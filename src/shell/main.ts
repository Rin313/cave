import { app, BrowserWindow, dialog, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Engine } from "../core/engine.ts";
import { listGames, loadGame } from "../core/games.ts";
import { errorText, spineLines, verbFace, type SlotDef } from "../core/sim.ts";
import { configDir, dataDir } from "../core/paths.ts";
import { listRuns, ModelConfigError, modelErrorReason, openModelRuntime, openRun, runPaths } from "../core/runs.ts";
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
const GAME_ROOTS = CONTENT_ROOTS;
const UI_ROOTS = CONTENT_ROOTS.map((root) => join(root, "ui"));
/** 配置根（用户级全局）：凭据、模型与界面偏好，与 CLI 共用；运行数据（runs）另按数据根。 */
const CONFIG_DIR = configDir(USER_DATA);
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");
/** 设置查序：用户配置 → 分发缺省（仅打包）。 */
const SETTINGS_FILES = app.isPackaged ? [SETTINGS_FILE, join(RESOURCE_ROOT, "settings.json")] : [SETTINGS_FILE];

let runtime: Promise<ModelRuntime> | null = null;
/** 壳与所有引擎共享同一模型运行时：配置协议写入的凭据对所有后续 open 立即生效。 */
function modelRuntime(): Promise<ModelRuntime> {
	const pending = runtime ?? openModelRuntime(CONFIG_DIR);
	runtime = pending;
	return pending;
}

/** 路径段：id 不做路径解析。 */
function segment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

/** 界面作用域：null 即通用；游戏自带界面缺省绑定其 game，ui.json 的 game 可覆盖或扩为多个。坏元数据回落隐式作用域并携错，界面不因此不可用。 */
function uiMeta(dir: string, implicit: string[] | null): { scope: string[] | null; error?: string } {
	const file = join(dir, "ui.json");
	if (!existsSync(file)) return { scope: implicit };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { scope: implicit, error: `界面元数据解析失败（${file}）：${errorText(e)}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { scope: implicit, error: `界面元数据须为对象（${file}）` };
	const declared = (parsed as { game?: unknown }).game;
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
	for (const root of GAME_ROOTS) {
		const dir = join(root, "games", name, "ui");
		const file = join(dir, "index.html");
		if (existsSync(file)) return { name, file, ...uiMeta(dir, [name]) };
	}
	return null;
}

/** 全部界面名（遮蔽后的全集，插入序即优先级）。 */
function uiNames(): string[] {
	const names = new Set<string>();
	for (const root of UI_ROOTS) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(root, entry.name, "index.html"))) names.add(entry.name);
		}
	}
	for (const root of GAME_ROOTS) {
		const dir = join(root, "games");
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(dir, entry.name, "ui", "index.html"))) names.add(entry.name);
		}
	}
	return [...names];
}

/** 设置按文件优先级读取（高优先在前）；破损设置视同缺席，启动失败信息会列出可用界面。 */
function loadSettings(): Record<string, unknown>[] {
	const files: Record<string, unknown>[] = [];
	for (const file of SETTINGS_FILES) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) files.push(parsed as Record<string, unknown>);
		} catch {
			// 破损设置视同缺席
		}
	}
	return files;
}

function readUiSetting(): string | undefined {
	for (const parsed of loadSettings()) if (typeof parsed.ui === "string") return parsed.ui;
	return undefined;
}

/** 按 game 的界面偏好：高优先文件先见，逐 game 覆盖。 */
function readUiChoice(game: string): string | undefined {
	for (const parsed of loadSettings()) {
		const uis = parsed.uis;
		if (uis === null || typeof uis !== "object" || Array.isArray(uis)) continue;
		const name = (uis as Record<string, unknown>)[game];
		if (typeof name === "string") return name;
	}
	return undefined;
}

function settings(): Record<string, unknown> {
	return Object.assign({}, ...loadSettings().reverse());
}

/** 写入用户级设置文件：当前合并态 + patch；分发缺省因此固化到用户文件。 */
function saveSettings(patch: Record<string, unknown>): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(Object.assign(settings(), patch), null, "\t")}\n`, "utf8");
}

/** 初始界面：settings.json 指定者优先，其次唯一可用界面；不猜、不兜底（shell 不自带界面）。 */
function bootUi(): UiSite {
	const named = readUiSetting();
	if (named !== undefined) {
		const site = uiSite(named);
		if (site !== null) return site;
	}
	const sites = uiNames().map(uiSite).filter((s): s is UiSite => s !== null);
	if (sites.length === 1) return sites[0]!;
	if (sites.length === 0) throw new Error(`没有可用界面：在 ${UI_ROOTS.join(" 或 ")} 下放置 <name>/index.html，或在 games/<id>/ui 放置游戏自带界面`);
	throw new Error(`未指定界面：可用 ${sites.map((s) => s.name).join(", ")}；在 ${SETTINGS_FILE} 写入 { "ui": "<name>" } 或 { "uis": { "<game>": "<name>" } }`);
}

let ui: UiSite;
try {
	ui = bootUi();
} catch (e) {
	console.error(errorText(e));
	dialog.showErrorBox("cave 无法启动", errorText(e));
	process.exit(2);
}

/** 配置面是内容：settingsUi 指定，缺省保留名 settings；壳不渲染也不解释其内部。 */
function configUiName(): string {
	for (const parsed of loadSettings()) {
		const name = parsed.settingsUi;
		if (typeof name === "string") {
			if (uiSite(name) === null) throw new Error(`未知配置界面：${name}（可用：${uiNames().join(", ") || "无"}）`);
			return name;
		}
	}
	if (uiSite("settings") !== null) return "settings";
	throw new Error(`没有配置界面：${UI_ROOTS.join(" 或 ")} 下放置 settings/index.html，或在 ${SETTINGS_FILE} 写入 { "settingsUi": "<name>" }；也可直接配置 ${SETTINGS_FILE} 与 ${join(CONFIG_DIR, "auth.json")}（与 CLI 共用）`);
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
	const site = uiSite(configUiName());
	if (site === null) throw new Error("配置界面不可用");
	if (settingsWin !== null && !settingsWin.isDestroyed()) {
		settingsWin.focus();
		return;
	}
	settingsWin = new BrowserWindow({ ...windowOptions(), width: 720, height: 640 });
	externalLinks(settingsWin);
	settingsWin.on("closed", () => {
		settingsWin = null;
	});
	void settingsWin.loadFile(site.file);
}

/** 事件按实例身份分流；界面自行按 (game, run) 过滤。 */
async function createSession(game: string, run: string): Promise<Session> {
	const engine = await openRun(game, run, { root: DATA_ROOT, gameRoots: GAME_ROOTS, modelRuntime: await modelRuntime() });
	const session: Session = { game, run, engine, unsubscribe: () => {}, busy: null };
	session.unsubscribe = engine.subscribe((event) => win?.webContents.send("cave:event", { game, run, event }));
	sessions.set(sessionKey(game, run), session);
	return session;
}

/** 打开或附着：同一 (game, run) 复用同一活实例（并发 open 也只剩一个）。 */
function openSession(game: string, run: string): Promise<Session> {
	const key = sessionKey(game, run);
	const ready = sessions.get(key);
	if (ready !== undefined) return Promise.resolve(ready);
	const pending = opening.get(key);
	if (pending !== undefined) return pending;
	const started = createSession(game, run).finally(() => opening.delete(key));
	opening.set(key, started);
	return started;
}

/** state/act 只附着已打开的实例（附着中的 open 一并等）；未打开即拒绝，不隐式创建。 */
async function attached(game: string, run: string): Promise<Session> {
	const key = sessionKey(game, run);
	const ready = sessions.get(key);
	if (ready !== undefined) return ready;
	const pending = opening.get(key);
	if (pending !== undefined) return pending;
	throw new Error(`未打开运行 ${game}/${run}：先 open(game, run)`);
}

function closeSession(game: string, run: string): void {
	const session = sessions.get(sessionKey(game, run));
	if (session === undefined) return;
	if (session.busy !== null) throw new Error(`回合进行中（${session.busy}）：${game}/${run} 不能关闭或重置`);
	sessions.delete(sessionKey(game, run));
	session.unsubscribe();
	session.engine.dispose();
}

/** 窗口关闭即释放全部实例；回合进行中的未竟调用随进程收束。 */
function closeAll(): void {
	for (const session of [...sessions.values()]) {
		sessions.delete(sessionKey(session.game, session.run));
		session.unsubscribe();
		session.engine.dispose();
	}
}

/** 状态快照：视图与坐标由同一读态求值，与 act 结果同形。 */
function snapshot(session: Session): { game: string; run: string; turn: number; time: number; view: unknown } {
	return { game: session.game, run: session.run, turn: session.engine.turn, time: session.engine.sim.world.time, view: session.engine.sim.view() };
}

function pair(req: { game?: unknown; run?: unknown } | undefined): { game: string; run: string } {
	if (!segment(req?.game) || !segment(req?.run)) throw new Error("需要非空 game 与 run（路径段，不含分隔符）");
	return { game: req.game, run: req.run };
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

ipcMain.handle("cave:games", () => listGames(GAME_ROOTS));

/** 存档清单：带 game 即只列该游戏；无记录目录不列。 */
ipcMain.handle("cave:runs", (_event, req: { game?: unknown } | undefined) => {
	const game = req?.game;
	if (game !== undefined && !segment(game)) throw new Error("runs 的 game 须为游戏 id");
	return listRuns(DATA_ROOT, game);
});

/** 活实例清单：界面换装/重载后据此附着回既有实例。 */
ipcMain.handle("cave:sessions", () => [...sessions.values()].map((s) => ({ game: s.game, run: s.run, turn: s.engine.turn, time: s.engine.sim.world.time, busy: s.busy })));

/** 游戏的静态派生面：动词目录与注册槽名字；界面据此生成控件，不必硬编码。 */
ipcMain.handle("cave:def", async (_event, req: { game?: unknown } | undefined) => {
	if (!segment(req?.game)) throw new Error("def 需要游戏 id");
	const def = await loadGame(req.game, GAME_ROOTS);
	return { game: req.game, verbs: verbFace(def.verbs), props: slotFace(def.props), relTypes: slotFace(def.relTypes) };
});

/** 界面清单：带 game 即按作用域过滤（启动器菜单），用户偏好置顶；序稳定。 */
ipcMain.handle("cave:uis", (_event, req: { game?: unknown } | undefined) => {
	const game = req?.game;
	if (game !== undefined && !segment(game)) throw new Error("uis 的 game 须为游戏 id");
	const sites = uiNames().map(uiSite).filter((s): s is UiSite => s !== null);
	const compatible = sites.filter((s) => s.scope === null || game === undefined || s.scope.includes(game));
	compatible.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (game !== undefined) {
		const chosen = readUiChoice(game);
		if (chosen !== undefined) {
			const site = uiSite(chosen);
			if (site !== null) return [uiFace(site), ...compatible.filter((s) => s.name !== site.name).map(uiFace)];
		}
	}
	return compatible.map(uiFace);
});

/** 换界面：只导航当前窗口，不动任何引擎；选择写入设置供下次启动。 */
ipcMain.handle("cave:use", (_event, req: { name?: unknown }) => {
	if (!segment(req?.name)) throw new Error("use 需要界面名");
	const site = uiSite(req.name);
	if (site === null) throw new Error(`未知界面：${req.name}（可用：${uiNames().join(", ") || "无"}）`);
	saveSettings({ ui: req.name });
	void win?.loadFile(site.file);
});

ipcMain.handle("cave:settings", () => settings());

ipcMain.handle("cave:settings:set", async (_event, req: { patch?: unknown }) => {
	if (req?.patch === null || typeof req?.patch !== "object" || Array.isArray(req.patch)) throw new Error("settings:set 需要 patch 对象");
	const patch = { ...(req.patch as Record<string, unknown>) };
	for (const key of ["ui", "settingsUi"] as const) {
		const name = patch[key];
		if (typeof name === "string" && uiSite(name) === null) throw new Error(`未知界面（${key}）：${name}（可用：${uiNames().join(", ") || "无"}）`);
	}
	if (patch.uis !== undefined) {
		const uis = patch.uis;
		if (uis === null || typeof uis !== "object" || Array.isArray(uis)) throw new Error("uis 须为 { <game>: <界面名> }");
		for (const [game, name] of Object.entries(uis as Record<string, unknown>)) {
			if (!segment(game) || !segment(name) || uiSite(name) === null) throw new Error(`未知界面偏好：${game} → ${String(name)}`);
		}
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
	let session: Session;
	try {
		session = await openSession(game, run);
	} catch (e) {
		// 配置不齐：自动唤起配置面（若有）；失败文本自身给出文件与 CLI 出口
		if (e instanceof ModelConfigError) {
			try {
				openSettings();
			} catch {
				// 无配置面可用
			}
		}
		throw e;
	}
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
	const session = await attached(game, run);
	if (session.busy !== null) throw new Error(`回合进行中（${session.busy}）：${game}/${run}`);
	session.busy = "act";
	try {
		const outcome = await session.engine.act({ utterance: req.utterance });
		const warnings = [...outcome.warnings];
		// 两相投影各自降级：账目已在定稿，呈现失灵不得使已入账回合变成调用失败
		let lines: string[] = [];
		let reveals: unknown[] = [];
		try {
			lines = spineLines(session.engine.sim, outcome.steps, session.engine.sim.snapshot());
		} catch (e) {
			warnings.push(`事件投影抛错：${errorText(e)}`);
		}
		try {
			reveals = session.engine.sim.reveals(outcome.steps);
		} catch (e) {
			warnings.push(`新见段投影抛错：${errorText(e)}`);
		}
		return { ...snapshot(session), steps: outcome.steps, lines, reveals, narration: outcome.narration, warnings, usage: outcome.usage };
	} finally {
		session.busy = null;
	}
});

ipcMain.handle("cave:narrate", async (_event, req: { game?: unknown; run?: unknown; instruction?: unknown }) => {
	const { game, run } = pair(req);
	if (typeof req?.instruction !== "string" || req.instruction.trim() === "") throw new Error("narrate 需要非空 instruction");
	const session = await attached(game, run);
	if (session.busy !== null) throw new Error(`回合进行中（${session.busy}）：${game}/${run}`);
	session.busy = "narrate";
	try {
		const outcome = await session.engine.narrate(req.instruction);
		return { narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage };
	} finally {
		session.busy = null;
	}
});

ipcMain.handle("cave:state", async (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	return snapshot(await attached(game, run));
});

ipcMain.handle("cave:reset", (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	closeSession(game, run);
	rmSync(runPaths(game, run, DATA_ROOT).dir, { recursive: true, force: true });
});

app.whenReady().then(() => {
	installAuth(modelRuntime);
	win = new BrowserWindow({ ...windowOptions(), width: 1200, height: 820 });
	externalLinks(win);
	win.on("closed", () => {
		win = null;
		closeAll();
	});
	void win.loadFile(ui.file);
});

app.on("window-all-closed", () => app.quit());
