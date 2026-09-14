import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 无宿主（CLI）时按平台约定复算 Electron userData：目录名即应用名，须与 app.name（package.json 的 productName ?? name）一致。 */
function platformUserData(): string {
	const base = process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
		: process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
		: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "cave");
}

/** 配置根：ENGINE_CONFIG_DIR 覆盖；缺省取宿主的用户数据目录（Electron 传 app.getPath("userData")）。 */
export function configDir(userData?: string): string {
	return process.env.ENGINE_CONFIG_DIR ?? userData ?? platformUserData();
}

/** 数据根：runs 与用户级内容（games、ui）的所在；ENGINE_DATA_DIR 覆盖，缺省即配置根。 */
export function dataDir(userData?: string): string {
	return process.env.ENGINE_DATA_DIR ?? configDir(userData);
}

export function recordsPath(game: string, run: string, root = dataDir()): string {
	return join(root, "runs", game, run, "records.jsonl");
}

/** JSON 对象文件：缺席返回 null；坏内容与非对象返回 value=null 与错误文本（自带位置）。 */
export function readJsonObject(file: string): { value: Record<string, unknown> | null; error?: string } | null {
	if (!existsSync(file)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { value: null, error: `解析失败（${file}）：${String(e)}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, error: `须为 JSON 对象（${file}）` };
	return { value: parsed as Record<string, unknown> };
}

export function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}
