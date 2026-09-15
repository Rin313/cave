import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 路径段：id 不做路径解析。 */
export function isSegment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

export function runsDir(root: string, game?: string): string {
	const base = join(root, "runs");
	return game === undefined ? base : join(base, game);
}

export function recordsPath(root: string, game: string, run: string): string {
	return join(runsDir(root, game), run, "records.jsonl");
}

/** 目录下的直接子目录名；目录缺席即空。 */
export function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** 读 JSON 对象：缺席与破损都按空对象；破损原因不含文件名，由调用方补全语境。 */
export function readJsonObject(file: string): { value: Record<string, unknown>; error?: string } {
	if (!existsSync(file)) return { value: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { value: {}, error: `JSON 解析失败：${String(e)}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: {}, error: "须为 JSON 对象" };
	return { value: parsed as Record<string, unknown> };
}
