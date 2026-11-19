/**
 * 按问题召回：索引行上的 BM25，命中后才由调用方读正文。
 * 纯计算：给定「候选索引行 + 查询」→ 排序后的 top 3。候选从哪来（entryStore.list + scope 过滤）归 ops，
 * 本模块不 import store、不做 IO。
 */
import { refreshConfig } from "./config";
import type { EntryIndex } from "./manifest";
import { tokensOf } from "./text";

/** 只有这些状态的条目能进召回；推断（inference）仍须人工确认，不直接当事实引用 */
export const RECALL_STATUS = new Set(["confirmed", "explicit", "event"]);
/** 高频词元闸门：中文词元 df/N 大于 5% 不参与打分（用户/域名/发布/英文这类常见词） */
const RECALL_STOP_DF = 0.05;
/** ASCII 整词判定（tokensOf 已小写）：豁免高频闸门，并独享单命中例外（见下方不对称说明） */
const RECALL_ASCII = /^[a-z0-9]+$/;
/** 条目少于 20 条时 df/N 没有统计意义（1 条就能占 10%），不启用高频词元闸门 */
const RECALL_STOP_MIN_DOCS = 20;
/** 单命中例外：只命中 1 个 ASCII 整词且 idf ≥ 3.5（staging/tauri 这类专名）才放行 */
const RECALL_SINGLE_IDF = 3.5;

/**
 * 召回第一阶段：只在索引行（meta.subject/title/toks）上算 BM25，绝不读 entries 正文。
 * 第二阶段由命中 id 的调用方按需 parseEntry；本函数只回 top 3 的 id/subject/title/score。
 *
 * 中文与 ASCII 两套规则为什么不对称：中文 bigram 切不出「专名」，域名/自己/岗位 这类通用词
 * 在 N=85 时 idf 也能到 3.5+，单命中放行几乎全是假阳性（「域名在哪里注册」召回 FoxyProxy 规则）；
 * 所以中文词元一律按 df/N > 5% 过滤，且不享受单命中例外。ASCII 整词是技术标识符
 * （npm/2fa/staging/tauri），出现频率高也仍有区分度，因此豁免高频闸门，并独享 idf ≥ 3.5 的单命中例外。
 */
export function rankRecall(
  query: string,
  corpus: EntryIndex[],
  excludeIds?: Set<string>,
): Array<{ id: string; subject: string; title: string; score: number }> {
  const q = String(query ?? "").trim().slice(0, 200);
  const qToks = tokensOf(q);
  if (!q || !qToks.length) return [];
  const configured = refreshConfig().recallMaxRows;
  const maxRows = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20000;
  // 语料口径由调用方给（状态/scope 合格的全部条目）；excludeIds（简报已展示）只影响输出，不参与 df/N 统计，
  // 否则简报抽走几十条会把 df 压到 1，idf 虚高到 3.9，单命中例外就会放行通用词
  // 硬上限：行数超限时只取索引前 maxRows 行（索引按 id 倒序，即优先较新条目）
  const degraded = corpus.length > maxRows;
  const rows = degraded ? corpus.slice(0, maxRows) : corpus;
  if (!rows.length) return [];
  const docs = rows.map((row) => {
    // 退化路径：超上限时只认 subject 词元（标题词元不参与），避免长尾行把打分拖慢
    const toks = degraded ? tokensOf(row.meta.subject ?? "") : Array.isArray(row.toks) ? row.toks : [];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { row, tf, dl: toks.length, sub: new Set(tokensOf(row.meta.subject ?? "")) };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of qToks) if (d.tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  // 高频词元不参与打分：df/N > 5% 的中文词（用户/域名/发布/英文）区分度太低，留着只会把无关条目顶上来；
  // ASCII 整词豁免（npm/2fa 在本库出现 >5% 但仍是技术标识符，过滤掉会把正确的 npm 条目一起弄丢）。
  // 库里条目太少时比例没有统计意义（1 条就能占 10%），此时不过滤，交给下面的最少命中闸门。
  const active =
    N >= RECALL_STOP_MIN_DOCS
      ? qToks.filter((t) => RECALL_ASCII.test(t) || (df.get(t) ?? 0) / N <= RECALL_STOP_DF)
      : qToks;
  if (!active.length) return [];
  const avgdl = Math.max(1, docs.reduce((sum, d) => sum + d.dl, 0) / N);
  const k1 = 1.2;
  const b = 0.75;
  const activeSet = new Set(active);
  const scored = docs
    .filter((d) => !excludeIds?.has(d.row.id))
    .map((d) => {
      let score = 0;
      let hits = 0;
      let maxIdf = 0;
      let subHit = false;
      let singleAscii = false;
      // 命中数只数参与打分的词元：被高频闸门过滤的「英文」不算命中，否则它会替无关条目凑够 2 个
      for (const t of qToks) {
        const tf = d.tf.get(t);
        if (!tf || !activeSet.has(t)) continue;
        hits++;
        singleAscii = RECALL_ASCII.test(t);
        const dfi = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
        maxIdf = Math.max(maxIdf, idf);
        const weight = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.dl) / avgdl));
        // subject 命中 ×3：索引行不另存 subject 专属 toks，命中时从 meta.subject 重切一次比对
        score += idf * weight * (d.sub.has(t) ? 3 : 1);
        if (d.sub.has(t)) subHit = true;
      }
      return { id: d.row.id, subject: d.row.meta.subject ?? "", title: d.row.title ?? "", score, hits, maxIdf, subHit, singleAscii };
    })
    // 最少命中：2 个不同词元；或 1 个 ASCII 专名且 idf ≥ 3.5（中文单命中一律不放行）
    .filter((x) => x.score > 0 && (x.hits >= 2 || (x.hits === 1 && x.singleAscii && x.maxIdf >= RECALL_SINGLE_IDF)));
  scored.sort((a, b2) => b2.score - a.score || Number(b2.subHit) - Number(a.subHit) || (a.id < b2.id ? 1 : -1));
  return scored.slice(0, 3);
}
