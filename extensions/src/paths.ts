/**
 * 路径常量与文件原语：库根、各文档/派生索引路径、原子写、跨进程文件锁、条目 id 生成。
 * 依赖图 L1：只 import config（时钟）。模块顶层不做任何 IO——所有读写都发生在调用时。
 * 收口原因：三个 store 与 ops/brief/extract 需要同一份路径口径；路径留在扩展壳里，
 * store 就只能反向 import 壳（会成环）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clock } from "./config";

/** 库根：加载期定一次（pi 扩展按 os.homedir() 找库，测试用临时 HOME 隔离） */
export const STORE = path.join(os.homedir(), ".pi", "agent", "memory");
export const ENTRIES_DIR = path.join(STORE, "entries");
export const EXPIRED_DIR = path.join(STORE, "expired");
export const RECOVERY_DIR = path.join(STORE, "recovery");
export const ACTIVITY = path.join(STORE, "activity.log");
export const PAUSE_FLAG = path.join(STORE, "paused");
export const MISS_FILE = path.join(STORE, "miss.log");
export const INDEX_FILE = path.join(STORE, "index.json");
export const EXTRACT_FAIL_FILE = path.join(STORE, "extract-failures.jsonl");
export const TODO_FILE = path.join(STORE, "todo.md");
export const TODO_ARCHIVE_FILE = path.join(STORE, "todo-archive.md");
export const TODO_INDEX_FILE = path.join(STORE, "todo-index.json");
export const SUMMARY_FILE = path.join(STORE, "summary.md");
export const SUMMARY_INDEX_FILE = path.join(STORE, "summary-index.json");
export const SUMMARY_ARCHIVE_FILE = path.join(STORE, "summary-archive.md");
export const PROFILE_FILE = path.join(STORE, "profile.md");
/** 风格归纳戳：style_scan 落盘，session_start 判「画像是否 30 天未归纳」 */
export const PROFILE_STYLE_STAMP = path.join(STORE, "profile-style.last");
/** 画像摘要注入开关文件：env/settings 都没表态时看它（存在即注入） */
export const PROFILE_BRIEF_FLAG = path.join(STORE, "profile-brief.on");
/** 派生索引（index.json / todo-index.json / summary-index.json）的格式版本：字段或语义变化时递增；stamp 相同不代表格式相同，旧索引一律重建 */
export const IDX_VERSION = 4;

export function ensureDirs() {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
}
export function entryPath(id: string) {
  return path.join(ENTRIES_DIR, `${id}.md`);
}
export function newId(): string {
  const d = new Date(clock.now());
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

export function isPaused() {
  return fs.existsSync(PAUSE_FLAG);
}

/** 原子写：先写临时文件再 rename，避免两个 pi 进程同时写导致半截文件 */
export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 同步文件锁：`<file>.lock` 用 O_EXCL 创建，覆盖「读—改—写」整段；持锁方崩溃留下的陈旧锁（>30s）自动接管 */
export function withFileLockSync<T>(file: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = clock.now() + 3000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${new Date(clock.now()).toISOString()}`);
        fs.closeSync(fd);
      } catch {
        // 锁内容写失败不影响互斥
      }
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (clock.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // 锁刚被释放，立即重试
      }
      if (clock.now() > deadline) {
        try {
          fs.unlinkSync(lock);
        } catch {
          // 已被接管
        }
        continue;
      }
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // 已被超时接管
    }
  }
}

/** 库内相对路径（lint 展示用）；不在 STORE 下的路径原样返回 */
export function manifestFileLabel(file: string): string {
  if (!file) return "";
  const rel = path.relative(STORE, file);
  return rel.startsWith("..") ? file : rel;
}

export function recoveryPath(id: string) {
  return path.join(RECOVERY_DIR, `${id}.json`);
}

/** activity.log 轮转目标：activity-YYYY-MM.log；同名已存在时按月内序号追加后缀 */
export function activityArchivePath(month: string, index = 0): string {
  return path.join(STORE, `activity-${month}${index ? `-${index}` : ""}.log`);
}

/** 活动小节保留数：超过就提示（或按 LIVING_MEMORY_AUTO_ARCHIVE 自动）归档 */

// 早期版本用大写文件名。若只剩大写孪生文件就改名为小写；两边都在则记下来，交给 session_start 提示人工合并（通常是陈旧实例又写回来的）。
const LEGACY_PAIRS: Array<[string, string]> = [
  ["SUMMARY.md", "summary.md"],
  ["SUMMARY-archive.md", "summary-archive.md"],
  ["TODO.md", "todo.md"],
  ["TODO-archive.md", "todo-archive.md"],
];
export function healLegacyNames(): void {
  for (const [upper, lower] of LEGACY_PAIRS) {
    const u = path.join(STORE, upper);
    const l = path.join(STORE, lower);
    if (!fs.existsSync(u)) continue;
    if (fs.existsSync(l)) continue;
    try {
      fs.renameSync(u, l);
    } catch {
      /* 只读盘或权限问题：留给人工 */
    }
  }
}
healLegacyNames();
// 大写与小写并存的孪生文件（通常是陈旧实例写回来的）：按需探测，改一次数量就少一次
export function legacyTwins(): string {
  const found: string[] = [];
  for (const [upper, lower] of LEGACY_PAIRS) {
    if (fs.existsSync(path.join(STORE, upper)) && fs.existsSync(path.join(STORE, lower))) found.push(upper);
  }
  return found.join(", ");
}
