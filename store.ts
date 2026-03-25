/**
 * Sprint storage — persists sprint history per project.
 *
 * Stores sprint records in ~/.pi/sprint/{hash}.json
 * The markdown report file is the primary source of truth for task progress.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SprintTask } from "./parser.js";

export interface SprintRecord {
	id: string;
	createdAt: number;
	title: string;
	status: "pending" | "accepted" | "executing" | "paused" | "completed" | "rejected" | "failed";
	proposal: string;
	critique: string | null;
	synthesis: string;
	snapshotSummary: string;
	tasks: SprintTask[];
	currentTaskIndex: number;
	reportPath?: string;
}

interface SprintFile {
	version: 2;
	sprints: SprintRecord[];
}

export function sprintStoragePath(cwd: string): string {
	const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return path.join(os.homedir(), ".pi", "sprint", `${hash}.json`);
}

export function loadSprints(storagePath: string): SprintRecord[] {
	if (!fs.existsSync(storagePath)) return [];
	try {
		const raw = JSON.parse(fs.readFileSync(storagePath, "utf-8")) as Partial<SprintFile>;
		return Array.isArray(raw.sprints) ? raw.sprints : [];
	} catch {
		return [];
	}
}

export function saveSprints(storagePath: string, sprints: SprintRecord[]): void {
	const dir = path.dirname(storagePath);
	fs.mkdirSync(dir, { recursive: true });
	const payload: SprintFile = { version: 2, sprints };
	const tmp = `${storagePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
	fs.renameSync(tmp, storagePath);
}

/** Save a single sprint record (find by id and update, or append). */
export function saveSprint(storagePath: string, record: SprintRecord): void {
	const sprints = loadSprints(storagePath);
	const idx = sprints.findIndex((s) => s.id === record.id);
	if (idx >= 0) {
		sprints[idx] = record;
	} else {
		sprints.unshift(record);
	}
	saveSprints(storagePath, sprints);
}

/** Find the most recent paused or executing sprint. */
export function findResumableSprint(storagePath: string): SprintRecord | null {
	const sprints = loadSprints(storagePath);
	return sprints.find((s) => s.status === "paused" || s.status === "executing") || null;
}
