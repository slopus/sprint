/**
 * Sprint report generator — renders a sprint into a comprehensive
 * markdown file at <project>/sprints/<date>-<name>.md
 *
 * The markdown file is the primary source of truth for task progress.
 * It is written incrementally as tasks complete and can be parsed back
 * to restore sprint state for resume.
 *
 * Includes: planning debate transcripts, per-task execution details,
 * review debates, user decisions, LLM-generated summaries, and timing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SprintRecord } from "./store.js";
import type { SprintTask, TokenUsage } from "./parser.js";
import { formatTokens, formatCost, formatDurationShort } from "./executor.js";

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

function aggregateUsage(tasks: SprintTask[]): TokenUsage {
	const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const t of tasks) {
		if (!t.usage) continue;
		total.input += t.usage.input || 0;
		total.output += t.usage.output || 0;
		total.cacheRead += t.usage.cacheRead || 0;
		total.cacheWrite += t.usage.cacheWrite || 0;
		total.cost += t.usage.cost || 0;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function formatDate(ts: number): string {
	const d = new Date(ts);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatTimestamp(ts: number | null): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleString();
}

function formatDuration(startMs: number | null, endMs: number | null): string {
	if (!startMs || !endMs) return "—";
	const sec = Math.round((endMs - startMs) / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	if (min < 60) return `${min}m ${rem}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${min % 60}m`;
}

export function sprintReportPath(cwd: string, record: SprintRecord): string {
	const date = formatDate(record.createdAt);
	const slug = slugify(record.title || "sprint");
	return path.join(cwd, "sprints", `${date}-${slug}.md`);
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

export function generateSprintMarkdown(record: SprintRecord): string {
	const lines: string[] = [];
	const done = record.tasks.filter((t) => t.status === "done").length;
	const failed = record.tasks.filter((t) => t.status === "failed").length;
	const total = record.tasks.length;

	// Aggregate usage across all tasks
	const totalUsage = aggregateUsage(record.tasks);
	const totalExecMs = record.tasks.reduce((sum, t) => sum + (t.executionDurationMs || 0), 0);
	const firstStart = record.tasks.map((t) => t.startedAt).filter(Boolean).sort()[0] as number | undefined;
	const lastEnd = record.tasks.map((t) => t.completedAt).filter(Boolean).sort().pop() as number | undefined;
	const wallClockMs = firstStart && lastEnd ? lastEnd - firstStart : 0;

	// Header
	lines.push(`# Sprint: ${record.title}`);
	lines.push("");
	lines.push(`| Field | Value |`);
	lines.push(`|-------|-------|`);
	lines.push(`| **Status** | ${record.status} |`);
	lines.push(`| **Created** | ${formatTimestamp(record.createdAt)} |`);
	lines.push(`| **Tasks** | ${done} done, ${failed} failed/skipped, ${total} total |`);
	lines.push(`| **Scan** | ${record.snapshotSummary} |`);
	if (totalExecMs > 0 || wallClockMs > 0) {
		lines.push(`| **Wall Clock** | ${wallClockMs > 0 ? formatDurationShort(wallClockMs) : "—"} |`);
		lines.push(`| **Execution Time** | ${totalExecMs > 0 ? formatDurationShort(totalExecMs) : "—"} |`);
	}
	if (totalUsage.input > 0 || totalUsage.output > 0) {
		const totalTokens = totalUsage.input + totalUsage.output + totalUsage.cacheRead;
		lines.push(`| **Tokens** | ${formatTokens(totalTokens)} total (${formatTokens(totalUsage.input)} in, ${formatTokens(totalUsage.output)} out, ${formatTokens(totalUsage.cacheRead)} cache) |`);
		lines.push(`| **Cost** | ${formatCost(totalUsage.cost)} |`);
	}
	lines.push("");

	// Table of contents
	lines.push(`## Table of Contents`);
	lines.push("");
	lines.push(`1. [Planning Debate](#planning-debate)`);
	lines.push(`2. [Task Execution](#task-execution)`);
	for (const task of record.tasks) {
		const statusIcon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "▶" : "⏸";
		lines.push(`   - ${statusIcon} [Task ${task.index}: ${task.title}](#task-${task.index})`);
	}
	lines.push(`3. [Summary](#summary)`);
	lines.push("");

	// -----------------------------------------------------------------------
	// Planning Debate
	// -----------------------------------------------------------------------
	lines.push(`---`);
	lines.push("");
	lines.push(`## Planning Debate`);
	lines.push("");

	lines.push(`### Proposal`);
	lines.push("");
	lines.push(record.proposal || "(no proposal recorded)");
	lines.push("");

	if (record.critique) {
		lines.push(`### Critique`);
		lines.push("");
		lines.push(record.critique);
		lines.push("");
	}

	lines.push(`### Synthesized Plan`);
	lines.push("");
	lines.push(record.synthesis || "(no synthesis recorded)");
	lines.push("");

	// -----------------------------------------------------------------------
	// Task Execution
	// -----------------------------------------------------------------------
	lines.push(`---`);
	lines.push("");
	lines.push(`## Task Execution`);
	lines.push("");

	for (const task of record.tasks) {
		lines.push(`<a id="task-${task.index}"></a>`);
		lines.push("");
		lines.push(`### Task ${task.index}: ${task.title}`);
		lines.push("");

		const statusIcon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "▶" : "⏸";
		const typeTag = task.isFrontend ? "🎨 Frontend" : "⚙️ Backend";

		const taskTokens = (task.usage?.input || 0) + (task.usage?.output || 0) + (task.usage?.cacheRead || 0);

		lines.push(`| Field | Value |`);
		lines.push(`|-------|-------|`);
		lines.push(`| **Status** | ${statusIcon} ${task.status} |`);
		lines.push(`| **Type** | ${typeTag} |`);
		lines.push(`| **Model** | ${task.executionModel || "—"} |`);
		lines.push(`| **Started** | ${formatTimestamp(task.startedAt)} |`);
		lines.push(`| **Completed** | ${formatTimestamp(task.completedAt)} |`);
		lines.push(`| **Duration** | ${formatDuration(task.startedAt, task.completedAt)} |`);
		if (task.executionDurationMs > 0) {
			lines.push(`| **Exec Time** | ${formatDurationShort(task.executionDurationMs)} |`);
		}
		if (taskTokens > 0) {
			lines.push(`| **Tokens** | ${formatTokens(taskTokens)} (${formatTokens(task.usage.input)} in, ${formatTokens(task.usage.output)} out, ${formatTokens(task.usage.cacheRead)} cache) |`);
			lines.push(`| **Cost** | ${formatCost(task.usage.cost)} |`);
		}
		lines.push(`| **Verdict** | ${task.reviewVerdict || "—"} |`);
		lines.push("");

		// Task description
		lines.push(`#### Description`);
		lines.push("");
		lines.push(task.body);
		lines.push("");

		// Event log
		if (task.events.length > 0) {
			lines.push(`#### Event Log`);
			lines.push("");
			lines.push(`| Time | Event | Detail |`);
			lines.push(`|------|-------|--------|`);
			for (const ev of task.events) {
				const time = new Date(ev.timestamp).toLocaleTimeString();
				lines.push(`| ${time} | ${ev.type} | ${ev.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
			}
			lines.push("");
		}

		// Execution output
		if (task.executionOutput) {
			lines.push(`#### Execution Output`);
			lines.push("");
			lines.push(`<details>`);
			lines.push(`<summary>Full execution output (click to expand)</summary>`);
			lines.push("");
			lines.push("```");
			lines.push(task.executionOutput);
			lines.push("```");
			lines.push("");
			lines.push(`</details>`);
			lines.push("");
		}

		// Review debate
		if (task.reviewProposal || task.reviewCritique) {
			lines.push(`#### Review Debate`);
			lines.push("");

			if (task.reviewProposal) {
				lines.push(`**Proposer Review:**`);
				lines.push("");
				lines.push(task.reviewProposal);
				lines.push("");
			}

			if (task.reviewCritique) {
				lines.push(`**Critic Review:**`);
				lines.push("");
				lines.push(task.reviewCritique);
				lines.push("");
			}
		}

		// LLM-generated summary
		if (task.summary) {
			lines.push(`#### Summary`);
			lines.push("");
			lines.push(task.summary);
			lines.push("");
		}
	}

	// -----------------------------------------------------------------------
	// Final summary
	// -----------------------------------------------------------------------
	lines.push(`---`);
	lines.push("");
	lines.push(`## Summary`);
	lines.push("");
	lines.push(`| Task | Status | Type | Duration | Tokens | Cost | Verdict |`);
	lines.push(`|------|--------|------|----------|--------|------|---------|`);
	for (const task of record.tasks) {
		const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : "⏸";
		const type = task.isFrontend ? "frontend" : "backend";
		const dur = task.executionDurationMs > 0 ? formatDurationShort(task.executionDurationMs) : formatDuration(task.startedAt, task.completedAt);
		const tTokens = (task.usage?.input || 0) + (task.usage?.output || 0) + (task.usage?.cacheRead || 0);
		const tokens = tTokens > 0 ? formatTokens(tTokens) : "—";
		const cost = task.usage?.cost > 0 ? formatCost(task.usage.cost) : "—";
		lines.push(`| ${task.index}. ${task.title} | ${icon} ${task.status} | ${type} | ${dur} | ${tokens} | ${cost} | ${task.reviewVerdict || "—"} |`);
	}
	lines.push("");

	// Sprint-level totals
	if (wallClockMs > 0) {
		lines.push(`**Wall clock:** ${formatDurationShort(wallClockMs)} | **Execution time:** ${formatDurationShort(totalExecMs)} | **Total tokens:** ${formatTokens(totalUsage.input + totalUsage.output + totalUsage.cacheRead)} | **Total cost:** ${formatCost(totalUsage.cost)}`);
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write report to disk
// ---------------------------------------------------------------------------

export function writeSprintReport(cwd: string, record: SprintRecord): string {
	const reportPath = record.reportPath || sprintReportPath(cwd, record);
	record.reportPath = reportPath;
	const dir = path.dirname(reportPath);
	fs.mkdirSync(dir, { recursive: true });
	const content = generateSprintMarkdown(record);
	fs.writeFileSync(reportPath, content, "utf-8");
	return reportPath;
}

// ---------------------------------------------------------------------------
// Parse sprint markdown back into a record (for resume)
// ---------------------------------------------------------------------------

/**
 * Read task statuses from an existing sprint markdown file.
 * Returns a map of task index → status parsed from the task execution tables.
 */
export function parseTaskStatusesFromMarkdown(reportPath: string): Map<number, SprintTask["status"]> {
	const statuses = new Map<number, SprintTask["status"]>();
	if (!fs.existsSync(reportPath)) return statuses;

	const content = fs.readFileSync(reportPath, "utf-8");

	const taskSectionPattern = /### Task (\d+):[^\n]*\n[\s\S]*?\| \*\*Status\*\* \| ([^\|]+)\|/g;
	let match;
	while ((match = taskSectionPattern.exec(content)) !== null) {
		const taskIndex = parseInt(match[1], 10);
		const statusText = match[2].trim();

		if (statusText.includes("done")) {
			statuses.set(taskIndex, "done");
		} else if (statusText.includes("failed")) {
			statuses.set(taskIndex, "failed");
		} else if (statusText.includes("running")) {
			statuses.set(taskIndex, "running");
		} else {
			statuses.set(taskIndex, "pending");
		}
	}

	return statuses;
}

/**
 * Parse the sprint-level status from the header metadata table.
 */
export function parseSprintStatusFromMarkdown(reportPath: string): SprintRecord["status"] | null {
	if (!fs.existsSync(reportPath)) return null;
	const content = fs.readFileSync(reportPath, "utf-8");
	const match = content.match(/\| \*\*Status\*\* \| (\w+)/);
	if (!match) return null;
	const raw = match[1].trim();
	const valid: SprintRecord["status"][] = ["pending", "accepted", "executing", "paused", "completed", "rejected", "failed"];
	return valid.includes(raw as any) ? raw as SprintRecord["status"] : null;
}

/**
 * Sync task statuses from the markdown file back into the record.
 * Used on resume to pick up where we left off.
 */
export function syncRecordFromMarkdown(record: SprintRecord): void {
	if (!record.reportPath || !fs.existsSync(record.reportPath)) return;
	const statuses = parseTaskStatusesFromMarkdown(record.reportPath);
	for (const task of record.tasks) {
		const mdStatus = statuses.get(task.index);
		if (mdStatus) {
			task.status = mdStatus;
		}
	}

	const firstPending = record.tasks.findIndex((t) => t.status !== "done" && t.status !== "failed");
	record.currentTaskIndex = firstPending >= 0 ? firstPending : record.tasks.length;
}
