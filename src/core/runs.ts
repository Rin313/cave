import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDocsPath, ModelRuntime, resolveCliModel, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { openArchive, parseRecordLine } from "./archive.ts";
import { Engine } from "./engine.ts";
import { loadGame } from "./games.ts";
import { configDir, dataDir, recordsPath, runsDir } from "./paths.ts";
import { readSettings, settingsPath, stringSetting, type Settings } from "./settings.ts";

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
			const parsed = parseRecordLine(lines[i]!);
			if (parsed?.kind === "record") return { turn: parsed.record.seq, time: parsed.record.time };
		}
	} finally {
		closeSync(fd);
	}
	return null;
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
			const tail = tailRecord(records, stat.size);
			out.push({ game: g, run: entry.name, ...(tail !== null && { turn: tail.turn, time: tail.time }), mtime: stat.mtimeMs });
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** 模型与凭据未就绪：宿主据此把用户引向配置面（文件、CLI 或壳暴露的配置协议）。 */
export class ModelConfigError extends Error {}

/** 模型是单一引用 `provider/model[:thinking]`：合并设置（分发缺省 ← 用户层）给缺省，环境变量按游戏 id 覆盖。 */
function modelReference(game: string, settings: Settings, file: string, hasDefaults: boolean): { ref: string; source: string } {
	const name = `${game.toUpperCase()}_MODEL`;
	const fromEnv = process.env[name];
	if (fromEnv) return { ref: fromEnv, source: name };
	const ref = stringSetting(settings, "model");
	if (ref !== undefined && ref.trim() !== "") return { ref, source: hasDefaults ? `${file} 或分发缺省` : file };
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
function modelErrorReason(error: string | undefined): string {
	return (error ?? "未解析到模型").replace(/ Use --[\s\S]*$/, "");
}

/** 单一引用的解析结果：配置面校验与建会话共用同一入口与文案。 */
export type ModelResolution =
	| { ok: true; model: NonNullable<CreateAgentSessionOptions["model"]>; thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>; warning?: string }
	| { ok: false; reason: string };

export function resolveModelRef(ref: string, modelRuntime: ModelRuntime): ModelResolution {
	const { model, thinkingLevel, warning, error } = resolveCliModel({ cliModel: ref, modelRuntime });
	if (!model || error) return { ok: false, reason: modelErrorReason(error) };
	return { ok: true, model, ...(thinkingLevel !== undefined && { thinkingLevel }), ...(warning !== undefined && { warning }) };
}

export interface OpenRunOptions {
	/** 数据根：runs 的所在；缺省 dataDir()。 */
	root?: string;
	/** 游戏查找链（先见者遮蔽）；缺省 [root]。 */
	gameRoots?: readonly string[];
	/** 设置缺省层（靠前者优先，如随包分发的 settings.json）；与用户层合并后供模型引用读取。 */
	settingLayers?: readonly string[];
	/** 宿主共享的模型运行时（配置协议与引擎同源）；缺省新建。 */
	modelRuntime?: ModelRuntime;
}

/** 装载（或新建）一次运行。模型与凭据只在 act/narrate 建会话时解析，设置每次都重读。 */
export async function openRun(game: string, run: string, options: OpenRunOptions = {}): Promise<Engine> {
	const root = options.root ?? dataDir();
	const gameRoots = options.gameRoots ?? [root];
	const config = configDir();
	const file = settingsPath(config);
	const agent = async () => {
		const layers = options.settingLayers ?? [];
		const { ref, source } = modelReference(game, readSettings(config, layers), file, layers.length > 0);
		const modelRuntime = options.modelRuntime ?? (await openModelRuntime(config));
		const resolved = resolveModelRef(ref, modelRuntime);
		if (!resolved.ok) throw new ModelConfigError(`模型 "${ref}"（${source}）不可用：${resolved.reason}`);
		if (resolved.warning) console.warn(`⚠ ${resolved.warning}`);
		const { model, thinkingLevel } = resolved;
		if (!(await modelRuntime.checkAuth(model.provider))) {
			throw new ModelConfigError(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(config, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
		}
		return { model, modelRuntime, ...(thinkingLevel !== undefined && { thinkingLevel }) };
	};
	return Engine.create(await loadGame(game, gameRoots), {
		agent,
		agentDir: config,
		archive: openArchive(recordsPath(game, run, root)),
	});
}
