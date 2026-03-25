# Sprint Extension for pi

Harness-driven sprint planner & executor. Everything runs **visibly in your session** — the agent does the work, the extension drives the state machine.

## Install

```bash
pi install git:github.com/slopus/sprint
```

## How It Works

Unlike a traditional extension that spawns hidden subprocesses, this is a **thin harness** around the agent:

```
/sprint → agent scans project (visible) → agent proposes plan (visible)
       → agent critiques own plan (visible) → agent synthesizes (visible)
       → user accepts
       → agent executes task 1 (visible — you see every file edit, test run)
       → harness checks: sends review prompt
       → agent reviews own work (visible)
       → harness checks verdict: PASS → updates report → sends task 2
       → ...repeat until done
```

The extension only:
1. Sends prompts to drive the agent through phases (`sendUserMessage`)
2. Checks results after each phase (`agent_end` event)
3. Updates the sprint report markdown (source of truth)
4. Asks you at decision points (accept/retry/skip/pause/stop)

You see **everything** the agent does — every tool call, every file read, every edit.

## Commands

| Command | Description |
|---------|-------------|
| `/sprint [goal]` | Plan and execute a 2-week sprint |
| `/sprint-resume` | Resume a paused sprint |
| `/sprint-history` | Browse past sprints |

## Flow

### Planning (3 phases, all visible)
1. **Scan & Propose** — agent reads the codebase and proposes a sprint
2. **Critique** — agent re-reads code to verify its own claims
3. **Synthesize** — agent produces the final plan addressing its critique

### Execution (per task)
1. **Execute** — agent implements the task (fully visible)
2. **Review** — harness sends review prompt, agent checks its own work
3. **Verdict** — harness parses PASS/NEEDS_WORK
   - PASS → update report, next task
   - NEEDS_WORK → ask user: retry / mark done / skip / pause / stop

### Pause & Resume
- Pause mid-sprint, resume with `/sprint-resume`
- Progress tracked in `<project>/sprints/<date>-<slug>.md`

## Files

| File | Purpose |
|------|---------|
| `index.ts` | State machine harness — drives phases, checks results |
| `parser.ts` | Parse sprint plan into tasks, classify frontend/backend |
| `report.ts` | Markdown report generator |
| `store.ts` | Sprint persistence (JSON + MD source of truth) |
| `executor.ts` | Formatting helpers |
