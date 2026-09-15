import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function rootDir(hostRoot?: string): string {
	if (hostRoot !== undefined) return hostRoot;
	const base = process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
		: process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
		: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "cave");
}

/** 路径段：id 不做路径解析。 */
export function isSegment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

export function runsDir(root = rootDir(), game?: string): string {
	const base = join(root, "runs");
	return game === undefined ? base : join(base, game);
}

export function recordsPath(game: string, run: string, root = rootDir()): string {
	return join(runsDir(root, game), run, "records.jsonl");
}

export function readJsonObject(file: string): { value: Record<string, unknown> | null; error?: string } | null {
	if (!existsSync(file)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { value: null, error: `解析失败（${file}）：${String(e)}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, error: `须为 JSON 对象（${file}）` };
	return { value: parsed as Record<string, unknown> };
}

export function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}
