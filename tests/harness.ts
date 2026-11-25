/**
 * 测试夹具：种子库、假的 ExtensionAPI、工具调用、读盘计数、断言收集。
 * 所有用例都在临时 HOME 里跑（扩展在加载时按 os.homedir() 定 STORE），绝不碰真库。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Check = { name: string; ok: boolean; detail?: string };

export const mem = (home: string) => path.join(home, ".pi", "agent", "memory");

export const out = (r: any): string => {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text ?? "").join("\n");
  return String(r);
};

export function mkCtx(cwd = "/work/acme", opts: { hasUI?: boolean; confirm?: boolean } = {}) {
  const notes: string[] = [];
  const ctx = {
    cwd,
    hasUI: opts.hasUI ?? true,
    notes,
    ui: {
      notify: (m: string) => notes.push(String(m)),
      setWidget: () => {},
      setStatus: () => {},
      select: async () => undefined,
      confirm: async () => opts.confirm ?? true,
    },
  };
  return ctx;
}

export function makeApi() {
  const handlers: Record<string, any> = {};
  const tools: any[] = [];
  const commands: any[] = [];
  const api = {
    registerTool: (t: any) => tools.push(t),
    registerCommand: (n: string, o: any) => commands.push({ name: n, ...o }),
    on: (n: string, fn: any) => (handlers[n] = fn),
    ui: { notify: () => {} },
  };
  return { api, handlers, tools, commands };
}

/** 加载被测扩展（必须在 HOME 指向临时目录之后调用） */
export async function load(home: string, env: Record<string, string | null> = {}) {
  process.env.HOME = home;
  process.env.LIVING_MEMORY_EXTRACT = "0"; // 测试不调 LLM
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  const ext = (await import("./under-test/living-memory.ts")).default;
  const it = makeApi();
  ext(it.api as unknown as ExtensionAPI); // 测试替身：只实现被测扩展实际用到的注册面
  const call = (name: string, params: any, ctx: any = mkCtx()) => {
    const t = it.tools.find((x: any) => x.name === name);
    if (!t) throw new Error(`未注册工具：${name}`);
    return t.execute("t" + Math.random().toString(36).slice(2), params, undefined, undefined, ctx);
  };
  return { ...it, call, ext };
}

/** 读盘计数器：只统计 agent/memory 下的读操作 */
export function counter() {
  const orig = fs.readFileSync as any;
  let on = false;
  const hits: Array<{ file: string; bytes: number }> = [];
  (fs as any).readFileSync = function (p: any, ...a: any[]) {
    const r = orig.call(fs, p, ...a);
    if (on) {
      const f = String(p);
      if (f.includes("/.pi/agent/memory/")) hits.push({ file: path.relative(path.dirname(path.dirname(path.dirname(f))), f), bytes: Buffer.isBuffer(r) ? r.length : String(r).length });
    }
    return r;
  };
  return {
    start() {
      on = true;
      hits.length = 0;
    },
    stop() {
      on = false;
      return hits.slice();
    },
    hits,
  };
}

const FM = (o: Record<string, string>) =>
  "---\n" +
  Object.entries(o)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n") +
  "\n---\n";

export function writeEntry(home: string, e: { id: string; kind?: string; status?: string; subject: string; scope?: string; expires_at?: string; review_after?: string; basis?: string; source?: string; body: string }) {
  const dir = path.join(mem(home), "entries");
  fs.mkdirSync(dir, { recursive: true });
  const fm = FM({
    id: e.id,
    kind: e.kind ?? "decision",
    status: e.status ?? "explicit",
    subject: e.subject,
    scope: e.scope ?? "global",
    basis: e.basis ?? "explicit",
    source: e.source ?? "fixture",
    obtained_at: "2026-01-01T00:00:00.000Z",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    expires_at: e.expires_at ?? "",
    review_after: e.review_after ?? "2027-01-01",
  });
  fs.writeFileSync(path.join(dir, `${e.id}.md`), `${fm}${e.body}\n`);
}

export type Seed = "basic" | "bulk" | "empty" | "lint" | "bigEntry" | "routing";

export function seed(home: string, kind: Seed = "basic") {
  const m = mem(home);
  fs.mkdirSync(path.join(m, "entries"), { recursive: true });
  fs.mkdirSync(path.join(m, "expired"), { recursive: true });
  fs.writeFileSync(path.join(m, "activity.log"), "");
  fs.writeFileSync(
    path.join(m, "todo.md"),
    `# todo —— 未完成事项层

## 测试项目 A

- [ ] 待办甲：验证勾选
- [ ] 待办乙：验证关键词
- [x] 待办丙：已完成项

## 默认待办

- [ ] 待办丁：无项目
`,
  );
  fs.writeFileSync(
    path.join(m, "summary.md"),
    `# summary —— 工程实况与事实摘要层

## 测试项目 A

### [01] 小节一：简报与索引验证
<!-- src: fixture -->
小节一正文：用于验证目录索引与关键词检索。

### [02] 小节二：todo 层验证
<!-- src: fixture -->
小节二正文：验证 summary 导航。
`,
  );
  fs.writeFileSync(
    path.join(m, "profile.md"),
    `# 用户画像（聚合视图）\n\n## 一、决策风格\n\n- 暂无\n\n<!-- STATS:BEGIN -->\n（未生成）\n<!-- STATS:END -->\n`,
  );
  if (kind === "empty") return;
  writeEntry(home, { id: "20260101-000001-a1b2", kind: "decision", subject: "测试决策甲", body: "测试决策甲的正文：简报与检索用。" });
  writeEntry(home, {
    id: "20260101-000002-c3d4",
    kind: "constraint",
    subject: "测试约束乙",
    scope: "global,project:acme",
    expires_at: "2026-01-02T00:00:00.000Z", // 已过期（今天 2026-11-16）
    review_after: "2026-01-03",
    body: "测试约束乙正文：到期档验证。",
  });
  if (kind === "bulk") {
    for (let i = 0; i < 30; i++) {
      writeEntry(home, {
        id: `20260101-0001${String(i).padStart(2, "0")}-b${String(i).padStart(3, "0")}`,
        kind: "outcome",
        subject: `批量条目${i}`,
        body: `${"正文".repeat(500)} #${i}`,
      });
    }
  }
  if (kind === "lint") {
    writeEntry(home, { id: "20260102-000001-l1l1", kind: "decision", subject: "重复主题丙", body: "同一件事的结论：走方案 A，理由是可回滚。" });
    writeEntry(home, { id: "20260102-000002-l2l2", kind: "decision", subject: "重复主题丙", body: "同一件事的结论：走方案 A，理由是可回滚。" });
  }
  if (kind === "bigEntry") {
    writeEntry(home, { id: "20260103-000001-e1e1", kind: "outcome", subject: "超长条目戊", body: `${"工程细节".repeat(400)}` });
  }
  if (kind === "routing") {
    // A 段：outcome + 过程词（修复/测试通过），且不含决定类措辞 → 建议迁 summary
    writeEntry(home, { id: "20260103-000001-e1e1", kind: "outcome", subject: "超长条目戊", body: `修复后测试通过。${"工程细节".repeat(300)}部署完成，合并 PR。` });
    // B 段：summary 小节里有以「约定」开头的规则行 → 建议升格为条目
    fs.appendFileSync(
      path.join(m, "summary.md"),
      `\n## 测试项目 C\n\n### [03] 决策小节：发布约定\n<!-- src: fixture -->\n- 约定：所有发布必须走 canary，再全量。\n`,
    );
  }
}
