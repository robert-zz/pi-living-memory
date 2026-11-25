/**
 * 检索与自检：entries / todo / summary / archive 检索、零命中日志、冲突与 manifest lint、分流审计、召回候选行。
 * 依赖 config / paths / manifest / text / recall / time / scope / triage 与三个 store；模块顶层不做 IO。
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { cfg, clock, refreshConfig } from "./config";
import { ACTIVE, parseEntryWithIssues, type Entry, type EntryIndex, type ManifestIssue } from "./manifest";
import { ENTRIES_DIR, MISS_FILE, ensureDirs, manifestFileLabel, withFileLockSync, writeAtomic } from "./paths";
import { RECALL_STATUS, rankRecall } from "./recall";
import { inScope } from "./scope";
import { bigrams, jaccard, normBody, normSubject } from "./text";
import { SELF_REF_MARK } from "./triage";
import { isDue } from "./time";
import { entryStore } from "./stores/entry-store";
import { dueState, parseTodoMeta, todoStore, type DueState } from "./stores/todo-store";
import { summaryStore, type SummarySection } from "./stores/summary-store";

/** 零命中日志（miss.log）保留行数：超过就只留最后 200 行 */
const MISS_KEEP = 200;

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
