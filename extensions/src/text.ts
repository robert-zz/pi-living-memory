/**
 * 纯文本工具：归一化、bigram 相似度、召回词元切分。
 * 只依赖注入层（词元白名单的初值来自 cfg.recall2L）；不 import store、不做 IO。
 */
import { cfg } from "./config";

/**
 * 2 字母 ASCII 白名单：`ai/ci/pr/ui/db/ss` 这类本是技术标识符，被 ≥3 的规则误杀会让「PR 评审」「CI 失败」
 * 这类提问召回不到。默认值可被 `LIVING_MEMORY_RECALL_2L` 覆盖/追加（逗号分隔，全小写）。
 */
export const ASCII_SHORT_OK = new Set(cfg.recall2L);
/**
 * 召回词元：索引与查询共用同一套切法，避免 BM25 只在一边成立。
 * 中文走 bigram：每个连续汉字段取所有相邻两字组合，单字段保留其本身。
 * ASCII 走整词：按空白/标点切成整词，只保留长度 ≥3 的（以及 2 字母白名单 `ASCII_SHORT_OK` 里的技术缩写），
 * `-A` 这类碎片与 `is/to` 这类功能词不进索引，不做子词或前缀匹配。入参保留原始空白与标点，词边界才不会在归一化时被抹掉。
 * 字典序去重后截断到 40 个，控制索引体积。
 */
export function tokensOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) if (m[0].length >= 3 || ASCII_SHORT_OK.has(m[0])) out.add(m[0]);
  for (const m of text.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length === 1) out.add(run);
    else for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].sort().slice(0, 40);
}

export function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** 同 subject+kind 且正文相似（包含或 bigram 重叠>0.6）才算冲突——不同偏好可共存 */
export function bodySimilar(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const grams = (t: string) => {
    const s = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
    return s;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  if (Math.min(gx.size, gy.size) < 8) return false; // 短句易误判：不足 8 个二元组只当不同
  return inter / (gx.size + gy.size - inter) > 0.5; // Jaccard：两段都要真的相似
}

export function normSubject(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s·・、，,。.:：;；/\-—_'"“”‘’《》<>()[\]{}!！?？]/g, "");
}

export function normBody(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[，,。.;；:：、"'“”‘’《》()（）]/g, "");
}

export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 负面偏好标记：这类条目在简报里优先，并打 [雷区] 标签 */
const NEGATION_RE = /(不要|别把|别再|禁止|不得|避免|切勿|勿|never|don'?t|avoid)/i;
export function isNegation(e: { meta: any; title?: string }): boolean {
  return NEGATION_RE.test(`${e.meta?.subject ?? ""} ${e.title ?? ""}`);
}

/** pi 消息 → 纯文本（content 可能是字符串或 text 块数组）；会话形状由宿主决定，不认的形状返回空串 */
export function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
  return "";
}
