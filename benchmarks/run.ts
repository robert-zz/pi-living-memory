/**
 * 真实召回基准（roadmap v0.2.x 第 1 项）：只评检索，不做答案判定。
 * 口径：questions.jsonl 的 gold 是期望命中的条目 id；absent 类 gold=[]，严格判空才算拒答正确。
 *
 * 只读保证：先把库快照到临时 HOME 的 .pi/agent/memory，再加载扩展源码（STORE 在模块加载期按 HOME 定死）；
 * store 的索引自愈/缓存落盘只发生在快照里，原库零写入。--memory 只是换快照来源。
 *
 * 用法：
 *   bun benchmarks/run.ts                                  # 默认库 + 读 baseline.json 做发布前门禁
 *   bun benchmarks/run.ts --memory /tmp/memcopy            # 指定库副本
 *   bun benchmarks/run.ts --update-baseline                 # 写入 benchmarks/baseline.json（不跑门禁）
 *   bun benchmarks/run.ts --extract                        # 抽取决策回放（不联网、报告型、无门禁）
 *   bun benchmarks/run.ts --extract-live                   # 只打印说明，模型侧漂移需人工录制回包
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import type { EntryIndex } from "../extensions/src/manifest";
import type { ExtractionCandidate, ExtractionDecision, NormalizedExtraction, ParsedExtraction } from "../extensions/src/extract";

/** 用 CJS 引用拿 node:os：静态 import 会把命名空间缓存住，homedir 补丁就传不进 paths.ts */
const nodeOs = createRequire(import.meta.url)("node:os") as { homedir: () => string; tmpdir: () => string };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.dirname(HERE);
const QUESTIONS_FILE = path.join(HERE, "questions.jsonl");
const BASELINE_FILE = path.join(HERE, "baseline.json");
const EXTRACT_GOLD_FILE = path.join(HERE, "extract-gold.jsonl");
const EXTRACT_FAMILIES = ["clean", "self-ref", "duplicate", "over-quota", "invalid-field", "parse-failure", "conflict-with-existing"] as const;
/** 默认库：在改 HOME 之前取，之后的 os.homedir() 指向临时快照 */
const DEFAULT_MEMORY = path.join(nodeOs.homedir(), ".pi", "agent", "memory");

const K3 = 3;
const K5 = 5;
const MIN_RECALL3 = 0.4;
const MIN_REFUSAL = 0.5;
const GATE_RELATIVE_DROP = 0.05;
/** 拒答门槛口径 A：不低于基线 −5pp（无基线时回落绝对值 MIN_REFUSAL） */
const GATE_REFUSAL_DROP = 0.05;
const CATS = ["exact", "state", "history", "neg", "scope", "absent"] as const;

type Question = { id: string; q: string; cat: string; scope: string | null; gold: string[] };
type Hit = { id: string; subject: string; title: string; score: number };
type CatStat = { n: number; recall3: number; recall5: number; mrr3: number; absent: number; refused: number };
type Metrics = {
  questions: number;
  processed: number;
  goldQuestions: number;
  absentQuestions: number;
  recall3: number;
  recall5: number;
  mrr3: number;
  refusal: number;
  latencyMs: number[];
  briefChars: number[];
  byCat: Record<string, CatStat>;
  absentMisses: Array<{ id: string; hits: string[] }>;
  errors: string[];
};
type Baseline = {
  generated_at: string;
  git_head: string;
  entry_count: number;
  question_count: number;
  recall_at_3: number;
  recall_at_5: number;
  mrr_at_3: number;
  refusal_accuracy: number;
  brief_chars_mean: number;
};

function usage(): string {
  return [
    "用法：bun benchmarks/run.ts [--memory <dir>] [--baseline <path>] [--update-baseline]",
    "      bun benchmarks/run.ts --extract [--memory <dir>]",
    "      bun benchmarks/run.ts --extract-live",
    "  --memory <dir>      用指定记忆库副本做快照（默认 ~/.pi/agent/memory）",
    "  --baseline <path>   门禁基线文件（默认 benchmarks/baseline.json；负向测试用）",
    "  --update-baseline   把本次指标写入 benchmarks/baseline.json，不跑门禁",
    "  --extract           跑抽取决策回放（不联网、报告型指标、不进发布门禁）",
    "  --extract-live      只打印说明：模型侧漂移需在 pi 会话内录制回包后人工核对",
  ].join("\n");
}

function parseArgs(argv: string[]): { memory: string; baseline: string; updateBaseline: boolean; extract: boolean; extractLive: boolean } {
  let memory: string | null = null;
  let baseline: string | null = null;
  let updateBaseline = false;
  let extract = false;
  let extractLive = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--memory") {
      const v = argv[++i];
      if (!v) throw new Error("--memory 需要一个目录参数");
      memory = path.resolve(v);
    } else if (a.startsWith("--memory=")) {
      memory = path.resolve(a.slice("--memory=".length));
    } else if (a === "--baseline") {
      const v = argv[++i];
      if (!v) throw new Error("--baseline 需要一个文件参数");
      baseline = path.resolve(v);
    } else if (a.startsWith("--baseline=")) {
      baseline = path.resolve(a.slice("--baseline=".length));
    } else if (a === "--update-baseline") {
      updateBaseline = true;
    } else if (a === "--extract") {
      extract = true;
    } else if (a === "--extract-live") {
      extractLive = true;
    } else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`未知参数：${a}\n${usage()}`);
    }
  }
  return { memory: memory ?? DEFAULT_MEMORY, baseline: baseline ?? BASELINE_FILE, updateBaseline, extract, extractLive };
}

function loadQuestions(file: string): Question[] {
  if (!fs.existsSync(file)) throw new Error(`问题文件不存在：${file}`);
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const ids = new Set<string>();
  const out: Question[] = [];
  lines.forEach((line, i) => {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`${file}:${i + 1} JSON 解析失败：${(e as Error).message}`);
    }
    const id = String(row?.id ?? "");
    const q = String(row?.q ?? "");
    const cat = String(row?.cat ?? "");
    const scope = row?.scope == null ? null : String(row.scope);
    const gold = Array.isArray(row?.gold) ? row.gold.map(String) : [];
    if (!id || !q) throw new Error(`${file}:${i + 1} 缺 id 或 q`);
    if (!CATS.includes(cat as (typeof CATS)[number])) throw new Error(`${file}:${i + 1}（${id}）未知 cat：${cat}`);
    if (scope !== null && !/^(project|workspace):[^\s,]+$/.test(scope))
      throw new Error(`${file}:${i + 1}（${id}）scope 不合法：${scope}`);
    if (cat === "absent" && gold.length) throw new Error(`${file}:${i + 1}（${id}）absent 类的 gold 必须为空`);
    if (cat !== "absent" && !gold.length) throw new Error(`${file}:${i + 1}（${id}）非 absent 类必须有 gold`);
    if (ids.has(id)) throw new Error(`${file}:${i + 1}（${id}）id 重复`);
    ids.add(id);
    out.push({ id, q, cat, scope, gold });
  });
  return out;
}

/** 把库复制到临时 HOME：复制而非原地跑，给 store 的自愈写盘一个一次性落点 */
function snapshotMemory(memoryDir: string): { home: string; origin: string } {
  if (!fs.existsSync(memoryDir)) throw new Error(`记忆库不存在：${memoryDir}`);
  if (!fs.existsSync(path.join(memoryDir, "entries"))) throw new Error(`记忆库缺少 entries/：${memoryDir}`);
  const home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), "lm-bench-home-"));
  const target = path.join(home, ".pi", "agent", "memory");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(memoryDir, target, { recursive: true, preserveTimestamps: true });
  return { home, origin: memoryDir };
}

/**
 * Bun 在进程启动时缓存 os.homedir()：只改 process.env.HOME 不会让 paths.ts 的 STORE 换目录，
 * --memory 会被静默忽略、回放仍读写真库。快照隔离必须同时替换 homedir()，跑完再还原。
 * 只影响本基准进程；扩展源码不感知这个补丁。
 */
function useSnapshotHome(home: string): () => void {
  const original = nodeOs.homedir;
  nodeOs.homedir = () => home;
  return () => {
    nodeOs.homedir = original;
  };
}

/** 问题里的 scope 是「期望的检索 scope」：用同名 basename 的假 cwd 走 inScope（global 条目照常可见） */
function cwdFor(scope: string | null): string | undefined {
  if (!scope) return undefined;
  return path.join("/bench", scope.split(":").slice(1).join(":"));
}

function coverage(gold: string[], hits: Hit[]): number {
  return gold.filter((id) => hits.some((h) => h.id === id)).length / gold.length;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** /proc/self/io 的 rchar：Linux 才有；其它平台返回 null 并按 n/a 打印 */
function readRchar(): number | null {
  try {
    const txt = fs.readFileSync("/proc/self/io", "utf8");
    const m = txt.match(/^rchar:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function gitHead(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() || "unknown" : "unknown";
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function printReport(m: Metrics, ctx: { origin: string; entryCount: number; rcharBytes: number | null }) {
  const p50 = percentile(m.latencyMs, 0.5);
  const p95 = percentile(m.latencyMs, 0.95);
  const charsTotal = m.briefChars.reduce((s, n) => s + n, 0);
  const charsMean = m.questions ? charsTotal / m.questions : 0;
  console.log("\n=== pi-living-memory 召回基准 ===");
  console.log(`记忆库：${ctx.origin}（快照条目 ${ctx.entryCount}） · 题目 ${m.questions} · 有 gold ${m.goldQuestions} · absent ${m.absentQuestions}`);
  console.log("");
  console.log("指标");
  console.log(`  Recall@3        ${fmt(m.recall3)}（${m.goldQuestions} 题宏平均）`);
  console.log(`  Recall@5        ${fmt(m.recall5)}`);
  console.log(`  MRR@3           ${fmt(m.mrr3)}`);
  console.log(`  拒答准确率       ${fmt(m.refusal)}（${Math.round(m.refusal * m.absentQuestions)}/${m.absentQuestions}，absent 严格判空）`);
  console.log(`  检索耗时 p50/p95 ${p50.toFixed(2)} / ${p95.toFixed(2)} ms（每题 scope 过滤 + rankRecall(k=5)）`);
  console.log(
    `  读盘字节        ${
      ctx.rcharBytes === null
        ? "n/a（非 Linux 或无 /proc/self/io）"
        : `${ctx.rcharBytes} B（评估阶段 /proc/self/io rchar 前后差）`
    }`,
  );
  console.log(`  注入字符        总 ${charsTotal} / 均 ${charsMean.toFixed(1)}（buildBrief(undefined, q).length）`);
  console.log("");
  console.log("按 cat");
  console.log("  cat       n   Recall@3  Recall@5  MRR@3    拒答");
  for (const c of CATS) {
    const s = m.byCat[c];
    if (!s) continue;
    if (c === "absent") {
      console.log(`  ${c.padEnd(8)} ${String(s.n).padStart(3)}   ${"—".padEnd(9)} ${"—".padEnd(9)} ${"—".padEnd(8)} ${fmt(s.refused / Math.max(1, s.absent))}（${s.refused}/${s.absent}）`);
    } else {
      console.log(
        `  ${c.padEnd(8)} ${String(s.n).padStart(3)}   ${fmt(s.recall3 / s.n).padEnd(9)} ${fmt(s.recall5 / s.n).padEnd(9)} ${fmt(s.mrr3 / s.n).padEnd(8)} —`,
      );
    }
  }
  if (m.absentMisses.length) {
    console.log("");
    console.log("absent 未判空（诊断，不改 DF 门槛）：");
    for (const miss of m.absentMisses) console.log(`  ${miss.id} → ${miss.hits.join(", ")}`);
  }
  if (m.errors.length) {
    console.log("");
    console.log("运行异常：");
    for (const e of m.errors) console.log(`  ${e}`);
  }
}

/**
 * 拒答门槛口径 A（2026-11-24 用户选 A）：有基线时「不低于基线 −5pp」，基线缺失（或旧基线无该字段）时回落绝对值 ≥0.50。
 * 用相对口径是因为库增长时 absent 题越来越难自然判空，绝对值会在没有退化的情况下假阻断。
 */
function refusalGate(baseline: Baseline | null): { min: number; label: string } {
  if (baseline && Number.isFinite(baseline.refusal_accuracy))
    return {
      min: baseline.refusal_accuracy - GATE_REFUSAL_DROP,
      label: `≥${(baseline.refusal_accuracy - GATE_REFUSAL_DROP).toFixed(4)}（基线 ${baseline.refusal_accuracy.toFixed(4)} −${(GATE_REFUSAL_DROP * 100).toFixed(0)}pp）`,
    };
  return { min: MIN_REFUSAL, label: `≥${MIN_REFUSAL.toFixed(4)}（无基线，绝对值）` };
}

function refusalPass(m: Metrics, gate: { min: number }): boolean {
  return m.absentQuestions > 0 && m.refusal >= gate.min;
}

function printSelfCheck(m: Metrics, baseline: Baseline | null): boolean {
  const gate = refusalGate(baseline);
  const checks = [
    { name: `Recall@3 ≥ ${MIN_RECALL3.toFixed(2)}`, ok: m.recall3 >= MIN_RECALL3, detail: `实际 ${fmt(m.recall3)}` },
    {
      name: `absent 判空率 ${gate.label}`,
      ok: refusalPass(m, gate),
      detail: `实际 ${fmt(m.refusal)}（${Math.round(m.refusal * m.absentQuestions)}/${m.absentQuestions}）`,
    },
    {
      name: `${m.questions} 题全部跑完无异常`,
      ok: m.errors.length === 0 && m.processed === m.questions,
      detail: `跑完 ${m.processed}/${m.questions}，异常 ${m.errors.length}`,
    },
  ];
  console.log("\n=== 自检 ===");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}（${c.detail}）`);
  return checks.every((c) => c.ok);
}

function readBaseline(file: string): Baseline | null {
  if (!fs.existsSync(file)) return null;
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`baseline.json 无法解析（${(e as Error).message}）；修复或删除后重跑`);
  }
  if (!Number.isFinite(Number(raw?.recall_at_3))) throw new Error(`${file} 缺 recall_at_3；用 --update-baseline 重新生成`);
  return {
    generated_at: String(raw.generated_at ?? ""),
    git_head: String(raw.git_head ?? "unknown"),
    entry_count: Number(raw.entry_count ?? 0),
    question_count: Number(raw.question_count ?? 0),
    recall_at_3: Number(raw.recall_at_3),
    recall_at_5: Number(raw.recall_at_5 ?? 0),
    mrr_at_3: Number(raw.mrr_at_3 ?? 0),
    // 旧基线可能没这个字段：留 NaN，让拒答门槛回落到绝对值（不能白送 −5pp）
    refusal_accuracy: raw.refusal_accuracy == null ? Number.NaN : Number(raw.refusal_accuracy),
    brief_chars_mean: Number(raw.brief_chars_mean ?? 0),
  };
}


// ---------- 抽取决策回放（--extract）：只测 解析 → 归一 → 冲突分流 这一层，不联网 ----------

const EXTRACT_FIELDS = ["accepted", "self_ref", "duplicate", "invalid", "conflicts", "auto_fact"] as const;
type ExtractField = (typeof EXTRACT_FIELDS)[number];

type ExtractGoldCase = {
  id: string;
  family: string;
  text: string;
  model_out: string;
  existing_hint: string | null;
  expect: {
    accepted: Array<{ kind: string; subject: string }>;
    counts: { self_ref: number; duplicate: number; invalid: number };
    conflicts: number;
    auto_fact: number;
  };
};

type ExtractObserved = {
  accepted: Array<{ kind: string; subject: string }>;
  counts: { self_ref: number; duplicate: number; invalid: number };
  conflicts: number;
  auto_fact: number;
  creates: number;
  modelCandidates: number;
  parseFailed: boolean;
  parseCode: "empty-response" | "no-json" | "parse-failed" | null;
  skipped: Array<{ reason: string; kind: string; subject: string }>;
  decisions: Array<{ kind: string; subject: string; verdict: "create" | "conflict" }>;
};

/** 回放只依赖这三条纯函数；类型从 extract.ts 取，避免把函数签名抄成 Function */
type ExtractPure = {
  parseExtractionOutput(out: string): ParsedExtraction;
  normalizeExtractionItems(value: unknown): NormalizedExtraction;
  decideExtractionBatch(
    candidates: ExtractionCandidate[],
    findConflicting: (kind: string, subject: string, body: string) => boolean,
  ): ExtractionDecision[];
};

type ExtractCaseResult = {
  gold: ExtractGoldCase;
  observed: ExtractObserved;
  mismatches: string[];
  fieldHits: Record<ExtractField, boolean>;
  elapsedMs: number;
};

/** 抽取值是 JSONL，不是数组包：逐行校验结构，坏行带 文件:行号 直接报错 */
function loadExtractGold(file: string): ExtractGoldCase[] {
  if (!fs.existsSync(file)) throw new Error(`抽取夹具不存在：${file}`);
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const ids = new Set<string>();
  return lines.map((line, i) => {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`${file}:${i + 1} JSON 解析失败：${(e as Error).message}`);
    }
    const id = String(row?.id ?? "");
    if (!id) throw new Error(`${file}:${i + 1} 缺 id`);
    if (ids.has(id)) throw new Error(`${file}:${i + 1}（${id}）id 重复`);
    ids.add(id);
    const family = String(row?.family ?? "");
    if (!(EXTRACT_FAMILIES as readonly string[]).includes(family))
      throw new Error(`${file}:${i + 1}（${id}）未知 family：${family}`);
    const text = String(row?.text ?? "");
    if (!text) throw new Error(`${file}:${i + 1}（${id}）text 不能为空`);
    if (typeof row?.model_out !== "string") throw new Error(`${file}:${i + 1}（${id}）model_out 必须是字符串`);
    const existing_hint = row?.existing_hint == null ? null : String(row.existing_hint);
    const rawExpect = row?.expect;
    if (!rawExpect || !Array.isArray(rawExpect.accepted)) throw new Error(`${file}:${i + 1}（${id}）expect.accepted 必须是数组`);
    const accepted = rawExpect.accepted.map((x: any) => ({ kind: String(x?.kind ?? ""), subject: String(x?.subject ?? "") }));
    if (accepted.some((x: { kind: string; subject: string }) => !x.kind || !x.subject))
      throw new Error(`${file}:${i + 1}（${id}）expect.accepted 每项都要有 kind/subject`);
    const counts = {
      self_ref: Number(rawExpect?.counts?.self_ref),
      duplicate: Number(rawExpect?.counts?.duplicate),
      invalid: Number(rawExpect?.counts?.invalid),
    };
    if (!Object.values(counts).every((n) => Number.isInteger(n) && n >= 0))
      throw new Error(`${file}:${i + 1}（${id}）expect.counts 必须是非负整数`);
    const conflicts = Number(rawExpect?.conflicts);
    const auto_fact = Number(rawExpect?.auto_fact);
    if (!Number.isInteger(conflicts) || conflicts < 0 || !Number.isInteger(auto_fact) || auto_fact < 0)
      throw new Error(`${file}:${i + 1}（${id}）expect.conflicts / auto_fact 必须是非负整数`);
    return { id, family, text, model_out: row.model_out, existing_hint, expect: { accepted, counts, conflicts, auto_fact } };
  });
}

const acceptedKey = (p: { kind: string; subject: string }) => `${p.kind}/${p.subject}`;
const sortedAccepted = (list: Array<{ kind: string; subject: string }>) => list.map(acceptedKey).sort();
const sameAccepted = (a: Array<{ kind: string; subject: string }>, b: Array<{ kind: string; subject: string }>) =>
  JSON.stringify(sortedAccepted(a)) === JSON.stringify(sortedAccepted(b));
const fmtAccepted = (list: Array<{ kind: string; subject: string }>) =>
  list.length ? `[${sortedAccepted(list).join(", ")}]` : "[]";

/** 只跑 解析 → 归一 → 决策 三段纯函数；findConflicting 注入快照库的只读查询 */
function runExtractCase(
  gold: ExtractGoldCase,
  entryStore: { findConflicting(kind: string, subject: string, body: string): unknown },
  extractMod: ExtractPure,
  autoFactable: (kind: string, conf: number, impact?: string) => boolean,
): ExtractCaseResult {
  const t0 = performance.now();
  const observed: ExtractObserved = {
    accepted: [],
    counts: { self_ref: 0, duplicate: 0, invalid: 0 },
    conflicts: 0,
    auto_fact: 0,
    creates: 0,
    modelCandidates: 0,
    parseFailed: false,
    parseCode: null,
    skipped: [],
    decisions: [],
  };
  const parsed = extractMod.parseExtractionOutput(gold.model_out);
  if (!parsed.ok) {
    observed.parseFailed = true;
    observed.parseCode = parsed.code;
  } else {
    observed.modelCandidates = Array.isArray(parsed.value) ? parsed.value.length : 0;
    const normalized = extractMod.normalizeExtractionItems(parsed.value);
    observed.skipped = normalized.skipped;
    for (const s of normalized.skipped) {
      if (s.reason === "self-ref") observed.counts.self_ref++;
      else if (s.reason === "duplicate") observed.counts.duplicate++;
      else observed.counts.invalid++;
    }
    const decisions = extractMod.decideExtractionBatch(
      normalized.candidates,
      (kind: string, subject: string, body: string) => entryStore.findConflicting(kind, subject, body) !== null,
    );
    for (const d of decisions) {
      observed.decisions.push({ kind: d.candidate.kind, subject: d.candidate.subject, verdict: d.verdict });
      if (d.verdict === "conflict") {
        observed.conflicts++;
        continue;
      }
      observed.creates++;
      observed.accepted.push({ kind: d.candidate.kind, subject: d.candidate.subject });
      if (autoFactable(d.candidate.kind, d.candidate.confidence, "advice-only")) observed.auto_fact++;
    }
  }
  const elapsedMs = performance.now() - t0;

  const fieldHits: Record<ExtractField, boolean> = {
    accepted: sameAccepted(gold.expect.accepted, observed.accepted),
    self_ref: observed.counts.self_ref === gold.expect.counts.self_ref,
    duplicate: observed.counts.duplicate === gold.expect.counts.duplicate,
    invalid: observed.counts.invalid === gold.expect.counts.invalid,
    conflicts: observed.conflicts === gold.expect.conflicts,
    auto_fact: observed.auto_fact === gold.expect.auto_fact,
  };
  const mismatches: string[] = [];
  if (!fieldHits.accepted) mismatches.push(`accepted 期望 ${fmtAccepted(gold.expect.accepted)} / 实际 ${fmtAccepted(observed.accepted)}`);
  if (!fieldHits.self_ref) mismatches.push(`self_ref 期望 ${gold.expect.counts.self_ref} / 实际 ${observed.counts.self_ref}`);
  if (!fieldHits.duplicate) mismatches.push(`duplicate 期望 ${gold.expect.counts.duplicate} / 实际 ${observed.counts.duplicate}`);
  if (!fieldHits.invalid) mismatches.push(`invalid 期望 ${gold.expect.counts.invalid} / 实际 ${observed.counts.invalid}`);
  if (!fieldHits.conflicts) mismatches.push(`conflicts 期望 ${gold.expect.conflicts} / 实际 ${observed.conflicts}`);
  if (!fieldHits.auto_fact) mismatches.push(`auto_fact 期望 ${gold.expect.auto_fact} / 实际 ${observed.auto_fact}`);
  return { gold, observed, mismatches, fieldHits, elapsedMs };
}

/** 失败时的定位提示：字段 → 哪条纯函数/哪道闸门 */
function locateExtractField(field: ExtractField): string {
  switch (field) {
    case "accepted":
      return "先看下方 skip 实况（normalizeExtractionItems 的字段/自指/重复/配额闸门），再看 conflict 分流（decideExtractionBatch）";
    case "self_ref":
      return "normalizeExtractionItems → isPluginInternal(subject)";
    case "duplicate":
      return "normalizeExtractionItems → 同批 kind+subject+body 精确比对";
    case "invalid":
      return "normalizeExtractionItems → KINDS / subject / body 闸门";
    case "conflicts":
      return "decideExtractionBatch → entryStore.findConflicting（核对 existing_hint）";
    case "auto_fact":
      return 'autoFactable(kind, confidence, "advice-only")（默认门槛 0.85；relation 不自动转事实）';
  }
}

/** 墙钟分档：六项指标要能连跑两次逐字相同，精确毫秒只放在指标段外的参考行 */
function latencyBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms/案";
  if (ms < 1) return "<1 ms/案";
  if (ms < 10) return "<10 ms/案";
  if (ms < 100) return "<100 ms/案";
  return "≥100 ms/案";
}

function printExtractReport(
  results: ExtractCaseResult[],
  ctx: { origin: string; entryCount: number; hintTotal: number; hintFound: number; hintMissing: string[] },
) {
  const n = results.length;
  const fullHits = results.filter((r) => r.mismatches.length === 0).length;
  const fieldHits = EXTRACT_FIELDS.reduce(
    (acc, f) => {
      acc[f] = results.filter((r) => r.fieldHits[f]).length;
      return acc;
    },
    {} as Record<ExtractField, number>,
  );
  const parseFailures = results.filter((r) => r.observed.parseFailed).length;
  const parseCodes = ["empty-response", "no-json", "parse-failed"].map(
    (code) => `${code} ${results.filter((r) => r.observed.parseCode === code).length}`,
  );
  const modelCandidates = results.reduce((s, r) => s + r.observed.modelCandidates, 0);
  const selfRefs = results.reduce((s, r) => s + r.observed.counts.self_ref, 0);
  const duplicates = results.reduce((s, r) => s + r.observed.counts.duplicate, 0);
  const creates = results.reduce((s, r) => s + r.observed.creates, 0);
  const autoFacts = results.reduce((s, r) => s + r.observed.auto_fact, 0);
  const totalMs = results.reduce((s, r) => s + r.elapsedMs, 0);
  const meanMs = n ? totalMs / n : 0;

  console.log("\n=== pi-living-memory 抽取决策回放 ===");
  console.log(`fixtures：${path.relative(ROOT, EXTRACT_GOLD_FILE)} · ${n} 案（${EXTRACT_FAMILIES.length} 类） · 记忆库：${ctx.origin}（快照条目 ${ctx.entryCount}）`);
  console.log("口径：录制回放，不联网；model_out 为固化录制样本，非本轮模型调用。报告型指标，不进发布门禁。");
  console.log(`existing_hint：${ctx.hintFound}/${ctx.hintTotal} 命中快照库${ctx.hintMissing.length ? `（缺失：${ctx.hintMissing.join(", ")}）` : ""}`);
  console.log("");
  console.log("指标");
  console.log(`  决策准确率       ${fmt(n ? fullHits / n : 0)}（${fullHits}/${n} 逐案全字段命中）`);
  console.log(`  字段级           ${EXTRACT_FIELDS.map((f) => `${f} ${fmt(n ? fieldHits[f] / n : 0)}`).join(" · ")}`);
  console.log(`  解析失败率       ${fmt(n ? parseFailures / n : 0)}（${parseFailures}/${n}）`);
  console.log(`  解析失败构成     ${parseCodes.join(" · ")}（三种解析分支的案数）`);
  console.log(`  自指噪声率       ${fmt(modelCandidates ? selfRefs / modelCandidates : 0)}（${selfRefs}/${modelCandidates} 个模型候选）`);
  console.log(`  重复率           ${fmt(modelCandidates ? duplicates / modelCandidates : 0)}（${duplicates}/${modelCandidates}）`);
  console.log(`  待确认占比       ${fmt(creates ? (creates - autoFacts) / creates : 0)}（${creates - autoFacts}/${creates} 条 create 未达 auto-fact）`);
  console.log(`  平均耗时         ${latencyBucket(meanMs)}（分档口径，保证六项指标可逐字复现）`);

  console.log("\n按 family");
  console.log("  family                  n   全字段命中  解析失败");
  for (const f of EXTRACT_FAMILIES) {
    const rows = results.filter((r) => r.gold.family === f);
    if (!rows.length) continue;
    const ok = rows.filter((r) => r.mismatches.length === 0).length;
    const pf = rows.filter((r) => r.observed.parseFailed).length;
    console.log(`  ${f.padEnd(22)} ${String(rows.length).padStart(3)}   ${String(ok).padStart(3)}/${rows.length}       ${pf}`);
  }

  console.log(
    `\n墙钟参考（非指标）：总 ${totalMs.toFixed(2)} ms / ${n} 案 = ${meanMs.toFixed(3)} ms/案（每次运行会浮动，不参与确定性对比）`,
  );

  const bad = results.filter((r) => r.mismatches.length);
  console.log(`\n逐案失败（${bad.length || "无"}）`);
  for (const r of bad) {
    console.log(`  ${r.gold.id} [${r.gold.family}]`);
    for (const m of r.mismatches) console.log(`    ${m}`);
    console.log(
      `    skip 实况：${r.observed.skipped.length ? r.observed.skipped.map((s) => `${s.reason}(${s.kind}/${s.subject})`).join("、") : "无"}`,
    );
    console.log(
      `    决策实况：${r.observed.decisions.length ? r.observed.decisions.map((d) => `${d.verdict}(${d.kind}/${d.subject})`).join("、") : "无"}`,
    );
    const badFields = EXTRACT_FIELDS.filter((f) => !r.fieldHits[f]);
    console.log(`    定位：${badFields.map((f) => `${f} → ${locateExtractField(f)}`).join("；")}`);
  }
}

function printExtractSelfCheck(processed: number, total: number, errors: string[]): boolean {
  const ok = errors.length === 0 && processed === total;
  console.log("\n=== 自检 ===");
  console.log(`${ok ? "PASS" : "FAIL"} ${total} 案全部跑完无异常（跑完 ${processed}/${total}，异常 ${errors.length}）`);
  console.log("（抽取回放为报告型指标，不进发布门禁；发布门禁只覆盖召回与拒答）");
  if (errors.length) {
    console.log("异常：");
    for (const e of errors) console.log(`  ${e}`);
  }
  return ok;
}

async function runExtractBenchmark(memoryDir: string) {
  const gold = loadExtractGold(EXTRACT_GOLD_FILE);
  const { home, origin } = snapshotMemory(memoryDir);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const restoreHomedir = useSnapshotHome(home);
  try {
    const [{ entryStore }, extractMod, { autoFactable }] = await Promise.all([
      import("../extensions/src/stores/entry-store"),
      import("../extensions/src/extract"),
      import("../extensions/src/ops"),
    ]);
    const ids = new Set(entryStore.list().map((r) => r.id));
    const hints = gold.map((g) => g.existing_hint).filter((x): x is string => !!x);
    const hintMissing = hints.filter((id) => !ids.has(id));
    const results: ExtractCaseResult[] = [];
    const errors: string[] = [];
    let processed = 0;
    for (const g of gold) {
      processed++;
      try {
        results.push(runExtractCase(g, entryStore, extractMod, autoFactable));
      } catch (e: any) {
        errors.push(`${g.id}: ${e?.message ?? String(e)}`);
      }
    }
    printExtractReport(results, {
      origin,
      entryCount: entryStore.list().length,
      hintTotal: hints.length,
      hintFound: hints.length - hintMissing.length,
      hintMissing,
    });
    const ok = printExtractSelfCheck(processed, gold.length, errors);
    process.exitCode = ok ? 0 : 1;
  } finally {
    restoreHomedir();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const { memory, baseline: baselineFile, updateBaseline, extract, extractLive } = parseArgs(process.argv.slice(2));
  if (extractLive) {
    console.log(
      "--extract-live：不联网。模型侧漂移需在 pi 会话内按线上抽取器录制回包，再与本目录 fixtures 人工比对；脚本不做任何网络调用。",
    );
    process.exitCode = 0;
    return;
  }
  if (extract) {
    await runExtractBenchmark(memory);
    return;
  }
  const questions = loadQuestions(QUESTIONS_FILE);
  const { home, origin } = snapshotMemory(memory);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const restoreHomedir = useSnapshotHome(home);
  try {
    const [{ entryStore }, { RECALL_STATUS, rankRecall }, { inScope }, { buildBrief }] = await Promise.all([
      import("../extensions/src/stores/entry-store"),
      import("../extensions/src/recall"),
      import("../extensions/src/scope"),
      import("../extensions/src/brief"),
    ]);

    const rows: EntryIndex[] = entryStore.list();
    const byCat: Record<string, CatStat> = {};
    for (const c of CATS) byCat[c] = { n: 0, recall3: 0, recall5: 0, mrr3: 0, absent: 0, refused: 0 };
    let goldQuestions = 0;
    let absentQuestions = 0;
    let sum3 = 0;
    let sum5 = 0;
    let sumMrr = 0;
    let processed = 0;
    const latencyMs: number[] = [];
    const briefChars: number[] = [];
    const absentMisses: Array<{ id: string; hits: string[] }> = [];
    const errors: string[] = [];

    const rcharBefore = readRchar();
    for (const q of questions) {
      processed++;
      try {
        const t0 = performance.now();
        const corpus = rows.filter((r) => RECALL_STATUS.has(r.meta.status ?? "") && inScope(r, cwdFor(q.scope)));
        const hits = rankRecall(q.q, corpus, undefined, K5);
        latencyMs.push(performance.now() - t0);
        briefChars.push(buildBrief(undefined, q.q).length);
        const top3 = hits.slice(0, K3);
        const cat = byCat[q.cat];
        cat.n++;
        if (!q.gold.length) {
          cat.absent++;
          absentQuestions++;
          if (hits.length === 0) cat.refused++;
          else absentMisses.push({ id: q.id, hits: hits.map((h) => h.id) });
        } else {
          goldQuestions++;
          const r3 = coverage(q.gold, top3);
          const r5 = coverage(q.gold, hits);
          const rank = top3.findIndex((h) => q.gold.includes(h.id));
          const rr = rank >= 0 ? 1 / (rank + 1) : 0;
          cat.recall3 += r3;
          cat.recall5 += r5;
          cat.mrr3 += rr;
          sum3 += r3;
          sum5 += r5;
          sumMrr += rr;
        }
      } catch (e) {
        errors.push(`${q.id}: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    const rcharAfter = readRchar();
    const rcharBytes = rcharBefore !== null && rcharAfter !== null ? rcharAfter - rcharBefore : null;

    const m: Metrics = {
      questions: questions.length,
      processed,
      goldQuestions,
      absentQuestions,
      recall3: goldQuestions ? sum3 / goldQuestions : 0,
      recall5: goldQuestions ? sum5 / goldQuestions : 0,
      mrr3: goldQuestions ? sumMrr / goldQuestions : 0,
      refusal: absentQuestions ? (absentQuestions - absentMisses.length) / absentQuestions : 0,
      latencyMs,
      briefChars,
      byCat,
      absentMisses,
      errors,
    };
    // 拒答准确率：absent 全空（严格判空）才算对，非空即错
    m.refusal = absentQuestions ? (absentQuestions - absentMisses.length) / absentQuestions : 0;

    // 自检的拒答门槛要用基线（口径 A），门禁段复用同一份，避免读两遍
    let baseline: Baseline | null = null;
    if (updateBaseline) {
      try {
        baseline = readBaseline(baselineFile);
      } catch {
        // 旧基线坏掉时仍允许 --update-baseline 重生成：退回绝对值门槛
        baseline = null;
      }
    } else {
      baseline = readBaseline(baselineFile);
    }

    printReport(m, { origin, entryCount: rows.length, rcharBytes });
    const selfOk = printSelfCheck(m, baseline);

    let gateOk = true;
    if (updateBaseline) {
      if (!selfOk) {
        console.log("\n=== 基线门禁 ===\n自检 FAIL，未写入 baseline.json");
        gateOk = false;
      } else {
        const baseline: Baseline = {
          generated_at: new Date().toISOString(),
          git_head: gitHead(),
          entry_count: rows.length,
          question_count: questions.length,
          recall_at_3: m.recall3,
          recall_at_5: m.recall5,
          mrr_at_3: m.mrr3,
          refusal_accuracy: m.refusal,
          brief_chars_mean: m.briefChars.reduce((s, n) => s + n, 0) / Math.max(1, questions.length),
        };
        fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
        console.log(`\n=== 基线门禁 ===\n已写入 ${BASELINE_FILE}（HEAD ${baseline.git_head} · ${baseline.entry_count} 条 · Recall@3 ${fmt(baseline.recall_at_3)}）`);
      }
    } else {
      console.log("\n=== 基线门禁 ===");
      if (!baseline) {
        console.log("baseline 缺失，跳过门禁（用 --update-baseline 生成）");
      } else {
        const gate = refusalGate(baseline);
        console.log(
          `baseline：${baseline.generated_at || "(无时间)"} · HEAD ${baseline.git_head} · ${baseline.entry_count} 条 · Recall@3 ${fmt(baseline.recall_at_3)} · 文件 ${baselineFile === BASELINE_FILE ? path.relative(ROOT, BASELINE_FILE) : baselineFile}`,
        );
        console.log(`拒答门槛 ${gate.label}：实际 ${fmt(m.refusal)} → ${refusalPass(m, gate) ? "PASS" : "FAIL（自检已判）"}`);
        if (baseline.recall_at_3 <= 0) {
          console.log("基线 Recall@3 非正，无法计算相对退化，跳过门禁");
        } else {
          const drop = (baseline.recall_at_3 - m.recall3) / baseline.recall_at_3;
          if (drop > GATE_RELATIVE_DROP) {
            gateOk = false;
            console.log(
              `BASELINE REGRESSION：Recall@3 ${fmt(baseline.recall_at_3)} → ${fmt(m.recall3)}，相对退化 ${(drop * 100).toFixed(2)}% > ${(GATE_RELATIVE_DROP * 100).toFixed(0)}%`,
            );
          } else {
            console.log(
              `Recall@3 ${fmt(baseline.recall_at_3)} → ${fmt(m.recall3)}，相对退化 ${(Math.max(0, drop) * 100).toFixed(2)}%（阈值 ${(GATE_RELATIVE_DROP * 100).toFixed(0)}%）→ PASS`,
            );
          }
        }
      }
    }

    console.log(`\n结论：${selfOk && gateOk ? "PASS" : "FAIL"}（自检 ${selfOk ? "全过" : "有 FAIL"}${updateBaseline ? " · 已尝试更新基线" : " · 门禁" + (gateOk ? "通过" : "阻断")}）`);
    process.exitCode = selfOk && gateOk ? 0 : 1;
  } finally {
    restoreHomedir();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((e: any) => {
  console.error(`基准运行失败：${e?.message ?? e}`);
  process.exitCode = 1;
});
