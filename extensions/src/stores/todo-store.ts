/**
 * todo.md / todo-archive.md / todo-index.json 的存储接口与实现。
 * 依赖图 L3：paths / config；不 import 扩展壳，也不 import 其它 store。
 * 锁不在这里：withFileLockSync 仍包在 ops 的 lockedTodoXxx「读—改—写」整段（挪进 store 会改变并发语义）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { clock, logger } from "../config";
import { IDX_VERSION, TODO_ARCHIVE_FILE, TODO_FILE, TODO_INDEX_FILE, ensureDirs, writeAtomic } from "../paths";

/** 待办行命中：idx 是 todo.md 行下标（面板与按下标改写都用它） */
type TodoMatch = { idx: number; line: string; done: boolean };
/** insert 结果：no-file=todo.md 缺失或为空；no-section 带现有小节名，文案由调用方拼 */
type TodoInsertResult =
  | { inserted: true }
  | { inserted: false; reason: "no-file" | "no-section"; sections: string[] };

/**
 * todo.md / todo-archive.md / todo-index.json 的存储接口：策略层只经它读写待办，不直接碰 fs 与派生索引。
 * 锁不在这里：withFileLockSync 仍包在 lockedTodoXxx 的「读—改—写」整段，store 方法的读写粒度与收口前一致
 * （挪锁进 store 会改变并发语义）。文案（含多命中歧义提示）留在策略层，store 只回命中行与改写结果。
 */

export interface TodoStore {
  /** todo.md 全文（mtime+size 戳缓存）；文件不存在时返回 null（空文件返回 ""：检索文案要区分两者） */
  text(): string | null;
  /** todo.md 行（文件不存在时为空数组） */
  lines(): string[];
  /** 未完成目录（节名 + 正文前 100 字 + @project/#tag/due，done=已完成条数）：简报/面板/计数读它，不读全文 */
  index(): { open: TodoRow[]; done: number };
  /** 逾期 / 今天 / 7 日内到期的未完成待办（简报与开屏提示读它） */
  dueRows(): TodoRow[];
  /** 整篇改写 todo.md（writeAtomic），写后全文缓存与目录索引同时失效 */
  write(lines: string[]): void;
  /** 按正文关键词定位（大小写不敏感子串），未完成项优先；idx 是 todo.md 行下标 */
  matches(match: string): TodoMatch[];
  /** 插入一条完整待办行：给了 section 就插到该节最后一条待办之后，否则插到最后一条待办之后；不写盘的原因由调用方拼文案 */
  insert(line: string, section?: string): TodoInsertResult;
  /** 按下标勾选/取消（面板行下标）：返回改写后的整行；该行不是待办条目时返回 null（不写盘） */
  setDoneAt(idx: number, done: boolean): string | null;
  /** 按下标改写正文（保留勾选状态与 done 标记）：返回改写后的整行；该行不是待办条目时返回 null */
  editAt(idx: number, body: string): string | null;
  /** 按下标删除：返回被删的整行；该行不是待办条目时返回 null */
  deleteAt(idx: number): string | null;
  /** 已完成项搬进 todo-archive.md（按 done 日期倒序、按完成月份分节），返回搬动条数（审计口径不变） */
  archiveDone(): number;
  /** todo-archive.md 全文（带关键词检索用：没 query 就不读它）；读失败返回 "" */
  archiveText(): string;
  /** todo-archive.md 行（/memory todo 的归档视图用；读失败为空数组） */
  archiveLines(): string[];
}

class FileTodoStore implements TodoStore {
  /** todo.md 全文缓存：简报 + 面板 + 计数共用一次读盘；戳=mtime+体积，写后立即失效 */
  private textCache: { stamp: string; text: string } | null = null;
  /** 未完成目录缓存：与全文同口径（戳不符才扫一遍 todo.md 重建 todo-index.json） */
  private idxCache: { stamp: string; open: TodoRow[]; done: number } | null = null;

  text(): string | null {
    let stamp = "";
    try {
      const st = fs.statSync(TODO_FILE);
      stamp = `${st.mtimeMs}|${st.size}`;
    } catch {
      return null;
    }
    if (this.textCache && this.textCache.stamp === stamp) return this.textCache.text;
    const text = fs.readFileSync(TODO_FILE, "utf8");
    this.textCache = { stamp, text };
    return text;
  }

  lines(): string[] {
    const text = this.text();
    return text ? text.split("\n") : [];
  }

  index(): { open: TodoRow[]; done: number } {
    const stamp = this.stamp();
    if (!stamp) return { open: [], done: 0 };
    if (this.idxCache && this.idxCache.stamp === stamp) return this.idxCache;
    try {
      const raw = JSON.parse(fs.readFileSync(TODO_INDEX_FILE, "utf8"));
      if (raw?.v === IDX_VERSION && raw?.stamp === stamp && Array.isArray(raw.open)) {
        this.idxCache = { stamp, open: raw.open as TodoRow[], done: Number(raw.done ?? 0) };
        return this.idxCache;
      }
    } catch {
      /* 缺失/损坏 → 重建 */
    }
    const built = this.buildRows();
    this.idxCache = { stamp, ...built };
    writeAtomic(TODO_INDEX_FILE, JSON.stringify({ v: IDX_VERSION, stamp, ...built }));
    return this.idxCache;
  }

  dueRows(): TodoRow[] {
    return this.index().open.filter((r) => {
      const s = dueState(r.due);
      return s === "overdue" || s === "today" || s === "soon";
    });
  }

  write(lines: string[]): void {
    ensureDirs();
    writeAtomic(TODO_FILE, lines.join("\n"));
    this.textCache = null;
    this.idxCache = null; // 目录索引同时失效
  }

  matches(match: string): TodoMatch[] {
    const m = match.trim().toLowerCase();
    if (!m) return [];
    return this.lines()
      .map((line, idx) => ({ idx, line, mm: TODO_LINE_RE.exec(line) }))
      .filter((r) => r.mm && r.line.toLowerCase().includes(m))
      .map((r) => ({ idx: r.idx, line: r.line, done: r.mm![1] !== " " }))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.idx - b.idx);
  }

  insert(line: string, section?: string): TodoInsertResult {
    const lines = this.lines();
    if (!lines.length) return { inserted: false, reason: "no-file", sections: [] };
    if (section) {
      const from = lines.findIndex(
        (l) => l.startsWith("## ") && l.toLowerCase().includes(section.trim().toLowerCase()),
      );
      if (from < 0)
        return {
          inserted: false,
          reason: "no-section",
          sections: lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3)),
        };
      let at = -1;
      for (let i = from + 1; i < lines.length && !lines[i].startsWith("## "); i++) if (TODO_LINE_RE.test(lines[i])) at = i;
      if (at < 0) lines.splice(from + 1, 0, "", line);
      else lines.splice(at + 1, 0, line);
    } else {
      let at = -1;
      for (let i = 0; i < lines.length; i++) if (TODO_LINE_RE.test(lines[i])) at = i;
      if (at < 0) lines.push(line);
      else lines.splice(at + 1, 0, line);
    }
    this.write(lines);
    return { inserted: true };
  }

  setDoneAt(idx: number, done: boolean): string | null {
    const lines = this.lines();
    const line = lines[idx] ?? "";
    if (!TODO_LINE_RE.test(line)) return null;
    const body = line.replace(DONE_MARK_RE, "").replace(/^- \[([ xX])\] /, "");
    lines[idx] = done ? `- [x] ${body} <!-- done: ${new Date(clock.now()).toISOString().slice(0, 10)} -->` : `- [ ] ${body}`;
    this.write(lines);
    return lines[idx];
  }

  editAt(idx: number, body: string): string | null {
    const lines = this.lines();
    const mm = TODO_LINE_RE.exec(lines[idx] ?? "");
    if (!mm) return null;
    const done = mm[1] !== " ";
    const doneMark = done ? (lines[idx].match(/<!-- done: [^>]+ -->/)?.[0] ?? "") : "";
    const kept = doneMark ? ` ${doneMark}` : "";
    lines[idx] = `- [${done ? "x" : " "}] ${body}${kept}`;
    this.write(lines);
    return lines[idx];
  }

  deleteAt(idx: number): string | null {
    const lines = this.lines();
    if (!TODO_LINE_RE.test(lines[idx] ?? "")) return null;
    const removed = lines.splice(idx, 1)[0];
    this.write(lines);
    return removed ?? null;
  }

  archiveDone(): number {
    const lines = this.lines();
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
    const month = clock.today().slice(0, 7);
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
    this.write(rest);
    logger.activity(`todo archive moved=${done.length} total=${total} file=todo-archive.md`);
    return done.length;
  }

  archiveText(): string {
    try {
      return fs.readFileSync(TODO_ARCHIVE_FILE, "utf8");
    } catch {
      return "";
    }
  }

  archiveLines(): string[] {
    const text = this.archiveText();
    return text ? text.split("\n") : [];
  }

  /** todo.md 的 mtime+体积戳：全文缓存与目录索引共用的失效口径 */
  private stamp(): string {
    try {
      const st = fs.statSync(TODO_FILE);
      return `${st.mtimeMs}|${st.size}`;
    } catch {
      return "";
    }
  }

  /** 戳不符时从 todo.md 重建目录并落盘 */
  private buildRows(): { open: TodoRow[]; done: number } {
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
}

export const todoStore: TodoStore = new FileTodoStore();

const TODO_LINE_RE = /^- \[([ xX])\] (.+)$/;
const ARCHIVE_SECTION = "## 已完成归档";
export const DONE_MARK_RE = /\s*<!-- done: [^>]*-->[ \t]*$/;

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
  const d = new Date(clock.now());
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export interface TodoMeta {
  project?: string;
  tags: string[];
  due?: string;
  text: string;
}

/** 从行尾逐个剥离 @project / #tag / due:YYYY-MM-DD，剩下的才是正文（正文里同名标记保留原样） */
export function parseTodoMeta(raw: string): TodoMeta {
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
export function todoSuffix(project?: string, tags?: string[], due?: string): string {
  const parts: string[] = [];
  if (project) parts.push(`@${project}`);
  for (const t of tags ?? []) if (t) parts.push(`#${t}`);
  if (due) parts.push(`due:${due}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export type DueState = "none" | "overdue" | "today" | "soon" | "later";

export function dueState(due?: string): DueState {
  if (!due) return "none";
  const today = localDay();
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (due <= localDay(7)) return "soon";
  return "later";
}
