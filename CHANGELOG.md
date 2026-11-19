# Changelog

## [0.2.0] - 2026-11-19

重构（对外行为除「写入非法字段被拒」外不变）。

- 单文件拆为 12 个模块：壳 3719 → 955 行，业务下沉至 `src/`（config/text/paths/manifest/recall、三个 store、ops/brief/extract）。
- Config/Clock/Logger 注入层：`loadConfig()` 集中 28 个 `LIVING_MEMORY_*` 环境变量；`systemClock` 唯一持有墙上时钟，`setClock`/`setConfig` 供测试冻结。
- 三个 Store 收口各自文件与派生索引：EntryStore（含生命周期 `expire`/`resurrect`/`restore`/`purgeExpired`）、TodoStore、SummaryStore。
- `readSettings`、`refreshWidget` 改注入，规避 jiti 下 `export let` 不跨模块传播。
- `isNegation` 下移 `text.ts`，消除 ops↔brief 环；47 条 import 边全部严格层降，`src/**` 零顶层 IO。
- 删除 20 个零调用点的 `@deprecated` 薄包装。

数据校验：

- **Manifest 校验**：新增 `validateManifest` 纯函数与 `parseEntryWithIssues`。读路径宽松（坏条目跳过但记录），写路径严格（`remember`/自动抽取拒绝非法字段并回原因），生命周期操作 `strict:false` 兼容历史数据。
- `source=lint` 增加「结构问题」段：缺 id、非法 kind/status/日期/scope/action_impact/confidence、frontmatter 缺失或未闭合、同 id 多文件；按 severity 排序，最多 20 条并给总数。
- 开屏 hints 新增结构问题计数（受 `LIVING_MEMORY_START_HINTS` 控制）。

测试：194 → 230 断言、41 → 44 用例。


## [0.1.14] - 2026-11-18

召回词元的 2 字母白名单。

- `ASCII_SHORT_OK`：`ai/ci/pr/ui/db/ss` 六个技术缩写即使在 2 字母也进索引与查询（`PR 评审`、`CI 失败`、`AI 配图`、`DB 迁移` 现在能召回），非白名单的 2 字母词（`qa/is/to`）仍被丢弃。可用 `LIVING_MEMORY_RECALL_2L` 覆盖（逗号分隔，全小写）。
- 索引版本 `v=3 → v=4`：`rows.every(toks)` 守卫只查字段存在、感知不到词元内容变化，白名单改了词元集合就必须升版本，否则旧 v3 索引会被继续沿用（三个派生索引会在下次启动各重建一次，无数据风险）。
- 测试新增 `recall-ascii-short`（5 断言）：白名单四词召回 + 非白名单词不召回；全套 192 断言 / 39 用例。

## [0.1.13] - 2026-11-18

召回调参：高频词元过滤、最少命中约束、ASCII 整词。

- `tokensOf`：中文仍走 bigram；ASCII 改为按空白/标点切的整词且只保留长度 ≥3（`-A` 与 2 字母碎片不再进索引，不做子词/前缀匹配），入参保留原始标点才能保住词边界。词元内容变了 → 索引 `v=3`，旧索引一律重建；真库 115 条重建后 `index.json` 63,184 → 62,530 字节（单行词元上限 40 未变）
- 中文高频闸门：`df/N > 0.05` 的中文词元不参与打分（用户/域名/发布/英文这类）；过滤后查询侧无词元直接返回空；语料 <20 条时比例没有统计意义，不启用
- 最少命中：至少 2 个参与打分的词元命中；仅 1 个时只放行 ASCII 整词且 `idf ≥ 3.5`（staging/tauri 这类专名）
- 中文与 ASCII 为什么不对称：中文 bigram 切不出专名——N=85 时 域名/自己 的 idf 也能到 3.5+，单命中放行几乎全是假阳性；ASCII 整词是技术标识符（npm/2fa/staging），出现频率高也仍有区分度，所以豁免高频闸门并独享单命中例外
- 语料统计改为「状态/scope 合格的全部条目」，简报去重只影响输出：否则简报抽走几十条会把 df 压到 1、idf 虚高到 3.9，通用词又会被单命中例外放行
- 测试新增 `recall-stopword` / `recall-ascii-exempt` / `recall-single-token` / `recall-hitcount`；共 38 用例 / 187 断言

## [0.1.12] - 2026-11-18

按问题召回与零命中日志。

- `index.json` 行新增 `toks`（中文 bigram + ASCII 词元，最多 40 个）；`v=2` 且缺 `toks` 的旧索引自动重建（`writeEntry` upsert / 删除 / 全量重建三条路径都带词元）
- `recallFor(query, cwd, excludeIds)`：只在索引行上跑 BM25（`k1=1.2, b=0.75`，subject 命中 ×3），返回 top 3；行数超 `LIVING_MEMORY_RECALL_MAX_ROWS`（默认 20000）时只用 subject 词元打分
- 简报尾部新增召回段（最多 3 条、subject ≤80 字符、整段 ≤300 字符，按简报已含 id 去重；预算不够先砍召回段）；`LIVING_MEMORY_RECALL=0` 关闭
- `source=entries` 零命中（`q` ≥2 字符）写 `miss.log`（保留最后 200 行，`withFileLockSync` 内读—改—写）；`LIVING_MEMORY_MISS_LOG=0` 关闭
- 测试新增 `index-toks` / `recall-rank` / `recall-limits` / `recall-dedup` / `recall-off` / `miss-log`；共 174 断言

## [0.1.11] - 2026-11-17

画廊元数据：README 首屏英文化（安装/数据/工具/开关六行速览），`pi.image` 指向 1200px 白底预览图（`docs/img/01-architecture-ai.webp`，37K）。

## [0.1.10] - 2026-11-17

发布卫生：副作用前置、示例去品牌、CI。

- README 顶部新增「装之前请先读：它默认会做的事」——写盘、默认把对话尾部发给**你自己配置的模型**做抽取（`LIVING_MEMORY_EXTRACT=0` 关）、≥0.85 自动转事实、开屏提示；英文摘要同步一行
- 示例与测试夹具去掉真实项目名（`project:acme`、`/work/acme`），README 本地安装路径泛化为 `/path/to/pi-living-memory`
- `tests/setup.ts` 依赖解析改为「仓内 node_modules 优先，pi 安装目录兜底」，CI 无需 pi 运行时
- 新增 `.github/workflows/test.yml`（push / PR 跑 `bun run test`；依赖从 npm 装 typebox 与 `@earendil-works/*`）

## [0.1.9] - 2026-11-17

画像可一键注入与风格归纳入口。

- `LIVING_MEMORY_PROFILE_BRIEF` 支持文件开关：`touch ~/.pi/agent/memory/profile-brief.on`（不必再设环境变量；`=0` 仍可强制关）
- `/memory style`：跑一次 30 天窗口的 `style_scan`，通知出雷区/偏好候选，详情仍用 `living_memory action=style_scan`
- 真库 `profile.md` 的「三、对外口径」「四、沟通与协作习惯」按 30 天证据重写为 176 字（此前把项目特例混进了对外口径）

## [0.1.7] - 2026-11-17

派生索引加格式版本闸门（A 档追溯本应生效却没跑）。

- `index.json` / `summary-index.json` / `todo-index.json` 现在带 `v` 字段（`IDX_VERSION=2`），读取时必须匹配，否则重建
- 起因：`toIndexRow` 新增 `confidence` 后，旧索引的 `stamp` 仍然有效（目录没变），于是被继续沿用，A 档读不到置信度 → 静默不转正
- 测试：`auto-fact-retro` 增加「旧格式索引（无 v、无 confidence）必须被判过期并重建」断言；共 137 断言
## [0.1.6] - 2026-11-17

推断自动按事实：A 按已存置信度追溯 + B 证据累积自动转正。

- **A 追溯补判**：`session_start` 扫 `inference`，`confidence ≥ 0.85`（`LIVING_MEMORY_AUTO_FACT`）且非 relation/needs-confirm → 直接 `confirmed`；规则上线前的存量推断会在下次开会话时补齐，幂等
- **B 证据转正**：`evidence` 覆盖 ≥3 个不同日期（`LIVING_MEMORY_AUTO_FACT_DAYS`）且复合分 ≥0.8（`LIVING_MEMORY_AUTO_FACT_SCORE`）→ 自动 `confirmed`；`LIVING_MEMORY_AUTO_FACT_EVIDENCE=0` 关闭
- 新增工具动作 `auto_fact`（手动跑 A+B，返回转正清单）
- 索引行补 `confidence` 字段（否则追溯判定读不到置信度）；`remember` 回包改为显示实际落盘状态
- 测试：+2 用例（追溯 / 证据），共 28 用例 135 断言
## [0.1.5] - 2026-11-16

推断按置信度自动处理（允许人工干预，面板不变）。

### 变更
- `confidence ≥ 0.85`（`LIVING_MEMORY_AUTO_FACT` 可调）且 `kind ≠ relation`、`action_impact ≠ needs-confirm` 的 `inference` 直接写 `status=confirmed`，`remember` 与自动抽取两条写入路径同时生效；回包与 `activity.log` 标注 `auto-fact`。
- 低于门槛的推断降权：简报档位由 `[待确认]` 改为 `[推断·弱]`，语义上不再按事实处理。
- `/memory` 面板与 `confirm` 流程不变；`promote_scan` 仍处理「靠证据累积转正」的那条路径（测试里用 `LIVING_MEMORY_AUTO_FACT=0.95` 隔离）。

### 测试
- 新增用例 `auto-fact`（9 断言：0.9 转事实 / 0.6 保推断 / relation 0.95 不转 / needs-confirm 0.95 不转 / 简报标「推断·弱」）。
- 全量 26 用例 / 126 断言通过。

## [0.1.4] - 2026-11-16

画像真正可用：profile.md 改写为可注入形态 + 摘要清洗。

### 变更
- `profileDigest()` 清洗规则：跳过引用块/小标题/注释行，剥掉 `**`、反引号与「（含 2026… 证据 id）」括号，压平空白；仍以 200 字为上限。
- 真库 `profile.md`：三、四节重写为 9 句短口径（193 字，可完整注入）；新增「六、对外材料细节（不进简报）」收纳公司主体/地址/PDF 版式/英语模板/纠正史/内容站口味。
- `profile-brief.on` 已创建（真库画像注入开启）。

### 测试
- `profile-brief` 用例新增 3 断言（剥装饰、去证据 id、≤200 字）；全量 25 用例 / 117 断言通过。

## [0.1.3] - 2026-11-16

长期画像的三个旋钮：画像进简报、月度归纳、雷区优先。

### 新增
- `profileDigest()`：只取 `profile.md` 的「三、对外口径」「四、沟通与协作习惯」，去 HTML 注释与 `暂无` 占位，压成 ≤200 字一行。
- 简报末尾注入 `· 画像：…`；默认关，`LIVING_MEMORY_PROFILE_BRIEF=1` 或 `touch ~/.pi/agent/memory/profile-brief.on` 打开。
- `living_memory_update action=style_scan match=<天数>`（只读）：列出窗口内 preference/constraint/correction，分出雷区与普通偏好，附证据 id 与归纳指引；写 `profile-style.last` 戳。
- 开屏提示：30 天未跑 `style_scan` 且活动条目 ≥5 时提示一次（受 `LIVING_MEMORY_START_HINTS` 控制）。
- 简报全局档对负面偏好（不要/别把/禁止/不得/避免/切勿/never/don't/avoid）排序优先，并加 `[雷区]` 前缀。

### 修复
- `profileDigest` / `isNegation` / `PROFILE_BRIEF_ON` 一度被声明在插件闭包内，模块级函数引用时报 `isNegation is not defined`（静默吞掉整块简报）；已提到模块作用域。

### 测试
- 新增用例 `profile-brief`（4 断言）、`negation`（3 断言）、`style-scan`（5 断言）。
- 全量：25 用例 / 114 断言通过。

## [0.1.2] - 2026-11-16

推断转正（口径 B）：证据累积 + 复合分。

### 新增
- `evidence` frontmatter 字段（`[{at, kind, id, note}]`，最多 20 条）。
- 证据累积：同一事实再次出现时不新建条目 —— `remember` 重复写入记 `repeat`（同日同源去重）、用户原话重述记 `restate`、抽取器再次命中记 `repeat`。
- `promote_scan`（只读）：按复合分排序全部 `inference` 条目，明细列出 `base/repeat/restate/penalty/days/independent` 与门槛判定。

### 权重（口径 B）
- `confidence × 0.40` + `min(复现天数,3)/3 × 0.50` + `0.30`（有 restate）− `0.25`（kind ∈ relation/decision/outcome）− `0.20`（含糊词）。
- 门槛：`score ≥ 0.80`（`LIVING_MEMORY_PROMOTE_THRESHOLD`）、独立证据 ≥2、`kind ≠ relation`、`action_impact ≠ needs-confirm`。
- 越过门槛只标「可转正」，`confirmed` 仍需用户 `confirm`。

### 测试
- 新增用例 `promote`（8 断言）：同源去重、异源复现、原话重述、0.81 越线、evidence 落盘。
- 全量：22 用例 / 102 断言通过。

## [0.1.1] - 2026-11-16

文档补齐：使用说明、架构图（含 7 张 AI 配图）、演进路线。

### 文档
- `docs/guide.md`：三个文档面分工、`remember` 写法、10 个检索面、18 个治理 action、三条日常动线、简报四档配额、故障排查。
- `docs/architecture.md`：架构 / 写入时序 / 启动时序 / 简报装配 / 条目状态机 / 抽取流水线 6 图 + 「为什么不直接用数据库」的设计取舍。
- `docs/roadmap.md`：v0.1.x → v1.0 五档里程碑与「明确不做」清单。
- `docs/mermaid/*.mmd`：与正文代码块同源的结构源；`docs/img/*.webp`：配图（白底，q88）。

## [0.1.0] - 2026-11-16

首个打包版本：把长期以单文件形式运行在 `~/.pi/agent/extensions/` 的扩展收成可安装的 Pi 包。

### 记忆条目
- `remember` 写入带生命周期元数据的条目：`kind / status / basis / scope / expires_at / review_after / supersedes / action_impact`。
- 同 `subject+kind` 活动条目冲突时拒绝写入，改用 `supersede`（旧条目保留在链上）。
- `delete` 前落 `recovery/` 快照，可按 id 前缀 `restore`。
- `expire` 把条目搬到 `expired/`（索引文件 + 正文），`restore` 从归档区取回。

### 三个文档面
- `summary.md` 工程实况（`[NN]` 编号小节）+ `summary-archive.md` 归档。
- `todo.md` 未完成待办 + `todo-archive.md` 已完成归档（按月份）。
- `profile.md` 聚合画像：机械统计块自动刷新，正文人写。

### 检索
- `living_memory` 十个检索面：`entries / todo / summary / summary-archive / all / archive / lint / routing / expired / extract`。
- `lint` 冲突自检（同 subject 正文 bigram Jaccard 相似度）；`routing` 分流审计（条目 ↔ summary 归属建议）。
- `archive` 走 qmd 只读快照检索旧 `MEMORY.md` / `SCRATCHPAD.md` / `daily`。

### 上下文成本
- 简报硬上限 + 分档预算（到期 → 项目 → 待确认 → 全局），页脚报告未显示条数。
- 三个派生索引（`index.json` / `summary-index.json` / `todo-index.json`）让简报、查重、待办摘录不再读正文，且与库规模脱钩。

### 写入安全
- 跨进程文件锁（O_EXCL，陈旧锁 30 秒接管）+ 原子写（临时文件 + rename）。
- `activity.log` 审计所有写操作，按行数上限轮转。
- 抽取失败落 `extract-failures.jsonl`，`source=extract` 可查原因与原文片段，24 小时内失败会在开屏提示。

### 测试
- `tests/`：21 个用例 / 94 条断言，每例独立临时 `HOME` + 子进程，约 3 秒跑完。

### 文档
- `docs/guide.md` 使用说明；`docs/architecture.md` 架构图 / 写入与启动时序 / 简报装配 / 条目状态机 / 抽取流水线；`docs/roadmap.md` 演进路线与「明确不做」清单。
