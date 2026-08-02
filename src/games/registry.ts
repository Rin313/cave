import type { GameDef } from "../core/sim.ts";
import { cave } from "./cave.ts";

export const GAMES: Record<string, GameDef> = {
	[cave.id]: cave,
};

export function getGame(id: string): GameDef {
	const def = GAMES[id];
	if (!def) throw new Error(`未知游戏：${id}（可用：${Object.keys(GAMES).join(", ")}）`);
	return def;
}

/** 缺省游戏：注册表的第一个条目（tools 未显式 --game 时的兜底，不再硬编码具体游戏 id）。 */
export function getDefaultGameId(): string {
	const keys = Object.keys(GAMES);
	if (!keys.length) throw new Error("没有注册任何游戏");
	return keys[0];
}
