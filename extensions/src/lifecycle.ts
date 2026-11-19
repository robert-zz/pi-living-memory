/**
 * 条目生命周期：确认 / 纠正 / 续期 / 过期 / 批量清理 / recovery 轮转 / expired 归档检索 / 删除与恢复。
 * 依赖 config / paths / manifest / text / entry-store 与 time（今天与到期判定）；写盘全在调用时。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { cfg, clock, logger } from "./config";
import { ACTIVE, type Entry, type Meta } from "./manifest";
import { RECOVERY_DIR, newId } from "./paths";
import { normText } from "./text";
import { entryStore } from "./stores/entry-store";
import { isDue, today } from "./time";

export function fmt(e: Entry, withBody = true): string {
  const m = e.meta;
  const tags = [m.kind ?? "", m.status ?? "", `scope=${m.scope ?? ""}`];
  if (m.confidence) tags.push(`conf=${m.confidence}`);
  if (m.supersedes) tags.push(`supersedes=${m.supersedes}`);
  if (m.superseded_by) tags.push(`superseded_by=${m.superseded_by}`);
  if (ACTIVE.has(m.status) && isDue(m)) tags.push("DUE");
  const head = `${m.id} [${tags.join(" · ")}] ${m.subject}`;
  if (!withBody) return head;
  const body = e.body.length > 80 ? `${e.body.slice(0, 80)}…` : e.body;
  return `${head}: ${body.replace(/\n/g, " ")}`;
}

// ---------- 核心操作（工具与 /memory 面板共用） ----------
export function opConfirm(e: Entry, note?: string): string {
  if (!["inference", "event", "explicit"].includes(e.meta.status))
    return `${e.meta.id} status=${e.meta.status}，无需确认。`;
  e.meta.status = "confirmed";
  e.meta.confirmed_at = new Date(clock.now()).toISOString();
  entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  logger.activity(`confirmed ${e.meta.id}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已确认为 confirmed 事实。`;
}

export function opSupersede(e: Entry, text: string, note?: string): string {
  // 只允许从当前版本派生：对已被取代的旧条目 supersede 会分叉出平行链
  if (!ACTIVE.has(e.meta.status)) {
    const tip = e.meta.superseded_by ? `，当前版本是 ${e.meta.superseded_by}` : "";
    return `${e.meta.id} 非活动条目（status=${e.meta.status}${tip}），请对当前版本 supersede。`;
  }
  const old = e.meta;
  const nid = newId();
  const nm: Meta = {
    id: nid,
    kind: old.kind,
    status: "explicit",
    subject: old.subject,
    scope: old.scope,
    source: `${old.source} → 纠正于 ${today()}${note ? `（${note}）` : ""}`,
    obtained_at: new Date(clock.now()).toISOString(),
    confirmed_at: new Date(clock.now()).toISOString(),
    expires_at: old.expires_at,
    review_after: old.review_after,
    confidence: "",
    action_impact: old.action_impact || "advice-only",
    supersedes: old.id,
    superseded_by: "",
  };
  // 新条目字段来自旧条目（可能是历史数据）：strict=false，问题由 logger.warn + lint 曝光
  entryStore.put({ meta: nm, body: text }, { strict: false });
  old.status = "superseded";
  old.superseded_by = nid;
  entryStore.put({ meta: old, body: e.body }, { strict: false });
  logger.activity(`supersede ${old.id} -> ${nid}`);
  // 替代链深度：同一 subject 反复纠正时提示合并，防止同主题攒出十几代版本
  let depth = 1;
  const seen = new Set<string>([old.id]);
  let cur: Meta | undefined = old;
  while (cur?.supersedes && !seen.has(cur.supersedes)) {
    seen.add(cur.supersedes);
    const prev = entryStore.get(cur.supersedes);
    if (!prev) break;
    cur = prev.meta;
    depth++;
  }
  const chainHint =
    depth >= 4 ? `\n提示：该 subject 的替代链已 ${depth} 代，旧条目可 expire 合并，避免长期累积。` : "";
  return `已纠正：旧条目 ${old.id} → 新条目 ${nid}（旧条目保留 superseded 链，不再参与检索）。${chainHint}`;
}

export function opRenew(e: Entry, reviewAfter?: string, expiresAt?: string): string {
  // 已失效（在 expired/ 或盘上 status=expired）的条目：renew 即复活——搬回 entries/ 并转为 explicit
  const resurrect = e.meta.status === "expired";
  if (!resurrect && !ACTIVE.has(e.meta.status)) return `${e.meta.id} status=${e.meta.status}，非活动条目，不能续期。`;
  const ra = reviewAfter || new Date(clock.now() + 30 * 86400e3).toISOString().slice(0, 10);
  const patch: Meta = { review_after: ra };
  if (expiresAt) patch.expires_at = expiresAt;
  if (resurrect) {
    const reviveFields: Meta = { confirmed_at: "", ...patch };
    Object.assign(e.meta, { status: "explicit", ...reviveFields });
    // 复活由 store 搬文件 + 恢复索引行；盘上没有任何副本（并发删除）时退回按内存内容写回，语义同旧实现
    if (!entryStore.resurrect(e.meta.id, "explicit", reviveFields))
      entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  } else {
    Object.assign(e.meta, patch);
    entryStore.put({ meta: e.meta, body: e.body }, { strict: false });
  }
  logger.activity(`renew ${e.meta.id} review_after=${ra} status=${e.meta.status}${resurrect ? " resurrect=1" : ""}`);
  return resurrect
    ? `${e.meta.id} 已复活（expired → explicit，搬回 entries/），review_after=${ra}。`
    : `${e.meta.id} 已续期，review_after=${ra}（status 保持 ${e.meta.status}：续期≠确认，转正仍需显式 confirm）。`;
}

export function opExpire(e: Entry, note?: string): string {
  const moved = entryStore.expire(e);
  logger.activity(`expire ${e.meta.id} moved=${moved ? "expired/" : "-"}${note ? ` note=${note}` : ""}`);
  return `${e.meta.id} 已标记过期${moved ? "并移入 expired/" : ""}（不再参与检索；restore 可取回，补 renew 即复活）。`;
}

// ---------- G：过期条目批量清理（转移而非删除，expired/ 下按 id 保留原文，可 restore 回来） ----------

/** 把 status=expired/superseded 且超过 older_than_days 的条目移入 expired/；dry_run 默认 true */
export function opPurgeExpired(olderDays = 30, dry = true): string {
  const { candidates: due, moved, closed } = entryStore.purgeExpired(olderDays, dry);
  if (!due.length)
    return `无符合条件条目（库内 status=expired/superseded 共 ${closed} 条，均未超过 ${olderDays} 天）。`;
  const lines = due.map((e) => `${e.meta.id}（${e.meta.kind ?? ""}/${e.meta.status ?? ""}/${(e.meta.obtained_at ?? "").slice(0, 10)}）${e.meta.subject ?? ""}`);
  if (dry)
    return `候选 ${due.length} 条（dry_run，未移动）：\n${lines.slice(0, 15).join("\n")}${due.length > 15 ? `\n…（还有 ${due.length - 15} 条）` : ""}\n确认无误会后传 dry_run=false 执行：文件移到 expired/，仍可用 restore 取回。`;
  logger.activity(`purge_expired n=${moved} older_than_days=${olderDays} ids=${due.map((e) => e.meta.id).join(",")}`);
  return `已清理 ${moved} 条到 expired/（索引 expired/index-${new Date(clock.now()).toISOString().slice(0, 7)}.md，restore 可取回）：\n${lines.slice(0, 10).join("\n")}${due.length > 10 ? "\n…" : ""}`;
}

function recoveryAgeDays(file: string): number {
  return (clock.now() - fs.statSync(file).mtimeMs) / 86_400_000;
}

/** 已删条目在 recovery/ 只保留 cfg.recoveryRetainDays 天，到期物理删；dry_run 默认 true */
export function rotateRecovery(days = cfg.recoveryRetainDays, dry = true): string {
  if (!fs.existsSync(RECOVERY_DIR)) return "recovery/ 为空，无需轮转。";
  const files = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
  const due = files.filter((f) => recoveryAgeDays(path.join(RECOVERY_DIR, f)) >= days);
  const oldest = files.length ? Math.round(Math.max(...files.map((f) => recoveryAgeDays(path.join(RECOVERY_DIR, f))))) : 0;
  if (!due.length) return `recovery/ 共 ${files.length} 条，均未超过 ${days} 天保留期（最老 ${oldest} 天）。`;
  const names = due.map((f) => f.replace(/\.json$/, ""));
  if (dry)
    return `可轮转 ${due.length} 条（dry_run，未删除，保留期 ${days} 天）：\n${names.slice(0, 15).join("\n")}${
      due.length > 15 ? `\n…（还有 ${due.length - 15} 条）` : ""
    }\n确认后传 dry_run=false；删除后这些条目不再可 restore。`;
  for (const f of due) fs.unlinkSync(path.join(RECOVERY_DIR, f));
  logger.activity(`rotate_recovery n=${due.length} retain=${days}d ids=${names.join(",")}`);
  return `已物理删除 ${due.length} 条超过 ${days} 天的 recovery 记录（这些条目不再可 restore）。`;
}

/** expired/ 归档区检索视图：条目被 purge_expired 移出活动库后仍可查、可取回 */
export function searchExpired(q: string, status?: string, limit = 30): string {
  const rows = entryStore.listExpired();
  if (!rows) return "expired/ 为空（尚未执行过 purge_expired）。";
  const kw = q.split(/\s+/).filter(Boolean);
  let list = status ? rows.filter((e) => e.meta.status === status) : rows;
  if (kw.length)
    list = list.filter((e) => kw.every((k) => normText(`${e.meta.subject} ${e.meta.kind} ${e.meta.source} ${e.body}`).includes(normText(k))));
  list.sort((a, b) => (a.meta.id < b.meta.id ? 1 : -1));
  if (!list.length) return `expired/ 共 ${rows.length} 条，无匹配${kw.length ? `「${kw.join(" ")}」` : ""}。`;
  const lim = Math.min(limit, 100);
  return `expired/ 共 ${rows.length} 条，命中 ${list.length}（显示前 ${Math.min(list.length, lim)}；restore id 可取回）：\n\n${list
    .slice(0, lim)
    .map((e) => fmt(e))
    .join("\n")}`;
}

/** 批量 expire：无 id 时按 kind/scope/subject_contains 选活动条目；dry_run 默认 true */
export function opExpireBatch(sel: { kind?: string; scope?: string; subject?: string }, dry = true, note?: string): string {
  const pick = entryStore.listFull().filter(
    (e) =>
      ACTIVE.has(e.meta.status) &&
      (!sel.kind || e.meta.kind === sel.kind) &&
      (!sel.scope || (e.meta.scope ?? "").split(",").map((s) => s.trim()).includes(sel.scope)) &&
      (!sel.subject || (e.meta.subject ?? "").includes(sel.subject)),
  );
  if (!pick.length) return "没有匹配的活动条目（批量 expire 只作用于 explicit/event/inference/confirmed）。";
  const lines = pick.map((e) => `${e.meta.id}（${e.meta.kind}/${e.meta.status}）${e.meta.subject}`);
  const more = pick.length > 15 ? `\n…（还有 ${pick.length - 15} 条）` : "";
  if (dry)
    return `候选 ${pick.length} 条（dry_run，未改动）：\n${lines.slice(0, 15).join("\n")}${more}\n确认后传 dry_run=false；每条都可 renew 复活。`;
  for (const e of pick) entryStore.expire(e);
  logger.activity(`expire-batch n=${pick.length} kind=${sel.kind ?? "-"} scope=${sel.scope ?? "-"} subject=${sel.subject ?? "-"}${note ? ` note=${note}` : ""}`);
  return `已批量失效 ${pick.length} 条（status=expired，renew 可复活）：\n${lines.slice(0, 10).join("\n")}${pick.length > 10 ? "\n…" : ""}`;
}

export function opDelete(e: Entry, note?: string): string {
  entryStore.delete(e, note);
  logger.activity(
    `delete ${e.meta.id} kind=${e.meta.kind} subject=${e.meta.subject} source="${e.meta.source}" body="${e.body.slice(0, 160)}"${note ? ` note=${note}` : ""} recovery=${e.meta.id}.json`,
  );
  return `${e.meta.id} 已删除（完整内容存于 recovery/${e.meta.id}.json，可用 living_memory_update action=restore id=${e.meta.id} 恢复）。`;
}

/** 从 expired/ 归档区或 recovery 记录恢复条目（幂等：条目仍在库中则不覆盖） */
export function opRestore(idPrefix: string): string {
  // 先看 expired/（purge_expired 转移过来的条目在这里，文件本身完好）
  const fromExpired = entryStore.restore(idPrefix, { from: "expired" });
  if (fromExpired) {
    logger.activity(`restore ${fromExpired.meta.id} from=expired/`);
    return `${fromExpired.meta.id} 已从 expired/ 恢复（status=expired，仍不参与检索；要复活需再来一次 renew）。`;
  }
  const ids = entryStore.recoverableIds();
  if (!ids) return "没有可恢复记录（recovery/ 为空）。";
  const rec = entryStore.restore(idPrefix, { from: "recovery" });
  if (rec) {
    logger.activity(`restore ${rec.meta.id} kind=${rec.meta.kind} subject=${rec.meta.subject}`);
    return `${rec.meta.id} 已从 recovery 恢复（status=${rec.meta.status}）。`;
  }
  // 记录还在 = 命中前缀但条目本就还在 entries/，restore 幂等跳过
  const hit = entryStore.recoverableIds(idPrefix);
  if (hit?.length) return `${hit[0]} 条目仍在库中，无需恢复。`;
  const list = ids.sort().reverse();
  return `找不到 ${idPrefix} 的删除记录。可恢复条目：${list.slice(0, 10).join(", ") || "无"}${list.length > 10 ? ` …（共 ${list.length} 条）` : ""}`;
}
