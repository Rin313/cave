// GUI e2e host：启动 Electron 壳（缺省 dev，--exe 指定打包产物），经 CDP 调 window.cave 的 IPC 面；数据根（--data-dir 或 CAVE_DATA_DIR，缺省用户数据目录）承载游戏、界面与会话证据，验证靠阅读会话。e2e 模型经 <GAME>_MODEL 或 settings.json 指定。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dataDir } from "../core/paths.ts";
import { flagStr, parseArgs, runMain } from "./cli.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const USAGE = `用法：gui <命令> [参数] [--exe <打包可执行文件>] [--data-dir <目录>] [--timeout <秒>]
  games
  def <game>
  meta <game>
  state <game> <run>
  records <game> <run>
  act <game> <run> <话语...>
  batch <game> <run> <话语文件>     （每行一条，空行与 # 注释跳过）
  narrate <game> <run> <指令...>
缺省以 dev Electron 启动本仓库；--exe 驱动打包产物；数据根取 --data-dir，缺省 CAVE_DATA_DIR 或用户数据目录。`;

interface Target {
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

interface CdpReply {
	id?: number;
	result?: {
		result?: { value?: unknown };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	};
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface RunFace {
	game: string;
	run: string;
	turn: number;
	time: number;
	view: unknown;
	warnings?: string[];
}

interface RecordsFace {
	broken: number;
	records: unknown[];
}

interface ActFace extends RunFace {
	lines: string[];
	reveals: unknown[];
	narration: string;
	warnings: string[];
	usage: Usage[];
}

interface NarrateFace {
	narration: string;
	warnings: string[];
	usage: Usage[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const js = (v: unknown): string => JSON.stringify(v);
const openExpr = (game: string, run: string): string => `window.cave.open(${js(game)},${js(run)})`;

/** dev 启动要求存在界面；仓库不带界面资产，数据根无界面时自动补一个 stub，命令结束即移除。 */
function ensureStubUi(dataRoot: string): string | null {
	const root = join(dataRoot, "ui");
	const found = existsSync(root) && readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(root, e.name, "index.html")));
	if (found) return null;
	const dir = join(root, "e2e");
	const file = join(dir, "index.html");
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, "<!doctype html><title>e2e</title>\n", "utf8");
	console.error(`已创建 e2e stub 界面：${file}`);
	return file;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = addr !== null && typeof addr === "object" ? addr.port : 0;
			server.close(() => (port > 0 ? resolve(port) : reject(new Error("无法分配调试端口"))));
		});
	});
}

interface App {
	target: Target;
	stop: () => void;
}

async function openApp(exe: string, dev: boolean, dataRoot: string): Promise<App> {
	const port = await freePort();
	const flags = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"];
	const child = spawn(exe, dev ? [REPO_ROOT, ...flags] : flags, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CAVE_DATA_DIR: dataRoot } });
	let err = "";
	child.stderr?.on("data", (d: Buffer) => { err += String(d); });
	const stop = (): void => { child.kill(); };
	process.once("exit", stop);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Electron 退出（code ${child.exitCode}${child.exitCode === 0 ? "，可能已有实例在运行（单实例锁）" : ""}）：${err.trim()}`);
		try {
			const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as unknown;
			if (Array.isArray(list)) {
				const target = (list as Target[]).find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
				if (target !== undefined) return { target, stop };
			}
		} catch {
			// 界面尚未就绪
		}
		await sleep(150);
	}
	stop();
	throw new Error(`等待界面超时（30s）：需在数据根 ui/<name>/index.html 提供界面，打包另可在 resources/ui${err.trim() === "" ? "" : `\n${err.trim()}`}`);
}

async function evaluate(target: Target, expression: string, timeoutMs: number): Promise<unknown> {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("CDP 连接失败"));
	});
	try {
		const id = 1;
		const reply = await new Promise<CdpReply>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`CDP 求值超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
			ws.onmessage = (e) => {
				const m = JSON.parse(String(e.data)) as CdpReply;
				if (m.id !== id) return;
				clearTimeout(timer);
				resolve(m);
			};
			ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP 通道中断")); };
			ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
		});
		const details = reply.result?.exceptionDetails;
		if (details !== undefined) {
			const desc = details.exception?.description ?? details.text ?? "CDP 异常";
			throw new Error(desc.startsWith("Error: ") ? desc.slice(7) : desc);
		}
		return reply.result?.result?.value;
	} finally {
		ws.close();
	}
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function usageLine(rows: Usage[]): string {
	if (!rows.length) return "";
	let i = 0, o = 0, cr = 0, cw = 0;
	for (const r of rows) { i += r.input; o += r.output; cr += r.cacheRead; cw += r.cacheWrite; }
	return `  tok ×${rows.length}：入 ${k(i)}（缓读 ${k(cr)}／缓写 ${k(cw)}）出 ${k(o)}`;
}

function printWarnings(warnings: string[]): void {
	for (const w of warnings) console.log(`  ⚠ ${w}`);
}

function printAct(utterance: string, r: ActFace, brief = false): void {
	console.log(`\n【${r.game}/${r.run} #${r.turn} t=${r.time} act】${utterance}`);
	for (const line of r.lines) console.log(`  ${line}`);
	for (const item of r.reveals) console.log(`  + ${js(item)}`);
	printWarnings(r.warnings);
	const tok = usageLine(r.usage);
	if (tok) console.log(tok);
	const text = brief ? (r.narration.split(/\n/).find((l) => l.trim()) ?? "") : r.narration;
	const shown = brief && text.length > 100 ? `${text.slice(0, 100)}…` : text;
	console.log(`  ┈ ${shown.replace(/\n/g, "\n  ")}`);
}

async function dispatch(cmd: string, positionals: string[], target: Target, timeout: number): Promise<void> {
	const [g, r, ...rest] = positionals;
	const requireRun = (): [string, string] => {
		if (g === undefined || r === undefined) throw new Error(`${cmd} 需要 <game> <run>`);
		return [g, r];
	};
	switch (cmd) {
		case "games":
			console.log(JSON.stringify(await evaluate(target, "window.cave.games()", timeout), null, 1));
			return;
		case "def": {
			if (g === undefined) throw new Error("def 需要 <game>");
			console.log(JSON.stringify(await evaluate(target, `window.cave.def(${js(g)})`, timeout), null, 1));
			return;
		}
		case "meta": {
			if (g === undefined) throw new Error("meta 需要 <game>");
			console.log(JSON.stringify(await evaluate(target, `window.cave.meta(${js(g)})`, timeout), null, 1));
			return;
		}
		case "state": {
			const [game, run] = requireRun();
			const face = (await evaluate(target, openExpr(game, run), timeout)) as unknown as RunFace;
			console.log(`【${game}/${run}】已进行 ${face.turn} 回合（t=${face.time}）`);
			printWarnings(face.warnings ?? []);
			console.log(JSON.stringify(face.view, null, 1));
			return;
		}
		case "records": {
			const [game, run] = requireRun();
			const face = (await evaluate(target, `window.cave.records(${js(game)},${js(run)})`, timeout)) as unknown as RecordsFace;
			console.log(`【${game}/${run}】${face.records.length} 回合${face.broken ? `，${face.broken} 条形状损坏` : ""}`);
			console.log(JSON.stringify(face.records, null, 1));
			return;
		}
		case "act": {
			const [game, run] = requireRun();
			const utterance = rest.join(" ").trim();
			if (utterance === "") throw new Error("act 需要话语");
			const expr = `(async()=>{const o=await ${openExpr(game, run)};return {warnings:o.warnings??[],result:await window.cave.act(${js(game)},${js(run)},${js(utterance)})}})()`;
			const { warnings, result } = (await evaluate(target, expr, timeout)) as unknown as { warnings: string[]; result: ActFace };
			printWarnings(warnings);
			printAct(utterance, result);
			return;
		}
		case "batch": {
			const [game, run] = requireRun();
			const file = rest[0];
			if (file === undefined) throw new Error("batch 需要话语文件");
			const lines = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
			if (!lines.length) throw new Error(`话语文件 ${file} 为空`);
			const expr = `(async()=>{const o=await ${openExpr(game, run)};const results=[];for(const u of ${js(lines)})results.push(await window.cave.act(${js(game)},${js(run)},u));return {warnings:o.warnings??[],results}})()`;
			const { warnings, results } = (await evaluate(target, expr, timeout)) as unknown as { warnings: string[]; results: ActFace[] };
			printWarnings(warnings);
			results.forEach((face, i) => printAct(lines[i] ?? "", face, true));
			return;
		}
		case "narrate": {
			const [game, run] = requireRun();
			const instruction = rest.join(" ").trim();
			if (instruction === "") throw new Error("narrate 需要指令");
			const expr = `(async()=>{const o=await ${openExpr(game, run)};return {warnings:o.warnings??[],result:await window.cave.narrate(${js(game)},${js(run)},${js(instruction)})}})()`;
			const { warnings, result } = (await evaluate(target, expr, timeout)) as unknown as { warnings: string[]; result: NarrateFace };
			console.log(`\n【${game}/${run} narrate】${instruction}`);
			printWarnings(warnings);
			printWarnings(result.warnings);
			const tok = usageLine(result.usage);
			if (tok) console.log(tok);
			console.log(result.narration);
			return;
		}
		default:
			throw new Error(`未知命令: ${cmd}\n${USAGE}`);
	}
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a = parseArgs(argv);
	if (!cmd) throw new Error(USAGE);
	const exe = flagStr(a, "exe");
	const dataRoot = flagStr(a, "data-dir") ?? dataDir();
	const seconds = Number(flagStr(a, "timeout") ?? "");
	const timeout = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000;
	const stub = exe === undefined ? ensureStubUi(dataRoot) : null;
	let app: App | null = null;
	try {
		const electron = exe ?? (createRequire(import.meta.url)("electron") as string);
		if (!existsSync(electron)) throw new Error(`找不到 Electron：${electron}`);
		app = await openApp(electron, exe === undefined, dataRoot);
		await dispatch(cmd, a.positionals, app.target, timeout);
	} finally {
		app?.stop();
		if (stub !== null) rmSync(stub, { recursive: true, force: true });
	}
}

runMain(main);
