/**
 * Parse a synthesized sprint plan into structured, executable tasks.
 * Classifies each task as frontend or backend for model routing.
 */

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TaskEvent {
	timestamp: number;
	type: "started" | "executed" | "review_pass" | "review_needs_work" | "retried" | "user_override" | "skipped" | "stopped";
	detail: string;
}

export interface SprintTask {
	index: number;
	title: string;
	body: string;
	isFrontend: boolean;
	status: "pending" | "running" | "done" | "failed";
	executionOutput: string | null;
	executionModel: string | null;
	reviewProposal: string | null;
	reviewCritique: string | null;
	reviewVerdict: string | null;
	summary: string | null;
	startedAt: number | null;
	completedAt: number | null;
	events: TaskEvent[];
	/** Accumulated token usage across all subagent calls for this task */
	usage: TokenUsage;
	/** Total wall-clock time for execution + review (ms) */
	executionDurationMs: number;
}

const FRONTEND_PATH_PATTERNS = [
	/\.tsx/i,
	/\.css/i,
	/\.html/i,
	/mainview/i,
	/components?\//i,
	/pages?\//i,
	/views?\//i,
	/hooks?\//i,
	/src\/app/i,
];

const FRONTEND_KEYWORDS = [
	/\bUI\b/,
	/\bfrontend\b/i,
	/\bcomponent\b/i,
	/\breact\b/i,
	/\bheader\b/i,
	/\bsidebar\b/i,
	/\bbutton\b/i,
	/\bhook\b/i,
	/\bCSS\b/,
	/\bstyle/i,
	/\blayout\b/i,
	/\brender/i,
	/\bAppShell\b/,
	/\bpage\b/i,
	/\bwidget\b/i,
	/\bmodal\b/i,
	/\bpopover\b/i,
	/\bindicator\b/i,
	/\btooltip\b/i,
	/\bbadge\b/i,
	/\bpolling\b.*\bUI\b/i,
	/\buseGit/i,
	/\buse[A-Z]/,
];

export function classifyTask(title: string, body: string): boolean {
	const text = `${title}\n${body}`;
	for (const p of FRONTEND_PATH_PATTERNS) {
		if (p.test(text)) return true;
	}
	for (const k of FRONTEND_KEYWORDS) {
		if (k.test(text)) return true;
	}
	return false;
}

/**
 * Extract tasks from the synthesized sprint plan markdown.
 * Tries the canonical "Task N:" format first, then falls back to
 * bold numbered items (e.g. "**1. Title**") under a Tasks section.
 */
export function parseTasks(synthesis: string): SprintTask[] {
	// Primary pattern: "Task N:" or "### Task N:" or "**Task N:**"
	const taskPattern =
		/(?:^|\n)(?:#{1,4}\s*)?(?:\*{1,2})?(?:Stretch\s+)?Task\s+[\dA-Za-z]+[:.]\s*(.+?)(?:\*{1,2})?\s*\n/gi;

	let matches = [...synthesis.matchAll(taskPattern)];

	// Fallback: bold numbered items like "**1. Title (N days)**" or "**1. Title**"
	// Only activate if the primary pattern found nothing
	if (matches.length === 0) {
		const fallbackPattern =
			/(?:^|\n)(?:#{1,4}\s*)?\*{1,2}\d+[.:]\s*(.+?)\*{1,2}\s*\n/gi;
		matches = [...synthesis.matchAll(fallbackPattern)];
	}

	if (matches.length === 0) return [];

	const tasks: SprintTask[] = [];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const title = match[1]
			.replace(/\*+/g, "")
			.replace(/—.*$/, "")
			.replace(/-\s*[\d.]+\s*days?$/i, "")
			.replace(/\(\d+\s*days?\)\s*$/i, "")
			.trim();

		const startIdx = match.index! + match[0].length;
		const endIdx = i + 1 < matches.length ? matches[i + 1].index! : undefined;
		const body = endIdx !== undefined
			? synthesis.slice(startIdx, endIdx).trim()
			: synthesis.slice(startIdx).split(/\n---|\n\*\*Acceptance Criteria|\n\*\*Risks|\n\*\*Out of Scope/i)[0]?.trim() || "";

		tasks.push({
			index: tasks.length + 1,
			title,
			body,
			isFrontend: classifyTask(title, body),
			status: "pending",
			executionOutput: null,
			executionModel: null,
			reviewProposal: null,
			reviewCritique: null,
			reviewVerdict: null,
			summary: null,
			startedAt: null,
			completedAt: null,
			events: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			executionDurationMs: 0,
		});
	}

	return tasks;
}

export function formatTaskWidget(tasks: SprintTask[], theme: { fg: (c: string, t: string) => string; strikethrough: (t: string) => string }): string[] {
	return tasks.map((t) => {
		const icon =
			t.status === "done" ? theme.fg("success", "✓")
			: t.status === "failed" ? theme.fg("error", "✗")
			: t.status === "running" ? theme.fg("warning", "▶")
			: theme.fg("muted", "○");
		const text = t.status === "done"
			? theme.fg("muted", theme.strikethrough(t.title))
			: t.title;
		return `${icon} ${t.index}. ${text}`;
	});
}
