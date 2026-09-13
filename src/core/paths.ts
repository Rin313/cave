import { homedir } from "node:os";
import { join } from "node:path";

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
