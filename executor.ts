/**
 * Task executor — runs individual sprint tasks via pi subagents,
 * then orchestrates a post-task review debate.
 *
 * Model routing:
 *   Frontend tasks → anthropic/claude-opus-4-6 (no thinking)
 *   Backend tasks  → openai-codex/gpt-5.4       (high)
 *
 * Tracks token usage and cost from JSON mode events.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SprintTask, TokenUsage } from "./parser.js";

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export interface ModelProfile {
	model: string;
	thinking: string;
	tools: string[];
}

export const FRONTEND_PROFILE: ModelProfile = {
	model: "anthropic/claude-opus-4-6",
	thinking: "none",
	tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
};

export const BACKEND_PROFILE: ModelProfile = {
	model: "openai-codex/gpt-5.4",
	thinking: "high",
	tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
};

export const DEBATE_TOOLS = ["read", "grep", "find", "ls", "bash"];

export function profileForTask(task: SprintTask): ModelProfile {
	return task.isFrontend ? FRONTEND_PROFILE : BACKEND_PROFILE;
}

// ---------------------------------------------------------------------------
// Pi subprocess runner
// ---------------------------------------------------------------------------

export interface SubagentResult {
	output: string;
	exitCode: number;
	model?: string;
	durationMs: number;
	usage: TokenUsage;
}

function emptyUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export async function runPiSubagent(opts: {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPromptFile?: string;
	signal?: AbortSignal;
	onActivity?: (activity: string) => void;
}): Promise<SubagentResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
	if (opts.systemPromptFile) args.push("--append-system-prompt", opts.systemPromptFile);
	args.push(opts.prompt);

	let output = "";
	let model: string | undefined;
	const usage = emptyUsage();
	const startTime = Date.now();

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const part of event.message.content || []) {
						if (part.type === "text") output += part.text;
					}
					if (event.message.model) model = event.message.model;

					// Accumulate token usage across all assistant messages (multi-turn)
					const u = event.message.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead += u.cacheRead || 0;
						usage.cacheWrite += u.cacheWrite || 0;
						if (u.cost) {
							usage.cost += typeof u.cost === "number" ? u.cost : (u.cost.total || 0);
						}
					}
				}

				// Track tool activity for status updates
				if (event.type === "tool_execution_start" && opts.onActivity) {
					const name = event.toolName ?? "";
					const eArgs = event.args ?? {};
					let desc = name;
					if (name === "bash") {
						const cmd = (eArgs.command as string) || "";
						desc = `$ ${cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd}`;
					} else if (name === "read" || name === "write" || name === "edit") {
						desc = `${name} ${(eArgs.path as string) || ""}`;
					}
					opts.onActivity(desc);
				}
			} catch { /* skip */ }
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", () => {});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 1);
		});
		proc.on("error", () => resolve(1));

		if (opts.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
	});

	const durationMs = Date.now() - startTime;
	return { output, exitCode, model, durationMs, usage };
}

// ---------------------------------------------------------------------------
// Helpers to write temp system prompt files
// ---------------------------------------------------------------------------

export async function writeTempPrompt(name: string, content: string): Promise<{ dir: string; path: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sprint-"));
	const p = path.join(dir, `${name}.md`);
	await fs.promises.writeFile(p, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, path: p };
}

export function cleanupTemp(dir: string, filePath: string) {
	try { fs.unlinkSync(filePath); } catch {}
	try { fs.rmdirSync(dir); } catch {}
}

// ---------------------------------------------------------------------------
// Token usage helpers
// ---------------------------------------------------------------------------

export function addUsage(target: TokenUsage, source: TokenUsage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

export function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatDurationShort(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	if (min < 60) return `${min}m${rem}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h${min % 60}m`;
}

// ---------------------------------------------------------------------------
// Shared planning & execution principle
// ---------------------------------------------------------------------------

export const BOIL_THE_LAKE_PRINCIPLE = `## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When you present options:

- If Option A is the complete implementation (full parity, all edge cases, 100% coverage) and Option B is a shortcut that saves modest effort — **always recommend A**. The delta between 80 lines and 150 lines is meaningless with CC+gstack. "Good enough" is the wrong instinct when "complete" costs minutes more.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, handling all edge cases, complete error paths. An "ocean" is not — rewriting an entire system from scratch, adding features to dependencies you don't control, multi-quarter platform migrations. Recommend boiling lakes. Flag oceans as out of scope.
- **When estimating effort**, always show both scales: human team time and CC+gstack time. The compression ratio varies by task type — use this reference:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

- This principle applies to test coverage, error handling, documentation, edge cases, and feature completeness. Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

**Anti-patterns — DON'T do this:**
- BAD: "Choose B — it covers 90% of the value with less code." (If A is only 70 lines more, choose A.)
- BAD: "We can skip edge case handling to save time." (Edge case handling costs minutes with CC.)
- BAD: "Let's defer test coverage to a follow-up PR." (Tests are the cheapest lake to boil.)
- BAD: Quoting only human-team effort: "This would take 2 weeks." (Say: "2 weeks human / ~1 hour CC.")`;

// ---------------------------------------------------------------------------
// Execute a single task
// ---------------------------------------------------------------------------

export function buildExecutionPrompt(task: SprintTask, sprintPlan: string): string {
	return `You are executing Task ${task.index} of a major sprint initiative. This is a substantial task — expect to create/modify multiple files across the codebase.

## Sprint Plan (for context)

${sprintPlan}

## Your Task

**Task ${task.index}: ${task.title}**

${task.body}

## Instructions

1. Read broadly — understand the full context before making changes. Scan related files, tests, and dependencies.
2. Implement the complete task as described — this is a staff-engineer-level deliverable, not a stub or skeleton.
3. Write thorough tests — unit tests for new logic, integration tests where appropriate. Cover success and error paths.
4. Run the test suite to verify everything passes.
5. If tests fail, fix the issues before finishing.
6. Follow existing code patterns and conventions. Use the project's naming style, error handling approach, and module structure.

This task should result in meaningful, production-quality code. Do not leave TODOs or incomplete implementations.

${BOIL_THE_LAKE_PRINCIPLE}`;
}

export function buildRetryPrompt(task: SprintTask, sprintPlan: string, priorFeedback: string): string {
	return `You are completing Task ${task.index} after reviewer feedback. The first pass made substantial progress — this is a refinement pass, not a redo.

## Sprint Plan (for context)

${sprintPlan}

## Your Task

**Task ${task.index}: ${task.title}**

${task.body}

## Previous Attempt Feedback

The following issues were identified. Address the specific points raised:

${priorFeedback}

## Instructions

1. Read the current state of the files — the first pass already created/modified significant code
2. Fix the specific issues raised in the feedback
3. Ensure tests pass
4. Do NOT start from scratch — build on what was already done
5. Focus only on the flagged issues — don't refactor working code

${BOIL_THE_LAKE_PRINCIPLE}`;
}

// ---------------------------------------------------------------------------
// Post-task review debate — biased toward PASS
// ---------------------------------------------------------------------------

export function buildReviewProposalPrompt(task: SprintTask, executionOutput: string, isRetry: boolean, priorFeedback: string | null): string {
	const retryContext = isRetry && priorFeedback
		? `\n\n## Prior Review Context\n\nThis is a RETRY. The previous attempt received this feedback:\n\n${priorFeedback}\n\nThe implementer was asked to fix these specific issues. Focus your review on whether those issues were addressed. Do NOT re-raise issues that were already flagged and fixed. New minor issues should not block a PASS.`
		: "";

	return `Review the implementation of Task ${task.index}: "${task.title}".

## Task Description

${task.body}

## Implementation Output

${executionOutput.slice(0, 8000)}
${retryContext}

## Review Guidelines

Your default stance is **PASS**. This is a sprint — forward progress matters more than perfection.

**PASS** the task if:
- The core functionality described in the task was implemented
- It compiles/runs without obvious crashes
- A reasonable attempt at testing was made

**NEEDS_WORK** only if there is a **blocking issue** such as:
- Core functionality is entirely missing (not just incomplete polish)
- The code has a bug that would crash at runtime
- Tests were explicitly required and completely absent

Minor style issues, incomplete docs, or missing edge cases are NOT grounds for NEEDS_WORK.

Conclude with your verdict: **PASS** or **NEEDS_WORK**.`;
}

export function buildReviewCritiquePrompt(task: SprintTask, executionOutput: string, proposalReview: string, isRetry: boolean, priorFeedback: string | null): string {
	const retryContext = isRetry && priorFeedback
		? `\n\n## Prior Review Context\n\nThis is a RETRY. The previous attempt had these issues:\n\n${priorFeedback}\n\nFocus your investigation on whether those specific issues were fixed. Do not re-flag resolved issues.`
		: "";

	return `You are the second reviewer for Task ${task.index}: "${task.title}". Another reviewer already investigated. Build on their work.

## Task Description

${task.body}

## Implementation Output (excerpt)

${executionOutput.slice(0, 4000)}

## Primary Reviewer's Findings

${proposalReview}
${retryContext}

## Your Job

The primary reviewer already investigated. Your job is to:

1. **Verify their claims** — they referenced specific files and findings. Read those files yourself. Do their claims hold up?
2. **Fill gaps they missed** — what files, tests, or integration points did they NOT look at? Investigate those.
3. **Check their blind spots** — the primary reviewer is the model that DIDN'T write this code. You DID (or the same model family did). Use your knowledge of the implementation intent to catch things an outside reviewer might misunderstand.
4. **Confirm or challenge their verdict** — if they said PASS, verify. If they said NEEDS_WORK, check if the concern is real.

Do NOT repeat what the primary reviewer already found. Add new information only.

Your default stance is **PASS**. Only flag issues you can point to in actual code.

Give your verdict: **PASS** or **NEEDS_WORK** with evidence.`;
}

export function extractVerdict(review: string): "pass" | "needs_work" {
	const upper = review.toUpperCase();
	if (upper.includes("NEEDS_WORK")) return "needs_work";
	if (upper.includes("**PASS**") || upper.match(/\bPASS\b/)) return "pass";
	return "pass";
}

// ---------------------------------------------------------------------------
// Post-task summary (LLM pass for structured record)
// ---------------------------------------------------------------------------

export function buildTaskSummaryPrompt(task: SprintTask): string {
	return `Produce a structured summary of the work done for this sprint task.

## Task

**Task ${task.index}: ${task.title}**

${task.body}

## Execution Output

${(task.executionOutput || "(no output)").slice(0, 10000)}

## Reviewer Assessment

${task.reviewProposal || "(none)"}

## Reviewer Critique

${task.reviewCritique || "(none)"}

## Review Verdict

${task.reviewVerdict || "unknown"}

## Instructions

Produce a concise, structured summary in this exact format:

### Files Changed
- List each file that was created, modified, or deleted

### What Was Done
- Bullet points summarizing the concrete implementation work

### Why
- The rationale — what problem this solves, why it was prioritized

### Key Decisions
- Any non-obvious choices made during implementation (architecture, naming, patterns, trade-offs)

### Review Outcome
- One sentence summarizing reviewer consensus and any caveats

Be factual. Reference specific files, functions, and line counts where visible in the output. Do not invent details not present in the execution output.`;
}
