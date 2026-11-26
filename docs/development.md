# 开发轨

本文写给**要改这个包代码的人**。只想使用，看 [README](../README.md) 就够。

## 单一来源

`extensions/living-memory.ts`（本仓）+ `extensions/src/` 下的模块。`~/.pi/agent/extensions/` 下**不再保留副本**——两份实例会各自缓存索引与文件状态，互相看不见对方的写入（曾经把大写 `summary.md` 写回来一次）。

模块结构（0.2.0 起）：

```
```
extensions/living-memory.ts      壳：pi 注册、工具 schema、事件接线（955 行）
  src/config.ts                  Config/Clock/Logger 注入层
  src/text.ts                    纯文本工具（无 IO）
  src/paths.ts                   路径常量 + 文件原语（顶层零 IO）
  src/manifest.ts                frontmatter 解析与校验
  src/recall.ts                  BM25 打分（纯函数）
  src/stores/{entry,todo,summary}-store.ts
  src/time.ts                    日期与复核期谓词
  src/scope.ts                   scope 过滤与校验
  src/evidence.ts                证据链、复合分、自动转正
  src/lifecycle.ts               confirm/supersede/expire/restore/purge
  src/documents.ts               todo 与 summary 的操作及锁包装
  src/triage.ts                  自动清理 + 自指判定正则
  src/search.ts                  检索面、lint/routing、按问题召回
  src/ops.ts                     **纯 re-export 兼容层**（12 行）
  src/brief.ts                   简报装配
  src/extract.ts                 自动抽取
```

依赖按层单向：`config → text/paths → manifest → recall/stores → time/scope → lifecycle → evidence/triage → documents/search → ops → brief → extract → 壳`。每条 import 边指向更底层，DFS 检测无环。pi 用 jiti 加载扩展，相对 import 不带扩展名即可，**不需要打包步骤**。

**`ops.ts` 只是兼容层**：壳 / brief / extract 历史上从 `./ops` 取 41+4+6 个符号，拆分时为免改 51 处 import 而保留桶文件。**新代码请直接 import 具体模块**（如 `from "./evidence"`），别再往桶里加依赖——桶存在的意义是让旧调用方不用动，不是让新代码继续模糊依赖。

## 日常循环

```bash
cd /path/to/pi-living-memory
# 改 extensions/ 下的代码
bun tests/run.ts          # 72 用例 / 315 断言，跑在临时 HOME，不碰真库
bun run typecheck         # strict 类型门禁（需先跑 tests 生成 under-test）
/reload                   # 包路径就是本目录，pi 重新读盘即生效
git commit -am "..." && git tag v0.x.y
```

`/reload` 只重载模块；**删/加扩展文件、改 `settings.json` 的 packages 后必须重启 pi**，否则旧实例的注册不会消失（表现为 `/memory:1`、`/memory:2`）。

## 类型门禁

```bash
bun tests/run.ts          # 72 用例 / 315 断言；同时把源码复制成 tests/under-test/
bun run typecheck         # tsc --noEmit（strict）；无输出即通过
```

- 配置在 `tsconfig.json`：`strict` + `noEmit`，`target: ES2022` / `lib: ES2023`（Bun 与 Node 22 的实际语义），`moduleResolution: Bundler` 适配现有无扩展名 ESM import；`types: ["bun"]` 提供 `Bun`/Node 全局（`tests/run.ts` 用 `Bun.spawn`）。只覆盖 `extensions/**` 与 `tests/**`，不扫 `node_modules` 或宿主包内部；`skipLibCheck` 跳过宿主 d.ts 的内部检查。
- 类型来源走 `devDependencies`（`typescript`、`@types/bun`、`typebox`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`），干净 clone 先 `npm install`；CI 里现有 `npm install --no-save ...` 会连同 package.json 的 devDependencies 一起装好。
- **typecheck 依赖 `tests/under-test/`**：`tests/harness.ts` 与 `tests/cases.ts` 静态 import 这份运行时副本（gitignored）。干净 clone 直接 `bun run typecheck` 会报一批 `TS2307`（约 24 条，`tests/cases.ts` 与 `tests/harness.ts` 指向 `./under-test/*`）；先跑一次 `bun tests/run.ts` 生成即可，CI 里 typecheck 排在 Run tests 之后就是为此。
- 错误必须用真实类型修（显式注解、类型守卫、`??` 兜底），**禁止** `@ts-ignore` / `@ts-expect-error` / `as any` / `!` 压错误；确需在宿主边界放宽时（如测试替身、宿主契约要求的字段），在 PR 里单独说明理由。

## 两个 jiti 相关的坑

1. **`export let` 的重新赋值不跨模块传播**。`readSettings` 若直接搬走，其它模块拿到的是初始值而不是后续赋的值。解法：`config.setSettingsReader(fn)` 注入，壳在 `default(pi)` 首行设置。
2. **模块级 const 与插件闭包**。写在 `export default` 闭包里的 `const` 对模块级函数不可见，引用会 `ReferenceError`——而这个错误会被 `before_agent_start` 的 try/catch 吞掉，表现为**简报静默变空**。共享的函数与常量一律放模块作用域。

## 设计约束（改代码前请先读）

1. **派生数据永不作事实源**：索引坏了就重建，绝不用索引反推条目。
2. **写路径必须有锁**：`summary.md` / `todo.md` 的读—改—写包在跨进程 `.lock`（O_EXCL，陈旧锁 30s 接管，最长等 3s）。
3. **简报有硬上限**：任何新增注入内容都要进分档预算，不得直接拼接。
4. **自动转正有闸门**：`inference` → `confirmed` 有两条自动路径（置信度 ≥0.85、证据 ≥3 天且复合分 ≥0.80），但 `kind=relation` 与 `action_impact=needs-confirm` **永不自动**，只能人工 `confirm`。
5. **过期不删数据**：`expired/` 与 `recovery/` 都靠轮转而非删除清理。
6. **读宽松、写严格**：frontmatter 校验在读路径只记录不阻断，写路径拒绝非法字段，生命周期操作对历史快照放宽。

## 测试组织

`tests/` 下每个用例一个临时 `HOME` + 独立子进程。新增行为请补用例，尤其是「静默失败」类——上面那个闭包作用域 bug 就是被一条画像断言意外抓出来的，否则会一直潜伏。

发版见 [publishing.md](./publishing.md)。
