import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
		data?: string;
	};
	error?: { message?: string };
}

interface RunFace {
	time: number;
	view: unknown;
	warnings?: string[];
}

interface ActFace extends RunFace {
	lines: string[];
	reveals: unknown[];
	narration: string;
}

interface NarrateFace {
	narration: string;
	warnings: string[];
}

interface RecordsFace {
	records: unknown[];
	broken: number;
	incomplete: boolean;
}

interface UiControl {
	role: string;
	name: string;
	value: string;
	disabled: boolean;
	checked: boolean;
}

interface UiFace {
	url: string;
	title: string;
	text: string;
	controls: UiControl[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const js = (v: unknown): string => JSON.stringify(v);
/** 求值探测时限 */
const PROBE_MS = 5_000;
/** 界面装载与清单时限 */
const UI_MS = 15_000;

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

/** 单实例锁使全局至多一个宿主 */
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

/** 脱离父进程启动宿主；就绪后才落盘状态。 */
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
			if (child.exitCode === 0) throw new Error(`Electron 退出（code 0，单实例锁）：已有实例在运行但无宿主记录；关闭其窗口后重试${logTail()}`);
			throw new Error(`Electron 退出（code ${child.exitCode}）${logTail()}`);
		}
		const target = await targetOf(port);
		const root = target === null ? null : await hostRoot(target).catch(() => null);
		if (target !== null && root !== null) {
			writeHost({ pid: child.pid ?? 0, port, exe, dataRoot: root });
			return target;
		}
		await sleep(150);
	}
	child.kill();
	throw new Error(`等待界面超时（30s，已结束 pid ${child.pid ?? 0}）：页面未就绪或 window.shell.env 不可达${logTail()}`);
}

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

/** 主窗关闭即 app.quit：页面全关即可收束，顽固进程补杀。 */
async function stopHost(): Promise<number | null> {
	const host = readHost();
	if (host === null) return null;
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
	return host.pid;
}

async function cdp<T>(target: Target, method: string, params: unknown, timeoutMs: number): Promise<T> {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("CDP 连接失败"));
	});
	try {
		const reply = await new Promise<CdpReply>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`CDP 超时（${method}，${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
			ws.onmessage = (e) => {
				const m = JSON.parse(String(e.data)) as CdpReply;
				if (m.id !== 1) return;
				clearTimeout(timer);
				resolve(m);
			};
			ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP 通道中断")); };
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error !== undefined) throw new Error(reply.error.message ?? `CDP 错误（${method}）`);
		return (reply.result ?? {}) as T;
	} finally {
		ws.close();
	}
}

interface EvalResult {
	result?: { value?: unknown };
	exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate<T>(target: Target, expression: string, timeoutMs: number): Promise<T> {
	const out = await cdp<EvalResult>(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
	const details = out.exceptionDetails;
	if (details !== undefined) {
		const desc = details.exception?.description ?? details.text ?? "CDP 异常";
		throw new Error(desc.startsWith("Error: ") ? desc.slice(7) : desc);
	}
	return out.result?.value as T;
}

/** 宿主自报的数据根：工具侧的唯一权威，不镜像 Electron 的默认值。 */
async function hostRoot(target: Target): Promise<string> {
	const face = await evaluate<{ root?: unknown }>(target, "window.shell.env()", 10_000);
	if (typeof face?.root !== "string" || face.root === "") throw new Error("宿主未报告数据根（window.shell.env）");
	return face.root;
}

function samePath(a: string, b: string): boolean {
	const x = resolve(a);
	const y = resolve(b);
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function onGameFace(target: Target, game: string): Promise<boolean> {
	const href = await evaluate<unknown>(target, "location.href", PROBE_MS).catch(() => undefined);
	if (typeof href !== "string") return false;
	try {
		return fileURLToPath(href).endsWith(join("games", game, "index.html"));
	} catch {
		return false;
	}
}

async function poll(timeout: number, what: string, probe: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (await probe().catch(() => false)) return;
		if (Date.now() >= deadline) throw new Error(`等待${what}超时（${Math.round(timeout / 1000)}s）`);
		await sleep(150);
	}
}

/** 只导航主窗到游戏界面，不开会话、不动引擎；已在即空操作。 */
async function go(target: Target, game: string): Promise<void> {
	if (await onGameFace(target, game)) return;
	const uis = await evaluate<unknown>(target, "window.shell.uis()", UI_MS);
	if (!Array.isArray(uis) || !uis.includes(game)) throw new Error(`游戏 ${game} 无界面（games/${game}/index.html 缺席）`);
	// 导航替换页面并销毁求值上下文：发起不等结果，落定由页面 URL 判定
	await evaluate(target, `void window.shell.navigate(${js(game)}).catch(() => {})`, PROBE_MS).catch(() => undefined);
	await poll(UI_MS, `游戏界面 ${game}`, () => onGameFace(target, game));
}

/** 打开或附着运行并返回装载面；不导航窗口。 */
async function openRun(target: Target, game: string, run: string, timeout: number): Promise<RunFace> {
	return await evaluate<RunFace>(target, `window.shell.open(${js(game)},${js(run)})`, timeout);
}

/** 页面内交互元素扫描：ui 与 click 共用同一规则，编号即文档序位置。 */
const SCAN = `
	const collapse = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
	const vis = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		const st = getComputedStyle(el);
		return st.display !== "none" && st.visibility !== "hidden";
	};
	const roleOf = (el) => {
		const role = el.getAttribute("role");
		if (role) return role;
		const t = el.tagName.toLowerCase();
		if (t === "a") return "link";
		if (t === "select") return "combobox";
		if (t === "textarea" || el.isContentEditable) return "textbox";
		if (t === "input") {
			const k = (el.type || "text").toLowerCase();
			if (k === "checkbox" || k === "radio") return k;
			if (k === "range") return "slider";
			if (k === "button" || k === "submit" || k === "reset") return "button";
			return "textbox";
		}
		return "button";
	};
	const nameOf = (el) => collapse(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.textContent);
	const valueOf = (el) => ("value" in el && typeof el.value === "string" ? el.value : "");
	const scan = () => Array.from(document.querySelectorAll("button,input,select,textarea,a[href],summary,[tabindex]:not([tabindex='-1']),[onclick],[contenteditable],[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=switch],[role=slider],[role=combobox],[role=tab],[role=menuitem],[role=option]")).filter(vis).map((el) => ({ el, role: roleOf(el), name: nameOf(el), value: valueOf(el), disabled: !!el.disabled, checked: !!el.checked }));
`;

const UI_EXPRESSION = `(() => {
${SCAN}
	const list = scan();
	return {
		url: location.href,
		title: document.title,
		text: collapse(document.body.innerText).slice(0, 2000),
		controls: list.map((c) => ({ role: c.role, name: c.name, value: c.value, disabled: c.disabled, checked: c.checked })),
	};
})()`;

/** 文本目标：先精确后包含；交互元素之外再落到最小可见文本宿主（无角色的 div 按钮）。 */
function pickExpression(text: string): string {
	return `((l) => {
		const hit = l.find((c) => c.name === ${js(text)}) ?? l.find((c) => c.name.includes(${js(text)}));
		if (hit) return hit.el;
		const all = Array.from(document.querySelectorAll("*")).filter((el) => el.getClientRects().length > 0);
		const exact = all.filter((el) => collapse(el.textContent) === ${js(text)});
		if (exact.length > 0) return exact[exact.length - 1];
		const loose = all.filter((el) => collapse(el.textContent).includes(${js(text)}));
		return loose.length > 0 ? loose[loose.length - 1] : null;
	})(scan())`;
}

function clickExpression(pick: string): string {
	return `(() => {
${SCAN}
	const el = ${pick};
	if (!el) return null;
	el.scrollIntoView({ block: "center", inline: "center" });
	const r = el.getBoundingClientRect();
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	return { x, y, off: x < 0 || y < 0 || x > innerWidth || y > innerHeight };
})()`;
}

function renderUi(face: UiFace): string {
	const lines = [`url ${face.url}`];
	if (face.title !== "") lines.push(`title ${face.title}`);
	if (face.text !== "") lines.push(`text ${face.text}`);
	face.controls.forEach((c, i) => {
		let line = `#${i} ${c.role} ${JSON.stringify(c.name)}`;
		if (c.value !== "") line += ` = ${JSON.stringify(c.value)}`;
		const marks = [c.disabled ? "disabled" : "", c.checked ? "checked" : ""].filter((m) => m !== "");
		if (marks.length > 0) line += ` [${marks.join(",")}]`;
		lines.push(line);
	});
	return lines.join("\n");
}

/** 真事件点击：坐标取自元素中心，命中判定与焦点交给渲染器。 */
async function click(target: Target, args: ParsedArgs, timeout: number): Promise<void> {
	const [first] = args.positionals;
	const text = flagStr(args, "text");
	const css = flagStr(args, "css");
	const at = flagStr(args, "at");
	let point: { x: number; y: number };
	if (at !== undefined) {
		const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(at);
		if (m === null) throw new Error("click --at 需要 x,y 坐标");
		point = { x: Number(m[1]), y: Number(m[2]) };
	} else {
		const pick = text !== undefined
			? pickExpression(text)
			: css !== undefined
				? `document.querySelector(${js(css)})`
				: first !== undefined && /^\d+$/.test(first)
					? `scan()[${first}]?.el`
					: null;
		if (pick === null) throw new Error("click 需要目标：<序号> | --text <文本> | --css <选择器> | --at <x,y>");
		const hit = await evaluate<{ x: number; y: number; off: boolean } | null>(target, clickExpression(pick), timeout);
		if (hit === null) throw new Error("click 目标不存在或不可见");
		if (hit.off) throw new Error(`click 目标不在视口内（${Math.round(hit.x)},${Math.round(hit.y)}）`);
		point = hit;
	}
	await cdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, PROBE_MS);
	await cdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, PROBE_MS);
	await cdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, PROBE_MS);
}

interface KeySpec {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const KEYS: Record<string, KeySpec> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function keySpec(name: string): KeySpec {
	const known = KEYS[name];
	if (known !== undefined) return known;
	if (!/^[a-zA-Z0-9]$/.test(name)) throw new Error(`未知按键：${name}（可用：${Object.keys(KEYS).join("/")} 或单个字母数字）`);
	const upper = name.toUpperCase();
	return { key: name, code: `${/^[a-z]$/i.test(name) ? "Key" : "Digit"}${upper}`, keyCode: upper.charCodeAt(0), text: name };
}

async function pressKey(target: Target, name: string, timeout: number): Promise<void> {
	const k = keySpec(name);
	await cdp(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }, timeout);
	if (k.text !== undefined) await cdp(target, "Input.dispatchKeyEvent", { type: "char", key: k.key, text: k.text, unmodifiedText: k.text }, timeout);
	await cdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }, timeout);
}

/** 空闲须稳定 500ms：点击后 UI 可能尚未发起回合。 */
async function waitIdle(target: Target, timeout: number): Promise<void> {
	const deadline = Date.now() + timeout;
	let since: number | null = null;
	for (;;) {
		const list = await evaluate<{ state: string }[]>(target, "window.shell.sessions()", PROBE_MS).catch(() => []);
		since = list.every((s) => s.state === "idle") ? (since ?? Date.now()) : null;
		if (since !== null && Date.now() - since >= 500) return;
		if (Date.now() >= deadline) throw new Error(`等待空闲超时（${Math.round(timeout / 1000)}s）`);
		await sleep(150);
	}
}

async function waitFace(target: Target, args: ParsedArgs, timeout: number): Promise<void> {
	const text = flagStr(args, "text");
	const idle = args.flags.has("idle");
	if ((text === undefined ? 0 : 1) + (idle ? 1 : 0) !== 1) throw new Error("wait 需要 --text <文本> | --idle 之一");
	if (text !== undefined) {
		await poll(timeout, `文本 ${js(text)}`, () => evaluate<boolean>(target, `document.body.innerText.includes(${js(text)})`, PROBE_MS));
		return;
	}
	await waitIdle(target, timeout);
}

async function shot(target: Target, timeout: number): Promise<string> {
	const file = join(tmpdir(), `cave-${Date.now()}.png`);
	const out = await cdp<{ data?: string }>(target, "Page.captureScreenshot", { format: "png" }, timeout);
	if (out.data === undefined || out.data === "") throw new Error("截图无数据");
	writeFileSync(file, Buffer.from(out.data, "base64"));
	return file;
}

/** 命令分派：UI 通道（go/ui/click/type/key/wait/shot）走真实交互；shell 通道是无头与断言面。 */
async function dispatch(cmd: string, args: ParsedArgs, target: Target, timeout: number): Promise<unknown> {
	const [g, r, ...rest] = args.positionals;
	const requireRun = (): [string, string] => {
		if (g === undefined || r === undefined) throw new Error(`${cmd} 需要 <game> <run>`);
		return [g, r];
	};
	switch (cmd) {
		case "games":
			return await evaluate(target, "window.shell.games()", timeout);
		case "runs":
			return await evaluate(target, g === undefined ? "window.shell.runs()" : `window.shell.runs(${js(g)})`, timeout);
		case "go": {
			if (g === undefined) throw new Error("go 需要 <game>");
			await go(target, g);
			return;
		}
		case "ui":
			return renderUi(await evaluate<UiFace>(target, UI_EXPRESSION, timeout));
		case "click": {
			await click(target, args, timeout);
			return;
		}
		case "type": {
			const text = args.positionals.join(" ").trim();
			if (text === "") throw new Error("type 需要文本");
			await cdp(target, "Input.insertText", { text }, timeout);
			return;
		}
		case "key": {
			const name = args.positionals[0];
			if (name === undefined) throw new Error("key 需要按键名");
			await pressKey(target, name, timeout);
			return;
		}
		case "wait": {
			await waitFace(target, args, timeout);
			return;
		}
		case "shot":
			return await shot(target, timeout);
		case "state": {
			const [game, run] = requireRun();
			const face = await openRun(target, game, run, timeout);
			return { time: face.time, view: face.view, warnings: face.warnings ?? [] };
		}
		case "records": {
			const [game, run] = requireRun();
			const face = await evaluate<RecordsFace>(target, `window.shell.records(${js(game)},${js(run)})`, timeout);
			return { records: face.records, broken: face.broken, incomplete: face.incomplete };
		}
		case "close": {
			const [game, run] = requireRun();
			await evaluate(target, `window.shell.close(${js(game)},${js(run)})`, timeout);
			return;
		}
		case "act": {
			const [game, run] = requireRun();
			const utterance = rest.join(" ").trim();
			if (utterance === "") throw new Error("act 需要话语");
			await openRun(target, game, run, timeout);
			const out = await evaluate<ActFace>(target, `window.shell.act(${js(game)},${js(run)},${js(utterance)})`, timeout);
			return { time: out.time, lines: out.lines, reveals: out.reveals, narration: out.narration, warnings: out.warnings };
		}
		case "narrate": {
			const [game, run] = requireRun();
			const instruction = rest.join(" ").trim();
			if (instruction === "") throw new Error("narrate 需要指令");
			await openRun(target, game, run, timeout);
			const out = await evaluate<NarrateFace>(target, `window.shell.narrate(${js(game)},${js(run)},${js(instruction)})`, timeout);
			return { narration: out.narration, warnings: out.warnings };
		}
		case "eval": {
			const expr = args.positionals.join(" ").trim();
			if (expr === "") throw new Error("eval 需要表达式");
			return await evaluate(target, expr, timeout);
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
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	if (cmd === undefined) throw new Error("需要命令：games|go|ui|click|type|key|wait|shot|state|records|close|act|narrate|eval|stop");
	const a = parseArgs(argv);
	const rawExe = flagStr(a, "exe");
	const exe = rawExe === undefined ? undefined : resolve(rawExe);
	const rawDataRoot = flagStr(a, "data-dir");
	const dataRoot = rawDataRoot === undefined ? undefined : resolve(rawDataRoot);
	const seconds = Number(flagStr(a, "timeout") ?? "");
	const timeout = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000;
	if (cmd === "stop") {
		console.log(JSON.stringify({ pid: await stopHost() }));
		return;
	}
	const target = await ensureHost(exe, dataRoot);
	const result = await dispatch(cmd, a, target, timeout);
	if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result));
}

runMain(main);
