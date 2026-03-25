/**
 * Roadmap generator — creates a 30-sprint dependency tree via debate.
 *
 * Structure: 3 tiers of 10 sprints each
 *   Tier 1 (foundational):  10 independent sprints — no dependencies
 *   Tier 2 (building):      10 sprints — each depends on 1-3 Tier 1 sprints
 *   Tier 3 (capstone):      10 sprints — each depends on 1-3 Tier 1/2 sprints
 *
 * Output: individual markdown files in <project>/sprints/planned/
 *   Each file has frontmatter with id, title, tier, depends-on, status.
 *
 * Also generates an index file: <project>/sprints/planned/index.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannedSprint {
	id: string;
	title: string;
	tier: 1 | 2 | 3;
	dependsOn: string[];
	goal: string;
	tasks: string;
	rationale: string;
	estimate: string;
	status: "planned" | "in-progress" | "done";
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildRoadmapProposalPrompt(snapshot: string, userGoal: string | null): string {
	const goalDirective = userGoal
		? `The user has specified this high-level vision:\n\n> ${userGoal}\n\nDesign the entire roadmap around this vision.`
		: `Based on the project state, design a comprehensive roadmap for the next ~60 weeks of development.`;

	return `You are creating a long-term sprint roadmap for a team of 4-6 high-performing staff engineers.

**What a sprint is:** A sprint is a **2-week cycle** delivering a **major feature milestone** — an entire subsystem, a complete end-to-end feature, or an architectural transformation. NOT a small task list. Each sprint should represent a significant, shippable capability that moves the product forward.

**Scale reference:**
- TOO SMALL: "Add a linter", "Create error types", "Add a route" — these are tasks within a sprint, not sprints themselves
- RIGHT SIZE: "Real-Time Collaboration Engine", "Complete Git-Aware Development Workflow", "Multi-Provider AI Backend with Streaming", "Production Packaging and Distribution Pipeline"

## Project State

${snapshot}

## Your Task

${goalDirective}

Create exactly 30 sprints organized in 3 tiers:

### Tier 1: Foundation (sprints 1-10)
Independent, parallelizable sprints. Each delivers a **complete, major capability** on its own. These are the big foundational systems the product needs — infrastructure, core subsystems, architectural foundations.

### Tier 2: Building (sprints 11-20)
Each depends on 1-3 Tier 1 sprints. These build **major product features** on top of the foundation — end-to-end user-facing capabilities that combine multiple subsystems.

### Tier 3: Capstone (sprints 21-30)
Each depends on 1-3 earlier sprints. These deliver **advanced capabilities, platform features, and production readiness** — the things that turn a working prototype into a shippable product.

## Output Format

For EACH sprint, produce this exact format (repeat 30 times):

---
**Sprint ID:** S01
**Title:** [compelling name for a major initiative]
**Tier:** 1
**Depends On:** none
**Estimate:** 2 weeks (4-6 engineers)
**Goal:** [one paragraph — what major capability ships and why it matters]
**Rationale:** [why this is sprint-sized, why at this tier, what it enables]
**Tasks:**
1. [substantial task — 1-3 engineer-days, with file/module references]
2. [substantial task]
...
(10-20 tasks per sprint, each staff-engineer-sized)
---

For Tier 2/3, Depends On should list sprint IDs like: S01, S03

IMPORTANT:
- Sprint IDs must be S01 through S30
- Tier 1: S01-S10 (no dependencies)
- Tier 2: S11-S20 (depend only on S01-S10)
- Tier 3: S21-S30 (depend on any earlier sprint)
- Each sprint = 2 weeks, 4-6 staff engineers, delivering a MAJOR capability
- Tasks within a sprint should be 1-3 engineer-days each, not hours
- Be specific: reference actual files, modules, patterns from the codebase
- Dependencies must be logical (a sprint should actually need its dependency)
- A sprint that could be done in a day by one person is TOO SMALL — combine related work into bigger initiatives`;
}

export function buildRoadmapCritiquePrompt(snapshot: string, proposal: string): string {
	return `Independently verify this 30-sprint roadmap. Each sprint should be a 2-week initiative for 4-6 staff engineers.

## Project State

${snapshot}

## Proposed Roadmap

${proposal}

## Your Task

Do NOT just comment on what the proposer wrote. Investigate the actual codebase to verify their claims:

1. **Verify file references** — Read the files and modules mentioned. Do they exist? Are they described accurately?
2. **Check dependencies** — For each sprint dependency, read the actual code to confirm the dependency is real. Are any missing?
3. **Find gaps** — Scan the codebase for areas the proposer didn't cover. Are there important modules, features, or debt that should be on the roadmap?
4. **Validate scale** — Based on the actual code complexity you see, are sprints right-sized for 2 weeks × 4-6 engineers? Flag undersized ones for merging.
5. **Verify tier placement** — Read the code to confirm foundation sprints are truly independent.

Your default stance is to approve. Only flag issues backed by evidence from the codebase.

Conclude with: **APPROVED** or list specific evidence-backed changes needed.`;
}

export function buildRoadmapSynthesisPrompt(snapshot: string, proposal: string, critique: string): string {
	return `Incorporate review feedback into a final 30-sprint roadmap. Each sprint is a 2-week cycle for 4-6 staff engineers.

## Project State

${snapshot}

## Original Roadmap

${proposal}

## Review Feedback

${critique}

## Your Task

Produce the FINAL roadmap with exactly 30 sprints. Address valid feedback — especially merge any undersized sprints into larger, more ambitious ones.

**Quality bar:** Every sprint must deliver a MAJOR, shippable capability. If a reviewer flagged something as too small, merge it with related work into a bigger initiative. "Add a linter" + "Set up CI" + "Improve test coverage" = one sprint: "Developer Tooling and Quality Infrastructure".

Keep the same ID scheme (S01-S30), tier structure, and format:

---
**Sprint ID:** S01
**Title:** [major initiative name]
**Tier:** [1|2|3]
**Depends On:** [none | S01, S03, ...]
**Estimate:** 2 weeks (4-6 engineers)
**Goal:** [paragraph — what major capability ships]
**Rationale:** [paragraph]
**Tasks:**
1. [staff-engineer-sized task, 1-3 days]
2. [staff-engineer-sized task, 1-3 days]
...
(10-20 tasks per sprint)
---`;
}

// ---------------------------------------------------------------------------
// Parser — extract sprints from LLM output
// ---------------------------------------------------------------------------

export function parseRoadmapSprints(output: string): PlannedSprint[] {
	const sprints: PlannedSprint[] = [];

	// Split by sprint blocks — look for **Sprint ID:** markers
	const blocks = output.split(/(?=\*\*Sprint ID:\*\*\s*S\d+)/i);

	for (const block of blocks) {
		const idMatch = block.match(/\*\*Sprint ID:\*\*\s*(S\d+)/i);
		if (!idMatch) continue;

		const id = idMatch[1].toUpperCase();
		const titleMatch = block.match(/\*\*Title:\*\*\s*(.+)/i);
		const tierMatch = block.match(/\*\*Tier:\*\*\s*(\d)/i);
		const depsMatch = block.match(/\*\*Depends On:\*\*\s*(.+)/i);
		const estimateMatch = block.match(/\*\*Estimate:\*\*\s*(.+)/i);
		const goalMatch = block.match(/\*\*Goal:\*\*\s*([\s\S]*?)(?=\*\*Rationale:|\*\*Tasks:|$)/i);
		const rationaleMatch = block.match(/\*\*Rationale:\*\*\s*([\s\S]*?)(?=\*\*Tasks:|$)/i);
		const tasksMatch = block.match(/\*\*Tasks:\*\*\s*([\s\S]*?)(?=---|$)/i);

		const title = titleMatch?.[1]?.trim() || id;
		const tierNum = parseInt(tierMatch?.[1] || "1", 10);
		const tier = (tierNum >= 1 && tierNum <= 3 ? tierNum : 1) as 1 | 2 | 3;

		const depsRaw = depsMatch?.[1]?.trim() || "none";
		const dependsOn = depsRaw.toLowerCase() === "none"
			? []
			: depsRaw.match(/S\d+/gi)?.map((s) => s.toUpperCase()) || [];

		sprints.push({
			id,
			title,
			tier,
			dependsOn,
			goal: goalMatch?.[1]?.trim() || "",
			rationale: rationaleMatch?.[1]?.trim() || "",
			tasks: tasksMatch?.[1]?.trim() || "",
			estimate: estimateMatch?.[1]?.trim() || "2 weeks (4-6 engineers)",
			status: "planned",
		});
	}

	return sprints;
}

// ---------------------------------------------------------------------------
// File generation — write individual sprint files + index
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

function sprintFilename(sprint: PlannedSprint): string {
	return `${sprint.id.toLowerCase()}-${slugify(sprint.title)}.md`;
}

function generateSprintFile(sprint: PlannedSprint): string {
	const deps = sprint.dependsOn.length > 0 ? sprint.dependsOn.join(", ") : "none";
	return `---
id: ${sprint.id}
title: "${sprint.title.replace(/"/g, '\\"')}"
tier: ${sprint.tier}
depends-on: [${sprint.dependsOn.map((d) => `"${d}"`).join(", ")}]
estimate: "${sprint.estimate}"
status: ${sprint.status}
---

# ${sprint.id}: ${sprint.title}

**Tier:** ${sprint.tier} | **Depends On:** ${deps} | **Estimate:** ${sprint.estimate} | **Status:** ${sprint.status}

## Goal

${sprint.goal}

## Rationale

${sprint.rationale}

## Tasks

${sprint.tasks}
`;
}

function generateIndexFile(sprints: PlannedSprint[]): string {
	const lines: string[] = [];
	lines.push("# Sprint Roadmap");
	lines.push("");
	lines.push(`Generated: ${new Date().toLocaleString()}`);
	lines.push(`Total: ${sprints.length} sprints across 3 tiers`);
	lines.push("");

	// Dependency tree visualization
	lines.push("## Dependency Tree");
	lines.push("");
	lines.push("```");
	for (const tier of [1, 2, 3] as const) {
		const label = tier === 1 ? "Foundation" : tier === 2 ? "Building" : "Capstone";
		lines.push(`── Tier ${tier}: ${label} ──`);
		const tierSprints = sprints.filter((s) => s.tier === tier);
		for (const s of tierSprints) {
			const deps = s.dependsOn.length > 0 ? ` ← ${s.dependsOn.join(", ")}` : "";
			lines.push(`  ${s.id}: ${s.title}${deps}`);
		}
		lines.push("");
	}
	lines.push("```");
	lines.push("");

	// Table
	lines.push("## All Sprints");
	lines.push("");
	lines.push("| ID | Title | Tier | Depends On | Estimate | Status |");
	lines.push("|-----|-------|------|------------|----------|--------|");
	for (const s of sprints) {
		const deps = s.dependsOn.length > 0 ? s.dependsOn.join(", ") : "—";
		const file = sprintFilename(s);
		lines.push(`| [${s.id}](./${file}) | ${s.title} | ${s.tier} | ${deps} | ${s.estimate} | ${s.status} |`);
	}
	lines.push("");

	// Per-tier sections with links
	for (const tier of [1, 2, 3] as const) {
		const label = tier === 1 ? "Tier 1: Foundation" : tier === 2 ? "Tier 2: Building" : "Tier 3: Capstone";
		lines.push(`## ${label}`);
		lines.push("");
		const tierSprints = sprints.filter((s) => s.tier === tier);
		for (const s of tierSprints) {
			const file = sprintFilename(s);
			const deps = s.dependsOn.length > 0 ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
			lines.push(`- [${s.id}: ${s.title}](./${file})${deps}`);
			if (s.goal) {
				const excerpt = s.goal.split("\n")[0].slice(0, 120);
				lines.push(`  > ${excerpt}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

export function writeRoadmap(cwd: string, sprints: PlannedSprint[]): { dir: string; indexPath: string; count: number } {
	const dir = path.join(cwd, "sprints", "planned");
	fs.mkdirSync(dir, { recursive: true });

	// Write individual sprint files
	for (const sprint of sprints) {
		const filePath = path.join(dir, sprintFilename(sprint));
		fs.writeFileSync(filePath, generateSprintFile(sprint), "utf-8");
	}

	// Write index
	const indexPath = path.join(dir, "index.md");
	fs.writeFileSync(indexPath, generateIndexFile(sprints), "utf-8");

	return { dir, indexPath, count: sprints.length };
}
