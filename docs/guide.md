# pi-living-memory 使用说明

记什么、怎么记、怎么查、怎么清 —— 四个问题的操作手册。图和数据流见 [`architecture.md`](./architecture.md)，版本规划见 [`roadmap.md`](./roadmap.md)。

## 1. 它解决什么问题

普通「记忆文件」有两个慢性病：**只增不减**（半年后没人敢读）、**混装**（用户偏好和工程实现堆在一起）。pi-living-memory 把记忆拆成三个面，各用各的写法：

| 面 | 存放 | 适合什么 | 写法 |
|---|---|---|---|
| 条目 | `entries/*.md` | 稳定偏好、约束、承诺、关系、纠正、拍板的决策、结果 | `remember` / `living_memory_update` |
| 工程实况 | `summary.md` | 做了什么、为什么、坑在哪、版本号 | `summary_add` / `summary_update` |
| 待办 | `todo.md` | 未完成事项 | `todo_add`，完成就 `todo_done` |

外加一个纯人读的 `profile.md`（画像统计 + 归纳正文）。

## 2. 三条铁律

1. **派生数据永不作事实源**。`index.json` / `summary-index.json` / `todo-index.json` 是可重建缓存，删了不丢数据。
2. **待确认不得自动转正**。抽取器写进来的 `inference` 条目只有两种命运：用户 `confirm`，或被 `supersede` 取代。
3. **过期不删数据**。`expire` 只是搬到 `expired/`，`delete` 前先落 `recovery/`，都能 `restore`。

## 3. 写：`remember`

```
remember kind=preference subject=用户 代码风格 text="偏好简短回复，不要客套" source="2026-11-16 用户原话『…』"
```

| 参数 | 说明 |
|---|---|
| `kind` | `preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome` |
| `basis` | `explicit`（用户原话）/ `event`（事实发生）/ `inference`（推断，必须带 `confidence`） |
| `source` | **日期 + 谁说的 + 原话引用**，将来复核全靠这一行 |
| `scope` | `global` / `workspace:vault` / `project:acme`，多值逗号分隔；决定简报里排在哪一档 |

会被拦下的两种情况：

- **同 `subject+kind` 已有活动条目** → 返回既有 id，要求 `living_memory_update action=supersede`（旧条目留在链上，不会两份矛盾并存）；
- **`/memory off` 期间** → 拒写，恢复用 `/memory on`。

**判断能不能写**：三天后、换个会话、换个项目，这条信息还有用吗？只有「是」才写。工程实现细节走 `summary_add`，不占条目。

## 4. 查：`living_memory`

| source | 用途 | 例子 |
|---|---|---|
| `entries` | 按元数据或关键词找事实 | `living_memory query=部署 status=confirmed` |
| `todo` | 未完成待办 + 归档项 | `living_memory source=todo query=acme` |
| `summary` | 无 `query` 给**目录导航**（按项目分组），有 `query` 读正文 | `living_memory source=summary query=OSS` |
| `summary-archive` | 已归档的旧小节 | `living_memory source=summary-archive query=dnspod` |
| `all` | 前三者一起 | `living_memory source=all query=dnssec` |
| `expired` | 归档区失效条目（带 id 可取回） | `living_memory source=expired query=域名` |
| `lint` | 同 subject 条目的相似度自检 | `living_memory source=lint` |
| `routing` | 条目 ↔ summary 归属建议 | `living_memory source=routing` |
| `archive` | qmd 只读快照（旧 MEMORY/SCRATCHPAD/daily） | `living_memory source=archive query=软链` |
| `extract` | 抽取器健康 | `living_memory source=extract` |

`due=true` 只看今天到期/该复核的条目。

## 5. 治：`living_memory_update`

| action | 什么时候用 |
|---|---|
| `confirm` | 抽取器写的推断是对的 |
| `supersede` | 事实变了（金额、路径、方案），**不要新写一条并存** |
| `renew` | 事情还在继续，只是到期了 —— 顺带续期 |
| `expire` | 事情结束/失效。无 id 时按 `kind`/`scope`/`subject_contains` 批量选（默认 dry_run） |
| `delete` | 写错了、不该存在。删前自动落 recovery |
| `restore` | 误删/误过期，按 id 前缀取回 |
| `todo_done` / `todo_undo` | 勾选 / 撤销，`match` 用唯一关键词 |
| `todo_add` / `todo_edit` / `todo_delete` | 待办增改删（`section` 指定小节，`due` 写截止日，`tags` 打标签） |
| `todo_archive` | 把 `todo.md` 里所有 `- [x]` 搬去 `todo-archive.md`（按月份） |
| `summary_add` / `summary_update` | 记工程实况：新建 `[NN]` 小节 / 改写已有小节正文 |
| `summary_archive` | 最老的小节移到 `summary-archive.md`（默认保留 60 节） |
| `purge_expired` | `expired/` 里超 30 天的条目真正移出热库（默认 dry_run） |
| `rotate_recovery` | `recovery/` 超 180 天的快照清理 |
| `profile_rebuild` | 重算 `profile.md` 的统计块（幂等，无变化不写盘） |

## 6. 日常三条动线

**开工**（什么都不用做）：简报自动注入，页脚告诉你库的状态：

```
活动 60 · 到期 0 · 待确认 9 · 简报 14/32（18 条未显示） · 待办 44 项
```

「简报 14/32」= 32 条可见条目里只有 14 条进了上下文，其余靠检索取。**消失了不等于丢了**。

**干活中**：需要背景时说一句「查一下 acme 的技术栈」即可，模型会调 `living_memory`；你纠正事实时，agent 会 `supersede`。

**收尾**：三句命令把当天沉淀下来 ——

```bash
/memory pending     # 把当天抽取的推断逐条过一遍：确认 / 改 / 删
/memory todo        # 完成的勾掉，缺的补上（可批量归档已完成）
/memory review      # 到期的条目：续期 / 失效
```

## 7. 常见任务速查

| 想做的事 | 一条命令 |
|---|---|
| 记一条用户偏好 | `remember kind=preference subject=用户… basis=explicit …` |
| 事实变了（旧的不对） | `living_memory_update action=supersede id=<旧id> text="新事实"` |
| 项目结束了 | `living_memory_update action=expire scope=project:xxx dry_run=false` |
| 查某项目所有待办 | `living_memory source=todo query=@acme` |
| 今天有什么到期 | `living_memory due=true` |
| SUMMARY 太长 | `living_memory_update action=summary_archive keep=60` |
| 归档区里翻旧账 | `living_memory source=archive query="某个词"` |
| 临时不想被写记忆 | `/memory off` → 完事 `/memory on` |
| 自检有没有重复/矛盾 | `living_memory source=lint` |

## 8. 简报是怎么排的

每轮注入有硬上限（默认 2400 字符，单行 130 字符），按四档取：

| 档 | 条数上限 | 内容 |
|---|---|---|
| `[到期]` | 5 | 到复核期或已过期的活动条目 |
| 项目 | 8 | `scope` 命中当前 cwd 的条目 |
| `[待确认]` | 4 | `status=inference` 的推断（弱参考，标注了身份） |
| 全局 | 5 | 其余 `scope=global` |

超出的部分在页脚报数，不塞进上下文。想调整：`LIVING_MEMORY_BRIEF_MAX_CHARS`。

## 9. 自动抽取（可以完全关掉）

模型回合结束后，扩展会把这一轮对话丢给「抽取器」模型，产出最多 3 条候选，写进 `status=inference`：

- 自指内容（记忆系统自身状态）、过程性事项（提案/瞬时 git 状态）、工程实现细节（「我们加了某索引」）**一律不抽**，归 `summary.md`；
- 抽取结果还要过四层确定性硬闸（`extensions/src/extract.ts` 纯函数；手工 `remember` 不走闸）：
  - **L0 溯源**：候选必须带 `quote`（用户原话逐字引文）；缺失、短于 6 字符或对不上本轮用户轮次 → `unverified` 丢弃，不回退；
  - **L1 噪声**：正文含命令/工具 token、仓库路径、任务书词汇，或「我已改/修/跑/验证」这类过程自述 → `noise` 丢弃；
  - **L2 自指**：正文讲记忆插件自身（`LIVING_MEMORY_`、`/memory`、`living_memory(`、`extensions/src/`）→ `self-ref` 丢弃；
  - 被闸记录落 `extract-gates.jsonl`（最近 200 条），`source=extract` 可看近 7 天被闸条数与原因分布；
- 先观察不拦：`LIVING_MEMORY_EXTRACT_GATE=0` 进入影子模式，照样记账但候选继续落库，用来评估误杀率后再收紧；
- 失败不再静默：落 `extract-failures.jsonl`，`source=extract` 可查原因与原文片段，24 小时内失败会在开屏提示；
- 关掉：`LIVING_MEMORY_EXTRACT=0`；临时暂停：`/memory off`（连手动 `remember` 也拒写）。

## 10. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 工具重名、行为像两个版本 | `~/.pi/agent/extensions/living-memory.ts` 和包同时加载了 —— 删开发副本，只留一处 |
| 开屏提示「发现大写孪生文件」 | 旧实例把 `SUMMARY.md` 写回来了：`/reload` 后人工合并（`healLegacyNames()` 会自动改名，但内容是分叉的） |
| `source=extract` 一直有失败 | 看 reason：`request-failed` 多为限流/无 key；`no-json`/`parse-failed` 看 detail 里的原文片段 |
| 索引看起来旧了 | 不用管，戳（`mtime+size`）一变自动重建；也可直接删 `index.json` |
| 想导出/迁移 | 备份 `~/.pi/agent/memory/` 即可；三个 `*.json` 索引不必带 |

## 11. 安全边界

- 所有写入走**跨进程文件锁**（`.lock`，O_EXCL，陈旧锁 30 秒接管）+ **原子写**（临时文件 + rename），多会话并行不互相覆盖；
- 每次写入前落 `recovery/`，`activity.log` 记录 who/what/when；
- 记忆库不加密，**不要记凭证、密钥、健康/财务等敏感推断**（抽取器也会拒绝）；
- 代码与数据分离：升级扩展、换 tag、回滚版本都不碰 `~/.pi/agent/memory/`。
