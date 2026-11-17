# Changelog

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
