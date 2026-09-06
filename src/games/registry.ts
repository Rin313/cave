import type { GameDef } from "../core/sim.ts";
import { seals } from "./seals.ts";

export const GAMES: Record<string, GameDef> = {
	[seals.id]: seals,
};

export function getGame(id: string): GameDef {
	const def = GAMES[id];
	if (!def) throw new Error(`未知游戏：${id}（可用：${Object.keys(GAMES).join(", ")}）`);
	return def;
}
