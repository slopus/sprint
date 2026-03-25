# Sprint Extension for pi

Debate-based sprint planner & executor. Planning runs via **dedicated subagent processes** (proposer + critic). Task execution runs in **isolated subprocess per task** with fresh context, model routing, and post-task review debate.

## Install

```bash
pi install git:github.com/slopus/sprint
```

## Prerequisites

Create two debate agent config files in `~/.pi/agent/agents/`:

- `claude-debater.md` — proposer agent (e.g., Claude Opus)
- `codex-debater.md` — critic agent (e.g., GPT-5.4)

Each file uses frontmatter for model config and body for system prompt.

## How It Works

```
/sprint → scan project → proposer proposes plan → critic reviews
       → proposer synthesizes → proposer asks open questions
       → user answers (or skips) → revised plan → re-critique → re-synthesize
       → ...repeat until no questions remain
       → auto-validate format (retry reformat up to 3x if parsing fails)
       → user accepts → subprocess: task 1 (isolated context, model routing)
       → primary + secondary reviewer debate → LLM summary
       → verdict: PASS → report → subprocess: task 2 → ...done
```

### Live Stats Widget

During all phases, a **real-time widget** shows:
- ⏱ Elapsed time (ticking every second)
- 📊 Total tokens used across all subagent calls
- 💰 Accumulated cost
- Task progress (done/total)
- Current activity (tool calls in subagents)

### Planning (iterative debate with user Q&A)
1. **Scan** — gathers git history, TODOs, plans, directory structure
2. **Propose** — proposer agent creates a sprint plan
3. **Critique** — critic agent reads the codebase to verify claims
4. **Synthesize** — proposer addresses critique and produces final plan
5. **Questions** — proposer identifies open questions for the user
6. **Answers** — if questions exist, user answers them
7. **Repeat** — plan is revised with user answers, re-critiqued, re-synthesized (up to 5 rounds)
8. **Validate** — parser checks format; auto-reformat up to 3x if needed

### Execution (isolated subprocess per task)
Each task runs in a **separate `pi` process** (`--mode json -p --no-session`):
- **Fresh context** — no bleed from previous tasks
- **Model routing** — frontend (Opus) vs backend (Codex) profiles
- **Post-task review debate** — primary + secondary reviewer agents
- **LLM summary** — structured record of changes for the report
- **Abort support** — `/sprint-abort` kills the subprocess

### Format Validation
If the synthesized plan doesn't use the `**Task N:** Title (N days)` heading format:
1. Auto-sends a reformat prompt to the proposer (up to 3 retries)
2. If all retries fail, offers manual edit or abort
3. This ensures the parser can always extract structured tasks

### Pause & Resume
- Pause mid-sprint, resume with `/sprint-resume`
- Progress tracked in `<project>/sprints/<date>-<slug>.md`
- Token usage and cost persisted per-task for accurate totals on resume

## Commands

| Command | Description |
|---------|-------------|
| `/sprint [goal]` | Plan and execute a sprint |
| `/sprint-resume` | Resume a paused sprint |
| `/sprint-abort` | Abort the currently executing task |
| `/sprint-history` | Browse past sprints |
| `/plan-sprints [vision]` | Generate a 30-sprint roadmap |

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry — commands, planning debate, execution loop, live widget |
| `executor.ts` | Subagent runner — spawns `pi` subprocess, tracks tokens/cost |
| `parser.ts` | Parse sprint plan → tasks, classify frontend/backend |
| `report.ts` | Markdown report generator with token/cost columns |
| `store.ts` | Sprint persistence (JSON + MD source of truth) |
| `scanner.ts` | Project scanner — git, TODOs, plans, structure |
| `roadmap.ts` | 30-sprint roadmap generator via debate |
