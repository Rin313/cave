import { join } from "node:path";
import { SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { openArchive } from "../core/archive.ts";
import { Engine } from "../core/engine.ts";
import { getGame } from "../games/registry.ts";

/** 一次运行的全部落盘位置；终端与 shell 两宿主共用同一约定。 */
export interface RunPaths {
	dir: string;
	records: string;
	session: string;
	transcript: string;
}

export function runPaths(game: string, run: string): RunPaths {
	const dir = join("runs", game, run);
	return {
		dir,
		records: join(dir, "records.jsonl"),
		session: join(dir, "session.jsonl"),
		transcript: join(dir, "transcript.jsonl"),
	};
}

/** 引擎配置按游戏 id 命名空间读取环境变量，多游戏并存互不覆盖。 */
export function engineOptions(game: string): { provider: string; model: string; thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"] } {
	const prefix = game.toUpperCase();
	const provider = process.env[`${prefix}_PROVIDER`];
	const model = process.env[`${prefix}_MODEL`];
	if (!provider || !model) throw new Error(`模型未配置：请设置 ${prefix}_PROVIDER 与 ${prefix}_MODEL 环境变量`);
	const thinkingLevel = process.env[`${prefix}_THINKING`] as CreateAgentSessionOptions["thinkingLevel"] | undefined;
	return { provider, model, ...(thinkingLevel !== undefined && { thinkingLevel }) };
}

/** 装载（或新建）一次运行：records 是证据、pi 会话是原始 trace，都按同一 run 位置续写。 */
export function openRun(game: string, run: string): Promise<Engine> {
	const paths = runPaths(game, run);
	return Engine.create(getGame(game), {
		...engineOptions(game),
		archive: openArchive(paths.records),
		sessionManager: SessionManager.open(paths.session),
	});
}
