import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameConfig } from "../core/types.ts";

const GAMES_DIR = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[a-z0-9_-]+$/;
const CONFIG_FILE_RE = /^([a-z0-9_-]+)\.config\.ts$/;

export async function listGameIds(): Promise<string[]> {
	const entries = await readdir(GAMES_DIR);
	return entries
		.filter((e) => CONFIG_FILE_RE.test(e))
		.map((e) => CONFIG_FILE_RE.exec(e)![1])
		.sort();
}

export async function loadGame(id: string): Promise<GameConfig> {
	if (!ID_RE.test(id)) throw new Error(`非法游戏 id: ${id}`);
	const mod = await import(`./${id}.config.ts`);
	const config = mod.default as GameConfig;
	if (!config || config.id !== id) {
		throw new Error(`游戏模块 ${id}.config.ts 未导出匹配的 default GameConfig（期望 id="${id}"）`);
	}
	return config;
}
