/**
 * scope 判定与白名单校验：global / workspace:<名> / project:<名>（多值逗号分隔）。
 * 依赖 manifest（SCOPE_TOKEN_RE / Meta 类型）与 entry-store（提示库里已用过的 scope）；读库只在调用时，模块顶层不碰库。
 */

import * as path from "node:path";

import { SCOPE_TOKEN_RE, type Meta } from "./manifest";
import { entryStore } from "./stores/entry-store";

export function inScope(e: { meta: Meta }, cwd?: string): boolean {
  const s = e.meta.scope || "global";
  if (s === "global") return true;
  if (!cwd) return true; // 拿不到 cwd 时宁多勿漏
  const base = path.basename(cwd);
  if (!base) return true;
  // 逐 token 精确比对（旧版 s.includes(base) 会让 acme 误配 acme.com）
  return s
    .split(",")
    .map((t) => t.trim().replace(/^(?:workspace|project):/, ""))
    .some((t) => t !== "" && t === base);
}

/** scope 白名单校验：global / workspace:<名> / project:<名>（多值逗号分隔）；错拼会永远进不了对应层，因此直接拒写 */
export function validateScope(raw: string): string {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return "scope 不能为空：用 global / workspace:<名> / project:<名>（多值逗号分隔）。";
  const bad = tokens.filter((t) => !SCOPE_TOKEN_RE.test(t));
  if (!bad.length) return "";
  const known = new Set(
    entryStore.list()
      .flatMap((e) => (e.meta.scope || "").split(",").map((x) => x.trim()))
      .filter(Boolean),
  );
  return `scope 值不合法：${bad.join("、")}。只接受 global / workspace:<名> / project:<名>（多值逗号分隔）。库里已用过的 scope：${
    [...known].sort().slice(0, 12).join(" / ") || "（暂无）"
  }`;
}
