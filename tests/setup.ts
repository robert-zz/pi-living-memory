/**
 * 测试装置准备：把当前扩展源码复制成"被测件"，并为其解析依赖。
 * 被测件必须在测试目录内，依赖（typebox / @earendil-works/*）通过 node_modules 软链指向 pi 安装目录。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const TESTS_DIR = path.dirname(new URL(import.meta.url).pathname);
export const UNDER_TEST = path.join(TESTS_DIR, "under-test");
const PKG_SRC = path.join(TESTS_DIR, "..", "extensions", "living-memory.ts");
const HOME_SRC = path.join(os.homedir(), ".pi", "agent", "extensions", "living-memory.ts");

/** 被测件来源：LIVING_MEMORY_SRC > 包内 extensions/ > 开发副本 ~/.pi/agent/extensions/ */
export const SRC = process.env.LIVING_MEMORY_SRC
  ? path.resolve(process.env.LIVING_MEMORY_SRC)
  : (fs.existsSync(PKG_SRC) ? PKG_SRC : HOME_SRC);

/** 找依赖：优先仓内 node_modules（CI / 贡献者），其次最新一个带 node_modules 的 pi 安装目录（本地免装） */
function findDeps(): string | null {
  const local = path.join(TESTS_DIR, "..", "node_modules");
  if (fs.existsSync(path.join(local, "typebox"))) return local;
  const root = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  if (!fs.existsSync(root)) return null;
  const rels = fs
    .readdirSync(root)
    .map((v) => ({ v, m: fs.statSync(path.join(root, v)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { v } of rels) {
    const nm = path.join(root, v, "node_modules");
    if (fs.existsSync(path.join(nm, "typebox"))) return nm;
  }
  return null;
}

export function setup(): { src: string; deps: string | null; copied: boolean } {
  fs.mkdirSync(UNDER_TEST, { recursive: true });
  const srcSize = fs.statSync(SRC).size;
  const dst = path.join(UNDER_TEST, "living-memory.ts");
  const prev = fs.existsSync(dst) ? fs.statSync(dst).size : -1;
  fs.copyFileSync(SRC, dst);

  const nm = path.join(UNDER_TEST, "node_modules");
  const deps = findDeps();
  if (deps && (!fs.existsSync(nm) || !fs.existsSync(path.join(nm, "typebox")))) {
    try {
      fs.rmSync(nm, { force: true });
    } catch {}
    fs.symlinkSync(deps, nm, "dir");
  }
  return { src: SRC, deps, copied: srcSize !== prev };
}
