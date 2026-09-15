import { statSync } from "node:fs";
import { openArchive } from "./archive.ts";
import { Engine, type AgentSpec } from "./engine.ts";
import { loadGame } from "./games.ts";
import { recordsPath, runsDir, subdirs } from "./paths.ts";

/** 存档目录的派生清单：runs/<game>/<run>/records.jsonl。 */
export interface RunFace {
	game: string;
	run: string;
	mtime: number;
}

/** 枚举存档（按记录文件 mtime 降序）；game 缺席即扫全部游戏目录。 */
export function listRuns(root: string, game?: string): RunFace[] {
	const games = game !== undefined ? [game] : subdirs(runsDir(root));
	const out: RunFace[] = [];
	for (const g of games) {
		for (const run of subdirs(runsDir(root, g))) {
			const stat = statSync(recordsPath(root, g, run), { throwIfNoEntry: false });
			if (stat === undefined) continue;
			out.push({ game: g, run, mtime: stat.mtimeMs });
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** 装载（或新建）一次运行；世界与档案就绪，模型到建会话时才解析。 */
export async function openRun(root: string, game: string, run: string, agent: () => Promise<AgentSpec>): Promise<Engine> {
	return Engine.create(await loadGame(root, game), {
		agent,
		agentDir: root,
		archive: openArchive(recordsPath(root, game, run)),
	});
}
