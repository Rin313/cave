import type { GameDef } from "../core/sim.ts";
import { village } from "./village.ts";
import { waste } from "./waste.ts";

export const GAMES: Record<string, GameDef> = {
	[village.id]: village,
	[waste.id]: waste
};

export function getGame(id: string): GameDef {
	const def = GAMES[id];
	if (!def) throw new Error(`未知游戏：${id}（可用：${Object.keys(GAMES).join(", ")}）`);
	return def;
}
