import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSegment, readJsonObject } from "./paths.ts";
import * as core from "./sim.ts";

/** 条目名按此序查找；id 即 <root>/games 下的目录名。 */
const ENTRIES = ["index.ts", "index.js", "index.mjs"];

/** id 是路径段：不做路径解析。 */
function gameFile(id: string, roots: readonly string[]): string | null {
	if (!isSegment(id)) return null;
	for (const root of roots) {
		for (const name of ENTRIES) {
			const file = join(root, "games", id, name);
			if (existsSync(file)) return file;
		}
	}
	return null;
}

/** 按 roots 顺序列出可用游戏，先见者遮蔽；id 升序。 */
export function listGames(roots: readonly string[]): string[] {
	const ids = new Set<string>();
	for (const root of roots) {
		const dir = join(root, "games");
		if (!existsSync(dir)) continue;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory() && !ids.has(e.name) && gameFile(e.name, [root]) !== null) ids.add(e.name);
		}
	}
	return [...ids].sort();
}

export type GameMeta = Record<string, unknown>;

/** 读目录清单：缺失即空对象；坏元数据回落并携错；未知游戏即 null。 */
export function readGameMeta(id: string, roots: readonly string[]): { meta: GameMeta; error?: string } | null {
	const entry = gameFile(id, roots);
	if (entry === null) return null;
	const parsed = readJsonObject(join(dirname(entry), "game.json"));
	if (parsed === null) return { meta: {} };
	if (parsed.value === null) return { meta: {}, error: `游戏元数据${parsed.error}` };
	return { meta: parsed.value };
}

/** 装载游戏实例：default 为 GameDef 或 (core) => GameDef 工厂。模块缓存按进程：改文件后须重启进程（CLI 每命令新进程，壳重启即生效）。 */
export async function loadGame(id: string, roots: readonly string[]): Promise<core.GameDef> {
	const file = gameFile(id, roots);
	if (file === null) throw new Error(`未知游戏：${id}（可用：${listGames(roots).join(", ") || "无"}）`);
	let mod: { default?: unknown };
	try {
		mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
	} catch (e) {
		throw new Error(`游戏 ${id} 装载失败（${file}）：${String(e)}`);
	}
	const def = typeof mod.default === "function" ? (mod.default as (sim: typeof core) => core.GameDef)(core) : mod.default;
	if (def === null || typeof def !== "object") throw new Error(`游戏 ${id} 未导出 GameDef（${file}）`);
	return def as core.GameDef;
}
