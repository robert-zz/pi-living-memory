/**
 * demo 捕获（in-process）：在临时 HOME 里加载真实扩展，调 remember 写一条事实，
 * 结束该轮后再触发下一轮的 before_agent_start 简报注入，只把**真实输出文本**落到 capture.json。
 *
 * 用法：bun scripts/demo/capture.ts
 *
 * 隔离与确定性（三条，都不改文案，只固定环境）：
 *   1. os.homedir() 打补丁指向固定临时目录 —— 与 benchmarks/run.ts 同法（Bun 启动期就缓存了 homedir，
 *      只改 process.env.HOME 不会让 paths.ts 的 STORE 换目录）。
 *   2. setClock 冻结到固定时刻 —— 条目 id 的日期戳、简报「近期」行的月份都固定。
 *   3. Math.random 换成定种 PRNG —— 条目 id 的后 4 位十六进制固定。
 *   4. 显示归一化：临时 HOME 的绝对路径随机器 TMPDIR 变化，写 capture.json 前折成 `~`；
 *      条目 id、status、scope 等其余文本逐字保留。
 * 因此 capture.json 可重复生成、逐字可 diff；除 `~` 前缀外，文本由扩展代码产生，脚本不做改写或补白。
 * 临时 HOME 每次重跑前清空，真库零写入。
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** 用 CJS 引用拿 node:os：静态 import 会把命名空间缓存住，homedir 补丁就传不进 paths.ts */
const nodeOs = createRequire(import.meta.url)("node:os") as { homedir: () => string; tmpdir: () => string };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT_FILE = path.join(HERE, "capture.json");
/** 固定的临时 HOME：路径会出现在 remember 返回的“存储:”行里，必须可重复 */
const DEMO_HOME = path.join(nodeOs.tmpdir(), "lm-demo-home");
/** 临时 HOME 的绝对路径随机器变化（TMPDIR 可配置），显示层统一折成 `~`：只替换该前缀，其余逐字保留 */
const foldDemoHome = (text: string): string => text.split(DEMO_HOME).join("~");
const DEMO_CWD = "/demo/acme";
const FROZEN_NOW = Date.UTC(2026, 10, 24, 9, 0, 0);
const FROZEN_TODAY = "2026-11-24";
const RANDOM_SEED = 0x2f6e;
const SYSTEM_PROMPT = "DEMO-SYSTEM-PROMPT";

/** 第一轮：用户给一条可跨会话的事实，工具写入（提问是 demo 的输入，返回值才是捕获对象） */
const FIRST_PROMPT = "记住：下周三去成都出差，周四回。";
const REMEMBER_PARAMS = {
  kind: "commitment",
  subject: "用户",
  text: "下周三去成都出差，周四回。",
  basis: "explicit",
  source: "2026-11-24 用户原话「下周三去成都出差，周四回」",
};
/** 第二轮（新会话）的用户提问：简报按它做召回段 */
const NEXT_PROMPT = "下周出差要带什么？";
/** 简报里「与这条事实相关」的行：命中主体/条目 id，或召回段、近期段本身 */
const RELATED_PREFIXES = ["近期：", "· 召回（"];

type Tool = { name: string; execute: (id: string, params: any, sig: any, upd: any, ctx: any) => Promise<any> };
type Handler = (event: any, ctx: any) => any;

function fakeApi() {
  const handlers: Record<string, Handler> = {};
  const tools: Tool[] = [];
  const api = {
    registerTool: (t: Tool) => tools.push(t),
    registerCommand: () => {},
    on: (name: string, fn: Handler) => (handlers[name] = fn),
    ui: { notify: () => {} },
    getSettings: () => null,
  };
  return { api, handlers, tools };
}

function fakeCtx() {
  return {
    cwd: DEMO_CWD,
    hasUI: true,
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
      select: async () => undefined,
      confirm: async () => true,
    },
  };
}

const textOf = (r: any): string =>
  Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? "").join("\n") : String(r ?? "");

/** Bun 启动期缓存 homedir：必须同时替换补丁与环境变量，跑完还原 */
function useDemoHome(home: string): () => void {
  const original = nodeOs.homedir;
  nodeOs.homedir = () => home;
  return () => {
    nodeOs.homedir = original;
  };
}

/** 条目 id 的后缀来自 Math.random：换成定种 PRNG，其余调用点照常 */
function freezeRandom(): () => void {
  const original = Math.random;
  let state = RANDOM_SEED;
  Math.random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return () => {
    Math.random = original;
  };
}

async function main(): Promise<void> {
  fs.rmSync(DEMO_HOME, { recursive: true, force: true });
  fs.mkdirSync(DEMO_HOME, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = DEMO_HOME;
  process.env.LIVING_MEMORY_EXTRACT = "0"; // demo 不调模型：本轮只演示写入与开屏简报
  const restoreHomedir = useDemoHome(DEMO_HOME);
  const restoreRandom = freezeRandom();
  try {
    const { default: livingMemory, setClock } = await import("../../extensions/living-memory.ts");
    setClock({ now: () => FROZEN_NOW, today: () => FROZEN_TODAY });
    const { api, handlers, tools } = fakeApi();
    livingMemory(api as any);
    const ctx = fakeCtx();

    // 第一轮：写一条事实，抓 remember 的真实返回
    const remember = tools.find((t) => t.name === "remember");
    if (!remember) throw new Error("扩展没有注册 remember 工具——demo 假设被打破");
    const wrote = textOf(await remember.execute("demo-remember", REMEMBER_PARAMS, null, null, ctx));
    if (!wrote) throw new Error("remember 没有返回文本——demo 假设被打破");

    // 结束该轮（抽取默认关闭，这里只走真实的 turn-end 钩子）
    await handlers["agent_end"]?.({ messages: [{ role: "user", content: [{ type: "text", text: REMEMBER_PARAMS.text }] }] }, ctx);
    await handlers["agent_settled"]?.({ aborted: false }, ctx);

    // 下一轮开屏：走真实的 before_agent_start 注入，拿它拼进 systemPrompt 的原样文本
    const injected = await handlers["before_agent_start"]({ systemPrompt: SYSTEM_PROMPT, prompt: NEXT_PROMPT }, ctx);
    const raw = typeof injected?.systemPrompt === "string" ? injected.systemPrompt : "";
    const block = raw.startsWith(SYSTEM_PROMPT) ? raw.slice(SYSTEM_PROMPT.length) : "";
    if (!block) throw new Error("简报没有注入——demo 假设被打破");
    const lines = block.split("\n").filter((l) => l.trim().length > 0);

    const id = (wrote.match(/\d{8}-\d{6}-[0-9a-f]{4}/) ?? [""])[0];
    const heading = lines.find((l) => l.startsWith("## ")) ?? "";
    const related = lines.filter(
      (l) =>
        l !== heading &&
        (l.includes(REMEMBER_PARAMS.subject) || (id && l.includes(id)) || RELATED_PREFIXES.some((p) => l.startsWith(p))),
    );
    const factLine = lines.find((l) => l.startsWith(`${REMEMBER_PARAMS.subject}：`));
    if (!factLine) throw new Error("简报里没有本次写入的分层行——demo 假设被打破");

    const payload = {
      note: "由 scripts/demo/capture.ts 生成（真实扩展输出；临时 HOME 显示为 ~；重跑：bun scripts/demo/capture.ts）",
      cwd: DEMO_CWD,
      frozen_now: `2026-11-24T${new Date(FROZEN_NOW).toISOString().slice(11)}`,
      remember: { prompt: FIRST_PROMPT, params: REMEMBER_PARAMS, lines: wrote.split("\n").map(foldDemoHome) },
      brief: { prompt: NEXT_PROMPT, heading: foldDemoHome(heading), lines: related.map(foldDemoHome) },
    };
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

    console.log(`capture.json 已写入：${path.relative(process.cwd(), OUT_FILE)}`);
    console.log(`remember：${wrote.split("\n")[0]}`);
    for (const l of related) console.log(`brief：${l}`);
  } finally {
    restoreRandom();
    restoreHomedir();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(DEMO_HOME, { recursive: true, force: true });
  }
}

await main();
