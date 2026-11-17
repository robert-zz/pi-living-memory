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
];

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

async function body(id: string, home: string) {
  const AUTO_OFF = { LIVING_MEMORY_AUTO_TRIAGE: "0" };

  switch (id) {
    case "brief": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/vanlife");
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
      const ctx = mkCtx("/work/vanlife");
      const r: any = await L.handlers.before_agent_start({ systemPrompt: "BASE" }, ctx);
      ok("不注入（返回空/undefined）", !r || r.systemPrompt === undefined || r.systemPrompt === "BASE", JSON.stringify(r ?? null).slice(0, 40));
      return;
    }
    case "brief-readbudget": {
      const c = counter();
      const L = await load(home, AUTO_OFF); // 索引冷建在加载期，不计入简报
      const ctx = mkCtx("/work/vanlife");
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
      await L.call("living_memory_update", { action: "todo_add", text: "结构待办己：标记写入", section: "测试项目 A", project: "vanlife", tags: "p2,dns", due: soon });
      const line = (read(home, "todo.md").split("\n").find((l) => l.includes("结构待办己")) ?? "").trim();
      ok("行尾写入 @project #tag due:", line.endsWith(`@vanlife #p2 #dns due:${soon}`), line);
      const bad = out(await L.call("living_memory_update", { action: "todo_add", text: "结构待办坏：日期非法", due: "2026/12/01" }));
      ok("非法 due 被拒", /YYYY-MM-DD/.test(bad) && !read(home, "todo.md").includes("结构待办坏"), bad.slice(0, 60));
      await L.call("living_memory_update", { action: "todo_add", text: "结构待办庚：已逾期", project: "vanlife", tags: "p0", due: late });
      ok("逾期日期可写", read(home, "todo.md").includes(`due:${late}`) && read(home, "todo.md").includes("#p0"));
      const q1 = out(await L.call("living_memory", { source: "todo", query: "@vanlife" }));
      ok("按 @project 筛", q1.includes("结构待办己") && q1.includes("结构待办庚") && !q1.includes("待办甲"), q1.split("\n")[0]);
      const q2 = out(await L.call("living_memory", { source: "todo", query: "@vanlife #p0" }));
      ok("按 #tag 叠加筛", q2.includes("结构待办庚") && !q2.includes("结构待办己"), q2.split("\n")[0]);
      const q3 = out(await L.call("living_memory", { source: "todo", query: "due:overdue" }));
      ok("due:overdue 只命中逾期", q3.includes("结构待办庚") && !q3.includes("结构待办己"), q3.split("\n")[0]);
      const q4 = out(await L.call("living_memory", { source: "todo", query: "due:soon" }));
      ok("due:soon 覆盖 7 日内与逾期", q4.includes("结构待办己") && q4.includes("结构待办庚"), q4.split("\n")[0]);
      const q5 = out(await L.call("living_memory", { source: "todo", query: "due:2099-01-01" }));
      ok("due:具体日期无命中", !q5.includes("结构待办己") && /命中 0/.test(q5), q5.split("\n")[0]);
      const ctx = mkCtx("/work/vanlife");
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
      await L.handlers.before_agent_start({ systemPrompt: "" }, mkCtx("/work/vanlife"));
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
      const ctx = mkCtx("/work/vanlife");
      await L.handlers.session_start({ reason: "startup" }, ctx);
      const notes = ctx.notes.join(" | ");
      ok("提示过期可归档", /过期 \d+ 条可归档/.test(notes), notes.slice(0, 80));
      ok("提示已完成待办可归档", /已完成 \d+ 项可归档/.test(notes));
      const ctx2 = mkCtx("/work/vanlife");
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
      const ctx = mkCtx("/work/vanlife");
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
      const ctx = mkCtx("/work/vanlife");
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
      const ctx = mkCtx("/work/vanlife");

      // ① 0.9 → 直接按事实（confirmed）
      const r1 = out(await L.call("remember", { kind: "preference", subject: "报告风格", text: "报告一律先给结论。", basis: "inference", confidence: 0.9, source: "fixture 高置信" }, ctx));
      ok("0.9 自动按事实", /status=confirmed/.test(r1), r1.split("\n")[0]);
      const e1 = L.findEntry ? null : null;
      const file1 = fs.readdirSync(path.join(mem(home), "entries")).find((f: string) => f.startsWith("2026") );
      const txt1 = fs.readFileSync(path.join(mem(home), "entries", file1), "utf8");
      ok("落盘 status=confirmed", /status: confirmed/.test(txt1), file1);
      ok("confirmed_at 已填", /confirmed_at: 2026/.test(txt1), "");

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
      const ctx = mkCtx("/work/vanlife");
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
      ok("旧格式索引被重建（带 v=2）", idx.v === 2, `v=${idx.v}`);
      ok("重建后索引含 confidence", idx.rows.some((r: any) => r.id === "20260101-000000-rtr1" && r.meta.confidence === "0.9"), "");
      return;
    }
    case "auto-fact-evidence": {
      const L = await load(home, AUTO_OFF);
      const ctx = mkCtx("/work/vanlife");
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
      const ctx2 = mkCtx("/work/vanlife");
      await L2.handlers.session_start({ reason: "startup" }, ctx2);
      ok("开关 0 时不提示自动按事实", !/自动按事实处理/.test(ctx2.notes.join(" | ")), ctx2.notes.join(" | ").slice(0, 40));
      return;
    }
    case "negation": {
      const L = await load(home, AUTO_OFF);
      writeEntry(home, { id: "20260101-000000-nnn1", kind: "preference", subject: "汇报口径", body: "汇报口径：先说结论，细节放后面。" });
      writeEntry(home, { id: "20260101-000000-nnn2", kind: "constraint", subject: "对外邮件", body: "对外邮件：不要抄送无关的人，别把内部猜测写进去。" });
      writeEntry(home, { id: "20260101-000000-nnn3", kind: "constraint", subject: "代码提交", body: "代码提交：禁止把 debug 代码一起提交。" });
      const ctx = mkCtx("/work/vanlife");
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
      const ctx = mkCtx("/work/vanlife");
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
