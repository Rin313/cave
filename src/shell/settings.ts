import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonObject } from "../core/paths.ts";

export type Settings = Record<string, unknown>;

export function settingsPath(root: string): string {
	return join(root, "settings.json");
}

/** 缺席与破损都按空对象；破损显形于控制台。 */
function readSettingsFile(file: string): Settings {
	const read = readJsonObject(file);
	if (read === null) return {};
	if (read.value !== null) return read.value;
	console.error(`设置文件不可读（按缺席处理）：${read.error}`);
	return {};
}

export function readSettings(root: string): Settings {
	return readSettingsFile(settingsPath(root));
}

/** 写补丁并返回写入后的设置。 */
export function patchSettings(root: string, patch: Settings): Settings {
	const file = settingsPath(root);
	const settings = Object.assign(readSettingsFile(file), patch);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	return settings;
}

/** 字符串键：非字符串即未定（不做回退）。 */
export function stringSetting(settings: Settings, key: string): string | undefined {
	const v = settings[key];
	return typeof v === "string" ? v : undefined;
}
