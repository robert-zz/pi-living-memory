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
 *
 * 模块图（单向依赖，无环）：
 *   L0 config · L1 text/paths · L2 manifest · L3 recall + stores/* · L4 ops · L5 brief · L6 extract · L7 本壳
 * 本壳只做 pi 注册、工具 schema、事件接线与日志落点；业务在 ./src 下按层拆分。
 */
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";

import { cfg, clock, logger, refreshConfig, setClock, setConfig, setLogger, setSettingsReader } from "./src/config";
import { normSubject, textOf } from "./src/text";
import { ACTIVE, KINDS, type Entry, type Meta } from "./src/manifest";
import {
  ACTIVITY,
  PAUSE_FLAG,
  PROFILE_FILE,
  SUMMARY_FILE,
  activityArchivePath,
  ensureDirs,
  entryPath,
  healLegacyNames,
  isPaused,
  legacyTwins,
  newId,
  withFileLockSync,
  writeAtomic,
} from "./src/paths";
import { entryStore } from "./src/stores/entry-store";
import { dueState, parseTodoMeta, todoStore } from "./src/stores/todo-store";
import { summaryStore } from "./src/stores/summary-store";
import {
  AUTO_FACT_CONF,
  addDays,
  appendEvidence,
  autoFactEvidence,
  autoFactable,
  autoFactRetro,
  autoTriage,
  defaultReviewAfter,
  fmt,
  lockedArchiveDone,
  lockedSummaryAdd,
  lockedSummaryUpdate,
  lockedTodoAdd,
  lockedTodoDelete,
  lockedTodoEdit,
  lockedTodoSet,
  lockedTodoToggleAt,
  matchesQuery,
  opConfirm,
  opDelete,
  opExpire,
  opExpireBatch,
  opPromoteScan,
  opPurgeExpired,
  opRenew,
  opRestore,
  opStyleScan,
  opSummaryArchive,
  opSupersede,
  renderLint,
  renderRouting,
  rotateRecovery,
  searchArchive,
  searchEntries,
  searchExpired,
  searchSummary,
  searchSummaryArchive,
  searchTodos,
  styleScanOverdue,
  todoSummaryText,
  validateScope,
} from "./src/ops";
import { brief, briefIndex, buildBrief } from "./src/brief";
import {
  awaitPendingExtraction,
  extractEnabled,
  extractHealthText,
  noteAgentEnd,
  recentExtractFailures,
  scheduleExtraction,
  setUiRefresh,
  settleExtraction,
} from "./src/extract";

/** 默认日志出口：activity 写 activity.log（含轮转），debug 仅在 LIVING_MEMORY_DEBUG=1 时落盘，warn 静默。 */
setLogger({
  activity: (msg) => appendActivityLog(msg),
  debug: (msg) => appendDebugLog(msg),
  warn: () => {},
});

/** logger.activity 的默认实现：追加 activity.log（月度轮转，失败静默） */
function appendActivityLog(line: string): void {
  ensureDirs();
  // 审计日志轮转：超过阈值就改名成 activity-YYYY-MM.log，历史仍可 grep，当前文件封顶
  const maxBytes = refreshConfig().activityMaxBytes;
  try {
    if (fs.statSync(ACTIVITY).size > maxBytes) {
      const month = new Date(clock.now()).toISOString().slice(0, 7);
      let dest = activityArchivePath(month);
      let n = 1;
      while (fs.existsSync(dest)) dest = activityArchivePath(month, n++);
      fs.renameSync(ACTIVITY, dest);
    }
  } catch {
    /* 首次写入或轮转失败都不影响写日志 */
  }
  fs.appendFileSync(ACTIVITY, `[${new Date(clock.now()).toISOString()}] ${line}\n`);
}

/** logger.debug 的默认实现：仅 LIVING_MEMORY_DEBUG=1 时落盘（现状没有控制台输出，这里也不新增） */
function appendDebugLog(s: string): void {
  if (!refreshConfig().debug) return;
  try {
    fs.appendFileSync("/tmp/living-memory-debug.log", `[${new Date(clock.now()).toISOString()}] ${s}\n`);
  } catch {
    /* 调试失败无害 */
  }
}

// healLegacyNames：早期版本用大写文件名，只剩大写孪生文件时改名为小写。
// 这是**唯一**的模块加载期 IO（用户可见的前置修复）；其余模块顶层零 IO，读写都在调用时发生。
healLegacyNames();

/** 本轮提问：事件直接给的 prompt 优先；没有就退到会话最后一条 user 消息；都没有返回空（不报错） */
function currentUserPrompt(event: any, ctx: any): string {
  const direct = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (direct) return direct.slice(0, 200);
  try {
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "message" || e?.message?.role !== "user") continue;
      const text = textOf(e.message).trim();
      if (text) return text.slice(0, 200);
    }
  } catch {
    /* 会话形状由宿主决定，拿不到就当没有查询 */
  }
  return "";
}

/** 常驻 widget：只看索引（不读正文），到期/待确认条数为 0 就清空 */
function refreshWidget(ctx: any) {
  try {
    if (!ctx?.hasUI) return;
    const { pending, due } = briefIndex();
    ctx.ui.setWidget("living-memory", due.length + pending.length > 0 ? [`长期记忆：${due.length} 条到期待复核 · ${pending.length} 条推断待确认 → /memory`] : []);
  } catch {
    /* widget 是尽力而为 */
  }
}

// ---------- 扩展 ----------
type TextToolReply = string | { content: Array<{ type: "text"; text: string }> };

/** 工具返回值归一：宿主契约要求 AgentToolResult（details 必填），本扩展只产出文本 content；
 *  在此统一补 details（不发给模型，供日志/UI）并把历史遗留的裸字符串分支包成 content。execute 主体保持原样。 */
function toolExecute<A extends unknown[]>(fn: (...args: A) => Promise<TextToolReply>) {
  return async (...args: A): Promise<AgentToolResult> => {
    const r = await fn(...args);
    return typeof r === "string"
      ? { content: [{ type: "text", text: r }], details: {} }
      : { content: r.content, details: {} };
  };
}

export default function (pi: ExtensionAPI) {
  // settings.json 的 livingMemory 段（autoTriage / reviewDays）：pi 实例只在 default() 里拿得到，
  // 所以把惰性读器交给 config 持有（jiti 下 export let 的重新赋值不跨模块传播，读器必须与 getSettings 同模块）。
  setSettingsReader(() => pi.getSettings?.() ?? null);
  // extract 的 UI 刷新落点：widget 依赖 pi ctx，只能由壳注入，避免 extract → 壳成环。
  setUiRefresh(refreshWidget);
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
      subject: Type.String({ description: "主体：说谁/什么（如 用户、张三、acme 项目）" }),
      text: Type.String({ description: "记忆正文（1-3 句事实本身；含原话则引用）" }),
      basis: StringEnum(["explicit", "event", "inference"]),
      source: Type.String({ description: "来源：日期+会话/谁说的/原话" }),
      scope: Type.Optional(Type.String({ description: "适用范围：global / workspace:<名> / project:<名>；多值逗号分隔" })),
      expires_at: Type.Optional(Type.String({ description: "ISO 日期：到期自动进复核队列" })),
      review_after: Type.Optional(Type.String({ description: "ISO 日期：到该日进复核（复核而非静默删除）" })),
      confidence: Type.Optional(Type.Number({ description: "basis=inference 必填，0-1" })),
      action_impact: Type.Optional(StringEnum(["advice-only", "reminder", "needs-confirm"])),
    }),
    execute: toolExecute(async (_toolCallId: string, p: any, _sig: any, _upd: any, ctx: any) => {
      if (isPaused())
        return { content: [{ type: "text", text: "living memory 已被 /memory off 暂停——本次未写入。恢复需用户执行 /memory on。" }] };
      if (p.basis === "inference" && (p.confidence == null || p.confidence < 0 || p.confidence > 1))
        return { content: [{ type: "text", text: "basis=inference 必须带 confidence（0-1）。" }] };
      const dup = entryStore.findConflicting(p.kind, p.subject, p.text);
      if (dup) {
        // 推断条目被再次提及：记证据而不是新建（第二步）；显式陈述算最强证据 restate
        if (dup.meta.status === "inference" && (p.basis === "inference" || p.basis === "explicit")) {
          const note = appendEvidence(dup, {
            at: new Date(clock.now()).toISOString(),
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
      const siblings = entryStore.list().filter(
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
        obtained_at: new Date(clock.now()).toISOString(),
        confirmed_at: autoFact || p.basis === "explicit" ? new Date(clock.now()).toISOString() : "",
        expires_at: p.expires_at || "",
        review_after: p.review_after || defaultReviewAfter(p.basis, p.kind),
        confidence: p.basis === "inference" ? String(p.confidence) : "",
        action_impact: p.action_impact || "advice-only",
        supersedes: "",
        superseded_by: "",
      };
      try {
        entryStore.put({ meta, body: p.text });
      } catch (err) {
        // 写路径收紧：非法字段（日期/id/kind/status/scope/confidence…）拒绝落盘，原因回给调用方
        return { content: [{ type: "text", text: `${err instanceof Error ? err.message : String(err)}\n（本次未写入；修正字段后重试。）` }] };
      }
      logger.activity(
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
    }),
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
      scope: Type.Optional(Type.String({ description: "按 scope 精确过滤（如 project:acme）；entries 检索与零命中日志共用" })),
      status: Type.Optional(Type.String({ description: "过滤状态：explicit/event/inference/confirmed/superseded/expired" })),
      kind: Type.Optional(StringEnum(KINDS)),
      subject_contains: Type.Optional(Type.String()),
      text_contains: Type.Optional(Type.String()),
      due: Type.Optional(Type.Boolean({ description: "true=只看活动且今天已到期/待复核" })),
      list: Type.Optional(Type.Boolean({ description: "true=精简列表（只回 id/kind/status/subject，不返回标题与正文），浏览巡检用" })),
      limit: Type.Optional(Type.Number()),
    }),
    execute: toolExecute(async (_toolCallId: string, p: any, _sig: any, _upd: any, ctx: any) => {
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
          const hits = entryStore.listFull().filter((e: Entry) => ACTIVE.has(e.meta.status) && matchesQuery(e, q));
          parts.push(
            hits.length
              ? `entries：${hits.length} 条命中\n${hits.slice(0, 10).map((e: Entry) => fmt(e)).join("\n")}`
              : "entries：无命中",
          );
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
      }
      // 元数据筛选走索引（一次读盘，frontmatter + 首行摘要）；只有全文匹配时才装载正文
      return { content: [{ type: "text", text: searchEntries(q, p, ctx?.cwd) }] };
    }),
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
      scope: Type.Optional(Type.String({ description: "批量 expire 可选：按 scope 精确选择（如 project:acme）" })),
      subject_contains: Type.Optional(Type.String({ description: "批量 expire 可选：subject 包含该子串（如「记忆」）" })),
      kind: Type.Optional(StringEnum(KINDS, { description: "批量 expire 可选：按类别选择" })),
      keep: Type.Optional(Type.Number({ description: "summary_archive 可选：活动 summary.md 保留多少个最新小节，默认 60（LIVING_MEMORY_SUMMARY_KEEP 可改）" })),
    }),
    execute: toolExecute(async (_toolCallId: string, p: any, _sig: any, _upd: any, ctx: any) => {
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
              text: rotateRecovery(Number.isFinite(days) ? days : cfg.recoveryRetainDays, p.dry_run !== false),
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
                opSummaryArchive(Number.isFinite(keep) && keep > 0 ? keep : cfg.summaryKeep, p.dry_run !== false),
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
      const e = entryStore.get(p.id);
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
    }),
  });

// ---------- 画像统计块（profile.md）：只做可计算的事，判断性表述留给四节正文 ----------
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
  const all = entryStore.list();
  const act = all.filter((e) => ACTIVE.has(e.meta.status));
  const count = (arr: Array<{ meta: Meta }>, f: (e: { meta: Meta }) => string) => {
    const m = new Map<string, number>();
    for (const e of arr) m.set(f(e) || "?", (m.get(f(e) || "?") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const list = (arr: Array<[string, number]>) => arr.map(([k, v]) => `${k} ${v}条`).join(" · ") || "（无）";
  const scopes = new Map<string, number>();
  for (const e of act) for (const s of (e.meta.scope ?? "").split(",").map((x) => x.trim()).filter(Boolean)) scopes.set(s, (scopes.get(s) ?? 0) + 1);
  const dates = act.map((e) => (e.meta.obtained_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const age = dates.length ? Math.round((clock.now() - new Date(`${dates[0]}T00:00:00Z`).getTime()) / 86_400_000) : 0;
  const multi = act.filter((e) => (e.meta.scope ?? "").includes(",")).length;
  const proj = act.filter((e) => /project:|workspace:/.test(e.meta.scope ?? "")).length;
  const superseded = all.filter((e) => e.meta.status === "superseded").length;
  const stamp = new Date(clock.now()).toISOString().slice(0, 16).replace("T", " ");
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
  if (next === old) return `profile.md 统计块已是最新（活动 ${entryStore.list().filter((e) => ACTIVE.has(e.meta.status)).length} 条），未写盘。`;
  writeAtomic(PROFILE_FILE, next);
  logger.activity("profile rebuild");
  return `已刷新 ${PROFILE_FILE}（活动 ${entryStore.list().filter((e) => ACTIVE.has(e.meta.status)).length} 条）`;
}

  // /memory 面板
  pi.registerCommand("memory", {
    description: "长期记忆治理面板（无参=浏览；todo=逐条勾选待办；review=逐条处理到期复核；pending=逐条处理待确认推断；off/on=暂停/恢复写入）",
    getArgumentCompletions: (prefix: string) => {
      const items = ["review", "pending", "todo", "profile", "style", "on", "off"].map((v) => ({ value: v, label: v }));
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim();
      if (arg === "off") {
        ensureDirs();
        fs.writeFileSync(PAUSE_FLAG, `${new Date(clock.now()).toISOString()}\n`);
        logger.activity("pause on");
        ctx.ui.notify("living memory 写入已暂停（remember 将拒写）", "info");
        return;
      }
      if (arg === "on") {
        if (fs.existsSync(PAUSE_FLAG)) fs.unlinkSync(PAUSE_FLAG);
        logger.activity("pause off");
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
          const lines = showDone ? todoStore.archiveLines() : todoStore.lines();
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
          const doneCount = todoStore.index().done;
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
      if (arg === "style") {
        const days = 30;
        const out = opStyleScan(days);
        ctx.ui.notify(out.split("\n").slice(0, 6).join("\n"), "info");
        ctx.ui.setStatus?.("living-memory", "style_scan 完成（候选见通知，详情用 living_memory action=style_scan）");
        refreshWidget(ctx);
        return;
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
      const rotated = rotateRecovery(cfg.recoveryRetainDays, false);
      if (rotated.startsWith("已物理删除")) ctx.ui.notify(`living memory ${rotated}`, "info");
      // 项 5：只提示不自动搬（过期条目可归档 / summary 小节超阈值），避免每次启动都动文件
      if (refreshConfig().startHints) {
        const hints: string[] = [];
        const twins = legacyTwins();
        if (twins) hints.push(`发现大写孪生文件 ${twins}（陈旧实例可能又写回来了）：/reload 后人工合并，否则写入会分叉`);
        const pc = entryStore.purgeExpired(30, true);
        if (pc.candidates.length) hints.push(`过期 ${pc.candidates.length} 条可归档（living_memory action=purge_expired 预览）`);
        const doneTodo = todoStore.index().done;
        if (doneTodo > 0) hints.push(`todo.md 内已完成 ${doneTodo} 项可归档（/memory todo → 归档已完成）`);
        const dueTodo = todoStore.dueRows();
        if (dueTodo.length) {
          const overdue = dueTodo.filter((r) => dueState(r.due) === "overdue").length;
          hints.push(
            `待办 ${dueTodo.length} 项 7 日内到期${overdue ? `（其中 ${overdue} 项已逾期）` : ""}：source=todo query="due:soon" 查看`,
          );
        }
        const styleDue = styleScanOverdue(30) && entryStore.list().filter((r) => ACTIVE.has(r.meta.status ?? "explicit")).length >= 5;
        if (styleDue) hints.push("画像 30 天未归纳：action=style_scan 出候选，再按证据改写 profile.md 的三、四节");
        const fail24 = recentExtractFailures(24);
        if (fail24.length) {
          const why = [...new Set(fail24.map((f) => f.reason))].join("/");
          hints.push(`抽取 24h 内失败 ${fail24.length} 次（${why}）：source=extract 看原因与原文片段`);
        }
        const secs = summaryStore.index().length;
        if (secs > cfg.summaryKeep) {
          const autoKeep = refreshConfig().autoArchiveKeep;
          if (refreshConfig().autoArchive && secs > autoKeep) {
            const r = opSummaryArchive(autoKeep, false);
            ctx.ui.notify(`living memory 自动归档（节数 ${secs} > ${autoKeep}）：${r}`, "info");
          } else hints.push(`summary ${secs} 节 > ${cfg.summaryKeep}（action=summary_archive 预览）`);
        }
        if (hints.length) ctx.ui.notify(`living memory ${hints.join(" · ")}`, "info");
      }
      // 画像统计块：机械计数，幂等（无变化不写盘），静默刷新（与提示开关无关）
      if (refreshConfig().profileAuto) {
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
      if (!refreshConfig().briefEnabled) return;
      const block = buildBrief(ctx?.cwd, currentUserPrompt(event, ctx));
      if (!block) return;
      return { systemPrompt: event.systemPrompt + block };
    } catch {
      /* 注入失败静默 */
    }
  });

  // Phase 3：agent_end 暂存本 run 消息 → agent_settled 触发抽取（fire-and-forget）
  pi.on("agent_end", async (event: any) => {
    logger.debug(`agent_end: ${(event?.messages ?? []).length} msgs`);
    noteAgentEnd(event?.messages ?? null);
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    settleExtraction(Boolean(event?.aborted), ctx);
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
    await awaitPendingExtraction();
  });
}

// 注入点对测试/宿主开放：默认实现与线上完全一致，只有显式注入才偏离（对外行为不变）
export { setConfig, setClock, setLogger };
