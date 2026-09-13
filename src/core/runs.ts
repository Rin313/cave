import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDocsPath, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
import { openArchive } from "./archive.ts";
import { Engine } from "./engine.ts";
import { loadGame } from "./games.ts";
import { configDir, dataDir } from "./paths.ts";
import { errorText } from "./sim.ts";

/** 一次运行的落盘位置；root 即数据根。 */
export interface RunPaths {
	dir: string;
	records: string;
	session: string;
}

export function runPaths(game: string, run: string, root = dataDir()): RunPaths {
	const dir = join(root, "runs", game, run);
	return {
		dir,
		records: join(dir, "records.jsonl"),
		session: join(dir, "session.jsonl"),
	};
}

/** 存档目录的派生清单：runs/<game>/<run>/records.jsonl；无记录的目录不是存档。 */
export interface RunFace {
	game: string;
	run: string;
	turn?: number;
	time?: number;
	mtime: number;
}

/** 尾部读最后一条完好的回合记录（半行与损坏向更早回退）；取不到即省略。 */
function tailRecord(path: string, size: number): { turn: number; time: number } | null {
	const fd = openSync(path, "r");
	try {
		const start = Math.max(0, size - 64 * 1024);
		const buf = Buffer.alloc(size - start);
		const got = readSync(fd, buf, 0, buf.length, start);
		const lines = buf.subarray(0, got).toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]!.trim();
			if (line === "") continue;
			try {
				const v = JSON.parse(line) as { seq?: unknown; time?: unknown };
				if (Number.isInteger(v.seq) && typeof v.time === "number") return { turn: v.seq as number, time: v.time };
			} catch {
				// 半行或损坏：向更早回退
			}
		}
	} finally {
		closeSync(fd);
	}
	return null;
}

/** 枚举存档（按记录文件 mtime 降序）；game 缺席即扫全部游戏目录。 */
export function listRuns(root: string, game?: string): RunFace[] {
	const base = join(root, "runs");
	const games = game !== undefined
		? [game]
		: existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
	const out: RunFace[] = [];
	for (const g of games) {
		const dir = join(base, g);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const records = join(dir, entry.name, "records.jsonl");
			if (!existsSync(records)) continue;
			const stat = statSync(records);
			const tail = tailRecord(records, stat.size);
			out.push({ game: g, run: entry.name, ...(tail !== null && { turn: tail.turn, time: tail.time }), mtime: stat.mtimeMs });
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** 模型与凭据未就绪：宿主据此把用户引向配置面（文件、CLI 或壳暴露的配置协议）。 */
export class ModelConfigError extends Error {}

/** 模型是单一引用 `provider/model[:thinking]`：配置根的 settings.json 给缺省，环境变量按游戏 id 覆盖。 */
function modelReference(game: string, config: string): { ref: string; source: string } {
	const name = `${game.toUpperCase()}_MODEL`;
	const fromEnv = process.env[name];
	if (fromEnv) return { ref: fromEnv, source: name };
	const file = join(config, "settings.json");
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			const model = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { model?: unknown }).model : undefined;
			if (typeof model === "string" && model.trim() !== "") return { ref: model, source: file };
		} catch (e) {
			throw new Error(`settings.json 解析失败（${file}）：${errorText(e)}`);
		}
	}
	throw new ModelConfigError(`模型未配置：在 ${file} 写入 { "model": "provider/model[:thinking]" }，或设置 ${name} 环境变量`);
}

/** 凭据与模型表随用户级配置根自持：不读 pi agent 的 ~/.pi/agent，用户无需安装 pi agent 或 /login。 */
export function openModelRuntime(config: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(config, "auth.json"),
		modelsPath: join(config, "models.json"),
		modelsStorePath: join(config, "models-store.json"),
	});
}

/** SDK 的错误提示以 pi CLI 旗标收尾（--list-models/--provider），本项目的配置面没有这些旗标，只保留原因。 */
export function modelErrorReason(error: string | undefined): string {
	return (error ?? "未解析到模型").replace(/ Use --[\s\S]*$/, "");
}

export interface OpenRunOptions {
	/** 数据根：runs 的所在；缺省 dataDir()。 */
	root?: string;
	/** 游戏查找链（先见者遮蔽）；缺省 [root]。 */
	gameRoots?: readonly string[];
	/** 宿主共享的模型运行时（配置协议与引擎同源）；缺省新建。 */
	modelRuntime?: ModelRuntime;
}

/** 装载（或新建）一次运行：records 是证据、pi 会话是原始 trace，都按同一 run 位置续写；模型与凭据只在 act/narrate 建会话时解析。 */
export async function openRun(game: string, run: string, options: OpenRunOptions = {}): Promise<Engine> {
	const root = options.root ?? dataDir();
	const gameRoots = options.gameRoots ?? [root];
	const paths = runPaths(game, run, root);
	const config = configDir();
	const agent = async () => {
		const { ref, source } = modelReference(game, config);
		const modelRuntime = options.modelRuntime ?? (await openModelRuntime(config));
		const { model, thinkingLevel, warning, error } = resolveCliModel({ cliModel: ref, modelRuntime });
		if (!model || error) throw new ModelConfigError(`模型 "${ref}"（${source}）不可用：${modelErrorReason(error)}`);
		if (warning) console.warn(`⚠ ${warning}`);
		if (!(await modelRuntime.checkAuth(model.provider))) {
			throw new ModelConfigError(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(config, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
		}
		return { model, modelRuntime, ...(thinkingLevel !== undefined && { thinkingLevel }) };
	};
	return Engine.create(await loadGame(game, gameRoots), {
		agent,
		agentDir: config,
		archive: openArchive(paths.records),
		sessionManager: SessionManager.open(paths.session),
	});
}
