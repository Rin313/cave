import { join } from "node:path";
import { readJsonObject, writeJson } from "./paths.ts";

/** 设置：用户级全局（凭据、模型与界面偏好），与 CLI 共用 */
export type Settings = Record<string, unknown>;

export function settingsPath(config: string): string {
	return join(config, "settings.json");
}

/** 单文件读取：缺席与破损都按空对象；破损显形于控制台。 */
function readLayer(file: string): Settings {
	const read = readJsonObject(file);
	if (read === null) return {};
	if (read.value !== null) return read.value;
	console.error(`设置文件不可读（按缺席处理）：${read.error}`);
	return {};
}

/** 合并态：defaults 靠前者优先，用户层最高（用户只存覆盖，分发缺省可随包更新）。 */
export function readSettings(config: string, defaults: readonly string[] = []): Settings {
	const merged: Settings = {};
	for (let i = defaults.length - 1; i >= 0; i--) Object.assign(merged, readLayer(defaults[i]!));
	return Object.assign(merged, readLayer(settingsPath(config)));
}

/** 用户层写补丁（分发缺省不固化）；返回写入后的合并态。 */
export function patchSettings(config: string, patch: Settings, defaults: readonly string[] = []): Settings {
	const user = Object.assign(readLayer(settingsPath(config)), patch);
	writeJson(settingsPath(config), user);
	return readSettings(config, defaults);
}

/** 字符串键：合并态中非字符串即未定（显式写入的错型值遮蔽缺省，不做回退）。 */
export function stringSetting(settings: Settings, key: string): string | undefined {
	const v = settings[key];
	return typeof v === "string" ? v : undefined;
}
