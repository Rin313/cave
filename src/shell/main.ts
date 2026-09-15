import { app, BrowserWindow, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readRecords } from "../core/archive.ts";
import type { ActOutcome, Engine, NarrationOutcome } from "../core/engine.ts";
import { listGames, loadGame, readGameMeta } from "../core/games.ts";
import { verbFace, type SlotDef } from "../core/sim.ts";
import { isSegment, recordsPath, rootDir } from "../core/paths.ts";
import { listRuns, ModelConfigError, openModelRuntime, openRun } from "../core/runs.ts";
import { patchSettings, readSettings, settingsPath, stringSetting, type Settings } from "../core/settings.ts";
import { installModel } from "./model.ts";

if (!app.requestSingleInstanceLock()) app.exit(0);

interface Session {
	game: string;
	run: string;
	engine: Engine;
	unsubscribe: () => void;
}

/** 会话槽：opened 恒为本次打开的结果；session 落定后可用；关闭即除名。 */
interface SessionSlot {
	readonly game: string;
	readonly run: string;
	readonly opened: Promise<Session>;
	session: Session | null;
}

/** 会话单表：键为 (game, run)；两段均为路径段（isSegment），拼接无歧义。 */
const sessions = new Map<string, SessionSlot>();
const sessionKey = (game: string, run: string): string => `${game}/${run}`;

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

/** 第二实例聚焦主窗（主窗缺席即应用正在收束）；写者唯一由单实例锁保证。 */
app.on("second-instance", () => {
	if (win === null || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	win.focus();
});

/** 根：games、runs 与配置（settings、auth、models）的共同所在；缺省取宿主用户数据目录。 */
const ROOT = rootDir(app.getPath("userData"));
/** 分发资源根：打包取 asar 之外的安装资源目录，dev 取应用路径（仓库）；游戏与界面随此分发。 */
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : app.getAppPath();
/** 内容根：根（用户覆盖）→ 分发资源根；同名前者遮蔽后者。 */
const CONTENT_ROOTS = [...new Set([ROOT, RESOURCE_ROOT])];
const SETTINGS_FILE = settingsPath(ROOT);
/** 分发缺省：位于资源根、只读；用户文件只存覆盖，故缺省可随包更新；文件缺席即无此层。 */
const SETTINGS_DEFAULT = join(RESOURCE_ROOT, "settings.json");
const SETTINGS_DEFAULTS = existsSync(SETTINGS_DEFAULT) ? [SETTINGS_DEFAULT] : [];
/** 壳内引导面：随包分发、不属内容、不可遮蔽；配置正确性的兜底，呈现可被 settingsUi 替换。 */
const SETUP_FILE = join(import.meta.dirname, "setup.html");

let runtime: Promise<ModelRuntime> | null = null;
/** 壳与所有引擎共享同一模型运行时：凭据写入对所有后续建会话生效；失败归配置错误（引向配置面）并弃置，下次重试。 */
function modelRuntime(): Promise<ModelRuntime> {
	if (runtime === null) {
		runtime = openModelRuntime(ROOT).catch((e: unknown) => {
			runtime = null;
			throw new ModelConfigError(`模型运行时不可用：${String(e)}`);
		});
	}
	return runtime;
}

interface UiSite {
	name: string;
	file: string;
	/** 作用域由位置给出：games/<id>/ui 下即绑定 id。 */
	game: string;
}

/** 界面 ref：`<game>/<name>`；两段均来自目录名，不含斜杠。 */
const uiRef = (site: UiSite): string => `${site.game}/${site.name}`;

/** 全部界面（ref 去重、先见者优先）：games/<id>/ui/index.html 为名即 id 的缺省界面，games/<id>/ui/<name>/index.html 为具名界面。 */
function uiRegistry(): ReadonlyMap<string, UiSite> {
	const sites = new Map<string, UiSite>();
	const add = (site: UiSite): void => {
		const ref = uiRef(site);
		if (!sites.has(ref)) sites.set(ref, site);
	};
	const scan = (base: string, game: string): void => {
		if (!existsSync(base)) return;
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const file = join(base, entry.name, "index.html");
			if (existsSync(file)) add({ name: entry.name, file, game });
		}
	};
	for (const root of CONTENT_ROOTS) {
		const dir = join(root, "games");
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const ui = join(dir, entry.name, "ui");
			const file = join(ui, "index.html");
			if (existsSync(file)) add({ name: entry.name, file, game: entry.name });
			scan(ui, entry.name);
		}
	}
	return sites;
}

/** 界面 ref 清单（诊断文案用）。 */
const uiList = (sites: ReadonlyMap<string, UiSite>): string => [...sites.keys()].join(", ") || "无";

const settings = (): Settings => readSettings(ROOT, SETTINGS_DEFAULTS);

/** 写入用户层（只存覆盖，分发缺省不固化）；返回写入后的合并态。 */
function saveSettings(patch: Settings): Settings {
	return patchSettings(ROOT, patch, SETTINGS_DEFAULTS);
}

/** 初始界面：settings.json 指定者优先，其次唯一可用界面；解析失败回落壳内引导面。 */
function bootUi(): UiSite {
	const named = stringSetting(settings(), "ui");
	const sites = uiRegistry();
	let why = "未指定界面";
	if (named !== undefined) {
		const site = sites.get(named);
		if (site !== undefined) return site;
		why = `设置的界面 ${named} 不存在`;
		console.error(`${why}（可用：${uiList(sites)}）：回落自动解析`);
	}
	const all = [...sites.values()];
	if (all.length === 1) return all[0]!;
	if (all.length === 0) throw new Error(`没有可用界面：在 ${CONTENT_ROOTS.map((root) => join(root, "games")).join(" 或 ")} 下任一 <id>/ui 放置 index.html（缺省）或 <name>/index.html`);
	throw new Error(`${why}：可用 ${uiList(sites)}；在 ${SETTINGS_FILE} 写入 { "ui": "<game>/<name>" }`);
}

let ui: UiSite | null = null;
let bootError: string | null = null;
try {
	ui = bootUi();
} catch (e) {
	bootError = String(e);
	console.error(bootError);
}

/** 配置面：settingsUi 指定的内容界面为皮肤层；缺席或失效即壳内引导面（配置面是兜底，不因设置失效而锁死）。 */
function settingsSite(): UiSite | null {
	const ref = stringSetting(settings(), "settingsUi");
	if (ref === undefined) return null;
	const sites = uiRegistry();
	const site = sites.get(ref);
	if (site === undefined) {
		console.error(`未知配置界面：${ref}（可用：${uiList(sites)}）：回落壳内引导面`);
		return null;
	}
	return site;
}

function windowOptions(): BrowserWindowConstructorOptions {
	return {
		show: false,
		backgroundColor: "#14161a",
		// 菜单隐藏但保留默认角色：重载/DevTools/缩放快捷键仍有效，Alt 可唤出，常驻视觉噪音消失。
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
		},
	};
}

/** 窗口共同纪律：首帧渲染完成后再显示（不闪底色）；页面不得自行导航（同址重载除外），http(s) 交系统浏览器；内容不得否决关闭。 */
function bindWindow(w: BrowserWindow): void {
	w.once("ready-to-show", () => w.show());
	const external = (url: string): void => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url);
	};
	w.webContents.setWindowOpenHandler(({ url }) => {
		external(url);
		return { action: "deny" };
	});
	// location.reload() 同走 will-navigate：同址放行（重载），其余一律拒绝；换界面由主进程 loadFile（不触发本事件）。
	w.webContents.on("will-navigate", (event) => {
		if (event.url === w.webContents.getURL()) return;
		event.preventDefault();
		external(event.url);
	});
	w.webContents.on("will-prevent-unload", (event) => event.preventDefault());
}

function loadPage(w: BrowserWindow, file: string, query?: Record<string, string>): void {
	const job = query === undefined ? w.loadFile(file) : w.loadFile(file, { query });
	void job.catch((e: unknown) => console.error(`界面装载失败（${file}）：${String(e)}`));
}

function openSettings(): void {
	if (settingsWin !== null && !settingsWin.isDestroyed()) {
		settingsWin.focus();
		return;
	}
	const file = settingsSite()?.file ?? SETUP_FILE;
	settingsWin = new BrowserWindow({ ...windowOptions(), width: 720, height: 640 });
	bindWindow(settingsWin);
	settingsWin.on("closed", () => {
		settingsWin = null;
	});
	loadPage(settingsWin, file);
}

/** 事件按实例身份分流；界面自行按 (game, run) 过滤。 */
async function createSession(game: string, run: string): Promise<Session> {
	const engine = await openRun(game, run, { root: ROOT, gameRoots: CONTENT_ROOTS, settingLayers: SETTINGS_DEFAULTS, modelRuntime });
	const unsubscribe = engine.subscribe((event) => {
		if (win !== null && !win.isDestroyed()) win.webContents.send("event", { game, run, event });
	});
	return { game, run, engine, unsubscribe };
}

/** 建槽：并发首调只建一次；失败释放位置（打开中不可关闭，故释放无需复核表项身份）。 */
function slotOf(game: string, run: string): SessionSlot {
	const key = sessionKey(game, run);
	const found = sessions.get(key);
	if (found !== undefined) return found;
	const opened = createSession(game, run);
	const slot: SessionSlot = { game, run, opened, session: null };
	sessions.set(key, slot);
	opened.then(
		(session) => {
			slot.session = session;
		},
		() => {
			sessions.delete(key);
		},
	);
	return slot;
}

/** 打开或附着：同一 (game, run) 复用同一活实例（并发 open 也只剩一个）；返回必为表内活实例。 */
async function openSession(game: string, run: string): Promise<Session> {
	slotOf(game, run);
	return attached(game, run);
}

/** state/act 只附着已打开的实例（打开中一并等）；未打开即拒绝，不隐式创建。 */
async function attached(game: string, run: string): Promise<Session> {
	const slot = sessions.get(sessionKey(game, run));
	if (slot === undefined) throw new Error(`未打开运行 ${game}/${run}：先 open(game, run)`);
	return slot.session ?? await slot.opened;
}

/** 关闭是显式的：打开中与回合进行中都拒绝；成功即除名释放（引擎自持回合互斥）。 */
function closeSession(game: string, run: string): void {
	const key = sessionKey(game, run);
	const slot = sessions.get(key);
	if (slot === undefined) return;
	const session = slot.session;
	if (session === null) throw new Error(`运行 ${game}/${run} 正在打开：待落定后再关闭`);
	session.engine.dispose();
	sessions.delete(key);
	session.unsubscribe();
}

/** 实例坐标：快照与会话清单共用。 */
function coords(session: Session): { game: string; run: string; time: number } {
	return { game: session.game, run: session.run, time: session.engine.sim.world.time };
}

/** 状态快照：视图与坐标由同一读态求值。 */
function face(session: Session): { game: string; run: string; time: number; view: unknown } {
	return { ...coords(session), view: session.engine.sim.view() };
}

/** IPC 载荷不可信：只声明形状，语义逐命令校验。 */
type GameRequest = { game?: unknown };
type RunRequest = GameRequest & { run?: unknown };

/** 非空字符串字段（trim 后非空）：IPC 边界校验，返回原值。 */
function strIn(value: unknown, cmd: string, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${cmd} 的 ${field} 须为非空字符串`);
	return value;
}

/** 可缺席的 game 字段：缺席即 undefined，非路径段即拒。 */
function idIn(req: GameRequest | undefined, cmd: string): string | undefined {
	if (req?.game === undefined) return undefined;
	if (!isSegment(req.game)) throw new Error(`${cmd} 的 game 须为游戏 id`);
	return req.game;
}

/** 必填的 game 与 run 字段。 */
function idsIn(req: RunRequest | undefined, cmd: string): { game: string; run: string } {
	const game = idIn(req, cmd);
	if (game === undefined) throw new Error(`${cmd} 需要游戏 id`);
	if (!isSegment(req?.run)) throw new Error(`${cmd} 的 run 须为存档 id（路径段，不含分隔符）`);
	return { game, run: req.run };
}

/** 注册槽静态面：核心 SlotDef 加内部键；界面据此生成控件。 */
type SlotFace = SlotDef & { key: string };

function slotFace(slots: Record<string, SlotDef> | undefined): SlotFace[] {
	return Object.entries(slots ?? {}).map(([key, d]) => ({ key, ...d }));
}

const uiFace = (site: UiSite): { name: string; ref: string; game: string } => ({ name: site.name, ref: uiRef(site), game: site.game });

ipcMain.handle("games", () => listGames(CONTENT_ROOTS));

/** 存档清单：带 game 即只列该游戏；无记录目录不列。 */
ipcMain.handle("runs", (_event, req: GameRequest | undefined) => listRuns(ROOT, idIn(req, "runs")));

/** 回合记录原样读取（诊断面）：不装载 def、不重放、不改档案；坏行只计数。 */
ipcMain.handle("records", (_event, req: RunRequest | undefined) => {
	const { game, run } = idsIn(req, "records");
	const path = recordsPath(game, run, ROOT);
	const read = readRecords(path);
	if (read === null) throw new Error(`运行 ${game}/${run} 无回合记录（${path}）`);
	return { game, run, ...read };
});

/** 活实例清单（含打开中）：界面换装/重载后据此附着回既有实例。 */
ipcMain.handle("sessions", () => [...sessions.values()].map((slot) => {
	const { session } = slot;
	return session === null ? { game: slot.game, run: slot.run, opening: true } : { ...coords(session), busy: session.engine.busy };
}));

/** 游戏目录事实：装载前可读（game.json），键由作者定义，壳不解释。 */
ipcMain.handle("meta", (_event, req: GameRequest | undefined) => {
	const game = idIn(req, "meta");
	if (game === undefined) throw new Error("meta 需要游戏 id");
	const read = readGameMeta(game, CONTENT_ROOTS);
	if (read === null) throw new Error(`未知游戏：${game}（可用：${listGames(CONTENT_ROOTS).join(", ") || "无"}）`);
	return { game, meta: read.meta, ...(read.error !== undefined && { error: read.error }) };
});

/** 游戏的静态派生面：动词目录与注册槽名字；界面据此生成控件，不必硬编码。 */
ipcMain.handle("def", async (_event, req: GameRequest | undefined) => {
	const game = idIn(req, "def");
	if (game === undefined) throw new Error("def 需要游戏 id");
	const def = await loadGame(game, CONTENT_ROOTS);
	return { game, verbs: verbFace(def.verbs), props: slotFace(def.props), relTypes: slotFace(def.relTypes) };
});

/** 界面清单：带 game 即按作用域过滤（启动器菜单）；序稳定。 */
ipcMain.handle("uis", (_event, req: GameRequest | undefined) => {
	const game = idIn(req, "uis");
	const compatible = [...uiRegistry().values()].filter((s) => game === undefined || s.game === game);
	compatible.sort((a, b) => (uiRef(a) < uiRef(b) ? -1 : uiRef(a) > uiRef(b) ? 1 : 0));
	return compatible.map(uiFace);
});

/** 换界面：只导航当前窗口，不动任何引擎；选择写入设置供下次启动。 */
ipcMain.handle("use", (_event, req: { ref?: unknown }) => {
	const ref = strIn(req?.ref, "use", "ref");
	const sites = uiRegistry();
	const site = sites.get(ref);
	if (site === undefined) throw new Error(`未知界面：${ref}（可用：${uiList(sites)}）`);
	saveSettings({ ui: ref });
	if (win !== null && !win.isDestroyed()) loadPage(win, site.file);
});

ipcMain.handle("settings", () => settings());

ipcMain.handle("env", () => ({ root: ROOT }));

/** 打开根下目录（不存在即建）：界面据此暴露内容与配置的可写位置。 */
ipcMain.handle("reveal", (_event, req: { dir?: unknown }) => {
	const dir = req?.dir ?? "";
	if (typeof dir !== "string" || (dir !== "" && !isSegment(dir))) throw new Error("reveal 的 dir 须为根下的路径段");
	const path = join(ROOT, dir);
	mkdirSync(path, { recursive: true });
	return shell.openPath(path);
});

/** 写入是哑的：patch 原样落用户层，宿主键的有效性由消费处解析（bootUi/settingsSite 回落、建会话的 ModelConfigError）；ui 归 use（写+导航）。 */
ipcMain.handle("settings:set", (_event, req: { patch?: unknown }) => {
	if (req?.patch === null || typeof req?.patch !== "object" || Array.isArray(req.patch)) throw new Error("settings:set 需要 patch 对象");
	const patch = { ...(req.patch as Record<string, unknown>) };
	if (patch.ui !== undefined) throw new Error("ui 只经 use 切换：settings:set 不接受 ui");
	return saveSettings(patch);
});

ipcMain.handle("settings:open", () => openSettings());

ipcMain.handle("open", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "open");
	const session = await openSession(game, run);
	return { ...face(session), warnings: [...session.engine.loadWarnings] };
});

/** 显式释放：不动档案。 */
ipcMain.handle("close", (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "close");
	return closeSession(game, run);
});

ipcMain.handle("act", async (_event, req: RunRequest & { utterance?: unknown }) => {
	const { game, run } = idsIn(req, "act");
	const utterance = strIn(req?.utterance, "act", "utterance");
	const session = await attached(game, run);
	const outcome: ActOutcome = await session.engine.act({ utterance });
	return { ...face(session), ...outcome };
});

ipcMain.handle("narrate", async (_event, req: RunRequest & { instruction?: unknown }) => {
	const { game, run } = idsIn(req, "narrate");
	const instruction = strIn(req?.instruction, "narrate", "instruction");
	const session = await attached(game, run);
	const outcome: NarrationOutcome = await session.engine.narrate(instruction);
	return outcome;
});

ipcMain.handle("state", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "state");
	return face(await attached(game, run));
});

app.whenReady().then(() => {
	installModel(modelRuntime);
	win = new BrowserWindow({ ...windowOptions(), width: 1200, height: 820 });
	bindWindow(win);
	// 主窗关闭＝结束应用：实例随进程收束，不存在无主窗的存活态。
	win.on("closed", () => {
		win = null;
		app.quit();
	});
	if (ui !== null) loadPage(win, ui.file);
	else loadPage(win, SETUP_FILE, { boot: "1", error: bootError ?? "未解析到界面" });
});
