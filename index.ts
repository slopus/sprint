/**
 * Sprint Extension — Harness-driven sprint planner & executor
 *
 * The agent does ALL the work visibly in the same window.
 * The extension is a thin state machine that:
 *   1. Drives the agent through phases via sendUserMessage()
 *   2. Checks results after each phase via agent_end
 *   3. Updates the sprint report (markdown source of truth)
 *   4. Asks the user what to do at decision points
 *
 * Commands:
 *   /sprint [goal]     — Plan and execute a sprint
 *   /sprint-resume     — Resume a paused sprint
 *   /sprint-history    — Browse past sprints
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { parseTasks, formatTaskWidget, type SprintTask } from "./parser.js";
import { writeSprintReport, syncRecordFromMarkdown } from "./report.js";
import { type SprintRecord, loadSprints, saveSprints, saveSprint, sprintStoragePath, findResumableSprint } from "./store.js";

// ---------------------------------------------------------------------------
// Sprint state machine
// ---------------------------------------------------------------------------

type Phase =
	| { type: "idle" }
	| { type: "scanning" }
	| { type: "proposing" }
	| { type: "critiquing"; proposal: string }
	| { type: "synthesizing"; proposal: string; critique: string }
	| { type: "executing"; taskIndex: number }
	| { type: "reviewing"; taskIndex: number }
	| { type: "complete" };

interface SprintState {
	phase: Phase;
	record: SprintRecord | null;
	cwd: string;
	startTime: number;
}

let state: SprintState = { phase: { type: "idle" }, record: null, cwd: "", startTime: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getAssistantText(messages: AgentMessage[]): string {
	return [...messages]
		.reverse()
		.filter(isAssistantMessage)
		.flatMap((m) => m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text))
		.join("\n");
}

function elapsed(): string {
	const sec = Math.round((Date.now() - state.startTime) / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m${sec % 60}s`;
	return `${Math.floor(min / 60)}h${min % 60}m`;
}

function taskStatus(tasks: SprintTask[]): string {
	const done = tasks.filter((t) => t.status === "done").length;
	return `[${done}/${tasks.length}]`;
}

function findNextPendingTask(record: SprintRecord): number {
	return record.tasks.findIndex((t) => t.status !== "done" && t.status !== "failed");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sprintExtension(pi: ExtensionAPI): void {

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("sprint", {
		description: "Plan and execute a 2-week sprint. Usage: /sprint [goal]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const storagePath = sprintStoragePath(cwd);

			// Check for existing paused sprint
			const existing = findResumableSprint(storagePath);
			if (existing) {
				const action = await ctx.ui.select(`There's a ${existing.status} sprint: "${existing.title}". What to do?`, [
					"▶️  Resume it",
					"🆕 Start new (marks current as completed)",
					"❌ Cancel",
				]);
				if (action?.startsWith("▶️")) {
					await startResume(pi, ctx);
					return;
				} else if (action?.startsWith("🆕")) {
					existing.status = "completed";
					saveSprint(storagePath, existing);
					if (existing.reportPath) writeSprintReport(cwd, existing);
				} else {
					return;
				}
			}

			const goal = args?.trim() || null;
			state = { phase: { type: "scanning" }, record: null, cwd, startTime: Date.now() };
			ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", "🔍 Scanning project..."));

			// Kick off the first phase — agent scans and proposes
			const goalLine = goal ? `\nThe user specified this goal: ${goal}` : "";
			pi.sendUserMessage(
				`You are planning a 2-week sprint for a team of 4-6 staff engineers. This is a major feature milestone — entire subsystems, not small tasks.${goalLine}

**Step 1: Scan the project.** Run these commands to gather context:
- \`git log --oneline --since="2 weeks ago" -n 30\`
- \`git diff --stat HEAD~10..HEAD\`
- Read README.md, package.json
- \`grep -rn "TODO\\|FIXME" --include="*.ts" --include="*.tsx" . | head -30\`
- \`ls docs/plans/ 2>/dev/null\` and read any plan files
- Explore the directory structure

**Step 2: Propose a sprint plan** using this EXACT format:

### Sprint: [Title]

## Goal
[paragraph]

## Tasks

**Task 1:** [Title] ([N] days)
[detailed description with file references]
**Files:** [list]

---

**Task 2:** [Title] ([N] days)
[description]
**Files:** [list]

(10-20 tasks, each 1-3 engineer-days. The word "Task" + number is REQUIRED in each heading.)

## Acceptance Criteria
- [ ] [criterion]

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |

## Out of Scope
- [item]`,
				{ deliverAs: "followUp" },
			);
			state.phase = { type: "proposing" };
		},
	});

	pi.registerCommand("sprint-resume", {
		description: "Resume a paused sprint",
		handler: async (_args, ctx) => { await startResume(pi, ctx); },
	});

	pi.registerCommand("sprint-history", {
		description: "Show past sprint results",
		handler: async (_args, ctx) => {
			const sprints = loadSprints(sprintStoragePath(ctx.cwd));
			if (sprints.length === 0) { ctx.ui.notify("No sprint history. Run /sprint.", "info"); return; }
			const choices = sprints.map((s) => {
				const date = new Date(s.createdAt).toLocaleDateString();
				const icon = s.status === "completed" ? "✓" : s.status === "paused" ? "⏸" : s.status === "failed" ? "✗" : "○";
				const done = s.tasks.filter((t) => t.status === "done").length;
				return `${icon} ${date} [${done}/${s.tasks.length}] — ${s.title || "(untitled)"}`;
			});
			const choice = await ctx.ui.select("Sprint History", choices);
			if (choice === undefined) return;
			const sprint = sprints[choices.indexOf(choice)];
			pi.sendMessage({
				customType: "sprint-history",
				content: `## ${sprint.title}\n**Status:** ${sprint.status} | **Tasks:** ${sprint.tasks.filter((t) => t.status === "done").length}/${sprint.tasks.length}\n${sprint.reportPath ? `**Report:** ${sprint.reportPath}` : ""}`,
				display: true,
			}, { triggerTurn: false });
		},
	});

	// -----------------------------------------------------------------------
	// Session start — show status for active sprints
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const sprints = loadSprints(sprintStoragePath(ctx.cwd));
		const active = sprints.find((s) => s.status === "paused" || s.status === "executing");
		if (active) {
			const done = active.tasks.filter((t) => t.status === "done").length;
			const isPaused = active.status === "paused";
			const label = `${isPaused ? "⏸" : "🏃"} ${active.title} [${done}/${active.tasks.length}]${isPaused ? " (/sprint-resume)" : ""}`;
			ctx.ui.setStatus("sprint", ctx.ui.theme.fg(isPaused ? "warning" : "accent", label));
		}
	});

	// -----------------------------------------------------------------------
	// Inject sprint context before each agent turn
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async () => {
		if (state.phase.type === "idle" || state.phase.type === "complete") return;
		if (!state.record) return;

		const record = state.record;
		const phase = state.phase;

		// During execution/review, inject current sprint context
		if (phase.type === "executing" || phase.type === "reviewing") {
			const task = record.tasks[phase.taskIndex];
			if (!task) return;
			const done = record.tasks.filter((t) => t.status === "done").length;
			return {
				message: {
					customType: "sprint-context",
					content: `[SPRINT: ${record.title} — ${done}/${record.tasks.length} done — ⏱${elapsed()}]`,
					display: false,
				},
			};
		}
	});

	// -----------------------------------------------------------------------
	// The harness: check results after each agent turn, drive next phase
	// -----------------------------------------------------------------------

	pi.on("agent_end", async (event, ctx) => {
		const phase = state.phase;
		if (phase.type === "idle" || phase.type === "complete") return;

		const text = getAssistantText(event.messages);

		// ----- PROPOSING → CRITIQUING -----
		if (phase.type === "proposing") {
			state.phase = { type: "critiquing", proposal: text };
			ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `🔎 Critiquing... ⏱${elapsed()}`));
			pi.sendUserMessage(
				`Now critique the sprint plan you just proposed. Read the actual codebase to verify your claims:

1. **Verify references** — read the files you mentioned. Are they described accurately?
2. **Find what's missing** — scan for related code, integration points, dependencies you overlooked
3. **Check scale** — is each task actually 1-3 engineer-days based on the code complexity?
4. **Assess feasibility** — can this be built as described?

Default stance: approve. Only flag issues backed by evidence from the actual code.`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// ----- CRITIQUING → SYNTHESIZING -----
		if (phase.type === "critiquing") {
			state.phase = { type: "synthesizing", proposal: phase.proposal, critique: text };
			ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `⚡ Synthesizing... ⏱${elapsed()}`));
			pi.sendUserMessage(
				`Now produce the FINAL sprint plan incorporating your critique. Fix any issues you found.

Use this EXACT format (the word "Task" + number is REQUIRED for each task heading):

### Sprint: [Title]

## Goal
[paragraph]

## Tasks

**Task 1:** [Title] ([N] days)
[description]
**Files:** [list]

---

**Task 2:** [Title] ([N] days)
[description]
**Files:** [list]

(continue for all tasks)

## Acceptance Criteria
- [ ] [criterion]

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |

## Out of Scope
- [item]`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// ----- SYNTHESIZING → PARSE + USER DECISION -----
		if (phase.type === "synthesizing") {
			const tasks = parseTasks(text);

			if (tasks.length === 0) {
				ctx.ui.notify("Could not parse tasks — asking for reformat...", "warning");
				pi.sendUserMessage(
					`Your plan could not be parsed because the task headings don't use the required format.
Reformat ALL tasks to use exactly: **Task N:** Title (N days)
Do NOT use "1. Title" or "**1. Title**". The word "Task" followed by a number is required.
Keep all content identical, only change task heading format.`,
					{ deliverAs: "followUp" },
				);
				return; // Will re-enter this branch on next agent_end
			}

			// Parse title
			const titleMatch = text.match(/###?\s*Sprint:\s*(.+)/i);
			const title = titleMatch ? titleMatch[1].replace(/\*+/g, "").trim() : "Untitled Sprint";

			// Show tasks and ask user
			const taskList = tasks.map((t) => `  ${t.index}. ${t.isFrontend ? "🎨" : "⚙️"} ${t.title}`).join("\n");
			pi.sendMessage({
				customType: "sprint-tasks",
				content: `**Parsed ${tasks.length} tasks:**\n${taskList}`,
				display: true,
			}, { triggerTurn: false });

			const choice = await ctx.ui.select("Sprint Plan — What next?", [
				`✅ Accept & Execute (${tasks.length} tasks)`,
				"✏️  Refine with feedback",
				"❌ Reject",
			]);

			const storagePath = sprintStoragePath(state.cwd);
			const record: SprintRecord = {
				id: crypto.randomUUID(),
				createdAt: Date.now(),
				title,
				status: "pending",
				proposal: phase.proposal,
				critique: phase.critique,
				synthesis: text,
				snapshotSummary: `scanned at ${new Date().toLocaleString()}`,
				tasks,
				currentTaskIndex: 0,
			};

			if (choice?.startsWith("✅")) {
				record.status = "executing";
				// Mark prior sprints as completed
				const allSprints = loadSprints(storagePath);
				for (const s of allSprints) {
					if (s.status === "executing" || s.status === "paused") s.status = "completed";
				}
				saveSprints(storagePath, allSprints);
				saveSprint(storagePath, record);
				const reportPath = writeSprintReport(state.cwd, record);
				record.reportPath = reportPath;
				saveSprint(storagePath, record);
				state.record = record;
				ctx.ui.notify(`Sprint report: ${reportPath}`, "info");
				ctx.ui.setWidget("sprint-progress", formatTaskWidget(tasks, ctx.ui.theme));

				// Start first task
				executeNextTask(pi, ctx);
			} else if (choice?.startsWith("✏️")) {
				const feedback = await ctx.ui.editor("What should change?", "");
				if (feedback?.trim()) {
					saveSprint(storagePath, record);
					pi.sendUserMessage(`Revise the sprint plan based on this feedback:\n\n${feedback.trim()}`);
					// Stay in synthesizing — will re-parse on next agent_end
				}
			} else {
				record.status = "rejected";
				saveSprint(storagePath, record);
				state.phase = { type: "idle" };
				ctx.ui.setStatus("sprint", undefined);
				ctx.ui.notify("Sprint rejected.", "info");
			}
			return;
		}

		// ----- EXECUTING → REVIEWING -----
		if (phase.type === "executing") {
			const task = state.record!.tasks[phase.taskIndex];
			task.completedAt = Date.now();
			state.phase = { type: "reviewing", taskIndex: phase.taskIndex };

			ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `🔎 Reviewing Task ${task.index}... ⏱${elapsed()}`));
			pi.sendUserMessage(
				`Now review the work you just did for Task ${task.index}: "${task.title}".

Read the files you created/modified. Check:
1. Does the implementation match the task description?
2. Does it compile/run without obvious issues?
3. Were tests written?

**Default stance: PASS.** This is a sprint — forward progress > perfection.
NEEDS_WORK only for blocking issues (core functionality missing, runtime crash, no tests when required).

End your review with exactly one of:
**VERDICT: PASS**
or
**VERDICT: NEEDS_WORK** — [reason]`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// ----- REVIEWING → NEXT TASK or NEEDS_WORK -----
		if (phase.type === "reviewing") {
			const record = state.record!;
			const task = record.tasks[phase.taskIndex];
			const storagePath = sprintStoragePath(state.cwd);

			const upper = text.toUpperCase();
			const pass = !upper.includes("NEEDS_WORK");

			task.reviewVerdict = pass ? "pass" : "needs_work";
			task.executionDurationMs = (task.completedAt || Date.now()) - (task.startedAt || Date.now());

			if (pass) {
				// --- PASS ---
				task.status = "done";
				saveSprint(storagePath, record);
				writeSprintReport(state.cwd, record);
				ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));

				pi.sendMessage({
					customType: "sprint-task-pass",
					content: `**✅ Task ${task.index} PASSED** — ${task.title}`,
					display: true,
				}, { triggerTurn: false });

				// Check if done
				const nextIdx = findNextPendingTask(record);
				if (nextIdx < 0) {
					finishSprint(pi, ctx);
				} else {
					executeNextTask(pi, ctx);
				}
			} else {
				// --- NEEDS_WORK ---
				pi.sendMessage({
					customType: "sprint-task-needswork",
					content: `**⚠️ Task ${task.index} NEEDS WORK**`,
					display: true,
				}, { triggerTurn: false });

				const action = await ctx.ui.select(`Task ${task.index} needs work. What to do?`, [
					"🔄 Retry — fix the issues",
					"✅ Mark done anyway",
					"⏭️  Skip",
					"⏸  Pause sprint",
					"🛑 Stop",
				]);

				if (action?.startsWith("🔄")) {
					task.status = "running";
					state.phase = { type: "executing", taskIndex: phase.taskIndex };
					ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `🔄 Retrying Task ${task.index}... ⏱${elapsed()}`));
					pi.sendUserMessage(
						`Fix the issues identified in your review for Task ${task.index}: "${task.title}".
Don't start from scratch — fix only the specific problems. Then confirm what you changed.`,
						{ deliverAs: "followUp" },
					);
				} else if (action?.startsWith("✅")) {
					task.status = "done";
					task.reviewVerdict = "pass (manual override)";
					saveSprint(storagePath, record);
					writeSprintReport(state.cwd, record);
					ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));
					const nextIdx = findNextPendingTask(record);
					if (nextIdx < 0) finishSprint(pi, ctx);
					else executeNextTask(pi, ctx);
				} else if (action?.startsWith("⏭️")) {
					task.status = "failed";
					task.reviewVerdict = "skipped";
					saveSprint(storagePath, record);
					writeSprintReport(state.cwd, record);
					ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));
					const nextIdx = findNextPendingTask(record);
					if (nextIdx < 0) finishSprint(pi, ctx);
					else executeNextTask(pi, ctx);
				} else if (action?.startsWith("⏸")) {
					pauseSprint(pi, ctx, task);
				} else {
					stopSprint(pi, ctx, task);
				}
			}
			return;
		}
	});
}

// ---------------------------------------------------------------------------
// Phase drivers
// ---------------------------------------------------------------------------

function executeNextTask(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const record = state.record!;
	const idx = findNextPendingTask(record);
	if (idx < 0) { finishSprint(pi, ctx); return; }

	const task = record.tasks[idx];
	task.status = "running";
	task.startedAt = Date.now();
	record.currentTaskIndex = idx;
	state.phase = { type: "executing", taskIndex: idx };

	const storagePath = sprintStoragePath(state.cwd);
	saveSprint(storagePath, record);
	writeSprintReport(state.cwd, record);
	ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `▶ Task ${task.index}/${record.tasks.length}: ${task.title} ⏱${elapsed()}`));

	pi.sendUserMessage(
		`Execute Task ${task.index}/${record.tasks.length}: **${task.title}**

${task.body}

Instructions:
1. Read broadly — understand full context before changes
2. Implement completely — production-quality, not stubs
3. Write tests for new logic (success + error paths)
4. Run the test suite
5. Fix any failures before finishing`,
		{ deliverAs: "followUp" },
	);
}

function finishSprint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const record = state.record!;
	record.status = "completed";
	const storagePath = sprintStoragePath(state.cwd);
	saveSprint(storagePath, record);
	writeSprintReport(state.cwd, record);

	const done = record.tasks.filter((t) => t.status === "done").length;
	const failed = record.tasks.filter((t) => t.status === "failed").length;
	state.phase = { type: "complete" };
	ctx.ui.setWidget("sprint-progress", undefined);
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("success", `✓ ${record.title} — complete (⏱${elapsed()})`));

	pi.sendMessage({
		customType: "sprint-complete",
		content: `**🎉 Sprint Complete: ${record.title}**\n\n**Results:** ${done} done, ${failed} failed out of ${record.tasks.length}\n**Time:** ${elapsed()}\n\n${record.tasks.map((t) => `${t.status === "done" ? "✅" : "❌"} Task ${t.index}: ${t.title}`).join("\n")}\n\n**Report:** ${record.reportPath}`,
		display: true,
	}, { triggerTurn: false });
}

function pauseSprint(pi: ExtensionAPI, ctx: ExtensionContext, task: SprintTask): void {
	const record = state.record!;
	task.status = "pending";
	record.status = "paused";
	const storagePath = sprintStoragePath(state.cwd);
	saveSprint(storagePath, record);
	writeSprintReport(state.cwd, record);

	const done = record.tasks.filter((t) => t.status === "done").length;
	state.phase = { type: "idle" };
	ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `⏸ ${record.title} ${taskStatus(record.tasks)} — /sprint-resume`));

	pi.sendMessage({
		customType: "sprint-paused",
		content: `**⏸ Sprint paused** at Task ${task.index}\n\n**Progress:** ${done}/${record.tasks.length}\n**Resume:** \`/sprint-resume\`\n**Report:** ${record.reportPath}`,
		display: true,
	}, { triggerTurn: false });
}

function stopSprint(pi: ExtensionAPI, ctx: ExtensionContext, task: SprintTask): void {
	const record = state.record!;
	task.status = "failed";
	task.completedAt = Date.now();
	record.status = "failed";
	const storagePath = sprintStoragePath(state.cwd);
	saveSprint(storagePath, record);
	writeSprintReport(state.cwd, record);

	state.phase = { type: "idle" };
	ctx.ui.setWidget("sprint-progress", undefined);
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("error", `⏹ ${record.title} — stopped`));

	pi.sendMessage({
		customType: "sprint-stopped",
		content: `**Sprint stopped** at Task ${task.index}\n**Report:** ${record.reportPath}`,
		display: true,
	}, { triggerTurn: false });
}

async function startResume(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const storagePath = sprintStoragePath(cwd);
	const record = findResumableSprint(storagePath);

	if (!record) {
		ctx.ui.notify("No paused sprint. Run /sprint to start one.", "info");
		return;
	}

	syncRecordFromMarkdown(record);
	const done = record.tasks.filter((t) => t.status === "done").length;
	const remaining = record.tasks.filter((t) => t.status === "pending" || t.status === "running").length;

	if (remaining === 0) {
		record.status = "completed";
		saveSprint(storagePath, record);
		writeSprintReport(cwd, record);
		ctx.ui.notify("All tasks already done.", "info");
		return;
	}

	// Reset interrupted tasks
	for (const task of record.tasks) {
		if (task.status === "running") task.status = "pending";
	}

	record.status = "executing";
	saveSprint(storagePath, record);
	state = { phase: { type: "idle" }, record, cwd, startTime: Date.now() };

	pi.sendMessage({
		customType: "sprint-resume",
		content: `**Resuming: ${record.title}** — ${done}/${record.tasks.length} done, ${remaining} remaining`,
		display: true,
	}, { triggerTurn: false });

	ctx.ui.setWidget("sprint-progress", formatTaskWidget(record.tasks, ctx.ui.theme));
	executeNextTask(pi, ctx as unknown as ExtensionContext);
}
