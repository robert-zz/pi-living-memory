# pi-living-memory

Pi 扩展：**带生命周期的长期记忆**。事实不再是散文段落，而是有 `kind / status / scope / 过期 / 复核 / 证据来源` 的条目；工程实况与待办另有 `summary.md` / `todo.md` 两个文档面；三者各有一份派生索引，让每轮注入的上下文体积与库的规模脱钩。

## 安装

```bash
# 本地目录（开发用，不复制）
pi install /work/projects/pi-extensions/pi-living-memory

# git（钉 tag，可回滚）
pi install git:github.com/<you>/pi-living-memory@v0.1.0
```

`pi list` 查看 / `pi remove <source>` 卸载。装成包之后**必须删掉** `~/.pi/agent/extensions/living-memory.ts`，否则两份实例同时注册 `living_memory` / `remember`，工具会重名。

依赖由 pi 宿主提供（`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`typebox`），因此这三个是 `peerDependencies`，包内不带副本。

## 数据在哪

代码与数据分离：扩展升级不碰记忆。

```
~/.pi/agent/memory/
├── entries/            每条事实一个文件（frontmatter + 正文）
├── summary.md          工程实况（按项目分节，每个小节 [NN] 编号）
├── summary-archive.md  被归档的旧小节
├── todo.md             未完成待办（- [ ]），与 todo-archive.md 分家
├── todo-archive.md     已完成待办（按月份归档）
├── profile.md          聚合画像（机械统计块由扩展刷新，正文人写）
├── index.json          entries 派生索引（删掉自动重建，不丢数据）
├── summary-index.json  summary.md 目录索引
├── todo-index.json     todo.md 派生索引
├── extract-failures.jsonl 抽取失败台账（最近 50 条）
├── expired/            purge 搬出的失效条目（索引文件 + 正文）
├── recovery/           每次写入前的上一版，按天轮转
├── activity.log        写操作审计（remember / 治理 / 待办 / 自动清理）
└── archive/            旧 MEMORY.md / SCRATCHPAD.md / daily 快照（只读，可 qmd 检索）
```

所有派生索引都靠 `目录 mtime + 文件数` 或 `mtime + size` 戳校验：外部手改或删除后自动重建，绝不作为事实源。

## 工具面

### `remember`

写一条事实。准入五类：`preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome`。必填 `kind subject text basis source`；`basis=inference` 必须带 `confidence`，且保持 `pending` 直到用户确认。同 `subject+kind` 已有活动条目时会被拦下，要求改用 `living_memory_update action=supersede`（避免并存矛盾事实）。

### `living_memory`（检索）

| source | 内容 |
|---|---|
| `entries`（默认） | 记忆条目，可按 `kind` / `status` / `subject_contains` / `text_contains` / `query` 过滤 |
| `todo` | `todo.md` 未完成项 + `todo-archive.md` 归档项（按关键词） |
| `summary` | `summary.md`；无 `query` 时给按项目分组的**目录导航**，有 `query` 才读正文匹配 |
| `summary-archive` | 已归档的旧工程小节 |
| `all` | 前三者一起查 |
| `archive` | qmd 只读快照检索（需要 `query`，走 `LIVING_MEMORY_QMD` 指定的 qmd） |
| `lint` | 冲突/重复自检：同 subject 的活动条目按正文 bigram Jaccard 相似度分组 |
| `routing` | 分流审计：条目 ↔ summary 归属建议（工程实况类内容应迁 summary） |
| `expired` | 归档区失效条目（只读，带 id 供 `restore` 取回） |
| `extract` | 抽取器健康：近 7 天失败次数、按原因计数、明细片段、最近一次成功 |

### `living_memory_update`（治理）

`confirm` · `supersede` · `renew` · `expire`（无 id 时按 `kind/scope/subject_contains` 批量选择，默认 dry_run）· `delete` · `restore` · `todo_done` · `todo_undo` · `todo_add` · `todo_edit` · `todo_delete` · `todo_archive` · `summary_add` · `summary_update` · `summary_archive`（把最老的小节移到归档，默认保留 60）· `purge_expired`（默认 dry_run）· `rotate_recovery` · `profile_rebuild`

### 斜杠命令

`/memory` 开面板（review / pending / todo / profile / on / off），`/memory pending` 逐条确认推断。

## 简报与开屏

每轮注入的简报有硬上限（`LIVING_MEMORY_BRIEF_MAX_CHARS`，默认 2400 字符），按「到期 → 项目事实 → 待确认 → 全局」分档，单行 130 字符，页脚给出 `活动 N · 到期 N · 待确认 N · 简报 M/T（N 条未显示） · 待办 N 项` —— **条目再多也不会挤爆上下文**。

`session_start` 只提示、不动数据：到期可归档条数、已完成待办可归档条数、24h 内抽取失败次数、summary 小节数超限。`LIVING_MEMORY_START_HINTS=0` 关掉。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `LIVING_MEMORY_BRIEF` | 开 | `0` 完全不注入简报 |
| `LIVING_MEMORY_BRIEF_MAX_CHARS` | 2400 | 简报字符上限 |
| `LIVING_MEMORY_TODO_DIGEST_CHARS` | 400 | 简报里待办摘录的字符预算 |
| `LIVING_MEMORY_EXTRACT` | 开 | `0` 关掉自动抽取 |
| `LIVING_MEMORY_EXTRACT_MODEL` | 宿主默认模型 | 抽取用的模型 |
| `LIVING_MEMORY_EXTRACT_TIMEOUT_MS` | 见源码 | 抽取超时 |
| `LIVING_MEMORY_AUTO_TRIAGE` | 开 | `0` 关掉会话启动自动清理（A 档） |
| `LIVING_MEMORY_NO_AUTO_REVIEW` | 关 | 关掉复核期自动标 pending |
| `LIVING_MEMORY_RECOVERY_DAYS` | 180 | recovery 快照保留天数 |
| `LIVING_MEMORY_SUMMARY_KEEP` | 60 | 自动归档保留的小节数 |
| `LIVING_MEMORY_AUTO_ARCHIVE` | 开 | 小节超限自动归档 |
| `LIVING_MEMORY_PROFILE_AUTO` | 开 | 会话启动刷新画像统计块（幂等） |
| `LIVING_MEMORY_START_HINTS` | 开 | `0` 关掉开屏提示 |
| `LIVING_MEMORY_QMD` | 自动探测 | archive 快照检索用的 qmd 可执行文件 |
| `LIVING_MEMORY_QMD_TIMEOUT_MS` | 60000 | qmd 调用超时 |
| `LIVING_MEMORY_DEBUG` | 关 | `1` 输出抽取/内部调试日志 |
| `LIVING_MEMORY_ACTIVITY_MAX` | 500 | activity.log 轮转前的行数上限 |

## 测试

```bash
bun tests/run.ts            # 全部（21 用例 / 94 断言，约 3s）
bun tests/run.ts --only brief
bun tests/run.ts --list
```

每个用例一个临时 `HOME` + 独立子进程（扩展在加载期定 `$HOME/.pi/agent/memory`，不隔离就会写到真库）。被测件默认取包内 `extensions/living-memory.ts`；`LIVING_MEMORY_SRC=/path/to/x.ts` 可指向开发副本。依赖通过 `tests/under-test/node_modules` 软链到最新 pi 安装目录解析。

## 开发轨

改代码时可以两处并存，但**同一时间只能有一处被加载**：

- 开发副本 `~/.pi/agent/extensions/living-memory.ts`（`/reload` 立即生效，适合快速迭代）；
- 包 `/work/projects/pi-extensions/pi-living-memory/extensions/living-memory.ts`（版本化、可回滚，适合稳定态）。

同步方向固定为「开发副本 → 包」，别反向改包：

```bash
cp ~/.pi/agent/extensions/living-memory.ts \
   /work/projects/pi-extensions/pi-living-memory/extensions/living-memory.ts
cd /work/projects/pi-extensions/pi-living-memory && bun tests/run.ts
git commit -am "..." && git tag v0.1.x
```

## 升级与回滚

```bash
pi update --extensions           # 按 settings 里写明的 spec 重新解析
pi install git:github.com/<you>/pi-living-memory@v0.0.9   # 退回旧 tag
```

包升级只换代码，`~/.pi/agent/memory` 原样保留；`/reload` 即可生效。

## 设计约束（改代码前请先读）

1. **派生数据永不作事实源**：索引坏了就重建，绝不用索引反推条目。
2. **写路径必须有锁**：`summary.md` / `todo.md` 的读—改—写包在跨进程 `.lock`（O_EXCL，陈旧锁 30s 接管，最长等 3s）。
3. **简报有硬上限**：任何新增注入内容都要进分档预算，不得直接拼接。
4. **待确认不得自动转正**：`basis=inference` 只能靠用户确认或显式 supersede 升级。
5. **过期不删数据**：`expired/` 与 `recovery/` 都靠轮转而非删除清理。
