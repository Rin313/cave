import { execSync } from "node:child_process";

/** 修复 Windows GB2312 控制台读取 UTF-8 输出导致的乱码。 */
export function fixConsole(): void {
	if (process.platform === "win32") {
		try {
			execSync("chcp 65001 >nul");
		} catch {
			/* 非交互终端可能失败，忽略 */
		}
	}
}

export interface ParsedArgs {
	flags: Map<string, string | boolean>;
	positionals: string[];
}

/** 解析 argv：`--key value` / `--key=value` / `--flag`（布尔）；其余为位置参数。 */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const eq = key.indexOf("=");
			if (eq >= 0) {
				flags.set(key.slice(0, eq), key.slice(eq + 1));
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(key, next);
				i++;
			} else {
				flags.set(key, true);
			}
		} else {
			positionals.push(a);
		}
	}
	return { flags, positionals };
}

export function flagStr(a: ParsedArgs, name: string): string | undefined {
	const v = a.flags.get(name);
	return typeof v === "string" ? v : undefined;
}

/** 必填参数：缺失即报错（tool 层不提供隐藏默认值）。 */
export function requireFlag(a: ParsedArgs, name: string, usage: string): string {
	const v = flagStr(a, name);
	if (!v) throw new Error(`缺少必填参数 --${name}；${usage}`);
	return v;
}

export function flagBool(a: ParsedArgs, name: string): boolean {
	return a.flags.get(name) !== undefined;
}

/** JSON 输出（UTF-8）。 */
export function out(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
