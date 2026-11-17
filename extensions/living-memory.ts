/**
 * pi-living-memory — Today 记忆契约的 pi 移植 · Phase 1-3
 * 设计文档: vault/20_Concepts/ai/Today记忆契约与pi移植设计.md
 * 契约: 五类准入（稳定偏好/进行中承诺/关系信息/用户纠正/决策与行动结果），
 *       五类禁入（凭证/未证实敏感推断/一时状态/可替代的完整记录/他人隐私）。
 * 分层: 本扩展是唯一记忆层——entries=带生命周期的治理条目（简报注入），todo.md=未完成事项，summary.md=工程实况大库（按需检索不注入）。
 * 存储: ~/.pi/agent/memory/entries/<id>.md（frontmatter+正文，git-friendly）
 *       activity.log（追加式审计）· paused 标志（/memory off）
 * Phase 2: before_agent_start 简报注入（到期/待确认优先 + scope 过滤；每 run 从库重算，天然抗压缩。LIVING_MEMORY_BRIEF=0 关）
 * Phase 3: 自动抽取（agent_end 暂存 messages → agent_settled 调 complete 抽候选写入待确认队列；
 *          session_before_compact 用 branchEntries 兜底抽取防压缩丢失；session_shutdown 等待在途抽取。
 *          LIVING_MEMORY_EXTRACT=0 关；LIVING_MEMORY_EXTRACT_MODEL="provider/model-id" 换便宜模型）
 * Phase 4: A 档机械清理（LIVING_MEMORY_AUTO_TRIAGE=1 开启，默认 off）——只自动 expire 未治理推断里的
 *          ①被更晚条目显式取代的旧版本 ②记忆系统自指/过程性事项；relation·needs-confirm·confirmed 一律不碰，
 *          每步落 activity.log。B 档（事实转正）仍须用户 confirm，C 档（隐私/低置信/冲突）须逐条人工。
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const STORE = path.join(os.homedir(), ".pi", "agent", "memory");
const ENTRIES_DIR = path.join(STORE, "entries");
// 条目缓存：以「目录 mtime + 文件数」为戳，同一 turn 内多次读取零重复解析；任何写入立即失效
let entriesCache: { stamp: string; list: Entry[] } | null = null;
const ACTIVITY = path.join(STORE, "activity.log");
const PAUSE_FLAG = path.join(STORE, "paused");

const KINDS = ["preference", "constraint", "commitment", "relation", "correction", "decision", "outcome"] as const;
const ACTIVE = new Set(["explicit", "event", "inference", "confirmed"]);
/** 推断自动按事实处理的置信度门槛：>= 即直接 confirmed；低于门槛仍只作弱参考（「待确认」档） */
const AUTO_FACT_CONF = () => Number(process.env.LIVING_MEMORY_AUTO_FACT ?? 0.85);
/** 自动转事实的排除面：关系类与 needs-confirm 仍需人工点头（错判代价不对称） */
const autoFactable = (kind: string, conf: number, impact?: string) =>
  Number.isFinite(conf) && conf >= AUTO_FACT_CONF() && kind !== "relation" && impact !== "needs-confirm";

type Meta = Record<string, string>;
type Entry = { meta: Meta; body: string };

// ---------- store ----------
function ensureDirs() {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
}
function entryPath(id: string) {
  return path.join(ENTRIES_DIR, `${id}.md`);
}
function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}
function logActivity(line: string) {
  ensureDirs();
  // 审计日志轮转：超过阈值就改名成 activity-YYYY-MM.log，历史仍可 grep，当前文件封顶
  const maxBytes = Number(process.env.LIVING_MEMORY_ACTIVITY_MAX ?? 1_000_000);
  try {
    if (fs.statSync(ACTIVITY).size > maxBytes) {
      let dest = path.join(STORE, `activity-${new Date().toISOString().slice(0, 7)}.log`);
      let n = 1;
      while (fs.existsSync(dest)) dest = path.join(STORE, `activity-${new Date().toISOString().slice(0, 7)}-${n++}.log`);
      fs.renameSync(ACTIVITY, dest);
    }
  } catch {
    /* 首次写入或轮转失败都不影响写日志 */
  }
  fs.appendFileSync(ACTIVITY, `[${new Date().toISOString()}] ${line}\n`);
}

// ---------- 抽取失败可见：失败是「没抽成」，和「抽到 0 条」不是一回事 ----------
const EXTRACT_FAIL_FILE = path.join(STORE, "extract-failures.jsonl");
const EXTRACT_FAIL_KEEP = 50;

interface ExtractFailure {
  ts: string;
  reason: string;
  detail: string;
}

function noteExtractFailure(reason: string, detail: string): void {
  const row: ExtractFailure = { ts: new Date().toISOString(), reason, detail: String(detail ?? "").slice(0, 240) };
  try {
    ensureDirs();
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(EXTRACT_FAIL_FILE, "utf8").split("\n").filter(Boolean);
    } catch {
      /* 首次失败 */
    }
    lines.push(JSON.stringify(row));
    if (lines.length > EXTRACT_FAIL_KEEP) lines = lines.slice(-EXTRACT_FAIL_KEEP);
    writeAtomic(EXTRACT_FAIL_FILE, `${lines.join("\n")}\n`);
  } catch {
    /* 失败记录本身写不进去也不能影响主流程 */
  }
  logActivity(`extract failed ${reason}: ${row.detail}`);
}

function extractFailures(): ExtractFailure[] {
  try {
    return fs
      .readFileSync(EXTRACT_FAIL_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ExtractFailure];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function recentExtractFailures(hours = 24): ExtractFailure[] {
  const since = Date.now() - hours * 3600e3;
  return extractFailures().filter((f) => {
    const t = Date.parse(f.ts);
    return Number.isFinite(t) && t >= since;
  });
}

/** activity.log 里最后一条抽取相关记录（成功/跳过都算「跑通」），用于对照失败 */
function lastExtractRun(): string {
  try {
    const lines = fs.readFileSync(ACTIVITY, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      const l = lines[i];
      if (!/auto-extract (created|skipped)/.test(l)) continue;
      return `${l.slice(1, 17)} ${l.replace(/^\[[^\]]*\]\s*/, "").slice(0, 60)}`;
    }
  } catch {
    /* 无日志 */
  }
  return "";
}

function extractHealthText(): string {
  const fails = extractFailures();
  if (!fails.length) {
    const ok = lastExtractRun();
    return `extract：没有失败记录（文件 ${EXTRACT_FAIL_FILE} 为空）${ok ? `\n最近一次运行 ${ok}` : ""}\n失败文件只在模型调用/解析失败时追加，最多留 ${EXTRACT_FAIL_KEEP} 条。`;
  }
  const week = recentExtractFailures(24 * 7);
  const byReason = new Map<string, number>();
  for (const f of week) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  const counts = [...byReason.entries()].map(([r, n]) => `${r} ${n}`).join(" / ");
  const last = fails
    .slice(-8)
    .reverse()
    .map((f) => `· ${f.ts.slice(5, 16).replace("T", " ")} ${f.reason} — ${f.detail}`);
  const ok = lastExtractRun();
  return [
    `extract：近 7 天失败 ${week.length} 次${counts ? `（${counts}）` : ""}，共记录 ${fails.length} 条（上限 ${EXTRACT_FAIL_KEEP}）`,
    ok ? `最近一次成功/跳过 ${ok}` : "还没有成功记录",
    "失败原因分类：request-failed=模型调用抛错 / empty-response=模型没回内容 / no-json=回包里找不到 JSON 数组 / parse-failed=JSON 解析失败",
    ...last,
  ].join("\n");
}
function isPaused() {
  return fs.existsSync(PAUSE_FLAG);
}

/** 原子写：先写临时文件再 rename，避免两个 pi 进程同时写导致半截文件 */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  if (file.startsWith(ENTRIES_DIR + path.sep)) entriesCache = null;
}

/** 同步文件锁：`<file>.lock` 用 O_EXCL 创建，覆盖「读—改—写」整段；持锁方崩溃留下的陈旧锁（>30s）自动接管 */
function withFileLockSync<T>(file: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
        fs.closeSync(fd);
      } catch {
        // 锁内容写失败不影响互斥
      }
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // 锁刚被释放，立即重试
      }
      if (Date.now() > deadline) {
        try {
          fs.unlinkSync(lock);
        } catch {
          // 已被接管
        }
        continue;
      }
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // 已被超时接管
    }
  }
}
type EntryIndex = { id: string; meta: Meta; title: string };
const INDEX_FILE = path.join(STORE, "index.json");
let indexCache: { stamp: string; rows: EntryIndex[] } | null = null;

function dirStamp(): string {
  try {
    return `${fs.statSync(ENTRIES_DIR).mtimeMs}|${fs.readdirSync(ENTRIES_DIR).length}`;
  } catch {
    return "";
  }
}

// 索引行只保留简报需要的字段；source 等长字段不进索引（否则索引和正文一样大）
function toIndexRow(meta: Meta, title: string): EntryIndex {
  const keep: Meta = {};
  for (const k of ["id", "kind", "status", "subject", "scope", "action_impact", "obtained_at", "expires_at", "review_after", "supersedes", "confidence"]) {
    if (meta[k]) keep[k] = meta[k];
  }
  return { id: meta.id, meta: keep, title };
}

// 索引里的标题是摘要不是全文：中文每字 3 字节，160 字会让索引逼近正文体积
const titleOf = (body: string) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"))?.slice(0, 40) ?? "";

/** 索引是派生数据：只存 frontmatter + 标题行，永不作事实源；戳不符就用文件重建 */
function loadEntriesIndex(): EntryIndex[] {
  const stamp = dirStamp();
  if (indexCache && indexCache.stamp === stamp) return indexCache.rows;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (raw?.stamp === stamp && Array.isArray(raw.rows)) {
      indexCache = { stamp, rows: raw.rows as EntryIndex[] };
      return indexCache.rows;
    }
  } catch {
    // 索引缺失/损坏 → 下面重建
  }
  ensureDirs();
  const rows: EntryIndex[] = [];
  for (const f of fs.readdirSync(ENTRIES_DIR)) {
    if (!f.endsWith(".md")) continue;
    const e = parseEntry(path.join(ENTRIES_DIR, f));
    if (!e?.meta.id) continue;
    rows.push(toIndexRow(e.meta, titleOf(e.body)));
  }
  rows.sort((a, b) => (a.id < b.id ? 1 : -1));
  indexCache = { stamp, rows };
  writeAtomic(INDEX_FILE, JSON.stringify({ stamp, rows }));
  return rows;
}

/** 索引写盘：stamp 取写盘后的目录戳——跨进程失效靠它，落不准就等下次重建 */
function flushIndex() {
  if (!indexCache) return;
  indexCache.stamp = dirStamp();
  writeAtomic(INDEX_FILE, JSON.stringify({ stamp: indexCache.stamp, rows: indexCache.rows }));
}

const sortRows = (rows: EntryIndex[]) => rows.sort((a, b) => (a.id < b.id ? 1 : -1));

/** 新增/改写条目：只动那一行，不重扫全库 */
function upsertIndexRow(meta: Meta, body: string) {
  if (!indexCache) return;
  const rows = indexCache.rows.filter((r) => r.id !== meta.id).concat(toIndexRow(meta, titleOf(body)));
  sortRows(rows);
  indexCache.rows = rows;
  flushIndex();
}

/** 条目被移走/删除：只删那几行 */
function dropIndexRows(ids: string[]) {
  if (!indexCache || !ids.length) return;
  const gone = new Set(ids);
  indexCache.rows = indexCache.rows.filter((r) => !gone.has(r.id));
  flushIndex();
}

/** 正文/状态变了但行已存在：按现正文重算标题与关键字 */
function refreshIndexRow(meta: Meta, body: string) {
  if (!indexCache) return;
  const row = indexCache.rows.find((r) => r.id === meta.id);
  if (!row) return; // 不在基线里——留给下次重建
  const fresh = toIndexRow(meta, titleOf(body));
  row.meta = fresh.meta;
  row.title = fresh.title;
  flushIndex();
}
const invalidateIndex = () => {
  indexCache = null;
};

/** 写条目：写到它当前所在目录（entries/ 或 expired/），活动条目才更新索引 */
function writeEntry(meta: Meta, body: string) {
  ensureDirs();
  const live = entryPath(meta.id);
  const cold = path.join(EXPIRED_DIR, `${meta.id}.md`);
  const target = fs.existsSync(live) || !fs.existsSync(cold) ? live : cold;
  const order = ["id", "kind", "status", "subject", "scope", "source", "obtained_at", "confirmed_at", "expires_at", "review_after", "confidence", "evidence", "action_impact", "supersedes", "superseded_by"];
  const fm = order.map((k) => `${k}: ${meta[k] ?? ""}`).join("\n");
  writeAtomic(target, `---\n${fm}\n---\n${body.trim()}\n`);
  if (target === live) upsertIndexRow(meta, body);
  else dropIndexRows([meta.id]);
}

/** 失效条目搬进 expired/：离开 entries/ 并同步从索引移除（不删除，restore 可取回） */
function moveToExpired(id: string): boolean {
  const src = entryPath(id);
  const dest = path.join(EXPIRED_DIR, `${id}.md`);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(EXPIRED_DIR, { recursive: true });
  fs.renameSync(src, dest);
  dropIndexRows([id]);
  return true;
}

function parseEntry(file: string): Entry | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith("---\n")) return null;
    const end = text.indexOf("\n---\n", 4);
    if (end < 0) return null;
    const meta: Meta = {};
    for (const line of text.slice(4, end).split("\n")) {
      const i = line.indexOf(": ");
      if (i > 0) meta[line.slice(0, i)] = line.slice(i + 2);
      else {
        const j = line.indexOf(":");
        if (j > 0) meta[line.slice(0, j)] = line.slice(j + 1);
      }
    }
    return { meta, body: text.slice(end + 5).trim() };
  } catch {
    return null;
  }
}

function listEntries(): Entry[] {
  const stamp = (() => {
    try {
      return `${fs.statSync(ENTRIES_DIR).mtimeMs}|${fs.readdirSync(ENTRIES_DIR).length}`;
    } catch {
      return "";
    }
  })();
  if (entriesCache && entriesCache.stamp === stamp) return entriesCache.list;
  ensureDirs();
  const out: Entry[] = [];
  for (const f of fs.readdirSync(ENTRIES_DIR)) {
    if (!f.endsWith(".md")) continue;
    const e = parseEntry(path.join(ENTRIES_DIR, f));
    if (e && e.meta.id) out.push(e);
  }
  out.sort((a, b) => (a.meta.id < b.meta.id ? 1 : -1));
  entriesCache = { stamp, list: out };
  return out;
}

/** 按 id 前缀定位：先查索引（不读正文），只解析命中的那一个文件 */
function findEntry(idPrefix: string): Entry | null {
  const rows = loadEntriesIndex();
  const hit = rows.find((r) => r.id === idPrefix) ?? rows.find((r) => r.id.startsWith(idPrefix));
  if (hit) return parseEntry(path.join(ENTRIES_DIR, `${hit.id}.md`));
  // 索引可能落后于盘（极端并发），兜底全扫一次
  const live = listEntries().find((e) => e.meta.id === idPrefix || e.meta.id.startsWith(idPrefix));
  if (live) return live;
  // 已失效搬进 expired/ 的条目仍可按 id 定位（renew/delete/restore 要用）
  if (fs.existsSync(EXPIRED_DIR)) {
    const f = fs
      .readdirSync(EXPIRED_DIR)
      .find((x) => x.endsWith(".md") && !x.startsWith("index-") && (x === `${idPrefix}.md` || x.startsWith(idPrefix)));
    if (f) return parseEntry(path.join(EXPIRED_DIR, f));
  }
  return null;
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** 同 subject+kind 且正文相似（包含或 bigram 重叠>0.6）才算冲突——不同偏好可共存 */
function bodySimilar(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const grams = (t: string) => {
    const s = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
    return s;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  if (Math.min(gx.size, gy.size) < 8) return false; // 短句易误判：不足 8 个二元组只当不同
  return inter / (gx.size + gy.size - inter) > 0.5; // Jaccard：两段都要真的相似
}

// ---------- 推断转正评分（第一步：只读打分，不改状态） ----------
// 原则：自评置信度最多贡献 0.4 分；跨会话复现 ≤0.35；用户原话重述 0.35；
// 隐私/决策类（relation/decision/outcome）与含糊表述扣分；转正还必须独立证据 ≥2。
type Ev = { at: string; kind: string; id?: string; note?: string };
const HEDGE_MARK = /(可能|大概|也许|或许|待定|尚不确定|不确定|估计|应该是|似乎|推测|不一定)/;
const PROMOTE_THRESHOLD = Number(process.env.LIVING_MEMORY_PROMOTE_THRESHOLD ?? 0.8);

function evidenceOf(meta: Meta): Ev[] {
  try {
    const v = JSON.parse(meta.evidence || "[]");
    return Array.isArray(v) ? (v.filter((x: any) => x && typeof x.at === "string") as Ev[]) : [];
  } catch {
    return [];
  }
}

/** 证据累积（第二步）：同一天同一来源重复出现则跳过；只改 evidence 字段，不新建条目 */
function appendEvidence(e: Entry, ev: Ev): string | null {
  const list = evidenceOf(e.meta);
  const day = ev.at.slice(0, 10);
  if (list.some((x) => x.at.slice(0, 10) === day && (x.id ?? "") === (ev.id ?? ""))) return null;
  const next = list.concat(ev).slice(-20);
  const meta = { ...e.meta, evidence: JSON.stringify(next) };
  writeEntry(meta, e.body);
  const s = promoteScore({ meta, body: e.body });
  logActivity(`evidence +1 ${e.meta.id} kind=${ev.kind} total=${next.length} score=${s.score.toFixed(2)}`);
  return `${e.meta.id} 证据 +1（${ev.kind}，累计 ${next.length} 条 / ${s.days} 天 / ${s.independent} 源，转正分 ${s.score.toFixed(2)}${s.gate ? "，已越过门槛，可用 confirm 转正" : ""}）`;
}
/** 复合分：返回 score 与各分项，供 promote_scan 展示与人工判断 */
function promoteScore(e: Entry) {
  const conf = Math.min(Math.max(Number(e.meta.confidence ?? 0.6), 0), 1);
  const ev = evidenceOf(e.meta);
  const days = new Set(ev.map((x) => x.at.slice(0, 10)));
  const independent = new Set(ev.map((x) => `${x.at.slice(0, 10)}|${x.id ?? ""}`)).size;
  const base = conf * 0.4;
  const repeat = (Math.min(days.size, 3) / 3) * 0.5; // 口径 B：复现满分 0.50，3 次独立复现即到线
  const restate = ev.some((x) => x.kind === "restate") ? 0.3 : 0;
  const kind = e.meta.kind ?? "";
  let penalty = 0;
  if (kind === "relation" || kind === "decision" || kind === "outcome") penalty += 0.25;
  if (HEDGE_MARK.test(e.body) || HEDGE_MARK.test(e.meta.subject ?? "")) penalty += 0.2;
  const score = Math.min(Math.max(base + repeat + restate - penalty, 0), 1);
  const blocked = kind === "relation" || e.meta.action_impact === "needs-confirm";
  const gate = score >= PROMOTE_THRESHOLD && independent >= 2 && !blocked;
  return { score, base, repeat, restate, penalty, days: days.size, independent, blocked, gate };
}

/** 只读扫描：按复合分排序打印，不写任何文件（转正在后续步骤里才开启） */
/** 月度风格归纳（只读；写 profile 由人或 agent 做）：把窗口内的偏好/纠正/雷区摆出来当归纳材料 */
function opStyleScan(days = 30, limit = 20): string {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = loadEntriesIndex().filter(
    (r) =>
      r.meta.status !== "expired" &&
      r.meta.status !== "superseded" &&
      (String(r.meta.obtained_at ?? "") >= since || String(r.meta.evidence ?? "").includes(since.slice(0, 10))),
  );
  if (!rows.length) return `近 ${days} 天没有新增/更新的条目——画像无需变更。`;
  const sel = rows.filter((r) => ["preference", "constraint", "correction"].includes(r.meta.kind ?? ""));
  const neg = sel.filter((r) => isNegation(r));
  const others = sel.filter((r) => !isNegation(r)).slice(0, limit);
  const counts = rows.reduce<Record<string, number>>((m, r) => {
    const k = r.meta.kind ?? "?";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const lines: string[] = [
    `近 ${days} 天：活动条目新增/更新 ${rows.length} 条（${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ")}）`,
  ];
  if (neg.length) {
    lines.push(`雷区 ${neg.length} 条（写成指令更好用）：`);
    for (const r of neg.slice(0, 8)) lines.push(`- ${r.meta.subject}：${(r.title ?? "").slice(0, 46)}（${r.meta.id}）`);
  }
  if (others.length) {
    lines.push(`偏好/纠正 ${others.length} 条（可能含风格线索）：`);
    for (const r of others) lines.push(`- [${r.meta.kind}] ${r.meta.subject}：${(r.title ?? "").slice(0, 46)}（${r.meta.id}）`);
  }
  lines.push(
    "归纳方式：只把反复出现的稳定线索写进 profile.md 的「三、对外口径」「四、沟通与协作习惯」，每条结论附上面的 id 当证据；一次性情绪、单个项目特例不要写进去。",
    "`LIVING_MEMORY_PROFILE_BRIEF=1` 打开后，这两节会被压成一行注入每轮简报。",
  );
  try {
    fs.writeFileSync(path.join(STORE, "profile-style.last"), new Date().toISOString());
  } catch {
    /* 戳写不进去不影响结果 */
  }
  logActivity(`style_scan days=${days} rows=${rows.length} neg=${neg.length}`);
  return lines.join("\n");
}

/** 画像是否到了该归纳的时候（戳缺失也视为到期） */
function styleScanOverdue(days = 30): boolean {
  try {
    const at = fs.readFileSync(path.join(STORE, "profile-style.last"), "utf8").trim();
    return Date.now() - Date.parse(at) > days * 86400e3;
  } catch {
    return true;
  }
}

function opPromoteScan(limit = 20): string {
  const rows = loadEntriesIndex()
    .filter((r) => r.meta.status === "inference") // 只有推断是转正候选，confirmed/explicit 无需评分
    .map((r) => ({ r, e: parseEntry(entryPath(r.id)) }))
    .filter((x): x is { r: (typeof rows)[number]["r"]; e: Entry } => !!x.e)
    .map(({ r, e }) => ({
      id: r.id,
      subject: r.meta.subject ?? "",
      kind: r.meta.kind ?? "",
      status: r.meta.status ?? "",
      s: promoteScore(e),
    }));
  if (!rows.length) return "没有活动条目可评分。";
  const sorted = rows.sort((a, b) => b.s.score - a.s.score);
  const over = sorted.filter((x) => x.s.gate).length;
  const n = Math.max(1, Math.min(limit, 50));
  const lines = sorted.slice(0, n).map(
    (x, i) =>
      `${String(i + 1).padStart(2)}. ${x.s.score.toFixed(2)}${x.s.gate ? " 可转正" : ""} · ${x.kind} · ${x.status} · ${x.id}\n` +
      `    ${x.subject}｜自评 ${x.s.base.toFixed(2)} · 复现 ${x.s.repeat.toFixed(2)}(${x.s.days} 天/${x.s.independent} 源) · 重述 ${x.s.restate.toFixed(2)} · 扣分 ${x.s.penalty.toFixed(2)}${x.s.blocked ? " · 需人工" : ""}`,
  );
  const avg = sorted.reduce((a, b) => a + b.s.score, 0) / sorted.length;
  return (
    `推断转正评分（阈值 ${PROMOTE_THRESHOLD}，独立证据 ≥2，本命令只读不改状态）\n` +
    `活动 ${sorted.length} 条 · 平均 ${avg.toFixed(2)} · 最高 ${sorted[0].s.score.toFixed(2)} · 越过门槛 ${over} 条\n\n` +
    lines.join("\n") +
    (sorted.length > n ? `\n…（另有 ${sorted.length - n} 条未显示，limit 可调）` : "")
  );
}
/** 冲突检测：先按 kind+subject 从索引筛候选（不读正文），只读命中候选的正文比对 */
function findConflicting(kind: string, subject: string, text: string): Entry | null {
  const want = normText(subject);
  const cands = loadEntriesIndex().filter(
    (r) => ACTIVE.has(r.meta.status ?? "") && r.meta.kind === kind && normText(r.meta.subject ?? "") === want,
  );
  for (const r of cands) {
    const e = parseEntry(path.join(ENTRIES_DIR, `${r.id}.md`));
    if (e && bodySimilar(e.body, text)) return e;
  }
  return null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 按 kind 的复核间隔（天）：0=不设默认复核日期；settings.livingMemory.reviewDays 可覆盖 */
function reviewDays(kind: string, basis: string): number {
  const defaults: Record<string, number> = { decision: 60, outcome: 60, inference: 30, default: 180 };
  try {
    const cfg = readSettings?.()?.livingMemory?.reviewDays as Record<string, number> | undefined;
    if (cfg) {
      if (typeof cfg[`${basis}`] === "number") return cfg[`${basis}`];
      if (typeof cfg[`${kind}`] === "number") return cfg[`${kind}`];
      if (typeof cfg.default === "number") return cfg.default;
    }
  } catch {
    /* 读不到设置就用内置默认 */
  }
  return defaults[`${basis}`] ?? defaults[kind] ?? defaults.default;
}

/** 默认复核日期：decision/outcome 60 天，inference 30 天，其余 180 天（reviewDays 可改；0=不设） */
function defaultReviewAfter(basis: string, kind = ""): string {
  if (process.env.LIVING_MEMORY_NO_AUTO_REVIEW === "1") return "";
  const days = reviewDays(kind, basis);
  if (!days) return "";
  return new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
}

function addDays(n: number): string {
  return new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
}
function isDue(meta: Meta): boolean {
  const t = today();
  for (const k of ["review_after", "expires_at"]) {
    const v = meta[k];
    if (v && v.slice(0, 10) <= t) return true;
  }
  return false;
}

function fmt(e: Entry, withBody = true): string {
  const m = e.meta;
  const tags = [m.kind, m.status, `scope=${m.scope}`];
  if (m.confidence) tags.push(`conf=${m.confidence}`);
  if (m.supersedes) tags.push(`supersedes=${m.supersedes}`);
  if (m.superseded_by) tags.push(`superseded_by=${m.superseded_by}`);
  if (ACTIVE.has(m.status) && isDue(m)) tags.push("DUE");
  const head = `${m.id} [${tags.join(" · ")}] ${m.subject}`;
  if (!withBody) return head;
  const body = e.body.length > 80 ? `${e.body.slice(0, 80)}…` : e.body;
  return `${head}: ${body.replace(/\n/g, " ")}`;
}

/** 简报/计数专用：只走索引（frontmatter + 标题），不装载正文 */
function briefIndex() {
  const all = loadEntriesIndex();
  const active = all.filter((e) => ACTIVE.has(e.meta.status));
  const pending = active.filter((e) => e.meta.status === "inference");
  const due = active.filter((e) => isDue(e.meta));
  return { all, active, pending, due };
}

function brief() {
  const all = listEntries();
  const active = all.filter((e) => ACTIVE.has(e.meta.status));
  const pending = active.filter((e) => e.meta.status === "inference");
  const due = active.filter((e) => isDue(e.meta));
  return { all, active, pending, due };
}

function refreshWidget(ctx: any) {
  try {
    if (!ctx?.hasUI) return;
    const { pending, due } = briefIndex();
    ctx.ui.setWidget("living-memory", due.length + pending.length > 0 ? [`长期记忆：${due.length} 条到期待复核 · ${pending.length} 条推断待确认 → /memory`] : []);
  } catch {
    /* widget 是尽力而为 */
  }
}

// ---------- 核心操作（工具与 /memory 面板共用） ----------
function opConfirm(e: Entry, note?: string): string {
  if (!["inference", "event", "explicit"].includes(e.meta.status))
    return `${e.meta.id} status=${e.meta.status}，无需确认。`;
  e.meta.status = "confirmed";
  e.meta.confirmed_at = new Date().toISOString();
  writeEntry(e.meta, e.body);
  logActivity(`confirmed ${e.meta.id}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已确认为 confirmed 事实。`;
}

function opSupersede(e: Entry, text: string, note?: string): string {
  // 只允许从当前版本派生：对已被取代的旧条目 supersede 会分叉出平行链
  if (!ACTIVE.has(e.meta.status)) {
    const tip = e.meta.superseded_by ? `，当前版本是 ${e.meta.superseded_by}` : "";
    return `${e.meta.id} 非活动条目（status=${e.meta.status}${tip}），请对当前版本 supersede。`;
  }
  const old = e.meta;
  const nid = newId();
  const nm: Meta = {
    id: nid,
    kind: old.kind,
    status: "explicit",
    subject: old.subject,
    scope: old.scope,
    source: `${old.source} → 纠正于 ${today()}${note ? `（${note}）` : ""}`,
    obtained_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    expires_at: old.expires_at,
    review_after: old.review_after,
    confidence: "",
    action_impact: old.action_impact || "advice-only",
    supersedes: old.id,
    superseded_by: "",
  };
  writeEntry(nm, text);
  old.status = "superseded";
  old.superseded_by = nid;
  writeEntry(old, e.body);
  logActivity(`supersede ${old.id} -> ${nid}`);
  // 替代链深度：同一 subject 反复纠正时提示合并，防止同主题攒出十几代版本
  let depth = 1;
  const seen = new Set<string>([old.id]);
  let cur: Meta | undefined = old;
  while (cur?.supersedes && !seen.has(cur.supersedes)) {
    seen.add(cur.supersedes);
    const prev = findEntry(cur.supersedes);
    if (!prev) break;
    cur = prev.meta;
    depth++;
  }
  const chainHint =
    depth >= 4 ? `\n提示：该 subject 的替代链已 ${depth} 代，旧条目可 expire 合并，避免长期累积。` : "";
  return `已纠正：旧条目 ${old.id} → 新条目 ${nid}（旧条目保留 superseded 链，不再参与检索）。${chainHint}`;
}

function opRenew(e: Entry, reviewAfter?: string, expiresAt?: string): string {
  // 已失效（在 expired/ 或盘上 status=expired）的条目：renew 即复活——搬回 entries/ 并转为 explicit
  const resurrect = e.meta.status === "expired";
  if (!resurrect && !ACTIVE.has(e.meta.status)) return `${e.meta.id} status=${e.meta.status}，非活动条目，不能续期。`;
  const ra = reviewAfter || new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  if (resurrect) {
    const cold = path.join(EXPIRED_DIR, `${e.meta.id}.md`);
    if (fs.existsSync(cold) && !fs.existsSync(entryPath(e.meta.id))) fs.renameSync(cold, entryPath(e.meta.id));
    e.meta.status = "explicit";
    e.meta.confirmed_at = "";
  }
  e.meta.review_after = ra;
  if (expiresAt) e.meta.expires_at = expiresAt;
  writeEntry(e.meta, e.body);
  logActivity(`renew ${e.meta.id} review_after=${ra} status=${e.meta.status}${resurrect ? " resurrect=1" : ""}`);
  return resurrect
    ? `${e.meta.id} 已复活（expired → explicit，搬回 entries/），review_after=${ra}。`
    : `${e.meta.id} 已续期，review_after=${ra}（status 保持 ${e.meta.status}：续期≠确认，转正仍需显式 confirm）。`;
}

function opExpire(e: Entry, note?: string): string {
  e.meta.status = "expired";
  writeEntry(e.meta, e.body);
  const moved = moveToExpired(e.meta.id);
  logActivity(`expire ${e.meta.id} moved=${moved ? "expired/" : "-"}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已标记过期${moved ? "并移入 expired/" : ""}（不再参与检索；restore 可取回，补 renew 即复活）。`;
}


// ---------- G：过期条目批量清理（转移而非删除，expired/ 下按 id 保留原文，可 restore 回来） ----------
const EXPIRED_DIR = path.join(STORE, "expired");

function ageDays(meta: Meta): number {
  const iso = meta.expires_at || meta.obtained_at;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 86_400_000;
}

/** 待归档（purge_expired）候选计数：opPurgeExpired 与开屏提示共用同一口径 */
function purgeCandidates(olderDays = 30): { closed: number; due: EntryIndex[] } {
  // 只看元数据：entries/ 里的 legacy 失效条目走索引，已搬走的 expired/ 直接读文件
  const listIn = (dir: string): Entry[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md") && !f.startsWith("index-"))
          .map((f) => parseEntry(path.join(dir, f)))
          .filter((e): e is Entry => !!e)
      : [];
  const fromIndex = loadEntriesIndex().filter((e) => e.meta.status === "expired" || e.meta.status === "superseded");
  const fromExpired = listIn(EXPIRED_DIR).map((e) => toIndexRow(e.meta, titleOf(e.body)));
  const all = fromIndex.concat(fromExpired);
  return { closed: all.length, due: all.filter((e) => ageDays(e.meta) >= olderDays) };
}

/** 把 status=expired/superseded 且超过 older_than_days 的条目移入 expired/；dry_run 默认 true */
function opPurgeExpired(olderDays = 30, dry = true): string {
  ensureDirs();
  const { closed, due } = purgeCandidates(olderDays);
  if (!due.length)
    return `无符合条件条目（库内 status=expired/superseded 共 ${closed} 条，均未超过 ${olderDays} 天）。`;
  const lines = due.map((e) => `${e.meta.id}（${e.meta.kind}/${e.meta.status}/${e.meta.obtained_at.slice(0, 10)}）${e.meta.subject}`);
  if (dry)
    return `候选 ${due.length} 条（dry_run，未移动）：\n${lines.slice(0, 15).join("\n")}${due.length > 15 ? `\n…（还有 ${due.length - 15} 条）` : ""}\n确认无误会后传 dry_run=false 执行：文件移到 expired/，仍可用 restore 取回。`;
  fs.mkdirSync(EXPIRED_DIR, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const idx = path.join(EXPIRED_DIR, `index-${month}.md`);
  const head = fs.existsSync(idx) ? "" : `# expired 归档索引 ${month}\n\n| id | kind | status | 记录日 | subject |\n|---|---|---|---|---|\n`;
  const rows = due.map((e) => {
    const src = entryPath(e.meta.id);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(EXPIRED_DIR, `${e.meta.id}.md`)); // 已在 expired/ 的只登记月度索引
    return `| ${e.meta.id} | ${e.meta.kind} | ${e.meta.status} | ${e.meta.obtained_at.slice(0, 10)} | ${e.meta.subject.replace(/\|/g, "／")} |`;
  });
  fs.writeFileSync(idx, head + rows.join("\n") + "\n");
  dropIndexRows(due.map((e) => e.meta.id));
  logActivity(`purge_expired n=${due.length} older_than_days=${olderDays} ids=${due.map((e) => e.meta.id).join(",")}`);
  return `已清理 ${due.length} 条到 expired/（索引 expired/index-${month}.md，restore 可取回）：\n${lines.slice(0, 10).join("\n")}${due.length > 10 ? "\n…" : ""}`;
}

const RECOVERY_RETAIN_DAYS = Number(process.env.LIVING_MEMORY_RECOVERY_DAYS ?? 180);

function recoveryAgeDays(file: string): number {
  return (Date.now() - fs.statSync(file).mtimeMs) / 86_400_000;
}

/** 已删条目在 recovery/ 只保留 RECOVERY_RETAIN_DAYS 天，到期物理删；dry_run 默认 true */
function rotateRecovery(days = RECOVERY_RETAIN_DAYS, dry = true): string {
  if (!fs.existsSync(RECOVERY_DIR)) return "recovery/ 为空，无需轮转。";
  const files = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
  const due = files.filter((f) => recoveryAgeDays(path.join(RECOVERY_DIR, f)) >= days);
  const oldest = files.length ? Math.round(Math.max(...files.map((f) => recoveryAgeDays(path.join(RECOVERY_DIR, f))))) : 0;
  if (!due.length) return `recovery/ 共 ${files.length} 条，均未超过 ${days} 天保留期（最老 ${oldest} 天）。`;
  const names = due.map((f) => f.replace(/\.json$/, ""));
  if (dry)
    return `可轮转 ${due.length} 条（dry_run，未删除，保留期 ${days} 天）：\n${names.slice(0, 15).join("\n")}${
      due.length > 15 ? `\n…（还有 ${due.length - 15} 条）` : ""
    }\n确认后传 dry_run=false；删除后这些条目不再可 restore。`;
  for (const f of due) fs.unlinkSync(path.join(RECOVERY_DIR, f));
  logActivity(`rotate_recovery n=${due.length} retain=${days}d ids=${names.join(",")}`);
  return `已物理删除 ${due.length} 条超过 ${days} 天的 recovery 记录（这些条目不再可 restore）。`;
}

/** expired/ 归档区检索视图：条目被 purge_expired 移出活动库后仍可查、可取回 */
function searchExpired(q: string, status?: string, limit = 30): string {
  if (!fs.existsSync(EXPIRED_DIR)) return "expired/ 为空（尚未执行过 purge_expired）。";
  const rows: Entry[] = [];
  for (const f of fs.readdirSync(EXPIRED_DIR)) {
    if (!f.endsWith(".md") || f.startsWith("index-")) continue;
    const e = parseEntry(path.join(EXPIRED_DIR, f));
    if (e?.meta.id) rows.push(e);
  }
  const kw = q.split(/\s+/).filter(Boolean);
  let list = status ? rows.filter((e) => e.meta.status === status) : rows;
  if (kw.length)
    list = list.filter((e) => kw.every((k) => normText(`${e.meta.subject} ${e.meta.kind} ${e.meta.source} ${e.body}`).includes(normText(k))));
  list.sort((a, b) => (a.meta.id < b.meta.id ? 1 : -1));
  if (!list.length) return `expired/ 共 ${rows.length} 条，无匹配${kw.length ? `「${kw.join(" ")}」` : ""}。`;
  const lim = Math.min(limit, 100);
  return `expired/ 共 ${rows.length} 条，命中 ${list.length}（显示前 ${Math.min(list.length, lim)}；restore id 可取回）：\n\n${list
    .slice(0, lim)
    .map((e) => fmt(e))
    .join("\n")}`;
}

/** 批量 expire：无 id 时按 kind/scope/subject_contains 选活动条目；dry_run 默认 true */
function opExpireBatch(sel: { kind?: string; scope?: string; subject?: string }, dry = true, note?: string): string {
  const pick = listEntries().filter(
    (e) =>
      ACTIVE.has(e.meta.status) &&
      (!sel.kind || e.meta.kind === sel.kind) &&
      (!sel.scope || e.meta.scope.split(",").map((s) => s.trim()).includes(sel.scope)) &&
      (!sel.subject || e.meta.subject.includes(sel.subject)),
  );
  if (!pick.length) return "没有匹配的活动条目（批量 expire 只作用于 explicit/event/inference/confirmed）。";
  const lines = pick.map((e) => `${e.meta.id}（${e.meta.kind}/${e.meta.status}）${e.meta.subject}`);
  const more = pick.length > 15 ? `\n…（还有 ${pick.length - 15} 条）` : "";
  if (dry)
    return `候选 ${pick.length} 条（dry_run，未改动）：\n${lines.slice(0, 15).join("\n")}${more}\n确认后传 dry_run=false；每条都可 renew 复活。`;
  for (const e of pick) {
    e.meta.status = "expired";
    writeEntry(e.meta, e.body);
    moveToExpired(e.meta.id);
  }
  logActivity(`expire-batch n=${pick.length} kind=${sel.kind ?? "-"} scope=${sel.scope ?? "-"} subject=${sel.subject ?? "-"}${note ? ` note=${note}` : ""}`);
  return `已批量失效 ${pick.length} 条（status=expired，renew 可复活）：\n${lines.slice(0, 10).join("\n")}${pick.length > 10 ? "\n…" : ""}`;
}
const RECOVERY_DIR = path.join(STORE, "recovery");

function recoveryPath(id: string) {
  return path.join(RECOVERY_DIR, `${id}.json`);
}

function opDelete(e: Entry, note?: string): string {
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  fs.writeFileSync(
    recoveryPath(e.meta.id),
    JSON.stringify({ meta: e.meta, body: e.body, deleted_at: new Date().toISOString(), note: note ?? "" }, null, 2),
  );
  const liveFile = entryPath(e.meta.id);
  const coldFile = path.join(EXPIRED_DIR, `${e.meta.id}.md`);
  try {
    fs.unlinkSync(fs.existsSync(liveFile) ? liveFile : coldFile);
  } catch {
    /* 文件可能已被移走，recovery 记录仍有效 */
  }
  dropIndexRows([e.meta.id]);
  logActivity(
    `delete ${e.meta.id} kind=${e.meta.kind} subject=${e.meta.subject} source="${e.meta.source}" body="${e.body.slice(0, 160)}"${note ? ` note=${note}` : ""} recovery=${e.meta.id}.json`,
  );
  return `${e.meta.id} 已删除（完整内容存于 recovery/${e.meta.id}.json，可用 living_memory_update action=restore id=${e.meta.id} 恢复）。`;
}

/** 从 recovery 记录恢复被删除条目（幂等：条目仍在库中则不覆盖） */
function opRestore(idPrefix: string): string {
  // 先看 expired/（purge_expired 转移过来的条目在这里，文件本身完好）
  if (fs.existsSync(EXPIRED_DIR)) {
    const hit = fs
      .readdirSync(EXPIRED_DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("index-") && (f === `${idPrefix}.md` || f.startsWith(idPrefix)))[0];
    if (hit) {
      fs.renameSync(path.join(EXPIRED_DIR, hit), entryPath(hit.replace(/\.md$/, "")));
      logActivity(`restore ${hit.replace(/\.md$/, "")} from=expired/`);
      return `${hit.replace(/\.md$/, "")} 已从 expired/ 恢复（status=expired，仍不参与检索；要复活需再来一次 renew）。`;
    }
  }
  if (!fs.existsSync(RECOVERY_DIR)) return "没有可恢复记录（recovery/ 为空）。";
  const files = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
  const f = files.find((x) => x === `${idPrefix}.json`) ?? files.find((x) => x.startsWith(idPrefix));
  if (!f) {
    const ids = files.map((x) => x.replace(/\.json$/, "")).sort().reverse();
    return `找不到 ${idPrefix} 的删除记录。可恢复条目：${ids.slice(0, 10).join(", ") || "无"}${ids.length > 10 ? ` …（共 ${ids.length} 条）` : ""}`;
  }
  const rec = JSON.parse(fs.readFileSync(path.join(RECOVERY_DIR, f), "utf8")) as { meta: Meta; body: string };
  const id = rec.meta.id;
  if (fs.existsSync(entryPath(id))) return `${id} 条目仍在库中，无需恢复。`;
  writeEntry(rec.meta, rec.body);
  fs.unlinkSync(path.join(RECOVERY_DIR, f));
  logActivity(`restore ${id} kind=${rec.meta.kind} subject=${rec.meta.subject}`);
  return `${id} 已从 recovery 恢复（status=${rec.meta.status}）。`;
}

// ---------- Phase 2：简报注入 ----------
// ---------- Phase 4：A 档机械清理（LIVING_MEMORY_AUTO_TRIAGE=1 开启，默认 off） ----------
// 只处理结构上可判定的两类，且只针对 status=inference（未治理推断）：
//  ①A1 旧版本：同 subject 下有更晚条目在正文显式声明「纠正/取代/已过时」，且旧条目自身无此类声明
//  ②A2 自指/过程性：subject 命中记忆系统自指，或正文命中待批准/待答问题清单/调试结论/git 提交号等过程标记
// 隐私类（kind=relation）、action_impact=needs-confirm、已 confirmed/superseded 的一律不碰；
// 每次触发最多 5 条，逐条写 activity.log，B 档（事实转正）仍须用户 confirm，C 档须逐条人工。
const SUCCESSOR_MARK = /(已(?:被)?纠正|已过时|已被?取代|纠正为|不再成立|以此为准)/;
const SELF_REF_MARK = /(living\s*(?:记忆|memory|迁移|功能|面板|brief|检索)|living-memor(?:y|ies)|pi-living-mem\w*|pi-memory|记忆系统|记忆层|抽取器|抽取\s*prompt|记忆库)/i;
/** 插件自身工程实现的自指词：subject 命中即视为工程实况，不立条目（「用户/我」开头的偏好类不受拦） */
const PLUGIN_INTERNAL =
  /(living[-_ ]?(?:memor|记忆)|pi-memory|index\.json|summary-index|todo-index|summary\.(?:md|索引)|todo(?:\.md|-archive|-index| 分家)|routing|source=(?:todo|summary|entries|archive|all)|brief|简报|面板|抽取器|派生索引|记忆)/i;
/** subject 是否在讲插件自身（「用户/我」开头的偏好类不算） */
const isPluginInternal = (subject: string) => PLUGIN_INTERNAL.test(subject) && !/^(用户|我)/.test(subject);
const PROCEDURAL_MARK = /(待用户回答|待用户批准|待批准|待用户确认后执行|待你确认后执行|调试结论|git 提交号|commit [0-9a-f]{6,})/i;

// pi.getSettings 惰性访问：module 级函数拿不到 pi 实例，由 default() 注入读取器
let readSettings: (() => any) | null = null;

function autoTriageEnabled(): boolean {
  const env = process.env.LIVING_MEMORY_AUTO_TRIAGE;
  if (env === "0") return false; // 环境变量优先，可临时关
  if (env === "1") return true;
  try {
    const v = readSettings?.()?.livingMemory?.autoTriage;
    if (typeof v === "boolean") return v;
  } catch {
    /* 读不到设置按默认 off */
  }
  return false;
}

function autoTriage(trigger: string): string[] {
  if (!autoTriageEnabled() || isPaused()) return [];
  // 候选只可能是 inference 条目：先走索引筛，再逐条读正文，避免为一次 A 档扫描装载全库
  const cands = loadEntriesIndex().filter((e) => ACTIVE.has(e.meta.status) && e.meta.status === "inference");
  if (!cands.length) return [];
  const allActive = loadEntriesIndex().filter((e) => ACTIVE.has(e.meta.status));
  const active = cands.map((c) => parseEntry(entryPath(c.id))).filter((e): e is Entry => !!e);
  const acted: string[] = [];
  for (const e of active) {
    if (acted.length >= 5) break;
    if (e.meta.status !== "inference") continue;
    if (e.meta.kind === "relation" || e.meta.action_impact === "needs-confirm") continue;
    let rule = "";
    if (!SUCCESSOR_MARK.test(e.body)) {
      // 同 subject 且更新的条目才可能构成「已取代」，只读这几条正文
      const n = allActive.find(
        (x) =>
          x.meta.id !== e.meta.id &&
          x.meta.subject === e.meta.subject &&
          x.meta.obtained_at > e.meta.obtained_at &&
          SUCCESSOR_MARK.test(parseEntry(entryPath(x.id))?.body ?? ""),
      );
      if (n) rule = `A1 旧版本被 ${n.meta.id} 取代`;
    }
    if (!rule) {
      if (SELF_REF_MARK.test(e.meta.subject) || isPluginInternal(e.meta.subject)) rule = "A2 记忆系统自指";
      else if (PROCEDURAL_MARK.test(e.body)) rule = "A2 过程性事项";
    }
    if (!rule) continue;
    opExpire(e, `auto-triage ${rule} (${trigger})`);
    acted.push(`${e.meta.id}（${rule}）`);
  }
  if (acted.length) logActivity(`auto-triage ${trigger}: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

function inScope(e: { meta: Meta }, cwd?: string): boolean {
  const s = e.meta.scope || "global";
  if (s === "global") return true;
  if (!cwd) return true; // 拿不到 cwd 时宁多勿漏
  const base = path.basename(cwd);
  if (!base) return true;
  // 逐 token 精确比对（旧版 s.includes(base) 会让 keqiz 误配 keqiz.com）
  return s
    .split(",")
    .map((t) => t.trim().replace(/^(?:workspace|project):/, ""))
    .some((t) => t !== "" && t === base);
}

const SCOPE_TOKEN_RE = /^(global|workspace:[a-z0-9._-]+|project:[a-z0-9._-]+)$/i;
/** scope 白名单校验：global / workspace:<名> / project:<名>（多值逗号分隔）；错拼会永远进不了对应层，因此直接拒写 */
function validateScope(raw: string): string {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return "scope 不能为空：用 global / workspace:<名> / project:<名>（多值逗号分隔）。";
  const bad = tokens.filter((t) => !SCOPE_TOKEN_RE.test(t));
  if (!bad.length) return "";
  const known = new Set(
    loadEntriesIndex()
      .flatMap((e) => (e.meta.scope || "").split(",").map((x) => x.trim()))
      .filter(Boolean),
  );
  return `scope 值不合法：${bad.join("、")}。只接受 global / workspace:<名> / project:<名>（多值逗号分隔）。库里已用过的 scope：${
    [...known].sort().slice(0, 12).join(" / ") || "（暂无）"
  }`;
}

/** A：按已存 confidence 追溯转事实（幂等）。用于规则上线前的存量推断；会话启动自动跑 */
function autoFactRetro(limit = 10): string[] {
  if (isPaused()) return [];
  const acted: string[] = [];
  const cands = loadEntriesIndex().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    const conf = Number(r.meta.confidence ?? NaN);
    if (!autoFactable(r.meta.kind ?? "", conf, r.meta.action_impact)) continue;
    const e = parseEntry(entryPath(r.id));
    if (!e) continue;
    opConfirm(e, `auto-fact retro conf=${conf}`);
    acted.push(`${r.id}（conf ${conf}）`);
  }
  if (acted.length) logActivity(`auto-fact retro: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

/** B：证据驱动的自动转事实。独立日期 >=3 天、复合分 >= 门槛、且非关系/需确认即视为事实 */
function autoFactEvidence(limit = 5): string[] {
  if (process.env.LIVING_MEMORY_AUTO_FACT_EVIDENCE === "0" || isPaused()) return [];
  const minDays = Number(process.env.LIVING_MEMORY_AUTO_FACT_DAYS ?? 3);
  const minScore = Number(process.env.LIVING_MEMORY_AUTO_FACT_SCORE ?? PROMOTE_THRESHOLD);
  const acted: string[] = [];
  const cands = loadEntriesIndex().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    if (r.meta.kind === "relation" || r.meta.action_impact === "needs-confirm") continue;
    const e = parseEntry(entryPath(r.id));
    if (!e) continue;
    const s = promoteScore(e);
    if (s.days < minDays || s.score < minScore || s.independent < 2) continue;
    opConfirm(e, `auto-fact evidence days=${s.days} score=${s.score.toFixed(2)}`);
    acted.push(`${r.id}（${s.days} 天 / 分 ${s.score.toFixed(2)}）`);
  }
  if (acted.length) logActivity(`auto-fact evidence: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

// ---------- Phase 5：简报分层预算 + 文档检索辅助 ----------
// 简报改为分档配额：到期 > 待确认推断 > 当前项目 scope > 全局，各档独立上限；
// 每行 subject 42 字符 + 正文摘录，总长硬顶（默认 2400，LIVING_MEMORY_BRIEF_MAX_CHARS 可调）；
// 被裁掉的条数显式告知而不是静默丢弃——目录条目会随迁移持续增长。
const BRIEF_MAX_CHARS = Number(process.env.LIVING_MEMORY_BRIEF_MAX_CHARS ?? 2400);
const BRIEF_LINE_CHARS = 130;
const TODO_DIGEST_CHARS = Number(process.env.LIVING_MEMORY_TODO_DIGEST_CHARS ?? 70);
const TODO_DIGEST_RESERVE = 150;

/** 画像摘要：只取「三、对外口径」「四、沟通与协作习惯」两节正文（人写结论），去标记与占位，压成一行 */
function profileDigest(max = 200): string {
  let text = "";
  try {
    text = fs.readFileSync(path.join(STORE, "profile.md"), "utf8");
  } catch {
    return "";
  }
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  const parts = body.split(/\n(?=## )/).filter((x) => /^## (三|四)/.test(x));
  // 只留“可念出来”的句子：跳过引用/小标题/注释，剥掉 markdown 装饰与证据 id（括号内含 2026…id 的那段）
  const clean = (l: string) =>
    l
      .replace(/^\s*[-*>#]+\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/（[^）]*20\d{6}[^）]*）/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const lines = parts
    .flatMap((p) => p.split("\n").slice(1))
    .map(clean)
    .filter((l) => l && !/暂无/.test(l) && !/^本节|^边界|^维护|^定位/.test(l) && l.length > 4);
  const joined = lines.join("；");
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

const PROFILE_BRIEF_ON = () => process.env.LIVING_MEMORY_PROFILE_BRIEF === "1";
/** 负面偏好标记：这类条目在简报里优先，并打 [雷区] 标签 */
const NEGATION_RE = /(不要|别把|别再|禁止|不得|避免|切勿|勿|never|don'?t|avoid)/i;
const isNegation = (e: { meta: any; title?: string }) => NEGATION_RE.test(`${e.meta?.subject ?? ""} ${e.title ?? ""}`);
const TODO_FILE = path.join(STORE, "todo.md");
const TODO_ARCHIVE_FILE = path.join(STORE, "todo-archive.md");
const SUMMARY_FILE = path.join(STORE, "summary.md");

// 早期版本用大写文件名。若只剩大写孪生文件就改名为小写；两边都在则记下来，交给 session_start 提示人工合并（通常是陈旧实例又写回来的）。
const LEGACY_PAIRS: Array<[string, string]> = [
  ["SUMMARY.md", "summary.md"],
  ["SUMMARY-archive.md", "summary-archive.md"],
  ["TODO.md", "todo.md"],
  ["TODO-archive.md", "todo-archive.md"],
];
function healLegacyNames(): void {
  for (const [upper, lower] of LEGACY_PAIRS) {
    const u = path.join(STORE, upper);
    const l = path.join(STORE, lower);
    if (!fs.existsSync(u)) continue;
    if (fs.existsSync(l)) continue;
    try {
      fs.renameSync(u, l);
    } catch {
      /* 只读盘或权限问题：留给人工 */
    }
  }
}
healLegacyNames();
// 大写与小写并存的孪生文件（通常是陈旧实例写回来的）：按需探测，改一次数量就少一次
function legacyTwins(): string {
  const found: string[] = [];
  for (const [upper, lower] of LEGACY_PAIRS) {
    if (fs.existsSync(path.join(STORE, upper)) && fs.existsSync(path.join(STORE, lower))) found.push(upper);
  }
  return found.join(", ");
}

function briefLine(tag: string, e: EntryIndex): string {
  const subject = (e.meta.subject || "").slice(0, 42);
  const body = e.title.replace(/\s+/g, " ").trim();
  const room = Math.max(24, BRIEF_LINE_CHARS - tag.length - subject.length - 1);
  return `${tag}${subject}：${body.length > room ? `${body.slice(0, room)}…` : body}`;
}

// todo.md 全文缓存：简报 + 面板 + 计数共用一次读盘；戳=mtime+体积，写后立即失效
let todoCache: { stamp: string; text: string } | null = null;
function todoText(): string {
  let stamp = "";
  try {
    const st = fs.statSync(TODO_FILE);
    stamp = `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
  if (todoCache && todoCache.stamp === stamp) return todoCache.text;
  const text = fs.readFileSync(TODO_FILE, "utf8");
  todoCache = { stamp, text };
  return text;
}

function todoOpenCount(): number {
  return todoIndex().open.length;
}

/** 待办条目标识：`- [ ] 正文` / `- [x] 正文`（正文可很长，含 `<!-- from: ... -->` 尾注） */
const TODO_LINE_RE = /^- \[([ xX])\] (.+)$/;
const ARCHIVE_SECTION = "## 已完成归档";
const DONE_MARK_RE = /\s*<!-- done: [^>]*-->[ \t]*$/;

function todoLines(): string[] {
  const text = todoText();
  return text ? text.split("\n") : [];
}

function todoArchiveLines(): string[] {
  try {
    return fs.readFileSync(TODO_ARCHIVE_FILE, "utf8").split("\n");
  } catch {
    return [];
  }
}

function saveTodoLines(lines: string[]): void {
  ensureDirs();
  writeAtomic(TODO_FILE, lines.join("\n"));
  todoCache = null;
  todoIdxCache = null; // 目录索引同时失效
}

// ---------- todo 索引（派生：只存未完成项的节名 + 正文前 100 字）----------
const TODO_INDEX_FILE = path.join(STORE, "todo-index.json");
interface TodoRow {
  section: string;
  text: string;
  project?: string;
  tags: string[];
  due?: string;
}

// ---------- 待办结构化：行尾 `@project #tag due:YYYY-MM-DD`（三者都可缺省）----------
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地日期（不用 toISOString：UTC 会把「今天」算错一天） */
function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface TodoMeta {
  project?: string;
  tags: string[];
  due?: string;
  text: string;
}

/** 从行尾逐个剥离 @project / #tag / due:YYYY-MM-DD，剩下的才是正文（正文里同名标记保留原样） */
function parseTodoMeta(raw: string): TodoMeta {
  let project: string | undefined;
  const tags: string[] = [];
  let due: string | undefined;
  let text = raw;
  for (let guard = 0; guard < 12; guard++) {
    const m = text.match(/(?:\s+|^)(@[^\s@#]+|#[^\s@#]+|due:\d{4}-\d{2}-\d{2})\s*$/);
    if (!m) break;
    const tok = m[1];
    if (tok.startsWith("@")) {
      if (!project) project = tok.slice(1);
    } else if (tok.startsWith("#")) {
      if (!tags.includes(tok.slice(1))) tags.unshift(tok.slice(1));
    } else if (!due) {
      due = tok.slice(4);
    }
    text = text.slice(0, text.length - m[0].length).trimEnd();
  }
  return { project, tags, due, text: text.trim() };
}

/** 把结构化标记拼回行尾（todo_add 写入用；顺序固定，便于 grep 与人工编辑） */
function todoSuffix(project?: string, tags?: string[], due?: string): string {
  const parts: string[] = [];
  if (project) parts.push(`@${project}`);
  for (const t of tags ?? []) if (t) parts.push(`#${t}`);
  if (due) parts.push(`due:${due}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

type DueState = "none" | "overdue" | "today" | "soon" | "later";

function dueState(due?: string): DueState {
  if (!due) return "none";
  const today = localDay();
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (due <= localDay(7)) return "soon";
  return "later";
}

/** 逾期 / 今天 / 7 日内到期的未完成待办（简报与开屏提示读它） */
function dueRows(): TodoRow[] {
  return todoIndex().open.filter((r) => {
    const s = dueState(r.due);
    return s === "overdue" || s === "today" || s === "soon";
  });
}
let todoIdxCache: { stamp: string; open: TodoRow[]; done: number } | null = null;

const todoStamp = (): string => {
  try {
    const st = fs.statSync(TODO_FILE);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
};

function buildTodoRows(): { open: TodoRow[]; done: number } {
  const open: TodoRow[] = [];
  let done = 0;
  let section = "";
  for (const line of fs.readFileSync(TODO_FILE, "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("- [x] ")) {
      done++;
      continue;
    }
    if (!line.startsWith("- [ ] ")) continue;
    if (!line.startsWith("- [ ] ")) continue;
    const meta = parseTodoMeta(line.slice(6).replace(/<!--.*$/, "").trim());
    open.push({ section, text: meta.text.slice(0, 100), project: meta.project, tags: meta.tags, due: meta.due });
  }
  return { open, done };
}

/** 未完成待办目录：简报/面板/计数读它，不再读 todo.md 全文（写操作照旧用全文） */
function todoIndex(): { open: TodoRow[]; done: number } {
  const stamp = todoStamp();
  if (!stamp) return { open: [], done: 0 };
  if (todoIdxCache && todoIdxCache.stamp === stamp) return todoIdxCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TODO_INDEX_FILE, "utf8"));
    if (raw?.stamp === stamp && Array.isArray(raw.open)) {
      todoIdxCache = { stamp, open: raw.open as TodoRow[], done: Number(raw.done ?? 0) };
      return todoIdxCache;
    }
  } catch {
    /* 缺失/损坏 → 重建 */
  }
  const built = buildTodoRows();
  todoIdxCache = { stamp, ...built };
  writeAtomic(TODO_INDEX_FILE, JSON.stringify({ stamp, ...built }));
  return todoIdxCache;
}

// ---------- summary.md 写入 ----------
function summaryLines(): string[] {
  return fs.existsSync(SUMMARY_FILE) ? fs.readFileSync(SUMMARY_FILE, "utf8").split("\n") : ["# summary", ""];
}
function saveSummaryLines(lines: string[]): void {
  ensureDirs();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  writeAtomic(SUMMARY_FILE, `${lines.join("\n")}\n`);
  summaryIdxCache = null; // 目录索引随正文一起失效
}

// ---------- summary 索引（派生：编号+标题+所属项目；正文仍以 summary.md 为准）----------
const SUMMARY_INDEX_FILE = path.join(STORE, "summary-index.json");
interface SummaryRow {
  num: number;
  title: string;
  project: string;
}
let summaryIdxCache: { stamp: string; rows: SummaryRow[] } | null = null;

const summaryStamp = (): string => {
  try {
    const st = fs.statSync(SUMMARY_FILE);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
};

function buildSummaryRows(): SummaryRow[] {
  const rows: SummaryRow[] = [];
  let project = "（未分节）";
  for (const line of fs.readFileSync(SUMMARY_FILE, "utf8").split("\n")) {
    if (line.startsWith("## ")) project = line.slice(3).trim();
    const m = line.match(/^### \[(\d+)\] (.+)$/);
    if (m) rows.push({ num: Number(m[1]), title: m[2].trim(), project });
  }
  return rows;
}

/** 小节目录：只读 summary-index.json（戳不符才扫一遍 summary.md 重建） */
function summaryIndex(): SummaryRow[] {
  const stamp = summaryStamp();
  if (!stamp) return [];
  if (summaryIdxCache && summaryIdxCache.stamp === stamp) return summaryIdxCache.rows;
  try {
    const raw = JSON.parse(fs.readFileSync(SUMMARY_INDEX_FILE, "utf8"));
    if (raw?.stamp === stamp && Array.isArray(raw.rows)) {
      summaryIdxCache = { stamp, rows: raw.rows as SummaryRow[] };
      return summaryIdxCache.rows;
    }
  } catch {
    /* 缺失/损坏 → 重建 */
  }
  ensureDirs();
  const rows = buildSummaryRows();
  summaryIdxCache = { stamp, rows };
  writeAtomic(SUMMARY_INDEX_FILE, JSON.stringify({ stamp, rows }));
  return rows;
}
/** 下一个 `### [NN]` 编号 */
function summaryNextNumber(lines: string[]): number {
  let max = 0;
  for (const l of lines) {
    const m = l.match(/^### \[(\d+)\] /);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
/** 定位 `## <project>` 节尾插入点；找不到则标记新建节 */
function summarySectionAt(lines: string[], project: string): { at: number; created: boolean } {
  const key = project.trim().toLowerCase();
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim().toLowerCase().includes(key));
  if (start < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return { at: lines.length, created: true };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === "") at--;
  return { at, created: false };
}
/** 正文 → `- ` bullet 行（已带 `- `/`* ` 的归一成 `- `） */
function toBullets(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .map((l) => `- ${l.replace(/^\s*(?:-|\*)\s+/, "").trim()}`);
}
function opSummaryAdd(project: string, title: string, body: string): string {
  const proj = (project || "").trim();
  const t = (title || "").trim();
  if (!proj || !t) return "summary_add 必须带 project（`## ` 节名关键词）与 title。";
  if (!body.trim()) return "summary_add 必须带 body（正文，按 `- ` 条目写入）。";
  const lines = summaryLines();
  const { at, created } = summarySectionAt(lines, proj);
  const nn = summaryNextNumber(lines);
  const block = [
    "",
    `### [${nn}] ${t}`,
    `<!-- src: living summary_add ${today()} -->`,
    `### ${t}`,
    "",
    ...toBullets(body),
  ];
  if (created) lines.push("", `## ${proj}`, ...block);
  else lines.splice(at, 0, ...block);
  saveSummaryLines(lines);
  logActivity(`summary add ${proj} :: ${t} (#${nn})`);
  return `已写入 summary.md：${created ? `新建节「${proj}」` : `「${proj}」节`} #${nn} ${t}`;
}
function opSummaryUpdate(match: string, body: string): string {
  const m = (match || "").trim().toLowerCase();
  if (!m) return "summary_update 必须带 match（小节标题的唯一关键词）。";
  if (!body.trim()) return "summary_update 必须带 body（新的正文）。";
  const lines = summaryLines();
  const cands = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.startsWith("### ") && !/^### \[\d+\] /.test(l) && l.slice(4).toLowerCase().includes(m));
  if (!cands.length) return `summary.md 里找不到标题含「${match}」的正文块。`;
  if (cands.length > 1)
    return `匹配到 ${cands.length} 个小节，请用更具体的 match：\n${cands
      .slice(0, 5)
      .map((c) => `- ${c.l.slice(4)}`)
      .join("\n")}`;
  const start = cands[0].i + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith("### ") || lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  while (end > start && lines[end - 1].trim() === "") end--;
  lines.splice(start, end - start, "", ...toBullets(body));
  saveSummaryLines(lines);
  logActivity(`summary update ${cands[0].l.slice(4)}`);
  return `已改写 summary.md 小节「${cands[0].l.slice(4)}」的正文（标题与编号不变）。`;
}

// ---------- summary.md 归档（控制文件规模：最老小节移入 summary-archive.md） ----------
const SUMMARY_ARCHIVE_FILE = path.join(STORE, "summary-archive.md");
const SUMMARY_KEEP = Number(process.env.LIVING_MEMORY_SUMMARY_KEEP ?? 60);

interface SummarySection {
  /** `### [NN] 标题` 的编号；0 = 无编号的散块（不参与归档） */
  num: number;
  title: string;
  lines: string[];
}

function summarySections(lines: string[]): { preamble: string[]; sections: SummarySection[] } {
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^### \[\d+\] /.test(l)) starts.push(i);
  });
  const preamble = starts.length ? lines.slice(0, starts[0]) : [...lines];
  const sections: SummarySection[] = [];
  starts.forEach((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const chunk = lines.slice(s, e);
    const m = (chunk[0] ?? "").match(/^### \[(\d+)\] (.+)$/);
    sections.push({ num: Number(m?.[1] ?? 0), title: (m?.[2] ?? "").trim(), lines: chunk });
  });
  return { preamble, sections };
}

function ensureArchiveHeader(): void {
  if (fs.existsSync(SUMMARY_ARCHIVE_FILE)) return;
  writeAtomic(
    SUMMARY_ARCHIVE_FILE,
    [
      "# summary-archive —— 已归档的工程实况小节",
      "",
      "<!-- 归档规则：summary.md 活动小节超过阈值时，编号最小（最老）的整节（索引块+正文块）移入本文件 -->",
      "<!-- 取回方式：living_memory source=summary-archive query=关键词 检索；需要恢复原文就手工把段落搬回 summary.md -->",
      "",
    ].join("\n"),
  );
}

/** 归档最老的 N 个 `### [NN]` 小节到 summary-archive.md；dry_run 默认 true */
function opSummaryArchive(keep = SUMMARY_KEEP, dry = true): string {
  const lines = summaryLines();
  const { preamble, sections } = summarySections(lines);
  if (sections.length <= keep) return `summary.md 共 ${sections.length} 个小节，未超过保留数 ${keep}，无需归档。`;
  const sorted = [...sections].sort((a, b) => a.num - b.num);
  const move = sorted.slice(0, sections.length - keep);
  const moveNums = new Set(move.map((s) => s.num));
  const list = move.map((s) => `[${String(s.num).padStart(2, "0")}] ${s.title.slice(0, 40)}`);
  if (dry)
    return `可归档 ${move.length} 个小节（dry_run，未改动；活动保留 ${keep} 个最新）：\n${list
      .slice(0, 12)
      .join("\n")}${list.length > 12 ? `\n…（还有 ${list.length - 12} 个）` : ""}\n确认后传 dry_run=false。`;
  const stamp = new Date().toISOString().slice(0, 10);
  const out: string[] = [...preamble];
  for (const s of sections) {
    if (!moveNums.has(s.num)) {
      out.push(...s.lines);
      if (out[out.length - 1] !== "") out.push("");
      continue;
    }
    // 活动文件里只留一行可读指针，不再占 `### [NN]` 计数
    out.push(`- 归档：\`[${s.num}]\` ${s.title}（正文见 summary-archive.md）`, "");
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  ensureArchiveHeader();
  const parts = move.map((s) => `<!-- archived ${stamp} from summary.md -->\n${s.lines.join("\n").replace(/\n+$/, "")}\n`);
  fs.appendFileSync(SUMMARY_ARCHIVE_FILE, `\n${parts.join("\n")}`);
  saveSummaryLines(out);
  logActivity(`summary archive n=${move.length} keep=${keep} nums=${move.map((s) => s.num).join(",")}`);
  return `已归档 ${move.length} 个小节到 summary-archive.md（活动 summary.md 保留 ${keep} 个）：${move
    .map((s) => `[${s.num}]`)
    .join("、")}`;
}

/** summary-archive.md 检索视图（归档节的正文仍可按关键词命中） */
function searchSummaryArchive(q: string, limit = 8): string {
  if (!fs.existsSync(SUMMARY_ARCHIVE_FILE)) return "summary-archive.md 不存在（尚未执行 summary_archive）。";
  const text = fs.readFileSync(SUMMARY_ARCHIVE_FILE, "utf8");
  // 归档区同样存「`### [NN] 标题` 索引块 + 正文块」，只取正文块，节数才准
  const blocks = text.split(/\n(?=### )/).filter((b) => b.startsWith("### ") && !/^### \[\d+\] /.test(b));
  const kw = q.split(/\s+/).filter(Boolean);
  const hits = kw.length ? blocks.filter((b) => kw.every((k) => normText(b).includes(normText(k)))) : blocks;
  if (!hits.length) return `summary-archive 共 ${blocks.length} 节，无匹配${kw.length ? `「${kw.join(" ")}」` : ""}。`;
  const lim = Math.min(limit, 20);
  const body = hits.slice(-lim).reverse().join("\n");
  return `summary-archive 共 ${blocks.length} 节，命中 ${hits.length}（显示 ${Math.min(hits.length, lim)} 节，最新归档在前）：\n\n${body}`;
}

/** 取匹配 cwd 名的小节里的未完成待办，正文压缩到 TODO_DIGEST_CHARS */
function todoDigest(baseName: string, limit: number): Array<{ section: string; text: string }> {
  const out: Array<{ section: string; text: string }> = [];
  const want = baseName.toLowerCase();
  for (const row of todoIndex().open) {
    if (!row.section.toLowerCase().includes(want)) continue;
    out.push({
      section: row.section.slice(0, 18),
      text: row.text.length > TODO_DIGEST_CHARS ? `${row.text.slice(0, TODO_DIGEST_CHARS)}…` : row.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function todoSummaryText(): string {
  const idx = todoIndex();
  const done = idx.done;
  return `未完成 ${idx.open.length} 项${done ? ` / todo.md 内已完成 ${done} 项` : ""}`;
}

/** 把已完成待办收拢到文末「## 已完成归档」，按 done 日期倒序；返回搬动条数 */
function archiveDone(): number {
  const lines = todoLines();
  const done: string[] = [];
  const rest: string[] = [];
  for (const l of lines) {
    if (l.startsWith("- [x] ")) {
      done.push(l);
      continue;
    }
    rest.push(l);
  }
  if (!done.length) return 0;
  const dateOf = (l: string) => (l.match(/<!-- done: ([^>]+) -->/)?.[1] ?? "").trim();
  done.sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : -1));

  // 完成项移出 todo.md 存到 todo-archive.md：todo.md 只留未完成 + 一个指针节，
  // 这样简报每轮读的待办文本量与「还剩多少活」成正比，而不是与历史总量成正比
  const month = today().slice(0, 7);
  const head = `# todo-archive —— 已完成的待办（按完成月份倒序）\n\n## 已归档（${month}）\n\n`;
  let arch = "";
  try {
    arch = fs.readFileSync(TODO_ARCHIVE_FILE, "utf8");
  } catch {
    arch = head;
  }
  const monthHead = `## 已归档（${month}）`;
  arch = arch.includes(monthHead)
    ? arch.replace(`${monthHead}\n\n`, `${monthHead}\n\n${done.join("\n")}\n`)
    : `${arch.trimEnd()}\n\n${monthHead}\n\n${done.join("\n")}\n`;
  fs.mkdirSync(path.dirname(TODO_ARCHIVE_FILE), { recursive: true });
  writeAtomic(TODO_ARCHIVE_FILE, arch);

  const total = (arch.match(/^- \[x\] /gm) ?? []).length;
  const at = rest.findIndex((l) => l.trim() === ARCHIVE_SECTION);
  const pointer = `- 历史上已完成的 ${total} 项已移入 \`todo-archive.md\`（按月份归档，可 grep）`;
  if (at < 0) {
    while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
    rest.push("", ARCHIVE_SECTION, "", pointer);
  } else {
    let i = at + 1;
    while (i < rest.length && rest[i].trim() === "") i++;
    while (i < rest.length && rest[i].startsWith("- ")) i++; // 清掉旧的清单指针
    rest.splice(i, 0, pointer);
  }
  saveTodoLines(rest);
  logActivity(`todo archive moved=${done.length} total=${total} file=todo-archive.md`);
  return done.length;
}

/** 正文命中（大小写不敏感子串）；未完成项优先 */
function todoMatches(match: string): Array<{ idx: number; line: string; done: boolean }> {
  const m = match.trim().toLowerCase();
  if (!m) return [];
  return todoLines()
    .map((line, idx) => ({ idx, line, mm: TODO_LINE_RE.exec(line) }))
    .filter((r) => r.mm && r.line.toLowerCase().includes(m))
    .map((r) => ({ idx: r.idx, line: r.line, done: r.mm![1] !== " " }))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.idx - b.idx);
}

function shortTodo(line: string, n = 80): string {
  const body = line.replace(/^- \[[ xX]\] /, "").replace(/<!--.*$/, "").trim();
  const box = line.startsWith("- [x] ") ? "- [x]" : "- [ ]";
  return `${box} ${body.length > n ? `${body.slice(0, n)}…` : body}`;
}

function opTodoAdd(text: string, section?: string, project?: string, tags?: string[], due?: string): string {
  const parsed = parseTodoMeta(text.replace(/\s+/g, " ").trim());
  const body = parsed.text;
  if (!body) return "todo_add 需要 text（待办正文）。";
  const merged: TodoMeta = {
    project: (project ?? "").trim().replace(/^@/, "") || parsed.project,
    tags: [...parsed.tags, ...(tags ?? []).map((t) => t.trim().replace(/^#/, "")).filter(Boolean)],
    due: (due ?? "").trim() || parsed.due,
    text: body,
  };
  if (merged.due && !/^\d{4}-\d{2}-\d{2}$/.test(merged.due))
    return `due 需要 YYYY-MM-DD（收到「${merged.due}」）。`;
  const lines = todoLines();
  if (!lines.length) return "（todo.md 不存在）";
  const item = `- [ ] ${body}${todoSuffix(merged.project, [...new Set(merged.tags)], merged.due)}`;
  if (section) {
    const from = lines.findIndex(
      (l) => l.startsWith("## ") && l.toLowerCase().includes(section.trim().toLowerCase()),
    );
    if (from < 0)
      return `找不到小节「${section}」；现有小节：${lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3)).join(" / ")}`;
    let at = -1;
    for (let i = from + 1; i < lines.length && !lines[i].startsWith("## "); i++) if (TODO_LINE_RE.test(lines[i])) at = i;
    if (at < 0) lines.splice(from + 1, 0, "", item);
    else lines.splice(at + 1, 0, item);
  } else {
    let at = -1;
    for (let i = 0; i < lines.length; i++) if (TODO_LINE_RE.test(lines[i])) at = i;
    if (at < 0) lines.push(item);
    else lines.splice(at + 1, 0, item);
  }
  saveTodoLines(lines);
  logActivity(`todo_add ${body.slice(0, 60)}`);
  return `已加入待办：${shortTodo(item)}\ntodo.md：${todoSummaryText()}`;
}

/** 面板用：按 todo.md 行下标直接勾选/取消（下标取自 todoMatches 或同一次渲染） */
function opTodoToggleAt(idx: number, done: boolean): string {
  const lines = todoLines();
  const line = lines[idx] ?? "";
  if (!TODO_LINE_RE.test(line)) return `${idx} 行不是待办条目（可能已被其他会话改动，请重开面板）`;
  const body = line.replace(DONE_MARK_RE, "").replace(/^- \[([ xX])\] /, "");
  lines[idx] = done ? `- [x] ${body} <!-- done: ${new Date().toISOString().slice(0, 10)} -->` : `- [ ] ${body}`;
  saveTodoLines(lines);
  logActivity(`todo_${done ? "done" : "undo"}@L${idx} ${body.slice(0, 60)}`);
  return `${done ? "已勾选完成" : "已恢复未完成"}：${shortTodo(lines[idx])}\ntodo.md：${todoSummaryText()}`;
}

function opTodoSet(match: string, done: boolean): string {
  const hits = todoMatches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  const togglable = hits.filter((h) => h.done !== done);
  if (!togglable.length)
    return `命中 ${hits.length} 项，但都已是${done ? "完成" : "未完成"}状态：\n${hits.slice(0, 5).map((h) => `· ${shortTodo(h.line)}`).join("\n")}`;
  if (togglable.length > 1)
    return `命中 ${togglable.length} 项，请换更具体的关键词（未改动任何条目）：\n${togglable.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = togglable[0];
  const lines = todoLines();
  const body = target.line.replace(DONE_MARK_RE, "").replace(/^- \[[ xX]\] /, "");
  lines[target.idx] = done
    ? `- [x] ${body} <!-- done: ${new Date().toISOString().slice(0, 10)} -->`
    : `- [ ] ${body}`;
  saveTodoLines(lines);
  logActivity(`todo_${done ? "done" : "undo"} ${body.slice(0, 60)}`);
  return `${done ? "已勾选完成" : "已恢复未完成"}：${shortTodo(lines[target.idx])}\ntodo.md：${todoSummaryText()}`;
}

/** 按唯一命中改写待办正文（保留勾选状态与 done 标记） */
function opTodoEdit(match: string, text: string): string {
  const body = text.replace(/\s+/g, " ").trim();
  if (!body) return "todo_edit 需要 text（新的待办正文）。";
  const hits = todoMatches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  if (hits.length > 1)
    return `命中 ${hits.length} 项，请换更具体的关键词（未改动任何条目）：\n${hits.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = hits[0];
  const lines = todoLines();
  const doneMark = target.done ? (lines[target.idx].match(/<!-- done: [^>]+ -->/)?.[0] ?? "") : "";
  const kept = doneMark ? ` ${doneMark}` : "";
  lines[target.idx] = `- [${target.done ? "x" : " "}] ${body}${kept}`;
  saveTodoLines(lines);
  logActivity(`todo_edit@L${target.idx} ${body.slice(0, 60)}`);
  return `已改写待办：${shortTodo(lines[target.idx])}\ntodo.md：${todoSummaryText()}`;
}
/** 按唯一命中删除待办行 */
function opTodoDelete(match: string): string {
  const hits = todoMatches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  if (hits.length > 1)
    return `命中 ${hits.length} 项，请换更具体的关键词（未删除任何条目）：\n${hits.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = hits[0];
  const lines = todoLines();
  const removed = lines.splice(target.idx, 1)[0];
  saveTodoLines(lines);
  logActivity(`todo_delete@L${target.idx} ${shortTodo(removed, 60)}`);
  return `已删除待办：${shortTodo(removed)}\ntodo.md：${todoSummaryText()}`;
}

// ---- 跨进程锁包装：todo.md / summary.md 的「读—改—写」都从这里进 ----
function lockedTodoAdd(text: string, section?: string, project?: string, tags?: string[], due?: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoAdd(text, section, project, tags, due));
}
function lockedTodoSet(match: string, done: boolean): string {
  return withFileLockSync(TODO_FILE, () => opTodoSet(match, done));
}
function lockedTodoToggleAt(idx: number, done: boolean): string {
  return withFileLockSync(TODO_FILE, () => opTodoToggleAt(idx, done));
}
function lockedTodoEdit(match: string, text: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoEdit(match, text));
}
function lockedTodoDelete(match: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoDelete(match));
}
function lockedArchiveDone(): number {
  return withFileLockSync(TODO_FILE, () => archiveDone());
}
function lockedSummaryAdd(project: string, title: string, body: string): string {
  return withFileLockSync(SUMMARY_FILE, () => opSummaryAdd(project, title, body));
}
function lockedSummaryUpdate(match: string, body: string): string {
  return withFileLockSync(SUMMARY_FILE, () => opSummaryUpdate(match, body));
}

/** 空格分隔的关键词全部命中（大小写不敏感） */
function kwAll(hay: string, q: string): boolean {
  const h = hay.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((k) => h.includes(k));
}

function matchesQuery(e: Entry, q: string): boolean {
  return kwAll(`${e.meta.subject}\n${e.meta.kind}\n${e.meta.scope}\n${e.body}`, q);
}

function searchTodos(q: string): string {
  let text = "";
  try {
    text = fs.readFileSync(TODO_FILE, "utf8");
  } catch {
    return "（todo.md 不存在）";
  }
  // 归档项只在带关键词时才读（否则等于把历史支出重新搬回来）
  const archText = q
    ? (() => {
        try {
          return fs.readFileSync(TODO_ARCHIVE_FILE, "utf8");
        } catch {
          return "";
        }
      })()
    : "";
  const own = text.split("\n").filter((l) => l.startsWith("- [ ] ") || l.startsWith("- [x] "));
  const open = own.filter((l) => l.startsWith("- [ ] "));
  const archived = archText.split("\n").filter((l) => l.startsWith("- [x] "));
  // 筛选语法：@project / #tag / due:soon|week|today|overdue|YYYY-MM-DD，其余词按正文匹配
  const tokens = q.split(/\s+/).filter(Boolean);
  let fdProject = "";
  const fdTags: string[] = [];
  let fdDue: ((d?: string) => boolean) | null = null;
  let fdDueLabel = "";
  const words: string[] = [];
  const dueStates: Record<string, DueState[]> = {
    overdue: ["overdue"],
    today: ["today"],
    soon: ["overdue", "today", "soon"],
    week: ["overdue", "today", "soon"],
  };
  for (const t of tokens) {
    if (t.startsWith("@")) fdProject = t.slice(1).toLowerCase();
    else if (t.startsWith("#")) fdTags.push(t.slice(1).toLowerCase());
    else if (t.toLowerCase().startsWith("due:")) {
      const v = t.slice(4).toLowerCase();
      if (dueStates[v]) {
        fdDue = (d) => dueStates[v].includes(dueState(d));
        fdDueLabel = `due:${v}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        fdDue = (d) => d === v;
        fdDueLabel = `due:${v}`;
      } else return `due: 支持 soon / week / today / overdue / YYYY-MM-DD（收到「${t}」）。`;
    } else words.push(t);
  }
  const structured = Boolean(fdProject || fdTags.length || fdDue);
  const filterLine = (l: string): boolean => {
    if (!structured) return true;
    const meta = parseTodoMeta(l.slice(6).replace(/<!--.*$/, "").trim());
    if (fdProject && !(meta.project ?? "").toLowerCase().includes(fdProject)) return false;
    if (fdTags.length && !fdTags.every((tg) => meta.tags.some((mt) => mt.toLowerCase() === tg))) return false;
    return fdDue ? fdDue(meta.due) : true;
  };
  const pool = (q ? `${text}\n${archText}` : text).split("\n");
  const hits = pool.filter(
    (l) =>
      (l.startsWith("- [ ] ") || (q && l.startsWith("- [x] "))) &&
      filterLine(l) &&
      (words.length ? kwAll(l, words.join(" ")) : true),
  );
  const cert = [`未完成 ${open.length} 项`, `归档 ${archived.length} 项`];
  if (structured)
    cert.push(`筛选 ${[fdProject ? `@${fdProject}` : "", ...fdTags.map((t) => `#${t}`), fdDueLabel].filter(Boolean).join(" ")}`);
  if (words.length) cert.push(`关键词「${words.join(" ")}」`);
  const head = `todo.md：${cert.join(" · ")}${q || structured ? ` · 命中 ${hits.length}` : ""}`;
  if (!hits.length) return `${head}\n（无匹配；换个关键词/标签，或 source=summary 查工程实况、source=entries 查记忆条目）`;
  return `${head}\n${hits.slice(0, 20).map((l) => l.slice(0, 246)).join("\n")}${hits.length > 20 ? `\n…（还有 ${hits.length - 20} 项）` : ""}`;
}

/** 无 query：只读目录索引，按项目分组列最新标题（不读正文） */
function summaryNav(cwd?: string): string {
  const rows = summaryIndex();
  if (!rows.length) return "summary.md：还没有小节（用 living_memory_update summary_add 追加）。";
  const base = path.basename(cwd ?? "");
  const groups = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const g = groups.get(r.project) ?? [];
    g.push(r);
    groups.set(r.project, g);
  }
  const order = [...groups.keys()].sort((a, b) =>
    a.toLowerCase().includes(base.toLowerCase()) ? -1 : b.toLowerCase().includes(base.toLowerCase()) ? 1 : 0,
  );
  const out = order.map((g) => {
    const top = (groups.get(g) ?? []).slice(-4).reverse();
    return `## ${g}（${groups.get(g)?.length ?? 0} 节）\n${top.map((r) => `  [${r.num}] ${r.title}`).join("\n")}`;
  });
  return `summary.md：${rows.length} 节，${groups.size} 个项目（标题导航；具体正文用 query 关键词检索）\n${out.join("\n")}`;
}

function searchSummary(q: string, cwd?: string): string {
  if (!q) return summaryNav(cwd);
  let text = "";
  try {
    text = fs.readFileSync(SUMMARY_FILE, "utf8");
  } catch {
    return "（summary.md 不存在）";
  }
  const base = path.basename(cwd ?? "");
  // summary.md 每个小节是「### [NN] 标题」索引行 + 「### 标题」正文块两段，只取正文块避免同一个事实成对出现
  const blocks = text.split(/\n(?=### )/).filter((b) => b.startsWith("### ") && !/^### \[\d+\] /.test(b));
  let list = blocks;
  let where = "全量";
  if (!q && base) {
    const hit = text
      .split(/\n(?=## )/)
      .find((s) => s.startsWith("## ") && s.split("\n")[0].toLowerCase().includes(base.toLowerCase()));
    if (hit) {
      list = hit.split(/\n(?=### )/).filter((b) => b.startsWith("### ") && !/^### \[\d+\] /.test(b));
      where = base;
    }
  }
  const hits = q ? list.filter((b) => kwAll(b, q)) : list;
  if (!hits.length)
    return `summary.md：${
      q ? `无命中（共 ${blocks.length} 节）` : `${where} 无对应项目节（共 ${blocks.length} 节）`
    }${q ? "\n（最老的小节可能已被 summary_archive 移走，试 source=summary-archive）" : ""}`;
  const out = hits.slice(0, 8).map((b) => {
    const heading = b.split("\n")[0].trim();
    const body = b
      .split("\n")
      .slice(1)
      .filter((l) => l.trim() && !l.startsWith("<!--") && !l.startsWith("#"))
      .map((l) => l.trim());
    const line = q ? body.find((l) => kwAll(l, q)) ?? body[0] ?? "" : body[0] ?? "";
    return `${heading}${line ? `\n  ${line.slice(0, 200)}` : ""}`;
  });
  return `summary.md：${q ? `关键词命中 ${hits.length} 节（共 ${blocks.length} 节）` : `${where} 节 ${hits.length} 条（共 ${blocks.length} 节）`}\n${out.join("\n")}${hits.length > out.length ? `\n…（还有 ${hits.length - out.length} 节，用更具体的关键词收窄）` : ""}`;
}

// ---------- 归档层检索：只读外挂 qmd（BM25），不索引 living 热数据、不碰存储 ----------
const QMD_BIN = process.env.LIVING_MEMORY_QMD ?? "qmd";
/**
 * 在 qmd 的既有快照索引里检索归档细节（原 pi-memory daily / MEMORY / SCRATCHPAD 全文）。
 * 纯只读：不调 update/embed，索引停留在 2026-11-15 快照；qmd 未装或报错时返回人话而不是抛异常。
 */
function searchArchive(q: string, limit: number): string {
  const n = Math.max(1, Math.min(25, limit || 5));
  if (!q) return "归档检索需要 query（走 qmd BM25，只覆盖 2026-11-15 快照索引：原 MEMORY/SCRATCHPAD/daily）。\n例：living_memory source=archive query=\"并发 重复扣款\"";
  const res = spawnSync(QMD_BIN, ["search", q, "--limit", String(n), "--json"], {
    encoding: "utf8",
    timeout: Number(process.env.LIVING_MEMORY_QMD_TIMEOUT_MS ?? 30_000),
    killSignal: "SIGKILL",
  });
  if (res.error || res.status !== 0) {
    const why = res.error ? String((res.error as any).message ?? res.error) : (res.stderr || "").trim().split("\n").slice(0, 2).join(" ");
    return `归档检索不可用（qmd 调用失败）：${why || `exit ${res.status}`}。\n装 qmd 或用 LIVING_MEMORY_QMD=<路径> 指定；living 自身不依赖它。`;
  }
  let hits: Array<{ score: number; file: string; line: number; title: string; snippet: string }> = [];
  try {
    hits = JSON.parse(res.stdout || "[]");
  } catch {
    return `归档检索失败：qmd 输出不是 JSON（前 200 字符）${String(res.stdout ?? "").slice(0, 200)}`;
  }
  if (!Array.isArray(hits) || !hits.length) return `归档检索「${q}」无命中（索引共 125 文档的快照，覆盖原 MEMORY.md/SCRATCHPAD/daily）。`;
  const rows = hits.slice(0, n).map((h) => {
    const body = String(h.snippet ?? "")
      .replace(/^@@[^\n]*\n+/, "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return `- ${h.file}#L${h.line} · ${Math.round((h.score ?? 0) * 100)}% · ${h.title ?? ""}\n  ${body.slice(0, 220)}${body.length > 220 ? "…" : ""}`;
  });
  return `归档检索「${q}」：命中 ${hits.length} 段（qmd BM25，快照索引，只读）\n${rows.join("\n")}${hits.length > n ? `\n…（还有 ${hits.length - n} 段，加 LIMIT 或收窄关键词）` : ""}`;
}
function normSubject(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s·・、，,。.:：;；/\-—_'"“”‘’《》<>()[\]{}!！?？]/g, "");
}

function normBody(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[，,。.;；:：、"'“”‘’《》()（）]/g, "");
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 这段正文是否已被某条活动条目覆盖（Jaccard ≥ 0.45，或整句被条目正文包含） */
function coveredByEntry(text: string): string | null {
  // 去掉行首「决定：」「教训：」这类标签词，否则整句以标签开头、永远匹配不到条目正文
  const nb = normBody(text).replace(/^(决定|决策|约定|教训|结论|铁律|口径|规则|保留|采用)/, "");
  if (nb.length < 8) return null;
  const bag = bigrams(nb);
  for (const e of listEntries()) {
    if (!ACTIVE.has(e.meta.status)) continue;
    const eb = normBody(e.body);
    if (!eb) continue;
    // 任一 16 字窗口在条目正文里出现即视为已覆盖（比整句前缀匹配宽容，又比 bigram 稳）
    for (let i = 0; i + 16 <= nb.length; i += 4) {
      if (eb.includes(nb.slice(i, i + 16))) return e.meta.id;
    }
    if (jaccard(bag, bigrams(eb)) >= 0.45) return e.meta.id;
  }
  return null;
}

/**
 * 冲突/重复自检（草案 2）：只看活动条目。
 *  ①同归一 subject 多活动条（kind 不同也算）②同 kind 且正文 bigram Jaccard ≥ 0.62。
 * 纯读，不改库；结论只是"候选"，是否合并仍需人/agent 判断。
 */
function findConflicts(): Array<{ type: string; label: string; ids: string[]; note: string }> {
  const act = listEntries().filter((e) => ACTIVE.has(e.meta.status));
  const out: Array<{ type: string; label: string; ids: string[]; note: string }> = [];
  const covered = new Set<string>();
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  const subj = new Map<string, Entry[]>();
  for (const e of act) {
    const k = normSubject(e.meta.subject);
    if (!k) continue;
    if (!subj.has(k)) subj.set(k, []);
    subj.get(k)!.push(e);
  }
  for (const [, es] of subj) {
    if (es.length < 2) continue;
    const kinds = [...new Set(es.map((e) => e.meta.kind))].join("/");
    out.push({ type: "subject", label: `${es[0].meta.subject}（${kinds}）`, ids: es.map((e) => e.meta.id), note: "同主体多活动条" });
    for (let a = 0; a < es.length; a++) for (let b = a + 1; b < es.length; b++) covered.add(pairKey(es[a].meta.id, es[b].meta.id));
  }
  const bodies = act
    .map((e) => ({ e, t: normBody(parseEntry(entryPath(e.meta.id))?.body ?? "") }))
    .filter((x) => x.t.length >= 30);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (bodies[i].e.meta.kind !== bodies[j].e.meta.kind) continue;
      const s = jaccard(bigrams(bodies[i].t), bigrams(bodies[j].t));
      if (s < 0.62) continue;
      // 已被「同主体」组覆盖的配对不再重复报
      if (covered.has(pairKey(bodies[i].e.meta.id, bodies[j].e.meta.id))) continue;
      out.push({
        type: "text",
        label: `${bodies[i].e.meta.subject} ≈ ${bodies[j].e.meta.subject}（相似 ${Math.round(s * 100)}%）`,
        ids: [bodies[i].e.meta.id, bodies[j].e.meta.id],
        note: "正文近似，疑似同一事实两次记录",
      });
    }
  }
  return out;
}

function renderLint(): string {
  const act = listEntries().filter((e) => ACTIVE.has(e.meta.status));
  const hits = findConflicts();
  const head = `冲突自检：活动 ${act.length} 条，检出 ${hits.length} 组候选`;
  if (!hits.length) return `${head}（无同主体重复、无正文近似）。`;
  const rows = hits.map((h, i) => {
    const detail = h.ids
      .map((id) => {
        const e = listEntries().find((x) => x.meta.id === id);
        return e ? `${id}（${e.meta.kind}/${e.meta.status}/${e.meta.obtained_at.slice(0, 10)}）${e.meta.subject}` : id;
      })
      .join("  ⊗  ");
    return `${i + 1}. [${h.type}] ${h.label}\n   ${detail}\n   → ${h.note}，建议 supersede 合并 + expire 另一条`;
  });
  return `${head}\n${rows.join("\n")}`;
}

/** 分流审计：entries 里像工程实况的 / summary 里像长期事实的，各给建议 */
function renderRouting(): string {
  const PROC = /修复|实现|部署|合并|重构|调试|排查|迁移|构建|编译|测试通过|改完|跑通/;
  const DECISIONISH = /决定|决策|约定|规则|铁律|口径|必须|永不|禁止|不要|优先|保留|采用|命名|锁定|白名单|不得|不允许|一律|须/;
  const act = listEntries().filter((e) => ACTIVE.has(e.meta.status));
  // A. 只看「本应短期」的类别：outcome/event/correction 若写成工程报告，才建议搬去 summary
  const PROCESS_KINDS = ["outcome", "event", "correction"];
  const likeSummary = act.filter(
    (e) => PROCESS_KINDS.includes(e.meta.kind) && PROC.test(e.body) && !DECISIONISH.test(`${e.meta.subject} ${e.body}`),
  );
  // B. summary 小节里像长期事实/规则的句子（应从工程实况升格为条目）
  // B 只看「整句像规则」的行：markdown 列表项以决定/约定/必须/禁止/不得/一律/铁律/口径开头
  const META_SECTION = /profile\.md|build-profile|living-memory\.ts|living_memory|STATS|brief|summary\.md|todo\.md|插件自身/i;
  const RULE_LINE = /^\s*[-*]\s*(决定|决策|约定|铁律|口径|规则|必须|永不|禁止|不得|一律|采用|保留|锁定)/;
  const ruleLines = (s: SummarySection) => s.lines.filter((l) => RULE_LINE.test(l));
  const likeEntry = summarySections(summaryLines())
    .sections.filter((s) => !/归档/.test(s.title))
    .map((s) => ({ s, rules: ruleLines(s) }))
    .filter((x) => x.rules.length > 0 && !SELF_REF_MARK.test(x.s.title) && !META_SECTION.test(x.s.title))
    .map((x) => ({ ...x, covered: coveredByEntry(x.rules.join(" ")) }));
  const promote = likeEntry.filter((x) => !x.covered);
  const covered = likeEntry.filter((x) => x.covered);
  const out: string[] = [
    `分流审计：活动条目 ${act.length} 条，summary ${summarySections(summaryLines()).sections.length} 节`,
  ];
  if (likeSummary.length) {
    out.push(`\nA. 条目里像工程实况的 ${likeSummary.length} 条（可 summary_add 后用 expire 收口）:`);
    for (const e of likeSummary.slice(0, 8))
      out.push(`  · ${e.meta.id}（${e.meta.kind}/${e.meta.subject}）${e.body.slice(0, 50)}`);
  } else out.push("\nA. 条目里未发现明显的过程性叙述。");
  if (promote.length) {
    out.push(`\nB. summary 里含规则句、尚无对应条目的 ${promote.length} 节（待确认后可 remember）:`);
    for (const x of promote.slice(-8))
      out.push(`  · [${x.s.num}] ${x.s.title.slice(0, 36)} → ${x.rules[0].trim().slice(0, 60)}`);
  } else out.push("\nB. summary 里未发现「有规则句但无对应条目」的节。");
  if (covered.length) out.push(`（另有 ${covered.length} 节已有条目覆盖，未列出）`);
  out.push("\n口径：过程性事实 → summary；跨会话持久的偏好/约束/关系/决定 → entries；未完成事项 → todo.md。");
  return out.join("\n");
}

function buildBrief(cwd?: string): string {
  const { active, pending, due } = briefIndex();
  if (!active.length) return "";
  const base = path.basename(cwd ?? "");
  const scoped = (e: EntryIndex) => {
    const s = e.meta.scope || "global";
    if (s === "global" || !base) return false;
    return s.includes(base);
  };
  const urgent = (a: EntryIndex, b: EntryIndex) => {
    const ia = a.meta.action_impact === "needs-confirm" ? 1 : 0;
    const ib = b.meta.action_impact === "needs-confirm" ? 1 : 0;
    if (ia !== ib) return ib - ia;
    return String(b.meta.obtained_at).localeCompare(String(a.meta.obtained_at));
  };
  const visible = active.filter((e: EntryIndex) => inScope(e, cwd));
  const d = visible.filter((e: Entry) => isDue(e.meta)).sort(urgent);
  const p = visible.filter((e: Entry) => e.meta.status === "inference" && !d.includes(e)).sort(urgent);
  const proj = visible.filter((e: Entry) => !d.includes(e) && !p.includes(e) && scoped(e)).sort(urgent);
  // 负面偏好（不要/禁止/避免…）在全局档里优先，避免「别做 X」被普通偏好挤掉
  const glob = visible
    .filter((e: Entry) => !d.includes(e) && !p.includes(e) && !scoped(e))
    .sort((a: Entry, b: Entry) => (isNegation(b) ? 1 : 0) - (isNegation(a) ? 1 : 0) || urgent(a, b));
  const tiers: Array<{ tag: string; cap: number; items: EntryIndex[] }> = [
    { tag: "[到期] ", cap: 5, items: d },
    { tag: "", cap: 8, items: proj },
    { tag: "[推断·弱] ", cap: 4, items: p },  // 低于自动门槛的推断：只作弱参考，不按事实处理
    { tag: "", cap: 5, items: glob },
  ];
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const t of tiers) {
    let n = 0;
    for (const e of t.items) {
      if (n >= t.cap) {
        dropped++;
        continue;
      }
      const text = briefLine(t.tag || (isNegation(e) ? "[雷区] " : ""), e);
      if (used + text.length + 1 > BRIEF_MAX_CHARS) {
        dropped++;
        continue;
      }
      lines.push(text);
      used += text.length + 1;
      n++;
    }
  }
  if (!lines.length) return "";
  const openTodos = todoOpenCount();
  // 当前项目节的未完成待办摘 2 条（内容不塞进 entries，只做行内提醒）
  if (base && used + TODO_DIGEST_RESERVE <= BRIEF_MAX_CHARS) {
    for (const t of todoDigest(base, 2)) {
      const line = `待办·${t.section}：${t.text}`;
      if (used + line.length + 1 > BRIEF_MAX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
  }

  // 到期提醒：逾期 / 今天 / 7 日内（跨项目，最多 3 条）
  const dueTodo = dueRows();
  if (dueTodo.length) {
    const show = dueTodo.slice(0, 3);
    const line = `待办到期：${show
      .map((r) => `${dueState(r.due) === "overdue" ? `逾期(${r.due})` : r.due} ${r.text.slice(0, 22)}`)
      .join(" · ")}${dueTodo.length > 3 ? ` …（共 ${dueTodo.length} 项）` : ""}`;
    if (used + line.length + 1 <= BRIEF_MAX_CHARS) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  // 最近 14 天的变更（本项目或全局，按 obtained_at 倒序，最多 3 条）
  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  const recent = [...proj, ...glob]
    .filter((e) => String(e.meta.obtained_at) >= since)
    .sort((a, b) => String(b.meta.obtained_at).localeCompare(String(a.meta.obtained_at)))
    .slice(0, 3);
  if (recent.length) {
    const line = `近期：${recent.map((e) => `${e.meta.obtained_at.slice(5, 10)} ${e.meta.kind}/${e.meta.subject.slice(0, 16)}`).join(" · ")}`;
    if (used + line.length + 1 <= BRIEF_MAX_CHARS) {
      lines.push(line);
      used += line.length + 1;
    }
  }

  // 画像摘要（默认关：LIVING_MEMORY_PROFILE_BRIEF=1 开）
  if (PROFILE_BRIEF_ON()) {
    const digest = profileDigest();
    if (digest) {
      const line = `· 画像：${digest}`;
      if (used + line.length + 1 <= BRIEF_MAX_CHARS + 220) {
        lines.push(line);
        used += line.length + 1;
      }
    }
  }

  const shownNote = `${lines.length}/${visible.length}${dropped ? `（${dropped} 条未显示，用 living_memory 查全文）` : ""}`;
  const dueTodoCount = dueRows().length;
  const tail = `\n（活动 ${active.length} · 到期 ${due.length} · 待确认 ${pending.length} · 简报 ${shownNote}${openTodos ? ` · 待办 ${openTodos} 项` : ""}${dueTodoCount ? ` · 待办到期 ${dueTodoCount} 项` : ""} — 检索 source=todo/summary/entries；治理 /memory）`;
  return `\n\n## Living Memory（个人长期记忆层 · Today 契约）\n到期项需处理；[待确认] 是未经确认的推断，只能作弱参考，不得当事实引用。完整正文用 living_memory；纠正用 living_memory_update supersede；工程实况用 living_memory source=summary/todo 检索；待办勾选用 living_memory_update action=todo_done match=唯一关键词。\n${lines.join("\n")}${tail}`;
}

// ---------- Phase 3：自动抽取 ----------
function dbg(s: string) {
  if (process.env.LIVING_MEMORY_DEBUG === "1") {
    try {
      fs.appendFileSync("/tmp/living-memory-debug.log", `[${new Date().toISOString()}] ${s}\n`);
    } catch {
      /* 调试失败无害 */
    }
  }
}
function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
  return "";
}

function conversationText(msgs: any[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const t = textOf(m).trim();
    if (t) parts.push(`[${m.role}] ${t}`);
  }
  const s = parts.join("\n");
  return s.length > 6000 ? s.slice(-6000) : s;
}

function extractEnabled(): boolean {
  return process.env.LIVING_MEMORY_EXTRACT !== "0";
}

function resolveExtractModel(ctx: any): any | null {
  const spec = (process.env.LIVING_MEMORY_EXTRACT_MODEL ?? "").trim();
  if (!spec) return ctx?.model ?? null;
  const slash = spec.indexOf("/");
  const reg = ctx?.modelRegistry as any;
  const found = slash > 0 ? reg?.find?.(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
  return found ?? ctx?.model ?? null;
}

async function resolveApiKey(ctx: any, model: any): Promise<string | undefined> {
  const reg = ctx?.modelRegistry as any;
  try {
    if (typeof reg?.getApiKey === "function") return await reg.getApiKey(model);
    if (typeof reg?.getApiKeyForProvider === "function") return await reg.getApiKeyForProvider(model.provider);
  } catch {
    /* fallthrough */
  }
  return undefined;
}

function extractionSystemPrompt(existing: string): string {
  return [
    "你是长期记忆抽取器（Today 记忆契约）。从对话中抽取「跨会话仍有价值」的记忆候选。",
    "准入五类：稳定偏好 / 进行中承诺或截止 / 关系信息 / 用户纠正 / 决策与行动结果。",
    "禁入：凭证密钥、未证实敏感推断（健康/政治/财务/性取向）、一时状态、可被日志替代的完整记录、超出任务需要的他人隐私。另禁入：①记忆系统自身的状态/条目推断（自我指涉：面板/库/抽取器的状态一律不当候选）②会话过程性事项（提案、待办、瞬时 git 或仓库状态）——已明确拍板的决策除外 ③**工程实现本身**：把「我们实现了 X / 修了 Y / 加了某索引·缓存·动作·阈值 / 改了某函数行为」记为 decision 或 correction 也属自指污染，这类内容归 summary.md（summary_add），抽取器必须跳过；只有「用户对系统提出的要求或偏好」才可抽 close 到 preference/constraint。",
    existing ? `已知活动条目（勿重复抽取；仅当对话明确纠正既有事实时抽 correction）：\n${existing}` : "当前无既有条目。",
    '只输出 JSON 数组（无任何其它文字），每项 {"kind":"preference|constraint|commitment|relation|correction|decision|outcome","subject":"说谁/什么","text":"1-3 句事实","confidence":0-1}。最多 3 项；无可抽取内容输出 []。',
  ].join("\n");
}

let extractionInFlight = false;
let pendingExtraction: Promise<void> | null = null;
let lastRunMessages: any[] | null = null;

function scheduleExtraction(msgs: any[], ctx: any, reason: string) {
  if (extractionInFlight) return;
  const text = conversationText(msgs);
  dbg(`scheduleExtraction (${reason}): text=${text.length}ch`);
  if (!text) return;
  extractionInFlight = true;
  const timeoutMs = Number(process.env.LIVING_MEMORY_EXTRACT_TIMEOUT_MS ?? 20000);
  pendingExtraction = (async () => {
    const expired = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    await Promise.race([runExtraction(text, ctx, reason), expired]);
  })()
    .catch(() => {})
    .finally(() => {
      extractionInFlight = false;
    });
}

async function runExtraction(text: string, ctx: any, reason: string): Promise<void> {
  try {
    if (isPaused()) return;
    const model = resolveExtractModel(ctx);
    if (!model) return;
    const apiKey = await resolveApiKey(ctx, model);
    dbg(`runExtraction ${reason}: model=${model?.provider ?? "?"}/${model?.id ?? "?"} apiKey=${apiKey ? "yes" : "no"}`);
    if (!apiKey) {
      logActivity(`auto-extract skipped: no api key (${reason})`);
      return;
    }
    const existing = brief()
      .active.slice(0, 20)
      .map((e) => `- ${e.meta.kind}/${e.meta.subject}: ${e.body.replace(/\n/g, " ").slice(0, 60)}`)
      .join("\n");
    const response = await complete(
      model,
      {
        systemPrompt: extractionSystemPrompt(existing),
        messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
      },
      { apiKey, reasoningEffort: "low" },
    );
    const out = ((response as any).content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    dbg(`extraction raw out: ${JSON.stringify(out).slice(0, 300)}`);
    if (!out) {
      noteExtractFailure("empty-response", `model=${model.id} 回包无文本（${reason}）`);
      return;
    }
    let raw = out;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1];
    const l = raw.indexOf("[");
    const r = raw.lastIndexOf("]");
    if (l < 0 || r <= l) {
      noteExtractFailure("no-json", `回包里找不到 JSON 数组：${out.slice(0, 120)}`);
      return;
    }
    let items: any;
    try {
      items = JSON.parse(raw.slice(l, r + 1));
      dbg(`parsed ${Array.isArray(items) ? items.length : "non-array"} items`);
    } catch {
      noteExtractFailure("parse-failed", `JSON 解析失败：${raw.slice(l, l + 120)}（${reason}）`);
      return;
    }
    let n = 0;
    for (const item of Array.isArray(items) ? items.slice(0, 3) : []) {
      const kind = String(item?.kind ?? "");
      const subject = String(item?.subject ?? "").trim();
      const body = String(item?.text ?? "").trim();
      const conf = Number(item?.confidence ?? 0.6);
      if (!(KINDS as readonly string[]).includes(kind) || !subject || !body) continue;
      // 自指过滤：讲插件自身实现/参数的候选不立条目（归 summary），避免「开发过程」污染个人记忆层
      if (isPluginInternal(subject)) {
        logActivity(`auto-extract skipped self-ref kind=${kind} subject=${subject} (${reason})`);
        continue;
      }
      const dup = findConflicting(kind, subject, body);
      if (dup) {
        // 同一推断再次被抽取到：算一次复现证据（不新建条目，不改 confidence）
        if (dup.meta.status === "inference")
          appendEvidence(dup, { at: new Date().toISOString(), kind: "repeat", id: `extract-${reason}`, note: "抽取器再次命中同一事实" });
        continue;
      }
      const autoFact = autoFactable(kind, conf, "advice-only");
      const id = newId();
      const meta: Meta = {
        id,
        kind,
        status: autoFact ? "confirmed" : "inference",
        subject,
        scope: "global",
        source: `auto-extract ${today()}（${reason} 模型抽取，${autoFact ? "高置信度自动按事实" : "待用户确认"}）`,
        obtained_at: new Date().toISOString(),
        confirmed_at: autoFact ? new Date().toISOString() : "",
        expires_at: "",
        review_after: new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10),
        confidence: String(Math.min(Math.max(conf, 0), 1)),
        action_impact: "advice-only",
        supersedes: "",
        superseded_by: "",
      };
      writeEntry(meta, body);
      logActivity(
        `auto-extract created ${id} kind=${kind} status=${meta.status}${autoFact ? ` auto-fact conf=${meta.confidence}` : ""} subject=${subject} (${reason})`,
      );
      n++;
    }
    dbg(`candidates written: ${n}`);
    if (n > 0) {
      if (ctx?.hasUI) {
        try {
          ctx.ui.notify(
            `living memory：自动抽取 ${n} 条（confidence ≥ ${AUTO_FACT_CONF()} 已按事实处理，其余待确认）—— /memory review 可逐条看。`,
            "info",
          );
        } catch {
          /* 尽力而为 */
        }
      }
      const cleaned = autoTriage("after-extract");
      if (cleaned.length && ctx?.hasUI) {
        try {
          ctx.ui.notify(`living memory 自动清理（A 档）${cleaned.length} 条：${cleaned.join("；")}`, "info");
        } catch {
          /* 尽力而为 */
        }
      }
      refreshWidget(ctx);
    }
  } catch (err) {
    dbg(`runExtraction threw: ${err instanceof Error ? err.message : String(err)}`);
    noteExtractFailure("request-failed", err instanceof Error ? err.message : String(err));
  }
}

// ---------- 扩展 ----------
export default function (pi: ExtensionAPI) {
  // settings.json 里 livingMemory.autoTriage 控制 A 档自动清理（env LIVING_MEMORY_AUTO_TRIAGE 可临时覆盖）
  readSettings = () => {
    try {
      return pi.getSettings?.() ?? null;
    } catch {
      return null;
    }
  };
  // 工具 1：写入（显式/事件/推断 三种 basis）
  pi.registerTool({
    name: "remember",
    label: "长期记忆写入",
    description:
      "写入一条带生命周期元数据的个人长期记忆（Today 记忆契约）。仅记五类准入：稳定偏好/进行中承诺/关系信息/用户纠正/决策与行动结果。",
    promptSnippet: "remember: 写入带生命周期元数据的个人长期记忆条目",
    promptGuidelines: [
      "Use remember when the user states a durable personal preference, ongoing commitment/deadline, relation fact, correction, or decision/outcome that matters across sessions — always with kind, subject, basis, source (日期+谁说的+原话引用).",
      "Never call remember for credentials/secrets, unverified sensitive inferences (health/politics/finance/sexuality), transient states（不写入本层）, full transcripts where one fact suffices, or others' private details beyond task need.",
      "remember with basis=inference must set confidence. Inference with confidence >= 0.85 (LIVING_MEMORY_AUTO_FACT) is written as a fact directly (status=confirmed); below that it stays a weak reference in the pending tier until the user confirms. kind=relation and action_impact=needs-confirm always stay pending — set those when the fact is sensitive.",
      "本层是唯一记忆层：同一 subject+kind 已有活动条目时用 living_memory_update supersede 替换，不要并存矛盾事实；工程实况写 summary.md（按项目小节），待办写 todo.md，两者用 living_memory source=summary/todo 检索，不要塞进 entries。",
    ],
    parameters: Type.Object({
      kind: StringEnum(KINDS),
      subject: Type.String({ description: "主体：说谁/什么（如 用户、张三、yangsheng 项目）" }),
      text: Type.String({ description: "记忆正文（1-3 句事实本身；含原话则引用）" }),
      basis: StringEnum(["explicit", "event", "inference"]),
      source: Type.String({ description: "来源：日期+会话/谁说的/原话" }),
      scope: Type.Optional(Type.String({ description: "适用范围：global / workspace:<名> / project:<名>；多值逗号分隔" })),
      expires_at: Type.Optional(Type.String({ description: "ISO 日期：到期自动进复核队列" })),
      review_after: Type.Optional(Type.String({ description: "ISO 日期：到该日进复核（复核而非静默删除）" })),
      confidence: Type.Optional(Type.Number({ description: "basis=inference 必填，0-1" })),
      action_impact: Type.Optional(StringEnum(["advice-only", "reminder", "needs-confirm"])),
    }),
    async execute(_toolCallId: string, p: any, _sig: any, _upd: any, ctx: any) {
      if (isPaused())
        return { content: [{ type: "text", text: "living memory 已被 /memory off 暂停——本次未写入。恢复需用户执行 /memory on。" }] };
      if (p.basis === "inference" && (p.confidence == null || p.confidence < 0 || p.confidence > 1))
        return { content: [{ type: "text", text: "basis=inference 必须带 confidence（0-1）。" }] };
      const dup = findConflicting(p.kind, p.subject, p.text);
      if (dup) {
        // 推断条目被再次提及：记证据而不是新建（第二步）；显式陈述算最强证据 restate
        if (dup.meta.status === "inference" && (p.basis === "inference" || p.basis === "explicit")) {
          const note = appendEvidence(dup, {
            at: new Date().toISOString(),
            kind: p.basis === "explicit" ? "restate" : "repeat",
            id: (p.source ?? "").slice(0, 40) || "remember",
            note: p.basis === "explicit" ? "用户原话重述" : "同一事实再次出现",
          });
          if (note)
            return {
              content: [
                {
                  type: "text",
                  text: `${note}\n（同一事实不新建条目；越过门槛后请用 living_memory_update confirm 转正。）`,
                },
              ],
            };
        }
        return {
          content: [
            {
              type: "text",
              text: `已有同 subject+kind 的活动条目 ${dup.meta.id}：「${dup.body}」。\n不要并存矛盾事实——若是新信息用 living_memory_update supersede 替换；完全重复则忽略。`,
            },
          ],
        };
      }
      // 软提示：同 subject+kind 已有活动条目（正文不相似也算）——只查索引，不读正文
      const wantSubj = normSubject(p.subject);
      const siblings = loadEntriesIndex().filter(
        (r) => ACTIVE.has(r.meta.status ?? "") && r.meta.kind === p.kind && normSubject(r.meta.subject ?? "") === wantSubj,
      );
      const sibHint = siblings.length
        ? `\n提示：同 subject+kind 另有 ${siblings.length} 条活动条目（${siblings
            .slice(0, 3)
            .map((r) => r.id)
            .join("、")}${siblings.length > 3 ? "…" : ""}）——若本次取代旧结论，应用 living_memory_update supersede 而非并存。`
        : "";
      const scopeErr = validateScope(p.scope || "global");
      if (scopeErr) return { content: [{ type: "text", text: scopeErr }] };
      const autoFact = p.basis === "inference" && autoFactable(p.kind, Number(p.confidence), p.action_impact);
      const id = newId();
      const meta: Meta = {
        id,
        kind: p.kind,
        status: autoFact ? "confirmed" : p.basis,
        subject: p.subject,
        scope: (p.scope || "global").trim(),
        source: p.source,
        obtained_at: new Date().toISOString(),
        confirmed_at: autoFact || p.basis === "explicit" ? new Date().toISOString() : "",
        expires_at: p.expires_at || "",
        review_after: p.review_after || defaultReviewAfter(p.basis, p.kind),
        confidence: p.basis === "inference" ? String(p.confidence) : "",
        action_impact: p.action_impact || "advice-only",
        supersedes: "",
        superseded_by: "",
      };
      writeEntry(meta, p.text);
      logActivity(
        autoFact
          ? `created ${id} kind=${p.kind} status=confirmed auto-fact conf=${p.confidence} subject=${p.subject}`
          : `created ${id} kind=${p.kind} status=${p.basis} subject=${p.subject}`,
      );
      refreshWidget(ctx);
      const tail = autoFact
        ? `\n（confidence ${p.confidence} ≥ ${AUTO_FACT_CONF()}：已按事实处理（status=confirmed）。若判断有误，用 supersede 替换或 expire 失效。）`
        : p.basis === "inference"
          ? `\n（置信度 ${p.confidence} < ${AUTO_FACT_CONF()} 或属 relation/needs-confirm：保留为推断，只在「待确认」档作弱参考，需 confirm 才按事实处理。）`
          : "";
      return { content: [{ type: "text", text: `已记入长期记忆 ${id}（status=${meta.status}，scope=${meta.scope}）${tail}${sibHint}\n存储: ${entryPath(id)}` }] };
    },
  });

  // 工具 2：查询
  pi.registerTool({
    name: "living_memory",
    label: "长期记忆查询",
    description: "查询治理层长期记忆（按状态/类别/主体/正文过滤，或只看到期复核项）。回答『你记得我什么』先查这里，引用实际条目而非口头总结。",
    promptSnippet: "living_memory: 查询/列出带生命周期的长期记忆条目",
    promptGuidelines: [
      "Before remembering or correcting, use living_memory to check existing entries; answer『你记得我什么』with actual entries shown by living_memory, not a verbal summary.",
    ],
    parameters: Type.Object({
      source: Type.Optional(
        StringEnum(["entries", "todo", "summary", "summary-archive", "all", "archive", "lint", "routing", "expired", "extract"], { description: "检索面：entries=记忆条目（默认）；todo=todo.md 待办；summary=summary.md 活动工程实况；summary-archive=已归档的旧工程小节；all=前三者都查；archive=qmd 只读快照检索（原 daily/MEMORY/SCRATCHPAD 细节，需 query）；lint=冲突/重复自检；routing=分流审计（条目↔summary 归属建议）；expired=归档区失效条目（只读）；extract=抽取器最近的失败次数与原因" }),
      ),
      query: Type.Optional(
        Type.String({ description: "关键词检索（空格分隔=全部命中）；source=todo/summary 时检索对应文档，source=entries 时按 subject+正文过滤" }),
      ),
      project: Type.Optional(Type.String({ description: "source=summary 时按项目分节过滤（默认取当前工作目录名）" })),
      status: Type.Optional(Type.String({ description: "过滤状态：explicit/event/inference/confirmed/superseded/expired" })),
      kind: Type.Optional(StringEnum(KINDS)),
      subject_contains: Type.Optional(Type.String()),
      text_contains: Type.Optional(Type.String()),
      due: Type.Optional(Type.Boolean({ description: "true=只看活动且今天已到期/待复核" })),
      list: Type.Optional(Type.Boolean({ description: "true=精简列表（只回 id/kind/status/subject，不返回标题与正文），浏览巡检用" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, p: any, ctx: any) {
      const src: string = p.source || "entries";
      const q = String(p.query ?? "").trim();
      // 文档检索面：todo.md（未完成事项）/ summary.md（工程实况，默认按 cwd 项目分节）
      if (src === "lint")
        return { content: [{ type: "text", text: renderLint() }] };
      if (src === "extract")
        return { content: [{ type: "text", text: extractHealthText() }] };
      if (src === "routing")
        return { content: [{ type: "text", text: renderRouting() }] };
      if (src === "expired")
        return { content: [{ type: "text", text: searchExpired(q, p.status, Number(p.limit ?? 30) || 30) }] };
      if (src === "archive")
        return { content: [{ type: "text", text: searchArchive(q, Number(p.limit ?? 5) || 5) }] };
      if (src === "summary-archive")
        return { content: [{ type: "text", text: searchSummaryArchive(q, Number(p.limit ?? 8) || 8) }] };
      if (src === "todo" || src === "summary" || src === "all") {
        const parts: string[] = [];
        if (src !== "summary") parts.push(searchTodos(q));
        if (src !== "todo") parts.push(searchSummary(q, p.project || ctx?.cwd));
        if (src === "all" && q) {
          const hits = listEntries().filter((e: Entry) => ACTIVE.has(e.meta.status) && matchesQuery(e, q));
          parts.push(
            hits.length
              ? `entries：${hits.length} 条命中\n${hits.slice(0, 10).map((e: Entry) => fmt(e)).join("\n")}`
              : "entries：无命中",
          );
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
      }
      // 元数据筛选走索引（一次读盘，frontmatter + 首行摘要）；只有全文匹配时才装载正文
      let rows = loadEntriesIndex();
      if (p.status) rows = rows.filter((r) => r.meta.status === p.status);
      if (p.kind) rows = rows.filter((r) => r.meta.kind === p.kind);
      if (p.subject_contains) rows = rows.filter((r) => r.meta.subject.includes(p.subject_contains));
      if (p.text_contains) rows = rows.filter((r) => (parseEntry(entryPath(r.id))?.body ?? "").includes(p.text_contains));
      if (q) {
        rows = rows.filter((r) => {
          const full = parseEntry(entryPath(r.id));
          return full ? matchesQuery(full, q) : false;
        });
      }
      if (p.due) rows = rows.filter((r) => ACTIVE.has(r.meta.status) && isDue(r.meta));
      const lim = Math.min(p.limit ?? 30, 100);
      if (!rows.length) return { content: [{ type: "text", text: "（无匹配条目）" }] };
      const render = (r: EntryIndex) => {
        if (p.list) return `${r.id} ${r.meta.kind}/${r.meta.status} ${r.meta.subject}`;
        const tags = [r.meta.kind, r.meta.status, `scope=${r.meta.scope}`];
        if (r.meta.confidence) tags.push(`conf=${r.meta.confidence}`);
        if (r.meta.supersedes) tags.push(`supersedes=${r.meta.supersedes}`);
        if (ACTIVE.has(r.meta.status) && isDue(r.meta)) tags.push("DUE");
        return `${r.id} [${tags.join(" · ")}] ${r.meta.subject}: ${r.title.replace(/\n/g, " ")}`;
      };
      return {
        content: [
          {
            type: "text",
            text: `共 ${rows.length} 条${p.status ? "" : `（活动 ${rows.filter((r) => ACTIVE.has(r.meta.status)).length}）`}（显示前 ${Math.min(rows.length, lim)}）：\n\n${rows.slice(0, lim).map(render).join("\n")}`,
          },
        ],
      };
    },
  });

  // 工具 3：治理
  pi.registerTool({
    name: "living_memory_update",
    label: "长期记忆治理",
    description: "治理长期记忆条目：confirm 确认推断 / supersede 纠正替换（旧条目保留 superseded 链）/ renew 续期 / expire 过期 / delete 删除（来源记入审计日志）/ restore 还原；以及 todo.md 待办：todo_done 勾选 / todo_undo 取消 / todo_add 新增；以及 summary.md 工程实况：summary_add 追加小节（自动建节与编号）/ summary_update 改写小节正文；过期批量清理：purge_expired（默认 dry_run，只列候选）。",
    promptSnippet: "living_memory_update: 确认/纠正/续期/过期/删除条目；勾选或新增 todo.md 待办",
    promptGuidelines: [
      "When the user corrects a remembered fact, use living_memory_update supersede with the corrected text (never create a coexisting contradictory entry); when the user confirms an inference, use action confirm; when the user says某事已结束/失效, use expire.",
      "某条 todo.md 待办完成后调 living_memory_update action=todo_done 并给唯一 match 关键词（命中多项会被拒绝并列候选，换更具体的词重试）；新待办用 action=todo_add（可选 section=某个 `## ` 小节名关键词）。",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "条目 id 或唯一前缀（restore 可传已删除条目的 id）；todo_* 不需要" })),
      action: StringEnum(["confirm", "supersede", "renew", "expire", "delete", "restore", "todo_done", "todo_undo", "todo_add", "todo_edit", "todo_delete", "todo_archive", "summary_add", "summary_update", "purge_expired", "rotate_recovery", "summary_archive", "profile_rebuild", "promote_scan", "style_scan", "auto_fact"]),
      match: Type.Optional(Type.String({ description: "todo_done/todo_undo/todo_edit/todo_delete 必填：待办正文的唯一关键词（大小写不敏感子串）；summary_update 必填：小节标题的唯一关键词" })),
      section: Type.Optional(Type.String({ description: "todo_add 可选：`## ` 小节名关键词；缺省追加到最后一个待办之后" })),
      project: Type.Optional(Type.String({ description: "todo_add 可选：项目标记（写成行尾 @project，可用 source=todo query=@project 筛）" })),
      tags: Type.Optional(Type.String({ description: "todo_add 可选：标签，逗号分隔（写成行尾 #tag，可用 query=#tag 筛）" })),
      due: Type.Optional(Type.String({ description: "todo_add 可选：截止日 YYYY-MM-DD（写成行尾 due:日期；简报与开屏会提醒逾期/7 日内到期）" })),
      text: Type.Optional(Type.String({ description: "supersede 必填：纠正后的新事实正文；todo_add/todo_edit 必填：待办正文" })),
      review_after: Type.Optional(Type.String({ description: "renew 可选：新复核日期，默认 +30 天" })),
      expires_at: Type.Optional(Type.String({ description: "renew 可选：新到期日期" })),
      note: Type.Optional(Type.String({ description: "审计备注（如用户原话）" })),
      title: Type.Optional(Type.String({ description: "summary_add 必填：小节标题（正文写在 body 里）" })),
      body: Type.Optional(Type.String({ description: "summary_add/summary_update 必填：小节正文，按 `- ` 条目写入，不要带标题行" })),
      older_than_days: Type.Optional(Type.Number({ description: "purge_expired 可选：只清理距今 ≥ 该天数的 expired/superseded 条目，默认 30" })),
      dry_run: Type.Optional(Type.Boolean({ description: "purge_expired 可选：默认 true 只列候选；传 false 才真正移动文件" })),
      scope: Type.Optional(Type.String({ description: "批量 expire 可选：按 scope 精确选择（如 project:vanlife）" })),
      subject_contains: Type.Optional(Type.String({ description: "批量 expire 可选：subject 包含该子串（如「记忆」）" })),
      kind: Type.Optional(StringEnum(KINDS, { description: "批量 expire 可选：按类别选择" })),
      keep: Type.Optional(Type.Number({ description: "summary_archive 可选：活动 summary.md 保留多少个最新小节，默认 60（LIVING_MEMORY_SUMMARY_KEEP 可改）" })),
    }),
    async execute(_toolCallId: string, p: any, _sig: any, _upd: any, ctx: any) {
      if (String(p.action).startsWith("todo_")) {
        if (isPaused())
          return { content: [{ type: "text", text: "living memory 已被 /memory off 暂停——待办写操作同样不可用（/memory on 恢复）。" }] };
        refreshWidget(ctx);
        let tm: string;
        if (p.action === "todo_archive") {
          const moved = lockedArchiveDone();
          return {
            content: [{ type: "text", text: moved ? `已归档 ${moved} 项已完成待办到 todo-archive.md（todo.md 只留未完成与指针）。` : "todo.md 内没有已完成的待办可归档。" }],
          };
        }
        if (p.action === "todo_add")
          tm = lockedTodoAdd(
            p.text ?? "",
            p.section,
            p.project,
            (p.tags ?? "").split(/[,，;、]/).map((t: string) => t.trim()).filter(Boolean),
            p.due,
          );
        else if (!p.match) tm = `${p.action} 必须带 match（待办正文的唯一关键词）。`;
        else if (p.action === "todo_edit") tm = lockedTodoEdit(p.match, p.text ?? "");
        else if (p.action === "todo_delete") tm = lockedTodoDelete(p.match);
        else tm = lockedTodoSet(p.match, p.action === "todo_done");
        return { content: [{ type: "text", text: tm }] };
      }
      if (p.action === "summary_add" || p.action === "summary_update") {
        if (isPaused())
          return { content: [{ type: "text", text: "living memory 已被 /memory off 暂停——summary 写入同样不可用（/memory on 恢复）。" }] };
        let sm: string;
        if (p.action === "summary_add") sm = lockedSummaryAdd(p.project ?? "", p.title ?? "", p.body ?? "");
        else if (!p.match) sm = "summary_update 必须带 match（小节标题的唯一关键词）。";
        else sm = lockedSummaryUpdate(p.match, p.body ?? "");
        return { content: [{ type: "text", text: sm }] };
      }
      if (isPaused() && !["delete", "restore"].includes(p.action))
        return { content: [{ type: "text", text: "living memory 已被 /memory off 暂停——治理写操作不可用（delete 除外）。" }] };
      if (p.action === "style_scan")
        return { content: [{ type: "text", text: opStyleScan(Number(p.match ?? 30) || 30) }] };
      if (p.action === "restore") {
        refreshWidget(ctx);
        return { content: [{ type: "text", text: opRestore(p.id) }] };
      }
      if (p.action === "purge_expired") {
        refreshWidget(ctx);
        const days = p.older_than_days === undefined ? 30 : Number(p.older_than_days);
        return { content: [{ type: "text", text: opPurgeExpired(Number.isFinite(days) ? days : 30, p.dry_run !== false) }] };
      }
      if (p.action === "expire" && !p.id) {
        if (!p.kind && !p.scope && !p.subject_contains)
          return {
            content: [
              {
                type: "text",
                text: "expire 需要 id；批量失效请给 kind / scope / subject_contains 之一（批量默认 dry_run，需 dry_run=false 才执行）。",
              },
            ],
          };
        refreshWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text: opExpireBatch({ kind: p.kind, scope: p.scope, subject: p.subject_contains }, p.dry_run !== false, p.note),
            },
          ],
        };
      }
      if (p.action === "rotate_recovery") {
        const days = Number(p.older_than_days);
        return {
          content: [
            {
              type: "text",
              text: rotateRecovery(Number.isFinite(days) ? days : RECOVERY_RETAIN_DAYS, p.dry_run !== false),
            },
          ],
        };
      }
      if (p.action === "summary_archive") {
        const keep = Number(p.keep);
        return {
          content: [
            {
              type: "text",
              text: withFileLockSync(SUMMARY_FILE, () =>
                opSummaryArchive(Number.isFinite(keep) && keep > 0 ? keep : SUMMARY_KEEP, p.dry_run !== false),
              ),
            },
          ],
        };
      }
      if (p.action === "auto_fact") {
        const a = autoFactRetro();
        const b = autoFactEvidence();
        if (!a.length && !b.length) return "没有可自动转事实的推断（门槛：confidence ≥ 门槛或证据 ≥3 天且复合分 ≥ 门槛；关系类与 needs-confirm 永不自动）。";
        return [
          a.length ? `按置信度转正 ${a.length} 条：${a.join("；")}` : "",
          b.length ? `按证据转正 ${b.length} 条：${b.join("；")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (p.action === "profile_rebuild")
        return { content: [{ type: "text", text: refreshProfile(p.dry_run !== false) }] };
      if (p.action === "promote_scan")
        return { content: [{ type: "text", text: opPromoteScan(Number(p.match) || 20) }] };
      if (!p.id) return { content: [{ type: "text", text: `${p.action} 必须带 id（条目 id 或唯一前缀）。` }] };
      const e = findEntry(p.id);
      if (!e) return { content: [{ type: "text", text: `找不到条目 ${p.id}` }] };
      let msg: string;
      switch (p.action) {
        case "confirm":
          msg = opConfirm(e, p.note);
          break;
        case "supersede":
          if (!p.text) return { content: [{ type: "text", text: "supersede 必须带 text（纠正后的新事实正文）。" }] };
          msg = opSupersede(e, p.text, p.note);
          break;
        case "renew":
          msg = opRenew(e, p.review_after, p.expires_at);
          break;
        case "expire":
          msg = opExpire(e, p.note);
          break;
        case "delete":
          msg = opDelete(e, p.note);
          break;
        default:
          return { content: [{ type: "text", text: `未知 action: ${p.action}` }] };
      }
      refreshWidget(ctx);
      return { content: [{ type: "text", text: msg }] };
    },
  });

// ---------- 画像统计块（profile.md）：只做可计算的事，判断性表述留给四节正文 ----------
const PROFILE_FILE = path.join(STORE, "profile.md");
const PROFILE_DEFAULT_BODY = [
  "# 画像 —— 用户与协作风格",
  "",
  "> 维护：机械统计块由 `living_memory action=profile_rebuild dry_run=false`（或 `/memory profile`）刷新；四节正文由人或 agent 在事实变化时重写，每条结论附证据 id。",
  "> 机械块只做计数与分布，不生成判断；正文里的结论没有证据就写「暂无」。",
  "",
  "## 一、决策风格",
  "",
  "- 暂无",
  "",
  "## 二、风险与边界偏好",
  "",
  "- 暂无",
  "",
  "## 三、对外口径",
  "",
  "- 暂无",
  "",
  "## 四、沟通与协作习惯",
  "",
  "- 暂无",
  "",
  "## 五、空白与待证（当前不足以归纳的部分）",
  "",
  "- 暂无",
  "",
  "<!-- STATS:BEGIN -->",
  "<!-- STATS:END -->",
  "",
].join("\n");

function pctOf(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

/** 统计块正文：与 entries/ 现状一致，幂等（只替换 STATS 标记区间） */
function profileBlock(): string {
  const all = loadEntriesIndex();
  const act = all.filter((e) => ACTIVE.has(e.meta.status));
  const count = (arr: Array<{ meta: Meta }>, f: (e: { meta: Meta }) => string) => {
    const m = new Map<string, number>();
    for (const e of arr) m.set(f(e) || "?", (m.get(f(e) || "?") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const list = (arr: Array<[string, number]>) => arr.map(([k, v]) => `${k} ${v}条`).join(" · ") || "（无）";
  const scopes = new Map<string, number>();
  for (const e of act) for (const s of e.meta.scope.split(",").map((x) => x.trim()).filter(Boolean)) scopes.set(s, (scopes.get(s) ?? 0) + 1);
  const dates = act.map((e) => e.meta.obtained_at.slice(0, 10)).filter(Boolean).sort();
  const age = dates.length ? Math.round((Date.now() - new Date(`${dates[0]}T00:00:00Z`).getTime()) / 86_400_000) : 0;
  const multi = act.filter((e) => e.meta.scope.includes(",")).length;
  const proj = act.filter((e) => /project:|workspace:/.test(e.meta.scope)).length;
  const superseded = all.filter((e) => e.meta.status === "superseded").length;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return [
    `| 指标 | 值 |`,
    `|---|---|`,
    `| 条目总数 | ${all.length}（活动 ${act.length} / 已过期 ${all.filter((e) => e.meta.status === "expired").length} / 已被取代 ${superseded}） |`,
    `| 活动条目状态 | ${list(count(act, (e) => e.meta.status))} |`,
    `| 活动条目类别 | ${list(count(act, (e) => e.meta.kind))} |`,
    `| 范围分布（活动） | ${list([...scopes.entries()].sort((a, b) => b[1] - a[1]))} |`,
    `| 项目专属 vs 全局 | 项目/工作区事实 ${proj} 条（${pctOf(proj, act.length)}）· 仅 global ${act.filter((e) => e.meta.scope === "global").length} 条 · 跨 2+ 范围 ${multi} 条 |`,
    `| 库龄 | 最早条目 ${dates[0] ?? "—"} → 最近 ${dates[dates.length - 1] ?? "—"}（约 ${age} 天） |`,
    `| 演化痕迹 | 纠正类 ${act.filter((e) => e.meta.kind === "correction").length} 条活动 · superseded 链 ${superseded} 条 |`,
    ``,
    `<!-- 本块由 living-memory 扩展生成于 ${stamp}，勿手改 -->`,
  ].join("\n");
}

/** 刷新 profile.md 的 STATS 块；内容无变化时不写盘。dry=true 只返回块本身 */
function refreshProfile(dry = true): string {
  const block = profileBlock();
  if (dry) return block;
  const old = fs.existsSync(PROFILE_FILE) ? fs.readFileSync(PROFILE_FILE, "utf8") : PROFILE_DEFAULT_BODY;
  const wrapped = `<!-- STATS:BEGIN -->\n${block}\n<!-- STATS:END -->`;
  const re = /<!-- STATS:BEGIN -->\n[\s\S]*?\n<!-- STATS:END -->/;
  const next = re.test(old)
    ? old.replace(re, wrapped)
    : `${old}${old.endsWith("\n") ? "" : "\n"}\n${wrapped}\n`;
  if (next === old) return `profile.md 统计块已是最新（活动 ${loadEntriesIndex().filter((e) => ACTIVE.has(e.meta.status)).length} 条），未写盘。`;
  writeAtomic(PROFILE_FILE, next);
  logActivity("profile rebuild");
  return `已刷新 ${PROFILE_FILE}（活动 ${loadEntriesIndex().filter((e) => ACTIVE.has(e.meta.status)).length} 条）`;
}

  // /memory 面板
  pi.registerCommand("memory", {
    description: "长期记忆治理面板（无参=浏览；todo=逐条勾选待办；review=逐条处理到期复核；pending=逐条处理待确认推断；off/on=暂停/恢复写入）",
    getArgumentCompletions: (prefix: string) => {
      const items = ["review", "pending", "todo", "profile", "on", "off"].map((v) => ({ value: v, label: v }));
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim();
      if (arg === "off") {
        ensureDirs();
        fs.writeFileSync(PAUSE_FLAG, `${new Date().toISOString()}\n`);
        logActivity("pause on");
        ctx.ui.notify("living memory 写入已暂停（remember 将拒写）", "info");
        return;
      }
      if (arg === "on") {
        if (fs.existsSync(PAUSE_FLAG)) fs.unlinkSync(PAUSE_FLAG);
        logActivity("pause off");
        ctx.ui.notify("living memory 写入已恢复", "info");
        return;
      }
      const { active, pending, due } = brief();
      if (arg === "review") {
        if (!due.length) {
          ctx.ui.notify(`无到期条目（活动 ${active.length} 条，待确认推断 ${pending.length} 条）`, "info");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify(`headless 模式无法交互复核；让模型调 living_memory due=true 查看并代为处理。`, "info");
          return;
        }
        const batch = await ctx.ui.select(
          `到期 ${due.length} 条（${due
            .slice(0, 3)
            .map((e) => e.meta.subject)
            .join("、")}${due.length > 3 ? "…" : ""}）`,
          ["逐条处理", "全部续期（推断+30 / 事实+180 天）", "全部标记过期", "退出"],
        );
        if (!batch || batch === "退出") {
          refreshWidget(ctx);
          return;
        }
        if (batch.startsWith("全部续期")) {
          let n = 0;
          for (const e of due) {
            opRenew(e, addDays(e.meta.status === "inference" ? 30 : 180));
            n++;
          }
          ctx.ui.notify(`已续期 ${n} 条（推断 +30 天 / 已确认事实 +180 天；续期≠转正）`, "info");
        } else if (batch === "全部标记过期") {
          for (const e of due) opExpire(e, "/memory review batch");
          ctx.ui.notify(`已标记过期 ${due.length} 条（保留在库，可用 living_memory_update restore 恢复）`, "info");
        } else {
          let k = 0;
          for (const e of due) {
            k++;
            const opts = ["续期30天", "续期半年"];
            if (e.meta.status === "inference") opts.push("确认（事实转正）");
            opts.push("标记过期", "删除", "跳过");
            const choice = await ctx.ui.select(`${k}/${due.length} ${fmt(e)}\n如何处理？`, opts);
            let msg = "跳过";
            if (choice === "续期30天") msg = opRenew(e, addDays(30));
            else if (choice === "续期半年") msg = opRenew(e, addDays(180));
            else if (choice === "确认（事实转正）") msg = opConfirm(e, "/memory review");
            else if (choice === "标记过期") msg = opExpire(e, "/memory review");
            else if (choice === "删除") msg = opDelete(e, "/memory review");
            ctx.ui.notify(msg, "info");
          }
        }
        refreshWidget(ctx);
        return;
      }
      if (arg === "pending") {
        if (!pending.length) {
          ctx.ui.notify(`没有待确认推断（活动 ${active.length} 条均已转正或为显式事实）。`, "info");
          refreshWidget(ctx);
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `待确认推断 ${pending.length} 条：headless 模式请让模型调 living_memory status=inference 查看、living_memory_update confirm 转正。`,
            "info",
          );
          return;
        }
        const batch = await ctx.ui.select(
          `待确认推断 ${pending.length} 条（${pending
            .slice(0, 3)
            .map((e) => e.meta.subject)
            .join("、")}${pending.length > 3 ? "…" : ""}）`,
          ["逐条处理", "全部续期30天", "全部标记过期", "退出"],
        );
        if (!batch || batch === "退出") {
          refreshWidget(ctx);
          return;
        }
        if (batch === "全部续期30天") {
          for (const e of pending) opRenew(e, addDays(30));
          ctx.ui.notify(`已续期 ${pending.length} 条（仍是待确认，续期≠转正）`, "info");
        } else if (batch === "全部标记过期") {
          for (const e of pending) opExpire(e, "/memory pending batch");
          ctx.ui.notify(`已标记过期 ${pending.length} 条（保留在库，可 restore 恢复）`, "info");
        } else {
          let k = 0;
          for (const e of pending) {
            k++;
            const choice = await ctx.ui.select(
              `${k}/${pending.length} ${fmt(e)}\n这条推断是否成立？`,
              ["确认（事实转正）", "续期30天", "按原样保留（跳过）", "标记过期", "删除"],
            );
            let msg = "跳过（保持待确认）";
            if (choice === "确认（事实转正）") msg = opConfirm(e, "/memory pending");
            else if (choice === "续期30天") msg = opRenew(e, addDays(30));
            else if (choice === "标记过期") msg = opExpire(e, "/memory pending");
            else if (choice === "删除") msg = opDelete(e, "/memory pending");
            ctx.ui.notify(msg, "info");
          }
        }
        refreshWidget(ctx);
        return;
      }
      if (arg === "todo") {
        if (!ctx.hasUI) {
          ctx.ui.notify(`todo.md：${todoSummaryText()}。headless 模式请让模型调 living_memory source=todo 检索、living_memory_update todo_done 勾选。`, "info");
          return;
        }
        // 已完成条目的取消入口
        let showDone = false;
        for (;;) {
          const lines = showDone ? todoArchiveLines() : todoLines();
          const rows: Array<{ idx: number; label: string }> = [];
          let section = "";
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l.startsWith("## ")) {
              section = l.slice(3).trim();
              continue;
            }
            const want = showDone ? "- [x] " : "- [ ] ";
            if (!l.startsWith(want)) continue;
            const body = l.slice(6).replace(/<!--.*$/, "").trim();
            const tags = showDone
              ? ""
              : (() => {
                  const m = parseTodoMeta(body);
                  const mark = [
                    m.project ? `@${m.project}` : "",
                    ...m.tags.map((t) => `#${t}`),
                    m.due ? `due:${m.due}${dueState(m.due) === "overdue" ? "(逾期)" : ""}` : "",
                  ].filter(Boolean);
                  return mark.length ? ` [${mark.join(" ")}]` : "";
                })();
            const tag = showDone ? "✓" : "·";
            rows.push({
              idx: showDone ? -1 : i,
              label: `${showDone ? "[归档] " : `#${i} `}${tag} ${section.slice(0, 14)} | ${body.length > 70 ? `${body.slice(0, 70)}…` : body}${tags}`,
            });
          }
          if (!rows.length) {
            ctx.ui.notify(showDone ? "没有已完成的待办。" : "todo.md 里没有未完成待办。", "info");
            if (!showDone) return;
            showDone = false;
            continue;
          }
          const title = `${todoSummaryText()}（${showDone ? "已完成" : "未完成"} ${rows.length} 条）——选择要切换状态的条目：`;
          const doneCount = todoLines().filter((l) => l.startsWith("- [x] ")).length;
          const extras = [showDone ? "看未完成" : "看已完成"];
          if (doneCount) extras.push(`归档已完成（${doneCount} 条）`);
          extras.push("退出");
          const choice = await ctx.ui.select(title, [...rows.slice(0, 60).map((r) => r.label), ...extras]);
          if (!choice || choice === "退出") return;
          if (choice === "看已完成") {
            showDone = true;
            continue;
          }
          if (choice === "看未完成") {
            showDone = false;
            continue;
          }
          if (choice.startsWith("归档已完成")) {
            const moved = lockedArchiveDone();
            ctx.ui.notify(`已归档 ${moved} 条到 todo-archive.md（todo.md 只留未完成与指针）`, "info");
            refreshWidget(ctx);
            continue;
          }
          const row = rows.find((r) => r.label === choice);
          if (!row) continue;
          if (row.idx < 0) {
            ctx.ui.notify("该条已完成并归档在 todo-archive.md（只读）；若要重做，用 todo_add 重新加入 todo.md。", "info");
            continue;
          }
          const ok = await ctx.ui.confirm(showDone ? "取消勾选？" : "标记完成？", choice);
          if (!ok) continue;
          ctx.ui.notify(lockedTodoToggleAt(row.idx, !showDone), "info");
          refreshWidget(ctx);
        }
      }
      if (arg === "profile") {
        const ok = ctx.hasUI ? await ctx.ui.confirm("刷新画像统计块？", "只更新 profile.md 里 STATS 标记区间的机械计数，四节正文不动。") : true;
        ctx.ui.notify(ok ? refreshProfile(false) : "已取消（未改动 profile.md）", "info");
        refreshWidget(ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `living memory：活动 ${active.length} · 待确认 ${pending.length} · 到期 ${due.length}。headless 模式请让模型调用 living_memory 工具。`,
          "info",
        );
        return;
      }
      // 无参 = 浏览循环
      for (;;) {
        const { active: a, pending: pend, due: d } = brief();
        const items = [
          ...d.map((e) => `[到期] ${fmt(e, false)}`),
          ...pend.filter((e) => !d.includes(e)).map((e) => `[待确认] ${fmt(e, false)}`),
          ...a.filter((e) => !d.includes(e) && !pend.includes(e)).map((e) => fmt(e, false)),
        ];
        if (!items.length) {
          ctx.ui.notify("living memory 为空。", "info");
          return;
        }
        const label = await ctx.ui.select(`长期记忆 ${a.length} 条（到期 ${d.length} · 待确认 ${pend.length}）— 选择条目：`, [...items, "退出"]);
        if (!label || label === "退出") return;
        const e = a.find((x) => label.endsWith(fmt(x, false)) || label.includes(x.meta.id));
        if (!e) continue;
        const act = await ctx.ui.select(
          `${fmt(e)}\n\n正文：\n${e.body}\n\n操作（纠正请在对话中说明，由模型调 living_memory_update supersede）：`,
          ["确认（推断→确认事实）", "续期30天", "标记过期", "删除", "返回"],
        );
        if (!act || act === "返回") continue;
        let msg = "";
        if (act.startsWith("确认")) msg = opConfirm(e, "/memory");
        else if (act === "续期30天") msg = opRenew(e);
        else if (act === "标记过期") msg = opExpire(e, "/memory");
        else if (act === "删除") msg = opDelete(e, "/memory");
        if (msg) ctx.ui.notify(msg, "info");
        refreshWidget(ctx);
      }
    },
  });

  // 开屏扫描：到期/待确认 → 常驻 widget
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const cleaned = autoTriage("session_start");
      if (cleaned.length) ctx.ui.notify(`living memory 自动清理（A 档）${cleaned.length} 条：${cleaned.join("；")}`, "info");
      // 推断自动按事实：先按已存 confidence 追溯补判（A），再按证据累积判（B）
      const autoFacts = [...autoFactRetro(), ...autoFactEvidence()];
      if (autoFacts.length)
        ctx.ui.notify(`living memory 自动按事实处理 ${autoFacts.length} 条：${autoFacts.join("；")}`, "info");
      // recovery/ 保留期轮转：只在有到期文件时才动，静默执行并记审计
      const rotated = rotateRecovery(RECOVERY_RETAIN_DAYS, false);
      if (rotated.startsWith("已物理删除")) ctx.ui.notify(`living memory ${rotated}`, "info");
      // 项 5：只提示不自动搬（过期条目可归档 / summary 小节超阈值），避免每次启动都动文件
      if (process.env.LIVING_MEMORY_START_HINTS !== "0") {
        const hints: string[] = [];
        const twins = legacyTwins();
        if (twins) hints.push(`发现大写孪生文件 ${twins}（陈旧实例可能又写回来了）：/reload 后人工合并，否则写入会分叉`);
        const pc = purgeCandidates(30);
        if (pc.due.length) hints.push(`过期 ${pc.due.length} 条可归档（living_memory action=purge_expired 预览）`);
        const doneTodo = todoIndex().done;
        if (doneTodo > 0) hints.push(`todo.md 内已完成 ${doneTodo} 项可归档（/memory todo → 归档已完成）`);
        const dueTodo = dueRows();
        if (dueTodo.length) {
          const overdue = dueTodo.filter((r) => dueState(r.due) === "overdue").length;
          hints.push(
            `待办 ${dueTodo.length} 项 7 日内到期${overdue ? `（其中 ${overdue} 项已逾期）` : ""}：source=todo query="due:soon" 查看`,
          );
        }
        const styleDue = styleScanOverdue(30) && loadEntriesIndex().filter((r) => ACTIVE.has(r.meta.status ?? "explicit")).length >= 5;
        if (styleDue) hints.push("画像 30 天未归纳：action=style_scan 出候选，再按证据改写 profile.md 的三、四节");
        const fail24 = recentExtractFailures(24);
        if (fail24.length) {
          const why = [...new Set(fail24.map((f) => f.reason))].join("/");
          hints.push(`抽取 24h 内失败 ${fail24.length} 次（${why}）：source=extract 看原因与原文片段`);
        }
        const secs = summaryIndex().length;
        if (secs > SUMMARY_KEEP) {
          const autoKeep = Number(process.env.LIVING_MEMORY_AUTO_ARCHIVE_KEEP ?? 120);
          if (process.env.LIVING_MEMORY_AUTO_ARCHIVE === "1" && secs > autoKeep) {
            const r = opSummaryArchive(autoKeep, false);
            ctx.ui.notify(`living memory 自动归档（节数 ${secs} > ${autoKeep}）：${r}`, "info");
          } else hints.push(`summary ${secs} 节 > ${SUMMARY_KEEP}（action=summary_archive 预览）`);
        }
        if (hints.length) ctx.ui.notify(`living memory ${hints.join(" · ")}`, "info");
      }
      // 画像统计块：机械计数，幂等（无变化不写盘），静默刷新（与提示开关无关）
      if (process.env.LIVING_MEMORY_PROFILE_AUTO !== "0") {
        try {
          refreshProfile(false);
        } catch {
          /* profile.md 可手写，刷新失败不影响记忆功能 */
        }
      }
      refreshWidget(ctx);
    } catch {
      /* session_start 静默失败无害 */
    }
  });

  // Phase 2：before_agent_start 简报注入（每 run 从库重算，压缩后自动重注入）
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (process.env.LIVING_MEMORY_BRIEF === "0") return;
      const block = buildBrief(ctx?.cwd);
      if (!block) return;
      return { systemPrompt: event.systemPrompt + block };
    } catch {
      /* 注入失败静默 */
    }
  });

  // Phase 3：agent_end 暂存本 run 消息 → agent_settled 触发抽取（fire-and-forget）
  pi.on("agent_end", async (event: any) => {
    dbg(`agent_end: ${(event?.messages ?? []).length} msgs`);
    lastRunMessages = event?.messages ?? null;
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    const msgs = lastRunMessages;
    lastRunMessages = null;
    dbg(`agent_settled: aborted=${!!event?.aborted} msgs=${msgs?.length ?? 0} enabled=${extractEnabled()} paused=${isPaused()}`);
    if (!msgs || event?.aborted || !extractEnabled() || isPaused()) return;
    scheduleExtraction(msgs, ctx, "agent_settled");
  });

  // Phase 3：压缩前兜底抽取——对话即将被摘要化，先把候选落库（防压缩丢失）
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    try {
      if (!extractEnabled() || isPaused()) return;
      const msgs = (event?.branchEntries ?? [])
        .map((e: any) => e?.message)
        .filter((m: any) => m && (m.role === "user" || m.role === "assistant"));
      if (!msgs.length) return;
      scheduleExtraction(msgs, ctx, "before_compact");
    } catch {
      /* 兜底失败无害 */
    }
  });

  // Phase 3：headless/--print 会话 settle 后立即退出，等在途抽完再走（内部有超时兜底）
  pi.on("session_shutdown", async () => {
    if (pendingExtraction) {
      try {
        await pendingExtraction;
      } catch {
        /* 已在内部吞掉 */
      }
      pendingExtraction = null;
    }
  });
}
