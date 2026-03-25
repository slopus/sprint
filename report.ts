/**
 * Sprint report generator — renders a sprint into markdown.
 * The markdown file is the primary source of truth for task progress.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SprintRecord } from "./store.js";
import type { SprintTask } from "./parser.js";
import { formatDurationShort } from "./executor.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function formatDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTimestamp(ts: number | null): string {
	return ts ? new Date(ts).toLocaleString() : "—";
}

function formatDuration(startMs: number | null, endMs: number | null): string {
	if (!startMs || !endMs) return "—";
	return formatDurationShort(endMs - startMs);
}

export function sprintReportPath(cwd: string, record: SprintRecord): string {
	return path.join(cwd, "sprints", `${formatDate(record.createdAt)}-${slugify(record.title || "sprint")}.md`);
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

export function generateSprintMarkdown(record: SprintRecord): string {
	const lines: string[] = [];
	const done = record.tasks.filter((t) => t.status === "done").length;
	const failed = record.tasks.filter((t) => t.status === "failed").length;
	const total = record.tasks.length;

	// Timing
	const firstStart = record.tasks.map((t) => t.startedAt).filter(Boolean).sort()[0] as number | undefined;
	const lastEnd = record.tasks.map((t) => t.completedAt).filter(Boolean).sort().pop() as number | undefined;
	const wallClockMs = firstStart && lastEnd ? lastEnd - firstStart : 0;

	// Header
	lines.push(`# Sprint: ${record.title}`, "");
	lines.push(`| Field | Value |`, `|-------|-------|`);
	lines.push(`| **Status** | ${record.status} |`);
	lines.push(`| **Created** | ${formatTimestamp(record.createdAt)} |`);
	lines.push(`| **Tasks** | ${done} done, ${failed} failed/skipped, ${total} total |`);
	if (wallClockMs > 0) lines.push(`| **Duration** | ${formatDurationShort(wallClockMs)} |`);
	lines.push(`| **Scan** | ${record.snapshotSummary} |`, "");

	// Table of contents
	lines.push(`## Table of Contents`, "");
	lines.push(`1. [Planning Debate](#planning-debate)`);
	lines.push(`2. [Task Execution](#task-execution)`);
	for (const task of record.tasks) {
		const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "▶" : "⏸";
		lines.push(`   - ${icon} [Task ${task.index}: ${task.title}](#task-${task.index})`);
	}
	lines.push(`3. [Summary](#summary)`, "");

	// Planning Debate
	lines.push(`---`, "", `## Planning Debate`, "");
	lines.push(`### Proposal`, "", record.proposal || "(none)", "");
	if (record.critique) lines.push(`### Critique`, "", record.critique, "");
	lines.push(`### Synthesized Plan`, "", record.synthesis || "(none)", "");

	// Task Execution
	lines.push(`---`, "", `## Task Execution`, "");
	for (const task of record.tasks) {
		lines.push(`<a id="task-${task.index}"></a>`, "");
		lines.push(`### Task ${task.index}: ${task.title}`, "");
		const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "▶" : "⏸";
		const type = task.isFrontend ? "🎨 Frontend" : "⚙️ Backend";
		lines.push(`| Field | Value |`, `|-------|-------|`);
		lines.push(`| **Status** | ${icon} ${task.status} |`);
		lines.push(`| **Type** | ${type} |`);
		lines.push(`| **Started** | ${formatTimestamp(task.startedAt)} |`);
		lines.push(`| **Completed** | ${formatTimestamp(task.completedAt)} |`);
		lines.push(`| **Duration** | ${formatDuration(task.startedAt, task.completedAt)} |`);
		lines.push(`| **Verdict** | ${task.reviewVerdict || "—"} |`, "");

		lines.push(`#### Description`, "", task.body, "");
		if (task.reviewVerdict) {
			lines.push(`#### Review`, "", `**Verdict:** ${task.reviewVerdict}`, "");
		}
	}

	// Summary
	lines.push(`---`, "", `## Summary`, "");
	lines.push(`| Task | Status | Type | Duration | Verdict |`);
	lines.push(`|------|--------|------|----------|---------|`);
	for (const task of record.tasks) {
		const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : "⏸";
		const type = task.isFrontend ? "frontend" : "backend";
		const dur = formatDuration(task.startedAt, task.completedAt);
		lines.push(`| ${task.index}. ${task.title} | ${icon} ${task.status} | ${type} | ${dur} | ${task.reviewVerdict || "—"} |`);
	}
	lines.push("");
	if (wallClockMs > 0) lines.push(`**Total time:** ${formatDurationShort(wallClockMs)}`, "");

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write / parse
// ---------------------------------------------------------------------------

export function writeSprintReport(cwd: string, record: SprintRecord): string {
	const reportPath = record.reportPath || sprintReportPath(cwd, record);
	record.reportPath = reportPath;
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, generateSprintMarkdown(record), "utf-8");
	return reportPath;
}

export function parseTaskStatusesFromMarkdown(reportPath: string): Map<number, SprintTask["status"]> {
	const statuses = new Map<number, SprintTask["status"]>();
	if (!fs.existsSync(reportPath)) return statuses;
	const content = fs.readFileSync(reportPath, "utf-8");
	const pattern = /### Task (\d+):[^\n]*\n[\s\S]*?\| \*\*Status\*\* \| ([^\|]+)\|/g;
	let match;
	while ((match = pattern.exec(content)) !== null) {
		const idx = parseInt(match[1], 10);
		const text = match[2].trim();
		statuses.set(idx, text.includes("done") ? "done" : text.includes("failed") ? "failed" : text.includes("running") ? "running" : "pending");
	}
	return statuses;
}

export function syncRecordFromMarkdown(record: SprintRecord): void {
	if (!record.reportPath || !fs.existsSync(record.reportPath)) return;
	const statuses = parseTaskStatusesFromMarkdown(record.reportPath);
	for (const task of record.tasks) {
		const s = statuses.get(task.index);
		if (s) task.status = s;
	}
	const firstPending = record.tasks.findIndex((t) => t.status !== "done" && t.status !== "failed");
	record.currentTaskIndex = firstPending >= 0 ? firstPending : record.tasks.length;
}
