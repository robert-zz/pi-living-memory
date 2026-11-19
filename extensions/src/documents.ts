/**
 * 文档层：summary.md 小节增改 / 归档与归档检索、todo.md 待办增删改勾选、简报用待办摘录、跨进程锁包装。
 * 依赖 config / paths / text / todo-store / summary-store；锁、读写与 IO 都在调用时。
 */

import { cfg, logger } from "./config";
import { SUMMARY_FILE, TODO_FILE, withFileLockSync } from "./paths";
import { normText } from "./text";
import { DONE_MARK_RE, parseTodoMeta, todoStore, todoSuffix, type TodoMeta } from "./stores/todo-store";
import { summaryStore } from "./stores/summary-store";

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
