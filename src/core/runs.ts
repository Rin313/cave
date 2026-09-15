import { existsSync, readdirSync, statSync } from "node:fs";
import { openArchive } from "./archive.ts";
import { Engine, type AgentSpec } from "./engine.ts";
import { loadGame } from "./games.ts";
import { recordsPath, runsDir } from "./paths.ts";

/** 存档目录的派生清单：runs/<game>/<run>/records.jsonl。 */
export interface RunFace {
	game: string;
	run: string;
	mtime: number;
}

/** 枚举存档（按记录文件 mtime 降序）；game 缺席即扫全部游戏目录。 */
export function listRuns(root: string, game?: string): RunFace[] {
	const base = runsDir(root);
	const games = game !== undefined
		? [game]
		: existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
	const out: RunFace[] = [];
	for (const g of games) {
		const dir = runsDir(root, g);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const records = recordsPath(g, entry.name, root);
			if (!existsSync(records)) continue;
			const stat = statSync(records);
			out.push({ game: g, run: entry.name, mtime: stat.mtimeMs });
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

export interface OpenRunOptions {
	/** 根：runs 与 agentDir 的所在。 */
	root: string;
	/** 游戏查找链（先见者遮蔽）。 */
	gameRoots: readonly string[];
	/** 模型与凭据的解析由宿主注入；只在 act/narrate 建会话时调用。 */
	agent: () => Promise<AgentSpec>;
}

/** 装载（或新建）一次运行；世界与档案就绪，模型到建会话时才解析。 */
export async function openRun(game: string, run: string, options: OpenRunOptions): Promise<Engine> {
	return Engine.create(await loadGame(game, options.gameRoots), {
		agent: options.agent,
		agentDir: options.root,
		archive: openArchive(recordsPath(game, run, options.root)),
	});
}
