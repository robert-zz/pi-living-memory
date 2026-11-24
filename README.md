# pi-living-memory

[中文文档](https://github.com/robert-zz/pi-living-memory/blob/main/README.zh-CN.md)

## English quick start

Durable, auditable long-term memory for a Pi session: facts are records with lifecycle
metadata (`kind` / `status` / `scope` / expiry / review), engineering state and todos
live in two plain-markdown documents, and every store has derived indexes so the
per-turn prompt cost stays flat as the library grows.

- **Install**: `pi install npm:pi-living-memory` (or `git:` / a local path).
  Remove any copy under `~/.pi/agent/extensions/` first - two instances register duplicate tools and commands (`/memory:1`, `/memory:2`).
- **Data** lives in `~/.pi/agent/memory/`: `entries/`, `todo.md`, `summary.md`, `profile.md`,
  `index.json` | `summary-index.json` | `todo-index.json` (derived, rebuildable), `activity.log`,
  `recovery/`, `expired/`, plus `archive/` when a qmd snapshot exists.
- **Tools**: `remember` (write) | `living_memory` (query: `entries` / `todo` / `summary` / `archive` / `extract`) |
  `living_memory_update` (governance: `confirm` / `supersede` / `expire` / `restore`, `todo_*`, `summary_*`,
  `purge_expired`, `promote_scan`, `style_scan`, `auto_fact`, `profile_rebuild`).
- **Command**: `/memory` - overview, or `pending` / `todo` / `review` / `profile` / `style` / `on|off`.
- **Main env vars**: `LIVING_MEMORY_AUTO_FACT` (0.85 - inference becomes fact at or above) |
  `LIVING_MEMORY_BRIEF_MAX_CHARS` (2400) | `LIVING_MEMORY_EXTRACT` | `LIVING_MEMORY_AUTO_TRIAGE` |
  `LIVING_MEMORY_PROFILE_BRIEF` | `LIVING_MEMORY_AUTO_FACT_EVIDENCE`.
- **Before installing, know the defaults**: it writes `~/.pi/agent/memory/`, and by default
  sends the tail of each conversation to *your own* model provider for memory extraction
  (`LIVING_MEMORY_EXTRACT=0` disables). The section "Before installing: default behavior" spells out every side effect.
- **Tests**: `bun tests/run.ts` - 61 cases / 276 assertions against a temporary HOME, never your real store.
- **Dependencies**: `typebox` and `@earendil-works/*` are host-provided. They are declared as
  `peerDependencies` and never bundled (a physical copy would bypass Pi's module mapping).

![pi-living-memory demo](https://raw.githubusercontent.com/robert-zz/pi-living-memory/main/docs/img/08-demo.gif)

## Before installing: default behavior

1. **Writes to disk**: creates directories under `~/.pi/agent/memory/`, writes entries and files such as `index.json`. Removing the extension does not remove these files.
2. **Sends conversation to the model (on by default)**: at the end of each session (`agent_settled`), the extension sends this turn's conversation slice (your prompts and the tail of assistant replies) to **your own configured model provider** for one extraction pass that proposes facts worth remembering. Scheduling is local code and the call goes through your existing model channel, **no third-party service**, but the text does reach that provider and is billed against your tokens. Set `LIVING_MEMORY_EXTRACT=0` to opt out.
3. **May auto-promote inference to fact (on by default)**: extracted candidates with `basis=inference` and `confidence >= 0.85` are written as `status=confirmed` (`LIVING_MEMORY_AUTO_FACT` tunes the threshold, `1` disables promotion). `relation` and `action_impact=needs-confirm` are never auto-promoted.
4. **Session-start hints**: on startup it may show the expired count, todos due, or a profile not summarized for 30 days in the status bar or notifications (`LIVING_MEMORY_START_HINTS=0` disables).

All data is plain markdown + JSON: no database, no network reporting. To wipe it completely run `rm -rf ~/.pi/agent/memory` (back it up first).

## Install

```bash
# npm (the normal install once published)
pi install npm:pi-living-memory

# git (pinned tag, easy rollback)
pi install git:github.com/robert-zz/pi-living-memory@v0.2.2

# local directory (development, no copy)
pi install /path/to/pi-living-memory
```

**Exactly one instance**: after installing as a package, delete `~/.pi/agent/extensions/living-memory.ts`. Otherwise the two instances both register `living_memory` / `remember`, `/memory` turns into `memory:1` / `memory:2`, and the two in-memory caches cannot see each other's writes.

**Restart pi after editing `packages` in `settings.json` or adding/removing extension files.** `/reload` does not clear registrations from the old instance. For daily code edits `/reload` is enough.

`pi list` to inspect, `pi remove <source>` to uninstall. A local-directory install is not npm-installed; its dependencies still come from the host.

Dependencies come from the Pi host (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`), so these three are `peerDependencies` and the package ships no copies.

## Data layout

Code and data are separate: upgrading the extension never touches memory.

```
~/.pi/agent/memory/
|-- entries/                one file per fact (frontmatter + body)
|-- summary.md              engineering state, one section per project, each numbered [NN]
|-- summary-archive.md      old sections moved out by archiving
|-- todo.md                 open todos (- [ ]), separate from todo-archive.md
|-- todo-archive.md         completed todos, archived by month
|-- profile.md              aggregate profile (statistics block refreshed by the extension, prose written by hand)
|-- index.json              derived entries index (format version v; rebuilt when entries expire or are deleted, no data loss)
|-- summary-index.json      section index for summary.md
|-- todo-index.json         derived index for todo.md
|-- miss.log                zero-hit log (last 200 queries, used to fill memory gaps)
|-- extract-failures.jsonl  extraction failure ledger (last 50)
|-- expired/                entries moved out by purge (index file + body)
|-- recovery/               previous version before each write, rotated by day
|-- activity.log            write audit (remember / governance / todos / auto cleanup)
`-- archive/                old MEMORY.md / SCRATCHPAD.md / daily snapshots (read-only, qmd searchable)
```

Every derived index is checked by a `directory mtime + file count` or `mtime + size` stamp: external edits or deletions rebuild it automatically. It is never a source of truth.

## Tools

### `remember`

Write one fact. Admission kinds: `preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome`. Required: `kind subject text basis source`; `basis=inference` must carry `confidence`: **>= 0.85 is written directly as fact (`status=confirmed`)**, below the threshold it stays `pending` (the weak-inference tier); `kind=relation` and `action_impact=needs-confirm` always need manual confirmation, whatever the confidence. When an active entry already exists for the same `subject+kind`, the write is rejected and you are told to use `living_memory_update action=supersede` (so contradictory facts never coexist); the one exception is an old entry still marked `inference`: a repeat write does not create a new entry, it appends evidence to the old one (`repeat`, or a user restatement as `restate`), see "Inference promotion" below.

### `living_memory` (query)

| source | Content |
| --- | --- |
| `entries` (default) | memory entries, filterable by `kind` / `status` / `subject_contains` / `text_contains` / `query` |
| `todo` | open items from `todo.md` plus archived items from `todo-archive.md` (keyword) |
| `summary` | `summary.md`; without `query` it returns a **navigation** of sections grouped by project, with `query` it reads matching bodies |
| `summary-archive` | archived engineering sections |
| `all` | the first three together |
| `archive` | read-only qmd snapshot search (requires `query`, uses the qmd named by `LIVING_MEMORY_QMD`) |
| `lint` | conflict and duplicate self-check plus **structural problems**: active entries sharing a subject grouped by body bigram Jaccard similarity; then frontmatter structural errors (missing id, illegal kind/status/date/scope, the same id in several files), sorted by severity, at most 20 with a total count |
| `routing` | routing audit: entry-to-summary placement suggestions (engineering-state content belongs in summary) |
| `expired` | expired entries in the archive area (read-only, ids let `restore` bring them back) |
| `extract` | extractor health: failures in the last 7 days, count by reason, detail excerpts, last success |

### `living_memory_update` (governance)

`confirm` | `supersede` | `renew` | `expire` (without an id it selects a batch by `kind/scope/subject_contains`, `dry_run` by default) | `delete` | `restore` | `todo_done` | `todo_undo` | `todo_add` | `todo_edit` | `todo_delete` | `todo_archive` | `summary_add` | `summary_update` | `summary_archive` (moves the oldest sections to the archive, keeps 60 by default) | `purge_expired` (dry_run by default) | `rotate_recovery` | `profile_rebuild` | `promote_scan` (read-only: ranks inference entries by composite score, `match` works as a limit) | `auto_fact` (manually runs A+B promotion and returns the list per class)

### Slash commands

`/memory` opens the panel (review / pending / todo / profile / style / on / off), `/memory pending` confirms inferences one by one, `/memory style` runs one 30-day style summary.

## Validation and lint

Entries are `entries/<id>.md` frontmatter plus body. Validation has two paths, **deliberately asymmetric**:

- **Read path is lenient**: a bad entry never takes down the whole memory layer. Entries that fail to parse or carry illegal fields are still skipped (same as earlier behavior), but the problem is now recorded instead of silent.
- **Write path is strict**: `remember` and automatic extraction validate before writing. Any error rejects the write and returns the field and the reason; the extractor records the failure in `extract-failures.jsonl` (reason=`manifest-invalid`) and moves on to the next candidate.
- **Lifecycle operations are relaxed**: `expire` / `restore` / `resurrect` / `appendEvidence` / auto cleanup and promotion run with `strict:false` - they operate on historical snapshots and must not be blocked by old fields. The cost: an invalid old entry moved by `expire` still sits in `expired/` with bad fields, and lint keeps reporting it. That is intentional.

Valid values:

| Field | Rule |
| --- | --- |
| `id` | required, non-empty; the same id in several files is an error |
| `kind` | `preference` / `constraint` / `commitment` / `relation` / `correction` / `decision` / `outcome` |
| `status` | `explicit` / `event` / `inference` / `confirmed` / `superseded` / `expired` (the first four count as active) |
| `obtained_at` / `confirmed_at` / `expires_at` / `review_after` | parseable by `Date.parse`; **empty is legal** (an inference has no `confirmed_at`, `expires_at` / `review_after` are often empty) |
| `scope` | comma-separated, each item `global` / `workspace:<name>` / `project:<name>`; empty is a warning only |
| `action_impact` | `advice-only` / `reminder` / `needs-confirm` (may be empty) |
| `confidence` | finite number 0-1 (may be empty) |
| `supersedes` / `evidence` / `source` etc. | optional, not validated |

Why strict: an illegal date makes `ageDays` NaN, the purge rule "keep the last N days" stops working and the entry can be treated as purgeable; a misspelled `status` (say `explici`) keeps an entry **out of the brief and out of recall forever**, while the file still looks present.

Self-check: `living_memory source=lint`. Session-start hints also report structural problems (subject to `LIVING_MEMORY_START_HINTS`).

## Brief and session-start hints

Each turn's brief has a hard cap (`LIVING_MEMORY_BRIEF_MAX_CHARS`, 2400 characters by default), filled in the order due -> project facts -> pending -> global. The global tier puts **negative preferences (don't / never / avoid ...) first and tags them `[雷区]`**, one line at 130 characters, with the footer:

```
活动 N · 到期 N · 待确认 N · 简报 M/T（N 条未显示） · 待办 N 项
```

No matter how many entries the library holds, the context never blows up.

`session_start` only reports, never touches data: due entries that can be archived, completed todos that can be archived, extraction failures in the last 24h, summary sections above the limit. `LIVING_MEMORY_START_HINTS=0` turns it off.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `LIVING_MEMORY_BRIEF` | on | `0` disables brief injection entirely |
| `LIVING_MEMORY_BRIEF_MAX_CHARS` | 2400 | hard cap on brief length |
| `LIVING_MEMORY_TODO_DIGEST_CHARS` | 400 | character budget for each todo excerpt in the brief |
| `LIVING_MEMORY_EXTRACT` | on | `0` disables automatic extraction |
| `LIVING_MEMORY_EXTRACT_MODEL` | host default model | model used for extraction (`provider/model-id`) |
| `LIVING_MEMORY_EXTRACT_TIMEOUT_MS` | see source | extraction timeout |
| `LIVING_MEMORY_AUTO_TRIAGE` | on | `0` disables session-start auto cleanup (tier A) |
| `LIVING_MEMORY_NO_AUTO_REVIEW` | off | disables auto-marking entries pending at their review date |
| `LIVING_MEMORY_RECOVERY_DAYS` | 180 | days `recovery/` snapshots are kept |
| `LIVING_MEMORY_SUMMARY_KEEP` | 60 | active sections kept in summary.md |
| `LIVING_MEMORY_AUTO_ARCHIVE` | on | archives sections automatically once the limit is exceeded |
| `LIVING_MEMORY_AUTO_ARCHIVE_KEEP` | 120 | section count that triggers auto-archive |
| `LIVING_MEMORY_PROFILE_AUTO` | on | refreshes the profile statistics block at session start (idempotent) |
| `LIVING_MEMORY_PROFILE_BRIEF` | off | `1` (or `touch ~/.pi/agent/memory/profile-brief.on`) compresses sections "3. External wording" and "4. Communication and collaboration habits" of profile.md into one line injected into the brief |
| `LIVING_MEMORY_AUTO_FACT` | 0.85 | inference at or above this confidence is treated as fact (`status=confirmed`); below it is only a weak reference. **At session start stored inferences are re-judged retroactively with this threshold** |
| `LIVING_MEMORY_AUTO_FACT_EVIDENCE` | on | `0` disables evidence-driven auto-promotion (tier B) |
| `LIVING_MEMORY_AUTO_FACT_DAYS` | 3 | distinct days the evidence must cover (tier B precondition) |
| `LIVING_MEMORY_AUTO_FACT_SCORE` | 0.80 | composite score threshold for evidence promotion (defaults to `LIVING_MEMORY_PROMOTE_THRESHOLD`) |
| `LIVING_MEMORY_PROMOTE_THRESHOLD` | 0.80 | composite score threshold for inference promotion (used by `promote_scan`) |
| `LIVING_MEMORY_START_HINTS` | on | `0` disables session-start hints |
| `LIVING_MEMORY_QMD` | auto-detected | qmd executable used for archive snapshot search |
| `LIVING_MEMORY_QMD_TIMEOUT_MS` | 60000 | qmd call timeout |
| `LIVING_MEMORY_DEBUG` | off | `1` writes extraction and internal debug logs |
| `LIVING_MEMORY_ACTIVITY_MAX` | 500 | line limit for `activity.log` before rotation |
| `LIVING_MEMORY_RECALL` | on | `0` disables the recall section at the end of the brief |
| `LIVING_MEMORY_RECALL_MAX_ROWS` | 20000 | maximum index rows scored by BM25 (above that, subject tokens only) |
| `LIVING_MEMORY_RECALL_2L` | `ai,ci,pr,ui,db,ss` | comma-separated 2-letter ASCII whitelist kept in the index and in queries |
| `LIVING_MEMORY_MISS_LOG` | on | `0` disables zero-hit logging to `miss.log` |

## Recall by question

Each turn the brief runs BM25 over the index rows using **this turn's user message**, adds at most 3 related entries that did not make the tiers, and appends them at the end:

```
· 召回（按本轮提问）：[subject](first 8 chars of id) · ...
```

Index rows carry `toks` (v=3 format: Chinese bigrams + ASCII whole words, the latter only when length >= 3, plus the six 2-letter technical abbreviations `ai/ci/pr/ui/db/ss`, override with `LIVING_MEMORY_RECALL_2L`). Recall never reads bodies; after a hit the full text is fetched by id with `living_memory`.

Before scoring it filters high-frequency Chinese tokens (`df/N > 5%`; disabled below 20 entries) and requires at least 2 valid token hits; with only 1 hit, only ASCII proper nouns pass (`idf >= 3.5`, e.g. staging/tauri). ASCII whole words bypass the frequency gate, so technical identifiers such as npm/2fa stay discriminative however often they appear.

`LIVING_MEMORY_RECALL=0` disables it; `LIVING_MEMORY_RECALL_MAX_ROWS` caps the rows scored.

A zero-hit `source=entries` query is appended to `miss.log` (200 lines kept); `LIVING_MEMORY_MISS_LOG=0` disables that.

## Inference promotion (policy B)

### Two paths

| Path | Trigger | Result |
| --- | --- | --- |
| **Confidence direct** (on by default) | `basis=inference` and `confidence >= 0.85` (`LIVING_MEMORY_AUTO_FACT`), `kind != relation`, `action_impact != needs-confirm` | written as `status=confirmed`, the reply notes it was treated as fact; the `/memory` panel is unchanged and manual `supersede` / `expire` still applies |
| **Evidence accumulation** (on by default) | `evidence` covers >= 3 days and the composite score >= 0.80 (`LIVING_MEMORY_AUTO_FACT_DAYS` / `_SCORE`) | written as `status=confirmed`; `LIVING_MEMORY_AUTO_FACT_EVIDENCE=0` falls back to "mark promotable, needs `confirm`" |
| **Down-weighted** | below the threshold, or `relation` / `needs-confirm` | stays in the weak-inference tier, weak reference only, never used as fact for decisions |

In other words: **without human intervention, high-confidence inference directly influences later decisions; low-confidence inference only appears in the weak-reference tier of the brief.**

An inference entry (`status=inference`) carries `confidence` (0-1, self-rated by the extraction model) and `evidence` (JSON array, each `{at, kind, id, note}`, at most 20 items) in its frontmatter.

**Evidence accumulation** (automatic): when the same fact shows up again no new entry is created, evidence is appended - a duplicate `remember` records `repeat` (same day and same source deduplicated), a user restatement records `restate`, an extractor hit again records `repeat`.

**Composite score** (`living_memory_update action=promote_scan`, read-only):

```
score = confidence * 0.40                  # self-rating contributes at most 40%
      + min(evidence days, 3) / 3 * 0.50   # 3 independent repetitions earn the full 50%
      + 0.30 (a restate exists)            # user restatement
      - 0.25 (kind in relation/decision/outcome)
      - 0.20 (subject or body contains a hedge)
```

**Threshold (all three at once)**: `score >= 0.80`, independent evidence >= 2 (deduplicated by date + source), `kind != relation` and `action_impact != needs-confirm`. Passing the threshold only marks the entry promotable; **promotion still needs `confirm`**. Measured: self-rating 0.9 with no evidence = 0.36; 0.8 with 2 source repetitions and 1 restatement = 0.81.

## Profile and induction (three knobs)

`profile.md` is the only place for cross-entry induction: the statistics block is generated mechanically, the five prose sections are written by hand. Three things are opt-in:

1. **Profile in the brief** (off by default): `LIVING_MEMORY_PROFILE_BRIEF=1` or `touch ~/.pi/agent/memory/profile-brief.on` compresses sections "3. External wording" and "4. Communication and collaboration habits" into one line (<= 200 characters; placeholders, quote blocks, markdown decoration and evidence-id parentheses are stripped) appended to the end of the brief. It only works if those two sections hold **general style conclusions**, not project specifics.

**The real store has already been reshaped for injection** (2026-11-16): sections 3 and 4 of `profile.md` were rewritten into 9 short statements (193 characters); project details (company entity, dual address formats, PDF layout, English description template, correction history, content-site taste) moved to a new section 6, "external material details (not injected)"; `profile-brief.on` is in place, so from the next session the brief ends with a one-line profile note.

2. **Monthly induction**: `living_memory_update action=style_scan match=30` lists preferences, corrections and minefields in the window (with evidence ids) for you and the agent to distill into profile candidates; each run writes `profile-style.last`, and session-start hints fire once when it has not run for 30 days.
3. **Minefields first**: the brief's global tier sorts negative preferences (don't / never / avoid / forbid, in Chinese or English) and prefixes matching entries with that tag, so "don't do X" does not get pushed out by ordinary preferences as the library grows.

## Tests

```bash
bun tests/run.ts            # all (61 cases / 276 assertions, about 4s)
bun tests/run.ts --only brief
bun tests/run.ts --list
```

Every case gets a temporary `HOME` and its own subprocess (the extension resolves `$HOME/.pi/agent/memory` at load time, so without isolation tests would write to the real store). The default target is the packaged `extensions/living-memory.ts`; `LIVING_MEMORY_SRC=/path/to/x.ts` points at a development copy. Dependencies resolve through `tests/under-test/node_modules`, symlinked to the latest Pi installation.

## Upgrade and rollback

```bash
pi update --extensions           # re-resolve the spec written in settings
pi install git:github.com/robert-zz/pi-living-memory@v0.1.14   # roll back to an older tag
```

An upgrade swaps code only; `~/.pi/agent/memory` is left as is. `/reload` applies it.

## Data safety

- **Expired is not deleted**: invalid entries go to `expired/`, every write leaves a `recovery/` snapshot, and both are cleaned by rotation rather than direct deletion; a mistaken delete can be undone with `restore`.
- **Inference has gates**: `kind=relation` and `action_impact=needs-confirm` are never auto-promoted to fact, only a manual `confirm` can do that.
- **Derived indexes rebuild**: delete `index.json` and the other two indexes and no data is lost; they are never a source of truth.

## Further reading

- [Guide](https://github.com/robert-zz/pi-living-memory/blob/main/docs/guide.md): what to remember / how to query / how to clean up
- [Architecture and data flow](https://github.com/robert-zz/pi-living-memory/blob/main/docs/architecture.md): architecture diagram, sequence diagram, state machine
- [Development and design constraints](https://github.com/robert-zz/pi-living-memory/blob/main/docs/development.md): module layout, jiti pitfalls, six constraints to read before changing code
- [Publishing to npm](https://github.com/robert-zz/pi-living-memory/blob/main/docs/publishing.md): maintainer-facing, the full 2FA and staged publishing flow
- [Roadmap](https://github.com/robert-zz/pi-living-memory/blob/main/docs/roadmap.md)
- [Chinese README](https://github.com/robert-zz/pi-living-memory/blob/main/README.zh-CN.md)
