/**
 * Sprint Extension — Debate-based weekly mission planner + executor
 *
 * Commands:
 *   /sprint          — Plan a sprint (debate), then execute it task-by-task
 *   /sprint-resume   — Resume a paused sprint from where it left off
 *   /sprint-history  — Browse past sprint plans
 *   /plan-sprints    — Generate a 30-sprint roadmap
 *
 * Planning flow (iterative):
 *   1. Scan project → build context snapshot
 *   2. Proposer agent proposes a sprint mission
 *   3. Critic agent reviews the proposal
 *   4. Proposer synthesizes into final plan
 *   5. Proposer identifies open questions for the user
 *   6. If questions → user answers → repeat from step 2 with answers as context
 *   7. If no questions → parse tasks (auto-reformat up to 3 times if needed)
 *   8. User accepts → execution begins
 *
 * Execution flow (per task):
 *   1. Classify task → frontend or backend → pick model profile
 *   2. Execute task via pi subagent with full tools
 *   3. Post-task debate: primary + secondary reviewer → verdict
 *   4. LLM summary pass: structured record of changes
 *   5. If PASS → next task. If NEEDS_WORK → user chooses retry/skip/stop
 *   6. Report written incrementally
 *   7. Live widget shows real-time clock, tokens used, cost
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import { scanProject, formatSnapshot } from "./scanner.js";
import { type SprintRecord, loadSprints, saveSprints, saveSprint, sprintStoragePath, findResumableSprint } from "./store.js";
import { parseTasks, formatTaskWidget, type SprintTask, type TokenUsage } from "./parser.js";
import {
	profileForTask,
	runPiSubagent,
	writeTempPrompt,
	cleanupTemp,
	buildExecutionPrompt,
	buildRetryPrompt,
	buildReviewProposalPrompt,
	buildReviewCritiquePrompt,
	buildTaskSummaryPrompt,
	extractVerdict,
	addUsage,
	formatTokens,
	formatCost,
	formatDurationShort,
	DEBATE_TOOLS,
	BOIL_THE_LAKE_PRINCIPLE,
	type SubagentResult,
} from "./executor.js";
import { writeSprintReport, syncRecordFromMarkdown } from "./report.js";
import {
	buildRoadmapProposalPrompt,
	buildRoadmapCritiquePrompt,
	buildRoadmapSynthesisPrompt,
	parseRoadmapSprints,
	writeRoadmap,
} from "./roadmap.js";

const PROPOSER_AGENT = "claude-debater";
const CRITIC_AGENT = "codex-debater";
const MAX_REFORMAT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Live stats tracker — real-time clock + token counter widget
// ---------------------------------------------------------------------------

interface LiveTracker {
	startTime: number;
	usage: TokenUsage;
	phase: string;
	activity: string;
	interval: ReturnType<typeof setInterval> | null;
}

function createLiveTracker(ctx: ExtensionCommandContext): LiveTracker {
	const tracker: LiveTracker = {
		startTime: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		phase: "",
		activity: "",
		interval: null,
	};
	return tracker;
}

function startLiveUpdates(tracker: LiveTracker, ctx: ExtensionCommandContext): void {
	if (tracker.interval) return;
	const update = () => renderTrackerStatus(tracker, ctx);
	update();
	tracker.interval = setInterval(update, 1000);
}

function stopLiveUpdates(tracker: LiveTracker): void {
	if (tracker.interval) {
		clearInterval(tracker.interval);
		tracker.interval = null;
	}
}

function renderTrackerStatus(tracker: LiveTracker, ctx: ExtensionCommandContext): void {
	const elapsed = formatDurationShort(Date.now() - tracker.startTime);
	const totalTokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead;
	const tokenStr = totalTokens > 0 ? ` ${formatTokens(totalTokens)}tok` : "";
	const costStr = tracker.usage.cost > 0 ? ` ${formatCost(tracker.usage.cost)}` : "";
	const activityStr = tracker.activity ? ` — ${tracker.activity.slice(0, 50)}` : "";
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `${tracker.phase} ⏱${elapsed}${tokenStr}${costStr}${activityStr}`));
}

function renderTrackerWidget(tracker: LiveTracker, tasks: SprintTask[], ctx: ExtensionCommandContext): void {
	const elapsed = formatDurationShort(Date.now() - tracker.startTime);
	const totalTokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead;
	const done = tasks.filter((t) => t.status === "done").length;
	const failed = tasks.filter((t) => t.status === "failed").length;

	const statsLine = [
		`⏱ ${elapsed}`,
		totalTokens > 0 ? `📊 ${formatTokens(totalTokens)} tokens` : null,
		tracker.usage.cost > 0 ? `💰 ${formatCost(tracker.usage.cost)}` : null,
		`✓ ${done}/${tasks.length}`,
		failed > 0 ? `✗ ${failed}` : null,
	].filter(Boolean).join("  ");

	const taskLines = formatTaskWidget(tasks, ctx.ui.theme);
	ctx.ui.setWidget("sprint-progress", [
		ctx.ui.theme.fg("accent", statsLine),
		...taskLines,
	]);
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

interface AgentConfig {
	name: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
}

function loadAgent(name: string): AgentConfig | null {
	const agentDir = path.join(getAgentDir(), "agents");
	const filePath = path.join(agentDir, `${name}.md`);
	if (!fs.existsSync(filePath)) return null;
	let content: string;
	try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const tools = frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean);
	return {
		name: frontmatter.name || name,
		model: frontmatter.model,
		tools: tools && tools.length > 0 ? tools : undefined,
		systemPrompt: body,
	};
}

async function runDebateAgent(agent: AgentConfig, prompt: string, cwd: string, tracker?: LiveTracker): Promise<SubagentResult> {
	let tmp: { dir: string; path: string } | null = null;
	if (agent.systemPrompt.trim()) {
		tmp = await writeTempPrompt(agent.name, agent.systemPrompt);
	}
	const result = await runPiSubagent({
		prompt,
		cwd,
		model: agent.model,
		tools: agent.tools ?? DEBATE_TOOLS,
		systemPromptFile: tmp?.path,
		onActivity: tracker ? (activity) => { tracker.activity = activity; } : undefined,
	});
	if (tmp) cleanupTemp(tmp.dir, tmp.path);
	if (tracker) {
		addUsage(tracker.usage, result.usage);
		tracker.activity = "";
	}
	return result;
}

// ---------------------------------------------------------------------------
// Planning debate prompts
// ---------------------------------------------------------------------------

function buildProposalPrompt(snapshot: string, userGoal: string | null): string {
	const goalDirective = userGoal
		? `The user has specified this goal for the sprint:\n\n> ${userGoal}\n\nDesign the sprint around this goal. Break it into concrete tasks grounded in the codebase.`
		: `Propose ONE focused sprint — the single most impactful major initiative to ship next.`;

	return `You are planning a sprint for a team of 4-6 high-performing staff engineers.

A sprint is a **2-week cycle** delivering a **major feature milestone** — not a small polish task, not a single file change. Think in terms of entire subsystems, end-to-end features, or architectural transformations that move the product forward significantly.

## Project State

${snapshot}

## Your Task

${goalDirective}

Fill out the following template. Replace all bracketed placeholders with real content. Every section is required. Do NOT deviate from this structure.

IMPORTANT: Each task MUST use the heading format \`**Task N:** Title (N days)\`. The word "Task" followed by a number is required for automated parsing. Do NOT use plain numbered lists like "1. Title" — they will not be detected and the sprint will have 0 tasks.

Scale guidance: a single task should take a staff engineer 1-3 days, not hours. A task like "add a route" is too small — instead, "Design and implement the complete git status API layer with detection, caching, throttled fetch, and integration tests" is the right granularity.

---

BEGIN TEMPLATE — fill this out completely:

\`\`\`
### Sprint: [Short, compelling title]

## Goal

[One paragraph: what major capability ships at the end of this sprint and why it matters]

## Team & Timeline

- **Team:** 4-6 staff engineers
- **Duration:** 2-week cycle

## Rationale

[Why this is the highest-leverage initiative right now. Reference specific codebase findings — files, modules, patterns, metrics, gaps. Ground every claim in evidence from the scan.]

## Tasks

**Task 1:** [Title] ([N] days)

[Detailed description: what to build, how it works, key design decisions. Reference specific files and modules affected. Include concrete work items as bullet points.]

**Files:** [list of files created/modified]

---

**Task 2:** [Title] ([N] days)

[Same structure as above]

**Files:** [list of files created/modified]

---

[Continue for all 10-20 tasks...]

## Acceptance Criteria

- [ ] [User-visible, end-to-end criterion that proves the feature works]
- [ ] [Another measurable criterion]
[5-10 criteria total]

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Specific risk] | [Low/Med/High] | [Low/Med/High] | [Concrete mitigation] |
[3-8 risks]

## Out of Scope

- [Related work explicitly excluded from this sprint and why]
[3-8 items]
\`\`\`

END TEMPLATE

${BOIL_THE_LAKE_PRINCIPLE}`;
}

function buildCritiquePrompt(snapshot: string, proposal: string): string {
	return `Independently investigate the feasibility of this sprint proposal. This sprint is for a team of 4-6 staff engineers over 2 weeks.

## Project State

${snapshot}

## Sprint Proposal

${proposal}

## Your Task

Do NOT just react to what the proposer wrote. Read the actual codebase to verify their claims and find what they missed:

1. **Verify references** — The proposer mentioned specific files and modules. Read them. Are they described accurately? Do they actually exist?
2. **Find what's missing** — Scan the codebase for related code the proposer didn't mention. Are there integration points, callers, or dependencies they overlooked?
3. **Check scale** — Is this actually 2 weeks of work for a team, or is it undersized? Base your assessment on the actual code complexity you see, not the proposer's estimates.
4. **Assess feasibility** — Based on YOUR reading of the code, can this be built as described?

Your default stance is to approve. Only flag issues you can back with evidence from the actual codebase.`;
}

function buildSynthesisPrompt(snapshot: string, proposal: string, critique: string): string {
	return `Synthesize critique feedback into a final sprint plan for a team of 4-6 staff engineers over 2 weeks.

## Project State

${snapshot}

## Your Original Proposal

${proposal}

## Critique Received

${critique}

## Your Task

Produce a **final sprint plan** addressing the critique. This must be a MAJOR initiative — a meaningful product milestone, not a small task list.

Fill out the following template EXACTLY. Replace all bracketed placeholders with real content. Every section is required. Do NOT add extra sections, change headings, or restructure.

IMPORTANT: Each task MUST use the heading format \`**Task N:** Title (N days)\`. The word "Task" followed by a number is REQUIRED for automated parsing. Do NOT use plain numbered lists like "1. Title" — they will not be detected and the sprint will have 0 tasks.

---

BEGIN TEMPLATE — fill this out completely:

\`\`\`
### Sprint: [Short, compelling title]

## Goal

[One paragraph: what major capability ships and why it matters. Address any goal adjustments from the critique.]

## Team & Timeline

- **Team:** 4-6 staff engineers
- **Duration:** 2-week cycle

## Rationale

[Why this initiative, grounded in codebase evidence. Incorporate any corrections from the critique — if the critic found inaccuracies, fix them here.]

## Tasks

**Task 1:** [Title] ([N] days)

[Detailed description: what to build, how it works, key design decisions. Reference specific files and modules. Include concrete work items as bullet points. Incorporate critique feedback — if the critic identified missing work, complexity, or ordering issues, address them.]

**Files:** [list of files created/modified]

---

**Task 2:** [Title] ([N] days)

[Same structure as above]

**Files:** [list of files created/modified]

---

[Continue for all 10-20 tasks...]

## Acceptance Criteria

- [ ] [User-visible, end-to-end criterion that proves the feature works]
- [ ] [Another measurable criterion]
[5-10 criteria total. Adjust based on critique if original criteria were too strong/weak.]

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Specific risk — include any new risks the critic identified] | [Low/Med/High] | [Low/Med/High] | [Concrete mitigation] |
[3-8 risks]

## Out of Scope

- [Related work explicitly excluded from this sprint and why]
[3-8 items. Include any items the critic recommended deferring.]
\`\`\`

END TEMPLATE

${BOIL_THE_LAKE_PRINCIPLE}`;
}

// ---------------------------------------------------------------------------
// Reformat prompt — used when task parsing fails
// ---------------------------------------------------------------------------

function buildReformatPrompt(synthesis: string): string {
	return `The sprint plan below was generated but its tasks could not be parsed because they don't use the required heading format.

Reformat the plan so that every task heading uses EXACTLY this format:

**Task 1:** Title (N days)
**Task 2:** Title (N days)

or:

### Task 1: Title (N days)
### Task 2: Title (N days)

The word "Task" followed by a number and colon/period is REQUIRED. Do NOT use plain numbered lists like "1. Title" or "**1. Title**".

Keep ALL content, descriptions, acceptance criteria, risks, and out-of-scope sections IDENTICAL. Only change the task heading format. Do not summarize or omit anything.

Here is the plan to reformat:

${synthesis}`;
}

// ---------------------------------------------------------------------------
// Questions prompt — asks the proposer to surface open questions
// ---------------------------------------------------------------------------

function buildQuestionsPrompt(synthesis: string, snapshot: string): string {
	return `You just produced a sprint plan. Before execution begins, identify any **open questions** that need the user's input to make better decisions.

## The Sprint Plan

${synthesis}

## Project State (for reference)

${snapshot}

## Your Task

Review the plan and identify questions where the user's input would **materially change** the plan. Focus on:

1. **Ambiguous priorities** — are there trade-offs where user preference matters?
2. **Missing context** — does the plan assume something about the product direction, user needs, or business goals that should be confirmed?
3. **Design decisions** — are there architecture or UX choices where the user might have a strong opinion?
4. **Scope boundaries** — should something be included or excluded that isn't obvious from the codebase alone?

Do NOT ask questions that can be answered by reading the codebase — you already did that.
Do NOT ask trivial questions (naming preferences, formatting, etc.).
Only ask questions where the answer would change what gets built or how.

## Output Format

If you have questions, output them as a numbered list:

1. [Question — one clear sentence, with context for why it matters]
2. [Question]
...

If you have NO questions and the plan is ready to execute, output exactly:

NO_QUESTIONS

Nothing else. Either a numbered list of questions or NO_QUESTIONS.`;
}

function buildRevisionPrompt(
	snapshot: string,
	previousSynthesis: string,
	previousCritique: string,
	questionsAsked: string,
	userAnswers: string,
): string {
	return `You previously produced a sprint plan, but the user answered open questions that may require revisions.

## Project State

${snapshot}

## Previous Sprint Plan

${previousSynthesis}

## Previous Critique

${previousCritique}

## Questions You Asked

${questionsAsked}

## User's Answers

${userAnswers}

## Your Task

Revise the sprint plan based on the user's answers. Their answers may:
- Confirm your existing approach (keep it)
- Redirect priorities (adjust task ordering or scope)
- Add new requirements (add tasks)
- Remove things from scope (remove tasks)
- Change design decisions (modify task descriptions)

Produce a COMPLETE updated sprint plan using the same template format. Do NOT just list the changes — output the entire plan.

IMPORTANT: Each task MUST use the heading format \`**Task N:** Title (N days)\`. The word "Task" followed by a number is REQUIRED for automated parsing.

${BOIL_THE_LAKE_PRINCIPLE}`;
}

interface ParsedQuestion {
	number: number;
	text: string;
}

function parseQuestions(output: string): ParsedQuestion[] | null {
	const trimmed = output.trim();

	// Check for NO_QUESTIONS marker
	if (/\bNO_QUESTIONS\b/.test(trimmed)) {
		return null; // null means "no questions, plan is ready"
	}

	// Parse numbered questions
	const questions: ParsedQuestion[] = [];
	const pattern = /^\s*(\d+)\.\s+(.+)/gm;
	let match;
	while ((match = pattern.exec(trimmed)) !== null) {
		const text = match[2].trim();
		// Filter out noise — only keep substantial questions
		if (text.length > 10) {
			questions.push({ number: parseInt(match[1], 10), text });
		}
	}

	return questions.length > 0 ? questions : null;
}

// ---------------------------------------------------------------------------
// Task event helpers
// ---------------------------------------------------------------------------

function addEvent(task: SprintTask, type: SprintTask["events"][number]["type"], detail: string) {
	task.events.push({ timestamp: Date.now(), type, detail });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sprintExtension(pi: ExtensionAPI): void {
	pi.registerCommand("sprint", {
		description: "Plan and execute a major 2-week sprint (team of 4-6 engineers). Usage: /sprint [goal]",
		handler: async (args, ctx) => { await runFullSprint(pi, ctx, args?.trim() || null); },
	});

	pi.registerCommand("sprint-resume", {
		description: "Resume a paused sprint from where it left off",
		handler: async (_args, ctx) => { await resumeSprint(pi, ctx); },
	});

	pi.registerCommand("sprint-abort", {
		description: "Abort the currently executing sprint task",
		handler: async (_args, ctx) => {
			if (!activeAbortController) {
				ctx.ui.notify("No task currently executing.", "info");
				return;
			}
			activeAbortController.abort();
			ctx.ui.notify("Aborting current task...", "warning");
		},
	});

	pi.registerCommand("sprint-history", {
		description: "Show past sprint results",
		handler: async (_args, ctx) => {
			const storagePath = sprintStoragePath(ctx.cwd);
			const sprints = loadSprints(storagePath);
			if (sprints.length === 0) { ctx.ui.notify("No sprint history. Run /sprint.", "info"); return; }

			const choices = sprints.map((s) => {
				const date = new Date(s.createdAt).toLocaleDateString();
				const icon = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : s.status === "paused" ? "⏸" : s.status === "executing" ? "▶" : "○";
				const done = s.tasks.filter((t) => t.status === "done").length;
				const progress = s.tasks.length > 0 ? ` [${done}/${s.tasks.length}]` : "";
				return `${icon} ${date}${progress} — ${s.title || "(untitled)"}`;
			});
			const choice = await ctx.ui.select("Sprint History", choices);
			if (choice === undefined) return;
			const sprint = sprints[choices.indexOf(choice)];
			pi.sendMessage({
				customType: "sprint-history",
				content: `## Sprint: ${sprint.title}\n**Status:** ${sprint.status} | **Tasks:** ${sprint.tasks.filter((t) => t.status === "done").length}/${sprint.tasks.length}\n${sprint.reportPath ? `**Report:** ${sprint.reportPath}` : ""}\n\n---\n\n${sprint.synthesis || sprint.proposal}`,
				display: true,
			}, { triggerTurn: false });
		},
	});

	pi.registerCommand("plan-sprints", {
		description: "Generate a 30-sprint roadmap (~60 weeks, team-sized sprints). Usage: /plan-sprints [vision]",
		handler: async (args, ctx) => { await runPlanSprints(pi, ctx, args?.trim() || null); },
	});

	pi.on("session_start", async (_event, ctx) => {
		const storagePath = sprintStoragePath(ctx.cwd);
		const sprints = loadSprints(storagePath);
		const active = sprints.find((s) => s.status === "accepted" || s.status === "executing" || s.status === "paused");
		if (active) {
			const done = active.tasks.filter((t) => t.status === "done").length;
			const isPaused = active.status === "paused";
			const icon = isPaused ? "⏸" : "🏃";
			const suffix = isPaused ? " (paused — /sprint-resume)" : "";
			const label = active.tasks.length > 0 ? `${icon} ${active.title} [${done}/${active.tasks.length}]${suffix}` : `${icon} ${active.title}${suffix}`;
			ctx.ui.setStatus("sprint", ctx.ui.theme.fg(isPaused ? "warning" : "accent", label));
		}
	});

	pi.on("session_shutdown", async () => {
		// Kill running subprocess on exit
		if (activeAbortController) {
			activeAbortController.abort();
		}
	});
}

// Shared abort controller for the currently executing task subprocess
let activeAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Full sprint: plan → accept → execute → report
// ---------------------------------------------------------------------------

async function runFullSprint(pi: ExtensionAPI, ctx: ExtensionCommandContext, userGoal: string | null): Promise<void> {
	const cwd = ctx.cwd;
	const storagePath = sprintStoragePath(cwd);
	const proposer = loadAgent(PROPOSER_AGENT);
	const critic = loadAgent(CRITIC_AGENT);
	if (!proposer || !critic) {
		ctx.ui.notify(`Missing debate agents. Need ${PROPOSER_AGENT}.md and ${CRITIC_AGENT}.md in ~/.pi/agent/agents/`, "error");
		return;
	}

	// Check for existing paused sprint
	const existing = findResumableSprint(storagePath);
	if (existing) {
		const action = await ctx.ui.select(`There's a ${existing.status} sprint: "${existing.title}". What to do?`, [
			"▶️  Resume it",
			"🆕 Start a new sprint (marks current as completed)",
			"❌ Cancel",
		]);
		if (action?.startsWith("▶️")) {
			await resumeSprint(pi, ctx);
			return;
		} else if (action?.startsWith("🆕")) {
			existing.status = "completed";
			saveSprint(storagePath, existing);
			writeSprintReport(cwd, existing);
		} else {
			return;
		}
	}

	// =================================================================
	// PHASE A: Iterative planning debate (via subagents)
	//   propose → critique → synthesize → questions → user answers → repeat
	// =================================================================

	const tracker = createLiveTracker(ctx);
	startLiveUpdates(tracker, ctx);

	// --- Scan ---
	tracker.phase = "🔍 Scanning...";
	const snapshot = await scanProject(cwd);
	const snapshotText = formatSnapshot(snapshot);
	ctx.ui.notify(`Scan: ${snapshot.recentCommits.length} commits, ${snapshot.todos.length} TODOs, ${snapshot.planFiles.length} plans`, "info");

	// Accumulate Q&A context across iterations
	const qaHistory: { questions: string; answers: string }[] = [];
	let latestProposal = "";
	let latestCritique = "";
	let latestSynthesis = "";
	const MAX_QUESTION_ROUNDS = 5;

	for (let round = 0; round < MAX_QUESTION_ROUNDS; round++) {
		const isFirstRound = round === 0;
		const roundLabel = isFirstRound ? "" : ` (round ${round + 1})`;

		// --- Proposal ---
		if (isFirstRound) {
			tracker.phase = `💡 ${proposer.name} proposing...`;
			const goalNote = userGoal ? `\n\n**Goal:** ${userGoal}` : "";
			pi.sendMessage({ customType: "sprint-phase", content: `**Sprint Planning — Proposal${roundLabel}**\n\n${proposer.name} is analyzing the project...${goalNote}`, display: true }, { triggerTurn: false });
			const proposalResult = await runDebateAgent(proposer, buildProposalPrompt(snapshotText, userGoal), cwd, tracker);
			if (!proposalResult.output) {
				stopLiveUpdates(tracker);
				ctx.ui.setStatus("sprint", undefined);
				ctx.ui.notify("Proposer failed.", "error");
				return;
			}
			latestProposal = proposalResult.output;
			pi.sendMessage({ customType: "sprint-proposal", content: `**Proposal** (${proposalResult.model || proposer.name}):\n\n${latestProposal}`, display: true }, { triggerTurn: false });
		} else {
			// Revision round — incorporate user answers into a new proposal
			const lastQA = qaHistory[qaHistory.length - 1];
			tracker.phase = `💡 ${proposer.name} revising plan${roundLabel}...`;
			pi.sendMessage({ customType: "sprint-phase", content: `**Sprint Planning — Revision${roundLabel}**\n\n${proposer.name} is revising the plan based on your answers...`, display: true }, { triggerTurn: false });
			const revisionResult = await runDebateAgent(
				proposer,
				buildRevisionPrompt(snapshotText, latestSynthesis, latestCritique, lastQA.questions, lastQA.answers),
				cwd,
				tracker,
			);
			if (!revisionResult.output) {
				stopLiveUpdates(tracker);
				ctx.ui.setStatus("sprint", undefined);
				ctx.ui.notify("Revision failed.", "warning");
				return;
			}
			latestProposal = revisionResult.output;
			pi.sendMessage({ customType: "sprint-proposal", content: `**Revised Plan${roundLabel}** (${revisionResult.model || proposer.name}):\n\n${latestProposal}`, display: true }, { triggerTurn: false });
		}

		// --- Critique ---
		tracker.phase = `🔎 ${critic.name} critiquing${roundLabel}...`;
		pi.sendMessage({ customType: "sprint-phase", content: `**Sprint Planning — Critique${roundLabel}**\n\n${critic.name} is reviewing...`, display: true }, { triggerTurn: false });
		const critiqueResult = await runDebateAgent(critic, buildCritiquePrompt(snapshotText, latestProposal), cwd, tracker);
		latestCritique = critiqueResult.output || "(no critique)";
		if (critiqueResult.output) {
			pi.sendMessage({ customType: "sprint-critique", content: `**Critique${roundLabel}** (${critiqueResult.model || critic.name}):\n\n${critiqueResult.output}`, display: true }, { triggerTurn: false });
		}

		// --- Synthesis ---
		tracker.phase = `⚡ Synthesizing${roundLabel}...`;
		pi.sendMessage({ customType: "sprint-phase", content: `**Sprint Planning — Synthesis${roundLabel}**`, display: true }, { triggerTurn: false });
		const synthesisResult = await runDebateAgent(proposer, buildSynthesisPrompt(snapshotText, latestProposal, latestCritique), cwd, tracker);
		if (!synthesisResult.output) {
			stopLiveUpdates(tracker);
			ctx.ui.setStatus("sprint", undefined);
			ctx.ui.notify("Synthesis failed.", "warning");
			return;
		}
		latestSynthesis = synthesisResult.output;
		pi.sendMessage({ customType: "sprint-synthesis", content: `**Sprint Plan${roundLabel}:**\n\n${latestSynthesis}`, display: true }, { triggerTurn: false });

		// --- Questions phase ---
		tracker.phase = `❓ Checking for open questions${roundLabel}...`;
		pi.sendMessage({ customType: "sprint-phase", content: `**Checking for open questions${roundLabel}...**`, display: true }, { triggerTurn: false });
		const questionsResult = await runDebateAgent(proposer, buildQuestionsPrompt(latestSynthesis, snapshotText), cwd, tracker);

		const parsedQuestions = questionsResult.output ? parseQuestions(questionsResult.output) : null;

		if (!parsedQuestions || parsedQuestions.length === 0) {
			// No questions — plan is ready
			pi.sendMessage({ customType: "sprint-phase", content: `**✓ No open questions — plan is ready to execute.**`, display: true }, { triggerTurn: false });
			break;
		}

		// --- Present questions to user ---
		stopLiveUpdates(tracker);

		const questionList = parsedQuestions.map((q) => `${q.number}. ${q.text}`).join("\n");
		pi.sendMessage({
			customType: "sprint-questions",
			content: `**Open Questions (round ${round + 1}):**\n\n${questionList}`,
			display: true,
		}, { triggerTurn: false });

		// Let user choose: answer questions, skip questions, or abort
		const qAction = await ctx.ui.select(
			`${parsedQuestions.length} open question${parsedQuestions.length > 1 ? "s" : ""} about the sprint plan:`,
			[
				"✍️  Answer questions (will revise the plan)",
				"⏭️  Skip questions — plan is good enough",
				"❌ Abort sprint planning",
			],
		);

		if (qAction?.startsWith("⏭️")) {
			// User says plan is fine as-is
			pi.sendMessage({ customType: "sprint-phase", content: `**Questions skipped — proceeding with current plan.**`, display: true }, { triggerTurn: false });
			startLiveUpdates(tracker, ctx);
			break;
		}

		if (qAction?.startsWith("❌") || !qAction) {
			ctx.ui.setStatus("sprint", undefined);
			ctx.ui.notify("Sprint planning aborted.", "info");
			return;
		}

		// Collect answers — one editor with all questions pre-filled
		const editorPrefill = parsedQuestions.map((q) =>
			`## Question ${q.number}\n${q.text}\n\nAnswer: `
		).join("\n\n");

		const userAnswersRaw = await ctx.ui.editor(
			`Answer the ${parsedQuestions.length} question${parsedQuestions.length > 1 ? "s" : ""} below:`,
			editorPrefill,
		);

		if (!userAnswersRaw?.trim()) {
			// Empty answers — treat as skip
			pi.sendMessage({ customType: "sprint-phase", content: `**No answers provided — proceeding with current plan.**`, display: true }, { triggerTurn: false });
			startLiveUpdates(tracker, ctx);
			break;
		}

		// Store Q&A for context accumulation
		qaHistory.push({ questions: questionList, answers: userAnswersRaw });

		pi.sendMessage({
			customType: "sprint-answers",
			content: `**Your Answers (round ${round + 1}):**\n\n${userAnswersRaw}`,
			display: true,
		}, { triggerTurn: false });

		startLiveUpdates(tracker, ctx);
		// Loop continues — will revise the plan with the answers
	}

	// =================================================================
	// PHASE B: Parse tasks — validate format, auto-reformat if needed
	// =================================================================

	let finalSynthesis = latestSynthesis;
	let tasks = parseTasks(finalSynthesis);

	// Auto-reformat loop if parsing fails
	for (let attempt = 1; attempt <= MAX_REFORMAT_RETRIES && tasks.length === 0; attempt++) {
		ctx.ui.notify(`No tasks parsed (attempt ${attempt}/${MAX_REFORMAT_RETRIES}) — asking model to reformat...`, "warning");
		tracker.phase = `🔄 Reformatting tasks (${attempt}/${MAX_REFORMAT_RETRIES})...`;
		const reformatResult = await runDebateAgent(proposer, buildReformatPrompt(finalSynthesis), cwd, tracker);
		if (reformatResult.output) {
			tasks = parseTasks(reformatResult.output);
			if (tasks.length > 0) {
				finalSynthesis = reformatResult.output;
				ctx.ui.notify(`Reformat succeeded — found ${tasks.length} tasks.`, "info");
				pi.sendMessage({ customType: "sprint-synthesis", content: `**Reformatted Sprint Plan:**\n\n${reformatResult.output}`, display: true }, { triggerTurn: false });
			}
		}
	}

	// If still no tasks after all retries, let user edit manually
	if (tasks.length === 0) {
		stopLiveUpdates(tracker);
		const action = await ctx.ui.select(
			`Failed to parse tasks after ${MAX_REFORMAT_RETRIES} reformat attempts.`,
			[
				"✏️  Edit the plan manually",
				"❌ Abort sprint",
			],
		);
		if (action?.startsWith("✏️")) {
			const edited = await ctx.ui.editor("Edit the sprint plan (use **Task N:** format):", finalSynthesis);
			if (edited?.trim()) {
				tasks = parseTasks(edited);
				if (tasks.length > 0) {
					finalSynthesis = edited;
				} else {
					ctx.ui.notify("Still couldn't parse tasks from edited plan.", "error");
					ctx.ui.setStatus("sprint", undefined);
					return;
				}
			} else {
				ctx.ui.setStatus("sprint", undefined);
				ctx.ui.notify("Sprint cancelled.", "info");
				return;
			}
		} else {
			ctx.ui.setStatus("sprint", undefined);
			ctx.ui.notify("Sprint aborted.", "info");
			return;
		}
		startLiveUpdates(tracker, ctx);
	}

	stopLiveUpdates(tracker);

	// =================================================================
	// PHASE C: User decision
	// =================================================================

	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("accent", "📋 Plan ready"));
	const titleMatch = finalSynthesis.match(/###?\s*Sprint:\s*(.+)/i) || latestProposal.match(/Sprint Title[:\s]*(.+)/i);
	const title = titleMatch ? titleMatch[1].replace(/\*+/g, "").trim() : "Untitled Sprint";

	const taskSummary = tasks.length > 0
		? `\n\n**Parsed ${tasks.length} tasks:**\n${tasks.map((t) => `  ${t.index}. ${t.isFrontend ? "🎨" : "⚙️"} ${t.title}`).join("\n")}`
		: "";
	pi.sendMessage({ customType: "sprint-tasks", content: `**Tasks detected:** ${tasks.length}${taskSummary}`, display: true }, { triggerTurn: false });

	// Show planning stats
	const planTokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead;
	const planElapsed = formatDurationShort(Date.now() - tracker.startTime);
	pi.sendMessage({ customType: "sprint-stats", content: `**Planning stats:** ${planElapsed} | ${formatTokens(planTokens)} tokens | ${formatCost(tracker.usage.cost)}`, display: true }, { triggerTurn: false });

	const choice = await ctx.ui.select("Sprint Plan — What next?", [
		`✅ Accept & Execute (${tasks.length} tasks)`,
		"✏️  Refine with feedback",
		"❌ Reject",
		"💾 Save for later",
	]);

	const record: SprintRecord = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		title,
		status: "pending",
		proposal: latestProposal,
		critique: latestCritique || null,
		synthesis: finalSynthesis,
		snapshotSummary: `${snapshot.recentCommits.length} commits, ${snapshot.todos.length} TODOs`,
		tasks,
		currentTaskIndex: 0,
	};

	if (!choice?.startsWith("✅")) {
		if (choice?.startsWith("✏️")) {
			const feedback = await ctx.ui.editor("What should change?", "");
			if (feedback?.trim()) {
				record.status = "pending";
				saveSprint(storagePath, record);
				pi.sendUserMessage(`Sprint plan feedback:\n\n${finalSynthesis}\n\nMy feedback:\n${feedback.trim()}\n\nHelp refine this.`);
			}
		} else if (choice?.startsWith("❌")) {
			record.status = "rejected"; saveSprint(storagePath, record);
			ctx.ui.setStatus("sprint", undefined); ctx.ui.notify("Rejected. Run /sprint again.", "info");
		} else {
			record.status = "pending"; saveSprint(storagePath, record);
			ctx.ui.setStatus("sprint", undefined); ctx.ui.notify("Saved. /sprint-history to review.", "info");
		}
		return;
	}

	// Mark as executing and start
	record.status = "executing";
	const allSprints = loadSprints(storagePath);
	for (const s of allSprints) {
		if (s.status === "accepted" || s.status === "executing" || s.status === "paused") s.status = "completed";
	}
	saveSprints(storagePath, allSprints);
	saveSprint(storagePath, record);

	// Write initial report and store path
	const reportPath = writeSprintReport(cwd, record);
	record.reportPath = reportPath;
	saveSprint(storagePath, record);
	ctx.ui.notify(`Sprint report: ${reportPath}`, "info");

	await executeSprintTasks(pi, ctx, record, tracker);
}

// ---------------------------------------------------------------------------
// Resume a paused sprint
// ---------------------------------------------------------------------------

async function resumeSprint(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const storagePath = sprintStoragePath(cwd);
	const record = findResumableSprint(storagePath);

	if (!record) {
		ctx.ui.notify("No paused or executing sprint to resume. Run /sprint to start one.", "info");
		return;
	}

	// Sync task statuses from the markdown file (source of truth)
	syncRecordFromMarkdown(record);

	const done = record.tasks.filter((t) => t.status === "done").length;
	const remaining = record.tasks.filter((t) => t.status === "pending" || t.status === "running").length;

	if (remaining === 0) {
		ctx.ui.notify(`All ${record.tasks.length} tasks already completed.`, "info");
		record.status = "completed";
		saveSprint(storagePath, record);
		writeSprintReport(cwd, record);
		return;
	}

	pi.sendMessage({
		customType: "sprint-resume",
		content: `**Resuming Sprint: ${record.title}**\n\n**Progress:** ${done}/${record.tasks.length} tasks done, ${remaining} remaining\n**Report:** ${record.reportPath || "(unknown)"}\n\n**Remaining tasks:**\n${record.tasks.filter((t) => t.status !== "done" && t.status !== "failed").map((t) => `  ${t.index}. ${t.title}`).join("\n")}`,
		display: true,
	}, { triggerTurn: false });

	// Reset any "running" tasks back to pending (they were interrupted)
	for (const task of record.tasks) {
		if (task.status === "running") {
			task.status = "pending";
			addEvent(task, "stopped", "Reset to pending on resume — previous execution was interrupted");
		}
	}

	record.status = "executing";
	saveSprint(storagePath, record);
	writeSprintReport(cwd, record);

	// Create a fresh tracker for the resume, restoring usage from completed tasks
	const tracker = createLiveTracker(ctx);
	for (const t of record.tasks) {
		if (t.usage) addUsage(tracker.usage, t.usage);
	}

	await executeSprintTasks(pi, ctx, record, tracker);
}

// ---------------------------------------------------------------------------
// Shared task execution loop (used by both sprint and resume)
// ---------------------------------------------------------------------------

async function executeSprintTasks(pi: ExtensionAPI, ctx: ExtensionCommandContext, record: SprintRecord, tracker: LiveTracker): Promise<void> {
	const cwd = ctx.cwd;
	const storagePath = sprintStoragePath(cwd);
	const proposer = loadAgent(PROPOSER_AGENT);
	const critic = loadAgent(CRITIC_AGENT);
	if (!proposer || !critic) {
		ctx.ui.notify(`Missing debate agents. Need ${PROPOSER_AGENT}.md and ${CRITIC_AGENT}.md in ~/.pi/agent/agents/`, "error");
		return;
	}

	const tasks = record.tasks;
	const title = record.title;

	// Start live updates
	startLiveUpdates(tracker, ctx);
	renderTrackerWidget(tracker, tasks, ctx);

	const doneAtStart = tasks.filter((t) => t.status === "done").length;
	tracker.phase = `🏃 ${title} [${doneAtStart}/${tasks.length}]`;

	let autoRetry = false;

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];

		// Skip already completed/failed tasks
		if (task.status === "done" || task.status === "failed") continue;

		task.status = "running";
		task.startedAt = task.startedAt || Date.now();
		record.currentTaskIndex = i;
		// Reset task usage for fresh/retry execution
		if (!task.usage) task.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const taskStartMs = Date.now();
		addEvent(task, "started", `Assigned to ${task.isFrontend ? "frontend" : "backend"} profile`);
		saveSprint(storagePath, record);
		writeSprintReport(cwd, record);
		renderTrackerWidget(tracker, tasks, ctx);

		const profile = profileForTask(task);
		const tag = task.isFrontend ? "🎨 frontend" : "⚙️ backend";
		tracker.phase = `▶ Task ${task.index}/${tasks.length}: ${task.title}`;
		pi.sendMessage({
			customType: "sprint-exec-start",
			content: `**Executing Task ${task.index}/${tasks.length}: ${task.title}**\n${tag} → ${profile.model} (thinking: ${profile.thinking})`,
			display: true,
		}, { triggerTurn: false });

		// --- Execute ---
		activeAbortController = new AbortController();
		const execResult = await runPiSubagent({
			prompt: buildExecutionPrompt(task, record.synthesis),
			cwd, model: profile.model, thinking: profile.thinking, tools: profile.tools,
			signal: activeAbortController.signal,
			onActivity: (activity) => { tracker.activity = activity; },
		});
		activeAbortController = null;

		task.executionOutput = execResult.output;
		task.executionModel = execResult.model || profile.model;
		addUsage(task.usage, execResult.usage);
		addUsage(tracker.usage, execResult.usage);
		tracker.activity = "";
		addEvent(task, "executed", `exit=${execResult.exitCode} model=${task.executionModel} tokens=${formatTokens(execResult.usage.input + execResult.usage.output)} cost=${formatCost(execResult.usage.cost)} time=${formatDurationShort(execResult.durationMs)}`);

		const execTokens = execResult.usage.input + execResult.usage.output;
		if (!execResult.output || execResult.exitCode !== 0) {
			pi.sendMessage({ customType: "sprint-exec-fail", content: `**Task ${task.index} execution issue** (exit ${execResult.exitCode}, ${formatDurationShort(execResult.durationMs)}, ${formatTokens(execTokens)} tokens):\n\n${execResult.output?.slice(0, 2000) || "(no output)"}`, display: true }, { triggerTurn: false });
		} else {
			pi.sendMessage({ customType: "sprint-exec-done", content: `**Task ${task.index} executed** (${formatDurationShort(execResult.durationMs)}, ${formatTokens(execTokens)} tokens, ${formatCost(execResult.usage.cost)})\n\nOutput (excerpt):\n\n${execResult.output.slice(0, 3000)}`, display: true }, { triggerTurn: false });
		}

		// --- Post-task review debate (first pass) ---
		const primaryReviewer = task.isFrontend ? critic : proposer;
		const secondaryReviewer = task.isFrontend ? proposer : critic;

		tracker.phase = `🔎 Reviewing Task ${task.index}...`;
		pi.sendMessage({ customType: "sprint-review", content: `**Post-Task Review — Task ${task.index}** (primary: ${primaryReviewer.name}, secondary: ${secondaryReviewer.name})`, display: true }, { triggerTurn: false });

		const reviewPrimary = await runDebateAgent(primaryReviewer, buildReviewProposalPrompt(task, execResult.output || "(empty)", false, null), cwd, tracker);
		task.reviewProposal = reviewPrimary.output || null;
		addUsage(task.usage, reviewPrimary.usage);
		if (reviewPrimary.output) {
			pi.sendMessage({ customType: "sprint-review-primary", content: `**Primary Review** (${primaryReviewer.name}):\n\n${reviewPrimary.output}`, display: true }, { triggerTurn: false });
		}

		const reviewSecondary = await runDebateAgent(secondaryReviewer, buildReviewCritiquePrompt(task, execResult.output || "(empty)", reviewPrimary.output || "(no review)", false, null), cwd, tracker);
		task.reviewCritique = reviewSecondary.output || null;
		addUsage(task.usage, reviewSecondary.usage);
		if (reviewSecondary.output) {
			pi.sendMessage({ customType: "sprint-review-secondary", content: `**Secondary Review** (${secondaryReviewer.name}):\n\n${reviewSecondary.output}`, display: true }, { triggerTurn: false });
		}

		const primaryVerdict = extractVerdict(reviewPrimary.output || "");
		const secondaryVerdict = extractVerdict(reviewSecondary.output || "");
		const overallPass = primaryVerdict === "pass" && secondaryVerdict === "pass";
		task.reviewVerdict = overallPass ? "pass" : "needs_work";
		addEvent(task, overallPass ? "review_pass" : "review_needs_work", `primary(${primaryReviewer.name})=${primaryVerdict} secondary(${secondaryReviewer.name})=${secondaryVerdict}`);

		// --- LLM summary pass ---
		tracker.phase = `📝 Summarizing Task ${task.index}...`;
		const summaryResult = await runPiSubagent({
			prompt: buildTaskSummaryPrompt(task), cwd, model: profile.model, tools: ["read", "grep", "find", "ls"],
		});
		task.summary = summaryResult.output || null;
		addUsage(task.usage, summaryResult.usage);
		addUsage(tracker.usage, summaryResult.usage);

		// Finalize task timing
		task.executionDurationMs = Date.now() - taskStartMs;

		if (overallPass) {
			task.status = "done";
			task.completedAt = Date.now();
			saveSprint(storagePath, record);
			writeSprintReport(cwd, record);
			renderTrackerWidget(tracker, tasks, ctx);
			const done = tasks.filter((t) => t.status === "done").length;
			const taskTokens = task.usage.input + task.usage.output + task.usage.cacheRead;
			tracker.phase = `🏃 ${title} [${done}/${tasks.length}]`;
			pi.sendMessage({ customType: "sprint-task-pass", content: `**✅ Task ${task.index} PASSED** — ${task.title} (${formatDurationShort(task.executionDurationMs)}, ${formatTokens(taskTokens)} tokens, ${formatCost(task.usage.cost)})`, display: true }, { triggerTurn: false });
			continue;
		}

		// --- NEEDS_WORK: auto-retry or ask user ---
		const priorFeedback = [reviewPrimary.output || "", reviewSecondary.output || ""].filter(Boolean).join("\n\n---\n\n");
		let shouldRetry = autoRetry;

		if (!autoRetry) {
			stopLiveUpdates(tracker);
			pi.sendMessage({ customType: "sprint-task-needswork", content: `**⚠️ Task ${task.index} NEEDS WORK**`, display: true }, { triggerTurn: false });

			const action = await ctx.ui.select(`Task ${task.index} needs work. What to do?`, [
				"🔄 Retry this task",
				"🔄 Auto-retry this and all future tasks",
				"✅ Mark as done anyway",
				"⏭️  Skip and continue",
				"⏸  Pause sprint (resume later with /sprint-resume)",
				"🛑 Stop sprint execution",
			]);

			startLiveUpdates(tracker, ctx);

			if (action?.includes("Auto-retry")) {
				autoRetry = true;
				shouldRetry = true;
				addEvent(task, "retried", "User enabled auto-retry for all future tasks");
			} else if (action?.startsWith("🔄")) {
				shouldRetry = true;
				addEvent(task, "retried", "User chose to retry");
			} else if (action?.startsWith("✅")) {
				task.status = "done"; task.completedAt = Date.now();
				task.reviewVerdict = "pass (manual override)";
				addEvent(task, "user_override", "User marked done despite reviewer concerns");
			} else if (action?.startsWith("⏭️")) {
				task.status = "failed"; task.completedAt = Date.now();
				task.reviewVerdict = "skipped";
				addEvent(task, "skipped", "User chose to skip");
			} else if (action?.startsWith("⏸")) {
				// --- PAUSE ---
				task.status = "pending";
				addEvent(task, "stopped", "Sprint paused by user");
				record.status = "paused";
				saveSprint(storagePath, record);
				writeSprintReport(cwd, record);
				stopLiveUpdates(tracker);
				renderTrackerWidget(tracker, tasks, ctx);
				const done = tasks.filter((t) => t.status === "done").length;
				ctx.ui.setStatus("sprint", ctx.ui.theme.fg("warning", `⏸ ${title} [${done}/${tasks.length}] — paused`));
				pi.sendMessage({ customType: "sprint-paused", content: `**⏸ Sprint paused** at Task ${task.index}.\n\n**Progress:** ${done}/${tasks.length} done\n**Resume:** \`/sprint-resume\`\n**Report:** ${record.reportPath}`, display: true }, { triggerTurn: false });
				return;
			} else {
				// --- STOP ---
				task.status = "failed"; task.completedAt = Date.now();
				record.status = "failed";
				addEvent(task, "stopped", "User stopped sprint");
				saveSprint(storagePath, record);
				writeSprintReport(cwd, record);
				stopLiveUpdates(tracker);
				ctx.ui.setWidget("sprint-progress", undefined);
				ctx.ui.setStatus("sprint", ctx.ui.theme.fg("error", `⏹ ${title} — stopped`));
				pi.sendMessage({ customType: "sprint-stopped", content: `**Sprint stopped** at Task ${task.index}.\n\nReport: ${record.reportPath}`, display: true }, { triggerTurn: false });
				return;
			}
		} else {
			addEvent(task, "retried", "Auto-retry (user previously chose auto-retry all)");
		}

		if (shouldRetry) {
			// --- Retry with feedback context ---
			tracker.phase = `🔄 Retrying Task ${task.index}...`;
			activeAbortController = new AbortController();
			const retryResult = await runPiSubagent({
				prompt: buildRetryPrompt(task, record.synthesis, priorFeedback),
				cwd, model: profile.model, thinking: profile.thinking, tools: profile.tools,
				signal: activeAbortController.signal,
				onActivity: (activity) => { tracker.activity = activity; },
			});
			activeAbortController = null;
			tracker.activity = "";

			task.executionOutput = retryResult.output;
			addUsage(task.usage, retryResult.usage);
			addUsage(tracker.usage, retryResult.usage);
			addEvent(task, "executed", `retry exit=${retryResult.exitCode} tokens=${formatTokens(retryResult.usage.input + retryResult.usage.output)} cost=${formatCost(retryResult.usage.cost)} time=${formatDurationShort(retryResult.durationMs)}`);

			pi.sendMessage({ customType: "sprint-task-retry-done", content: `**Task ${task.index} retried** (${formatDurationShort(retryResult.durationMs)}, ${formatTokens(retryResult.usage.input + retryResult.usage.output)} tokens)\n\nOutput:\n\n${retryResult.output?.slice(0, 2000) || "(no output)"}`, display: true }, { triggerTurn: false });

			// --- Post-retry review debate (with prior context) ---
			tracker.phase = `🔎 Re-reviewing Task ${task.index}...`;

			const retryReviewPrimary = await runDebateAgent(primaryReviewer, buildReviewProposalPrompt(task, retryResult.output || "(empty)", true, priorFeedback), cwd, tracker);
			task.reviewProposal = retryReviewPrimary.output || null;
			addUsage(task.usage, retryReviewPrimary.usage);
			if (retryReviewPrimary.output) {
				pi.sendMessage({ customType: "sprint-review-primary", content: `**Retry Review** (${primaryReviewer.name}):\n\n${retryReviewPrimary.output}`, display: true }, { triggerTurn: false });
			}

			const retryReviewSecondary = await runDebateAgent(secondaryReviewer, buildReviewCritiquePrompt(task, retryResult.output || "(empty)", retryReviewPrimary.output || "(no review)", true, priorFeedback), cwd, tracker);
			task.reviewCritique = retryReviewSecondary.output || null;
			addUsage(task.usage, retryReviewSecondary.usage);
			if (retryReviewSecondary.output) {
				pi.sendMessage({ customType: "sprint-review-secondary", content: `**Retry Secondary** (${secondaryReviewer.name}):\n\n${retryReviewSecondary.output}`, display: true }, { triggerTurn: false });
			}

			const retryVerdict = extractVerdict(retryReviewPrimary.output || "") === "pass" && extractVerdict(retryReviewSecondary.output || "") === "pass";
			task.reviewVerdict = retryVerdict ? "pass (retried)" : "pass (retried, issues noted)";
			addEvent(task, retryVerdict ? "review_pass" : "review_needs_work", `retry review — accepted regardless`);

			// Re-summarize
			const retrySummary = await runPiSubagent({
				prompt: buildTaskSummaryPrompt(task), cwd, model: profile.model, tools: ["read", "grep", "find", "ls"],
			});
			task.summary = retrySummary.output || task.summary;
			addUsage(task.usage, retrySummary.usage);
			addUsage(tracker.usage, retrySummary.usage);

			// Finalize task timing
			task.executionDurationMs = Date.now() - taskStartMs;
			task.status = "done";
			task.completedAt = Date.now();
			const retryTaskTokens = task.usage.input + task.usage.output + task.usage.cacheRead;
			pi.sendMessage({ customType: "sprint-task-pass", content: `**✅ Task ${task.index} DONE** (retried) — ${task.title} (${formatDurationShort(task.executionDurationMs)}, ${formatTokens(retryTaskTokens)} tokens, ${formatCost(task.usage.cost)})`, display: true }, { triggerTurn: false });
		}

		saveSprint(storagePath, record);
		writeSprintReport(cwd, record);
		renderTrackerWidget(tracker, tasks, ctx);
		const done = tasks.filter((t) => t.status === "done").length;
		tracker.phase = `🏃 ${title} [${done}/${tasks.length}]`;
	}

	// =================================================================
	// Sprint complete
	// =================================================================

	record.status = "completed";
	saveSprint(storagePath, record);
	writeSprintReport(cwd, record);

	const doneCount = tasks.filter((t) => t.status === "done").length;
	const failedCount = tasks.filter((t) => t.status === "failed").length;
	const totalSprintTokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead;
	const sprintElapsed = formatDurationShort(Date.now() - tracker.startTime);
	stopLiveUpdates(tracker);
	ctx.ui.setWidget("sprint-progress", undefined);
	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("success", `✓ ${title} — complete (${sprintElapsed}, ${formatCost(tracker.usage.cost)})`));

	pi.sendMessage({
		customType: "sprint-complete",
		content: `**🎉 Sprint Complete: ${title}**\n\n**Results:** ${doneCount} done, ${failedCount} skipped/failed out of ${tasks.length} tasks\n**Time:** ${sprintElapsed} | **Tokens:** ${formatTokens(totalSprintTokens)} | **Cost:** ${formatCost(tracker.usage.cost)}\n\n${tasks.map((t) => {const tTok = (t.usage?.input || 0) + (t.usage?.output || 0) + (t.usage?.cacheRead || 0); return `${t.status === "done" ? "✅" : "❌"} Task ${t.index}: ${t.title} (${t.executionDurationMs > 0 ? formatDurationShort(t.executionDurationMs) : "—"}, ${tTok > 0 ? formatTokens(tTok) : "—"}, ${t.usage?.cost > 0 ? formatCost(t.usage.cost) : "—"})`;}).join("\n")}\n\n**Full report:** ${record.reportPath}`,
		display: true,
	}, { triggerTurn: false });
}

// ---------------------------------------------------------------------------
// Plan Sprints: generate 30-sprint roadmap via debate
// ---------------------------------------------------------------------------

async function runPlanSprints(pi: ExtensionAPI, ctx: ExtensionCommandContext, userGoal: string | null): Promise<void> {
	const cwd = ctx.cwd;
	const proposer = loadAgent(PROPOSER_AGENT);
	const critic = loadAgent(CRITIC_AGENT);
	if (!proposer || !critic) {
		ctx.ui.notify(`Missing debate agents. Need ${PROPOSER_AGENT}.md and ${CRITIC_AGENT}.md in ~/.pi/agent/agents/`, "error");
		return;
	}

	const tracker = createLiveTracker(ctx);
	startLiveUpdates(tracker, ctx);

	// --- Scan ---
	tracker.phase = "🔍 Scanning project for roadmap...";
	const snapshot = await scanProject(cwd);
	const snapshotText = formatSnapshot(snapshot);
	ctx.ui.notify(`Scan: ${snapshot.recentCommits.length} commits, ${snapshot.todos.length} TODOs, ${snapshot.planFiles.length} plans`, "info");

	// --- Propose roadmap ---
	tracker.phase = `💡 ${proposer.name} building roadmap...`;
	const goalNote = userGoal ? `\n\n**Vision:** ${userGoal}` : "";
	pi.sendMessage({ customType: "roadmap-phase", content: `**Roadmap — Phase 1/3: Proposal**\n\n${proposer.name} is designing a 30-sprint roadmap...${goalNote}`, display: true }, { triggerTurn: false });

	const proposalResult = await runDebateAgent(proposer, buildRoadmapProposalPrompt(snapshotText, userGoal), cwd, tracker);
	if (!proposalResult.output) {
		stopLiveUpdates(tracker);
		ctx.ui.setStatus("sprint", undefined);
		ctx.ui.notify("Proposer failed to generate roadmap.", "error");
		return;
	}
	pi.sendMessage({ customType: "roadmap-proposal", content: `**Roadmap Proposal** (${proposalResult.model || proposer.name}):\n\n${proposalResult.output.slice(0, 5000)}...`, display: true }, { triggerTurn: false });

	// --- Critique ---
	tracker.phase = `🔎 ${critic.name} reviewing roadmap...`;
	pi.sendMessage({ customType: "roadmap-phase", content: `**Roadmap — Phase 2/3: Review**\n\n${critic.name} is checking dependencies and feasibility...`, display: true }, { triggerTurn: false });

	const critiqueResult = await runDebateAgent(critic, buildRoadmapCritiquePrompt(snapshotText, proposalResult.output), cwd, tracker);
	if (critiqueResult.output) {
		pi.sendMessage({ customType: "roadmap-critique", content: `**Roadmap Review** (${critiqueResult.model || critic.name}):\n\n${critiqueResult.output}`, display: true }, { triggerTurn: false });
	}

	// --- Synthesize ---
	tracker.phase = "⚡ Finalizing roadmap...";
	pi.sendMessage({ customType: "roadmap-phase", content: `**Roadmap — Phase 3/3: Synthesis**`, display: true }, { triggerTurn: false });

	const synthesisResult = await runDebateAgent(proposer, buildRoadmapSynthesisPrompt(snapshotText, proposalResult.output, critiqueResult.output || "(no critique)"), cwd, tracker);
	if (!synthesisResult.output) {
		ctx.ui.notify("Synthesis failed. Using original proposal.", "warning");
	}

	const finalOutput = synthesisResult.output || proposalResult.output;

	// --- Parse sprints ---
	const sprints = parseRoadmapSprints(finalOutput);
	stopLiveUpdates(tracker);
	ctx.ui.notify(`Parsed ${sprints.length} sprints from roadmap`, "info");

	if (sprints.length === 0) {
		ctx.ui.setStatus("sprint", undefined);
		ctx.ui.notify("Could not parse any sprints from the roadmap output. Check LLM output format.", "error");
		pi.sendMessage({ customType: "roadmap-raw", content: `**Raw roadmap output (parsing failed):**\n\n${finalOutput.slice(0, 5000)}`, display: true }, { triggerTurn: false });
		return;
	}

	// Show summary
	const tier1 = sprints.filter((s) => s.tier === 1);
	const tier2 = sprints.filter((s) => s.tier === 2);
	const tier3 = sprints.filter((s) => s.tier === 3);

	const treeSummary = [
		`**Tier 1 — Foundation (${tier1.length}):**`,
		...tier1.map((s) => `  ${s.id}: ${s.title}`),
		"",
		`**Tier 2 — Building (${tier2.length}):**`,
		...tier2.map((s) => `  ${s.id}: ${s.title} ← ${s.dependsOn.join(", ") || "none"}`),
		"",
		`**Tier 3 — Capstone (${tier3.length}):**`,
		...tier3.map((s) => `  ${s.id}: ${s.title} ← ${s.dependsOn.join(", ") || "none"}`),
	].join("\n");

	// Show roadmap stats
	const rmTokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead;
	const rmElapsed = formatDurationShort(Date.now() - tracker.startTime);
	pi.sendMessage({ customType: "roadmap-summary", content: `**Roadmap: ${sprints.length} sprints** (${rmElapsed}, ${formatTokens(rmTokens)} tokens, ${formatCost(tracker.usage.cost)})\n\n${treeSummary}`, display: true }, { triggerTurn: false });

	// --- User decision ---
	const choice = await ctx.ui.select(`Roadmap: ${sprints.length} sprints across 3 tiers. What next?`, [
		"✅ Save roadmap to sprints/planned/",
		"❌ Discard",
	]);

	if (!choice?.startsWith("✅")) {
		ctx.ui.setStatus("sprint", undefined);
		ctx.ui.notify("Roadmap discarded.", "info");
		return;
	}

	// --- Write files ---
	const { dir, indexPath, count } = writeRoadmap(cwd, sprints);

	ctx.ui.setStatus("sprint", ctx.ui.theme.fg("success", `📋 Roadmap saved (${count} sprints)`));
	ctx.ui.notify(`Roadmap written to ${dir}/`, "info");

	pi.sendMessage({
		customType: "roadmap-complete",
		content: `**✅ Roadmap saved**\n\n**${count} sprint files** written to \`sprints/planned/\`\n\n**Index:** ${indexPath}\n\n${treeSummary}`,
		display: true,
	}, { triggerTurn: false });
}
