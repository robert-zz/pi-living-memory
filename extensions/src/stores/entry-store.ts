/**
 * entries/ 的存储接口与实现（含 expired/ 归档区与 recovery/ 删除记录）。
 * 依赖图 L3：paths / config / manifest / text；不 import 扩展壳，也不 import 其它 store。
 * 模块顶层只 new 一个无 IO 的 store 实例：ESM 模块缓存保证全进程共享同一份缓存。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { clock, logger } from "../config";
import { ACTIVE, parseEntry, toIndexRow, validateManifest, type Entry, type EntryIndex, type Meta } from "../manifest";
import { bodySimilar, normText } from "../text";
import {
  ENTRIES_DIR,
  EXPIRED_DIR,
  IDX_VERSION,
  INDEX_FILE,
  RECOVERY_DIR,
  ensureDirs,
  entryPath,
  manifestFileLabel,
  recoveryPath,
  writeAtomic,
} from "../paths";

/** 条目缓存：以「目录 mtime + 文件数」为戳，同一 turn 内多次读取零重复解析；put 写活动路径后立即失效 */
let entriesCache: { stamp: string; list: Entry[] } | null = null;
/** 索引行缓存：与 entriesCache 同口径失效（stamp=目录戳），写入路径同步更新而非整表重建 */
let indexCache: { stamp: string; rows: EntryIndex[] } | null = null;

function dirStamp(): string {
  try {
    return `${fs.statSync(ENTRIES_DIR).mtimeMs}|${fs.readdirSync(ENTRIES_DIR).length}`;
  } catch {
    return "";
  }
}

// 索引里的标题是摘要不是全文：中文每字 3 字节，160 字会让索引逼近正文体积
const titleOf = (body: string) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"))?.slice(0, 40) ?? "";

/**
 * entries 的存储接口：策略层只经它访问条目，不直接碰 fs 与派生索引。
 * list 与 listFull 是两种口径：list 只回索引行（不读正文，简报/召回必须用它），
 * listFull 才读正文（面板/冲突自检/全文检索用）；两者各自缓存、各自按目录戳失效。
 */
export interface EntryStore {
  /** 索引行（frontmatter + 标题 + 词元）：不读 entries 正文 */
  list(): EntryIndex[];
  /** 全量条目（含正文）：会读 entries 正文，简报不要用 */
  listFull(): Entry[];
  /** 按 id 前缀定位：先查索引，只解析命中的那 1 个文件；索引落后时回退全扫，最后查 expired/ */
  get(idPrefix: string): Entry | null;
  /**
   * 写条目：写到它当前所在目录（entries/ 或 expired/），活动条目同步索引行。
   * strict=true（默认）时先 validateManifest，有 error 直接抛；strict=false 只 logger.warn，供生命周期操作处理历史遗留条目。
   */
  put(e: Entry, opts?: { strict?: boolean }): void;
  /** 删除条目：落 recovery 记录、移走 entries/ 或 expired/ 下的文件、同步索引行 */
  delete(e: Entry, note?: string): void;
  /**
   * entries → expired：写 status=expired（frontmatter 其余字段保留）后把文件搬进 expired/ 并从索引移除，
   * 返回是否真的搬了文件（盘上没有活动文件时为 false，调用方的文案靠它）。activity.log 由策略层写。
   */
  expire(e: Entry): boolean;
  /**
   * expired → entries：按 id 搬回（保留原 id 与正文）并把 status 换成新值、写入 extraMeta 里的 frontmatter 字段，
   * 索引行随之恢复；盘上没有任何副本时返回 false，由调用方按「新建条目」写回。
   */
  resurrect(id: string, status: string, extraMeta?: Record<string, string>): boolean;
  /**
   * 从 expired/（文件）或 recovery/（删除记录）取回，返回取回后的条目；
   * 条目仍在 entries/ 时幂等跳过（recovery 记录保留），找不到可恢复的东西返回 null。
   */
  restore(id: string, opts?: { from?: "expired" | "recovery" }): Entry | null;
  /** recovery/ 里可恢复的 id（给前缀时按 restore 的匹配口径过滤）；recovery/ 目录不存在时为 null */
  recoverableIds(idPrefix?: string): string[] | null;
  /** expired/ 归档区全量条目（含正文，归档区检索用）；目录不存在时为 null */
  listExpired(): Entry[] | null;
  /**
   * purge 语义：把 status=expired/superseded 且超过 olderDays 的条目搬进 expired/ 并写月度台账（dropIndexRows 一次）。
   * 返回候选行（只含元数据，不读正文）、实际搬动条数、库内失效条目总数；dryRun=true 只算不动。
   */
  purgeExpired(olderDays: number, dryRun: boolean): { candidates: EntryIndex[]; moved: number; closed: number };
  /** 同 kind+subject 的活动条目里正文相似的那条（先索引筛候选，再只读候选正文） */
  findConflicting(kind: string, subject: string, text: string): Entry | null;
  /** 强制从盘重建派生索引并落盘（格式版本不符/损坏时 list 会自动调用） */
  rebuildIndex(): void;
  /** entries/ 目录戳（mtime + 文件数）：索引与全量缓存的失效口径 */
  stamp(): string;
}

class FileEntryStore implements EntryStore {
  list(): EntryIndex[] {
    const stamp = this.stamp();
    if (indexCache && indexCache.stamp === stamp) return indexCache.rows;
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
      // v 不符重建；同版本但没有 toks 的旧行也重建（格式闸门不能只看顶层 v）
      if (raw?.v === IDX_VERSION && raw?.stamp === stamp && Array.isArray(raw.rows) && raw.rows.every((r: any) => Array.isArray(r?.toks))) {
        indexCache = { stamp, rows: raw.rows as EntryIndex[] };
        return indexCache.rows;
      }
    } catch {
      // 索引缺失/损坏 → 下面重建
    }
    return this.buildIndex(stamp);
  }

  listFull(): Entry[] {
    const stamp = this.stamp();
    if (entriesCache && entriesCache.stamp === stamp) return entriesCache.list;
    ensureDirs();
    const out: Entry[] = [];
    for (const f of fs.readdirSync(ENTRIES_DIR)) {
      if (!f.endsWith(".md")) continue;
      const e = parseEntry(path.join(ENTRIES_DIR, f));
      if (e && e.meta.id) out.push(e);
    }
    out.sort((a, b) => (a.meta.id < b.meta.id ? 1 : -1));
    entriesCache = { stamp, list: out };
    return out;
  }

  get(idPrefix: string): Entry | null {
    const rows = this.list();
    const hit = rows.find((r) => r.id === idPrefix) ?? rows.find((r) => r.id.startsWith(idPrefix));
    if (hit) return parseEntry(path.join(ENTRIES_DIR, `${hit.id}.md`));
    // 索引可能落后于盘（极端并发），兜底全扫一次
    const live = this.listFull().find((e) => e.meta.id === idPrefix || e.meta.id.startsWith(idPrefix));
    if (live) return live;
    // 已失效搬进 expired/ 的条目仍可按 id 定位（renew/delete/restore 要用）
    if (fs.existsSync(EXPIRED_DIR)) {
      const f = fs
        .readdirSync(EXPIRED_DIR)
        .find((x) => x.endsWith(".md") && !x.startsWith("index-") && (x === `${idPrefix}.md` || x.startsWith(idPrefix)));
      if (f) return parseEntry(path.join(EXPIRED_DIR, f));
    }
    return null;
  }

  put(e: Entry, opts?: { strict?: boolean }): void {
    const { meta, body } = e;
    const strict = opts?.strict ?? true;
    const issues = validateManifest(meta, { file: manifestFileLabel(meta.id ? entryPath(meta.id) : "") });
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length) {
      const msg = errors.map((i) => `${i.field}: ${i.problem}`).join("；");
      if (strict) throw new Error(`manifest 不合法，未写入：${msg}`);
      logger.warn(`manifest 不合法（strict=false，仍按原样写盘）：${meta.id || "(无 id)"} ${msg}`);
    }
    ensureDirs();
    const live = entryPath(meta.id);
    const cold = path.join(EXPIRED_DIR, `${meta.id}.md`);
    const target = fs.existsSync(live) || !fs.existsSync(cold) ? live : cold;
    const order = ["id", "kind", "status", "subject", "scope", "source", "obtained_at", "confirmed_at", "expires_at", "review_after", "confidence", "evidence", "action_impact", "supersedes", "superseded_by"];
    const fm = order.map((k) => `${k}: ${meta[k] ?? ""}`).join("\n");
    writeAtomic(target, `---\n${fm}\n---\n${body.trim()}\n`);
    // 活动条目落盘即让全量缓存失效（原先由 writeAtomic 统一清；缓存归 store 后在这里清，口径等价）
    if (target === live) entriesCache = null;
    if (target === live) upsertIndexRow(meta, body);
    else dropIndexRows([meta.id]);
  }

  delete(e: Entry, note?: string): void {
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
    fs.writeFileSync(
      recoveryPath(e.meta.id),
      JSON.stringify({ meta: e.meta, body: e.body, deleted_at: new Date(clock.now()).toISOString(), note: note ?? "" }, null, 2),
    );
    const liveFile = entryPath(e.meta.id);
    const coldFile = path.join(EXPIRED_DIR, `${e.meta.id}.md`);
    try {
      fs.unlinkSync(fs.existsSync(liveFile) ? liveFile : coldFile);
    } catch {
      /* 文件可能已被移走，recovery 记录仍有效 */
    }
    dropIndexRows([e.meta.id]);
  }

  expire(e: Entry): boolean {
    e.meta.status = "expired";
    // 历史遗留条目可能带着非法 kind/日期；expire 是收口旧数据的手段，不能因此失败
    this.put({ meta: e.meta, body: e.body }, { strict: false });
    // 与旧 moveToExpired 同序：先写 status，再搬文件，最后删索引行（文件不在时不动索引）
    const moved = this.moveFileToExpired(e.meta.id);
    if (moved) dropIndexRows([e.meta.id]);
    return moved;
  }

  resurrect(id: string, status: string, extraMeta?: Record<string, string>): boolean {
    const cold = path.join(EXPIRED_DIR, `${id}.md`);
    const live = entryPath(id);
    const src = fs.existsSync(cold) ? cold : fs.existsSync(live) ? live : null;
    if (!src) return false;
    const e = parseEntry(src);
    if (!e) return false;
    // 搬回 entries/：rename 保留原文，随后 put 按 live 路径改写 status 并恢复索引行
    if (src === cold && !fs.existsSync(live)) fs.renameSync(cold, live);
    e.meta.status = status;
    for (const [k, v] of Object.entries(extraMeta ?? {})) e.meta[k] = v;
    // 归档区条目是历史快照，复活不应被旧字段卡住
    this.put({ meta: e.meta, body: e.body }, { strict: false });
    return true;
  }

  restore(id: string, opts?: { from?: "expired" | "recovery" }): Entry | null {
    const from = opts?.from;
    if (!from || from === "expired") {
      const e = this.restoreFromExpired(id);
      if (e) return e;
      if (from === "expired") return null;
    }
    return this.restoreFromRecovery(id);
  }

  recoverableIds(idPrefix?: string): string[] | null {
    if (!fs.existsSync(RECOVERY_DIR)) return null;
    const files = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
    if (idPrefix) {
      const hit = files.find((x) => x === `${idPrefix}.json`) ?? files.find((x) => x.startsWith(idPrefix));
      return hit ? [hit.replace(/\.json$/, "")] : [];
    }
    return files.map((x) => x.replace(/\.json$/, ""));
  }

  listExpired(): Entry[] | null {
    if (!fs.existsSync(EXPIRED_DIR)) return null;
    const out: Entry[] = [];
    for (const f of fs.readdirSync(EXPIRED_DIR)) {
      if (!f.endsWith(".md") || f.startsWith("index-")) continue;
      const e = parseEntry(path.join(EXPIRED_DIR, f));
      if (e?.meta.id) out.push(e);
    }
    return out;
  }

  purgeExpired(olderDays: number, dryRun: boolean): { candidates: EntryIndex[]; moved: number; closed: number } {
    ensureDirs();
    const { closed, due } = this.purgeCandidates(olderDays);
    if (dryRun || !due.length) return { candidates: due, moved: 0, closed };
    fs.mkdirSync(EXPIRED_DIR, { recursive: true });
    const month = new Date(clock.now()).toISOString().slice(0, 7);
    const idx = path.join(EXPIRED_DIR, `index-${month}.md`);
    const head = fs.existsSync(idx) ? "" : `# expired 归档索引 ${month}\n\n| id | kind | status | 记录日 | subject |\n|---|---|---|---|---|\n`;
    const rows = due.map((e) => {
      this.moveFileToExpired(e.meta.id); // 已在 expired/ 的只登记月度索引
      return `| ${e.meta.id} | ${e.meta.kind ?? ""} | ${e.meta.status ?? ""} | ${(e.meta.obtained_at ?? "").slice(0, 10)} | ${(e.meta.subject ?? "").replace(/\|/g, "／")} |`;
    });
    fs.writeFileSync(idx, head + rows.join("\n") + "\n");
    dropIndexRows(due.map((e) => e.meta.id));
    return { candidates: due, moved: due.length, closed };
  }

  findConflicting(kind: string, subject: string, text: string): Entry | null {
    const want = normText(subject);
    const cands = this.list().filter(
      (r) => ACTIVE.has(r.meta.status ?? "") && r.meta.kind === kind && normText(r.meta.subject ?? "") === want,
    );
    for (const r of cands) {
      const e = parseEntry(path.join(ENTRIES_DIR, `${r.id}.md`));
      if (e && bodySimilar(e.body, text)) return e;
    }
    return null;
  }

  rebuildIndex(): void {
    this.buildIndex(this.stamp());
  }

  stamp(): string {
    return dirStamp();
  }

  /** 从 entries/ 搬进 expired/（只动文件，索引由调用方按旧时机维护）：返回是否真的搬了 */
  private moveFileToExpired(id: string): boolean {
    const src = entryPath(id);
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(EXPIRED_DIR, { recursive: true });
    fs.renameSync(src, path.join(EXPIRED_DIR, `${id}.md`));
    return true;
  }

  /** restore 的 expired/ 分支：归档区文件本身完好，原样搬回 entries/（不动索引，旧实现也不动） */
  private restoreFromExpired(idPrefix: string): Entry | null {
    if (!fs.existsSync(EXPIRED_DIR)) return null;
    const hit = fs
      .readdirSync(EXPIRED_DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("index-") && (f === `${idPrefix}.md` || f.startsWith(idPrefix)))[0];
    if (!hit) return null;
    const id = hit.replace(/\.md$/, "");
    fs.renameSync(path.join(EXPIRED_DIR, hit), entryPath(id));
    // 归档区文件损坏时 parseEntry 回 null，但文件已搬回：仍按「已恢复」返回占位条目（旧实现只看文件名）
    return parseEntry(entryPath(id)) ?? { meta: { id }, body: "" };
  }

  /** restore 的 recovery/ 分支：条目仍在 entries/ 时幂等跳过（记录保留），返回 null */
  private restoreFromRecovery(idPrefix: string): Entry | null {
    if (!fs.existsSync(RECOVERY_DIR)) return null;
    const files = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
    const f = files.find((x) => x === `${idPrefix}.json`) ?? files.find((x) => x.startsWith(idPrefix));
    if (!f) return null;
    const rec = JSON.parse(fs.readFileSync(path.join(RECOVERY_DIR, f), "utf8")) as Entry;
    const id = rec.meta.id;
    if (fs.existsSync(entryPath(id))) return null;
    // recovery/ 记录是删除时的历史快照，取回不应被旧字段卡住
    this.put({ meta: rec.meta, body: rec.body }, { strict: false });
    fs.unlinkSync(path.join(RECOVERY_DIR, f));
    return rec;
  }

  /** 待归档（purge_expired）候选：只看元数据——entries/ 里的失效条目走索引，已搬走的 expired/ 直接读文件 */
  private purgeCandidates(olderDays: number): { closed: number; due: EntryIndex[] } {
    const fromIndex = this.list().filter((e) => e.meta.status === "expired" || e.meta.status === "superseded");
    const fromExpired: EntryIndex[] = fs.existsSync(EXPIRED_DIR)
      ? fs
          .readdirSync(EXPIRED_DIR)
          .filter((f) => f.endsWith(".md") && !f.startsWith("index-"))
          .map((f) => parseEntry(path.join(EXPIRED_DIR, f)))
          .filter((e): e is Entry => !!e)
          .map((e) => toIndexRow(e.meta, titleOf(e.body)))
      : [];
    const all = fromIndex.concat(fromExpired);
    return { closed: all.length, due: all.filter((e) => ageDays(e.meta) >= olderDays) };
  }

  /** 从 entries/ 重建索引行并落盘；stamp 由调用方先取，缓存戳与触发重建的那次读盘一致 */
  private buildIndex(stamp: string): EntryIndex[] {
    ensureDirs();
    const rows: EntryIndex[] = [];
    for (const f of fs.readdirSync(ENTRIES_DIR)) {
      if (!f.endsWith(".md")) continue;
      const e = parseEntry(path.join(ENTRIES_DIR, f));
      if (!e?.meta.id) continue;
      rows.push(toIndexRow(e.meta, titleOf(e.body)));
    }
    rows.sort((a, b) => (a.id < b.id ? 1 : -1));
    indexCache = { stamp, rows };
    writeAtomic(INDEX_FILE, JSON.stringify({ v: IDX_VERSION, stamp, rows }));
    return rows;
  }
}

export const entryStore: EntryStore = new FileEntryStore();

/** 索引写盘：stamp 取写盘后的目录戳——跨进程失效靠它，落不准就等下次重建 */
function flushIndex() {
  if (!indexCache) return;
  indexCache.stamp = dirStamp();
  writeAtomic(INDEX_FILE, JSON.stringify({ v: IDX_VERSION, stamp: indexCache.stamp, rows: indexCache.rows }));
}

const sortRows = (rows: EntryIndex[]) => rows.sort((a, b) => (a.id < b.id ? 1 : -1));

/** 新增/改写条目：只动那一行，不重扫全库 */
function upsertIndexRow(meta: Meta, body: string) {
  if (!indexCache) return;
  const rows = indexCache.rows.filter((r) => r.id !== meta.id).concat(toIndexRow(meta, titleOf(body)));
  sortRows(rows);
  indexCache.rows = rows;
  flushIndex();
}

/** 条目被移走/删除：只删那几行 */
function dropIndexRows(ids: string[]) {
  if (!indexCache || !ids.length) return;
  const gone = new Set(ids);
  indexCache.rows = indexCache.rows.filter((r) => !gone.has(r.id));
  flushIndex();
}

function ageDays(meta: Meta): number {
  const iso = meta.expires_at || meta.obtained_at;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (clock.now() - t) / 86_400_000;
}
