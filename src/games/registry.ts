import type { GameDef } from "../core/sim.ts";
import { cave } from "./cave.ts";
import { wuxia } from "./wuxia.ts";

export const GAMES: Record<string, GameDef> = {
	[cave.id]: cave,
	[wuxia.id]: wuxia,
};

export function getGame(id: string): GameDef {
	const def = GAMES[id];
	if (!def) throw new Error(`未知游戏：${id}（可用：${Object.keys(GAMES).join(", ")}）`);
	return def;
}
