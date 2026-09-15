// GUI e2e host：经 CDP 调 window.shell 的 IPC 面
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

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

interface RunFace {
	game: string;
	run: string;
	time: number;
	view: unknown;
	warnings?: string[];
}

interface RecordsFace {
	broken: number;
	records: { narration?: string }[];
}

interface ActFace extends RunFace {
	lines: string[];
	reveals: unknown[];
	narration: string;
	warnings: string[];
}

interface NarrateFace {
	narration: string;
	warnings: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const js = (v: unknown): string => JSON.stringify(v);
const openExpr = (game: string, run: string): string => `window.shell.open(${js(game)},${js(run)})`;
/** 打开（必要时建会话）再求值：装载告警与结果一并回传。 */
const openThen = (game: string, run: string, call: string): string => `(async()=>{const o=await ${openExpr(game, run)};return {warnings:o.warnings??[],result:await (${call})}})()`;

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

/** 保活宿主的状态记录：参数随记录，供重连判定；dataRoot 为宿主自报的实际数据根。 */
interface Host {
	pid: number;
	port: number;
	exe: string;
	dataRoot: string;
}

/** 单实例锁使全局至多一个宿主，故状态与日志全局唯一。 */
const HOST_FILE = join(tmpdir(), "gui-host.json");
const HOST_LOG = join(tmpdir(), "gui-host.log");

function readHost(): Host | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(HOST_FILE, "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const { pid, port, exe, dataRoot } = parsed as Record<string, unknown>;
	if (typeof pid !== "number" || typeof port !== "number" || typeof exe !== "string" || typeof dataRoot !== "string") return null;
	return { pid, port, exe, dataRoot };
}

function writeHost(host: Host): void {
	writeFileSync(HOST_FILE, `${JSON.stringify(host)}\n`, "utf8");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 宿主的全部页面目标（窗口可不止一个）；不可达（未起／已死／界面已关）即空。 */
async function targetsOf(port: number): Promise<Target[]> {
	try {
		const list = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()) as unknown;
		if (!Array.isArray(list)) return [];
		return (list as Target[]).filter((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
	} catch {
		return [];
	}
}

/** 命令求值面：任一页面等价（同一 preload）；不可达即 null。 */
async function targetOf(port: number): Promise<Target | null> {
	return (await targetsOf(port))[0] ?? null;
}

/** 宿主日志尾：启动与崩溃诊断。 */
function logTail(): string {
	try {
		const lines = readFileSync(HOST_LOG, "utf8").trimEnd().split(/\r?\n/).filter((l) => l !== "");
		return lines.length === 0 ? "" : `\n宿主日志尾（${HOST_LOG}）：\n${lines.slice(-10).join("\n")}`;
	} catch {
		return "";
	}
}

/** 弃置宿主记录；不动进程。 */
function discardHost(): void {
	rmSync(HOST_FILE, { force: true });
}

/** 宿主记录须匹配 exe；dataRoot 缺省（未指定 --data-dir）即接受在跑宿主的实际根。 */
async function waitHost(exe: string, dataRoot: string | undefined, ms: number): Promise<Target | null> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const host = readHost();
		if (host !== null && host.exe === exe && (dataRoot === undefined || samePath(host.dataRoot, dataRoot))) {
			const target = await targetOf(host.port);
			if (target !== null) return target;
		}
		await sleep(150);
	}
	return null;
}

/** 脱离父进程启动宿主；就绪后才落盘状态（并发竞争由单实例锁收敛到先到者）。 */
async function spawnHost(exe: string, dev: boolean, dataRoot: string | undefined): Promise<Target> {
	const port = await freePort();
	const flags = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", ...(dataRoot === undefined ? [] : [`--user-data-dir=${dataRoot}`])];
	appendFileSync(HOST_LOG, `\n=== ${new Date().toISOString()} spawn ${exe}${dev ? ` ${REPO_ROOT}` : ""}（data-dir=${dataRoot ?? "宿主默认"}）\n`, "utf8");
	const fd = openSync(HOST_LOG, "a");
	const child = spawn(exe, dev ? [REPO_ROOT, ...flags] : flags, { detached: true, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	child.unref();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			if (child.exitCode === 0) {
				const target = await waitHost(exe, dataRoot, 10_000);
				if (target !== null) return target;
				throw new Error(`Electron 退出（code 0，单实例锁）：已有实例在运行但未记录状态；关闭其窗口后重试${logTail()}`);
			}
			throw new Error(`Electron 退出（code ${child.exitCode}）${logTail()}`);
		}
		const target = await targetOf(port);
		const root = target === null ? null : await hostRoot(target).catch(() => null);
		if (target !== null && root !== null) {
			if (dataRoot !== undefined && !samePath(root, dataRoot)) {
				child.kill();
				throw new Error(`宿主未采用指定数据根（期望 ${dataRoot}，实际 ${root}）`);
			}
			writeHost({ pid: child.pid ?? 0, port, exe, dataRoot: root });
			return target;
		}
		await sleep(150);
	}
	child.kill();
	throw new Error(`等待界面超时（30s，已结束 pid ${child.pid ?? 0}）：需在数据根的 games/<id>/ui/index.html 提供界面，且该界面经 preload 暴露 window.shell${logTail()}`);
}

/** 重连或启动宿主：参数不符时报错，进程已死则清理残留后重启。 */
async function ensureHost(exe: string | undefined, dataRoot: string | undefined): Promise<Target> {
	const binary = exe ?? (createRequire(import.meta.url)("electron") as string);
	if (!existsSync(binary)) throw new Error(`找不到 Electron：${binary}`);
	const host = readHost();
	if (host !== null) {
		if (host.exe !== binary || (dataRoot !== undefined && !samePath(host.dataRoot, dataRoot))) throw new Error(`已有宿主参数不符（pid ${host.pid}，exe ${host.exe}，data-dir ${host.dataRoot}）：先 stop 再以当前参数运行`);
		const target = await targetOf(host.port);
		if (target !== null) return target;
		if (pidAlive(host.pid)) throw new Error(`宿主进程存活（pid ${host.pid}）但界面不可达（debug port ${host.port}）：stop 后重试${logTail()}`);
		discardHost();
	}
	return await spawnHost(binary, exe === undefined, dataRoot);
}

function requestClose(target: Target): Promise<void> {
	return new Promise((resolve) => {
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		const finish = (): void => {
			ws.close();
			resolve();
		};
		const timer = setTimeout(finish, 1000);
		ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.close" }));
		ws.onmessage = () => {
			clearTimeout(timer);
			finish();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			finish();
		};
	});
}

async function stopHost(): Promise<void> {
	const host = readHost();
	if (host === null) {
		console.log("宿主：无运行记录");
		return;
	}
	const targets = await targetsOf(host.port);
	await Promise.all(targets.map((t) => requestClose(t)));
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && pidAlive(host.pid)) await sleep(150);
	if (pidAlive(host.pid)) {
		try {
			process.kill(host.pid);
		} catch {
			// 已退出
		}
	}
	discardHost();
	console.log(`宿主已停止（pid ${host.pid}${targets.length === 0 ? "，界面本不可达" : ""}）`);
}

async function evaluate<T>(target: Target, expression: string, timeoutMs: number): Promise<T> {
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
		return reply.result?.result?.value as T;
	} finally {
		ws.close();
	}
}

/** 宿主自报的数据根：工具侧的唯一权威，不镜像 Electron 的默认值。 */
async function hostRoot(target: Target): Promise<string> {
	const face = await evaluate<{ root?: unknown }>(target, "window.shell.env()", 10_000);
	if (typeof face?.root !== "string" || face.root === "") throw new Error("宿主未报告数据根（window.shell.env）");
	return face.root;
}

/** 路径同一性：解析后比较；Windows 大小写不敏感。 */
function samePath(a: string, b: string): boolean {
	const x = resolve(a);
	const y = resolve(b);
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function printWarnings(warnings: string[]): void {
	for (const w of warnings) console.log(`  ⚠ ${w}`);
}

function printAct(utterance: string, r: ActFace, brief = false): void {
	console.log(`\n【${r.game}/${r.run} t=${r.time} act】${utterance}`);
	for (const line of r.lines) console.log(`  ${line}`);
	for (const item of r.reveals) console.log(`  + ${js(item)}`);
	printWarnings(r.warnings);
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
			console.log(JSON.stringify(await evaluate(target, "window.shell.games()", timeout), null, 1));
			return;
		case "def": {
			if (g === undefined) throw new Error("def 需要 <game>");
			console.log(JSON.stringify(await evaluate(target, `window.shell.def(${js(g)})`, timeout), null, 1));
			return;
		}
		case "state": {
			const [game, run] = requireRun();
			const face = await evaluate<RunFace>(target, openExpr(game, run), timeout);
			console.log(`【${game}/${run}】t=${face.time}`);
			printWarnings(face.warnings ?? []);
			console.log(JSON.stringify(face.view, null, 1));
			return;
		}
		case "records": {
			const [game, run] = requireRun();
			const face = await evaluate<RecordsFace>(target, `window.shell.records(${js(game)},${js(run)})`, timeout);
			const narrated = face.records.reduce((n, r) => n + (r.narration === undefined ? 0 : 1), 0);
			console.log(`【${game}/${run}】${face.records.length} 回合${narrated ? `，${narrated} 表达` : ""}${face.broken ? `，${face.broken} 条形状损坏` : ""}`);
			console.log(JSON.stringify(face.records, null, 1));
			return;
		}
		case "close": {
			const [game, run] = requireRun();
			await evaluate(target, `window.shell.close(${js(game)},${js(run)})`, timeout);
			console.log(`【${game}/${run}】已关闭`);
			return;
		}
		case "act": {
			const [game, run] = requireRun();
			const utterance = rest.join(" ").trim();
			if (utterance === "") throw new Error("act 需要话语");
			const expr = openThen(game, run, `window.shell.act(${js(game)},${js(run)},${js(utterance)})`);
			const { warnings, result } = await evaluate<{ warnings: string[]; result: ActFace }>(target, expr, timeout);
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
			const expr = openThen(game, run, `(async()=>{const results=[];for(const u of ${js(lines)})results.push(await window.shell.act(${js(game)},${js(run)},u));return results})()`);
			const { warnings, result } = await evaluate<{ warnings: string[]; result: ActFace[] }>(target, expr, timeout);
			printWarnings(warnings);
			result.forEach((face, i) => printAct(lines[i] ?? "", face, true));
			return;
		}
		case "narrate": {
			const [game, run] = requireRun();
			const instruction = rest.join(" ").trim();
			if (instruction === "") throw new Error("narrate 需要指令");
			const expr = openThen(game, run, `window.shell.narrate(${js(game)},${js(run)},${js(instruction)})`);
			const { warnings, result } = await evaluate<{ warnings: string[]; result: NarrateFace }>(target, expr, timeout);
			console.log(`\n【${game}/${run} narrate】${instruction}`);
			printWarnings(warnings);
			printWarnings(result.warnings);
			console.log(result.narration);
			return;
		}
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

interface ParsedArgs {
	flags: Map<string, string | boolean>;
	positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
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

function flagStr(a: ParsedArgs, name: string): string | undefined {
	const v = a.flags.get(name);
	return typeof v === "string" ? v : undefined;
}

function runMain(main: () => Promise<void>): void {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a = parseArgs(argv);
	if (!cmd) throw new Error("需要命令");
	const rawExe = flagStr(a, "exe");
	const exe = rawExe === undefined ? undefined : resolve(rawExe);
	const rawDataRoot = flagStr(a, "data-dir");
	const dataRoot = rawDataRoot === undefined ? undefined : resolve(rawDataRoot);
	const seconds = Number(flagStr(a, "timeout") ?? "");
	const timeout = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000;
	if (cmd === "stop") {
		await stopHost();
		return;
	}
	if (cmd === "restart") await stopHost();
	const target = await ensureHost(exe, dataRoot);
	if (cmd === "start" || cmd === "restart") {
		const host = readHost();
		if (host !== null) console.log(`宿主${cmd === "restart" ? "已重启" : "已就绪"}（pid ${host.pid}，debug port ${host.port}，data-dir ${host.dataRoot}）：窗口保活，stop 关闭`);
		return;
	}
	await dispatch(cmd, a.positionals, target, timeout);
}

runMain(main);
