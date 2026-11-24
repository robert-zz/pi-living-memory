# 基准（召回 + 抽取回放）

回答「这次改动有没有把真实提问的检索变差」——只评检索，不做全自动答案判定。
59 条真实提问的 `gold` 是期望命中的条目 id；答案对不对由人工抽检校准（见文末）。
另含 `--extract` 抽取决策回放：只测「解析 → 归一 → 冲突/配额」这层，不联网、报告型、不进发布门禁（见文末）。

```
benchmarks/
  questions.jsonl     # 59 题：{id, q, cat, scope, gold}；gold=[] 表示 absent（库里没有）
  extract-gold.jsonl  # 32 条抽取回放夹具：model_out + expect（录制样本，脱敏）
  run.ts              # 跑分 + 自检 + 基线门禁（--extract 走抽取回放）
  baseline.json       # 发布门禁基线（--update-baseline 生成）
  README.md
```

## 指标定义

| 指标 | 口径 |
| --- | --- |
| Recall@3 | 只在有 `gold` 的题上算：top3 命中的 gold 条数 / gold 总条数，再对题取宏平均（0–1） |
| Recall@5 | 同上，取 top5；与 Recall@3 由同一次 `rankRecall(..., k=5)` 的前缀得出 |
| MRR@3 | 只在有 `gold` 的题上算：第一个命中 gold 的名次 `r` 记 `1/r`（r≤3），前 3 名都不命中记 0，再取宏平均 |
| 拒答准确率 | 只算 `absent` 类（`gold=[]`）：返回空数组才算对，非空即错；`正确数 / absent 题数`。门禁按「不低于基线 −5pp」比较（见门禁语义） |
| 检索耗时 p50/p95 | 每题「scope 过滤 + `rankRecall(q, corpus, undefined, 5)`」的墙钟耗时，最近秩百分位 |
| 读盘字节 | 评估阶段前后 `/proc/self/io` 的 `rchar` 差；含 `buildBrief` 读 profile/todo 的开销（`rankRecall` 本身不读盘）；非 Linux 打印 `n/a` 不报错 |
| 注入字符 | 每题 `buildBrief(undefined, q).length`，输出总和与均值（均值为总长 / 59） |

召回状态口径沿用 `RECALL_STATUS`（`confirmed` / `explicit` / `event`），与线上召回一致。
`scope` 用假 cwd `/bench/<token>` 走 `inScope`：`global` 条目在任何 scope 下都可见，与线上行为一致；`scope=null` 表示不限定（全库）。

## 六类问题

| cat | 含义 |
| --- | --- |
| `exact` | 精确事实（日期、数字、名称、单一取值） |
| `state` | 当前状态 / 现行做法（「现在是什么」） |
| `history` | 历史沿革 / 变更过程（「后来改成了什么」） |
| `neg` | 负面约束、雷区（「能不能 / 该不该」） |
| `scope` | 只在某个 project/workspace 下成立的事实（考察 scope 过滤） |
| `absent` | 库里没有的答案（考察拒答，`gold=[]`） |

## 门禁语义

- 默认运行读 `benchmarks/baseline.json`，比较**整体 Recall@3**：
  `(baseline.recall_at_3 - 本次.recall_at_3) / baseline.recall_at_3 > 5%` → 打印 `BASELINE REGRESSION`，退出码 1（阻断发布）。
- 退化 ≤5%（或指标变好）→ PASS。
- **拒答准确率（口径 A，拍板 2026-11-24，决策来源：用户选 A）**：本次 `refusal_accuracy` 必须 `≥ baseline.refusal_accuracy − 5pp`，
  自检行打印实际门槛（如 `absent 判空率 ≥0.4500（基线 0.5000 −5pp）`），不满足即该条 FAIL、退出码 1。
  用相对口径的理由：库会随使用增长，absent 题越来越难自然判空，**绝对值 ≥0.50 会在没有退化时假阻断**；相对口径只拦「比基线掉 5pp 以上」。
- 基线缺失，或旧基线没有 `refusal_accuracy` 字段 → 拒答门槛回落到绝对值 `≥0.50`。
- `--baseline <path>` 指另一份基线做门禁（负向测试用）；`--update-baseline` 始终写默认 `benchmarks/baseline.json`。
- 无 `baseline.json` → 打印「baseline 缺失，跳过门禁」并正常退出（自检仍照跑）。
- `baseline.json` 存在但无法解析 / 缺 `recall_at_3` → 直接报错退出 1，不静默放行。
- 更新基线：`bun benchmarks/run.ts --update-baseline`（自检 FAIL 时不写，避免把退化固化）。

基线同时记录 `generated_at`、`git_head`、`entry_count`（索引行总数）、`question_count`，用来判断基线与本次是否同一库规模；rebase / 大量新增条目后应重新生成。

## 自检（内置，任一 FAIL 退出码 1）

- `Recall@3 ≥ 0.40`
- `absent 判空率 ≥ baseline.refusal_accuracy − 5pp`（无基线时 `≥ 0.50`，行内打印实际门槛）
- `59 题全部跑完无异常`

## 复现

```bash
cd /work/projects/pi-extensions/pi-living-memory

# 默认库 + 门禁
bun benchmarks/run.ts

# 抽取决策回放（不联网、报告型）
bun benchmarks/run.ts --extract
bun benchmarks/run.ts --extract --memory /tmp/memcopy
bun benchmarks/run.ts --extract-live   # 只打印说明，不联网

# 库副本（先用 cp -a 固定快照，避免跑分期间库被会话改写）
cp -a ~/.pi/agent/memory /tmp/memcopy
bun benchmarks/run.ts --memory /tmp/memcopy

# 负向测试：换一份基线（例：把 refusal_accuracy 改成 0.60 应退出 1，改成 0.45 应退出 0）
bun benchmarks/run.ts --baseline /tmp/baseline-strict.json

# 生成/刷新基线
bun benchmarks/run.ts --update-baseline
```

**只读保证**：runner 先把 `--memory`（默认 `~/.pi/agent/memory`）整库复制到临时 HOME 的 `.pi/agent/memory`，再加载扩展源码；扩展的 STORE 在模块加载期按 HOME 定死，索引自愈与缓存落盘都只发生在临时快照里，跑完即删，**原库零写入**。
Bun 会在进程启动时缓存 `os.homedir()`，只改 `process.env.HOME` 不会让 `paths.ts` 的 STORE 换目录；runner 在加载扩展前同时替换 `homedir()`、跑完还原，`--memory` 才真正生效。
代价是临时 HOME 下没有用户的 pi `settings.json`，基准按默认配置跑（环境变量 `LIVING_MEMORY_*` 仍生效）；基线与本次用同一口径，门禁比较不受影响。

## 哪段结论由哪段输出支撑

| 想得到的结论 | 对应的输出段 |
| --- | --- |
| 检索质量是否相对基线退化 | `基线门禁` 段的 `Recall@3 A → B，相对退化 x%` 与最终 `结论：PASS/FAIL` |
| 哪一类问题最弱（该补什么） | `按 cat` 表的 `Recall@3 / Recall@5 / MRR@3` 分行 |
| 拒答行为是否变差 | `自检` 的拒答门槛行（`≥基线 −5pp` 与实际值）+ `拒答准确率` 行 + `absent 未判空（诊断）` 列出的题号与误召回 id |
| 注入成本是否膨胀 | `注入字符` 行的「总 / 均」；均值进 baseline，可直接跨版本对比 |
| 检索是否变慢 / 读盘是否变多 | `检索耗时 p50/p95` 行 + `读盘字节` 行 |
| 本次结果是否可信 | `自检` 段三条 PASS/FAIL（Recall 下限、拒答下限、59 题跑完无异常） |

## 人工抽检校准（20 条）

自动指标只认 id 命中，不判答案是否切题。发布前从 59 题里固定抽 20 条（建议每 3 题取 1 条，覆盖六类），
逐条看 top3 的 `subject` 是否真能回答 `q`：明显不切题的命中在 `questions.jsonl` 里修正 `gold` 并记 issue。
抽检结论不回写 `baseline.json`，只改题集——题集变更后必须重跑 `--update-baseline`。

## 已知边界（不在本基准里做）

- 不做答案生成质量判定（LLM 判分不在门禁内）。
- 不调整召回打分/DF 门槛：`absent` 误召回只作诊断输出（`absent 未判空`），要改算法请走独立提案。
- `questions.jsonl` 的 `q` / `gold` 只由人工维护；runner 只校验结构（cat 合法、absent 的 gold 必空、id 不重复）。

## 抽取决策回放（--extract，报告型，不进发布门禁）

只跑三段纯函数：`parseExtractionOutput` → `normalizeExtractionItems` → `decideExtractionBatch`；
`findConflicting` 注入临时 HOME 快照库的 `entryStore.findConflicting`（同召回基准的只读保证，原库零写入）。
不调用模型、不联网。

### 为什么用录制回放

- **确定性**：同一份 fixtures + 同一库快照，六项指标逐字复现，可以进 CI；真调模型会带温度和采样抖动，回归信号会被模型噪声淹没。
- **不烧模型**：一次跑 32 案，真调模型既慢又花钱；回放只考「模型回包之后，我们这一层判断得对不对」。
- **责任边界清楚**：模型该抽什么由模型侧负责；本基准只回答解析、字段闸门、自指过滤、同批去重、配额、与既有条目的冲突分流是否正确。

模型侧漂移不能靠回放证明。`--extract-live` 只打印一行说明并退出 0（脚本不做任何网络调用）：需要在 pi 会话内按线上抽取器录制新回包，再与本目录 fixtures 人工比对。

### 七类 family

| family | 含义 | 条数 |
| --- | --- | --- |
| `clean` | 正常回包：1–3 条合法候选，覆盖缺省 confidence、relation 不自动转事实、围栏 JSON、空数组 | 8 |
| `self-ref` | subject 讲插件自身（简报/面板/抽取器/派生索引等），应被 `isPluginInternal` 拦下，不立条目 | 5 |
| `duplicate` | 同批 kind+subject+body 完全重复只留首条；同 subject 不同正文/不同 kind 应并存 | 4 |
| `over-quota` | 模型给 4–5 条；只处理前 3 条，配额之外的坏字段不计入 skip 计数 | 4 |
| `invalid-field` | 非法 kind / 空 subject / 空 body，逐条进 `invalid` skip | 4 |
| `parse-failure` | `parse-failed`（坏 JSON）/ `no-json`（找不到数组）/ `empty-response`（空回包）三种分支各一条；`accepted`、skip、conflict、auto_fact 全为 0 | 3 |
| `conflict-with-existing` | `existing_hint` 指向库中真实条目；同 kind+subject 且正文相似时判 `conflict`，不新建条目 | 4 |

### 指标定义（六项 + 字段级拆分）

| 指标 | 口径 |
| --- | --- |
| 决策准确率 | 逐案六字段（`accepted` 集合、`self_ref`、`duplicate`、`invalid`、`conflicts`、`auto_fact`）全部命中才算一案命中；`accepted` 按 kind/subject 多重集比较，不看顺序 |
| 字段级 | 决策准确率的拆分（非独立门禁指标）：上述六个字段各自按案命中率，用来区分「整体差」还是「只有某道闸门错」 |
| 解析失败率 | `parseExtractionOutput` 返回 `!ok` 的案数 / 总案数；下一行「解析失败构成」再拆成 `empty-response` / `no-json` / `parse-failed` 三种分支 |
| 自指噪声率 | `normalizeExtractionItems` 的 `self-ref` skip 数 / 模型给出的候选数（`model_out` 数组长度；解析失败按 0） |
| 重复率 | `duplicate` skip 数 / 同上分母 |
| 待确认占比 | create 中未达 auto-fact 门槛的条数 / create 总数；门槛走线上 `autoFactable(kind, confidence, "advice-only")`（默认 0.85，relation 永不自动转事实） |
| 平均耗时 | `parse → normalize → decide` 的单案均值，按 `<1 / <10 / <100 / ≥100 ms` 分档；精确墙钟另起「墙钟参考（非指标）」行，每次运行会浮动，不参与确定性对比 |

六项指标里「平均耗时」用分档而不是精确毫秒，是为了让连跑两次的指标段逐字相同；精确值只作诊断。

### fixtures 的局限

- `extract-gold.jsonl` 的 `model_out` 是**录制/固化样本**（recorded fixtures），按线上抽取器的 prompt 与回包形态整理，**不是本轮联网调用结果**，也不代表当前模型版本。
- 回放只能证明「决策层对这批回包的处理」；模型侧漂移（该抽的没抽、措辞变了、JSON 结构变了）必须人工用 `--extract-live` 录制新回包后与 fixtures 对照。
- `conflict-with-existing` 依赖默认库里的真实条目 id（`existing_hint`）。换库（`--memory`）或条目被删/改名时，该 case 会报 `conflicts` 不符——这是预期的夹具诊断，不是决策层回归。
- 回放不写库：冲突 case 只走到 `decideExtractionBatch`，不执行 `runExtraction` 的 appendEvidence / put。

### 隐私脱敏

- 所有 `text` 都是脱敏改写，不含真实人名、健康、财务、密钥原文。
- `conflict-with-existing` 只挑选中性工作流规则条目（提交规则、文档格式、子代理模型规则、配图尺寸），`model_out` 只保留触发相似度所需的短句，不复制隐私类条目。
- 库本身只读：runner 先整库快照到临时 HOME，再加载扩展源码，跑完即删。

### 失败如何定位（三步）

1. **哪个 case**：看「逐案失败」段的 `id` 与 `family`，先判断错的是正常抽取、自指、去重、配额、字段、解析还是冲突类。
2. **哪个 skip 原因**：同一段下的「skip 实况」列出 `self-ref` / `duplicate` / `invalid(kind|subject|body)`，以及对应的 kind/subject；解析失败看 `解析失败率` 与 `model_out`。
3. **哪条纯函数**：按「定位」行回到代码——
   - `normalizeExtractionItems`：字段闸门、`isPluginInternal` 自指、同批去重、前 3 条配额；
   - `decideExtractionBatch` + `entryStore.findConflicting`：与既有条目冲突的分流（先核对 `existing_hint`）；
   - `autoFactable`：auto-fact 门槛与 kind 排除面。

改完只重跑 `bun benchmarks/run.ts --extract`；报告型指标不进发布门禁，自检底线只有「所有用例跑完不抛异常」（抛异常才退出 1）。
