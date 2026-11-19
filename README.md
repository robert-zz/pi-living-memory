# pi-living-memory
## English quick start

Durable, auditable long-term memory for a Pi session: facts are records with lifecycle
metadata (`kind` / `status` / `scope` / expiry / review), engineering state and todos
live in two plain-markdown documents, and every store has derived indexes so the
per-turn prompt cost stays flat as the library grows.

- **Install**: `pi install npm:pi-living-memory` (or `git:` / a local path).
  Remove any copy under `~/.pi/agent/extensions/` first — two instances register duplicate tools and commands (`/memory:1`, `/memory:2`).
- **Data** lives in `~/.pi/agent/memory/`: `entries/`, `todo.md`, `summary.md`, `profile.md`,
  `index.json` · `summary-index.json` · `todo-index.json` (derived, rebuildable), `activity.log`,
  `recovery/`, `expired/`, plus `archive/` when a qmd snapshot exists.
- **Tools**: `remember` (write) · `living_memory` (query: `entries` / `todo` / `summary` / `archive` / `extract`) ·
  `living_memory_update` (governance: `confirm` / `supersede` / `expire` / `restore`, `todo_*`, `summary_*`,
  `purge_expired`, `promote_scan`, `style_scan`, `auto_fact`, `profile_rebuild`).
- **Command**: `/memory` — overview, or `pending` / `todo` / `review` / `profile` / `style` / `on|off`.
- **Main env vars**: `LIVING_MEMORY_AUTO_FACT` (0.85 — inference becomes fact at or above) ·
  `LIVING_MEMORY_BRIEF_MAX_CHARS` (2400) · `LIVING_MEMORY_EXTRACT` · `LIVING_MEMORY_AUTO_TRIAGE` ·
  `LIVING_MEMORY_PROFILE_BRIEF` · `LIVING_MEMORY_AUTO_FACT_EVIDENCE`.
- **Before installing, know the defaults**: it writes `~/.pi/agent/memory/`, and by default
  sends the tail of each conversation to *your own* model provider for memory extraction
  (`LIVING_MEMORY_EXTRACT=0` disables). The Chinese section below spells out every side effect.
- **Tests**: `bun tests/run.ts` — 28 cases / 137 assertions against a temporary HOME, never your real store.
- **Dependencies**: `typebox` and `@earendil-works/*` are host-provided. They are declared as
  `peerDependencies` and never bundled (a physical copy would bypass Pi's module mapping).

Behavior, design trade-offs and the pitfalls we hit are documented in Chinese below.


Pi 扩展：**带生命周期的长期记忆**。事实不再是散文段落，而是有 `kind / status / scope / 过期 / 复核 / 证据来源` 的条目；工程实况与待办另有 `summary.md` / `todo.md` 两个文档面；三者各有一份派生索引，让每轮注入的上下文体积与库的规模脱钩。

**文档**：[使用说明](docs/guide.md)（记什么/怎么查/怎么清） · [架构与数据流](docs/architecture.md)（架构图·时序图·状态机） · [演进路线](docs/roadmap.md)

> **装之前请先读：它默认会做的事**
>
> 1. **写盘**：在你的 `~/.pi/agent/memory/` 下建目录、写条目、写 `index.json` 等文件。删掉扩展不会删这些文件。
> 2. **把对话交给模型（默认开）**：每个会话结束（`agent_settled`）时，扩展会把**本轮对话片段**（含你的提问与助手回复的结尾部分）发给**你自己配置的模型 provider** 做一次抽取，用来提出"值得记的事实"。抽取是本地代码调度、走你现有模型通道，**不经过第三方服务**，但确实会把文本发送给该 provider，并按你的 token 计费。不要这个行为：设 `LIVING_MEMORY_EXTRACT=0`。
> 3. **可能自动"转事实"**（默认开）：抽取给出的候选若 `basis=inference` 且 `confidence ≥ 0.85`，会直接写成 `status=confirmed`（`LIVING_MEMORY_AUTO_FACT` 可调，`1` 关闭）。`relation` 与 `action_impact=needs-confirm` 永不自动转正。
> 4. **开屏提示**：会话启动时可能在状态栏/通知里提示"过期 N 条""待办 N 项到期""画像 30 天未归纳"等（`LIVING_MEMORY_START_HINTS=0` 关）。
>
> 数据全部是纯文本 markdown + JSON，无数据库、无网络上报；想彻底清空就 `rm -rf ~/.pi/agent/memory`（先备份）。


## 安装

```bash
# npm（发布后的正式装法）
pi install npm:pi-living-memory

# git（钉 tag，可回滚）
pi install git:github.com/<you>/pi-living-memory@v0.1.0

# 本地目录（开发用，不复制）
pi install /path/to/pi-living-memory
```

**只能有一份实例**：装成包之后要删掉 `~/.pi/agent/extensions/living-memory.ts`，否则两份同时注册 `living_memory` / `remember`，`/memory` 会变成 `memory:1` / `memory:2`，两套内存缓存还会互相看不见对方的写入。

`pi list` 查看 / `pi remove <source>` 卸载。本地目录装的包**不会被 npm install**，依赖仍由宿主提供。

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
├── index.json          entries 派生索引（带 v 格式版本；过期/删掉自动重建，不丢数据）
├── summary-index.json  summary.md 目录索引
├── todo-index.json     todo.md 派生索引
├── miss.log            零命中日志（最近 200 条，供补库参考）
├── extract-failures.jsonl 抽取失败台账（最近 50 条）
├── expired/            purge 搬出的失效条目（索引文件 + 正文）
├── recovery/           每次写入前的上一版，按天轮转
├── activity.log        写操作审计（remember / 治理 / 待办 / 自动清理）
└── archive/            旧 MEMORY.md / SCRATCHPAD.md / daily 快照（只读，可 qmd 检索）
```

所有派生索引都靠 `目录 mtime + 文件数` 或 `mtime + size` 戳校验：外部手改或删除后自动重建，绝不作为事实源。

## 工具面

### `remember`

写一条事实。准入五类：`preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome`。必填 `kind subject text basis source`；`basis=inference` 必须带 `confidence`：**≥ 0.85 直接按事实写入（`status=confirmed`）**，低于门槛才保持 `pending`（「推断·弱」档）；`kind=relation` 与 `action_impact=needs-confirm` 无论置信度都仍需人工确认。同 `subject+kind` 已有活动条目时会被拦下，要求改用 `living_memory_update action=supersede`（避免并存矛盾事实）；唯一例外是旧条目仍为 `inference`：此时重复写入不会新建，而是给旧条目追加一条证据（`repeat` 或用户原话的 `restate`），见下节「推断转正」。

### `living_memory`（检索）

| source | 内容 |
|---|---|
| `entries`（默认） | 记忆条目，可按 `kind` / `status` / `subject_contains` / `text_contains` / `query` 过滤 |
| `todo` | `todo.md` 未完成项 + `todo-archive.md` 归档项（按关键词） |
| `summary` | `summary.md`；无 `query` 时给按项目分组的**目录导航**，有 `query` 才读正文匹配 |
| `summary-archive` | 已归档的旧工程小节 |
| `all` | 前三者一起查 |
| `archive` | qmd 只读快照检索（需要 `query`，走 `LIVING_MEMORY_QMD` 指定的 qmd） |
| `lint` | 冲突/重复自检 + **结构问题**：同 subject 的活动条目按正文 bigram Jaccard 相似度分组；随后列出 frontmatter 结构错误（缺 id、非法 kind/status/日期/scope、同 id 多文件等），按 severity 排序，最多 20 条并给总数 |
| `routing` | 分流审计：条目 ↔ summary 归属建议（工程实况类内容应迁 summary） |
| `expired` | 归档区失效条目（只读，带 id 供 `restore` 取回） |
| `extract` | 抽取器健康：近 7 天失败次数、按原因计数、明细片段、最近一次成功 |

### `living_memory_update`（治理）

`confirm` · `supersede` · `renew` · `expire`（无 id 时按 `kind/scope/subject_contains` 批量选择，默认 dry_run）· `delete` · `restore` · `todo_done` · `todo_undo` · `todo_add` · `todo_edit` · `todo_delete` · `todo_archive` · `summary_add` · `summary_update` · `summary_archive`（把最老的小节移到归档，默认保留 60）· `purge_expired`（默认 dry_run）· `rotate_recovery` · `profile_rebuild` · `promote_scan`（只读：按复合分排序推断条目，`match` 可当 limit）· `auto_fact`（手动跑 A+B 自动转正并按类返回清单）

### 斜杠命令

`/memory` 开面板（review / pending / todo / profile / style / on / off），`/memory pending` 逐条确认推断，`/memory style` 跑一次 30 天风格归纳。

## 数据校验与 lint

条目是 `entries/<id>.md` 的 frontmatter + 正文。校验分两条路径，**故意不对称**：

- **读路径宽松**：坏条目不会拖垮整个记忆层。解析失败或字段非法的条目仍被跳过（与早期行为一致），但问题会被记录下来，不再静默。
- **写路径收紧**：`remember` 与自动抽取在落盘前校验，有 error 直接拒绝并把字段与原因回给你；抽取器会把失败记进 `extract-failures.jsonl`（reason=`manifest-invalid`）后继续处理下一条候选。
- **生命周期操作放宽**：`expire` / `restore` / `resurrect` / `appendEvidence` / 自动清理与转正走 `strict:false`——它们处理的是历史快照，不能被旧字段卡死。代价是非法旧条目经 `expire` 后仍带错字段躺在 `expired/`，lint 会持续报告，这是有意的。

合法值：

| 字段 | 规则 |
|---|---|
| `id` | 必填，非空；同一 id 出现在多个文件会报 error |
| `kind` | `preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome` |
| `status` | `explicit` / `event` / `inference` / `confirmed` / `superseded` / `expired`（前四个算「活动」） |
| `obtained_at` / `confirmed_at` / `expires_at` / `review_after` | 可被 `Date.parse` 解析；**留空合法**（推断本无 `confirmed_at`，`expires_at`/`review_after` 常空） |
| `scope` | 逗号分隔多值，每项为 `global` / `workspace:<名>` / `project:<名>`；为空只 warn |
| `action_impact` | `advice-only` / `reminder` / `needs-confirm`（可空） |
| `confidence` | 0–1 的有限数字（可空） |
| `supersedes` / `evidence` / `source` 等 | 可空，不校验 |

为什么严格：非法日期会让 `ageDays` 变 `NaN`，purge 的「保留近 N 天」判断失效，条目可能被当作可清理；`status` 错拼（如 `explici`）会让条目**永远进不了简报与召回**，而文件看起来还在。

自查：`living_memory source=lint`；开屏 hints 在存在结构问题时也会提示（受 `LIVING_MEMORY_START_HINTS` 控制）。

## 简报与开屏

每轮注入的简报有硬上限（`LIVING_MEMORY_BRIEF_MAX_CHARS`，默认 2400 字符），按「到期 → 项目事实 → 待确认 → 全局」分档，全局档里**负面偏好（不要/禁止/避免…）排最前并打 `[雷区]` 标签**，单行 130 字符，页脚给出 `活动 N · 到期 N · 待确认 N · 简报 M/T（N 条未显示） · 待办 N 项` —— **条目再多也不会挤爆上下文**。

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
| `LIVING_MEMORY_PROFILE_BRIEF` | 关 | `1`（或 `touch ~/.pi/agent/memory/profile-brief.on`）把 profile.md 的「三、对外口径」「四、沟通与协作习惯」压成一行注入简报 |
| `LIVING_MEMORY_AUTO_FACT` | 0.85 | 推断置信度 ≥ 此值直接按事实处理（`status=confirmed`）；低于则只作弱参考。**会话启动时也会对存量推断按此追溯补判** |
| `LIVING_MEMORY_AUTO_FACT_EVIDENCE` | 开 | 设 `0` 关闭证据驱动自动转正（B 档） |
| `LIVING_MEMORY_AUTO_FACT_DAYS` | 3 | 证据需覆盖的不同日期数（B 档前置条件） |
| `LIVING_MEMORY_AUTO_FACT_SCORE` | 0.80 | 证据转正的复合分门槛（默认同 `LIVING_MEMORY_PROMOTE_THRESHOLD`）|
| `LIVING_MEMORY_PROMOTE_THRESHOLD` | 0.80 | 推断转正的复合分门槛（`promote_scan` 用） |
| `LIVING_MEMORY_START_HINTS` | 开 | `0` 关掉开屏提示 |
| `LIVING_MEMORY_QMD` | 自动探测 | archive 快照检索用的 qmd 可执行文件 |
| `LIVING_MEMORY_QMD_TIMEOUT_MS` | 60000 | qmd 调用超时 |
| `LIVING_MEMORY_DEBUG` | 关 | `1` 输出抽取/内部调试日志 |
| `LIVING_MEMORY_ACTIVITY_MAX` | 500 | activity.log 轮转前的行数上限 |
| `LIVING_MEMORY_RECALL` | 开 | `0` 关掉简报尾部的按问题召回段 |
| `LIVING_MEMORY_RECALL_MAX_ROWS` | 20000 | 召回 BM25 最多打分的索引行数（超限退化为只用 subject 词元） |
| `LIVING_MEMORY_RECALL_2L` | `ai,ci,pr,ui,db,ss` | 2 字母 ASCII 白名单（技术缩写仍进索引/查询），逗号分隔 |
| `LIVING_MEMORY_MISS_LOG` | 开 | `0` 关掉 `miss.log` 零命中记录 |

## 按问题召回

简报每轮会按**本轮用户消息**在索引行上跑一次 BM25，只补 3 条未进分档的相关条目，附在简报末尾：`· 召回（按本轮提问）：[subject](id 前 8 位) · …`。
索引行带 `toks`（v=3 格式：中文 bigram + ASCII 整词，后者只留长度 ≥3，外加 `ai/ci/pr/ui/db/ss` 六个 2 字母技术缩写白名单，可用 `LIVING_MEMORY_RECALL_2L` 覆盖），召回阶段不读正文；命中后仍按 id 用 `living_memory` 取全文。
打分前先过滤中文高频词元（`df/N > 5%`，如 用户/域名/发布/英文；语料 <20 条不启用），并要求至少 2 个有效词元命中；只命中 1 个时仅放行 ASCII 专名（`idf ≥ 3.5`，如 staging/tauri）。ASCII 整词豁免高频闸门——npm/2fa 这类技术标识符出现再多也仍有区分度。
`LIVING_MEMORY_RECALL=0` 关闭；`LIVING_MEMORY_RECALL_MAX_ROWS` 限制参与打分的行数。
零命中的 `source=entries` 查询会追加到 `miss.log`（保留 200 行），`LIVING_MEMORY_MISS_LOG=0` 关闭。

## 推断转正（口径 B）

### 两道路径

| 路径 | 触发 | 结果 |
|---|---|---|
| **置信度直达**（默认开） | `basis=inference` 且 `confidence ≥ 0.85`（`LIVING_MEMORY_AUTO_FACT`），`kind ≠ relation`，`action_impact ≠ needs-confirm` | 直接写 `status=confirmed`，回包注明「已按事实处理」；`/memory` 面板不改，仍可人工 supersede/expire 干预 |
| **证据累积转正**（默认开） | `evidence` 覆盖 ≥3 天且复合分 ≥0.80（`LIVING_MEMORY_AUTO_FACT_DAYS` / `_SCORE`） | 直接写 `status=confirmed`；`LIVING_MEMORY_AUTO_FACT_EVIDENCE=0` 退回「只标可转正、需 confirm」 |
| **降权** | 低于门槛，或属 relation / needs-confirm | 留在「推断·弱」档，只作弱参考，不参与按事实的决策 |

也就是说：**无人工干预时，高置信推断会直接影响后续决策；低置信推断只出现在简报的弱参考档。**

推断条目（`status=inference`）的 frontmatter 带 `confidence`（抽取模型自评 0–1）与 `evidence`（JSON 数组，每条 `{at, kind, id, note}`，最多 20 条）。

**证据累积**（自动）：同一事实再次出现时不新建条目，只追加证据——`remember` 重复写入记 `repeat`（同一天同一来源去重）、用户原话重述记 `restate`、抽取器再次命中记 `repeat`。

**复合分**（`living_memory_update action=promote_scan`，只读）：

```
score = confidence × 0.40        # 自评最多 40%
      + min(复现天数, 3)/3 × 0.50   # 3 次独立复现拿满 50%
      + 0.30 (存在 restate)         # 用户原话重述
      - 0.25 (kind ∈ relation/decision/outcome)
      - 0.20 (subject 或正文含「可能/大概/待定/估计…」)
```

**门槛（三条同时满足）**：`score ≥ 0.80`、独立证据 ≥2（按「日期+来源」去重）、`kind ≠ relation` 且 `action_impact ≠ needs-confirm`。越过门槛只标「可转正」，**转正仍需 `confirm`**。实测：自评 0.9 无证据 = 0.36；自评 0.8 + 2 源复现 + 1 次原话重述 = 0.81。

## 画像与归纳（三个旋钮）

`profile.md` 是唯一「跨条目归纳」的地方：统计块机械生成，五节正文人写。三件事按需打开：

1. **画像进简报**（默认关）：`LIVING_MEMORY_PROFILE_BRIEF=1` 或 `touch ~/.pi/agent/memory/profile-brief.on`，把「三、对外口径」「四、沟通与协作习惯」压成一行（≤200 字，`暂无` 占位、引用块、markdown 装饰与证据 id 括号自动剔除）附在简报末尾。前提是这两节写的是**通用风格结论**，不是项目特例。

**已经把真库改成「可注入」形态**（2026-11-16）：`profile.md` 的「三」「四」两节重写为 9 句短口径（193 字），项目细节（公司主体、地址双写、PDF 版式、英语描述模板、纠正史、内容站口味）移到新增的「六、对外材料细节（不进简报）」；`profile-brief.on` 已创建，下个会话起简报末尾会带一行 `· 画像：…`。

2. **月度归纳**：`living_memory_update action=style_scan match=30` 列出窗口内的偏好/纠正/雷区（带证据 id），供你和 agent 归纳成画像候选；每次运行写 `profile-style.last`，超过 30 天未跑时开屏提示一次。
3. **雷区优先**：简报全局档按负面偏好排序（`不要/别把/禁止/不得/避免/切勿`、英文 `never/don't/avoid`），命中的条目加 `[雷区]` 前缀——「别做 X」不会因为条目变多被普通偏好挤掉。

## 测试

```bash
bun tests/run.ts            # 全部（21 用例 / 94 断言，约 3s）
bun tests/run.ts --only brief
bun tests/run.ts --list
```

每个用例一个临时 `HOME` + 独立子进程（扩展在加载期定 `$HOME/.pi/agent/memory`，不隔离就会写到真库）。被测件默认取包内 `extensions/living-memory.ts`；`LIVING_MEMORY_SRC=/path/to/x.ts` 可指向开发副本。依赖通过 `tests/under-test/node_modules` 软链到最新 pi 安装目录解析。

## 开发轨

**单一来源**：`extensions/living-memory.ts`（本仓）。`~/.pi/agent/extensions/` 下不再保留副本——两份实例会各自缓存索引与文件状态，互相看不见对方的写入（曾经把大写 `summary.md` 写回来一次）。

日常循环：

```bash
cd /path/to/pi-living-memory
# 改 extensions/living-memory.ts
bun tests/run.ts          # 28 用例 / 137 断言，跑在临时 HOME，不碰真库
/reload                   # 包路径就是本目录，pi 重新读盘即生效
git commit -am "..." && git tag v0.1.x
```

`/reload` 只重载模块；**删/加扩展文件、改 `settings.json` 的 packages 后必须重启 pi**，否则旧实例的注册不会消失（表现为 `/memory:1`、`/memory:2`）。

## 升级与回滚

```bash
pi update --extensions           # 按 settings 里写明的 spec 重新解析
pi install git:github.com/<you>/pi-living-memory@v0.0.9   # 退回旧 tag
```

包升级只换代码，`~/.pi/agent/memory` 原样保留；`/reload` 即可生效。

## 发布到 npm

```bash
npm login --auth-type=web     # 浏览器完成登录（CLI 侧不再要求本地 OTP）
npm pack --dry-run            # 看清单与体积（现在 459 KB / 27 个文件）
npm version patch             # bump 版本（已发布版本不可覆盖）
npm stage publish             # 只是暂存；发布见下节「2FA 与 staged publishing」
```

发布前确认四件事：

1. `package.json` **不能有** `"private": true`；
2. `typebox` / `@earendil-works/*` 只能在 `peerDependencies`（`"*"`）里，**不能进 `dependencies`**——物理副本会绕过 pi 的模块映射（`docs/packages.md:114`）；
3. 版本号必须 bump（同版本重发会被 registry 拒绝，已发布版本删不掉，只能 `npm deprecate`）；
4. 包名可用：`curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/pi-living-memory`，`404` 才是空闲。

`keywords` 里有 `pi-package` 就会出现在 [pi.dev/packages](https://pi.dev/packages) 的 gallery。发布后 `pi install npm:pi-living-memory@<版本>` 验证，再把 `settings.json` 里的本地路径条目换成 npm spec——两者并存会造成“源码改了、装的是旧行为”的错觉。


### 2FA 与 staged publishing（2025 年后必读）

npm 已于 2025 年停止**新增** TOTP：`npm profile enable-2fa` 会返回
`404 – Adding a new TOTP 2FA is no longer supported`，只剩安全密钥 / Passkey（WebAuthn）。而发布规则变成“**发布必须带 2FA，或带 bypass-2FA 的 granular token**”，且 bypass token **只能暂存、不能直发**：

```
npm publish        → 403 E_STAGE_REQUIRED
                     "this token can only publish to a staging area"
npm stage publish  → 成功，输出 staged id
npm stage approve  → 需要 2FA（proof-of-presence），由浏览器完成
```

因此**首次发布在无硬件密钥时的唯一路径**是「电脑 stage + 手机 approve」：

1. 电脑：`npm stage publish`（bypass-2FA granular token 写进 `~/.npmrc`）
2. 终端报 `EOTP` 并打印 `https://www.npmjs.com/auth/cli/<id>`（TTY 下才完整显示，管道里会被打码成 `***`）
3. 手机 Chrome **先登录 npmjs**（未登录会被重定向回首页），再打开该链接，用 passkey 确认
4. 终端保持运行（它每几秒轮询 `/-/v1/done?authId=…`），成功后打印 `+ pi-living-memory@<版本>`

四个实测过的坑：

- **链接 60 秒级过期**：复制到手机再打开要快，超时就重跑命令拿新 authId；
- **别扫码**：Linux 版 Chrome 没有实现 hybrid/caBLE，「手机当安全密钥」在桌面上必然连不上（与本机 IPv6/局域网无关）；
- **`approve` 在 `validating` 期间报 `404 staged version not found`**：等 `npm stage list` 里状态变成 `staged`（扫描校验通常 1–3 分钟）再 approve；
- **暂存版本与已发布版本共用版本号空间**：暂存了 0.1.10 就不能再发 0.1.10，丢弃用 `npm stage reject <id>`。

stage 与 approve 是两次独立请求，可分布在不同设备：**stage 跟着源码走，approve 跟着你的认证器走**。有 USB 安全密钥时两者都在电脑；CI（GitHub Actions）可以 stage，人在手机上 approve——这正是 staged publishing 的设计意图。

`npm stage list [<pkg>]` 查看、`npm stage view <id>` 看详情、`npm stage download <id>` 取回 tarball 做检查。


## 设计约束（改代码前请先读）

1. **派生数据永不作事实源**：索引坏了就重建，绝不用索引反推条目。
2. **写路径必须有锁**：`summary.md` / `todo.md` 的读—改—写包在跨进程 `.lock`（O_EXCL，陈旧锁 30s 接管，最长等 3s）。
3. **简报有硬上限**：任何新增注入内容都要进分档预算，不得直接拼接。
4. **自动转正有闸门**：`inference` → `confirmed` 有两条自动路径（置信度 ≥0.85、证据 ≥3 天且复合分 ≥0.80），但 `kind=relation` 与 `action_impact=needs-confirm` **永自动**，只能人工 `confirm`；面板与人工干预流程不变。
5. **过期不删数据**：`expired/` 与 `recovery/` 都靠轮转而非删除清理。
6. **读宽松、写严格**：frontmatter 校验在读路径只记录不阻断，写路径拒绝非法字段，生命周期操作对历史快照放宽（见「数据校验与 lint」）。
