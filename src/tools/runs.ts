import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDocsPath, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
import { openArchive } from "../core/archive.ts";
import { Engine } from "../core/engine.ts";
import { errorText } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";

/** 一次运行的全部落盘位置；终端与 shell 两宿主共用同一约定。root 即数据根：终端用 cwd，打包的 shell 用 userData。 */
export interface RunPaths {
	dir: string;
	records: string;
	session: string;
	transcript: string;
}

export function runPaths(game: string, run: string, root = "."): RunPaths {
	const dir = join(root, "runs", game, run);
	return {
		dir,
		records: join(dir, "records.jsonl"),
		session: join(dir, "session.jsonl"),
		transcript: join(dir, "transcript.jsonl"),
	};
}

/** 用户级配置根：凭据、模型表与偏好跨项目/宿主共用（与 Electron userData 同径）；运行数据仍按数据根。 */
export function configDir(): string {
	const override = process.env.CAVE_CONFIG_DIR;
	if (override) return override;
	if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "cave");
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "cave");
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cave");
}

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
	throw new Error(`模型未配置：在 ${file} 写入 { "model": "provider/model[:thinking]" }，或设置 ${name} 环境变量`);
}

/** 凭据与模型表随用户级配置根自持：不读 pi agent 的 ~/.pi/agent，用户无需安装 pi agent 或 /login。 */
function openModelRuntime(config: string): Promise<ModelRuntime> {
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

/** 装载（或新建）一次运行：records 是证据、pi 会话是原始 trace，都按同一 run 位置续写。 */
export async function openRun(game: string, run: string, root = "."): Promise<Engine> {
	const paths = runPaths(game, run, root);
	const config = configDir();
	const { ref, source } = modelReference(game, config);
	const modelRuntime = await openModelRuntime(config);
	const { model, thinkingLevel, warning, error } = resolveCliModel({ cliModel: ref, modelRuntime });
	if (!model || error) throw new Error(`模型 "${ref}"（${source}）不可用：${modelErrorReason(error)}`);
	if (warning) console.warn(`⚠ ${warning}`);
	if (!(await modelRuntime.checkAuth(model.provider))) {
		throw new Error(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(config, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
	}
	return Engine.create(getGame(game), {
		model,
		modelRuntime,
		agentDir: config,
		...(thinkingLevel !== undefined && { thinkingLevel }),
		archive: openArchive(paths.records),
		sessionManager: SessionManager.open(paths.session),
	});
}
