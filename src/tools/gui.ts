// GUI e2e host：启动 Electron 壳（缺省 dev，--exe 指定打包产物），经 CDP 调 window.cave 的 IPC 面；会话证据落壳的数据根（dev 即仓库 runs/，打包即 userData/runs/），验证靠阅读会话。e2e 模型经 <GAME>_MODEL 或 settings.json 指定。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { flagStr, parseArgs, runMain } from "./cli.ts";

const APP_ROOT = join(import.meta.dirname, "..", "..");
const USAGE = `用法：gui <命令> [参数] [--exe <打包可执行文件>] [--timeout <秒>]
  games
  def <game>
  state <game> <run>
  act <game> <run> <话语...>
  batch <game> <run> <话语文件>     （每行一条，空行与 # 注释跳过）
  narrate <game> <run> <指令...>
  reset <game> <run>
缺省以 dev Electron 启动本仓库；--exe 驱动打包产物（界面须在 userData/ui 或 resources/ui 下）。`;

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

/** dev 启动要求存在界面；仓库不带界面资产，首次 e2e 自动补一个 stub。 */
function ensureStubUi(): void {
	const root = join(APP_ROOT, "ui");
	const found = existsSync(root) && readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(root, e.name, "index.html")));
	if (found) return;
	const dir = join(root, "e2e");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>e2e</title>\n", "utf8");
	console.error(`已创建 e2e stub 界面：${join(dir, "index.html")}`);
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

async function openApp(exe: string, dev: boolean): Promise<App> {
	const port = await freePort();
	const flags = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"];
	const child = spawn(exe, dev ? [APP_ROOT, ...flags] : flags, { stdio: ["ignore", "ignore", "pipe"] });
	let err = "";
	child.stderr?.on("data", (d: Buffer) => { err += String(d); });
	const stop = (): void => { child.kill(); };
	process.once("exit", stop);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Electron 退出（code ${child.exitCode}）：${err.trim()}`);
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
	throw new Error(`等待界面超时（30s）：dev 需 ui/<name>/index.html，打包产物须在 userData/ui 或 resources/ui 提供界面${err.trim() === "" ? "" : `\n${err.trim()}`}`);
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
		case "state": {
			const [game, run] = requireRun();
			const face = (await evaluate(target, openExpr(game, run), timeout)) as unknown as RunFace;
			console.log(`【${game}/${run}】已进行 ${face.turn} 回合（t=${face.time}）`);
			printWarnings(face.warnings ?? []);
			console.log(JSON.stringify(face.view, null, 1));
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
		case "reset": {
			const [game, run] = requireRun();
			await evaluate(target, `window.cave.reset(${js(game)},${js(run)})`, timeout);
			console.log(`已重置 run ${game}/${run}`);
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
	const seconds = Number(flagStr(a, "timeout") ?? "");
	const timeout = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000;
	if (exe === undefined) ensureStubUi();
	const electron = exe ?? (createRequire(import.meta.url)("electron") as string);
	if (!existsSync(electron)) throw new Error(`找不到 Electron：${electron}`);
	const app = await openApp(electron, exe === undefined);
	try {
		await dispatch(cmd, a.positionals, app.target, timeout);
	} finally {
		app.stop();
	}
}

runMain(main);
