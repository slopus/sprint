# Sprint Extension for pi

Debate-based sprint planner, executor, and reporter for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/slopus/sprint
```

Or try without installing:

```bash
pi -e git:github.com/slopus/sprint
```

## Prerequisites

You need two debate agent files in `~/.pi/agent/agents/`:

- `claude-debater.md` — proposer agent (uses Claude)
- `codex-debater.md` — critic agent (uses Codex/GPT)

These are agent definition files with frontmatter (`name`, `model`, optionally `tools`) and a system prompt body.

## Commands

| Command | Description |
|---------|-------------|
| `/sprint [goal]` | Plan and execute a 2-week sprint |
| `/sprint-resume` | Resume a paused sprint from where it left off |
| `/sprint-history` | Browse past sprint plans and results |
| `/plan-sprints [vision]` | Generate a 30-sprint roadmap (~60 weeks) |

## What it does

### Planning (debate)
1. **Scan** — Gathers git history, TODOs, plan files, directory structure, README
2. **Propose** → proposer agent analyzes the project and proposes a sprint
3. **Critique** → critic agent independently verifies feasibility against the codebase
4. **Synthesize** → proposer incorporates feedback into a final plan with 10-20 tasks
5. **Accept** → You review, accept, refine, reject, or save for later

### Execution (per task)
1. **Classify** — frontend (🎨 Claude Opus 4.6) or backend (⚙️ GPT 5.4)
2. **Execute** — pi subagent runs with full tools (read, write, edit, bash, etc.)
3. **Review debate** — the model that *didn't* execute reviews → cross-review → verdict
4. **Summary** — LLM generates structured record of files changed, decisions, rationale
5. **User decision** (if NEEDS_WORK) — retry / auto-retry / mark done / skip / pause / stop

### Pause & Resume
- **Pause** mid-sprint and resume later with `/sprint-resume`
- Progress tracked in the markdown report — the MD file is the source of truth
- On resume, completed tasks are skipped, interrupted tasks restart

### Output
- **Sprint report:** `<project>/sprints/<date>-<name>.md` — written incrementally after each task
- **Roadmap files:** `<project>/sprints/planned/` — individual sprint files + dependency index

## Sprint Report Contents

Each report includes:
- Full planning debate transcript (proposal, critique, synthesis)
- Per-task execution details with metadata table (status, model, timing, verdict)
- Event log tracking every state change
- Full execution output (collapsible)
- Review debate (proposer + critic assessments)
- LLM-generated summary (files changed, rationale, key decisions)
- Summary table with status, type, duration, verdict

## Roadmap (`/plan-sprints`)

Generates 30 sprints across 3 tiers:
- **Tier 1 (Foundation):** 10 independent, parallelizable sprints
- **Tier 2 (Building):** 10 sprints depending on Tier 1
- **Tier 3 (Capstone):** 10 sprints depending on earlier tiers

Each sprint file has YAML frontmatter with id, title, tier, dependencies, and status.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, commands, plan→execute→report orchestration |
| `scanner.ts` | Project context scanner (git, TODOs, plans, structure) |
| `parser.ts` | Parse sprint plan into tasks, classify frontend/backend |
| `executor.ts` | Subagent runner, model profiles, prompt builders |
| `store.ts` | Sprint persistence (JSON + MD file as source of truth) |
| `report.ts` | Markdown report generator with incremental writes |
| `roadmap.ts` | 30-sprint roadmap generator with dependency tree |

## License

MIT
