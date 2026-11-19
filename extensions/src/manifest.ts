/**
 * frontmatter 解析与 manifest 校验：纯函数 + 单文件读（读发生在调用时，模块顶层不碰 IO）。
 * STORE/ENTRIES_DIR 等路径常量留在主文件，所以这里不做路径归一化——调用方传已算好的库内相对 label。
 */
import * as fs from "node:fs";
import { tokensOf } from "./text";

export type Meta = Record<string, string>;
export type Entry = { meta: Meta; body: string };

/** manifest 校验结果：file 用库内相对路径（entries/x.md），便于 lint 直接展示 */
export interface ManifestIssue {
  file: string;
  id?: string;
  field: string;
  problem: string;
  severity: "error" | "warn";
}

export const KINDS = ["preference", "constraint", "commitment", "relation", "correction", "decision", "outcome"] as const;
export const ACTIVE = new Set(["explicit", "event", "inference", "confirmed"]);
/** 全量合法 status（ACTIVE 是其中参与简报/召回的子集） */
export const KNOWN_STATUSES = new Set(["explicit", "event", "inference", "confirmed", "superseded", "expired"]);
export const ACTION_IMPACTS = new Set(["advice-only", "reminder", "needs-confirm"]);
export const SCOPE_TOKEN_RE = /^(global|workspace:[a-z0-9._-]+|project:[a-z0-9._-]+)$/i;

/** 索引行：frontmatter 裁剪字段 + 标题 + 词元（store 与召回共用，只依赖 manifest 与 text） */
export type EntryIndex = { id: string; meta: Meta; title: string; toks: string[] };

const DATE_FIELDS = ["obtained_at", "confirmed_at", "expires_at", "review_after"] as const;

/** 纯解析（不做字段校验）：frontmatter 失败时 entry=null 并给出原因，交给 parseEntryWithIssues 转成 issue */
export function readEntryFile(file: string): { entry: Entry | null; failure: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { entry: null, failure: "文件无法读取" };
  }
  if (!text.startsWith("---\n")) return { entry: null, failure: "缺少 frontmatter（文件未以 --- 开头）" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { entry: null, failure: "frontmatter 未闭合（找不到 --- 分隔行）" };
  const meta: Meta = {};
  for (const line of text.slice(4, end).split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) meta[line.slice(0, i)] = line.slice(i + 2);
    else {
      const j = line.indexOf(":");
      if (j > 0) meta[line.slice(0, j)] = line.slice(j + 1);
    }
  }
  return { entry: { meta, body: text.slice(end + 5).trim() }, failure: "" };
}

export function parseEntry(file: string): Entry | null {
  return readEntryFile(file).entry;
}

/**
 * 解析条目并同时产出 manifest 问题：读路径仍返回 null（坏条目照现状跳过），但不再静默。
 * 无 frontmatter / 未闭合两类解析失败会给 field=frontmatter 的 error；解析成功则附带字段级校验结果。
 * label 是库内相对路径（manifestFileLabel 由主文件算，路径常量不搬）。
 */
export function parseEntryWithIssues(file: string, label: string): { entry: Entry | null; issues: ManifestIssue[] } {
  const { entry, failure } = readEntryFile(file);
  if (!entry) return { entry: null, issues: [{ file: label, field: "frontmatter", problem: failure, severity: "error" }] };
  return { entry, issues: validateManifest(entry.meta, { file: label }) };
}

/**
 * 纯函数、无 IO：只校验 frontmatter 字段本身。
 * error = 字段值会让条目落进错误语义（丢索引、永进不了简报、NaN 排序、写进错误 scope 层），写入时必须拒；
 * warn = 现状可运行但可疑（scope 为空读路径按 global 处理，不算坏数据）。
 * 可选字段缺失一律不报（supersedes/evidence/source 等本就可空）。
 * opts.file 是展示用 label；缺省时按 entries/<id>.md 生成（与 STORE 下的相对路径同形）。
 */
export function validateManifest(meta: Meta, opts: { file?: string; requireId?: boolean } = {}): ManifestIssue[] {
  const file = opts.file ?? (meta.id ? `entries/${meta.id}.md` : "");
  const requireId = opts.requireId ?? true;
  const issues: ManifestIssue[] = [];
  const add = (field: string, problem: string, severity: ManifestIssue["severity"]) =>
    issues.push({ file, id: meta.id || undefined, field, problem, severity });

  const id = (meta.id ?? "").trim();
  if (!id) {
    if (requireId) add("id", "缺少 id / id 为空（条目无法定位、索引与生命周期操作都会失去锚点）", "error");
  }
  const kind = (meta.kind ?? "").trim();
  if (!(KINDS as readonly string[]).includes(kind))
    add("kind", `kind="${kind}" 不在允许集合（${KINDS.join("/")}）；读路径会被各类筛选静默漏掉`, "error");
  const status = (meta.status ?? "").trim();
  if (!KNOWN_STATUSES.has(status))
    add("status", `status="${status}" 不在合法集合（${[...KNOWN_STATUSES].join("/")}）；错拼会让条目永远进不了简报`, "error");

  for (const field of DATE_FIELDS) {
    const v = (meta[field] ?? "").trim();
    // expires_at / review_after / confirmed_at 为空是合法现状（推断条目本来就没有确认日）
    if (v && Number.isNaN(Date.parse(v))) add(field, `日期无法解析："${v}"（空值合法，非空必须是可解析的日期）`, "error");
  }

  const scope = (meta.scope ?? "").trim();
  if (!scope) add("scope", "scope 为空（读路径按 global 处理，写入时应显式给出）", "warn");
  else {
    const bad = scope
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !SCOPE_TOKEN_RE.test(t));
    if (bad.length)
      add("scope", `非法 scope 值：${bad.join("、")}（只接受 global / workspace:<名> / project:<名>，多值用逗号）`, "error");
  }

  const impact = (meta.action_impact ?? "").trim();
  if (impact && !ACTION_IMPACTS.has(impact))
    add("action_impact", `action_impact="${impact}" 不在 advice-only / reminder / needs-confirm 内`, "error");
  const conf = (meta.confidence ?? "").trim();
  if (conf) {
    const n = Number(conf);
    if (!Number.isFinite(n) || n < 0 || n > 1) add("confidence", `confidence="${conf}" 不是 0-1 的数字`, "error");
  }

  return issues;
}

export function toIndexRow(meta: Meta, title: string): EntryIndex {
  const keep: Meta = {};
  for (const k of ["id", "kind", "status", "subject", "scope", "action_impact", "obtained_at", "expires_at", "review_after", "supersedes", "confidence"]) {
    if (meta[k]) keep[k] = meta[k];
  }
  // 词元由「subject + 标题」生成：召回只在索引行上算分，正文不参与（保留原空白/标点给 ASCII 整词用）
  return { id: meta.id, meta: keep, title, toks: tokensOf(`${meta.subject ?? ""} ${title}`) };
}
