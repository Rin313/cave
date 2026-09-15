import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSegment, readJsonObject } from "./paths.ts";
import * as core from "./sim.ts";

/** 条目名按此序查找；游戏即 <root>/games 下的同名目录。 */
const ENTRIES = ["index.ts", "index.js", "index.mjs"];

/** id 是路径段：不做路径解析。 */
function gameFile(id: string, root: string): string | null {
	if (!isSegment(id)) return null;
	for (const name of ENTRIES) {
		const file = join(root, "games", id, name);
		if (existsSync(file)) return file;
	}
	return null;
}

/** 列出 <root>/games 下的可用游戏；id 升序。 */
export function listGames(root: string): string[] {
	const dir = join(root, "games");
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && gameFile(e.name, root) !== null)
		.map((e) => e.name)
		.sort();
}

export type GameMeta = Record<string, unknown>;

/** 读目录清单：缺失即空对象；坏元数据回落并携错；未知游戏即 null。 */
export function readGameMeta(id: string, root: string): { meta: GameMeta; error?: string } | null {
	const entry = gameFile(id, root);
	if (entry === null) return null;
	const parsed = readJsonObject(join(dirname(entry), "game.json"));
	if (parsed === null) return { meta: {} };
	if (parsed.value === null) return { meta: {}, error: `游戏元数据${parsed.error}` };
	return { meta: parsed.value };
}

/** 装载游戏实例：default 为 GameDef 或 (core) => GameDef 工厂。模块缓存按进程：改文件后须重启进程（CLI 每命令新进程，壳重启即生效）。 */
export async function loadGame(id: string, root: string): Promise<core.GameDef> {
	const file = gameFile(id, root);
	if (file === null) throw new Error(`未知游戏：${id}（可用：${listGames(root).join(", ") || "无"}）`);
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
