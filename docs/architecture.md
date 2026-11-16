# 架构与数据流

四张图：整体架构、写入时序、启动时序、简报装配，加上条目状态机与抽取流水线。

配图为 `img/` 下的 AI 插画版（`gpt-image-2.6-sunburst` 生成，白底，WebP q88，最长边 1200）：

| # | 图 | 图片 |
|---|---|---|
| 1 | 整体架构 | [01-architecture-ai.webp](img/01-architecture-ai.webp) |
| 2 | 写入时序 `remember` | [02-seq-remember-ai.webp](img/02-seq-remember-ai.webp) |
| 3 | 启动时序 `session_start` | [03-seq-session-ai.webp](img/03-seq-session-ai.webp) |
| 4 | 简报装配流程 | [04-flow-brief-ai.webp](img/04-flow-brief-ai.webp) |
| 5 | 条目状态机 | [05-state-machine-ai.webp](img/05-state-machine-ai.webp) |
| 6 | 抽取流水线 | [06-flow-extraction-ai.webp](img/06-flow-extraction-ai.webp) |
| 7 | 演进路线 | [07-roadmap-ai.webp](img/07-roadmap-ai.webp) |

下文各节的 `mermaid` 代码块是与代码同步的**结构源**（节点与边可直接改）；`mermaid/*.mmd` 是同一份源码的独立文件，需要矢量版时用任意 mermaid 渲染器重新出图。


## 1. 架构图

```mermaid
flowchart TB
  subgraph HOST["pi 宿主"]
    LOOP[agent loop]
    TOOLS[tool registry]
    CMD[slash commands]
  end

  subgraph EXT["pi-living-memory 扩展（单文件 2913 行）"]
    direction TB
    subgraph IFACE["接口层"]
      T1[remember]
      T2[living_memory]
      T3[living_memory_update]
      C1["/memory<br/>review · pending · todo · profile · on/off"]
      H1["钩子<br/>session_start · before_agent_start<br/>agent_end · agent_settled<br/>session_before_compact · session_shutdown"]
    end
    subgraph CORE["核心层"]
      W[写入<br/>writeEntry · writeAtomic<br/>withFileLockSync]
      R[读取<br/>findEntry · findConflicting<br/>listEntries · matchesQuery]
      G[治理<br/>confirm · supersede · renew · expire<br/>delete · restore · purge · archive]
      D[三文档面<br/>todo ops · summary ops · profile]
      X[抽取器<br/>runExtraction · 过滤 · 防重]
      BR[简报装配<br/>buildBrief · 分档预算]
    end
    subgraph CACHE["派生索引"]
      I1[index.json]
      I2[summary-index.json]
      I3[todo-index.json]
    end
  end

  subgraph STORE["~/.pi/agent/memory（纯文本，可 cp -r 备份）"]
    E[entries/*.md]
    EX[expired/]
    SM[summary.md · summary-archive.md]
    TD[todo.md · todo-archive.md]
    PF[profile.md]
    RC[recovery/]
    AL[activity.log]
    XF[extract-failures.jsonl]
    AR[archive/<br/>旧 MEMORY · SCRATCHPAD · daily]
  end

  QMD[qmd 只读检索<br/>外部可执行]

  LOOP --> H1
  TOOLS --> T1 & T2 & T3
  CMD --> C1
  T1 --> W
  T2 --> R
  T3 --> G & D
  H1 --> BR & X & G
  W --> E
  W --> RC
  W --> AL
  R --> E
  R -->|有 query| SM & TD
  R -->|无 query| CACHE
  BR --> CACHE
  G --> EX & SM & TD
  D --> SM & TD & PF & I2 & I3
  X --> E & XF
  CACHE --> E & SM & TD
  AR --> QMD
  T2 -->|source=archive| QMD
```

要点：**简报只读三个索引**（token 成本与库规模脱钩），**正文只在需要时读**（详情、查重候选用、关键词命中）。索引都带戳（`目录 mtime+文件数` 或 `文件 mtime+size`），一旦失配就重建，所以永远可以放心删。

## 2. 写入时序：一次 `remember`

```mermaid
sequenceDiagram
  autonumber
  participant M as 模型
  participant T as remember 工具
  participant Lock as withFileLockSync
  participant FS as ~/.pi/agent/memory
  participant Idx as index.json

  M->>T: kind · subject · text · basis · source · scope
  T->>T: 校验必填与 basis=inference 的 confidence
  alt /memory off（paused 标记存在）
    T-->>M: 拒写：写入已暂停
  else 正常
    T->>Idx: 读索引，筛同 kind+subject 的活动行
    T->>FS: 只读这几条候选的正文（不全库扫描）
    T->>T: bodySimilar 判是否同一条事实
    alt 已存在同 subject+kind 的活动条目
      T-->>M: 拒绝：已有同 subject 的活动条目 id=…，请用 supersede
    else 无冲突
      T->>Lock: 建 entries.lock（O_EXCL）
      T->>FS: 落 recovery/<ts>-<subject>.json 快照
      T->>FS: 原子写 entries/id.md（tmp + rename）
      T->>Idx: upsertIndexRow → flushIndex(重取 dirStamp)
      T->>FS: activity.log 追加 remember 一行
      T->>Lock: 释放
      T-->>M: 已记入长期记忆 id=…（status=…）
    end
  end
```

`supersede` 走同一把锁：旧条目 `status=superseded` + 正文追加「被 <新id> 取代」，新条目写入，索引两行一起更新，链不会断。

## 3. 启动时序：`session_start`

```mermaid
sequenceDiagram
  autonumber
  participant S as session_start
  participant T as autoTriage(A 档)
  participant RC as recovery
  participant Idx as 三个索引
  participant P as profile.md
  participant UI as ctx.ui

  S->>T: 只取 status=inference 的活动条目（上限 5 条）
  Note over T: A1 已被更新的版本取代 / A2 自指或过程性 → expire
  T-->>UI: notify「自动清理 N 条」（有动作才提示）
  S->>RC: rotateRecovery(180 天)，仅在有到期快照时动手
  S->>Idx: purgeCandidates(30) · todoIndex().done · dueRows() · summaryIndex().length
  S->>S: recentExtractFailures(24)
  alt 有可提示项（LIVING_MEMORY_START_HINTS≠0）
    S-->>UI: 「过期 N 条可归档 · 已完成 N 项可归档 · 待办 7 日内到期 · 抽取失败 N 次 · summary 节数超限」
  end
  S->>P: refreshProfile(false)（幂等，无变化不写盘）
  S->>UI: refreshWidget（常驻面板：活动/待确认/待办）
```

设计原则：**启动只提示、不改数据**（唯一例外是 A 档清理和 recovery 轮转，而且都记审计）。搬文件必须是显式命令。

## 4. 每轮简报装配：`before_agent_start`

```mermaid
flowchart LR
  A[before_agent_start] --> B{LIVING_MEMORY_BRIEF=0?}
  B -->|是| Z[不注入]
  B -->|否| C[读 index.json<br/>summary-index<br/>todo-index]
  C --> D[读 todo.md 摘要<br/>命中缓存则 0 次读盘]
  D --> E[分流<br/>到期 / 项目 / 待确认 / 全局]
  E --> F{逐档取数<br/>5 · 8 · 4 · 5}
  F --> G{累计 ≤ 2400 字符<br/>单行 ≤ 130 字符?}
  G -->|超出| H[计数 dropped，进页脚]
  G -->|未超| I[拼行]
  H --> I
  I --> J[页脚：活动 N · 到期 N · 待确认 N<br/>简报 M/T（N 条未显示）· 待办 N 项]
  J --> K[追加到 systemPrompt]
```

## 5. 条目状态机

```mermaid
stateDiagram-v2
  [*] --> explicit: remember basis=explicit
  [*] --> event: remember basis=event
  [*] --> inference: remember basis=inference<br/>或抽取器写入
  inference --> confirmed: confirm（用户点头）
  inference --> expired: autoTriage A 档<br/>（自指/过程性/被取代）
  explicit --> superseded: supersede
  event --> superseded: supersede
  confirmed --> superseded: supersede
  explicit --> expired: expire / 到期未续
  confirmed --> expired: expire / 到期未续
  expired --> explicit: restore / renew（复活）
  expired --> [*]: purge_expired（≥30 天，移出热库）
  superseded --> [*]: 保留在链上，只读
```

`status` 落在活动集合（`ACTIVE = explicit · event · inference · confirmed`）之外的条目才不进简报；`expired` 目录是**归档而非销毁**。

## 6. 抽取流水线

```mermaid
flowchart TD
  A[agent_end<br/>暂存本轮消息] --> B[agent_settled]
  B --> C{aborted? paused? EXTRACT=0?}
  C -->|是| Z[跳过]
  C -->|否| D[conversationText 拼正文]
  D --> E{有 apiKey 与模型?}
  E -->|否| Z2[记 activity.log：skipped]
  E -->|是| F[complete：抽取提示词<br/>准入五类 / 禁入清单 / 最多 3 条]
  F --> G{20s 超时?}
  G -->|超时| Z3[放弃本次]
  G -->|正常| H{解析 JSON 数组}
  H -->|no-json / parse-failed| XF[extract-failures.jsonl<br/>留原文片段]
  H -->|成功| I[逐条过滤<br/>自指 · 过程性 · 工程实现]
  I --> J[findConflicting 去重]
  J --> K[writeEntry status=inference]
  K --> L[activity.log: auto-extract created]
```

`session_before_compact` 会再触发一次同样的流水线——对话将被摘要化之前，先把还没落库的候选捞出来，防压缩丢失。

## 7. 为什么不直接用数据库

| 选择 | 原因 |
|---|---|
| 每条事实一个 `.md` 文件 | diff 可读、`git` 友好、`grep` 秒查、单条损坏不影响全库 |
| 三个 JSON 索引 | 只是缓存，能删能重建，不进 git 也不怕丢 |
| 不做向量库 | 语义召回对「事实型记忆」收益有限；关键词 + 元数据足够，且没有模型依赖 |
| qmd 只读外挂 | 冷数据（旧 MEMORY/daily）不值得日常加载，需要时用外部检索器召回 |
