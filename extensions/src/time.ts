/**
 * 时间口径：today / addDays / isDue 与按 kind 的复核间隔、默认复核日期。
 * 依赖注入层（clock / settings / refreshConfig）；纯函数，模块顶层不做 IO。
 */
import { clock, getSettings, refreshConfig } from "./config";
import type { Meta } from "./manifest";

export function today(): string {
  return clock.today();
}

/** 按 kind 的复核间隔（天）：0=不设默认复核日期；settings.livingMemory.reviewDays 可覆盖 */
function reviewDays(kind: string, basis: string): number {
  const defaults: Record<string, number> = { decision: 60, outcome: 60, inference: 30, default: 180 };
  try {
    const custom = getSettings()?.livingMemory?.reviewDays as Record<string, number> | undefined;
    if (custom) {
      if (typeof custom[`${basis}`] === "number") return custom[`${basis}`];
      if (typeof custom[`${kind}`] === "number") return custom[`${kind}`];
      if (typeof custom.default === "number") return custom.default;
    }
  } catch {
    /* 读不到设置就用内置默认 */
  }
  return defaults[`${basis}`] ?? defaults[kind] ?? defaults.default;
}

/** 默认复核日期：decision/outcome 60 天，inference 30 天，其余 180 天（reviewDays 可改；0=不设） */
export function defaultReviewAfter(basis: string, kind = ""): string {
  if (refreshConfig().noAutoReview) return "";
  const days = reviewDays(kind, basis);
  if (!days) return "";
  return new Date(clock.now() + days * 86400e3).toISOString().slice(0, 10);
}

export function addDays(n: number): string {
  return new Date(clock.now() + n * 86400e3).toISOString().slice(0, 10);
}
export function isDue(meta: Meta): boolean {
  const t = today();
  for (const k of ["review_after", "expires_at"]) {
    const v = meta[k];
    if (v && v.slice(0, 10) <= t) return true;
  }
  return false;
}
