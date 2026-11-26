/**
 * Phase 3 自动抽取：暂存本轮消息 → complete 抽候选 → 写待确认队列；失败落 extract-failures.jsonl。
 * 依赖图 L6：config / paths / manifest / entry-store / ops / brief；不 import 扩展壳。
 * 三个事件级状态（lastRunMessages / extractionInFlight / pendingExtraction）归本模块所有，
 * 壳只调 noteAgentEnd / settleExtraction / scheduleExtraction / awaitPendingExtraction；
 * widget 刷新依赖 pi ctx，由壳通过 setUiRefresh 注入（否则 extract → 壳成环）。
 */
import { complete } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";

import { clock, logger, refreshConfig } from "./config";
import { KINDS, type Meta } from "./manifest";
import { ACTIVITY, EXTRACT_FAIL_FILE, EXTRACT_GATE_FILE, ensureDirs, isPaused, newId, withFileLockSync, writeAtomic } from "./paths";
import { entryStore } from "./stores/entry-store";
import { AUTO_FACT_CONF, appendEvidence, autoFactable, autoTriage, isPluginInternal, today } from "./ops";
import { brief } from "./brief";
import { textOf } from "./text";

/** 失败台账保留条数：只留最近 50 条，旧记录滚掉 */
const EXTRACT_FAIL_KEEP = 50;
/** 被闸台账保留条数：只留最近 200 条，旧记录滚掉 */
const EXTRACT_GATE_KEEP = 200;

interface ExtractFailure {
  ts: string;
  reason: string;
  detail: string;
}

function noteExtractFailure(reason: string, detail: string): void {
  const row: ExtractFailure = { ts: new Date(clock.now()).toISOString(), reason, detail: String(detail ?? "").slice(0, 240) };
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
  logger.activity(`extract failed ${reason}: ${row.detail}`);
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

export function recentExtractFailures(hours = 24): ExtractFailure[] {
  const since = clock.now() - hours * 3600e3;
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

export function extractHealthText(): string {
  const fails = extractFailures();
  if (!fails.length) {
    const ok = lastExtractRun();
    return `extract：没有失败记录（文件 ${EXTRACT_FAIL_FILE} 为空）${ok ? `\n最近一次运行 ${ok}` : ""}\n失败文件只在模型调用/解析失败时追加，最多留 ${EXTRACT_FAIL_KEEP} 条。\n${gateHealthText()}`;
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
    "失败原因分类：request-failed=模型调用抛错 / empty-response=模型没回内容 / no-json=回包里找不到 JSON 数组 / parse-failed=JSON 解析失败 / manifest-invalid=候选字段未通过写入校验",
    ...last,
    gateHealthText(),
  ].join("\n");
}

export function conversationText(msgs: any[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const t = textOf(m).trim();
    if (t) parts.push(`[${m.role}] ${t}`);
  }
  const s = parts.join("\n");
  return s.length > 6000 ? s.slice(-6000) : s;
}

/** 空白归一：引文溯源只比对内容，不因换行/缩进差异误杀 */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * L0 溯源闸的底料：只取 role=user 的正文，空白归一后拼接。
 * 不受 conversationText 的 6000 字符截断影响——引文校验必须看到完整用户轮次。
 */
export function userTurnsText(msgs: any[]): string {
  return msgs
    .filter((m) => m?.role === "user")
    .map((m) => normalizeSpace(textOf(m)))
    .filter(Boolean)
    .join(" ");
}

export function extractEnabled(): boolean {
  return refreshConfig().extractEnabled;
}

function resolveExtractModel(ctx: any): any | null {
  const spec = refreshConfig().extractModel;
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

export function extractionSystemPrompt(existing: string): string {
  return [
    "你是长期记忆抽取器（Today 记忆契约）。从对话中抽取「跨会话仍有价值」的记忆候选。",
    "准入五类：稳定偏好 / 进行中承诺或截止 / 关系信息 / 用户纠正 / 决策与行动结果。",
    "禁入：凭证密钥、未证实敏感推断（健康/政治/财务/性取向）、一时状态、可被日志替代的完整记录、超出任务需要的他人隐私。另禁入：①记忆系统自身的状态/条目推断（自我指涉：面板/库/抽取器的状态一律不当候选）②会话过程性事项（提案、待办、瞬时 git 或仓库状态）——已明确拍板的决策除外 ③**工程实现本身**：把「我们实现了 X / 修了 Y / 加了某索引·缓存·动作·阈值 / 改了某函数行为」记为 decision 或 correction 也属自指污染，这类内容归 summary.md（summary_add），抽取器必须跳过；只有「用户对系统提出的要求或偏好」才可抽 close 到 preference/constraint。",
    existing ? `已知活动条目（勿重复抽取；仅当对话明确纠正既有事实时抽 correction）：\n${existing}` : "当前无既有条目。",
    '每项的 quote 必须是本轮**用户消息里的逐字子串**（至少 6 字），用于溯源；禁止用助手回复、工具输出或任务书里的句子充数——找不到用户原话就不要输出该候选。',
    '只输出 JSON 数组（无任何其它文字），每项 {"kind":"preference|constraint|commitment|relation|correction|decision|outcome","subject":"说谁/什么","text":"1-3 句事实","quote":"用户原话逐字摘录","confidence":0-1}。最多 3 项；无可抽取内容输出 []。',
  ].join("\n");
}

/** 解析结果：失败只回 code/detail，模型 id 与 reason 由壳拼接后再写抽取失败台账 */
export type ParsedExtraction =
  | { ok: true; value: unknown }
  | { ok: false; code: "empty-response" | "no-json" | "parse-failed"; detail: string };

/**
 * 纯解析：空回包 → empty-response；剥 ```json 围栏后取首个 `[` 到末个 `]`，找不到 → no-json；
 * JSON.parse 抛错 → parse-failed。成功时 value 是 unknown：是不是数组、字段合不合法交给 normalize。
 */
export function parseExtractionOutput(out: string): ParsedExtraction {
  const text = String(out ?? "");
  if (!text.trim()) return { ok: false, code: "empty-response", detail: "" };
  let raw = text;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  const l = raw.indexOf("[");
  const r = raw.lastIndexOf("]");
  if (l < 0 || r <= l) return { ok: false, code: "no-json", detail: `回包里找不到 JSON 数组：${text.slice(0, 120)}` };
  try {
    return { ok: true, value: JSON.parse(raw.slice(l, r + 1)) };
  } catch {
    return { ok: false, code: "parse-failed", detail: `JSON 解析失败：${raw.slice(l, l + 120)}` };
  }
}

/** quote=模型给出的用户原话逐字引文（L0 溯源闸用；缺失/对不上用户轮次 → unverified） */
export type ExtractionCandidate = { kind: string; subject: string; body: string; confidence: number; quote?: string };
/** 批内被弃的原因：kind/subject/body=字段不过闸，self-ref=讲插件自身，duplicate=同批完全重复（只留首条） */
export type ExtractionSkipReason = "kind" | "subject" | "body" | "self-ref" | "duplicate";
export type NormalizedExtraction = {
  candidates: ExtractionCandidate[];
  skipped: Array<{ reason: ExtractionSkipReason; kind: string; subject: string }>;
};

/**
 * 纯归一：只认前 3 项（配额）· kind 必须在 KINDS 内 · subject/body trim 后非空 ·
 * confidence 夹到 [0,1]（缺省 0.6）· 自指 subject 不立条目 · 同批同 kind+subject+body 只留首条。
 * 非数组一律空转（坏回包不报错，由壳按「0 条」继续）。
 */
export function normalizeExtractionItems(value: unknown): NormalizedExtraction {
  const candidates: ExtractionCandidate[] = [];
  const skipped: NormalizedExtraction["skipped"] = [];
  if (!Array.isArray(value)) return { candidates, skipped };
  for (const item of value.slice(0, 3)) {
    const kind = String(item?.kind ?? "");
    const subject = String(item?.subject ?? "").trim();
    const body = String(item?.text ?? "").trim();
    const quote = String(item?.quote ?? "").trim();
    const confidence = Math.min(Math.max(Number(item?.confidence ?? 0.6), 0), 1);
    if (!(KINDS as readonly string[]).includes(kind)) {
      skipped.push({ reason: "kind", kind, subject });
      continue;
    }
    if (!subject) {
      skipped.push({ reason: "subject", kind, subject });
      continue;
    }
    if (!body) {
      skipped.push({ reason: "body", kind, subject });
      continue;
    }
    // 自指过滤：讲插件自身实现/参数的候选不立条目（归 summary），避免「开发过程」污染个人记忆层
    if (isPluginInternal(subject)) {
      skipped.push({ reason: "self-ref", kind, subject });
      continue;
    }
    if (candidates.some((c) => c.kind === kind && c.subject === subject && c.body === body)) {
      skipped.push({ reason: "duplicate", kind, subject });
      continue;
    }
    candidates.push({ kind, subject, body, confidence, quote });
  }
  return { candidates, skipped };
}

/** 硬闸跳过原因：unverified=引文对不上用户原话，noise=命令/路径/任务书/过程自述，self-ref=正文讲插件自身 */
export type ExtractionGateReason = "unverified" | "noise" | "self-ref";
/** enforce=拦下并记账；shadow=只记账不拦（LIVING_MEMORY_EXTRACT_GATE=0） */
export type ExtractionGateMode = "enforce" | "shadow";
export type ExtractionGateHit = { candidate: ExtractionCandidate; reason: ExtractionGateReason };
export type ExtractionGateResult = { accepted: ExtractionCandidate[]; gated: ExtractionGateHit[] };

/** 命令/工具 token、仓库数据路径、任务书词汇：命中即判过程噪声，只抽用户事实、不抄过程 */
const PROCESS_NOISE_RES: RegExp[] = [
  /(?:^|[\s，。；、])(?:git|npm|bun|pnpm|tsc)\s/,
  /(?:^|[\s，。；、])--[^\s]/,
  /```/,
  /&&/,
  /^\$ /m,
  /extensions\//,
  /\/src\//,
  /\.ts\b/,
  /package\.json/,
  /~\/\.pi\/agent/,
  /docs\//,
  /tests\/run\.ts/,
  /[0-9a-f]{40}/i,
  /(?:背景|输入|要求|输出格式|验收标准|委派|子代理|任务书|worker|scout|reviewer)/i,
];
/** 正文以这些词开头且含实现动词 → 助手/工具的过程自述，不是用户事实 */
const PROCESS_LEAD_RE = /^(?:已|我|我们|现已|刚才|本轮|这一轮)/;
const PROCESS_VERB_RE = /(改|修|跑|推|提交|删|加|验证|复验|实现)/;
/** L2 正文自指：讲记忆插件自身的实现/参数/工具调用 */
const BODY_SELF_REF_RE = /LIVING_MEMORY_|\/memory\b|living_memory\(|remember\(|extensions\/src\//;

export function isProcessNoise(body: string): boolean {
  const b = String(body ?? "").trim();
  if (!b) return false;
  if (PROCESS_NOISE_RES.some((re) => re.test(b))) return true;
  return PROCESS_LEAD_RE.test(b) && PROCESS_VERB_RE.test(b);
}

/**
 * L0–L2 硬闸（纯函数）：quote 缺失/短于 6 字符/归一后不是用户原话子串 → unverified（不回退、不放行）；
 * 正文自指插件 → self-ref；正文像命令/工具输出/任务书/过程自述 → noise。
 * shadow 模式把命中的候选也放行，只返回 gated 供记账。
 */
export function applyExtractionGate(candidates: ExtractionCandidate[], userText: string, mode: ExtractionGateMode): ExtractionGateResult {
  const user = normalizeSpace(userText);
  const accepted: ExtractionCandidate[] = [];
  const gated: ExtractionGateHit[] = [];
  for (const candidate of candidates) {
    const quote = normalizeSpace(candidate.quote ?? "");
    const reason: ExtractionGateReason | null =
      quote.length < 6 || !user.includes(quote)
        ? "unverified"
        : BODY_SELF_REF_RE.test(candidate.body)
          ? "self-ref"
          : isProcessNoise(candidate.body)
            ? "noise"
            : null;
    if (reason) gated.push({ candidate, reason });
    if (!reason || mode === "shadow") accepted.push(candidate);
  }
  return { accepted, gated };
}

interface ExtractGateRow {
  ts: string;
  reason: ExtractionGateReason;
  kind: string;
  subject: string;
  body: string;
  quote: string;
}

function extractGateRows(): ExtractGateRow[] {
  try {
    return fs
      .readFileSync(EXTRACT_GATE_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ExtractGateRow];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** 写被闸台账（文件锁 + 原子写，保留最近 200 条）并落 activity；影子模式同样记账 */
export function recordExtractionGates(gated: ExtractionGateHit[], trigger: string, mode: ExtractionGateMode): void {
  if (!gated.length) return;
  const ts = new Date(clock.now()).toISOString();
  try {
    ensureDirs();
    withFileLockSync(EXTRACT_GATE_FILE, () => {
      const lines = extractGateRows().map((r) => JSON.stringify(r));
      for (const { candidate, reason } of gated)
        lines.push(
          JSON.stringify({
            ts,
            reason,
            kind: candidate.kind,
            subject: candidate.subject,
            body: candidate.body.slice(0, 120),
            quote: (candidate.quote ?? "").slice(0, 60),
          }),
        );
      writeAtomic(EXTRACT_GATE_FILE, `${(lines.length > EXTRACT_GATE_KEEP ? lines.slice(-EXTRACT_GATE_KEEP) : lines).join("\n")}\n`);
    });
  } catch {
    /* 观测失败不影响抽取主流程 */
  }
  for (const { candidate, reason } of gated)
    logger.activity(`auto-extract gated ${reason} kind=${candidate.kind} subject=${candidate.subject} (${trigger}${mode === "shadow" ? " shadow" : ""})`);
}

/** source=extract 追加段：近 7 日被闸条数 + 原因分布 + 最近 5 条正文摘要 */
function gateHealthText(): string {
  const rows = extractGateRows();
  const since = clock.now() - 7 * 86400e3;
  const week = rows.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= since;
  });
  const byReason = new Map<string, number>();
  for (const r of week) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  const counts = [...byReason.entries()].map(([r, n]) => `${r} ${n}`).join(" / ");
  const recent = rows
    .slice(-5)
    .reverse()
    .map((r) => `· ${r.ts.slice(5, 16).replace("T", " ")} ${r.reason} — ${r.body}`);
  return [
    `gate：近 7 天被闸 ${week.length} 条${counts ? `（${counts}）` : ""}，台账共 ${rows.length} 条（上限 ${EXTRACT_GATE_KEEP}）`,
    ...recent,
  ].join("\n");
}

/** 单条候选的落库分流：create=照常新建（或待确认推断），conflict=库内已有同 kind+subject 且正文相似的活动条目 */
export type ExtractionDecision = { candidate: ExtractionCandidate; verdict: "create" | "conflict" };

/**
 * 纯决策：只把「是否与既有条目冲突」交给注入的查找函数，批次内不读盘、不写盘。
 * runExtraction 注入 entryStore.findConflicting；测试注入固定布尔表即可覆盖 create/conflict 分流。
 */
export function decideExtractionBatch(
  candidates: ExtractionCandidate[],
  findConflicting: (kind: string, subject: string, body: string) => boolean,
): ExtractionDecision[] {
  return candidates.map((candidate) => ({
    candidate,
    verdict: findConflicting(candidate.kind, candidate.subject, candidate.body) ? "conflict" : "create",
  }));
}

let extractionInFlight = false;
let pendingExtraction: Promise<void> | null = null;
let lastRunMessages: any[] | null = null;

export function scheduleExtraction(msgs: any[], ctx: any, reason: string) {
  if (extractionInFlight) return;
  const text = conversationText(msgs);
  const userText = userTurnsText(msgs);
  logger.debug(`scheduleExtraction (${reason}): text=${text.length}ch user=${userText.length}ch`);
  if (!text) return;
  extractionInFlight = true;
  const timeoutMs = refreshConfig().extractTimeoutMs;
  pendingExtraction = (async () => {
    const expired = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    await Promise.race([runExtraction(text, userText, ctx, reason), expired]);
  })()
    .catch(() => {})
    .finally(() => {
      extractionInFlight = false;
    });
}

async function runExtraction(text: string, userText: string, ctx: any, reason: string): Promise<void> {
  try {
    if (isPaused()) return;
    const model = resolveExtractModel(ctx);
    if (!model) return;
    const apiKey = await resolveApiKey(ctx, model);
    logger.debug(`runExtraction ${reason}: model=${model?.provider ?? "?"}/${model?.id ?? "?"} apiKey=${apiKey ? "yes" : "no"}`);
    if (!apiKey) {
      logger.activity(`auto-extract skipped: no api key (${reason})`);
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
        messages: [{ role: "user", content: [{ type: "text", text }], timestamp: clock.now() }],
      },
      { apiKey, reasoningEffort: "low" },
    );
    const out = ((response as any).content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    logger.debug(`extraction raw out: ${JSON.stringify(out).slice(0, 300)}`);
    const parsed = parseExtractionOutput(out);
    if (!parsed.ok) {
      // 失败文案与拆分前逐字一致：空回包补模型 id，解析失败补原因，无数组直接用片段
      const detail =
        parsed.code === "empty-response"
          ? `model=${model.id} 回包无文本（${reason}）`
          : parsed.code === "parse-failed"
            ? `${parsed.detail}（${reason}）`
            : parsed.detail;
      noteExtractFailure(parsed.code, detail);
      return;
    }
    logger.debug(`parsed ${Array.isArray(parsed.value) ? parsed.value.length : "non-array"} items`);
    const { candidates, skipped } = normalizeExtractionItems(parsed.value);
    for (const s of skipped)
      if (s.reason === "self-ref")
        logger.activity(`auto-extract skipped self-ref kind=${s.kind} subject=${s.subject} (${reason})`);
    const mode: ExtractionGateMode = refreshConfig().extractGate ? "enforce" : "shadow";
    const { accepted, gated } = applyExtractionGate(candidates, userText, mode);
    recordExtractionGates(gated, reason, mode);
    logger.debug(`extraction gates (${mode}): accepted=${accepted.length} gated=${gated.length}`);
    let n = 0;
    const decisions = decideExtractionBatch(
      accepted,
      (kind, subject, body) => entryStore.findConflicting(kind, subject, body) !== null,
    );
    for (const { candidate, verdict } of decisions) {
      const { kind, subject, body, confidence } = candidate;
      if (verdict === "conflict") {
        // 同一推断再次被抽取到：算一次复现证据（不新建条目，不改 confidence）
        // verdict 只带布尔，复现证据需要条目本体，只在冲突这条少数路径上再取一次
        const dup = entryStore.findConflicting(kind, subject, body);
        if (dup?.meta.status === "inference")
          appendEvidence(dup, { at: new Date(clock.now()).toISOString(), kind: "repeat", id: `extract-${reason}`, note: "抽取器再次命中同一事实" });
        continue;
      }
      const autoFact = autoFactable(kind, confidence, "advice-only");
      const id = newId();
      const meta: Meta = {
        id,
        kind,
        status: autoFact ? "confirmed" : "inference",
        subject,
        scope: "global",
        source: `auto-extract ${today()}（${reason} 模型抽取，${autoFact ? "高置信度自动按事实" : "待用户确认"}）`,
        obtained_at: new Date(clock.now()).toISOString(),
        confirmed_at: autoFact ? new Date(clock.now()).toISOString() : "",
        expires_at: "",
        review_after: new Date(clock.now() + 14 * 86400e3).toISOString().slice(0, 10),
        confidence: String(confidence),
        action_impact: "advice-only",
        supersedes: "",
        superseded_by: "",
      };
      try {
        entryStore.put({ meta, body });
      } catch (err) {
        // 抽取候选也走同一道闸：模型传来的字段非法时不落盘，记进抽取失败台账后继续下一条
        noteExtractFailure("manifest-invalid", `${subject}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      logger.activity(
        `auto-extract created ${id} kind=${kind} status=${meta.status}${autoFact ? ` auto-fact conf=${meta.confidence}` : ""} subject=${subject} (${reason})`,
      );
      n++;
    }
    logger.debug(`candidates written: ${n}`);
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
      uiRefresh(ctx);
    }
  } catch (err) {
    logger.debug(`runExtraction threw: ${err instanceof Error ? err.message : String(err)}`);
    noteExtractFailure("request-failed", err instanceof Error ? err.message : String(err));
  }
}

/** UI 刷新落点：widget 是 pi ctx 的事，归壳；由 default() 注入，默认空实现 */
let uiRefresh: (ctx: any) => void = () => {};
export function setUiRefresh(fn: (ctx: any) => void): void {
  uiRefresh = fn;
}

/** agent_end：暂存本轮消息（真正开抽在 agent_settled，避免与工具写库抢文件） */
export function noteAgentEnd(msgs: any[] | null): void {
  lastRunMessages = msgs;
}

/** agent_settled：取走暂存消息，按暂停/开关档位决定是否开抽（日志口径与拆分前逐字一致） */
export function settleExtraction(aborted: boolean, ctx: any): void {
  const msgs = lastRunMessages;
  lastRunMessages = null;
  logger.debug(`agent_settled: aborted=${!!aborted} msgs=${msgs?.length ?? 0} enabled=${extractEnabled()} paused=${isPaused()}`);
  if (!msgs || aborted || !extractEnabled() || isPaused()) return;
  scheduleExtraction(msgs, ctx, "agent_settled");
}

/** session_shutdown：headless 退出前等在途抽完（超时兜底在 scheduleExtraction 里） */
export async function awaitPendingExtraction(): Promise<void> {
  if (!pendingExtraction) return;
  try {
    await pendingExtraction;
  } catch {
    /* 已在内部吞掉 */
  }
  pendingExtraction = null;
}
