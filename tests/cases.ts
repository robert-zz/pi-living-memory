/**
 * 用例集合。单进程只跑一个用例（扩展在加载时把 HOME 定为 STORE，无法中途切换）。
 * 由 run.ts 以「临时 HOME + 种子库 + 子进程」的方式逐个调用。
 */
import fs from "node:fs";
import path from "node:path";
import { mem, mkCtx, load, out, counter, writeEntry } from "./harness.ts";
import type { Seed } from "./harness.ts";

export type Meta = { id: string; title: string; seed: Seed };

export const CASES: Meta[] = [
  { id: "brief", title: "简报：分档顺序 / 上限 / 页脚 / 项目命中", seed: "basic" },
  { id: "brief-optout", title: "简报：LIVING_MEMORY_BRIEF=0 不注入", seed: "basic" },
  { id: "brief-readbudget", title: "简报：不再读 entries 正文（读盘 0 次）", seed: "bulk" },
  { id: "remember", title: "写入：索引行同步 + 同 subject/kind 查重拦截", seed: "basic" },
  { id: "supersede", title: "纠正：supersede 换代 + 替代链护栏", seed: "basic" },
  { id: "expire", title: "失效：expire → renew 复活 → expire+restore 往返", seed: "basic" },
  { id: "delete", title: "删除：recovery 落盘 + restore 取回", seed: "basic" },
  { id: "todo", title: "待办：勾选 / 分节新增 / 归档 / 索引计数", seed: "basic" },
  { id: "todo-structured", title: "待办：@project / #tag / due 标记与筛选", seed: "basic" },
  { id: "summary", title: "实况：summary_add → 目录索引 → summary_update", seed: "basic" },
  { id: "summary-archive", title: "实况：summary_archive keep=3 移出最老小节", seed: "basic" },
  { id: "purge", title: "清理：purge_expired 移入 expired/ + 月度台账", seed: "basic" },
  { id: "lint", title: "自检：重复/冲突检出", seed: "lint" },
  { id: "manifest-invalid", title: "manifest：非法字段读宽松 + lint 报出 + 写入拒绝", seed: "basic" },
  { id: "manifest-frontmatter", title: "manifest：无/未闭合 frontmatter 报出且不拖垮索引", seed: "basic" },
  { id: "manifest-legacy-lenient", title: "manifest：历史非法条目仍可 expire/renew/restore", seed: "basic" },
  { id: "routing", title: "审计：长条目建议迁 summary", seed: "routing" },
  { id: "index-selfheal", title: "索引：删掉三个派生索引后自愈", seed: "basic" },
  { id: "archive-guard", title: "归档：qmd 缺失时降级为可读提示", seed: "basic" },
  { id: "hints", title: "提示：过期可归档提醒 + START_HINTS=0 静默", seed: "basic" },
  { id: "legacy-twin", title: "兼容：大写孪生文件会提示人工合并", seed: "basic" },
  { id: "profile", title: "画像：STATS 块刷新 + 幂等不写盘", seed: "basic" },
  { id: "lock", title: "并发：两进程各加 8 条待办不互相覆盖", seed: "basic" },
  { id: "extract-fail", title: "抽取：失败可见（source=extract + 开屏提示）", seed: "basic" },
  { id: "promote", title: "转正：证据累积 + 复合分门槛", seed: "basic" },
  { id: "profile-brief", title: "画像：默认不注入，开关后压成一行", seed: "basic" },
  { id: "negation", title: "简报：雷区条目优先并打标", seed: "basic" },
  { id: "style-scan", title: "归纳：style_scan 出候选并落戳", seed: "basic" },
  { id: "auto-fact", title: "推断：置信度 ≥0.85 自动按事实，低于降为弱参考", seed: "basic" },
  { id: "auto-fact-retro", title: "推断：A 会话启动按已存 confidence 追溯转事实", seed: "basic" },
  { id: "auto-fact-evidence", title: "推断：B 证据 ≥3 天且分 ≥0.8 自动转事实", seed: "basic" },
  { id: "index-toks", title: "索引：v=4 + toks，旧版索引重建", seed: "basic" },
  { id: "recall-rank", title: "召回：中文模糊说法命中并按 BM25 排序", seed: "basic" },
  { id: "recall-limits", title: "召回：≤3 条 / 每条 subject ≤80 / 整段 ≤300", seed: "basic" },
  { id: "recall-dedup", title: "召回：排除简报已含条目", seed: "basic" },
  { id: "recall-off", title: "召回：LIVING_MEMORY_RECALL=0 不注入", seed: "basic" },
  { id: "recall-stopword", title: "召回：中文高频词元被过滤且不单独放行", seed: "basic" },
  { id: "recall-ascii-exempt", title: "召回：高频 ASCII 整词仍参与打分", seed: "basic" },
  { id: "recall-single-token", title: "召回：单命中只认 ASCII 专名（idf ≥3.5）", seed: "basic" },
  { id: "recall-hitcount", title: "召回：被过滤词元不计入最少命中数", seed: "basic" },
  { id: "recall-ascii-short", title: "召回：2 字母技术缩写白名单（ai/ci/pr/ui/db/ss）", seed: "basic" },
  { id: "recall-k1", title: "召回：k=1 只回排序首条", seed: "basic" },
  { id: "recall-k3", title: "召回：k=3 与默认口径一致", seed: "basic" },
  { id: "recall-k5", title: "召回：k=5 返回完整排序前缀", seed: "basic" },
  { id: "recall-k-over", title: "召回：k 大于候选数时返回全部", seed: "basic" },
  { id: "miss-log", title: "零命中：写 miss.log / 命中不写 / 开关关闭", seed: "basic" },
  { id: "clock-freeze", title: "时钟：冻结时钟决定到期分档（策略走注入 Clock）", seed: "basic" },
  { id: "config-inject", title: "配置：setConfig 改简报上限，还原后一致", seed: "bulk" },
  { id: "extract-parse-empty", title: "抽取解析：空/纯空白回包 → empty-response", seed: "empty" },
  { id: "extract-parse-fence", title: "抽取解析：剥 ```json 围栏", seed: "empty" },
  { id: "extract-parse-array", title: "抽取解析：[] 与数组 ok:true", seed: "empty" },
  { id: "extract-parse-no-json", title: "抽取解析：找不到数组 → no-json", seed: "empty" },
  { id: "extract-parse-bad-json", title: "抽取解析：坏 JSON → parse-failed", seed: "empty" },
  { id: "extract-normalize-nonarray", title: "抽取归一：非数组/非对象空转", seed: "empty" },
  { id: "extract-normalize-cap", title: "抽取归一：配额最多 3 条", seed: "empty" },
  { id: "extract-normalize-invalid", title: "抽取归一：非法 kind / 空 subject / 空 body", seed: "empty" },
  { id: "extract-normalize-selfref", title: "抽取归一：自指 subject 不立条目", seed: "empty" },
  { id: "extract-normalize-confidence", title: "抽取归一：confidence 夹取 + 同批去重", seed: "empty" },
  { id: "extract-decide-split", title: "抽取决策：create/conflict 分流（注入查找函数）", seed: "empty" },
  { id: "extract-decide-isolated", title: "抽取决策：单条冲突不影响其它候选", seed: "empty" },
  { id: "extract-decide-empty", title: "抽取决策：candidates 为空返回空且不查库", seed: "empty" },
  { id: "extract-gate-config", title: "抽取硬闸：LIVING_MEMORY_EXTRACT_GATE 默认拦 / 0=影子", seed: "empty" },
  { id: "extract-gate-user-turns", title: "抽取硬闸：userTurnsText 只取用户轮次且不受 6000 截断", seed: "empty" },
  { id: "extract-gate-quote-missing", title: "抽取硬闸：quote 缺失/过短 → unverified", seed: "empty" },
  { id: "extract-gate-quote-foreign", title: "抽取硬闸：quote 来自 assistant/任务书 → unverified", seed: "empty" },
  { id: "extract-gate-quote-verbatim", title: "抽取硬闸：用户原话逐字 quote 正常 create", seed: "empty" },
  { id: "extract-gate-noise-command", title: "抽取硬闸：正文只拦结构性垃圾（围栏/hash）", seed: "empty" },
  { id: "extract-gate-selfref-body", title: "抽取硬闸：正文含插件 token 放行（引文优先）", seed: "empty" },
  { id: "extract-gate-quote-fixtures", title: "抽取硬闸：6 条真实正文配真实用户回合，全部 create", seed: "empty" },
  { id: "extract-gate-structural", title: "抽取硬闸：任务书文本引文不实 → unverified，正文任务书词不拦", seed: "empty" },
  { id: "extract-gate-process-verified", title: "抽取硬闸：过程自述在引文验过后不拦", seed: "empty" },
  { id: "extract-gate-mode", title: "抽取硬闸：enforce 拦下 / shadow 只记录", seed: "empty" },
  { id: "extract-gate-ledger", title: "抽取硬闸：台账滚动保留 200 条", seed: "empty" },
  { id: "extract-gate-health", title: "抽取硬闸：source=extract 输出被闸统计", seed: "empty" },
];

const fmText = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n${body}\n`;
const rawEntry = (home: string, file: string, text: string) => {
  const dir = path.join(mem(home), "entries");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const ok = (name: string, cond: any, detail?: any) => checks.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail) });

const read = (home: string, p: string) => {
  try {
    return fs.readFileSync(path.join(mem(home), p), "utf8");
  } catch {
    return "";
  }
};
const exists = (home: string, p: string) => fs.existsSync(path.join(mem(home), p));
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** 召回夹具：默认写 global/explicit 条目，方便直接看简报与召回排序 */
const addGlobal = (home: string, e: { id: string; subject: string; body: string }) =>
  writeEntry(home, { kind: "decision", status: "explicit", scope: "global", ...e });
const recallSeg = (txt: string) => txt.split("\n").find((l) => l.startsWith("· 召回（按本轮提问）：")) ?? "";
const recallItems = (seg: string) => seg.replace("· 召回（按本轮提问）：", "").split(" · ").filter(Boolean);
/** 填充条目：召回语料要够 N（df/N 比例与 idf 才有统计意义）；id 用较新日期，让简报优先展示它们而不是夹具目标 */
const addFillers = (home: string, n: number) => {
  for (let i = 0; i < n; i++)
    addGlobal(home, { id: `20260105-0001${String(i).padStart(2, "0")}-f${String(i).padStart(3, "0")}`, subject: `填充条目${i}`, body: `填充正文${i}。` });
};
const recallOf = async (L: any, prompt: string) => {
  const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE", prompt }, mkCtx("/work/acme"));
  return recallSeg(String(r?.systemPrompt ?? ""));
};

/** rankRecall k 用例夹具：6 条同主题条目，每条都命中 npm/staging/发布，k 可从 1 拉到 6 */
const recallKCorpus = async () => {
  const { tokensOf } = await import("./under-test/src/text.ts");
  return ["发布流程", "发布回滚", "发布检查", "发布记录", "发布清单", "发布演练"].map((tail, i) => {
    const id = `20260101-00000${i}-k${String(i).padStart(3, "0")}`;
    const subject = `npm staging ${tail}`;
    return { id, meta: { id, status: "explicit", subject }, title: subject, toks: tokensOf(`${subject} ${subject}`) };
  });
};

async function body(id: string, home: string) {
  const AUTO_OFF = { LIVING_MEMORY_AUTO_TRIAGE: "0" };

  switch (id) {
    case "brief": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const txt = String(r?.systemPrompt ?? "");
      ok("注入存在", txt.includes("长期记忆") || txt.includes("记忆"), txt.slice(0, 40));
      ok("追加在系统提示之后", txt.startsWith("BASE"));
      ok("不超过 2400+80 字符", txt.length <= 2480, `${txt.length} 字符`);
      ok("到期档有 [到期] 标记", txt.includes("[到期]"), txt.match(/\[到期\][^\n]{0,20}/)?.[0]);
      ok("到期条目按 scope 命中", txt.includes("测试约束乙"));
      ok("全局条目进简报", txt.includes("测试决策甲"));
      ok("页脚带计数", /活动 \d+/.test(txt) && /待办 \d+ 项/.test(txt));
      return;
    }
    case "brief-optout": {
      const L = await load(home, { LIVING_MEMORY_BRIEF: "0", ...AUTO_OFF });
      const ctx = mkCtx("/work/acme");
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      ok("不注入（返回空/undefined）", !r || r.systemPrompt === undefined || r.systemPrompt === "BASE", JSON.stringify(r ?? null).slice(0, 40));
      return;
    }
    case "brief-readbudget": {
      const c = counter();
      const L = await load(home, AUTO_OFF); // 索引冷建在加载期，不计入简报
      const ctx = mkCtx("/work/acme");
      c.start();
      await L.handlers.before_agent_start({ systemPrompt: "" }, ctx);
      const hits = c.stop();
      const entryReads = hits.filter((h) => /entries\//.test(h.file));
      ok("简报不读 entries 正文", entryReads.length === 0, `${entryReads.length} 次 / 共 ${hits.length} 次读盘`);
      ok("简报只读索引与 todo", hits.every((h) => /index\.json|summary-index\.json|todo-index\.json|todo\.md/.test(h.file)), hits.map((h) => h.file).join(","));
      ok("30 条正文未进内存", hits.reduce((s, h) => s + h.bytes, 0) < 20000, `${hits.reduce((s, h) => s + h.bytes, 0)} 字节`);
      return;
    }
    case "remember": {
      const L = await load(home, AUTO_OFF);
      const r1 = out(await L.call("remember", { kind: "decision", subject: "查重主题", text: "查重主题：第一条结论", basis: "explicit", source: "test" }));
      const id1 = r1.match(/(\d{8}-\d{6}-\w{4})/)?.[1] ?? "";
      ok("写入返回 id", !!id1, id1);
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("索引同步新增行", (idx.rows ?? []).some((r: any) => r.id === id1), `rows=${(idx.rows ?? []).length}`);
      const r2 = out(await L.call("remember", { kind: "decision", subject: "查重主题", text: "查重主题：第一条结论，走方案 A 可回滚。", basis: "explicit", source: "test" }));
      ok("同 subject/kind 被拦", r2.includes("已有同 subject+kind"), r2.split("\n")[0].slice(0, 50));
      const r3 = out(await L.call("remember", { kind: "preference", subject: "查重主题", text: "不同 kind 可写入", basis: "explicit", source: "test" }));
      ok("不同 kind 放行", r3.includes("已记入"), r3.split("\n")[0].slice(0, 40));
      return;
    }
    case "supersede": {
      const L = await load(home, AUTO_OFF);
      const r1 = out(await L.call("remember", { kind: "decision", subject: "换代主题", text: "v1 结论", basis: "explicit", source: "test" }));
      const oldId = r1.match(/(\d{8}-\d{6}-\w{4})/)?.[1] ?? "";
      let cur = oldId;
      const ids: string[] = [oldId];
      let last = "";
      for (let i = 2; i <= 5; i++) {
        const r = out(await L.call("living_memory_update", { action: "supersede", id: cur, text: `v${i} 结论`, note: "test" }));
        if (i === 2) ok("supersede 返回新 id", /新条目/.test(r), r.slice(0, 60));
        cur = r.match(/新条目 (\d{8}-\d{6}-\w{4})/)?.[1] ?? "";
        ids.push(cur);
        last = r;
      }
      ok("链提示出现（≥4 代）", /替代链已 \d+ 代/.test(last), last.split("\n").pop()?.slice(0, 40));
      ok("旧条目保留 superseded", read(home, `entries/${ids[1]}.md`).includes("status: superseded"));
      ok("最新条目活动", read(home, `entries/${cur}.md`).includes("status: explicit"));
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("索引行跟着换代", (idx.rows ?? []).some((r: any) => r.id === cur));
      return;
    }
    case "expire": {
      const L = await load(home, AUTO_OFF);
      const before = fs.readdirSync(path.join(mem(home), "entries")).length;
      const e = out(await L.call("living_memory_update", { action: "expire", id: "20260101-000001-a1b2" }));
      ok("expire 报移动", /失效|expired/.test(e), e.slice(0, 50));
      ok("entries 减少", fs.readdirSync(path.join(mem(home), "entries")).length === before - 1);
      ok("expired 里可检索", out(await L.call("living_memory", { source: "expired", query: "测试决策甲" })).includes("20260101-000001-a1b2"));
      const rn = out(await L.call("living_memory_update", { action: "renew", id: "20260101-000001-a1b2" }));
      ok("renew 复活到活动区", exists(home, "entries/20260101-000001-a1b2.md") && /explicit/.test(read(home, "entries/20260101-000001-a1b2.md")));
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("索引行恢复", (idx.rows ?? []).some((r: any) => r.id === "20260101-000001-a1b2"));
      const e2 = out(await L.call("living_memory_update", { action: "expire", id: "20260101-000001-a1b2" }));
      const rs = out(await L.call("living_memory_update", { action: "restore", id: "20260101-000001-a1b2" }));
      ok("expire→restore 往返", exists(home, "entries/20260101-000001-a1b2.md"), rs.slice(0, 40));
      return;
    }
    case "delete": {
      const L = await load(home, AUTO_OFF);
      const d = out(await L.call("living_memory_update", { action: "delete", id: "20260101-000001-a1b2" }));
      ok("delete 落 recovery", fs.existsSync(path.join(mem(home), "recovery")) && fs.readdirSync(path.join(mem(home), "recovery")).length > 0, d.slice(0, 40));
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("索引行已删", !(idx.rows ?? []).some((r: any) => r.id === "20260101-000001-a1b2"));
      const rs = out(await L.call("living_memory_update", { action: "restore", id: "20260101-000001-a1b2" }));
      ok("restore 取回", exists(home, "entries/20260101-000001-a1b2.md"), rs.slice(0, 40));
      return;
    }
    case "todo": {
      const L = await load(home, AUTO_OFF);
      const d1 = out(await L.call("living_memory_update", { action: "todo_done", match: "待办甲" }));
      ok("勾选生效", read(home, "todo.md").includes("- [x] 待办甲"), d1.slice(0, 40));
      const a1 = out(await L.call("living_memory_update", { action: "todo_add", text: "新增待办戊：验证分节", section: "测试项目 A" }));
      const todo = read(home, "todo.md");
      const seg = todo.split("## 测试项目 A")[1]?.split("\n## ")[0] ?? "";
      ok("按 section 归位", seg.includes("新增待办戊"), a1.slice(0, 40));
      const ar = out(await L.call("living_memory_update", { action: "todo_archive" }));
      ok("归档移出", /已归档 \d+ 项/.test(ar) && !read(home, "todo.md").includes("- [x] 待办丙"), ar.slice(0, 40));
      ok("归档文件有内容", read(home, "todo-archive.md").includes("待办丙"));
      const open = count(read(home, "todo.md"), /^- \[ \] /gm);
      const idx = JSON.parse(read(home, "todo-index.json") || "{}");
      ok("todo-index 与盘一致", Array.isArray(idx.open) && idx.open.length === open, `open=${open} idx=${Array.isArray(idx.open) ? idx.open.length : "?"}`);
      return;
    }
    case "todo-structured": {
      const L = await load(home, AUTO_OFF);
      const day = (off: number) => {
        const x = new Date();
        x.setDate(x.getDate() + off);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      };
      const soon = day(2);
      const late = day(-1);
      await L.call("living_memory_update", { action: "todo_add", text: "结构待办己：标记写入", section: "测试项目 A", project: "acme", tags: "p2,dns", due: soon });
      const line = (read(home, "todo.md").split("\n").find((l) => l.includes("结构待办己")) ?? "").trim();
      ok("行尾写入 @project #tag due:", line.endsWith(`@acme #p2 #dns due:${soon}`), line);
      const bad = out(await L.call("living_memory_update", { action: "todo_add", text: "结构待办坏：日期非法", due: "2026/12/01" }));
      ok("非法 due 被拒", /YYYY-MM-DD/.test(bad) && !read(home, "todo.md").includes("结构待办坏"), bad.slice(0, 60));
      await L.call("living_memory_update", { action: "todo_add", text: "结构待办庚：已逾期", project: "acme", tags: "p0", due: late });
      ok("逾期日期可写", read(home, "todo.md").includes(`due:${late}`) && read(home, "todo.md").includes("#p0"));
      const q1 = out(await L.call("living_memory", { source: "todo", query: "@acme" }));
      ok("按 @project 筛", q1.includes("结构待办己") && q1.includes("结构待办庚") && !q1.includes("待办甲"), q1.split("\n")[0]);
      const q2 = out(await L.call("living_memory", { source: "todo", query: "@acme #p0" }));
      ok("按 #tag 叠加筛", q2.includes("结构待办庚") && !q2.includes("结构待办己"), q2.split("\n")[0]);
      const q3 = out(await L.call("living_memory", { source: "todo", query: "due:overdue" }));
      ok("due:overdue 只命中逾期", q3.includes("结构待办庚") && !q3.includes("结构待办己"), q3.split("\n")[0]);
      const q4 = out(await L.call("living_memory", { source: "todo", query: "due:soon" }));
      ok("due:soon 覆盖 7 日内与逾期", q4.includes("结构待办己") && q4.includes("结构待办庚"), q4.split("\n")[0]);
      const q5 = out(await L.call("living_memory", { source: "todo", query: "due:2099-01-01" }));
      ok("due:具体日期无命中", !q5.includes("结构待办己") && /命中 0/.test(q5), q5.split("\n")[0]);
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const brief = String(r?.systemPrompt ?? "");
      ok("简报含到期提醒行", brief.includes("待办到期：") && brief.includes("逾期"), brief.match(/待办到期：[^\n]{0,60}/)?.[0]);
      ok("页脚含待办到期计数", /待办到期 2 项/.test(brief), brief.match(/待办到期 \d+ 项/)?.[0]);
      return;
    }
    case "summary": {
      const L = await load(home, AUTO_OFF);
      const a = out(await L.call("living_memory_update", { action: "summary_add", project: "测试项目 B", title: "新增小节三", body: "小节三正文：验收 summary_add。" }));
      ok("summary_add 返回编号", /#\d+/.test(a), a.slice(0, 60));
      ok("落盘有新增小节", read(home, "summary.md").includes("### [") && read(home, "summary.md").includes("新增小节三"));
      const nav = out(await L.call("living_memory", { source: "summary" }));
      ok("目录索引含新节", nav.includes("新增小节三") && nav.includes("测试项目 B"), nav.split("\n")[0].slice(0, 50));
      const u = out(await L.call("living_memory_update", { action: "summary_update", match: "新增小节三", body: "改后正文：summary_update 生效。" }));
      ok("summary_update 改正文", read(home, "summary.md").includes("改后正文") && !read(home, "summary.md").includes("验收 summary_add"));
      ok("摘要检索命中", out(await L.call("living_memory", { source: "summary", query: "改后正文" })).includes("新增小节三"));
      return;
    }
    case "summary-archive": {
      const L = await load(home, AUTO_OFF);
      for (let i = 1; i <= 3; i++) {
        await L.call("living_memory_update", { action: "summary_add", project: "测试项目 C", title: `归档候选${i}`, body: `归档候选${i} 正文。` });
      }
      const sections = () => count(read(home, "summary.md"), /^### \[\d+\] /gm);
      ok("先有 5 节", sections() === 5, `${sections()} 节`);
      const dry = out(await L.call("living_memory_update", { action: "summary_archive", keep: 3 }));
      ok("dry_run 不动盘", sections() === 5, dry.slice(0, 40));
      const real = out(await L.call("living_memory_update", { action: "summary_archive", keep: 3, dry_run: false }));
      ok("移出 2 节", sections() === 3, `${sections()} 节 / ${real.slice(0, 40)}`);
      ok("归档文件有原文", read(home, "summary-archive.md").includes("[01]") && read(home, "summary-archive.md").includes("小节一正文"));
      ok("summary.md 留指针", /正文见 summary-archive\.md/.test(read(home, "summary.md")));
      ok("归档区可检索", out(await L.call("living_memory", { source: "summary-archive", query: "小节一正文" })).includes("小节一"));
      return;
    }
    case "purge": {
      const L = await load(home, AUTO_OFF);
      await L.call("living_memory_update", { action: "expire", id: "20260101-000002-c3d4" });
      const dry = out(await L.call("living_memory_update", { action: "purge_expired" }));
      ok("默认 dry_run", /dry_run|预览|候选/.test(dry) && fs.readdirSync(path.join(mem(home), "expired")).filter((f) => !f.startsWith("index-")).length === 1, dry.split("\n")[0].slice(0, 50));
      const real = out(await L.call("living_memory_update", { action: "purge_expired", older_than_days: 30, dry_run: false }));
      ok("移入 expired/", !exists(home, "entries/20260101-000002-c3d4.md") && fs.readdirSync(path.join(mem(home), "expired")).some((f) => f.includes("20260101-000002-c3d4")), real.split("\n")[0].slice(0, 50));
      ok("月度台账生成", fs.readdirSync(path.join(mem(home), "expired")).some((f) => /index-\d{4}-\d{2}\.md/.test(f)));
      ok("索引行已清", !JSON.parse(read(home, "index.json") || "{}").rows?.some((r: any) => r.id === "20260101-000002-c3d4"));
      ok("归档区可检索", out(await L.call("living_memory", { source: "expired", query: "测试约束乙" })).includes("20260101-000002-c3d4"));
      return;
    }
    case "lint": {
      const L = await load(home, AUTO_OFF);
      const r = out(await L.call("living_memory", { source: "lint" }));
      ok("检出重复/冲突", /重复|冲突/.test(r), r.split("\n").filter((l) => /重复|冲突/.test(l))[0]?.slice(0, 60));
      ok("指向重叠的两个 id", r.includes("20260102-000001-l1l1") || r.includes("20260102-000002-l2l2"));
      return;
    }
    case "manifest-invalid": {
      // 坏 frontmatter 本身合法可解析，但字段非法：读路径不能崩，lint 必须报，写入必须拒
      rawEntry(home, "bad-no-id.md", fmText({ kind: "decision", status: "explicit", subject: "缺 id 条目", scope: "global" }, "缺 id 正文。"));
      rawEntry(
        home,
        "20250101-000000-bad1.md",
        fmText(
          { id: "20250101-000000-bad1", kind: "decision", status: "explici", subject: "错状态条目", scope: "global", expires_at: "definitely-not-a-date" },
          "错状态正文。",
        ),
      );
      rawEntry(
        home,
        "20250101-000000-bad2.md",
        fmText(
          {
            id: "20250101-000000-bad2",
            kind: "nonsense",
            status: "explicit",
            subject: "非法类别条目",
            scope: "global;project:acme",
            action_impact: "maybe",
            confidence: "1.5",
          },
          "非法类别正文。",
        ),
      );
      rawEntry(home, "20250101-000000-warn1.md", fmText({ id: "20250101-000000-warn1", kind: "decision", status: "explicit", subject: "空 scope 条目" }, "空 scope 正文。"));
      // 同 id 两个文件：索引会出两行，lint 要检
      const dup = { id: "20250101-000000-dupe", kind: "decision", status: "explicit", subject: "重复 id 条目", scope: "global" };
      rawEntry(home, "dup-a.md", fmText(dup, "重复 id 正文 A。"));
      rawEntry(home, "dup-b.md", fmText({ ...dup, subject: "重复 id 条目 B" }, "重复 id 正文 B。"));

      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      // (a) 读路径：坏条目不拖垮简报/检索
      const b: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const brief = String(b?.systemPrompt ?? "");
      ok("坏条目不阻断简报", brief.includes("测试决策甲"), brief.split("\n").find((l) => l.includes("测试决策甲"))?.slice(0, 50));
      const list = out(await L.call("living_memory", { source: "entries", list: true }));
      ok("坏条目不阻断条目检索", list.includes("测试决策甲"), list.split("\n")[0]?.slice(0, 50));

      // (b) lint 必须按字段报出，且 error 排在 warn 前
      const lint = out(await L.call("living_memory", { source: "lint" }));
      ok("lint 报 id 缺失", lint.includes("字段 id") && /缺少 id/.test(lint), lint.split("\n").find((l) => l.includes("缺少 id"))?.slice(0, 80));
      ok("lint 报非法 status", lint.includes("字段 status") && lint.includes("explici"), lint.split("\n").find((l) => l.includes("字段 status"))?.slice(0, 80));
      ok("lint 报非法日期", lint.includes("字段 expires_at") && lint.includes("definitely-not-a-date"));
      ok("lint 报非法 kind", lint.includes("字段 kind") && lint.includes("nonsense"));
      ok("lint 报非法 scope", lint.includes("字段 scope") && lint.includes("global;project:acme"));
      ok("lint 报非法 action_impact", lint.includes("字段 action_impact") && lint.includes("maybe"), lint.split("\n").find((l) => l.includes("action_impact"))?.slice(0, 80));
      ok("lint 报非法 confidence", lint.includes("字段 confidence") && lint.includes("1.5"));
      ok("lint 报空 scope 为 warn", /\[warn\][^\n]*字段 scope/.test(lint), lint.split("\n").find((l) => l.includes("[warn]"))?.slice(0, 80));
      ok("lint 报同 id 多文件", /同一 id 出现在 2 个文件/.test(lint), lint.split("\n").find((l) => l.includes("同一 id"))?.slice(0, 100));
      ok("结构问题段有总数", /结构问题：检出 \d+ 条（error \d+ \/ warn \d+）/.test(lint), lint.split("\n").find((l) => l.includes("结构问题"))?.slice(0, 80));
      ok("error 排在 warn 之前", lint.indexOf("[error]") < lint.indexOf("[warn]"), `error@${lint.indexOf("[error]")} warn@${lint.indexOf("[warn]")}`);

      // (c) 写路径拒绝非法字段，并回原因；不落盘
      const before = fs.readdirSync(path.join(mem(home), "entries")).length;
      const badDate = out(
        await L.call("remember", { kind: "decision", subject: "非法日期主题", text: "非法日期正文", basis: "explicit", source: "test", expires_at: "definitely-not-a-date" }),
      );
      ok("remember 拒绝非法日期", /manifest 不合法/.test(badDate) && badDate.includes("expires_at"), badDate.slice(0, 100));
      const badKind = out(await L.call("remember", { kind: "nonsense", subject: "非法类别主题", text: "非法类别正文", basis: "explicit", source: "test" }));
      ok("remember 拒绝非法 kind", /manifest 不合法/.test(badKind) && badKind.includes("kind"), badKind.slice(0, 100));
      const badStatus = out(await L.call("remember", { kind: "decision", subject: "非法状态主题", text: "非法状态正文", basis: "explici", source: "test" }));
      ok("remember 拒绝非法 status", /manifest 不合法/.test(badStatus) && badStatus.includes("status"), badStatus.slice(0, 100));
      ok("被拒后没有落盘", fs.readdirSync(path.join(mem(home), "entries")).length === before, `${before} → ${fs.readdirSync(path.join(mem(home), "entries")).length}`);
      return;
    }
    case "manifest-frontmatter": {
      rawEntry(home, "broken-no-fm.md", "# 没有 frontmatter\n正文不该被当成条目。\n");
      rawEntry(
        home,
        "broken-unclosed.md",
        "---\nid: 20250101-000000-brok\nkind: decision\nstatus: explicit\nsubject: 未闭合条目\nscope: global\n正文缺少闭合分隔行。\n",
      );
      const L = await load(home, AUTO_OFF);
      await L.call("living_memory", { source: "entries", list: true });
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("正常条目仍在索引", (idx.rows ?? []).some((r: any) => r.id === "20260101-000001-a1b2") && (idx.rows ?? []).some((r: any) => r.id === "20260101-000002-c3d4"));
      ok("未闭合条目被跳过（不进索引）", !(idx.rows ?? []).some((r: any) => r.id === "20250101-000000-brok"));
      const lint = out(await L.call("living_memory", { source: "lint" }));
      ok("lint 报无 frontmatter", lint.includes("broken-no-fm.md") && lint.includes("缺少 frontmatter"), lint.split("\n").find((l) => l.includes("broken-no-fm"))?.slice(0, 80));
      ok("lint 报 frontmatter 未闭合", lint.includes("broken-unclosed.md") && lint.includes("未闭合"), lint.split("\n").find((l) => l.includes("broken-unclosed"))?.slice(0, 80));
      ok("结构问题总数 2", /结构问题：检出 2 条（error 2 \/ warn 0）/.test(lint), lint.split("\n").find((l) => l.includes("结构问题"))?.slice(0, 80));
      ok("坏条目不影响正常检索", out(await L.call("living_memory", { source: "entries", query: "测试决策甲" })).includes("测试决策甲"));
      return;
    }
    case "manifest-legacy-lenient": {
      rawEntry(
        home,
        "20250101-000000-leg1.md",
        fmText(
          {
            id: "20250101-000000-leg1",
            kind: "nonsense",
            status: "explici",
            subject: "遗留坏条目",
            scope: "global",
            source: "legacy fixture",
            obtained_at: "2025-01-01T00:00:00.000Z",
            confirmed_at: "",
            expires_at: "",
            review_after: "2025-13-40",
            confidence: "",
            action_impact: "advice-only",
          },
          "遗留坏条目正文。",
        ),
      );
      const L = await load(home, AUTO_OFF);
      const { setLogger } = await import("./under-test/living-memory.ts");
      const warns: string[] = [];
      setLogger({ activity: () => {}, debug: () => {}, warn: (m: string) => warns.push(m) });

      const lint0 = out(await L.call("living_memory", { source: "lint" }));
      ok("lint 报出遗留非法条目", lint0.includes("20250101-000000-leg1") && lint0.includes("字段 status"), lint0.split("\n").find((l) => l.includes("leg1"))?.slice(0, 80));

      const ex = out(await L.call("living_memory_update", { action: "expire", id: "20250101-000000-leg1" }));
      ok("expire 仍能执行", /已标记过期/.test(ex) && exists(home, "expired/20250101-000000-leg1.md"), ex.slice(0, 60));
      ok("expire 走 strict=false 并记 warning", warns.some((w) => w.includes("strict=false")), warns.join(" | ").slice(0, 120));

      const rn = out(await L.call("living_memory_update", { action: "renew", id: "20250101-000000-leg1" }));
      ok("renew 复活仍能执行", /已复活/.test(rn) && exists(home, "entries/20250101-000000-leg1.md"), rn.slice(0, 60));
      ok("resurrect 走 strict=false 并记 warning", warns.filter((w) => w.includes("strict=false")).length >= 2, `${warns.length} 条`);

      await L.call("living_memory_update", { action: "expire", id: "20250101-000000-leg1" });
      const rs = out(await L.call("living_memory_update", { action: "restore", id: "20250101-000000-leg1" }));
      ok("expire→restore 仍能执行", exists(home, "entries/20250101-000000-leg1.md"), rs.slice(0, 60));
      return;
    }
    case "routing": {
      const L = await load(home, AUTO_OFF);
      const r = out(await L.call("living_memory", { source: "routing" }));
      ok("输出分流审计头", /分流审计/.test(r), r.split("\n")[0].slice(0, 60));
      ok("A 段：过程性条目建议迁 summary", r.includes("超长条目戊"), r.split("\n").find((l) => l.includes("超长条目戊"))?.slice(0, 70));
      ok("B 段：summary 里的规则句建议升格", r.includes("决策小节") || /B\./.test(r), r.split("\n").find((l) => /B\./.test(l))?.slice(0, 60));
      return;
    }
    case "index-selfheal": {
      const L = await load(home, AUTO_OFF);
      for (const f of ["index.json", "summary-index.json", "todo-index.json"]) fs.rmSync(path.join(mem(home), f), { force: true });
      ok("三个索引已删干净", ["index.json", "summary-index.json", "todo-index.json"].every((f) => !exists(home, f)));
      const q = out(await L.call("living_memory", { source: "entries", query: "测试决策甲", list: true }));
      ok("删索引后检索仍可用", q.includes("测试决策甲"), q.split("\n")[0].slice(0, 40));
      ok("index.json 按需重建", exists(home, "index.json") && JSON.parse(read(home, "index.json")).rows.length >= 2);
      const before = read(home, "todo.md");
      await L.handlers.before_agent_start({ systemPrompt: "" }, mkCtx("/work/acme"));
      ok("todo-index 按需重建（简报触发）", exists(home, "todo-index.json") && read(home, "todo.md") === before);
      await L.call("living_memory", { source: "summary" });
      ok("summary-index 按需重建", exists(home, "summary-index.json"));
      fs.appendFileSync(path.join(mem(home), "summary.md"), "\n### [99] 外部手改小节\n<!-- src: manual -->\n外部手改正文。\n");
      const nav = out(await L.call("living_memory", { source: "summary" }));
      ok("手改 summary.md 被看见", nav.includes("外部手改小节"));
      return;
    }
    case "archive-guard": {
      const L = await load(home, { LIVING_MEMORY_QMD: "/bin/false", ...AUTO_OFF });
      const noQuery = out(await L.call("living_memory", { source: "archive" }));
      ok("无 query 给用法提示", /query/i.test(noQuery), noQuery.slice(0, 60));
      const q = out(await L.call("living_memory", { source: "archive", query: "随便" }));
      ok("qmd 缺失时给可读错误", /qmd|失败|不可用|无结果/.test(q), q.slice(0, 80));
      ok("不抛异常", checks.every((c) => c.ok) || true);
      return;
    }
    case "hints": {
      const L = await load(home, AUTO_OFF);
      // 已过期的条目要先真的落到 expired/ 才算“可归档候选”
      await L.call("living_memory_update", { action: "expire", id: "20260101-000002-c3d4" });
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const notes = ctx.notes.join(" | ");
      ok("提示过期可归档", /过期 \d+ 条可归档/.test(notes), notes.slice(0, 80));
      ok("提示已完成待办可归档", /已完成 \d+ 项可归档/.test(notes));
      const ctx2 = mkCtx("/work/acme");
      const L2 = await load(home, { LIVING_MEMORY_START_HINTS: "0", ...AUTO_OFF });
      await L2.handlers.session_start({ reason: "startup" }, ctx2);
      ok("START_HINTS=0 静默", ctx2.notes.length === 0, ctx2.notes.join("|"));
      return;
    }
    case "legacy-twin": {
      // ① 只剩大写：加载时改名为小写并保留内容（要在首次 load 之前造好状态，模块只加载一次）
      fs.rmSync(path.join(mem(home), "summary.md"), { force: true });
      fs.rmSync(path.join(mem(home), "todo.md"), { force: true });
      fs.writeFileSync(path.join(mem(home), "SUMMARY.md"), "# summary\n\n### [09] 大写遗留\n正文\n");
      fs.writeFileSync(path.join(mem(home), "TODO.md"), "# TODO\n\n- [ ] 遗留项\n");
      const L = await load(home, AUTO_OFF);
      ok("只剩大写时改名为小写", !exists(home, "SUMMARY.md") && exists(home, "summary.md") && !exists(home, "TODO.md") && exists(home, "todo.md"));
      ok("改名后内容还在", read(home, "summary.md").includes("大写遗留") && read(home, "todo.md").includes("遗留项"));
      // ② 大小写并存：模拟出“陈旧实例写回来的”孪生文件，session_start 按需探测并提示人工合并
      fs.writeFileSync(path.join(mem(home), "SUMMARY.md"), "# summary\n\n### [1] 陈旧写入\n");
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      ok("session_start 提示人工合并", ctx.notes.join("|").includes("大写孪生文件 SUMMARY.md"), ctx.notes.join("|").slice(0, 80));
      // ③ 孪生文件本身不被吞掉（人工要能核对内容）
      ok("大写孪生仍可读", read(home, "SUMMARY.md").includes("陈旧写入"));
      return;
    }
    case "profile": {
      const L = await load(home, AUTO_OFF);
      const dry = out(await L.call("living_memory_update", { action: "profile_rebuild" }));
      ok("default dry_run 只回块", /活动|STATS|条目/.test(dry) && !/已刷新|无变化/.test(dry), dry.split("\n")[0].slice(0, 50));
      const r1 = out(await L.call("living_memory_update", { action: "profile_rebuild", dry_run: false }));
      const p1 = read(home, "profile.md");
      ok("STATS 块写入条目数", /活动条目：2|活动 \d+ 条|[─|] \d+ ─/.test(p1) || p1.includes("2"), p1.split("\n").find((l) => /2/.test(l))?.slice(0, 40));
      ok("正文没被覆盖", p1.includes("## 一、决策风格"));
      const before = p1;
      const r2 = out(await L.call("living_memory_update", { action: "profile_rebuild", dry_run: false }));
      ok("幂等：第二次不写盘", read(home, "profile.md") === before || /无变化/.test(r2), r2.slice(0, 40));
      return;
    }
    case "promote": {
      // 本用例专门验证「推断 → 转正候选」链路，故把自动按事实门槛抬高，让 0.85 仍是推断
      const L = await load(home, { ...AUTO_OFF, LIVING_MEMORY_AUTO_FACT: "0.95" });
      const T = "转正主题：部署一律先跑测试。";
      const r1 = out(await L.call("remember", { kind: "preference", subject: "转正主题", text: T, basis: "inference", confidence: 0.85, source: "test-s1" }));
      const id = r1.match(/(\d{8}-\d{6}-\w{4})/)?.[1] ?? "";
      ok("推断写入成功", !!id && r1.includes("已记入"), r1.split("\n")[0].slice(0, 40));
      const r2 = out(await L.call("remember", { kind: "preference", subject: "转正主题", text: T, basis: "inference", confidence: 0.85, source: "test-s1" }));
      ok("同日同源去重", !r2.includes("已记入"), r2.split("\n")[0].slice(0, 40));
      const r2b = out(await L.call("remember", { kind: "preference", subject: "转正主题", text: T, basis: "inference", confidence: 0.85, source: "test-s1" }));
      ok("同源同日再次出现不再加证据", r2b.includes("已有同 subject+kind"), r2b.split("\n")[0].slice(0, 40));
      const r3 = out(await L.call("remember", { kind: "preference", subject: "转正主题", text: T, basis: "inference", confidence: 0.85, source: "test-s2" }));
      ok("异源记证据", r3.includes("证据 +1"), r3.split("\n")[0].slice(0, 50));
      const r4 = out(await L.call("remember", { kind: "preference", subject: "转正主题", text: T, basis: "explicit", source: "user" }));
      ok("原话重述记 restate", r4.includes("restate"), r4.split("\n")[0].slice(0, 50));
      const scan = out(await L.call("living_memory_update", { action: "promote_scan", match: "5" }));
      ok("扫描列出该条", scan.includes(id), scan.split("\n")[0].slice(0, 40));
      ok("越过门槛标记可转正", scan.includes("可转正"), scan.match(/[0-9.]+ 可转正[^\n]{0,20}/)?.[0]);
      const ent = read(home, `entries/${id}.md`);
      ok("evidence 落进 frontmatter", /evidence: .*"restate"/.test(ent), (ent.match(/evidence: [^\n]{0,40}/) ?? [""])[0].slice(0, 60));
      return;
    }
    case "profile-brief": {
      fs.writeFileSync(
        path.join(mem(home), "profile.md"),
        "# 画像\n\n## 三、对外口径\n\n> 本节会被压缩注入简报，只留一般口径（`20260101-000000-aaa`）\n\n- **对外文档用中文**，代码与提交信息用英文（`20260101-000000-bbb`）。\n- 报价与承诺先内部确认再对外（`20260101-000000-ccc`）。\n\n## 四、沟通与协作习惯\n\n- 先给结论，再给依据；不喜欢铺垫。\n- 表格优先于长段落。\n\n## 五、空白与待证\n\n- 暂无\n",
      );
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const off: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      ok("默认不注入画像", !String(off?.systemPrompt ?? "").includes("· 画像"), String(off?.systemPrompt ?? "").length);
      process.env.LIVING_MEMORY_PROFILE_BRIEF = "1";
      const on: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const txt = String(on?.systemPrompt ?? "");
      ok("开启后注入画像行", txt.includes("· 画像："), txt.match(/· 画像：[^\n]{0,30}/)?.[0]);
      ok("画像含第三/四节结论", /英文|先给结论/.test(txt), txt.match(/· 画像：.{0,60}/)?.[0]);
      ok("画像不含空占位", !/· 画像：[^\n]*暂无/.test(txt));
      const line = txt.split("\n").find((l) => l.includes("· 画像：" )) ?? "";
      ok("画像行剥掉引用与 markdown 装饰", !/[>*]|`/.test(line), line.slice(0, 60));
      ok("画像行去掉证据 id 括号", !/20\d{6}/.test(line), line.slice(0, 60));
      ok("画像行不超 200 字", line.length - 5 <= 200, `${line.length - 5} 字`);
      delete process.env.LIVING_MEMORY_PROFILE_BRIEF;
      return;
    }
    case "auto-fact": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");

      // ① 0.9 → 直接按事实（confirmed）
      const r1 = out(await L.call("remember", { kind: "preference", subject: "报告风格", text: "报告一律先给结论。", basis: "inference", confidence: 0.9, source: "fixture 高置信" }, ctx));
      ok("0.9 自动按事实", /status=confirmed/.test(r1), r1.split("\n")[0]);
      const id1 = r1.match(/已记入长期记忆 ([0-9]{8}-[0-9]{6}-[a-z0-9]{4})/)?.[1] ?? "";
      const p1 = path.join(mem(home), "entries", `${id1}.md`);
      ok(`${id1 || "<未解析到 id>"} 落盘存在`, id1 !== "" && fs.existsSync(p1), id1 || r1.split("\n")[0]);
      const txt1 = id1 !== "" && fs.existsSync(p1) ? fs.readFileSync(p1, "utf8") : "";
      ok("落盘 status=confirmed", /status: confirmed/.test(txt1), id1);
      ok("confirmed_at 已填", /confirmed_at: 2026/.test(txt1), id1);

      // ② 0.6 → 仍是推断（弱参考）
      const r2 = out(await L.call("remember", { kind: "preference", subject: "会议习惯", text: "会议纪要当天发。", basis: "inference", confidence: 0.6, source: "fixture 低置信" }, ctx));
      ok("0.6 保留推断", /status=inference/.test(r2), r2.split("\n")[0]);
      ok("回包说明弱参考", /弱参考/.test(r2), "");

      // ③ relation 即使 0.95 也不自动转事实
      const r3 = out(await L.call("remember", { kind: "relation", subject: "合作方联系人", text: "对方偏好邮件沟通。", basis: "inference", confidence: 0.95, source: "fixture 关系" }, ctx));
      ok("relation 不自动转事实", /status=inference/.test(r3), r3.split("\n")[0]);

      // ④ needs-confirm 即使 0.95 也不自动转事实
      const r4 = out(await L.call("remember", { kind: "decision", subject: "付款条件", text: "付款改为预付 30%。", basis: "inference", confidence: 0.95, action_impact: "needs-confirm", source: "fixture 需确认" }, ctx));
      ok("needs-confirm 不自动转事实", /status=inference/.test(r4), r4.split("\n")[0]);

      // ⑤ 简报：低于门槛的推断出现在「推断·弱」档
      const b: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const bt = String(b?.systemPrompt ?? "");
      ok("简报标出推断·弱", bt.includes("[推断·弱]"), bt.split("\n").find((l) => l.includes("推断·弱")) ?? "");
      ok("简报不再用宽泛的待确认档位", !/^\[待确认\]/m.test(bt), "");
      return;
    }
    case "auto-fact-retro": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      const seedEntry = (id: string, kind: string, conf: string, impact = "advice-only", subject = "报告风格") => {
        const dir = path.join(mem(home), "entries");
        fs.writeFileSync(
          path.join(dir, `${id}.md`),
          [
            "---",
            `id: ${id}`,
            `kind: ${kind}`,
            "status: inference",
            `subject: ${subject}`,
            "scope: global",
            "source: fixture 存量推断",
            "obtained_at: 2026-01-01T00:00:00.000Z",
            "confirmed_at: ",
            "expires_at: ",
            "review_after: 2026-12-01",
            `confidence: ${conf}`,
            `action_impact: ${impact}`,
            "supersedes: ",
            "evidence: ",
            "---",
            "",
            `${subject}：先给结论再给依据。`,
            "",
          ].join("\n"),
        );
      };
      seedEntry("20260101-000000-rtr1", "preference", "0.9");
      seedEntry("20260101-000000-rtr2", "decision", "0.6", "advice-only", "会议习惯");
      seedEntry("20260101-000000-rtr3", "relation", "0.95", "advice-only", "合作方联系人");
      seedEntry("20260101-000000-rtr4", "decision", "0.95", "needs-confirm", "付款条件");

      // 真实世界的坑：旧格式索引（无 v / 无 confidence）而 stamp 恰好匹配 → 必须判为过期并重建
      const dir = path.join(mem(home), "entries");
      const count = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
      const legacyStamp = `${fs.statSync(dir).mtimeMs}|${count}`;
      fs.writeFileSync(
        path.join(mem(home), "index.json"),
        JSON.stringify({ stamp: legacyStamp, rows: [{ id: "20260101-000000-rtr1", meta: { id: "20260101-000000-rtr1", status: "inference" }, title: "旧索引行" }] }),
      );

      await L.handlers.session_start({ reason: "startup" }, ctx);
      const read1 = (id: string) => fs.readFileSync(path.join(mem(home), "entries", `${id}.md`), "utf8");
      ok("conf 0.9 追溯转为 confirmed", /status: confirmed/.test(read1("20260101-000000-rtr1")), read1("20260101-000000-rtr1").match(/status: \w+/)?.[0]);
      ok("conf 0.6 仍是 inference", /status: inference/.test(read1("20260101-000000-rtr2")), "");
      ok("relation 0.95 不追溯", /status: inference/.test(read1("20260101-000000-rtr3")), "");
      ok("needs-confirm 0.95 不追溯", /status: inference/.test(read1("20260101-000000-rtr4")), "");
      ok("开屏提示含自动按事实", /自动按事实处理/.test(ctx.notes.join(" | ")), ctx.notes.join(" | ").slice(0, 60));
      const idx = JSON.parse(fs.readFileSync(path.join(mem(home), "index.json"), "utf8"));
      ok("旧格式索引被重建（带 v=4）", idx.v === 4, `v=${idx.v}`);
      ok("重建后索引含 confidence", idx.rows.some((r: any) => r.id === "20260101-000000-rtr1" && r.meta.confidence === "0.9"), "");
      return;
    }
    case "auto-fact-evidence": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      const withEvidence = (id: string, conf: string, ev: Array<{ at: string; kind: string; id?: string }>) => {
        const dir = path.join(mem(home), "entries");
        fs.writeFileSync(
          path.join(dir, `${id}.md`),
          [
            "---",
            `id: ${id}`,
            "kind: preference",
            "status: inference",
            `subject: 汇报口径 ${id.slice(-4)}`,
            "scope: global",
            "source: fixture 证据累积",
            "obtained_at: 2026-01-01T00:00:00.000Z",
            "confirmed_at: ",
            "expires_at: ",
            "review_after: 2026-12-01",
            `confidence: ${conf}`,
            "action_impact: advice-only",
            "supersedes: ",
            `evidence: ${JSON.stringify(ev)}`,
            "---",
            "",
            "汇报先给结论，细节放后面（无含糊词）。",
            "",
          ].join("\n"),
        );
      };
      // 三天 repeat + 一次 restate → 分 ≥0.8，应自动成事实
      withEvidence("20260101-000000-evd1", "0.6", [
        { at: "2026-01-01T00:00:00.000Z", kind: "repeat", id: "s1" },
        { at: "2026-01-02T00:00:00.000Z", kind: "repeat", id: "s2" },
        { at: "2026-01-03T00:00:00.000Z", kind: "restate", id: "s3" },
      ]);
      // 只有两天、无 restate → 分不够，保持推断
      withEvidence("20260101-000000-evd2", "0.6", [
        { at: "2026-01-01T00:00:00.000Z", kind: "repeat", id: "s1" },
        { at: "2026-01-02T00:00:00.000Z", kind: "repeat", id: "s2" },
      ]);

      await L.handlers.session_start({ reason: "startup" }, ctx);
      const read1 = (id: string) => fs.readFileSync(path.join(mem(home), "entries", `${id}.md`), "utf8");
      ok("证据≥3天且分够→confirmed", /status: confirmed/.test(read1("20260101-000000-evd1")), "");
      ok("两天证据仍为 inference", /status: inference/.test(read1("20260101-000000-evd2")), "");
      ok("记录 auto-fact evidence", /auto-fact evidence/.test(fs.readFileSync(path.join(mem(home), "activity.log"), "utf8")), "");
      // 关闭开关后不再自动转（用同一库再跑一次应在提示里无声）
      const off = { ...AUTO_OFF, LIVING_MEMORY_AUTO_FACT_EVIDENCE: "0" };
      const L2 = await load(home, off);
      const ctx2 = mkCtx("/work/acme");
      await L2.handlers.session_start({ reason: "startup" }, ctx2);
      ok("开关 0 时不提示自动按事实", !/自动按事实处理/.test(ctx2.notes.join(" | ")), ctx2.notes.join(" | ").slice(0, 40));
      return;
    }
    case "index-toks": {
      const dir = path.join(mem(home), "entries");
      const stamp = () => `${fs.statSync(dir).mtimeMs}|${fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length}`;
      const idxFile = path.join(mem(home), "index.json");
      // 造假旧索引：stamp 完全匹配，但 v=1 且没有 toks——必须被格式闸门判过期
      fs.writeFileSync(
        idxFile,
        JSON.stringify({ v: 1, stamp: stamp(), rows: [{ id: "20260101-000001-a1b2", meta: { id: "20260101-000001-a1b2", status: "explicit", subject: "旧索引" }, title: "旧索引" }] }),
      );
      const L = await load(home, AUTO_OFF);
      const q = out(await L.call("living_memory", { source: "entries", query: "测试决策甲" }));
      ok("旧索引仍可检索", q.includes("测试决策甲"), q.split("\n")[0].slice(0, 40));
      const idx = JSON.parse(read(home, "index.json") || "{}");
      ok("重建后顶层 v=4", idx.v === 4, `v=${idx.v}`);
      ok("旧 v=1 行被替换", !idx.rows.some((r: any) => r.title === "旧索引"), `rows=${idx.rows?.length}`);
      ok("每行都有 toks 数组", idx.rows.every((r: any) => Array.isArray(r.toks)), `rows=${idx.rows?.length}`);
      const row = idx.rows.find((r: any) => r.id === "20260101-000001-a1b2");
      ok("subject 中文 bigram 入词元", ["测试", "试决", "决策", "策甲"].every((t) => row?.toks?.includes(t)), (row?.toks ?? []).join(","));
      ok("toks 字典序去重", idx.rows.every((r: any) => JSON.stringify([...new Set(r.toks)].sort()) === JSON.stringify(r.toks)));
      ok("toks 上限 40", idx.rows.every((r: any) => r.toks.length <= 40), Math.max(...idx.rows.map((r: any) => r.toks.length)));
      // 写路径：upsert 必须带 toks，删除必须只删那一行
      const r1 = out(await L.call("remember", { kind: "decision", subject: "索引词元写入", text: "索引词元写入：验证 upsert。", basis: "explicit", source: "test" }));
      const nid = r1.match(/(\d{8}-\d{6}-\w{4})/)?.[1] ?? "";
      const idx2 = JSON.parse(read(home, "index.json") || "{}");
      const nrow = idx2.rows.find((r: any) => r.id === nid);
      ok("upsert 行带 toks", Array.isArray(nrow?.toks) && nrow.toks.includes("索引"), (nrow?.toks ?? []).slice(0, 4).join(","));
      await L.call("living_memory_update", { action: "delete", id: nid });
      const idx3 = JSON.parse(read(home, "index.json") || "{}");
      ok("删除只移除对应行", !idx3.rows.some((r: any) => r.id === nid) && idx3.rows.some((r: any) => r.id === "20260101-000001-a1b2"));
      // 同 v=3 但缺 toks 的索引也必须重建（否则召回会拿空词元静默失效）
      fs.writeFileSync(
        path.join(dir, "20260101-000003-t0k5.md"),
        "---\nid: 20260101-000003-t0k5\nkind: decision\nstatus: explicit\nsubject: 词元校验\nscope: global\nobtained_at: 2026-01-01T00:00:00.000Z\n---\n词元校验正文。\n",
      );
      fs.writeFileSync(idxFile, JSON.stringify({ v: 3, stamp: stamp(), rows: idx3.rows.map(({ toks, ...rest }: any) => rest) }));
      const q2 = out(await L.call("living_memory", { source: "entries", query: "词元校验" }));
      const idx4 = JSON.parse(read(home, "index.json") || "{}");
      ok("v=3 但缺 toks 也重建", q2.includes("词元校验") && idx4.rows.some((r: any) => r.id === "20260101-000003-t0k5" && Array.isArray(r.toks)), `rows=${idx4.rows?.length}`);
      return;
    }
    case "recall-rank": {
      addGlobal(home, { id: "20251231-999999-rclt", subject: "npm 发布时的 2FA 要求", body: "npm 发布时要输入验证码，发布前检查 2FA。" });
      addGlobal(home, { id: "20260101-000000-r001", subject: "发布流程记录", body: "发布流程记录：常规检查清单。" });
      addGlobal(home, { id: "20260101-000000-r002", subject: "验证接口联调", body: "验证接口联调：测试环境地址。" });
      addGlobal(home, { id: "20260101-000000-r003", subject: "验证码样式", body: "验证码样式：六位数字。" });
      for (const [id, subject] of [["20260101-000020-u020", "周报模板"], ["20260101-000030-u030", "会议纪要"], ["20260101-000040-u040", "磁盘配额"]] as const)
        addGlobal(home, { id, subject, body: `${subject}正文：与本轮问题无关。` });
      const L = await load(home, AUTO_OFF);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE", prompt: "发布要验证码" }, mkCtx("/work/acme"));
      const txt = String(r?.systemPrompt ?? "");
      const seg = recallSeg(txt);
      ok("召回段存在", seg.length > 0, txt.slice(-80));
      ok("中文模糊说法命中目标 subject", seg.includes("npm 发布时的 2FA 要求"), seg.slice(0, 100));
      ok("目标排在相关干扰条目之前", seg.indexOf("npm 发布时的 2FA 要求") >= 0 && (seg.indexOf("验证码样式") < 0 || seg.indexOf("npm 发布时的 2FA 要求") < seg.indexOf("验证码样式")), seg.slice(0, 120));
      ok("最多 3 条", recallItems(seg).length >= 1 && recallItems(seg).length <= 3, `${recallItems(seg).length} 条`);
      ok("每条附 id 前 8 位", recallItems(seg).every((it) => /\(\d{8}\)$/.test(it)), recallItems(seg).join(" | ").slice(0, 80));
      ok("目标只在召回段（未进分档）", txt.indexOf("npm 发布时的 2FA 要求") > txt.indexOf("· 召回（按本轮提问）："), `${txt.indexOf("npm 发布时的 2FA 要求")}/${txt.indexOf("· 召回（按本轮提问）：")}`);
      const ctx2: any = mkCtx("/work/acme");
      ctx2.sessionManager = {
        getEntries: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "发布要验证码" }] } }],
      };
      const r2: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx2);
      ok("事件无 prompt 时退到会话最后一条 user 消息", recallSeg(String(r2?.systemPrompt ?? "")).includes("npm 发布时的 2FA 要求"), recallSeg(String(r2?.systemPrompt ?? "")).slice(0, 80));
      return;
    }
    case "recall-limits": {
      for (const n of [1, 2, 3, 4]) {
        const id = `20251230-999999-l00${n}`;
        addGlobal(home, { id, subject: `候选${n}：${"发布要验证码".repeat(30)}`, body: "发布要验证码的验证流程记录。" });
      }
      for (let i = 0; i < 6; i++) {
        const id = `20260101-0001${String(i).padStart(2, "0")}-u1${String(i).padStart(2, "0")}`;
        addGlobal(home, { id, subject: `无关条目${i}`, body: `无关条目${i}正文。` });
      }
      const L = await load(home, AUTO_OFF);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE", prompt: "发布要验证码" }, mkCtx("/work/acme"));
      const txt = String(r?.systemPrompt ?? "");
      const seg = recallSeg(txt);
      const items = recallItems(seg);
      ok("召回段长度 ≤300", seg.length > 0 && seg.length <= 300, `${seg.length} 字符`);
      ok("召回条数 ≤3", items.length >= 1 && items.length <= 3, `${items.length} 条`);
      ok("每条 subject ≤80 字符", items.every((it) => ((it.match(/^\[([^\]]*)\]/) ?? [])[1] ?? "").length <= 80), items.map((it) => (it.match(/^\[([^\]]*)\]/) ?? [])[1]?.length).join(","));
      ok("每条带 id 前 8 位", items.every((it) => /\(\d{8}\)$/.test(it)));
      ok("长 subject 被截断而不是整条丢弃", seg.includes("发布要验证码") && items.length === 3, `${items.length} 条 / ${seg.length} 字符`);
      return;
    }
    case "recall-dedup": {
      addGlobal(home, { id: "20251231-999999-dd01", subject: "测试决策乙", body: "测试决策乙正文：复核记录。" });
      for (let i = 0; i < 4; i++) {
        const id = `20260101-00002${i}-u2${String(i).padStart(2, "0")}`;
        addGlobal(home, { id, subject: `无关条目${i}`, body: `无关条目${i}正文。` });
      }
      const L = await load(home, AUTO_OFF);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE", prompt: "测试决策" }, mkCtx("/work/acme"));
      const txt = String(r?.systemPrompt ?? "");
      const seg = recallSeg(txt);
      ok("召回补上未进分档的同主题条目", seg.includes("测试决策乙"), seg.slice(0, 80));
      ok("简报已含条目不再重复召回", !seg.includes("测试决策甲") && txt.split("\n").filter((l) => l.includes("测试决策甲")).length === 1, `行数 ${txt.split("\n").filter((l) => l.includes("测试决策甲")).length}`);
      ok("去重后仍只回未含条目", seg.indexOf("测试决策乙") > 0 && !seg.includes("20260101-000001-a1b2"));
      return;
    }
    case "recall-off": {
      addGlobal(home, { id: "20251231-999999-dd01", subject: "测试决策乙", body: "测试决策乙正文：复核记录。" });
      for (let i = 0; i < 4; i++) {
        const id = `20260101-00002${i}-u2${String(i).padStart(2, "0")}`;
        addGlobal(home, { id, subject: `无关条目${i}`, body: `无关条目${i}正文。` });
      }
      const L = await load(home, { LIVING_MEMORY_RECALL: "0", ...AUTO_OFF });
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE", prompt: "测试决策" }, mkCtx("/work/acme"));
      const txt = String(r?.systemPrompt ?? "");
      ok("关闭后仍注入简报", txt.includes("长期记忆"), txt.slice(0, 40));
      ok("关闭后没有召回段", !txt.includes("· 召回"), txt.slice(-80));
      ok("关闭后未进分档的条目仍不出现", !txt.includes("测试决策乙"), `len=${txt.length}`);
      return;
    }
    case "recall-stopword": {
      // 23 条语料：域名 df=3/26 >5% 被过滤；真正相关的 npm 条目靠 ASCII 词元仍能召回
      addGlobal(home, { id: "20251231-999001-sw01", subject: "域名注册备忘", body: "域名注册与续费由用户自己处理。" });
      addGlobal(home, { id: "20251231-999002-sw02", subject: "英文内容站排期", body: "英文站点的域名与证书。" });
      addGlobal(home, { id: "20251231-999003-sw03", subject: "用户偏好清单", body: "用户登记的域名偏好。" });
      addGlobal(home, { id: "20251231-999004-sw04", subject: "npm 发布验证码处理", body: "npm 发布时的验证码：用 staging 设备走 CLI。" });
      addFillers(home, 20);
      const L = await load(home, AUTO_OFF);
      const miss = await recallOf(L, "域名在哪里注册");
      ok("中文高频词被过滤后不召回", miss === "", miss.slice(0, 80));
      ok("单个高频中文词查询也直接返回空", (await recallOf(L, "域名")) === "", "");
      const hit = await recallOf(L, "npm 发布要验证码");
      ok("npm 发布要验证码仍召回正确条目", hit.includes("npm 发布验证码处理"), hit.slice(0, 100));
      ok("只召回这一条", recallItems(hit).length === 1, `${recallItems(hit).length} 条`);
      return;
    }
    case "recall-ascii-exempt": {
      // npm(6/25)、staging(4/25)、2fa(4/28) 都超 5%，但都是技术标识符：不参与中文闸门，仍能靠它们打分
      for (let i = 0; i < 5; i++)
        addGlobal(home, { id: `20251231-99910${i}-nx0${i}`, subject: `npm 噪声条目${i}`, body: `npm 噪声记录${i}。` });
      for (let i = 0; i < 3; i++)
        addGlobal(home, { id: `20251231-99920${i}-st0${i}`, subject: `staging 设备${i}`, body: `staging 设备记录${i}。` });
      for (let i = 0; i < 3; i++)
        addGlobal(home, { id: `20251231-99930${i}-tf0${i}`, subject: `2fa 设备${i}`, body: `2fa 设备记录${i}。` });
      addGlobal(home, { id: "20251231-999401-as01", subject: "npm staging 发布流程", body: "npm staging 发布流程的设备分工。" });
      addGlobal(home, { id: "20251231-999402-as02", subject: "npm 2fa 验证方式", body: "npm 账号的 2fa 验证方式。" });
      addFillers(home, 14);
      const L = await load(home, AUTO_OFF);
      const staging = await recallOf(L, "npm staging");
      ok("高频 npm/staging 仍参与打分并召开发布流程", staging.includes("npm staging 发布流程"), staging.slice(0, 100));
      ok("单命中 npm 噪声条目不召回", recallItems(staging).length === 1, `${recallItems(staging).length} 条`);
      const twofa = await recallOf(L, "npm 2fa");
      ok("高频 npm/2fa 仍参与打分并召回验证方式", twofa.includes("npm 2fa 验证方式"), twofa.slice(0, 100));
      return;
    }
    case "recall-single-token": {
      // 语料 66 条，df=1 时 idf ≈3.8（≥3.5）：只有 ASCII 专名能过，中文单命中与普通 ASCII 词都不行
      addGlobal(home, { id: "20251231-999501-tau1", subject: "tauri 打包构建", body: "tauri 打包构建配置。" });
      addGlobal(home, { id: "20251231-999502-rel1", subject: "release 版本记录一", body: "release 版本记录一。" });
      addGlobal(home, { id: "20251231-999503-rel2", subject: "release 版本记录二", body: "release 版本记录二。" });
      addGlobal(home, { id: "20251231-999504-iso1", subject: "隔离策略备忘", body: "隔离策略说明。" });
      addFillers(home, 60);
      const L = await load(home, AUTO_OFF);
      ok("中文单命中即使 idf ≥3.5 也不召回", (await recallOf(L, "隔离")) === "", "");
      ok("ASCII 普通词单命中 idf <3.5 不召回", (await recallOf(L, "release")) === "", "");
      const ascii = await recallOf(L, "tauri");
      ok("ASCII 专名单命中 idf ≥3.5 召回", ascii.includes("tauri 打包构建"), ascii.slice(0, 100));
      return;
    }
    case "recall-hitcount": {
      // 英文 4/43 >5% 被过滤；A 命中「英文+岗位」但只有岗位计分 → 1 命中丢弃；B 命中「岗位+简历」→ 2 命中召回
      addGlobal(home, { id: "20251231-999601-hc01", subject: "英文岗位说明", body: "面向英文岗位的说明。" });
      addGlobal(home, { id: "20251231-999602-hc02", subject: "岗位职责与简历", body: "岗位职责与简历要点。" });
      for (let i = 0; i < 3; i++)
        addGlobal(home, { id: `20251231-99970${i}-en0${i}`, subject: `英文内容站${i}`, body: `英文站点记录${i}。` });
      addFillers(home, 36);
      const L = await load(home, AUTO_OFF);
      const filtered = await recallOf(L, "英文 岗位");
      ok("被过滤的「英文」不计入命中数", filtered === "", filtered.slice(0, 80));
      const two = await recallOf(L, "岗位简历");
      ok("2 个有效词元命中仍召回", two.includes("岗位职责与简历"), two.slice(0, 100));
      ok("只命中岗位的条目不召回", !two.includes("英文岗位说明"), two.slice(0, 100));
      return;
    }
    case "recall-ascii-short": {
      // 2 字母技术缩写（ai/ci/pr/ui/db/ss）走白名单进索引；非白名单的 2 字母词（qa/is/to）仍被丢弃
      addGlobal(home, { id: "20251231-999801-sh01", subject: "PR 评审流程", body: "PR 评审流程与合并约定。" });
      addGlobal(home, { id: "20251231-999802-sh02", subject: "AI 配图规范", body: "AI 配图规范：白底、WebP、1200 宽。" });
      addGlobal(home, { id: "20251231-999803-sh03", subject: "CI 失败排查", body: "CI 失败排查步骤。" });
      addGlobal(home, { id: "20251231-999804-sh04", subject: "DB 迁移脚本", body: "DB 迁移脚本按版本号排序。" });
      addGlobal(home, { id: "20251231-999805-sh05", subject: "QA 检查清单", body: "QA 检查清单（无白名单，qa 不进索引）。" });
      addFillers(home, 40);
      const L = await load(home, AUTO_OFF);
      const pr = await recallOf(L, "PR 评审");
      ok("2 字母白名单 pr 可召回", pr.includes("PR 评审流程"), pr.slice(0, 100));
      const ai = await recallOf(L, "AI 配图");
      ok("2 字母白名单 ai 可召回", ai.includes("AI 配图规范"), ai.slice(0, 100));
      const ci = await recallOf(L, "CI 失败");
      ok("2 字母白名单 ci 可召回", ci.includes("CI 失败排查"), ci.slice(0, 100));
      const db = await recallOf(L, "DB 迁移");
      ok("2 字母白名单 db 可召回", db.includes("DB 迁移脚本"), db.slice(0, 100));
      const qa = await recallOf(L, "QA 检查");
      ok("非白名单 2 字母词不进索引（只剩中文单命中，不召回）", qa === "", qa.slice(0, 80));
      return;
    }
    case "recall-k1": {
      const { rankRecall } = await import("./under-test/src/recall.ts");
      const corpus = await recallKCorpus();
      const full = rankRecall("npm staging 发布", corpus, undefined, 99);
      const one = rankRecall("npm staging 发布", corpus, undefined, 1);
      ok("k=1 只回 1 条", one.length === 1, `${one.length} 条`);
      ok("k=1 是完整排序的首条", one[0]?.id === full[0]?.id, `${one[0]?.id} / ${full[0]?.id}`);
      return;
    }
    case "recall-k3": {
      const { rankRecall } = await import("./under-test/src/recall.ts");
      const corpus = await recallKCorpus();
      const dflt = rankRecall("npm staging 发布", corpus);
      const three = rankRecall("npm staging 发布", corpus, undefined, 3);
      ok("默认 k=3 回 3 条", dflt.length === 3, `${dflt.length} 条`);
      ok("显式 k=3 与默认一致", JSON.stringify(dflt.map((h: any) => h.id)) === JSON.stringify(three.map((h: any) => h.id)), `${dflt.length}/${three.length} 条`);
      return;
    }
    case "recall-k5": {
      const { rankRecall } = await import("./under-test/src/recall.ts");
      const corpus = await recallKCorpus();
      const full = rankRecall("npm staging 发布", corpus, undefined, 99);
      const five = rankRecall("npm staging 发布", corpus, undefined, 5);
      ok("k=5 回 5 条", five.length === 5, `${five.length} 条`);
      ok("k=5 是完整排序前缀", JSON.stringify(five.map((h: any) => h.id)) === JSON.stringify(full.slice(0, 5).map((h: any) => h.id)), `${five.length}/${full.length} 条`);
      return;
    }
    case "recall-k-over": {
      const { rankRecall } = await import("./under-test/src/recall.ts");
      const corpus = await recallKCorpus();
      const full = rankRecall("npm staging 发布", corpus, undefined, 99);
      const five = rankRecall("npm staging 发布", corpus, undefined, 5);
      ok("k 大于候选数时返回全部候选", full.length === corpus.length, `${full.length}/${corpus.length} 条`);
      ok("超量 k 不改变前 5 顺序", JSON.stringify(full.slice(0, 5).map((h: any) => h.id)) === JSON.stringify(five.map((h: any) => h.id)), `${full.length}/${five.length} 条`);
      return;
    }
    case "miss-log": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/acme");
      const miss = () => read(home, "miss.log").split("\n").filter(Boolean);
      out(await L.call("living_memory", { source: "entries", query: "测试决策甲" }, ctx));
      ok("命中不写 miss.log", !exists(home, "miss.log"), `${miss().length} 行`);
      out(await L.call("living_memory", { source: "entries", query: "完全不存在的词" }, ctx));
      const one = miss();
      ok("零命中写一行", one.length === 1, `${one.length} 行`);
      ok("行含 ISO 时间 / q / cwd / scope", /^\d{4}-\d{2}-\d{2}T[^|]+\| q=完全不存在的词 \| cwd=acme \| scope=-$/.test(one[0] ?? ""), (one[0] ?? "").slice(0, 120));
      out(await L.call("living_memory", { source: "entries", query: "缺口的词", scope: "project:acme" }, ctx));
      ok("scope 参数写进日志", miss()[1]?.includes("scope=project:acme"), (miss()[1] ?? "").slice(0, 120));
      out(await L.call("living_memory", { source: "entries", query: "甲" }, ctx));
      ok("单字符不记", miss().length === 2, `${miss().length} 行`);
      out(await L.call("living_memory", { source: "entries", query: "测试约束乙", scope: "project:acme" }, ctx));
      ok("scope 过滤能命中且不记", miss().length === 2, `${miss().length} 行`);
      process.env.LIVING_MEMORY_MISS_LOG = "0";
      out(await L.call("living_memory", { source: "entries", query: "关闭后的缺口词" }, ctx));
      ok("LIVING_MEMORY_MISS_LOG=0 完全不写", miss().length === 2, `${miss().length} 行`);
      delete process.env.LIVING_MEMORY_MISS_LOG;
      fs.writeFileSync(path.join(mem(home), "miss.log"), Array.from({ length: 205 }, (_, i) => `line ${i}`).join("\n") + "\n");
      out(await L.call("living_memory", { source: "entries", query: "触发截断的词" }, ctx));
      const trimmed = miss();
      ok("超 200 行截断为最后 200", trimmed.length === 200, `${trimmed.length} 行`);
      ok("新行保留在末尾", trimmed[199]?.includes("q=触发截断的词"), (trimmed[199] ?? "").slice(0, 80));
      return;
    }
    case "negation": {
      const L = await load(home, AUTO_OFF);
      writeEntry(home, { id: "20260101-000000-nnn1", kind: "preference", subject: "汇报口径", body: "汇报口径：先说结论，细节放后面。" });
      writeEntry(home, { id: "20260101-000000-nnn2", kind: "constraint", subject: "对外邮件", body: "对外邮件：不要抄送无关的人，别把内部猜测写进去。" });
      writeEntry(home, { id: "20260101-000000-nnn3", kind: "constraint", subject: "代码提交", body: "代码提交：禁止把 debug 代码一起提交。" });
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      const txt = String(r?.systemPrompt ?? "");
      ok("雷区行带 [雷区] 标记", txt.includes("[雷区]"), txt.match(/\[雷区\][^\n]{0,30}/)?.[0]);
      const iNeg = txt.indexOf("[雷区]");
      const iPlain = txt.indexOf("汇报口径");
      ok("雷区排在普通偏好之前", iNeg >= 0 && (iPlain < 0 || iNeg < iPlain), `${iNeg}/${iPlain}`);
      ok("雷区条数与命中一致", (txt.match(/\[雷区\]/g) ?? []).length >= 2, (txt.match(/\[雷区\]/g) ?? []).length);
      return;
    }
    case "style-scan": {
      const L = await load(home, AUTO_OFF);
      await L.call("remember", { kind: "constraint", subject: "对外邮件", text: "对外邮件：不要抄送无关的人。", basis: "explicit", source: "test" });
      await L.call("remember", { kind: "preference", subject: "回复风格", text: "回复风格：先给结论，再给依据。", basis: "explicit", source: "test" });
      const r = out(await L.call("living_memory_update", { action: "style_scan", match: "30" }));
      ok("列出窗口内条目数", /近 30 天：活动条目新增\/更新 \d+ 条/.test(r), r.split("\n")[0].slice(0, 50));
      ok("雷区小节出现", r.includes("雷区"), r.split("\n").slice(0, 3).join(" | "));
      ok("带证据 id", /（\d{8}-\d{6}-\w{4}）/.test(r), (r.match(/（(\d{8}-\d{6}-\w{4})）/g) ?? []).slice(0, 2).join(","));
      ok("给出归纳指引", r.includes("profile.md"), r.split("\n").slice(-2).join(" | ").slice(0, 60));
      ok("写入归纳戳", fs.existsSync(path.join(mem(home), "profile-style.last")), "profile-style.last");
      return;
    }
    case "extract-fail": {
      const L = await load(home, AUTO_OFF);
      const empty = out(await L.call("living_memory", { source: "extract" }));
      ok("无失败时给结论", /没有失败记录/.test(empty), empty.split("\n")[0]);
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
      fs.writeFileSync(
        path.join(mem(home), "extract-failures.jsonl"),
        [
          JSON.stringify({ ts: hoursAgo(1), reason: "request-failed", detail: "429 Too Many Requests" }),
          JSON.stringify({ ts: hoursAgo(2), reason: "parse-failed", detail: "JSON 解析失败：[{kind:decision" }),
          JSON.stringify({ ts: hoursAgo(24 * 10), reason: "empty-response", detail: "回包无文本" }),
        ].join("\n") + "\n",
      );
      fs.appendFileSync(path.join(mem(home), "activity.log"), `[${hoursAgo(3)}] auto-extract created 20260101-000003-e5f6 kind=decision (user)\n`);
      const t = out(await L.call("living_memory", { source: "extract" }));
      ok("近 7 天只算最近两条", /近 7 天失败 2 次/.test(t), t.split("\n")[0]);
      ok("按原因分类计数", /request-failed 1/.test(t) && /parse-failed 1/.test(t), t.match(/（[^）]*）/)?.[0]);
      ok("明细含原文片段", t.includes("429 Too Many Requests") && t.includes("JSON 解析失败"));
      ok("对照最近一次成功", /最近一次成功\/跳过/.test(t) && t.includes("auto-extract created"));
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const hint = ctx.notes.join(" | ");
      ok("开屏提示含失败次数", /抽取 24h 内失败 2 次/.test(hint), hint.slice(0, 80));
      return;
    }
    case "lock": {
      if (process.env.TEST_CHILD === "1") {
        const L = await load(home, AUTO_OFF);
        for (let i = 0; i < 8; i++) await L.call("living_memory_update", { action: "todo_add", text: `并发条目 ${process.env.TEST_TAG}-${i}` });
        return;
      }
      const self = new URL(import.meta.url).pathname;
      const kids = ["A", "B"].map((tag) =>
        Bun.spawn([process.execPath, self, "lock"], {
          env: { ...process.env, TEST_HOME: home, TEST_CHILD: "1", TEST_TAG: tag },
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      await Promise.all(kids.map((k) => k.exited));
      const todo = read(home, "todo.md");
      const added = count(todo, /并发条目 (A|B)-\d/gm);
      ok("两进程写入都保留", added === 16, `${added}/16 条`);
      ok("无重复条目", new Set(todo.match(/并发条目 (A|B)-\d/g) ?? []).size === 16);
      ok("未丢原始待办", todo.includes("待办甲") && todo.includes("待办丁"));
      return;
    }
    case "clock-freeze": {
      const L = await load(home, AUTO_OFF);
      const { setClock } = await import("./under-test/living-memory.ts");
      // 三条只差 review_after 的条目：早于 / 等于 / 晚于冻结日
      writeEntry(home, { id: "20260110-000001-ck01", subject: "复核早于冻结日", review_after: "2026-01-10", body: "早于冻结日的复核正文。" });
      writeEntry(home, { id: "20260110-000002-ck02", subject: "复核等于冻结日", review_after: "2026-01-15", body: "等于冻结日的复核正文。" });
      writeEntry(home, { id: "20260110-000003-ck03", subject: "复核晚于冻结日", review_after: "2026-01-20", body: "晚于冻结日的复核正文。" });
      const freeze = (day: string) => setClock({ now: () => Date.parse(`${day}T00:00:00Z`), today: () => day });
      const briefAt = async (day: string) => {
        freeze(day);
        const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, mkCtx("/work/acme"));
        return String(r?.systemPrompt ?? "");
      };
      const dueLines = (txt: string) => txt.split("\n").filter((l) => l.startsWith("[到期] "));
      const has = (txt: string, subject: string) => dueLines(txt).some((l) => l.includes(subject));
      const before = await briefAt("2026-01-09");
      ok("冻结到复核日之前：三条都不进到期档", !has(before, "复核"), dueLines(before).join(" | ").slice(0, 100));
      const onDay = await briefAt("2026-01-15");
      ok("冻结到当天：早于/等于进到期档", has(onDay, "复核早于冻结日") && has(onDay, "复核等于冻结日"), dueLines(onDay).join(" | ").slice(0, 120));
      ok("冻结到当天：晚于不进到期档", !has(onDay, "复核晚于冻结日"), dueLines(onDay).join(" | ").slice(0, 120));
      const after = await briefAt("2026-01-21");
      ok(
        "冻结到之后：三条都进到期档",
        ["复核早于冻结日", "复核等于冻结日", "复核晚于冻结日"].every((x) => has(after, x)),
        dueLines(after).join(" | ").slice(0, 120),
      );
      // 策略写入也走同一个时钟：续期默认 +30 天，不读墙上时钟
      freeze("2026-01-15");
      const rn = out(await L.call("living_memory_update", { action: "renew", id: "20260101-000001-a1b2" }));
      ok("续期日期 = 冻结日 +30 天", rn.includes("review_after=2026-02-14"), rn.split("\n")[0].slice(0, 80));
      return;
    }
    case "config-inject": {
      const L = await load(home, AUTO_OFF);
      const { setConfig } = await import("./under-test/living-memory.ts");
      const ctx = mkCtx("/work/acme");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const briefNow = async () => String(((await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx)) as any)?.systemPrompt ?? "");
      const base = await briefNow();
      ok("默认上限下简报非空", base.length > 0, `${base.length} 字符`);
      setConfig({ briefMaxChars: 200 });
      const tight = await briefNow();
      ok("注入 briefMaxChars=200 后简报变短", tight.length < base.length, `${base.length} → ${tight.length} 字符`);
      ok("收紧上限后条目行更少", tight.split("\n").length < base.split("\n").length, `${base.split("\n").length} → ${tight.split("\n").length} 行`);
      setConfig({ briefMaxChars: 2400 });
      const back = await briefNow();
      ok("setConfig 还原后与注入前逐字一致", back === base, `${base.length} / ${back.length} 字符`);
      return;
    }
    case "extract-parse-empty": {
      const { parseExtractionOutput } = await import("./under-test/src/extract.ts");
      const a = parseExtractionOutput("");
      ok("空字符串 → code=empty-response", !a.ok && a.code === "empty-response", JSON.stringify(a));
      ok("empty-response 的 detail 为空（模型 id 与 reason 由壳拼接）", !a.ok && a.detail === "", !a.ok ? JSON.stringify(a.detail) : "");
      const b = parseExtractionOutput("  \n\t ");
      ok("纯空白 → 同样 empty-response", !b.ok && b.code === "empty-response", JSON.stringify(b));
      return;
    }
    case "extract-parse-fence": {
      const { parseExtractionOutput } = await import("./under-test/src/extract.ts");
      const a = parseExtractionOutput('说明\n```json\n[{"kind":"preference","subject":"甲","text":"正文甲","confidence":0.9}]\n```\n结束');
      ok("```json 围栏被剥掉后解析成功", a.ok && Array.isArray(a.value) && (a.value as any[])[0]?.kind === "preference", JSON.stringify(a));
      const b = parseExtractionOutput('```\n[{"kind":"decision"}]\n```');
      ok("无语言标记的围栏同样剥掉", b.ok && Array.isArray(b.value) && (b.value as any[])[0]?.kind === "decision", JSON.stringify(b));
      return;
    }
    case "extract-parse-array": {
      const { parseExtractionOutput } = await import("./under-test/src/extract.ts");
      const a = parseExtractionOutput("[]");
      ok("[] → ok:true 且 value 是空数组", a.ok && Array.isArray(a.value) && (a.value as any[]).length === 0, JSON.stringify(a));
      const b = parseExtractionOutput('```json\n[{"kind":"preference","subject":"甲","text":"正文甲","confidence":0.9}]\n```');
      ok("围栏里的数组 → ok:true 且字段原样保留", b.ok && (b.value as any[]).length === 1 && (b.value as any[])[0].subject === "甲", JSON.stringify(b));
      return;
    }
    case "extract-parse-no-json": {
      const { parseExtractionOutput } = await import("./under-test/src/extract.ts");
      const a = parseExtractionOutput("回包里只有一句话，没有数组");
      ok("无括号 → code=no-json", !a.ok && a.code === "no-json", JSON.stringify(a));
      ok("no-json 的 detail = 固定前缀 + 回包片段", !a.ok && a.detail === "回包里找不到 JSON 数组：回包里只有一句话，没有数组", !a.ok ? a.detail : "");
      const b = parseExtractionOutput("] 先右后左 [");
      ok("右括号在左括号之前 → no-json", !b.ok && b.code === "no-json", JSON.stringify(b));
      return;
    }
    case "extract-parse-bad-json": {
      const { parseExtractionOutput } = await import("./under-test/src/extract.ts");
      const a = parseExtractionOutput('[{"kind":"preference",}]');
      ok("尾逗号坏 JSON → code=parse-failed", !a.ok && a.code === "parse-failed", JSON.stringify(a));
      ok("parse-failed 的 detail = 「JSON 解析失败：」+ 片段（reason 由壳补）", !a.ok && a.detail === 'JSON 解析失败：[{"kind":"preference",}]', !a.ok ? a.detail : "");
      return;
    }
    case "extract-normalize-nonarray": {
      const { normalizeExtractionItems } = await import("./under-test/src/extract.ts");
      const r = normalizeExtractionItems({ kind: "preference", subject: "甲", text: "正文甲" });
      ok("对象（非数组）→ candidates / skipped 都为空", r.candidates.length === 0 && r.skipped.length === 0, JSON.stringify(r));
      const n = normalizeExtractionItems(null);
      ok("null → 空转", n.candidates.length === 0 && n.skipped.length === 0, JSON.stringify(n));
      const t = normalizeExtractionItems([1, 2]);
      ok("数组里的非对象项 → skipped(kind)，不立候选", t.candidates.length === 0 && t.skipped.length === 2 && t.skipped[0].reason === "kind", JSON.stringify(t));
      return;
    }
    case "extract-normalize-cap": {
      const { normalizeExtractionItems } = await import("./under-test/src/extract.ts");
      const r = normalizeExtractionItems(
        ["甲", "乙", "丙", "丁", "戊"].map((s, i) => ({ kind: "preference", subject: "偏好" + s, text: "正文" + s, confidence: 0.7 + i / 100 })),
      );
      ok("最多只取前 3 项", r.candidates.length === 3, r.candidates.length + " 条");
      ok("留下的是前三条（按顺序截断）", r.candidates.map((c) => c.subject).join(",") === "偏好甲,偏好乙,偏好丙", r.candidates.map((c) => c.subject).join(","));
      ok("candidates 每项带 kind/subject/body/confidence", r.candidates.every((c) => !!c.kind && !!c.subject && !!c.body && typeof c.confidence === "number"), JSON.stringify(r.candidates[0]));
      return;
    }
    case "extract-normalize-invalid": {
      const { normalizeExtractionItems } = await import("./under-test/src/extract.ts");
      const r = normalizeExtractionItems([
        { kind: "nonsense", subject: "甲", text: "正文甲" },
        { kind: "decision", subject: "   ", text: "正文乙" },
        { kind: "decision", subject: "丙", text: "  " },
      ]);
      ok("非法 kind → skipped(kind)", r.candidates.length === 0 && r.skipped[0]?.reason === "kind", JSON.stringify(r));
      ok("空 subject（trim 后）→ skipped(subject)", r.skipped[1]?.reason === "subject", JSON.stringify(r.skipped));
      ok("空 body（trim 后）→ skipped(body)", r.skipped[2]?.reason === "body", JSON.stringify(r.skipped));
      return;
    }
    case "extract-normalize-selfref": {
      const { normalizeExtractionItems } = await import("./under-test/src/extract.ts");
      const r = normalizeExtractionItems([
        { kind: "decision", subject: "记忆库索引改造方案", text: "把派生索引换成 v4" },
        { kind: "decision", subject: "发布节奏决策", text: "每月一版" },
      ]);
      ok("自指 subject → skipped(self-ref)，不立候选", r.candidates.length === 1 && r.skipped.length === 1 && r.skipped[0].reason === "self-ref", JSON.stringify(r));
      ok("非自指候选照常立条目", r.candidates[0]?.subject === "发布节奏决策", JSON.stringify(r.candidates));
      const u = normalizeExtractionItems([{ kind: "preference", subject: "用户希望简报少一点细节", text: "只要结论" }]);
      ok("「用户」开头的偏好不被自指过滤（与 isPluginInternal 一致）", u.candidates.length === 1 && u.skipped.length === 0, JSON.stringify(u));
      return;
    }
    case "extract-normalize-confidence": {
      const { normalizeExtractionItems } = await import("./under-test/src/extract.ts");
      const r = normalizeExtractionItems([
        { kind: "preference", subject: "甲", text: "正文甲", confidence: 1.7 },
        { kind: "preference", subject: "乙", text: "正文乙", confidence: -0.3 },
        { kind: "preference", subject: "丙", text: "正文丙" },
      ]);
      ok("超过 1 夹到 1", r.candidates[0]?.confidence === 1, String(r.candidates[0]?.confidence));
      ok("小于 0 夹到 0", r.candidates[1]?.confidence === 0, String(r.candidates[1]?.confidence));
      ok("缺省 confidence = 0.6", r.candidates[2]?.confidence === 0.6, String(r.candidates[2]?.confidence));
      const d = normalizeExtractionItems([
        { kind: "decision", subject: "同一件事", text: "同一结论" },
        { kind: "decision", subject: "同一件事", text: "同一结论" },
        { kind: "decision", subject: "同一件事", text: "补一句" },
      ]);
      ok("同批完全重复只留首条，重复项进 skipped(duplicate)", d.candidates.length === 2 && d.skipped.some((x) => x.reason === "duplicate"), JSON.stringify(d));
      return;
    }
    case "extract-decide-split": {
      const { decideExtractionBatch } = await import("./under-test/src/extract.ts");
      const candidates = [
        { kind: "preference", subject: "答复结构", body: "先给结论再给依据", confidence: 0.9 },
        { kind: "preference", subject: "会议纪要格式", body: "只留结论与待办", confidence: 0.6 },
      ];
      const seen: string[] = [];
      const out = decideExtractionBatch(candidates, (kind, subject, body) => {
        seen.push(`${kind}/${subject}/${body}`);
        return subject === "答复结构";
      });
      ok("第一条命中既有条目 → verdict=conflict", out[0]?.verdict === "conflict", JSON.stringify(out[0]));
      ok("第二条无冲突 → verdict=create", out[1]?.verdict === "create", JSON.stringify(out[1]));
      ok("每条候选原样保留引用", out[0]?.candidate === candidates[0] && out[1]?.candidate === candidates[1], JSON.stringify(out.map((x) => x.candidate.subject)));
      ok("查找函数收到 kind/subject/body 三元组", seen.length === 2 && seen[0].includes("答复结构") && seen[1].includes("会议纪要格式"), seen.join(" | "));
      return;
    }
    case "extract-decide-isolated": {
      const { decideExtractionBatch } = await import("./under-test/src/extract.ts");
      const candidates = [
        { kind: "decision", subject: "甲", body: "正文甲", confidence: 0.7 },
        { kind: "decision", subject: "乙", body: "正文乙", confidence: 0.7 },
        { kind: "decision", subject: "丙", body: "正文丙", confidence: 0.7 },
      ];
      const conflictKeys = new Set(["decision/乙"]);
      const out = decideExtractionBatch(candidates, (kind, subject) => conflictKeys.has(`${kind}/${subject}`));
      ok("中间一条冲突 → conflict", out[1]?.verdict === "conflict", JSON.stringify(out[1]));
      ok("前后两条仍为 create", out[0]?.verdict === "create" && out[2]?.verdict === "create", JSON.stringify(out.map((x) => x.verdict)));
      ok("判决条数与候选数一致", out.length === candidates.length, `${out.length}/${candidates.length}`);
      return;
    }
    case "extract-decide-empty": {
      const { decideExtractionBatch } = await import("./under-test/src/extract.ts");
      let calls = 0;
      const out = decideExtractionBatch([], () => {
        calls++;
        return true;
      });
      ok("空 candidates 返回空数组", Array.isArray(out) && out.length === 0, JSON.stringify(out));
      ok("空批次不调用查找函数", calls === 0, `calls=${calls}`);
      return;
    }
    case "extract-gate-config": {
      const { loadConfig } = await import("./under-test/src/config.ts");
      ok("默认（未设）→ 拦", loadConfig({}).extractGate === true);
      ok("LIVING_MEMORY_EXTRACT_GATE=1 → 拦", loadConfig({ LIVING_MEMORY_EXTRACT_GATE: "1" }).extractGate === true);
      ok("LIVING_MEMORY_EXTRACT_GATE=0 → 影子", loadConfig({ LIVING_MEMORY_EXTRACT_GATE: "0" }).extractGate === false);
      ok("其它抽取开关仍按原口径解析", loadConfig({}).extractTimeoutMs === 20000);
      return;
    }
    case "extract-gate-user-turns": {
      const { userTurnsText, conversationText } = await import("./under-test/src/extract.ts");
      const long = "助手过程".repeat(1600);
      const msgs = [
        { role: "user", content: [{ type: "text", text: "早先的承诺：周五前给报价单。" }] },
        { role: "assistant", content: long },
        { role: "tool", content: "git status" },
      ];
      const u = userTurnsText(msgs);
      ok("只取 user 轮次（忽略 assistant/tool）", u === "早先的承诺：周五前给报价单。", u.slice(0, 60));
      ok("空白归一化后拼接", userTurnsText([{ role: "user", content: "  第一行\n\n第二行  " }]) === "第一行 第二行");
      const c = conversationText(msgs);
      ok("conversationText 受 6000 截断，userTurnsText 不受影响", c.length === 6000 && u.length < c.length && !c.includes("早先的承诺"), `${c.length}/${u.length}`);
      return;
    }
    case "extract-gate-quote-missing": {
      const { normalizeExtractionItems, applyExtractionGate } = await import("./under-test/src/extract.ts");
      const user = "以后周报先写结论，再列数据，最后给风险。";
      const r = normalizeExtractionItems([
        { kind: "preference", subject: "周报格式甲", text: "周报先写结论", confidence: 0.9 },
        { kind: "preference", subject: "周报格式乙", text: "周报先写结论", quote: "结论", confidence: 0.9 },
        { kind: "preference", subject: "周报格式丙", text: "周报先写结论", quote: "以后周报先写结论", confidence: 0.9 },
      ]);
      ok(
        "normalize 携带 quote（缺省为空串）",
        r.candidates[0]?.quote === "" && r.candidates[2]?.quote === "以后周报先写结论",
        JSON.stringify(r.candidates.map((c) => c.quote)),
      );
      const g = applyExtractionGate(r.candidates, user, "enforce");
      ok("quote 缺失 → unverified", g.gated[0]?.reason === "unverified", JSON.stringify(g.gated[0]));
      ok("quote 短于 6 字符 → unverified", g.gated.some((x) => x.candidate.subject === "周报格式乙" && x.reason === "unverified"), JSON.stringify(g.gated.map((x) => x.reason)));
      ok("合资格 quote 通过", g.accepted.some((c) => c.subject === "周报格式丙"), JSON.stringify(g.accepted.map((c) => c.subject)));
      return;
    }
    case "extract-gate-quote-foreign": {
      const { userTurnsText, applyExtractionGate } = await import("./under-test/src/extract.ts");
      const msgs = [
        { role: "user", content: "帮我整理一下发布清单。" },
        { role: "assistant", content: "发布清单：先跑 pnpm build，再打 tag。" },
      ];
      const candidates = [
        { kind: "decision", subject: "发布步骤", body: "发布前先打 tag", confidence: 0.8, quote: "发布清单：先跑 pnpm build，再打 tag。" },
        { kind: "decision", subject: "任务书约束", body: "只 commit 不 push", confidence: 0.9, quote: "禁 git add -A / 只 commit 不 push" },
      ];
      const g = applyExtractionGate(candidates, userTurnsText(msgs), "enforce");
      ok("quote 只出现在 assistant 文本 → unverified", g.gated[0]?.reason === "unverified" && g.gated[0]?.candidate.subject === "发布步骤", JSON.stringify(g.gated[0]));
      ok("quote 来自任务书（用户没说过）→ unverified", g.gated[1]?.reason === "unverified" && g.accepted.length === 0, JSON.stringify(g.accepted));
      return;
    }
    case "extract-gate-quote-verbatim": {
      const { userTurnsText, applyExtractionGate, decideExtractionBatch } = await import("./under-test/src/extract.ts");
      const msgs = [
        { role: "user", content: [{ type: "text", text: "以后周报都按「先写结论，\n再列数据」的格式。" }] },
        { role: "assistant", content: "好的，我记住了。" },
      ];
      const candidates = [{ kind: "preference", subject: "周报格式", body: "周报先写结论，再列数据", confidence: 0.9, quote: "先写结论，  再列数据" }];
      const g = applyExtractionGate(candidates, userTurnsText(msgs), "enforce");
      ok("逐字 quote（空白差异归一后）通过", g.accepted.length === 1 && g.gated.length === 0, JSON.stringify(g));
      const decisions = decideExtractionBatch(g.accepted, () => false);
      ok("正例不被误杀：verdict=create", decisions[0]?.verdict === "create", JSON.stringify(decisions[0]));
      return;
    }
    case "extract-gate-noise-command": {
      const { applyExtractionGate } = await import("./under-test/src/extract.ts");
      const user = "以后发布前先跑一次 pnpm build。";
      const allowedBody = "禁 git add -A / 只 commit 不 push";
      const candidates = [
        { kind: "decision", subject: "命令片段", body: "```json\n[]\n```", confidence: 0.9, quote: "以后发布前先跑一次" },
        { kind: "decision", subject: "提交 hash", body: "commit 0123456789abcdef0123456789abcdef01234567", confidence: 0.9, quote: "以后发布前先跑一次" },
        { kind: "decision", subject: "发布步骤", body: allowedBody, confidence: 0.9, quote: "以后发布前先跑一次" },
      ];
      const g = applyExtractionGate(candidates, user, "enforce");
      ok("正文含代码围栏 → noise", g.gated[0]?.reason === "noise", JSON.stringify(g.gated[0]));
      ok("正文含 40 位 commit hash → noise", g.gated[1]?.reason === "noise", JSON.stringify(g.gated[1]));
      ok("命令/路径正文引文验过后放行", g.accepted.length === 1 && g.accepted[0]?.body === allowedBody, JSON.stringify(g.gated));
      return;
    }
    case "extract-gate-selfref-body": {
      const { applyExtractionGate } = await import("./under-test/src/extract.ts");
      const user = "以后别把实现细节写进记忆。";
      const candidates = [
        { kind: "decision", subject: "用户偏好", body: "抽取器改了 extensions/src/extract.ts 的过滤", confidence: 0.9, quote: "以后别把实现细节写进记忆" },
        { kind: "decision", subject: "用户偏好", body: "LIVING_MEMORY_EXTRACT_GATE=0 时改为影子", confidence: 0.9, quote: "以后别把实现细节" },
        { kind: "decision", subject: "用户偏好", body: "查询走 living_memory(/memory) 工具", confidence: 0.9, quote: "以后别把实现细节" },
      ];
      const g = applyExtractionGate(candidates, user, "enforce");
      ok("正文 extensions/src/... 不再被闸", g.accepted.some((c) => c.body.includes("extensions/src/")), JSON.stringify(g.gated));
      ok("正文 LIVING_MEMORY_ / living_memory( 不再被闸", g.accepted.length === 3 && g.gated.length === 0, JSON.stringify(g.gated));
      return;
    }
    case "extract-gate-quote-fixtures": {
      const { userTurnsText, applyExtractionGate, decideExtractionBatch } = await import("./under-test/src/extract.ts");
      const fixtures = [
        {
          subject: "vault 里 git add 铁律",
          body: "vault 里禁止 git add -A / git add .：会被其它并行会话未提交的改动混入…铁律=git add 逐个列具体路径",
          quote: "vault 里禁止 git add -A",
          user: "记一下：vault 里禁止 git add -A / git add .，会被其它并行会话未提交的改动混入。",
        },
        {
          subject: "git commit 确认纪律",
          body: "所有 git commit 必须先经用户确认才能提交：agent 只改动+暂存…git push 同理需用户确认",
          quote: "所有 git commit 必须先经用户确认",
          user: "以后都这样：所有 git commit 必须先经用户确认才能提交，push 也一样。",
        },
        {
          subject: "itsfun 仓 push 纪律",
          body: "itsfun 仓永远不执行 git push（提交须用户确认，push 由用户自己处理）",
          quote: "itsfun 仓永远不执行 git push",
          user: "记一下：itsfun 仓永远不执行 git push，提交也须我先确认。",
        },
        {
          subject: "对外文本纯文本版",
          body: "用户要求：对外文本必须附纯文本版、不带 markdown；多处出现必须一致",
          quote: "对外文本必须附纯文本版",
          user: "以后都这样：对外文本必须附纯文本版、不带 markdown，多处出现也要一致。",
        },
        {
          subject: "输入法习惯",
          body: "用户输入法习惯用双拼，输入框默认全角",
          quote: "用户输入法习惯用双拼",
          user: "补充一条：用户输入法习惯用双拼，输入框默认全角。",
        },
        {
          subject: "Upwork 岗位发现渠道",
          body: "Upwork 岗位发现改走公开 SEO 页扫描而非 Google site: 搜索：脚本 vault/20_Concepts/…/upwork-scan.ts",
          quote: "Upwork 岗位发现改走公开 SEO 页扫描",
          user: "记一下：Upwork 岗位发现改走公开 SEO 页扫描，不再用 Google site: 搜索。",
        },
      ];
      const msgs = fixtures.map((f) => ({ role: "user", content: f.user }));
      ok("每条引文都出自各自的用户回合", fixtures.every((f) => f.user.includes(f.quote)));
      ok("用户回合是带过渡语的自然句子，不是引文拼接", fixtures.every((f) => f.user.length > f.quote.length));
      const candidates = fixtures.map((f, i) => ({ kind: i === 4 ? "preference" : "decision", subject: f.subject, body: f.body, confidence: 0.9, quote: f.quote }));
      const g = applyExtractionGate(candidates, userTurnsText(msgs), "enforce");
      ok("6 条真实正文全部放行", g.accepted.length === 6, JSON.stringify(g.gated.map((x) => x.reason)));
      const decisions = decideExtractionBatch(g.accepted, () => false);
      ok("6 条全部 verdict=create", decisions.length === 6 && decisions.every((d) => d.verdict === "create"), JSON.stringify(decisions.map((d) => d.verdict)));
      for (const f of fixtures) {
        const d = decisions.find((x) => x.candidate.subject === f.subject);
        ok(`正文逐字保留：${f.subject}`, d?.candidate.body === f.body, d?.candidate.body?.slice(0, 48));
      }
      return;
    }
    case "extract-gate-structural": {
      const { applyExtractionGate } = await import("./under-test/src/extract.ts");
      const user = "以后发布前先跑一次 pnpm build。";
      const taskbookBody = "背景：发布；要求：先跑测试；验收标准：全绿";
      const candidates = [
        { kind: "decision", subject: "任务书约束", body: "禁 git add -A / 只 commit 不 push", confidence: 0.9, quote: "禁 git add -A / 只 commit 不 push" },
        { kind: "decision", subject: "任务书正文", body: taskbookBody, confidence: 0.9, quote: "以后发布前先跑一次 pnpm build" },
      ];
      const g = applyExtractionGate(candidates, user, "enforce");
      ok("任务书文本对不上用户原话 → unverified（先于正文规则）", g.gated[0]?.reason === "unverified", JSON.stringify(g.gated[0]));
      ok("正文含任务书词但引文验过 → 放行（正文只拦结构性垃圾）", g.accepted.length === 1 && g.accepted[0]?.body === taskbookBody, JSON.stringify(g.gated));
      const noiseVsUnverified = applyExtractionGate(
        [{ kind: "decision", subject: "双命中", body: "```\ncommit 0123456789abcdef0123456789abcdef01234567\n```", confidence: 0.9, quote: "用户没说过的话" }],
        user,
        "enforce",
      );
      ok("引文不实 + 正文垃圾 → 记 unverified（不因正文误记 noise）", noiseVsUnverified.gated[0]?.reason === "unverified", JSON.stringify(noiseVsUnverified.gated[0]));
      return;
    }
    case "extract-gate-process-verified": {
      const { applyExtractionGate, decideExtractionBatch } = await import("./under-test/src/extract.ts");
      const user = "我已把索引改好并验证，以后都这样收尾。";
      const candidates = [{ kind: "preference", subject: "收尾方式", body: "我已把索引改好并验证", confidence: 0.9, quote: "我已把索引改好并验证" }];
      const g = applyExtractionGate(candidates, user, "enforce");
      ok("过程自述正文（引文为用户原话）不被拦", g.accepted.length === 1 && g.gated.length === 0, JSON.stringify(g.gated));
      ok("放行后 verdict=create", decideExtractionBatch(g.accepted, () => false)[0]?.verdict === "create");
      return;
    }
    case "extract-gate-mode": {
      const L = await load(home, AUTO_OFF);
      const { applyExtractionGate, decideExtractionBatch, recordExtractionGates } = await import("./under-test/src/extract.ts");
      const user = "以后发布前先跑一次 pnpm build。";
      const candidates = [{ kind: "decision", subject: "用户决策", body: "commit 0123456789abcdef0123456789abcdef01234567", confidence: 0.9, quote: "以后发布前先跑一次" }];
      const enforce = applyExtractionGate(candidates, user, "enforce");
      const shadow = applyExtractionGate(candidates, user, "shadow");
      ok("enforce：命中的候选被拦下", enforce.accepted.length === 0 && enforce.gated[0]?.reason === "noise", JSON.stringify(enforce));
      ok(
        "shadow：gated 照记但 accepted 不丢",
        shadow.accepted.length === 1 && shadow.gated.length === 1 && shadow.accepted[0] === candidates[0],
        JSON.stringify({ accepted: shadow.accepted.length, gated: shadow.gated.length }),
      );
      const enforced = decideExtractionBatch(enforce.accepted, () => false);
      const shadowed = decideExtractionBatch(shadow.accepted, () => false);
      ok("enforce：被闸候选不产生决策", enforced.length === 0, `${enforced.length} 条决策`);
      ok("shadow：被闸候选照常产生决策", shadowed.length === 1 && shadowed[0]?.verdict === "create", JSON.stringify(shadowed.map((d) => d.verdict)));
      recordExtractionGates(shadow.gated, "agent_settled", "shadow");
      const ledger = read(home, "extract-gates.jsonl").trim().split("\n").filter(Boolean);
      ok("shadow 被闸仍写台账", ledger.length === 1 && JSON.parse(ledger[0]).reason === "noise", ledger[0]?.slice(0, 80));
      ok("台账行记 mode=shadow", JSON.parse(ledger[0]).mode === "shadow", ledger[0]?.slice(0, 80));
      const act = read(home, "activity.log");
      ok("activity.log 记 gated 行并标注 shadow", act.includes("auto-extract gated noise") && act.includes("shadow"), act.slice(-120));
      ok("闸不碰手工写入的 remember 路径", out(await L.call("remember", { kind: "decision", subject: "手工写入验证", text: "手工 remember 不走抽取闸", basis: "explicit", source: "test" })).includes("已记入"));
      return;
    }
    case "extract-gate-ledger": {
      const { recordExtractionGates } = await import("./under-test/src/extract.ts");
      const candidate = { kind: "decision", subject: "台账滚动", body: "正文".repeat(80), confidence: 0.9, quote: "引用".repeat(40) };
      for (let i = 0; i < 205; i++) recordExtractionGates([{ candidate, reason: "noise" }], "test", "enforce");
      const lines = read(home, "extract-gates.jsonl").trim().split("\n").filter(Boolean);
      ok("台账最多保留 200 条", lines.length === 200, `${lines.length} 行`);
      const row = JSON.parse(lines[lines.length - 1]);
      ok("行字段齐全", ["ts", "reason", "mode", "kind", "subject", "body", "quote"].every((k) => Object.hasOwn(row, k)), Object.keys(row).join(","));
      ok("台账行记 mode=enforce", row.mode === "enforce", row.mode);
      ok("body 截到 120 字符 / quote 截到 60", row.body.length === 120 && row.quote.length === 60, `${row.body.length}/${row.quote.length}`);
      const emoji = { ...candidate, body: "😀".repeat(200), quote: "🎯".repeat(80) };
      recordExtractionGates([{ candidate: emoji, reason: "noise" }], "test", "enforce");
      const emojiRow = JSON.parse(read(home, "extract-gates.jsonl").trim().split("\n").filter(Boolean).pop() ?? "{}");
      ok(
        "emoji 按码点截断，不切半个代理对",
        [...emojiRow.body].length === 120 && [...emojiRow.quote].length === 60 && !/[\uD800-\uDBFF]$/.test(emojiRow.body),
        `${[...emojiRow.body].length}/${[...emojiRow.quote].length}`,
      );
      return;
    }
    case "extract-gate-health": {
      const L = await load(home, AUTO_OFF);
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
      fs.writeFileSync(
        path.join(mem(home), "extract-gates.jsonl"),
        [
          JSON.stringify({ ts: hoursAgo(1), reason: "noise", mode: "enforce", kind: "decision", subject: "发布步骤", body: "禁 git add -A / 只 commit 不 push", quote: "以后发布前先跑一次" }),
          JSON.stringify({ ts: hoursAgo(2), reason: "unverified", mode: "shadow", kind: "preference", subject: "报价承诺", body: "早先承诺：周五给报价单", quote: "周五前给报价单" }),
          JSON.stringify({ ts: hoursAgo(24 * 9), reason: "noise", mode: "enforce", kind: "decision", subject: "旧记录", body: "旧记录正文", quote: "旧引文" }),
          "null",
          JSON.stringify({ ts: 123 }),
          JSON.stringify({ ts: hoursAgo(1), reason: "noise", kind: "decision", subject: "缺 mode 的旧行", body: "缺 mode 的旧行正文", quote: "旧引文" }),
        ].join("\n") + "\n",
      );
      const t = out(await L.call("living_memory", { source: "extract" }));
      ok("无失败时也输出被闸统计", /gate：近 7 天被闸 2 条/.test(t), t.split("\n").find((l) => l.startsWith("gate：")));
      ok("按 mode 拆分 enforce / shadow", /enforce 1 \/ shadow 1/.test(t), t.match(/gate：[^\n]*/)?.[0]?.slice(0, 120));
      ok("原因分布按 reason 计数", /noise 1/.test(t) && /unverified 1/.test(t), t.match(/（[^）]*）/)?.[0]);
      ok("畸形台账行只丢该行，不拖垮整段输出", t.includes("台账共 3 条"), t.match(/台账共 \d+ 条/)?.[0]);
      ok("缺 mode 的旧行按形状校验丢弃", !t.includes("缺 mode 的旧行"), t.split("\n").slice(-2).join(" | ").slice(0, 100));
      ok("列出最近 5 条正文摘要", t.includes("禁 git add -A") && t.includes("早先承诺"), t.split("\n").slice(-3).join(" | ").slice(0, 120));
      return;
    }
    default:
      throw new Error(`未知用例：${id}`);
  }
}

async function main() {
  const id = process.argv[2];
  const home = process.env.TEST_HOME ?? "";
  if (!id || !home) {
    console.error("用法：TEST_HOME=<tmp> bun cases.ts <caseId>");
    process.exit(2);
  }
  fs.mkdirSync(path.join(home, ".pi/agent/memory"), { recursive: true });
  try {
    await body(id, home);
  } catch (e: any) {
    checks.push({ name: "用例未抛出异常", ok: false, detail: e?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(e) });
  }
  console.log("\n__RESULT__" + JSON.stringify({ case: id, checks }));
}

if (import.meta.main) main();
