# living-memory 回归测试

`../extensions/living-memory.ts` 的回归网。不带任何依赖，只用 bun。

```bash
cd ~/Projects/pi-extensions/pi-living-memory/tests
bun run.ts              # 全部 21 个用例（约 3s）
bun run.ts --only brief # 单条
bun run.ts --list       # 列出用例
```

退出码：全绿 0，有失败 1（可直接接 CI / hook）。

## 为什么是这个形状

- **每个用例一个临时 HOME + 独立子进程**。扩展在加载时就把 `STORE` 定成 `~/.pi/agent/memory`（`living-memory.ts:26`），同一进程里换不了，所以隔离必须靠子进程 + `HOME` 覆盖。
- **不碰真库**。`home` 是 `os.tmpdir()` 下的 `lmtest-<case>-xxxx`，跑完即删；任何用例写坏文件都伤不到 `~/.pi/agent/memory/`。
- **被测件来源**：优先包内 `extensions/living-memory.ts`，其次 `~/.pi/agent/extensions/living-memory.ts`（开发副本），可用 `LIVING_MEMORY_SRC=/path/to/x.ts` 覆盖（`setup.ts`）
- **被测件是运行时复制的副本** `under-test/living-memory.ts`（依据 `memory/README.md` 的 `STORE` 常量自动改写到临时目录，并做符号链接让 `typebox`/pi 包能解析）。所以测试跑的是**当前源码**，不是某个旧版本。

## 文件

| 文件 | 作用 |
|---|---|
| `run.ts` | 编排：选例 → 建临时 HOME → 子进程跑 → 汇总断言，退出码 |
| `setup.ts` | 建临时库、拷扩展、改写 `STORE`、符号链接依赖、生成最小 `pi`/`ctx` 桩 |
| `harness.ts` | 造数据种子（`basic`/`bulk`/`empty`/`lint`/`bigEntry`/`routing`）与 `load` / `call` / `out` / `read` 小工具 |
| `cases.ts` | 21 个用例：断言 + 说明 |
| `under-test/` | 运行时生成的扩展副本与 `node_modules` 软链，随时可删 |

## 覆盖的 21 个用例（94 断言）

| 用例 | 关键断言 |
|---|---|
| `brief` | 分档顺序（到期 > 项目 > 待确认 > 全局）、≤2400 字符、页脚计数、`project:acme` 命中 |
| `brief-optout` | `LIVING_MEMORY_BRIEF=0` → 不注入 |
| `brief-readbudget` | 简报读盘 0 次（只读索引，不碰正文） |
| `remember` | 写盘 + 索引行同步 + 回包格式；同 `subject+kind` 且正文相近 → 拦截并给旧 id |
| `supersede` | 换代取新 id、旧条 `status: superseded`、链护栏（≥4 代提示）、索引行跟着换代 |
| `expire` | `expire` 搬进 `expired/`、`renew` 直接复活、`expire+restore` 不带出失效副本 |
| `delete` | `delete` 写 `recovery/`、`restore` 取回 |
| `todo` | `todo_done` 勾选、`todo_add section=` 落位、`todo_archive` 搬 `- [x]` 到 `todo-archive.md`、`todo-index` 与盘一致 |
| `summary` | `summary_add` 写入并进目录索引（会话内立即可见）、`summary_update` 改写正文 |
| `summary-archive` | `keep=3` 移出最老小节到 `summary-archive.md`，`summary.md` 只留指针，归档区可检索 |
| `purge` | `purge_expired` 默认 dry_run、`dry_run=false` 搬入 `expired/` 并写月度台账 |
| `lint` | 重复/冲突检出并给出两个重叠 id |
| `routing` | A 段（长且过程性的 outcome → 建议迁 summary）、B 段（summary 里的规则句 → 建议升格） |
| `index-selfheal` | 删掉三个派生索引后按需重建（entries / todo / summary），手改 `summary.md` 被看见 |
| `archive-guard` | qmd 缺失时 `source=archive` 降级为可读提示，不抛异常 |
| `legacy-twin` | 只剩大写文件名时加载即改名（内容保留）；大小写并存时 `session_start` 提示人工合并，且不吞掉孪生文件 |
| `hints` | 过期可归档提醒、`todo.md` 内已完成项提醒、`LIVING_MEMORY_START_HINTS=0` 静默 |
| `profile` | STATS 块刷新、正文不被覆盖、第二次幂等不写盘 |
| `lock` | 两进程各写 8 条待办 → 16/16 全在、无重复、原有条目不丢 |
| `extract-fail` | `source=extract` 汇总 7 天失败、按原因计数、带原文片段与「最近一次成功」；24h 内有失败时开屏提示 |
| `todo-structured` | `@project`/`#tag`/`due:` 写到行尾；非法日期被拒；`query="@acme"`、`#p0`、`due:overdue|soon|YYYY-MM-DD` 筛选；简报「待办到期」行与页脚计数 |

## 加一个用例

1. 在 `cases.ts` 的 `CASES` 里加一行 `{ id, title, seed }`；
2. 写 `case "<id>":` 分支，用 `ok(名称, 条件, 给细节)` 断言；
3. 需要新数据形状就在 `harness.ts` 的 `seed()` 里加 `kind`，并同步 `Seed` 联合类型。

断言失败时 `ok` 会把实际值打到 `detail`，直接看输出定位即可。

## 维护约定

- 改了扩展中「落盘位置 / 返回文案 / 索引结构」的，这里对应断言必须一起改——测试跑绿但断言过时，比没测试更危险。
- 新增写操作（例如又加一个 `action`）至少配一条“写入 + 索引/派生物一致 + 回包文案”的断言。
- `under-test/` 每次运行重建，不要手改。
