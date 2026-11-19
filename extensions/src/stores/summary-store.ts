/**
 * summary.md / summary-archive.md / summary-index.json 的存储接口与实现。
 * 依赖图 L3：paths / config；不 import 扩展壳，也不 import 其它 store。
 * 锁不在这里：withFileLockSync 仍包在 ops 的 lockedSummaryXxx / summary_archive 的「读—改—写」整段。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { clock } from "../config";
import { IDX_VERSION, SUMMARY_ARCHIVE_FILE, SUMMARY_FILE, SUMMARY_INDEX_FILE, ensureDirs, writeAtomic } from "../paths";

// ---------- summary.md / summary-index.json / summary-archive.md 存储 ----------
export interface SummaryRow {
  num: number;
  title: string;
  project: string;
}
export interface SummarySection {
  /** `### [NN] 标题` 的编号；0 = 无编号的散块（不参与归档） */
  num: number;
  title: string;
  lines: string[];
}
/** 归档预览/结果里的一节：num 拼文案里的 `[NN]`，title 原样给调用方（截断口径在文案里） */
export type SummaryArchiveMove = { num: number; title: string };

/**
 * summary.md / summary-archive.md / summary-index.json 的存储接口：策略层只经它读写工程实况，
 * 不直接碰 fs 与派生索引。锁不在这里：withFileLockSync 仍包在 lockedSummaryXxx / summary_archive 的
 * 「读—改—写」整段，读写粒度与收口前一致（挪锁进 store 会改变并发语义）。
 * 文案（多命中歧义、dry_run 预览、归档指针措辞）与 activity.log 留在策略层，store 只回结构化结果。
 */
export interface SummaryStore {
  /** summary.md 全文（mtime+体积戳缓存）；文件不存在时返回 null（检索文案要区分「不存在」与空文件） */
  text(): string | null;
  /** summary.md 行（文件不存在时回 `# summary` 骨架：空库上 summary_add 仍能建文件） */
  lines(): string[];
  /** 整篇改写 summary.md（writeAtomic），写后全文缓存与目录索引同时失效 */
  write(lines: string[]): void;
  /** 小节视图：preamble（首个 `### [NN]` 之前的行）+ 带编号的整节（原样保留索引块+正文块） */
  sections(): { preamble: string[]; sections: SummarySection[] };
  /** 小节目录（编号+标题+所属项目）：只读 summary-index.json，戳不符才扫一遍 summary.md 重建 */
  index(): SummaryRow[];
  /** 追加一个小节：编号=max+1，落在 `## <project>` 节尾（节不存在则新建）；created 决定调用方文案 */
  add(project: string, title: string, body: string): { num: number; created: boolean };
  /**
   * 按小节标题的唯一关键词改写正文（标题与编号不变）：matched=命中标题（文件顺序），
   * updated=false（0 命中或多命中）不落盘，由调用方拼「找不到 / 多命中」文案。
   */
  update(match: string, body: string): { matched: string[]; updated: boolean };
  /**
   * 最老的若干 `### [NN]` 整节移入 summary-archive.md（活动文件里只留一行指针）；dryRun=true 只算不动。
   * sections=活动小节总数，moved=被移出的整节（num 升序，与文案里的 [NN] 顺序一致）。
   */
  archive(keep: number, dryRun: boolean): { sections: number; moved: SummaryArchiveMove[] };
  /** summary-archive.md 全文；文件不存在返回 null（没归档过，检索文案要区分） */
  archiveText(): string | null;
  /** 目录导航：按项目分组、每组最新 4 条；cwd 命中项目名时排前（不读正文） */
  nav(cwd?: string): string;
}

class FileSummaryStore implements SummaryStore {
  /** summary.md 全文缓存：检索/导航/分流审计共用一次读盘；戳=mtime+体积，写后立即失效 */
  private textCache: { stamp: string; text: string } | null = null;
  /** 小节目录缓存：与全文同口径（戳不符才扫一遍 summary.md 重建 summary-index.json） */
  private idxCache: { stamp: string; rows: SummaryRow[] } | null = null;

  text(): string | null {
    const stamp = this.stamp();
    if (!stamp) return null;
    if (this.textCache && this.textCache.stamp === stamp) return this.textCache.text;
    try {
      const text = fs.readFileSync(SUMMARY_FILE, "utf8");
      this.textCache = { stamp, text };
      return text;
    } catch {
      // 读不了（权限/被换成目录）按「不存在」处理：收口前 searchSummary 的 catch 就是这个口径
      return null;
    }
  }

  lines(): string[] {
    const text = this.text();
    return text === null ? ["# summary", ""] : text.split("\n");
  }

  write(lines: string[]): void {
    ensureDirs();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    writeAtomic(SUMMARY_FILE, `${lines.join("\n")}\n`);
    this.textCache = null;
    this.idxCache = null; // 目录索引随正文一起失效
  }

  sections(): { preamble: string[]; sections: SummarySection[] } {
    return summarySections(this.lines());
  }

  index(): SummaryRow[] {
    const stamp = this.stamp();
    if (!stamp) return [];
    if (this.idxCache && this.idxCache.stamp === stamp) return this.idxCache.rows;
    try {
      const raw = JSON.parse(fs.readFileSync(SUMMARY_INDEX_FILE, "utf8"));
      if (raw?.v === IDX_VERSION && raw?.stamp === stamp && Array.isArray(raw.rows)) {
        this.idxCache = { stamp, rows: raw.rows as SummaryRow[] };
        return this.idxCache.rows;
      }
    } catch {
      /* 缺失/损坏 → 重建 */
    }
    ensureDirs();
    const rows = this.buildRows();
    this.idxCache = { stamp, rows };
    writeAtomic(SUMMARY_INDEX_FILE, JSON.stringify({ v: IDX_VERSION, stamp, rows }));
    return rows;
  }

  add(project: string, title: string, body: string): { num: number; created: boolean } {
    const lines = this.lines();
    const { at, created } = summarySectionAt(lines, project);
    const num = summaryNextNumber(lines);
    const block = [
      "",
      `### [${num}] ${title}`,
      `<!-- src: living summary_add ${clock.today()} -->`,
      `### ${title}`,
      "",
      ...toBullets(body),
    ];
    if (created) lines.push("", `## ${project}`, ...block);
    else lines.splice(at, 0, ...block);
    this.write(lines);
    return { num, created };
  }

  update(match: string, body: string): { matched: string[]; updated: boolean } {
    const m = match.trim().toLowerCase();
    const lines = this.lines();
    const cands = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith("### ") && !/^### \[\d+\] /.test(l) && l.slice(4).toLowerCase().includes(m));
    const matched = cands.map((c) => c.l.slice(4));
    if (cands.length !== 1) return { matched, updated: false };
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
    this.write(lines);
    return { matched, updated: true };
  }

  archive(keep: number, dryRun: boolean): { sections: number; moved: SummaryArchiveMove[] } {
    const lines = this.lines();
    const { preamble, sections } = summarySections(lines);
    if (sections.length <= keep) return { sections: sections.length, moved: [] };
    const sorted = [...sections].sort((a, b) => a.num - b.num);
    const move = sorted.slice(0, sections.length - keep);
    const moved: SummaryArchiveMove[] = move.map((s) => ({ num: s.num, title: s.title }));
    if (dryRun) return { sections: sections.length, moved };
    const moveNums = new Set(move.map((s) => s.num));
    const stamp = new Date(clock.now()).toISOString().slice(0, 10);
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
    this.ensureArchiveHeader();
    const parts = move.map((s) => `<!-- archived ${stamp} from summary.md -->\n${s.lines.join("\n").replace(/\n+$/, "")}\n`);
    fs.appendFileSync(SUMMARY_ARCHIVE_FILE, `\n${parts.join("\n")}`);
    this.write(out);
    return { sections: sections.length, moved };
  }

  archiveText(): string | null {
    try {
      return fs.readFileSync(SUMMARY_ARCHIVE_FILE, "utf8");
    } catch {
      return null;
    }
  }

  nav(cwd?: string): string {
    const rows = this.index();
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

  /** summary.md 的 mtime+体积戳：全文缓存与目录索引共用的失效口径 */
  private stamp(): string {
    try {
      const st = fs.statSync(SUMMARY_FILE);
      return `${st.mtimeMs}|${st.size}`;
    } catch {
      return "";
    }
  }

  /** 戳不符时从 summary.md 重建目录并落盘 */
  private buildRows(): SummaryRow[] {
    const rows: SummaryRow[] = [];
    let project = "（未分节）";
    for (const line of fs.readFileSync(SUMMARY_FILE, "utf8").split("\n")) {
      if (line.startsWith("## ")) project = line.slice(3).trim();
      const m = line.match(/^### \[(\d+)\] (.+)$/);
      if (m) rows.push({ num: Number(m[1]), title: m[2].trim(), project });
    }
    return rows;
  }

  private ensureArchiveHeader(): void {
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
}
export const summaryStore: SummaryStore = new FileSummaryStore();

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

// ---------- summary.md 归档（控制文件规模：最老小节移入 summary-archive.md） ----------
/** @deprecated 无 IO 的纯解析器：策略层读 summary.md 请用 summaryStore.sections()；store.sections() 复用本实现 */
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
