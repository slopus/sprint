/**
 * Project scanner — gathers context for sprint planning.
 *
 * Collects git history, TODOs, plan files, directory structure,
 * and other signals to feed into the debate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface ProjectSnapshot {
	cwd: string;
	scannedAt: number;
	recentCommits: string[];
	gitDiffStat: string | null;
	gitBranch: string | null;
	todos: TodoItem[];
	planFiles: PlanFile[];
	readme: string | null;
	structure: string[];
	packageInfo: PackageInfo | null;
}

export interface TodoItem {
	file: string;
	line: number;
	kind: string;
	text: string;
}

export interface PlanFile {
	name: string;
	excerpt: string;
}

export interface PackageInfo {
	name: string;
	description?: string;
	scripts?: Record<string, string>;
}

function execGit(cwd: string, args: string): string | null {
	try {
		return execSync(`git ${args}`, { cwd, encoding: "utf-8", timeout: 10000 }).trim();
	} catch {
		return null;
	}
}

function execGrep(cwd: string, args: string): string | null {
	try {
		return execSync(args, { cwd, encoding: "utf-8", timeout: 10000 }).trim();
	} catch {
		return null;
	}
}

export async function scanProject(cwd: string): Promise<ProjectSnapshot> {
	const [
		recentCommits,
		gitDiffStat,
		gitBranch,
		todos,
		planFiles,
		readme,
		structure,
		packageInfo,
	] = await Promise.all([
		Promise.resolve(scanCommits(cwd)),
		Promise.resolve(scanDiffStat(cwd)),
		Promise.resolve(scanBranch(cwd)),
		Promise.resolve(scanTodos(cwd)),
		Promise.resolve(scanPlans(cwd)),
		Promise.resolve(scanReadme(cwd)),
		Promise.resolve(scanStructure(cwd)),
		Promise.resolve(scanPackage(cwd)),
	]);

	return {
		cwd,
		scannedAt: Date.now(),
		recentCommits,
		gitDiffStat,
		gitBranch,
		todos,
		planFiles,
		readme,
		structure,
		packageInfo,
	};
}

function scanCommits(cwd: string): string[] {
	const raw = execGit(cwd, 'log --oneline --since="2 weeks ago" -n 30');
	return raw ? raw.split("\n").filter(Boolean) : [];
}

function scanDiffStat(cwd: string): string | null {
	return execGit(cwd, "diff --stat HEAD~10..HEAD 2>/dev/null");
}

function scanBranch(cwd: string): string | null {
	return execGit(cwd, "branch --show-current");
}

function scanTodos(cwd: string): TodoItem[] {
	const raw = execGrep(
		cwd,
		`grep -rn -E "(TODO|FIXME|HACK|XXX):" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" --include="*.rs" . 2>/dev/null | head -50`,
	);
	if (!raw) return [];

	const items: TodoItem[] = [];
	for (const line of raw.split("\n").filter(Boolean)) {
		const match = line.match(/^\.\/(.+?):(\d+):(.+)$/);
		if (!match) continue;
		const [, file, lineStr, content] = match;
		const kindMatch = content.match(/(TODO|FIXME|HACK|XXX):\s*(.*)/);
		if (!kindMatch) continue;
		items.push({
			file,
			line: parseInt(lineStr, 10),
			kind: kindMatch[1],
			text: kindMatch[2].trim(),
		});
	}
	return items;
}

function scanPlans(cwd: string): PlanFile[] {
	const plansDir = path.join(cwd, "docs", "plans");
	if (!fs.existsSync(plansDir)) return [];

	try {
		return fs.readdirSync(plansDir)
			.filter(f => f.endsWith(".md"))
			.sort()
			.map(name => {
				const content = fs.readFileSync(path.join(plansDir, name), "utf-8");
				const titleMatch = content.match(/^#\s+(.+)/m);
				const title = titleMatch ? titleMatch[1] : name;
				const totalTasks = (content.match(/- \[[ x]\]/g) || []).length;
				const doneTasks = (content.match(/- \[x\]/gi) || []).length;
				const progress = totalTasks > 0 ? `${doneTasks}/${totalTasks} tasks done` : "no tasks";
				return {
					name,
					excerpt: `${title} (${progress})\n${content.slice(0, 500)}`,
				};
			});
	} catch {
		return [];
	}
}

function scanReadme(cwd: string): string | null {
	for (const name of ["README.md", "readme.md", "Readme.md"]) {
		const p = path.join(cwd, name);
		if (fs.existsSync(p)) {
			try {
				return fs.readFileSync(p, "utf-8").slice(0, 2000);
			} catch {
				return null;
			}
		}
	}
	return null;
}

function scanStructure(cwd: string): string[] {
	const result: string[] = [];

	function walk(dir: string, depth: number, prefix: string) {
		if (depth > 3) return;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return;
		}
		const filtered = entries
			.filter(e => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "build" && e !== "__pycache__")
			.sort();

		for (const entry of filtered) {
			const full = path.join(dir, entry);
			const rel = `${prefix}${entry}`;
			try {
				const stat = fs.statSync(full);
				if (stat.isDirectory()) {
					result.push(`${rel}/`);
					walk(full, depth + 1, `${rel}/`);
				} else {
					result.push(rel);
				}
			} catch {
				result.push(rel);
			}
		}
	}

	walk(cwd, 0, "");
	return result.slice(0, 200);
}

function scanPackage(cwd: string): PackageInfo | null {
	const pkgPath = path.join(cwd, "package.json");
	if (!fs.existsSync(pkgPath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return {
			name: raw.name || "unknown",
			description: raw.description,
			scripts: raw.scripts,
		};
	} catch {
		return null;
	}
}

export function formatSnapshot(snapshot: ProjectSnapshot): string {
	const sections: string[] = [];

	if (snapshot.gitBranch) {
		sections.push(`**Current branch:** ${snapshot.gitBranch}`);
	}

	if (snapshot.packageInfo) {
		let pkg = `**Project:** ${snapshot.packageInfo.name}`;
		if (snapshot.packageInfo.description) pkg += ` — ${snapshot.packageInfo.description}`;
		if (snapshot.packageInfo.scripts) {
			const scripts = Object.keys(snapshot.packageInfo.scripts).join(", ");
			pkg += `\n**Scripts:** ${scripts}`;
		}
		sections.push(pkg);
	}

	if (snapshot.readme) {
		const excerpt = snapshot.readme.split("\n").slice(0, 10).join("\n");
		sections.push(`**README (excerpt):**\n${excerpt}`);
	}

	if (snapshot.recentCommits.length > 0) {
		const commits = snapshot.recentCommits.slice(0, 20).map(c => `  ${c}`).join("\n");
		sections.push(`**Recent commits (last 2 weeks):**\n${commits}`);
	} else {
		sections.push("**Recent commits:** none in last 2 weeks");
	}

	if (snapshot.gitDiffStat) {
		sections.push(`**Change activity (last 10 commits):**\n${snapshot.gitDiffStat}`);
	}

	if (snapshot.todos.length > 0) {
		const todoLines = snapshot.todos.slice(0, 25).map(t =>
			`  ${t.kind}: ${t.text} (${t.file}:${t.line})`
		).join("\n");
		sections.push(`**Outstanding TODOs/FIXMEs (${snapshot.todos.length} total):**\n${todoLines}`);
	}

	if (snapshot.planFiles.length > 0) {
		const planSummaries = snapshot.planFiles.map(p => `### ${p.name}\n${p.excerpt}`).join("\n\n");
		sections.push(`**Existing plans:**\n\n${planSummaries}`);
	}

	if (snapshot.structure.length > 0) {
		const topLevel = snapshot.structure.filter(s => !s.includes("/") || s.endsWith("/")).slice(0, 30);
		sections.push(`**Project structure (top-level):**\n${topLevel.map(s => `  ${s}`).join("\n")}`);
	}

	return sections.join("\n\n---\n\n");
}
