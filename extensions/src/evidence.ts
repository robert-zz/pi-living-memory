/**
 * 证据与转正：自动事实门槛、证据累积、复合分评分、风格归纳扫描、自动按事实（A 追溯 / B 证据）。
 * 依赖 config / paths / manifest / text / entry-store；转正要改状态，故复用 lifecycle 的 opConfirm。
 * 只读扫描也只在调用时读盘，模块顶层不做 IO。
 */

import * as fs from "node:fs";

import { cfg, clock, logger, refreshConfig } from "./config";
import type { Entry, Meta } from "./manifest";
import { PROFILE_STYLE_STAMP, isPaused } from "./paths";
import { isNegation } from "./text";
import { entryStore } from "./stores/entry-store";
import { opConfirm } from "./lifecycle";

/** 推断自动按事实处理的置信度门槛：>= 即直接 confirmed；低于门槛仍只作弱参考（「待确认」档） */
export const AUTO_FACT_CONF = () => refreshConfig().autoFactConf; // 原先每次调用读 env，故这里也重读（注入值仍生效）
/** 自动转事实的排除面：关系类与 needs-confirm 仍需人工点头（错判代价不对称） */
export const autoFactable = (kind: string, conf: number, impact?: string) =>
  Number.isFinite(conf) && conf >= AUTO_FACT_CONF() && kind !== "relation" && impact !== "needs-confirm";

// ---------- 推断转正评分（第一步：只读打分，不改状态） ----------
// 原则：自评置信度最多贡献 0.4 分；跨会话复现 ≤0.35；用户原话重述 0.35；
// 隐私/决策类（relation/decision/outcome）与含糊表述扣分；转正还必须独立证据 ≥2。
type Ev = { at: string; kind: string; id?: string; note?: string };
const HEDGE_MARK = /(可能|大概|也许|或许|待定|尚不确定|不确定|估计|应该是|似乎|推测|不一定)/;
function evidenceOf(meta: Meta): Ev[] {
  try {
    const v = JSON.parse(meta.evidence || "[]");
    return Array.isArray(v) ? (v.filter((x: any) => x && typeof x.at === "string") as Ev[]) : [];
  } catch {
    return [];
  }
}

/** 证据累积（第二步）：同一天同一来源重复出现则跳过；只改 evidence 字段，不新建条目 */
export function appendEvidence(e: Entry, ev: Ev): string | null {
  const list = evidenceOf(e.meta);
  const day = ev.at.slice(0, 10);
  if (list.some((x) => x.at.slice(0, 10) === day && (x.id ?? "") === (ev.id ?? ""))) return null;
  const next = list.concat(ev).slice(-20);
  const meta = { ...e.meta, evidence: JSON.stringify(next) };
  // 证据可能落在历史条目上：只警告不阻断（否则旧字段会把证据累积整条链路卡死）
  entryStore.put({ meta, body: e.body }, { strict: false });
  const s = promoteScore({ meta, body: e.body });
  logger.activity(`evidence +1 ${e.meta.id} kind=${ev.kind} total=${next.length} score=${s.score.toFixed(2)}`);
  return `${e.meta.id} 证据 +1（${ev.kind}，累计 ${next.length} 条 / ${s.days} 天 / ${s.independent} 源，转正分 ${s.score.toFixed(2)}${s.gate ? "，已越过门槛，可用 confirm 转正" : ""}）`;
}
/** 复合分：返回 score 与各分项，供 promote_scan 展示与人工判断 */
function promoteScore(e: Entry) {
  const conf = Math.min(Math.max(Number(e.meta.confidence ?? 0.6), 0), 1);
  const ev = evidenceOf(e.meta);
  const days = new Set(ev.map((x) => x.at.slice(0, 10)));
  const independent = new Set(ev.map((x) => `${x.at.slice(0, 10)}|${x.id ?? ""}`)).size;
  const base = conf * 0.4;
  const repeat = (Math.min(days.size, 3) / 3) * 0.5; // 口径 B：复现满分 0.50，3 次独立复现即到线
  const restate = ev.some((x) => x.kind === "restate") ? 0.3 : 0;
  const kind = e.meta.kind ?? "";
  let penalty = 0;
  if (kind === "relation" || kind === "decision" || kind === "outcome") penalty += 0.25;
  if (HEDGE_MARK.test(e.body) || HEDGE_MARK.test(e.meta.subject ?? "")) penalty += 0.2;
  const score = Math.min(Math.max(base + repeat + restate - penalty, 0), 1);
  const blocked = kind === "relation" || e.meta.action_impact === "needs-confirm";
  const gate = score >= cfg.promoteThreshold && independent >= 2 && !blocked;
  return { score, base, repeat, restate, penalty, days: days.size, independent, blocked, gate };
}

/** 只读扫描：按复合分排序打印，不写任何文件（转正在后续步骤里才开启） */
/** 月度风格归纳（只读；写 profile 由人或 agent 做）：把窗口内的偏好/纠正/雷区摆出来当归纳材料 */
export function opStyleScan(days = 30, limit = 20): string {
  const since = new Date(clock.now() - days * 86400e3).toISOString();
  const rows = entryStore.list().filter(
    (r) =>
      r.meta.status !== "expired" &&
      r.meta.status !== "superseded" &&
      (String(r.meta.obtained_at ?? "") >= since || String(r.meta.evidence ?? "").includes(since.slice(0, 10))),
  );
  if (!rows.length) return `近 ${days} 天没有新增/更新的条目——画像无需变更。`;
  const sel = rows.filter((r) => ["preference", "constraint", "correction"].includes(r.meta.kind ?? ""));
  const neg = sel.filter((r) => isNegation(r));
  const others = sel.filter((r) => !isNegation(r)).slice(0, limit);
  const counts = rows.reduce<Record<string, number>>((m, r) => {
    const k = r.meta.kind ?? "?";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const lines: string[] = [
    `近 ${days} 天：活动条目新增/更新 ${rows.length} 条（${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ")}）`,
  ];
  if (neg.length) {
    lines.push(`雷区 ${neg.length} 条（写成指令更好用）：`);
    for (const r of neg.slice(0, 8)) lines.push(`- ${r.meta.subject}：${(r.title ?? "").slice(0, 46)}（${r.meta.id}）`);
  }
  if (others.length) {
    lines.push(`偏好/纠正 ${others.length} 条（可能含风格线索）：`);
    for (const r of others) lines.push(`- [${r.meta.kind}] ${r.meta.subject}：${(r.title ?? "").slice(0, 46)}（${r.meta.id}）`);
  }
  lines.push(
    "归纳方式：只把反复出现的稳定线索写进 profile.md 的「三、对外口径」「四、沟通与协作习惯」，每条结论附上面的 id 当证据；一次性情绪、单个项目特例不要写进去。",
    "`LIVING_MEMORY_PROFILE_BRIEF=1` 打开后，这两节会被压成一行注入每轮简报。",
  );
  try {
    fs.writeFileSync(PROFILE_STYLE_STAMP, new Date(clock.now()).toISOString());
  } catch {
    /* 戳写不进去不影响结果 */
  }
  logger.activity(`style_scan days=${days} rows=${rows.length} neg=${neg.length}`);
  return lines.join("\n");
}

/** 画像是否到了该归纳的时候（戳缺失也视为到期） */
export function styleScanOverdue(days = 30): boolean {
  try {
    const at = fs.readFileSync(PROFILE_STYLE_STAMP, "utf8").trim();
    return clock.now() - Date.parse(at) > days * 86400e3;
  } catch {
    return true;
  }
}

export function opPromoteScan(limit = 20): string {
  const rows = entryStore.list()
    .filter((r) => r.meta.status === "inference") // 只有推断是转正候选，confirmed/explicit 无需评分
    .map((r) => ({ r, e: entryStore.get(r.id) }))
    .filter((x): x is { r: (typeof rows)[number]["r"]; e: Entry } => !!x.e)
    .map(({ r, e }) => ({
      id: r.id,
      subject: r.meta.subject ?? "",
      kind: r.meta.kind ?? "",
      status: r.meta.status ?? "",
      s: promoteScore(e),
    }));
  if (!rows.length) return "没有活动条目可评分。";
  const sorted = rows.sort((a, b) => b.s.score - a.s.score);
  const over = sorted.filter((x) => x.s.gate).length;
  const n = Math.max(1, Math.min(limit, 50));
  const lines = sorted.slice(0, n).map(
    (x, i) =>
      `${String(i + 1).padStart(2)}. ${x.s.score.toFixed(2)}${x.s.gate ? " 可转正" : ""} · ${x.kind} · ${x.status} · ${x.id}\n` +
      `    ${x.subject}｜自评 ${x.s.base.toFixed(2)} · 复现 ${x.s.repeat.toFixed(2)}(${x.s.days} 天/${x.s.independent} 源) · 重述 ${x.s.restate.toFixed(2)} · 扣分 ${x.s.penalty.toFixed(2)}${x.s.blocked ? " · 需人工" : ""}`,
  );
  const avg = sorted.reduce((a, b) => a + b.s.score, 0) / sorted.length;
  return (
    `推断转正评分（阈值 ${cfg.promoteThreshold}，独立证据 ≥2，本命令只读不改状态）\n` +
    `活动 ${sorted.length} 条 · 平均 ${avg.toFixed(2)} · 最高 ${sorted[0].s.score.toFixed(2)} · 越过门槛 ${over} 条\n\n` +
    lines.join("\n") +
    (sorted.length > n ? `\n…（另有 ${sorted.length - n} 条未显示，limit 可调）` : "")
  );
}

/** A：按已存 confidence 追溯转事实（幂等）。用于规则上线前的存量推断；会话启动自动跑 */
export function autoFactRetro(limit = 10): string[] {
  if (isPaused()) return [];
  const acted: string[] = [];
  const cands = entryStore.list().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    const conf = Number(r.meta.confidence ?? NaN);
    if (!autoFactable(r.meta.kind ?? "", conf, r.meta.action_impact)) continue;
    const e = entryStore.get(r.id);
    if (!e) continue;
    opConfirm(e, `auto-fact retro conf=${conf}`);
    acted.push(`${r.id}（conf ${conf}）`);
  }
  if (acted.length) logger.activity(`auto-fact retro: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}

/** B：证据驱动的自动转事实。独立日期 >=3 天、复合分 >= 门槛、且非关系/需确认即视为事实 */
export function autoFactEvidence(limit = 5): string[] {
  const c = refreshConfig();
  if (c.autoFactEvidenceOff || isPaused()) return [];
  const minDays = c.autoFactMinDays;
  const minScore = c.autoFactMinScore ?? c.promoteThreshold;
  const acted: string[] = [];
  const cands = entryStore.list().filter((r) => r.meta.status === "inference");
  for (const r of cands) {
    if (acted.length >= limit) break;
    if (r.meta.kind === "relation" || r.meta.action_impact === "needs-confirm") continue;
    const e = entryStore.get(r.id);
    if (!e) continue;
    const s = promoteScore(e);
    if (s.days < minDays || s.score < minScore || s.independent < 2) continue;
    opConfirm(e, `auto-fact evidence days=${s.days} score=${s.score.toFixed(2)}`);
    acted.push(`${r.id}（${s.days} 天 / 分 ${s.score.toFixed(2)}）`);
  }
  if (acted.length) logger.activity(`auto-fact evidence: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}
