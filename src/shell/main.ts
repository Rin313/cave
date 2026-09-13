import { app, BrowserWindow, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseRecordLines } from "../core/archive.ts";
import type { Engine } from "../core/engine.ts";
import { listGames, loadGame, readGameMeta } from "../core/games.ts";
import { errorText, verbFace, type SlotDef } from "../core/sim.ts";
import { configDir, dataDir, readJsonObject, runPaths, writeJson } from "../core/paths.ts";
import { listRuns, ModelConfigError, modelErrorReason, openModelRuntime, openRun } from "../core/runs.ts";
import { installAuth } from "./auth.ts";

if (!app.requestSingleInstanceLock()) app.exit(0);

/** 引擎实例身份是 (game, run)：活实例进程内唯一（同一 run 双写者撕裂档案），界面只是附着者。 */
interface Session {
	game: string;
	run: string;
	engine: Engine;
	unsubscribe: () => void;
	busy: "act" | "narrate" | null;
}

const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();
const sessionKey = (game: string, run: string): string => `${game}\u0000${run}`;

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

/** 第二实例聚焦已有窗口；写者唯一由单实例锁保证。 */
app.on("second-instance", () => {
	const target = win ?? settingsWin;
	if (target === null || target.isDestroyed()) return;
	if (target.isMinimized()) target.restore();
	target.focus();
});

const USER_DATA = app.getPath("userData");
/** 数据根：runs 与用户级内容（games、ui）的所在；引擎包内不复含内容。 */
const DATA_ROOT = dataDir(USER_DATA);
/** 包外资源根：随安装分发，位于 asar 之外；dev 无此层。 */
const RESOURCE_ROOT = process.resourcesPath;
/** 内容根：数据根 → 包外资源（仅打包分发）；同名前者遮蔽后者。 */
const CONTENT_ROOTS = app.isPackaged ? [DATA_ROOT, RESOURCE_ROOT] : [DATA_ROOT];
const UI_ROOTS = CONTENT_ROOTS.map((root) => join(root, "ui"));
/** 配置根（用户级全局）：凭据、模型与界面偏好，与 CLI 共用；运行数据（runs）另按数据根。 */
const CONFIG_DIR = configDir(USER_DATA);
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");
/** 设置查序：用户配置 → 分发缺省（仅打包）。 */
const SETTINGS_FILES = app.isPackaged ? [SETTINGS_FILE, join(RESOURCE_ROOT, "settings.json")] : [SETTINGS_FILE];
/** 壳内引导面：随包分发、不属内容、不可遮蔽；配置正确性的兜底，呈现可被 settingsUi 替换。 */
const SETUP_FILE = join(import.meta.dirname, "setup.html");

let runtime: Promise<ModelRuntime> | null = null;
/** 壳与所有引擎共享同一模型运行时：配置协议写入的凭据对所有后续 open 立即生效；失败即弃，下次重试。 */
function modelRuntime(): Promise<ModelRuntime> {
	if (runtime === null) {
		runtime = openModelRuntime(CONFIG_DIR).catch((e: unknown) => {
			runtime = null;
			throw e;
		});
	}
	return runtime;
}

/** 路径段：id 不做路径解析。 */
function segment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

/** 界面作用域：null 即通用；游戏自带界面缺省绑定其 game，ui.json 的 game 可覆盖或扩为多个。坏元数据回落隐式作用域并携错，界面不因此不可用。 */
function uiMeta(dir: string, implicit: string[] | null): { scope: string[] | null; error?: string } {
	const file = join(dir, "ui.json");
	const read = readJsonObject(file);
	if (read === null) return { scope: implicit };
	if (read.value === null) return { scope: implicit, error: `界面元数据${read.error}` };
	const declared = read.value.game;
	if (declared === undefined) return { scope: implicit };
	const list = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : null;
	if (list === null || list.length === 0 || !list.every((g) => segment(g))) return { scope: implicit, error: `界面元数据的 game 须为非空游戏 id 或非空数组（${file}）` };
	return { scope: [...list] };
}

interface UiSite {
	name: string;
	file: string;
	scope: string[] | null;
	error?: string;
}

/** 界面位置：全局在前，游戏自带在后；名称即目录名（游戏自带的即 game id）。 */
function uiSite(name: string): UiSite | null {
	if (!segment(name)) return null;
	for (const root of UI_ROOTS) {
		const dir = join(root, name);
		const file = join(dir, "index.html");
		if (existsSync(file)) return { name, file, ...uiMeta(dir, null) };
	}
	for (const root of CONTENT_ROOTS) {
		const dir = join(root, "games", name, "ui");
		const file = join(dir, "index.html");
		if (existsSync(file)) return { name, file, ...uiMeta(dir, [name]) };
	}
	return null;
}

/** 全部界面（遮蔽后的全集，遮蔽者优先）。 */
function uiSites(): UiSite[] {
	const sites = new Map<string, UiSite>();
	for (const root of UI_ROOTS) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || sites.has(entry.name)) continue;
			const dir = join(root, entry.name);
			if (existsSync(join(dir, "index.html"))) sites.set(entry.name, { name: entry.name, file: join(dir, "index.html"), ...uiMeta(dir, null) });
		}
	}
	for (const root of CONTENT_ROOTS) {
		const dir = join(root, "games");
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || sites.has(entry.name)) continue;
			const gameUi = join(dir, entry.name, "ui");
			if (existsSync(join(gameUi, "index.html"))) sites.set(entry.name, { name: entry.name, file: join(gameUi, "index.html"), ...uiMeta(gameUi, [entry.name]) });
		}
	}
	return [...sites.values()];
}

/** 界面名清单（诊断文案用）。 */
const uiList = (): string => uiSites().map((s) => s.name).join(", ") || "无";

/** 设置按文件优先级读取（高优先在前）；破损设置视同缺席。 */
function loadSettings(): Record<string, unknown>[] {
	const files: Record<string, unknown>[] = [];
	for (const file of SETTINGS_FILES) {
		const read = readJsonObject(file);
		if (read !== null && read.value !== null) files.push(read.value);
	}
	return files;
}

/** 设置字符串键：按文件优先级，先见者胜。 */
function settingString(key: string): string | undefined {
	for (const parsed of loadSettings()) {
		const v = parsed[key];
		if (typeof v === "string") return v;
	}
	return undefined;
}

function settings(): Record<string, unknown> {
	return Object.assign({}, ...loadSettings().reverse());
}

/** 写入用户级设置文件：当前合并态 + patch；分发缺省因此固化到用户文件。 */
function saveSettings(patch: Record<string, unknown>): void {
	writeJson(SETTINGS_FILE, Object.assign(settings(), patch));
}

/** 初始界面：settings.json 指定者优先，其次唯一可用界面；解析失败回落壳内引导面。 */
function bootUi(): UiSite {
	const named = settingString("ui");
	if (named !== undefined) {
		const site = uiSite(named);
		if (site !== null) return site;
	}
	const sites = uiSites();
	if (sites.length === 1) return sites[0]!;
	if (sites.length === 0) throw new Error(`没有可用界面：在 ${UI_ROOTS.join(" 或 ")} 下放置 <name>/index.html，或在 games/<id>/ui 放置游戏自带界面`);
	throw new Error(`未指定界面：可用 ${sites.map((s) => s.name).join(", ")}；在 ${SETTINGS_FILE} 写入 { "ui": "<name>" }`);
}

let ui: UiSite | null = null;
let bootError: string | null = null;
try {
	ui = bootUi();
} catch (e) {
	bootError = errorText(e);
	console.error(bootError);
}

/** 配置面：settingsUi 指定的内容界面为皮肤层；缺席即壳内引导面。 */
function settingsSite(): UiSite | null {
	const name = settingString("settingsUi");
	if (name === undefined) return null;
	const site = uiSite(name);
	if (site === null) throw new Error(`未知配置界面：${name}（可用：${uiList()}）`);
	return site;
}

function windowOptions(): BrowserWindowConstructorOptions {
	return {
		backgroundColor: "#14161a",
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
		},
	};
}

/** 外链一律交系统浏览器：配置面的 OAuth 链接不开 Electron 子窗口；只放行 http(s)。 */
function externalLinks(w: BrowserWindow): void {
	w.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
}

function openSettings(): void {
	if (settingsWin !== null && !settingsWin.isDestroyed()) {
		settingsWin.focus();
		return;
	}
	const file = settingsSite()?.file ?? SETUP_FILE;
	settingsWin = new BrowserWindow({ ...windowOptions(), width: 720, height: 640 });
	externalLinks(settingsWin);
	settingsWin.on("closed", () => {
		settingsWin = null;
	});
	void settingsWin.loadFile(file);
}

/** 事件按实例身份分流；界面自行按 (game, run) 过滤。 */
async function createSession(game: string, run: string): Promise<Session> {
	const engine = await openRun(game, run, { root: DATA_ROOT, gameRoots: CONTENT_ROOTS, modelRuntime: await modelRuntime() });
	const session: Session = { game, run, engine, unsubscribe: () => {}, busy: null };
	session.unsubscribe = engine.subscribe((event) => win?.webContents.send("cave:event", { game, run, event }));
	sessions.set(sessionKey(game, run), session);
	return session;
}

/** 活实例或开启中的实例；未开即 undefined。 */
function active(game: string, run: string): Session | Promise<Session> | undefined {
	const key = sessionKey(game, run);
	return sessions.get(key) ?? opening.get(key);
}

/** 打开或附着：同一 (game, run) 复用同一活实例（并发 open 也只剩一个）。 */
function openSession(game: string, run: string): Promise<Session> {
	const found = active(game, run);
	if (found !== undefined) return Promise.resolve(found);
	const key = sessionKey(game, run);
	const started = createSession(game, run).finally(() => opening.delete(key));
	opening.set(key, started);
	return started;
}

/** state/act 只附着已打开的实例（附着中的 open 一并等）；未打开即拒绝，不隐式创建。 */
async function attached(game: string, run: string): Promise<Session> {
	const found = active(game, run);
	if (found !== undefined) return found;
	throw new Error(`未打开运行 ${game}/${run}：先 open(game, run)`);
}

function closeSession(game: string, run: string): void {
	const key = sessionKey(game, run);
	const session = sessions.get(key);
	if (session === undefined) return;
	if (session.busy !== null) throw new Error(`回合进行中（${session.busy}）：${game}/${run} 不能关闭`);
	sessions.delete(key);
	session.unsubscribe();
	session.engine.dispose();
}

/** 配置不齐（模型/凭据）：自动唤起配置面（若有）；失败文本自身给出文件与配置出口。 */
async function configured<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof ModelConfigError) {
			try {
				openSettings();
			} catch {
				// 无配置面可用
			}
		}
		throw e;
	}
}

/** 窗口关闭即释放全部实例；回合进行中的未竟调用随进程收束。 */
function closeAll(): void {
	const all = [...sessions.values()];
	sessions.clear();
	for (const session of all) {
		session.unsubscribe();
		session.engine.dispose();
	}
}

/** 实例坐标：snapshot 与会话清单共用。 */
function coords(session: Session): { game: string; run: string; turn: number; time: number } {
	return { game: session.game, run: session.run, turn: session.engine.turn, time: session.engine.sim.world.time };
}

/** 状态快照：视图与坐标由同一读态求值，与 act 结果同形。 */
function snapshot(session: Session): { game: string; run: string; turn: number; time: number; view: unknown } {
	return { ...coords(session), view: session.engine.sim.view() };
}

function pair(req: { game?: unknown; run?: unknown } | undefined): { game: string; run: string } {
	if (!segment(req?.game) || !segment(req?.run)) throw new Error("需要非空 game 与 run（路径段，不含分隔符）");
	return { game: req.game, run: req.run };
}

/** 可缺席的 game 字段：缺席即 undefined，非路径段即拒。 */
function gameId(req: { game?: unknown } | undefined, cmd: string): string | undefined {
	if (req?.game === undefined) return undefined;
	if (!segment(req.game)) throw new Error(`${cmd} 的 game 须为游戏 id`);
	return req.game;
}

/** 必填的 game 字段。 */
function requiredGame(req: { game?: unknown } | undefined, cmd: string): string {
	const game = gameId(req, cmd);
	if (game === undefined) throw new Error(`${cmd} 需要游戏 id`);
	return game;
}

/** 回合门：同一实例同时只容一个 act/narrate；校验归调用方。 */
async function turn<T>(game: string, run: string, kind: "act" | "narrate", body: (session: Session) => Promise<T>): Promise<T> {
	const session = await attached(game, run);
	if (session.busy !== null) throw new Error(`回合进行中（${session.busy}）：${game}/${run}`);
	session.busy = kind;
	try {
		return await body(session);
	} finally {
		session.busy = null;
	}
}

interface SlotFace {
	key: string;
	type: SlotDef["type"];
	many: boolean;
	strong?: boolean;
	label?: string | null;
}

/** 注册槽静态面：键、值域、重数、ref 生命周期与呈现名（label 缺席即该格类缺省）。 */
function slotFace(slots: Record<string, SlotDef> | undefined): SlotFace[] {
	return Object.entries(slots ?? {}).map(([key, d]) => ({
		key,
		type: d.type,
		many: d.many === true,
		...(d.type === "ref" && { strong: d.strong }),
		...(d.label !== undefined && { label: d.label }),
	}));
}

const uiFace = (site: UiSite): { name: string; game?: string[]; error?: string } => ({
	name: site.name,
	...(site.scope !== null && { game: site.scope }),
	...(site.error !== undefined && { error: site.error }),
});

ipcMain.handle("cave:games", () => listGames(CONTENT_ROOTS));

/** 存档清单：带 game 即只列该游戏；无记录目录不列。 */
ipcMain.handle("cave:runs", (_event, req: { game?: unknown } | undefined) => listRuns(DATA_ROOT, gameId(req, "runs")));

/** 回合记录原样读取（诊断面）：坏行计数显形；不装载 def、不重放、不改档案。 */
ipcMain.handle("cave:records", (_event, req: { game?: unknown; run?: unknown } | undefined) => {
	const { game, run } = pair(req);
	const path = runPaths(game, run, DATA_ROOT).records;
	if (!existsSync(path)) throw new Error(`运行 ${game}/${run} 无回合记录（${path}）`);
	const lines = parseRecordLines(readFileSync(path, "utf8"));
	const records = lines.flatMap((l) => (l.kind === "record" ? [l.record] : []));
	return { game, run, broken: lines.length - records.length, records };
});

/** 活实例清单：界面换装/重载后据此附着回既有实例。 */
ipcMain.handle("cave:sessions", () => [...sessions.values()].map((s) => ({ ...coords(s), busy: s.busy })));

/** 游戏目录事实：装载前可读（game.json），键由作者定义，壳不解释。 */
ipcMain.handle("cave:meta", (_event, req: { game?: unknown } | undefined) => {
	const game = requiredGame(req, "meta");
	const read = readGameMeta(game, CONTENT_ROOTS);
	if (read === null) throw new Error(`未知游戏：${game}（可用：${listGames(CONTENT_ROOTS).join(", ") || "无"}）`);
	return { game, meta: read.meta, ...(read.error !== undefined && { error: read.error }) };
});

/** 游戏的静态派生面：动词目录与注册槽名字；界面据此生成控件，不必硬编码。 */
ipcMain.handle("cave:def", async (_event, req: { game?: unknown } | undefined) => {
	const game = requiredGame(req, "def");
	const def = await loadGame(game, CONTENT_ROOTS);
	return { game, verbs: verbFace(def.verbs), props: slotFace(def.props), relTypes: slotFace(def.relTypes) };
});

/** 界面清单：带 game 即按作用域过滤（启动器菜单）；序稳定。 */
ipcMain.handle("cave:uis", (_event, req: { game?: unknown } | undefined) => {
	const game = gameId(req, "uis");
	const compatible = uiSites().filter((s) => s.scope === null || game === undefined || s.scope.includes(game));
	compatible.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return compatible.map(uiFace);
});

/** 换界面：只导航当前窗口，不动任何引擎；选择写入设置供下次启动。 */
ipcMain.handle("cave:use", (_event, req: { name?: unknown }) => {
	if (!segment(req?.name)) throw new Error("use 需要界面名");
	const site = uiSite(req.name);
	if (site === null) throw new Error(`未知界面：${req.name}（可用：${uiList()}）`);
	saveSettings({ ui: req.name });
	void win?.loadFile(site.file);
});

ipcMain.handle("cave:settings", () => settings());

ipcMain.handle("cave:env", () => ({ configDir: CONFIG_DIR }));

ipcMain.handle("cave:settings:set", async (_event, req: { patch?: unknown }) => {
	if (req?.patch === null || typeof req?.patch !== "object" || Array.isArray(req.patch)) throw new Error("settings:set 需要 patch 对象");
	const patch = { ...(req.patch as Record<string, unknown>) };
	for (const key of ["ui", "settingsUi"] as const) {
		const name = patch[key];
		if (typeof name === "string" && uiSite(name) === null) throw new Error(`未知界面（${key}）：${name}（可用：${uiList()}）`);
	}
	if (typeof patch.model === "string") {
		const { model, error } = resolveCliModel({ cliModel: patch.model, modelRuntime: await modelRuntime() });
		if (!model || error) throw new Error(`模型 "${patch.model}" 不可用：${modelErrorReason(error)}`);
	}
	saveSettings(patch);
	return settings();
});

ipcMain.handle("cave:settings:open", () => openSettings());

ipcMain.handle("cave:open", async (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	const session = await openSession(game, run);
	return { ...snapshot(session), warnings: [...session.engine.loadWarnings] };
});

/** 显式释放：不关别人的实例，也不动档案。 */
ipcMain.handle("cave:close", (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	closeSession(game, run);
});

ipcMain.handle("cave:act", async (_event, req: { game?: unknown; run?: unknown; utterance?: unknown }) => {
	const { game, run } = pair(req);
	if (typeof req?.utterance !== "string" || req.utterance.trim() === "") throw new Error("act 需要非空 utterance");
	const utterance = req.utterance;
	return turn(game, run, "act", async (session) => {
		const outcome = await configured(() => session.engine.act({ utterance }));
		return { ...snapshot(session), steps: outcome.steps, lines: outcome.lines, reveals: outcome.reveals, narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage };
	});
});

ipcMain.handle("cave:narrate", async (_event, req: { game?: unknown; run?: unknown; instruction?: unknown }) => {
	const { game, run } = pair(req);
	if (typeof req?.instruction !== "string" || req.instruction.trim() === "") throw new Error("narrate 需要非空 instruction");
	const instruction = req.instruction;
	return turn(game, run, "narrate", async (session) => {
		const outcome = await configured(() => session.engine.narrate(instruction));
		return { narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage };
	});
});

ipcMain.handle("cave:state", async (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	return snapshot(await attached(game, run));
});

app.whenReady().then(() => {
	installAuth(modelRuntime);
	win = new BrowserWindow({ ...windowOptions(), width: 1200, height: 820 });
	externalLinks(win);
	win.on("closed", () => {
		win = null;
		closeAll();
	});
	if (ui !== null) void win.loadFile(ui.file);
	else void win.loadFile(SETUP_FILE, { query: { boot: "1", error: bootError ?? "未解析到界面" } });
});

app.on("window-all-closed", () => app.quit());
