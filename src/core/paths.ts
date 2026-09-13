import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 无宿主（CLI）时按平台约定复算 Electron userData。 */
function platformUserData(): string {
	if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "cave");
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "cave");
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cave");
}

/** 配置根：CAVE_CONFIG_DIR 覆盖；缺省取宿主的用户数据目录（Electron 传 app.getPath("userData")）。 */
export function configDir(userData?: string): string {
	return process.env.CAVE_CONFIG_DIR ?? userData ?? platformUserData();
}

/** 数据根：runs 与用户级内容（games、ui）的所在；CAVE_DATA_DIR 覆盖，缺省即配置根。 */
export function dataDir(userData?: string): string {
	return process.env.CAVE_DATA_DIR ?? configDir(userData);
}

/** 一次运行的落盘位置；root 即数据根。 */
export interface RunPaths {
	dir: string;
	records: string;
	session: string;
}

export function runPaths(game: string, run: string, root = dataDir()): RunPaths {
	const dir = join(root, "runs", game, run);
	return { dir, records: join(dir, "records.jsonl"), session: join(dir, "session.jsonl") };
}

/** JSON 对象文件读写：缺席、坏内容、非对象一律视同缺席；写侧建目录并带换行。 */
export function readJsonObject(file: string): Record<string, unknown> | null {
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}
