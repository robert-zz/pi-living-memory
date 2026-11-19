/**
 * 策略层：条目生命周期操作、转正/自动事实、A 档清理、todo/summary 文档操作、检索与自检、召回候选。
 * 依赖图 L4：config / paths / text / manifest / recall / stores/*。不 import 扩展壳，也不 import brief。
 * 工具 schema 与 pi 事件接线留在扩展壳；这里只做「拿到参数 → 读写库 → 回人话」。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { cfg, clock, getSettings, logger, refreshConfig } from "./config";
import { ACTIVE, SCOPE_TOKEN_RE, parseEntryWithIssues, type Entry, type EntryIndex, type ManifestIssue, type Meta } from "./manifest";
import { RECALL_STATUS, rankRecall } from "./recall";
import { bigrams, isNegation, jaccard, normBody, normSubject, normText } from "./text";
import {
  ENTRIES_DIR,
  MISS_FILE,
  PROFILE_STYLE_STAMP,
  RECOVERY_DIR,
  SUMMARY_FILE,
  TODO_FILE,
  ensureDirs,
  isPaused,
  manifestFileLabel,
  newId,
  withFileLockSync,
  writeAtomic,
} from "./paths";
import { entryStore } from "./stores/entry-store";
import { DONE_MARK_RE, dueState, parseTodoMeta, todoStore, todoSuffix, type TodoMeta } from "./stores/todo-store";
import { summaryStore, type SummarySection } from "./stores/summary-store";

/** 零命中日志（miss.log）保留行数：超过就只留最后 200 行 */
const MISS_KEEP = 200;

/** 推断自动按事实处理的置信度门槛：>= 即直接 confirmed；低于门槛仍只作弱参考（「待确认」档） */
export const AUTO_FACT_CONF = () => refreshConfig().autoFactConf; // 原先每次调用读 env，故这里也重读（注入值仍生效）
/** 自动转事实的排除面：关系类与 needs-confirm 仍需人工点头（错判代价不对称） */
export const autoFactable = (kind: string, conf: number, impact?: string) =>
  Number.isFinite(conf) && conf >= AUTO_FACT_CONF() && kind !== "relation" && impact !== "needs-confirm";

/** 扫描 entries/ 收集 manifest 问题（lint 用）：不抛异常，坏条目照现状跳过但仍报告 */
function scanManifestIssues(): ManifestIssue[] {
  ensureDirs();
  const issues: ManifestIssue[] = [];
  const byId = new Map<string, string[]>();
  for (const f of fs.readdirSync(ENTRIES_DIR)) {
    if (!f.endsWith(".md")) continue;
    const file = path.join(ENTRIES_DIR, f);
    const parsed = parseEntryWithIssues(file, manifestFileLabel(file));
    issues.push(...parsed.issues);
    const id = parsed.entry?.meta.id;
    if (!id) continue;
    const files = byId.get(id) ?? [];
    files.push(f);
    byId.set(id, files);
  }
  for (const [id, files] of byId) {
    if (files.length < 2) continue;
    for (const f of files)
      issues.push({
        file: `entries/${f}`,
        id,
        field: "id",
        problem: `同一 id 出现在 ${files.length} 个文件（${files.join("、")}）：索引会出现重复行、简报与召回会重复`,
        severity: "error",
      });
  }
  return issues;
}

// ---------- 推断转正评分（第一步：只读打分，不改状态） ----------
// 原则：自评置信度最多贡献 0.4 分；跨会话复现 ≤0.35；用户原话重述 0.35；
// 隐私/决策类（relation/decision/outcome）与含糊表述扣分；转正还必须独立证据 ≥2。
type Ev = { at: string; kind: string; id?: string; note?: string };
const HEDGE_MARK = /(可能|大概|也许|或许|待定|尚不确定|不确定|估计|应该是|似乎|推测|不一定)/;
function evidenceOf(meta: Meta): Ev[] {
  try {
    const v = JSON.parse(meta.evidence || "[]");
    return Array.isArray(v) ? (v.filter((x: any) => x && typeof x.at === "string") as Ev[]) : [];
  } catch {
    return [];
  }
}

/** 证据累积（第二步）：同一天同一来源重复出现则跳过；只改 evidence 字段，不新建条目 */
export function appendEvidence(e: Entry, ev: Ev): string | null {
  const list = evidenceOf(e.meta);
  const day = ev.at.slice(0, 10);
  if (list.some((x) => x.at.slice(0, 10) === day && (x.id ?? "") === (ev.id ?? ""))) return null;
  const next = list.concat(ev).slice(-20);
  const meta = { ...e.meta, evidence: JSON.stringify(next) };
  // 证据可能落在历史条目上：只警告不阻断（否则旧字段会把证据累积整条链路卡死）
  entryStore.put({ meta, body: e.body }, { strict: false });
  const s = promoteScore({ meta, body: e.body });
  logger.activity(`evidence +1 ${e.meta.id} kind=${ev.kind} total=${next.length} score=${s.score.toFixed(2)}`);
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
  const gate = score >= cfg.promoteThreshold && independent >= 2 && !blocked;
  return { score, base, repeat, restate, penalty, days: days.size, independent, blocked, gate };
}

/** 只读扫描：按复合分排序打印，不写任何文件（转正在后续步骤里才开启） */
/** 月度风格归纳（只读；写 profile 由人或 agent 做）：把窗口内的偏好/纠正/雷区摆出来当归纳材料 */
export function opStyleScan(days = 30, limit = 20): string {
  const since = new Date(clock.now() - days * 86400e3).toISOString();
  const rows = entryStore.list().filter(
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
    fs.writeFileSync(PROFILE_STYLE_STAMP, new Date(clock.now()).toISOString());
  } catch {
    /* 戳写不进去不影响结果 */
  }
  logger.activity(`style_scan days=${days} rows=${rows.length} neg=${neg.length}`);
  return lines.join("\n");
}

/** 画像是否到了该归纳的时候（戳缺失也视为到期） */
export function styleScanOverdue(days = 30): boolean {
  try {
    const at = fs.readFileSync(PROFILE_STYLE_STAMP, "utf8").trim();
    return clock.now() - Date.parse(at) > days * 86400e3;
  } catch {
    return true;
  }
}

export function opPromoteScan(limit = 20): string {
  const rows = entryStore.list()
    .filter((r) => r.meta.status === "inference") // 只有推断是转正候选，confirmed/explicit 无需评分
    .map((r) => ({ r, e: entryStore.get(r.id) }))
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
    `推断转正评分（阈值 ${cfg.promoteThreshold}，独立证据 ≥2，本命令只读不改状态）\n` +
    `活动 ${sorted.length} 条 · 平均 ${avg.toFixed(2)} · 最高 ${sorted[0].s.score.toFixed(2)} · 越过门槛 ${over} 条\n\n` +
    lines.join("\n") +
    (sorted.length > n ? `\n…（另有 ${sorted.length - n} 条未显示，limit 可调）` : "")
  );
}

export function today(): string {
  return clock.today();
}

/** 按 kind 的复核间隔（天）：0=不设默认复核日期；settings.livingMemory.reviewDays 可覆盖 */
function reviewDays(kind: string, basis: string): number {
  const defaults: Record<string, number> = { decision: 60, outcome: 60, inference: 30, default: 180 };
  try {
    const custom = getSettings()?.livingMemory?.reviewDays as Record<string, number> | undefined;
    if (custom) {
      if (typeof custom[`${basis}`] === "number") return custom[`${basis}`];
      if (typeof custom[`${kind}`] === "number") return custom[`${kind}`];
      if (typeof custom.default === "number") return custom.default;
    }
  } catch {
    /* 读不到设置就用内置默认 */
  }
  return defaults[`${basis}`] ?? defaults[kind] ?? defaults.default;
}

/** 默认复核日期：decision/outcome 60 天，inference 30 天，其余 180 天（reviewDays 可改；0=不设） */
export function defaultReviewAfter(basis: string, kind = ""): string {
  if (refreshConfig().noAutoReview) return "";
  const days = reviewDays(kind, basis);
  if (!days) return "";
  return new Date(clock.now() + days * 86400e3).toISOString().slice(0, 10);
}

export function addDays(n: number): string {
  return new Date(clock.now() + n * 86400e3).toISOString().slice(0, 10);
}
export function isDue(meta: Meta): boolean {
  const t = today();
  for (const k of ["review_after", "expires_at"]) {
    const v = meta[k];
    if (v && v.slice(0, 10) <= t) return true;
  }
  return false;
}

export function fmt(e: Entry, withBody = true): string {
  const m = e.meta;
  const tags = [m.kind ?? "", m.status ?? "", `scope=${m.scope ?? ""}`];
  if (m.confidence) tags.push(`conf=${m.confidence}`);
  if (m.supersedes) tags.push(`supersedes=${m.supersedes}`);
  if (m.superseded_by) tags.push(`superseded_by=${m.superseded_by}`);
  if (ACTIVE.has(m.status) && isDue(m)) tags.push("DUE");
  const head = `${m.id} [${tags.join(" · ")}] ${m.subject}`;
  if (!withBody) return head;
  const body = e.body.length > 80 ? `${e.body.slice(0, 80)}…` : e.body;
  return `${head}: ${body.replace(/\n/g, " ")}`;
}

// ---------- 核心操作（工具与 /memory 面板共用） ----------
export function opConfirm(e: Entry, note?: string): string {
  if (!["inference", "event", "explicit"].includes(e.meta.status))
    return `${e.meta.id} status=${e.meta.status}，无需确认。`;
  e.meta.status = "confirmed";
  e.meta.confirmed_at = new Date(clock.now()).toISOString();
  entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  logger.activity(`confirmed ${e.meta.id}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已确认为 confirmed 事实。`;
}

export function opSupersede(e: Entry, text: string, note?: string): string {
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
    obtained_at: new Date(clock.now()).toISOString(),
    confirmed_at: new Date(clock.now()).toISOString(),
    expires_at: old.expires_at,
    review_after: old.review_after,
    confidence: "",
    action_impact: old.action_impact || "advice-only",
    supersedes: old.id,
    superseded_by: "",
  };
  // 新条目字段来自旧条目（可能是历史数据）：strict=false，问题由 logger.warn + lint 曝光
  entryStore.put({ meta: nm, body: text }, { strict: false });
  old.status = "superseded";
  old.superseded_by = nid;
  entryStore.put({ meta: old, body: e.body }, { strict: false });
  logger.activity(`supersede ${old.id} -> ${nid}`);
  // 替代链深度：同一 subject 反复纠正时提示合并，防止同主题攒出十几代版本
  let depth = 1;
  const seen = new Set<string>([old.id]);
  let cur: Meta | undefined = old;
  while (cur?.supersedes && !seen.has(cur.supersedes)) {
    seen.add(cur.supersedes);
    const prev = entryStore.get(cur.supersedes);
    if (!prev) break;
    cur = prev.meta;
    depth++;
  }
  const chainHint =
    depth >= 4 ? `\n提示：该 subject 的替代链已 ${depth} 代，旧条目可 expire 合并，避免长期累积。` : "";
  return `已纠正：旧条目 ${old.id} → 新条目 ${nid}（旧条目保留 superseded 链，不再参与检索）。${chainHint}`;
}

export function opRenew(e: Entry, reviewAfter?: string, expiresAt?: string): string {
  // 已失效（在 expired/ 或盘上 status=expired）的条目：renew 即复活——搬回 entries/ 并转为 explicit
  const resurrect = e.meta.status === "expired";
  if (!resurrect && !ACTIVE.has(e.meta.status)) return `${e.meta.id} status=${e.meta.status}，非活动条目，不能续期。`;
  const ra = reviewAfter || new Date(clock.now() + 30 * 86400e3).toISOString().slice(0, 10);
  const patch: Meta = { review_after: ra };
  if (expiresAt) patch.expires_at = expiresAt;
  if (resurrect) {
    const reviveFields: Meta = { confirmed_at: "", ...patch };
    Object.assign(e.meta, { status: "explicit", ...reviveFields });
    // 复活由 store 搬文件 + 恢复索引行；盘上没有任何副本（并发删除）时退回按内存内容写回，语义同旧实现
    if (!entryStore.resurrect(e.meta.id, "explicit", reviveFields))
      entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  } else {
    Object.assign(e.meta, patch);
    entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  }
  logger.activity(`renew ${e.meta.id} review_after=${ra} status=${e.meta.status}${resurrect ? " resurrect=1" : ""}`);
  return resurrect
    ? `${e.meta.id} 已复活（expired → explicit，搬回 entries/），review_after=${ra}。`
    : `${e.meta.id} 已续期，review_after=${ra}（status 保持 ${e.meta.status}：续期≠确认，转正仍需显式 confirm）。`;
}

export function opExpire(e: Entry, note?: string): string {
  const moved = entryStore.expire(e);
  logger.activity(`expire ${e.meta.id} moved=${moved ? "expired/" : "-"}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已标记过期${moved ? "并移入 expired/" : ""}（不再参与检索；restore 可取回，补 renew 即复活）。`;
}

// ---------- G：过期条目批量清理（转移而非删除，expired/ 下按 id 保留原文，可 restore 回来） ----------

/** 把 status=expired/superseded 且超过 older_than_days 的条目移入 expired/；dry_run 默认 true */
export function opPurgeExpired(olderDays = 30, dry = true): string {
  const { candidates: due, moved, closed } = entryStore.purgeExpired(olderDays, dry);
  if (!due.length)
    return `无符合条件条目（库内 status=expired/superseded 共 ${closed} 条，均未超过 ${olderDays} 天）。`;
  const lines = due.map((e) => `${e.meta.id}（${e.meta.kind ?? ""}/${e.meta.status ?? ""}/${(e.meta.obtained_at ?? "").slice(0, 10)}）${e.meta.subject ?? ""}`);
  if (dry)
    return `候选 ${due.length} 条（dry_run，未移动）：\n${lines.slice(0, 15).join("\n")}${due.length > 15 ? `\n…（还有 ${due.length - 15} 条）` : ""}\n确认无误会后传 dry_run=false 执行：文件移到 expired/，仍可用 restore 取回。`;
  logger.activity(`purge_expired n=${moved} older_than_days=${olderDays} ids=${due.map((e) => e.meta.id).join(",")}`);
  return `已清理 ${moved} 条到 expired/（索引 expired/index-${new Date(clock.now()).toISOString().slice(0, 7)}.md，restore 可取回）：\n${lines.slice(0, 10).join("\n")}${due.length > 10 ? "\n…" : ""}`;
}

function recoveryAgeDays(file: string): number {
  return (clock.now() - fs.statSync(file).mtimeMs) / 86_400_000;
}

/** 已删条目在 recovery/ 只保留 cfg.recoveryRetainDays 天，到期物理删；dry_run 默认 true */
export function rotateRecovery(days = cfg.recoveryRetainDays, dry = true): string {
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
  logger.activity(`rotate_recovery n=${due.length} retain=${days}d ids=${names.join(",")}`);
  return `已物理删除 ${due.length} 条超过 ${days} 天的 recovery 记录（这些条目不再可 restore）。`;
}

/** expired/ 归档区检索视图：条目被 purge_expired 移出活动库后仍可查、可取回 */
export function searchExpired(q: string, status?: string, limit = 30): string {
  const rows = entryStore.listExpired();
  if (!rows) return "expired/ 为空（尚未执行过 purge_expired）。";
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
export function opExpireBatch(sel: { kind?: string; scope?: string; subject?: string }, dry = true, note?: string): string {
  const pick = entryStore.listFull().filter(
    (e) =>
      ACTIVE.has(e.meta.status) &&
      (!sel.kind || e.meta.kind === sel.kind) &&
      (!sel.scope || (e.meta.scope ?? "").split(",").map((s) => s.trim()).includes(sel.scope)) &&
      (!sel.subject || (e.meta.subject ?? "").includes(sel.subject)),
  );
  if (!pick.length) return "没有匹配的活动条目（批量 expire 只作用于 explicit/event/inference/confirmed）。";
  const lines = pick.map((e) => `${e.meta.id}（${e.meta.kind}/${e.meta.status}）${e.meta.subject}`);
  const more = pick.length > 15 ? `\n…（还有 ${pick.length - 15} 条）` : "";
  if (dry)
    return `候选 ${pick.length} 条（dry_run，未改动）：\n${lines.slice(0, 15).join("\n")}${more}\n确认后传 dry_run=false；每条都可 renew 复活。`;
  for (const e of pick) entryStore.expire(e);
  logger.activity(`expire-batch n=${pick.length} kind=${sel.kind ?? "-"} scope=${sel.scope ?? "-"} subject=${sel.subject ?? "-"}${note ? ` note=${note}` : ""}`);
  return `已批量失效 ${pick.length} 条（status=expired，renew 可复活）：\n${lines.slice(0, 10).join("\n")}${pick.length > 10 ? "\n…" : ""}`;
}

export function opDelete(e: Entry, note?: string): string {
  entryStore.delete(e, note);
  logger.activity(
    `delete ${e.meta.id} kind=${e.meta.kind} subject=${e.meta.subject} source="${e.meta.source}" body="${e.body.slice(0, 160)}"${note ? ` note=${note}` : ""} recovery=${e.meta.id}.json`,
  );
  return `${e.meta.id} 已删除（完整内容存于 recovery/${e.meta.id}.json，可用 living_memory_update action=restore id=${e.meta.id} 恢复）。`;
}

/** 从 expired/ 归档区或 recovery 记录恢复条目（幂等：条目仍在库中则不覆盖） */
export function opRestore(idPrefix: string): string {
  // 先看 expired/（purge_expired 转移过来的条目在这里，文件本身完好）
  const fromExpired = entryStore.restore(idPrefix, { from: "expired" });
  if (fromExpired) {
    logger.activity(`restore ${fromExpired.meta.id} from=expired/`);
    return `${fromExpired.meta.id} 已从 expired/ 恢复（status=expired，仍不参与检索；要复活需再来一次 renew）。`;
  }
  const ids = entryStore.recoverableIds();
  if (!ids) return "没有可恢复记录（recovery/ 为空）。";
  const rec = entryStore.restore(idPrefix, { from: "recovery" });
  if (rec) {
    logger.activity(`restore ${rec.meta.id} kind=${rec.meta.kind} subject=${rec.meta.subject}`);
    return `${rec.meta.id} 已从 recovery 恢复（status=${rec.meta.status}）。`;
  }
  // 记录还在 = 命中前缀但条目本就还在 entries/，restore 幂等跳过
  const hit = entryStore.recoverableIds(idPrefix);
  if (hit?.length) return `${hit[0]} 条目仍在库中，无需恢复。`;
  const list = ids.sort().reverse();
  return `找不到 ${idPrefix} 的删除记录。可恢复条目：${list.slice(0, 10).join(", ") || "无"}${list.length > 10 ? ` …（共 ${list.length} 条）` : ""}`;
}

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
export const isPluginInternal = (subject: string) => PLUGIN_INTERNAL.test(subject) && !/^(用户|我)/.test(subject);
const PROCEDURAL_MARK = /(待用户回答|待用户批准|待批准|待用户确认后执行|待你确认后执行|调试结论|git 提交号|commit [0-9a-f]{6,})/i;

function autoTriageEnabled(): boolean {
  const env = refreshConfig().autoTriage;
  if (env === "0") return false; // 环境变量优先，可临时关
  if (env === "1") return true;
  try {
    const v = getSettings()?.livingMemory?.autoTriage;
    if (typeof v === "boolean") return v;
  } catch {
    /* 读不到设置按默认 off */
  }
  return false;
}

export function autoTriage(trigger: string): string[] {
  if (!autoTriageEnabled() || isPaused()) return [];
  // 候选只可能是 inference 条目：先走索引筛，再逐条读正文，避免为一次 A 档扫描装载全库
  const cands = entryStore.list().filter((e) => ACTIVE.has(e.meta.status) && e.meta.status === "inference");
  if (!cands.length) return [];
  const allActive = entryStore.list().filter((e) => ACTIVE.has(e.meta.status));
  const active = cands.map((c) => entryStore.get(c.id)).filter((e): e is Entry => !!e);
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
          SUCCESSOR_MARK.test(entryStore.get(x.id)?.body ?? ""),
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
  if (acted.length) logger.activity(`auto-triage ${trigger}: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

export function inScope(e: { meta: Meta }, cwd?: string): boolean {
  const s = e.meta.scope || "global";
  if (s === "global") return true;
  if (!cwd) return true; // 拿不到 cwd 时宁多勿漏
  const base = path.basename(cwd);
  if (!base) return true;
  // 逐 token 精确比对（旧版 s.includes(base) 会让 acme 误配 acme.com）
  return s
    .split(",")
    .map((t) => t.trim().replace(/^(?:workspace|project):/, ""))
    .some((t) => t !== "" && t === base);
}

/** scope 白名单校验：global / workspace:<名> / project:<名>（多值逗号分隔）；错拼会永远进不了对应层，因此直接拒写 */
export function validateScope(raw: string): string {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return "scope 不能为空：用 global / workspace:<名> / project:<名>（多值逗号分隔）。";
  const bad = tokens.filter((t) => !SCOPE_TOKEN_RE.test(t));
  if (!bad.length) return "";
  const known = new Set(
    entryStore.list()
      .flatMap((e) => (e.meta.scope || "").split(",").map((x) => x.trim()))
      .filter(Boolean),
  );
  return `scope 值不合法：${bad.join("、")}。只接受 global / workspace:<名> / project:<名>（多值逗号分隔）。库里已用过的 scope：${
    [...known].sort().slice(0, 12).join(" / ") || "（暂无）"
  }`;
}

/** A：按已存 confidence 追溯转事实（幂等）。用于规则上线前的存量推断；会话启动自动跑 */
export function autoFactRetro(limit = 10): string[] {
  if (isPaused()) return [];
  const acted: string[] = [];
  const cands = entryStore.list().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    const conf = Number(r.meta.confidence ?? NaN);
    if (!autoFactable(r.meta.kind ?? "", conf, r.meta.action_impact)) continue;
    const e = entryStore.get(r.id);
    if (!e) continue;
    opConfirm(e, `auto-fact retro conf=${conf}`);
    acted.push(`${r.id}（conf ${conf}）`);
  }
  if (acted.length) logger.activity(`auto-fact retro: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

/** B：证据驱动的自动转事实。独立日期 >=3 天、复合分 >= 门槛、且非关系/需确认即视为事实 */
export function autoFactEvidence(limit = 5): string[] {
  const c = refreshConfig();
  if (c.autoFactEvidenceOff || isPaused()) return [];
  const minDays = c.autoFactMinDays;
  const minScore = c.autoFactMinScore ?? c.promoteThreshold;
  const acted: string[] = [];
  const cands = entryStore.list().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    if (r.meta.kind === "relation" || r.meta.action_impact === "needs-confirm") continue;
    const e = entryStore.get(r.id);
    if (!e) continue;
    const s = promoteScore(e);
    if (s.days < minDays || s.score < minScore || s.independent < 2) continue;
    opConfirm(e, `auto-fact evidence days=${s.days} score=${s.score.toFixed(2)}`);
    acted.push(`${r.id}（${s.days} 天 / 分 ${s.score.toFixed(2)}）`);
  }
  if (acted.length) logger.activity(`auto-fact evidence: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

function opSummaryAdd(project: string, title: string, body: string): string {
  const proj = (project || "").trim();
  const t = (title || "").trim();
  if (!proj || !t) return "summary_add 必须带 project（`## ` 节名关键词）与 title。";
  if (!body.trim()) return "summary_add 必须带 body（正文，按 `- ` 条目写入）。";
  const { num, created } = summaryStore.add(proj, t, body);
  logger.activity(`summary add ${proj} :: ${t} (#${num})`);
  return `已写入 summary.md：${created ? `新建节「${proj}」` : `「${proj}」节`} #${num} ${t}`;
}
function opSummaryUpdate(match: string, body: string): string {
  if (!(match || "").trim()) return "summary_update 必须带 match（小节标题的唯一关键词）。";
  if (!body.trim()) return "summary_update 必须带 body（新的正文）。";
  const { matched, updated } = summaryStore.update(match, body);
  if (!matched.length) return `summary.md 里找不到标题含「${match}」的正文块。`;
  if (!updated)
    return `匹配到 ${matched.length} 个小节，请用更具体的 match：\n${matched
      .slice(0, 5)
      .map((t) => `- ${t}`)
      .join("\n")}`;
  logger.activity(`summary update ${matched[0]}`);
  return `已改写 summary.md 小节「${matched[0]}」的正文（标题与编号不变）。`;
}

/** 归档最老的 N 个 `### [NN]` 小节到 summary-archive.md；dry_run 默认 true */
export function opSummaryArchive(keep = cfg.summaryKeep, dry = true): string {
  const { sections, moved } = summaryStore.archive(keep, dry);
  if (!moved.length) return `summary.md 共 ${sections} 个小节，未超过保留数 ${keep}，无需归档。`;
  const list = moved.map((s) => `[${String(s.num).padStart(2, "0")}] ${s.title.slice(0, 40)}`);
  if (dry)
    return `可归档 ${moved.length} 个小节（dry_run，未改动；活动保留 ${keep} 个最新）：\n${list
      .slice(0, 12)
      .join("\n")}${list.length > 12 ? `\n…（还有 ${list.length - 12} 个）` : ""}\n确认后传 dry_run=false。`;
  logger.activity(`summary archive n=${moved.length} keep=${keep} nums=${moved.map((s) => s.num).join(",")}`);
  return `已归档 ${moved.length} 个小节到 summary-archive.md（活动 summary.md 保留 ${keep} 个）：${moved
    .map((s) => `[${s.num}]`)
    .join("、")}`;
}

/** summary-archive.md 检索视图（归档节的正文仍可按关键词命中） */
export function searchSummaryArchive(q: string, limit = 8): string {
  const text = summaryStore.archiveText();
  if (text === null) return "summary-archive.md 不存在（尚未执行 summary_archive）。";
  // 归档区同样存「`### [NN] 标题` 索引块 + 正文块」，只取正文块，节数才准
  const blocks = text.split(/\n(?=### )/).filter((b) => b.startsWith("### ") && !/^### \[\d+\] /.test(b));
  const kw = q.split(/\s+/).filter(Boolean);
  const hits = kw.length ? blocks.filter((b) => kw.every((k) => normText(b).includes(normText(k)))) : blocks;
  if (!hits.length) return `summary-archive 共 ${blocks.length} 节，无匹配${kw.length ? `「${kw.join(" ")}」` : ""}。`;
  const lim = Math.min(limit, 20);
  const body = hits.slice(-lim).reverse().join("\n");
  return `summary-archive 共 ${blocks.length} 节，命中 ${hits.length}（显示 ${Math.min(hits.length, lim)} 节，最新归档在前）：\n\n${body}`;
}

/** 取匹配 cwd 名的小节里的未完成待办，正文压缩到 cfg.todoDigestChars */
export function todoDigest(baseName: string, limit: number): Array<{ section: string; text: string }> {
  const out: Array<{ section: string; text: string }> = [];
  const want = baseName.toLowerCase();
  for (const row of todoStore.index().open) {
    if (!row.section.toLowerCase().includes(want)) continue;
    out.push({
      section: row.section.slice(0, 18),
      text: row.text.length > cfg.todoDigestChars ? `${row.text.slice(0, cfg.todoDigestChars)}…` : row.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function todoSummaryText(): string {
  const idx = todoStore.index();
  const done = idx.done;
  return `未完成 ${idx.open.length} 项${done ? ` / todo.md 内已完成 ${done} 项` : ""}`;
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
  const item = `- [ ] ${body}${todoSuffix(merged.project, [...new Set(merged.tags)], merged.due)}`;
  const res = todoStore.insert(item, section);
  if (!res.inserted) {
    if (res.reason === "no-file") return "（todo.md 不存在）";
    return `找不到小节「${section}」；现有小节：${res.sections.join(" / ")}`;
  }
  logger.activity(`todo_add ${body.slice(0, 60)}`);
  return `已加入待办：${shortTodo(item)}\ntodo.md：${todoSummaryText()}`;
}

/** 面板用：按 todo.md 行下标直接勾选/取消（下标取自 todoStore.matches 或同一次渲染） */
function opTodoToggleAt(idx: number, done: boolean): string {
  const line = todoStore.setDoneAt(idx, done);
  if (line === null) return `${idx} 行不是待办条目（可能已被其他会话改动，请重开面板）`;
  const body = line.replace(DONE_MARK_RE, "").replace(/^- \[([ xX])\] /, "");
  logger.activity(`todo_${done ? "done" : "undo"}@L${idx} ${body.slice(0, 60)}`);
  return `${done ? "已勾选完成" : "已恢复未完成"}：${shortTodo(line)}\ntodo.md：${todoSummaryText()}`;
}

function opTodoSet(match: string, done: boolean): string {
  const hits = todoStore.matches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  const togglable = hits.filter((h) => h.done !== done);
  if (!togglable.length)
    return `命中 ${hits.length} 项，但都已是${done ? "完成" : "未完成"}状态：\n${hits.slice(0, 5).map((h) => `· ${shortTodo(h.line)}`).join("\n")}`;
  if (togglable.length > 1)
    return `命中 ${togglable.length} 项，请换更具体的关键词（未改动任何条目）：\n${togglable.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = togglable[0];
  const line = todoStore.setDoneAt(target.idx, done);
  if (line === null) return `${target.idx} 行不是待办条目（可能已被其他会话改动，请重开面板）`;
  const body = line.replace(DONE_MARK_RE, "").replace(/^- \[([ xX])\] /, "");
  logger.activity(`todo_${done ? "done" : "undo"} ${body.slice(0, 60)}`);
  return `${done ? "已勾选完成" : "已恢复未完成"}：${shortTodo(line)}\ntodo.md：${todoSummaryText()}`;
}

/** 按唯一命中改写待办正文（保留勾选状态与 done 标记） */
function opTodoEdit(match: string, text: string): string {
  const body = text.replace(/\s+/g, " ").trim();
  if (!body) return "todo_edit 需要 text（新的待办正文）。";
  const hits = todoStore.matches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  if (hits.length > 1)
    return `命中 ${hits.length} 项，请换更具体的关键词（未改动任何条目）：\n${hits.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = hits[0];
  const line = todoStore.editAt(target.idx, body);
  if (line === null) return `${target.idx} 行不是待办条目（可能已被其他会话改动，请重开面板）`;
  logger.activity(`todo_edit@L${target.idx} ${body.slice(0, 60)}`);
  return `已改写待办：${shortTodo(line)}\ntodo.md：${todoSummaryText()}`;
}
/** 按唯一命中删除待办行 */
function opTodoDelete(match: string): string {
  const hits = todoStore.matches(match);
  if (!hits.length) return `todo.md 里没有命中「${match}」的待办`;
  if (hits.length > 1)
    return `命中 ${hits.length} 项，请换更具体的关键词（未删除任何条目）：\n${hits.slice(0, 8).map((h) => `· ${shortTodo(h.line, 100)}`).join("\n")}`;
  const target = hits[0];
  const removed = todoStore.deleteAt(target.idx);
  if (removed === null) return `${target.idx} 行不是待办条目（可能已被其他会话改动，请重开面板）`;
  logger.activity(`todo_delete@L${target.idx} ${shortTodo(removed, 60)}`);
  return `已删除待办：${shortTodo(removed)}\ntodo.md：${todoSummaryText()}`;
}

// ---- 跨进程锁包装：todo.md / summary.md 的「读—改—写」都从这里进 ----
export function lockedTodoAdd(text: string, section?: string, project?: string, tags?: string[], due?: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoAdd(text, section, project, tags, due));
}
export function lockedTodoSet(match: string, done: boolean): string {
  return withFileLockSync(TODO_FILE, () => opTodoSet(match, done));
}
export function lockedTodoToggleAt(idx: number, done: boolean): string {
  return withFileLockSync(TODO_FILE, () => opTodoToggleAt(idx, done));
}
export function lockedTodoEdit(match: string, text: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoEdit(match, text));
}
export function lockedTodoDelete(match: string): string {
  return withFileLockSync(TODO_FILE, () => opTodoDelete(match));
}
export function lockedArchiveDone(): number {
  return withFileLockSync(TODO_FILE, () => todoStore.archiveDone());
}
export function lockedSummaryAdd(project: string, title: string, body: string): string {
  return withFileLockSync(SUMMARY_FILE, () => opSummaryAdd(project, title, body));
}
export function lockedSummaryUpdate(match: string, body: string): string {
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

export function matchesQuery(e: Entry, q: string): boolean {
  return kwAll(`${e.meta.subject}\n${e.meta.kind}\n${e.meta.scope}\n${e.body}`, q);
}

// 零命中日志：帮助发现“用户问过但库里没有”的缺口；失败绝不能影响检索
export type EntrySearchParams = {
  status?: string;
  kind?: string;
  subject_contains?: string;
  text_contains?: string;
  due?: boolean;
  limit?: number;
  scope?: string;
  list?: boolean;
};

/** 记一行零命中（q 至少 2 字符）；miss.log 保留最后 200 行。整个读—改—写进文件锁，写失败静默 */
function noteSearchMiss(q: string, cwd?: string, scope?: string): void {
  if (!refreshConfig().missLog || q.length < 2) return;
  try {
    ensureDirs();
    const line = `${new Date(clock.now()).toISOString()} | q=${q.replace(/\r?\n/g, " ")} | cwd=${path.basename(cwd ?? "") || "-"} | scope=${scope?.trim() || "-"}`;
    withFileLockSync(MISS_FILE, () => {
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(MISS_FILE, "utf8").split("\n").filter(Boolean);
      } catch {
        /* 首次零命中 */
      }
      lines.push(line);
      const kept = lines.length > MISS_KEEP ? lines.slice(-MISS_KEEP) : lines;
      writeAtomic(MISS_FILE, `${kept.join("\n")}\n`);
    });
  } catch {
    /* 日志只是线索，写不进去不能影响检索 */
  }
}

/** entries 检索（工具与零命中日志共用）：元数据筛选走索引，只有全文匹配才装载正文 */
export function searchEntries(q: string, p: EntrySearchParams, cwd?: string): string {
  let rows = entryStore.list();
  if (p.status) rows = rows.filter((r) => r.meta.status === p.status);
  if (p.kind) rows = rows.filter((r) => r.meta.kind === p.kind);
  if (p.scope) {
    const want = p.scope.trim();
    rows = rows.filter((r) => (r.meta.scope || "global").split(",").map((s) => s.trim()).includes(want));
  }
  if (p.subject_contains) rows = rows.filter((r) => (r.meta.subject ?? "").includes(p.subject_contains!));
  if (p.text_contains) rows = rows.filter((r) => (entryStore.get(r.id)?.body ?? "").includes(p.text_contains!));
  if (q) {
    rows = rows.filter((r) => {
      const full = entryStore.get(r.id);
      return full ? matchesQuery(full, q) : false;
    });
  }
  if (p.due) rows = rows.filter((r) => ACTIVE.has(r.meta.status) && isDue(r.meta));
  const lim = Math.min(p.limit ?? 30, 100);
  if (!rows.length) {
    if (q.length >= 2) noteSearchMiss(q, cwd, p.scope);
    return "（无匹配条目）";
  }
  const render = (r: EntryIndex) => {
    if (p.list) return `${r.id} ${r.meta.kind}/${r.meta.status} ${r.meta.subject}`;
    const tags = [r.meta.kind, r.meta.status, `scope=${r.meta.scope}`];
    if (r.meta.confidence) tags.push(`conf=${r.meta.confidence}`);
    if (r.meta.supersedes) tags.push(`supersedes=${r.meta.supersedes}`);
    if (ACTIVE.has(r.meta.status) && isDue(r.meta)) tags.push("DUE");
    return `${r.id} [${tags.join(" · ")}] ${r.meta.subject}: ${r.title.replace(/\n/g, " ")}`;
  };
  return `共 ${rows.length} 条${p.status ? "" : `（活动 ${rows.filter((r) => ACTIVE.has(r.meta.status)).length}）`}（显示前 ${Math.min(rows.length, lim)}）：\n\n${rows.slice(0, lim).map(render).join("\n")}`;
}

export function searchTodos(q: string): string {
  const text = todoStore.text();
  if (text === null) return "（todo.md 不存在）";
  // 归档项只在带关键词时才读（否则等于把历史支出重新搬回来）
  const archText = q ? todoStore.archiveText() : "";
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

export function searchSummary(q: string, cwd?: string): string {
  // 无 query 只读目录索引（summary-index.json），不读正文；有 query 才读全文
  if (!q) return summaryStore.nav(cwd);
  const text = summaryStore.text();
  if (text === null) return "（summary.md 不存在）";
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
/**
 * 在 qmd 的既有快照索引里检索归档细节（原 pi-memory daily / MEMORY / SCRATCHPAD 全文）。
 * 纯只读：不调 update/embed，索引停留在 2026-11-15 快照；qmd 未装或报错时返回人话而不是抛异常。
 */
export function searchArchive(q: string, limit: number): string {
  const n = Math.max(1, Math.min(25, limit || 5));
  if (!q) return "归档检索需要 query（走 qmd BM25，只覆盖 2026-11-15 快照索引：原 MEMORY/SCRATCHPAD/daily）。\n例：living_memory source=archive query=\"并发 重复扣款\"";
  const res = spawnSync(cfg.qmdBin, ["search", q, "--limit", String(n), "--json"], {
    encoding: "utf8",
    timeout: refreshConfig().qmdTimeoutMs,
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

/** 这段正文是否已被某条活动条目覆盖（Jaccard ≥ 0.45，或整句被条目正文包含） */
function coveredByEntry(text: string): string | null {
  // 去掉行首「决定：」「教训：」这类标签词，否则整句以标签开头、永远匹配不到条目正文
  const nb = normBody(text).replace(/^(决定|决策|约定|教训|结论|铁律|口径|规则|保留|采用)/, "");
  if (nb.length < 8) return null;
  const bag = bigrams(nb);
  for (const e of entryStore.listFull()) {
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
  const act = entryStore.listFull().filter((e) => ACTIVE.has(e.meta.status));
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
    .map((e) => ({ e, t: normBody(entryStore.get(e.meta.id)?.body ?? "") }))
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

const SEVERITY_RANK: Record<ManifestIssue["severity"], number> = { error: 0, warn: 1 };

/** 结构问题段：按 severity 排序（error 先），最多 20 条，末尾给总数 */
function renderManifestIssues(issues: ManifestIssue[]): string {
  if (!issues.length) return "结构问题：0 条（frontmatter、id、kind、status、日期、scope、action_impact、confidence 均合法）。";
  const errors = issues.filter((i) => i.severity === "error").length;
  const sorted = [...issues].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.field.localeCompare(b.field),
  );
  const rows = sorted
    .slice(0, 20)
    .map((it, i) => `${i + 1}. [${it.severity}] ${it.file}${it.id ? `（id=${it.id}）` : ""} 字段 ${it.field}：${it.problem}`);
  const more = issues.length > 20 ? `\n… 仅显示前 20 条，另有 ${issues.length - 20} 条未显示。` : "";
  return [`结构问题：检出 ${issues.length} 条（error ${errors} / warn ${issues.length - errors}）`, ...rows].join("\n") + more;
}

export function renderLint(): string {
  const act = entryStore.listFull().filter((e) => ACTIVE.has(e.meta.status));
  const hits = findConflicts();
  const issues = scanManifestIssues();
  const head = `冲突自检：活动 ${act.length} 条，检出 ${hits.length} 组候选`;
  const conflicts = hits.length
    ? `${head}\n${hits
        .map((h, i) => {
          const detail = h.ids
            .map((id) => {
              const e = entryStore.listFull().find((x) => x.meta.id === id);
              return e ? `${id}（${e.meta.kind ?? ""}/${e.meta.status ?? ""}/${(e.meta.obtained_at ?? "").slice(0, 10)}）${e.meta.subject ?? ""}` : id;
            })
            .join("  ⊗  ");
          return `${i + 1}. [${h.type}] ${h.label}\n   ${detail}\n   → ${h.note}，建议 supersede 合并 + expire 另一条`;
        })
        .join("\n")}`
    : `${head}（无同主体重复、无正文近似）。`;
  return `${conflicts}\n\n${renderManifestIssues(issues)}`;
}

/** 分流审计：entries 里像工程实况的 / summary 里像长期事实的，各给建议 */
export function renderRouting(): string {
  const PROC = /修复|实现|部署|合并|重构|调试|排查|迁移|构建|编译|测试通过|改完|跑通/;
  const DECISIONISH = /决定|决策|约定|规则|铁律|口径|必须|永不|禁止|不要|优先|保留|采用|命名|锁定|白名单|不得|不允许|一律|须/;
  const act = entryStore.listFull().filter((e) => ACTIVE.has(e.meta.status));
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
  const likeEntry = summaryStore
    .sections()
    .sections.filter((s) => !/归档/.test(s.title))
    .map((s) => ({ s, rules: ruleLines(s) }))
    .filter((x) => x.rules.length > 0 && !SELF_REF_MARK.test(x.s.title) && !META_SECTION.test(x.s.title))
    .map((x) => ({ ...x, covered: coveredByEntry(x.rules.join(" ")) }));
  const promote = likeEntry.filter((x) => !x.covered);
  const covered = likeEntry.filter((x) => x.covered);
  const out: string[] = [
    `分流审计：活动条目 ${act.length} 条，summary ${summaryStore.sections().sections.length} 节`,
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

/**
 * 召回第一阶段：候选行（状态/scope 合格）由 store 取，BM25 打分与排序在 ./src/recall。
 * 第二阶段由命中 id 的调用方按需 parseEntry；本函数只回 top 3 的 id/subject/title/score。
 */
function recallFor(
  query: string,
  cwd?: string,
  excludeIds?: Set<string>,
): Array<{ id: string; subject: string; title: string; score: number }> {
  const corpus = entryStore.list().filter((r) => RECALL_STATUS.has(r.meta.status ?? "") && inScope(r, cwd));
  return rankRecall(query, corpus, excludeIds);
}

/** 简报尾部召回段：固定格式、最多 3 条、整段 ≤300 字符 */
export function recallLine(query: string | undefined, cwd: string | undefined, excludeIds: Set<string>): string {
  if (!refreshConfig().recallEnabled || !query) return "";
  const hits = recallFor(query, cwd, excludeIds);
  if (!hits.length) return "";
  const items = hits.map((h) => `[${h.subject.slice(0, 80)}](${h.id.slice(0, 8)})`);
  const line = `· 召回（按本轮提问）：${items.join(" · ")}`;
  return line.length > 300 ? line.slice(0, 300) : line;
}
