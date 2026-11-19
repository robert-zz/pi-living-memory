/**
 * 简报：分档预算、待办摘录/到期、画像摘要、召回段与页脚。
 * 依赖图 L5：config / paths / text / manifest / recall（经 ops 的 recallLine）/ entry-store / todo-store / ops。
 * 只读索引行做简报（不装载 entries 正文）；brief() 是面板用的全量口径，两者分开命名。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { cfg, clock, refreshConfig } from "./config";
import { ACTIVE, type Entry, type EntryIndex } from "./manifest";
import { isNegation } from "./text";
import { PROFILE_BRIEF_FLAG, PROFILE_FILE } from "./paths";
import { entryStore } from "./stores/entry-store";
import { dueState, todoStore } from "./stores/todo-store";
import { inScope, isDue, recallLine, todoDigest } from "./ops";

// ---------- Phase 5：简报分层预算 + 文档检索辅助 ----------
// 简报改为分档配额：到期 > 待确认推断 > 当前项目 scope > 全局，各档独立上限；
// 每行 subject 42 字符 + 正文摘录，总长硬顶（默认 2400，LIVING_MEMORY_BRIEF_MAX_CHARS 可调）；
// 被裁掉的条数显式告知而不是静默丢弃——目录条目会随迁移持续增长。
const BRIEF_LINE_CHARS = 130;
const TODO_DIGEST_RESERVE = 150;

function profileDigest(max = 200): string {
  let text = "";
  try {
    text = fs.readFileSync(PROFILE_FILE, "utf8");
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

const PROFILE_BRIEF_ON = () => {
  const c = refreshConfig();
  if (c.profileBrief === "on") return true;
  if (c.profileBrief === "off") return false;
  try {
    return fs.existsSync(PROFILE_BRIEF_FLAG);
  } catch {
    return false;
  }
};
function briefLine(tag: string, e: EntryIndex): string {
  const subject = (e.meta.subject || "").slice(0, 42);
  const body = e.title.replace(/\s+/g, " ").trim();
  const room = Math.max(24, BRIEF_LINE_CHARS - tag.length - subject.length - 1);
  return `${tag}${subject}：${body.length > room ? `${body.slice(0, room)}…` : body}`;
}

export function briefIndex() {
  const all = entryStore.list();
  const active = all.filter((e) => ACTIVE.has(e.meta.status));
  const pending = active.filter((e) => e.meta.status === "inference");
  const due = active.filter((e) => isDue(e.meta));
  return { all, active, pending, due };
}

export function brief() {
  const all = entryStore.listFull();
  const active = all.filter((e) => ACTIVE.has(e.meta.status));
  const pending = active.filter((e) => e.meta.status === "inference");
  const due = active.filter((e) => isDue(e.meta));
  return { all, active, pending, due };
}

export function buildBrief(cwd?: string, query?: string): string {
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
  const usedIds = new Set<string>();
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
      if (used + text.length + 1 > cfg.briefMaxChars) {
        dropped++;
        continue;
      }
      lines.push(text);
      usedIds.add(e.id);
      used += text.length + 1;
      n++;
    }
  }
  if (!lines.length) return "";
  const openTodos = todoStore.index().open.length;
  // 当前项目节的未完成待办摘 2 条（内容不塞进 entries，只做行内提醒）
  if (base && used + TODO_DIGEST_RESERVE <= cfg.briefMaxChars) {
    for (const t of todoDigest(base, 2)) {
      const line = `待办·${t.section}：${t.text}`;
      if (used + line.length + 1 > cfg.briefMaxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
  }

  // 到期提醒：逾期 / 今天 / 7 日内（跨项目，最多 3 条）
  const dueTodo = todoStore.dueRows();
  if (dueTodo.length) {
    const show = dueTodo.slice(0, 3);
    const line = `待办到期：${show
      .map((r) => `${dueState(r.due) === "overdue" ? `逾期(${r.due})` : r.due} ${r.text.slice(0, 22)}`)
      .join(" · ")}${dueTodo.length > 3 ? ` …（共 ${dueTodo.length} 项）` : ""}`;
    if (used + line.length + 1 <= cfg.briefMaxChars) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  // 最近 14 天的变更（本项目或全局，按 obtained_at 倒序，最多 3 条）
  const since = new Date(clock.now() - 14 * 86400e3).toISOString();
  const recent = [...proj, ...glob]
    .filter((e) => String(e.meta.obtained_at) >= since)
    .sort((a, b) => String(b.meta.obtained_at).localeCompare(String(a.meta.obtained_at)))
    .slice(0, 3);
  if (recent.length) {
    const line = `近期：${recent.map((e) => `${(e.meta.obtained_at ?? "").slice(5, 10)} ${e.meta.kind ?? ""}/${(e.meta.subject ?? "").slice(0, 16)}`).join(" · ")}`;
    if (used + line.length + 1 <= cfg.briefMaxChars) {
      lines.push(line);
      used += line.length + 1;
    }
  }

  // 画像摘要（默认关：LIVING_MEMORY_PROFILE_BRIEF=1 开）
  if (PROFILE_BRIEF_ON()) {
    const digest = profileDigest();
    if (digest) {
      const line = `· 画像：${digest}`;
      if (used + line.length + 1 <= cfg.briefMaxChars + 220) {
        lines.push(line);
        used += line.length + 1;
      }
    }
  }

  // 召回段必须排在所有分档/待办/画像之后；预算不够时先砍它，不挤占既有档位
  const recall = recallLine(query, cwd, usedIds);
  if (recall && used + recall.length + 1 <= cfg.briefMaxChars) {
    lines.push(recall);
    used += recall.length + 1;
  }

  const shownNote = `${lines.length}/${visible.length}${dropped ? `（${dropped} 条未显示，用 living_memory 查全文）` : ""}`;
  const dueTodoCount = todoStore.dueRows().length;
  const tail = `\n（活动 ${active.length} · 到期 ${due.length} · 待确认 ${pending.length} · 简报 ${shownNote}${openTodos ? ` · 待办 ${openTodos} 项` : ""}${dueTodoCount ? ` · 待办到期 ${dueTodoCount} 项` : ""} — 检索 source=todo/summary/entries；治理 /memory）`;
  return `\n\n## Living Memory（个人长期记忆层 · Today 契约）\n到期项需处理；[待确认] 是未经确认的推断，只能作弱参考，不得当事实引用。完整正文用 living_memory；纠正用 living_memory_update supersede；工程实况用 living_memory source=summary/todo 检索；待办勾选用 living_memory_update action=todo_done match=唯一关键词。\n${lines.join("\n")}${tail}`;
}
