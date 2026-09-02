import type { GameDef } from "../core/sim.ts";
import type { ProbeSpec } from "./probe.ts";
import { village, villageProbe } from "./village.ts";
import { yume, yumeProbe } from "./yume.ts";

export const GAMES: Record<string, GameDef> = {
	[village.id]: village,
	[yume.id]: yume
};

/** 探测域索引：游戏 id → 该游戏的候选域声明 */
const PROBES: Record<string, ProbeSpec> = {
	[village.id]: villageProbe,
	[yume.id]: yumeProbe
};

export function getGame(id: string): GameDef {
	const def = GAMES[id];
	if (!def) throw new Error(`未知游戏：${id}（可用：${Object.keys(GAMES).join(", ")}）`);
	return def;
}

export function getProbe(id: string): ProbeSpec | undefined {
	return PROBES[id];
}
