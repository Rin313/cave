import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
	type: string;
	webSocketDebuggerUrl: string;
}

interface CdpReply {
	id?: number;
	result?: unknown;
	error?: { message?: string };
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

/** 保活宿主的状态记录：exe 随记录，供重连判定。 */
interface Host {
	pid: number;
	port: number;
	exe: string;
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
	const { pid, port, exe } = parsed as Record<string, unknown>;
	if (typeof pid !== "number" || typeof port !== "number" || typeof exe !== "string") return null;
	return { pid, port, exe };
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

/** 命令求值面：任一页面等价（同一 preload）；不可达（未起／已死／界面已关）即 null。 */
async function targetOf(port: number): Promise<Target | null> {
	try {
		const list = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()) as unknown;
		if (!Array.isArray(list)) return null;
		return (list as Target[]).find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string") ?? null;
	} catch {
		return null;
	}
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
async function spawnHost(exe: string): Promise<Target> {
	const port = await freePort();
	const flags = [`--remote-debugging-port=${port}`];
	appendFileSync(HOST_LOG, `\n=== ${new Date().toISOString()} spawn ${exe}\n`, "utf8");
	const fd = openSync(HOST_LOG, "a");
	const child = spawn(exe, flags, { detached: true, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	child.unref();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			if (child.exitCode === 0) throw new Error(`宿主退出（code 0，单实例锁）：已有实例在运行但无宿主记录；关闭其窗口后重试${logTail()}`);
			throw new Error(`宿主退出（code ${child.exitCode}）${logTail()}`);
		}
		const target = await targetOf(port);
		if (target !== null && (await shellReady(target))) {
			writeHost({ pid: child.pid ?? 0, port, exe });
			return target;
		}
		await sleep(150);
	}
	child.kill();
	throw new Error(`等待界面超时（30s，已结束 pid ${child.pid ?? 0}）：页面未就绪或 window.shell 不可达${logTail()}`);
}

async function ensureHost(binary: string): Promise<Target> {
	if (!existsSync(binary)) throw new Error(`找不到可执行文件：${binary}`);
	const host = readHost();
	if (host !== null) {
		if (host.exe !== binary) throw new Error(`已有宿主的 exe 不符（pid ${host.pid}，exe ${host.exe}）：先 stop 再以 ${binary} 运行`);
		const target = await targetOf(host.port);
		if (target !== null) return target;
		if (pidAlive(host.pid)) throw new Error(`宿主进程存活（pid ${host.pid}）但界面不可达（debug port ${host.port}）：stop 后重试${logTail()}`);
		discardHost();
	}
	return await spawnHost(binary);
}

/** 主窗关闭即 app.quit：请求关页即可收束，顽固进程补杀。 */
async function stopHost(): Promise<number | null> {
	const host = readHost();
	if (host === null) return null;
	const target = await targetOf(host.port);
	if (target !== null) await cdp(target, "Page.close", {}, 1000).catch(() => undefined);
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

/** 装载就绪判据：preload 已暴露 window.shell。 */
async function shellReady(target: Target): Promise<boolean> {
	return (await evaluate<unknown>(target, `typeof window.shell === "object"`, PROBE_MS).catch(() => false)) === true;
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
	const at = flagStr(args, "at");
	let point: { x: number; y: number };
	if (at !== undefined) {
		const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(at);
		if (m === null) throw new Error("click --at 需要 x,y 坐标");
		point = { x: Number(m[1]), y: Number(m[2]) };
	} else {
		const pick = text !== undefined
			? pickExpression(text)
			: first !== undefined && /^\d+$/.test(first)
				? `scan()[${first}]?.el`
				: null;
		if (pick === null) throw new Error("click 需要目标：<序号> | --text <文本> | --at <x,y>");
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
	return { key: name, code: `${/[a-z]/i.test(name) ? "Key" : "Digit"}${upper}`, keyCode: upper.charCodeAt(0), text: name };
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

/** 分派：真实交互（go/ui/click/type/key/wait/shot）走 CDP 输入；协议面不设转发命令，经 eval 直达 window.shell。 */
async function dispatch(cmd: string, args: ParsedArgs, target: Target, timeout: number): Promise<unknown> {
	switch (cmd) {
		case "go": {
			const game = args.positionals[0];
			if (game === undefined) throw new Error("go 需要 <game>");
			await go(target, game);
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
		if (a === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
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
	if (cmd === undefined) throw new Error("需要命令：go|ui|click|type|key|wait|shot|eval|stop；除 stop 外均需 --exe <可执行文件>（协议面：eval 'window.shell.*'）");
	const a = parseArgs(argv);
	const seconds = Number(flagStr(a, "timeout") ?? "");
	const timeout = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000;
	if (cmd === "stop") {
		console.log(JSON.stringify({ pid: await stopHost() }));
		return;
	}
	const rawExe = flagStr(a, "exe");
	if (rawExe === undefined) throw new Error("需要 --exe <可执行文件>：宿主只由显式指定的二进制启动（npm run dist 的产物）");
	const target = await ensureHost(resolve(rawExe));
	const result = await dispatch(cmd, a, target, timeout);
	if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result));
}

runMain(main);
