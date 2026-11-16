# Changelog

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
