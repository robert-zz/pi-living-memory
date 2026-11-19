/**
 * A 档机械清理（LIVING_MEMORY_AUTO_TRIAGE 开关，默认 off）：只 expire 未治理推断里的自指 / 过程性 / 被更晚条目取代的旧版本。
 * 三个判定正则故意写死在代码里：可配置化一旦拼错会静默删记忆，写死 + 测试覆盖更安全。
 * 依赖 config / paths / manifest / entry-store 与 lifecycle 的 opExpire。
 */

import { getSettings, logger, refreshConfig } from "./config";
import { ACTIVE, type Entry } from "./manifest";
import { isPaused } from "./paths";
import { entryStore } from "./stores/entry-store";
import { opExpire } from "./lifecycle";

// ---------- Phase 4：A 档机械清理（LIVING_MEMORY_AUTO_TRIAGE=1 开启，默认 off） ----------
// 只处理结构上可判定的两类，且只针对 status=inference（未治理推断）：
//  ①A1 旧版本：同 subject 下有更晚条目在正文显式声明「纠正/取代/已过时」，且旧条目自身无此类声明
//  ②A2 自指/过程性：subject 命中记忆系统自指，或正文命中待批准/待答问题清单/调试结论/git 提交号等过程标记
// 隐私类（kind=relation）、action_impact=needs-confirm、已 confirmed/superseded 的一律不碰；
// 每次触发最多 5 条，逐条写 activity.log，B 档（事实转正）仍须用户 confirm，C 档须逐条人工。
const SUCCESSOR_MARK = /(已(?:被)?纠正|已过时|已被?取代|纠正为|不再成立|以此为准)/;
export const SELF_REF_MARK = /(living\s*(?:记忆|memory|迁移|功能|面板|brief|检索)|living-memor(?:y|ies)|pi-living-mem\w*|pi-memory|记忆系统|记忆层|抽取器|抽取\s*prompt|记忆库)/i;
/** 插件自身工程实现的自指词：subject 命中即视为工程实况，不立条目（「用户/我」开头的偏好类不受拦） */
const PLUGIN_INTERNAL =
  /(living[-_ ]?(?:memor|记忆)|pi-memory|index\.json|summary-index|todo-index|summary\.(?:md|索引)|todo(?:\.md|-archive|-index| 分家)|routing|source=(?:todo|summary|entries|archive|all)|brief|简报|面板|抽取器|派生索引|记忆)/i;
/** subject 是否在讲插件自身（「用户/我」开头的偏好类不算） */
export const isPluginInternal = (subject: string) => PLUGIN_INTERNAL.test(subject) && !/^(用户|我)/.test(subject);
const PROCEDURAL_MARK = /(待用户回答|待用户批准|待批准|待用户确认后执行|待你确认后执行|调试结论|git 提交号|commit [0-9a-f]{6,})/i;

function autoTriageEnabled(): boolean {
  const env = refreshConfig().autoTriage;
  if (env === "0") return false; // 环境变量优先，可临时关
  if (env === "1") return true;
  try {
    const v = getSettings()?.livingMemory?.autoTriage;
    if (typeof v === "boolean") return v;
  } catch {
    /* 读不到设置按默认 off */
  }
  return false;
}

export function autoTriage(trigger: string): string[] {
  if (!autoTriageEnabled() || isPaused()) return [];
  // 候选只可能是 inference 条目：先走索引筛，再逐条读正文，避免为一次 A 档扫描装载全库
  const cands = entryStore.list().filter((e) => ACTIVE.has(e.meta.status) && e.meta.status === "inference");
  if (!cands.length) return [];
  const allActive = entryStore.list().filter((e) => ACTIVE.has(e.meta.status));
  const active = cands.map((c) => entryStore.get(c.id)).filter((e): e is Entry => !!e);
  const acted: string[] = [];
  for (const e of active) {
    if (acted.length >= 5) break;
    if (e.meta.status !== "inference") continue;
    if (e.meta.kind === "relation" || e.meta.action_impact === "needs-confirm") continue;
    let rule = "";
    if (!SUCCESSOR_MARK.test(e.body)) {
      // 同 subject 且更新的条目才可能构成「已取代」，只读这几条正文
      const n = allActive.find(
        (x) =>
          x.meta.id !== e.meta.id &&
          x.meta.subject === e.meta.subject &&
          x.meta.obtained_at > e.meta.obtained_at &&
          SUCCESSOR_MARK.test(entryStore.get(x.id)?.body ?? ""),
      );
      if (n) rule = `A1 旧版本被 ${n.meta.id} 取代`;
    }
    if (!rule) {
      if (SELF_REF_MARK.test(e.meta.subject) || isPluginInternal(e.meta.subject)) rule = "A2 记忆系统自指";
      else if (PROCEDURAL_MARK.test(e.body)) rule = "A2 过程性事项";
    }
    if (!rule) continue;
    opExpire(e, `auto-triage ${rule} (${trigger})`);
    acted.push(`${e.meta.id}（${rule}）`);
  }
  if (acted.length) logger.activity(`auto-triage ${trigger}: ${acted.length} 条 → ${acted.join("; ")}`);
  return acted;
}
