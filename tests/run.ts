/**
 * 测试编排器：每个用例一个临时 HOME + 独立子进程（扩展加载时定 STORE，必须隔离）。
 * 用法：
 *   bun run.ts              # 全部
 *   bun run.ts --only brief # 单条
 *   bun run.ts --list       # 列出用例
 *   bun run.ts --keep       # 保留临时库（排查失败时用）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup } from "./setup.ts";
import { seed } from "./harness.ts";
import { CASES } from "./cases.ts";

const SELF = new URL(import.meta.url).pathname;
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const list = args.includes("--list");

if (list) {
  for (const c of CASES) console.log(`  ${c.id.padEnd(18)} ${c.title}`);
  process.exit(0);
}

const s = setup();
console.log(`被测件: ${s.src} → under-test/（${fs.statSync(path.join(path.dirname(SELF), "under-test/living-memory.ts")).size} 字节）`);
if (!s.deps) {
  console.error("找不到 pi 安装目录下的 node_modules，无法解析 typebox / @earendil-works/*");
  process.exit(2);
}

const selected = only ? CASES.filter((c) => c.id === only) : CASES;
const KEEP = args.includes("--keep");
if (!selected.length) {
  console.error(`没有用例匹配 ${only}`);
  process.exit(2);
}

let total = 0;
let failed = 0;
const failures: string[] = [];

for (const c of selected) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lmtest-${c.id}-`));
  seed(home, c.seed);
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, SELF.replace(/run\.ts$/, "cases.ts"), c.id], {
    env: { ...process.env, TEST_HOME: home, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const ms = Math.round(performance.now() - t0);

  const line = stdout.split("\n").find((l) => l.includes("__RESULT__"));
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = line
    ? JSON.parse(line.slice(line.indexOf("__RESULT__") + "__RESULT__".length)).checks
    : [{ name: "子进程无结果", ok: false, detail: (stderr || stdout).slice(0, 300) }];

  const bad = checks.filter((x) => !x.ok);
  total += checks.length;
  failed += bad.length;
  console.log(`\n${bad.length ? "✗" : "✓"} ${c.id}  (${c.title})  ${ms}ms  临时库 ${home.replace(os.tmpdir(), "~tmp")}`);
  for (const x of checks) {
    const mark = x.ok ? "  ✓" : "  ✗";
    console.log(`${mark} ${x.name}${x.detail ? ` — ${x.detail.replace(/\n/g, " ")}` : ""}`);
  }
  if (bad.length) console.log(`  现场保留：${home}`);
  else if (!KEEP) fs.rmSync(home, { recursive: true, force: true });
  if (bad.length) failures.push(`${c.id}: ${bad.map((b) => b.name).join(", ")}`);
  if (stderr.trim() && bad.length) console.log(`  stderr: ${stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
}

console.log(`\n${failed ? "✗ 失败" : "✓ 全部通过"}：${total - failed}/${total} 断言通过，${selected.length} 个用例`);
if (failures.length) {
  console.log("失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
