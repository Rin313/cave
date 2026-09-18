import { app, BrowserWindow, dialog, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocsPath, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openArchive } from "../core/archive.ts";
import { Engine, type ActOutcome, type AgentSpec } from "../core/engine.ts";
import * as sim from "../core/sim.ts";
import { installModel, isThinkingLevel, modelRef, openModelRuntime, supportedThinkingLevels, type ModelFace, type ThinkingLevel } from "./model.ts";

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

/** 第二实例聚焦主窗（主窗缺席即应用正在收束）；写者唯一由单实例锁保证。 */
app.on("second-instance", () => {
	if (win === null || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	win.focus();
});

/** 根：games、runs 与配置（settings、auth、models）的共同所在；即宿主用户数据目录（--user-data-dir 可覆盖）。 */
const ROOT = app.getPath("userData");
const SETTINGS_FILE = join(ROOT, "settings.json");

/** 路径段：id 不做路径解析。 */
function isSegment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
}

function runsDir(root: string, game?: string): string {
	const base = join(root, "runs");
	return game === undefined ? base : join(base, game);
}

function recordsPath(root: string, game: string, run: string): string {
	return join(runsDir(root, game), run, "records.jsonl");
}

/** 目录下的直接子目录名；目录缺席即空。 */
function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** 内容应用面：存在即为主面（启动、home 与游戏界面失败回落的落点）；启动器仅在缺席、故障或内容显式调用时出现。 */
const APP_FILE = join(ROOT, "ui", "index.html");
/** 壳内启动器：配置与界面清单。 */
const LAUNCHER_FILE = join(import.meta.dirname, "launcher.html");

let sharedRuntime: Promise<ModelRuntime> | null = null;
/** 壳、配置协议与所有引擎共享同一模型运行时：凭据写入对所有后续建会话生效；失败弃置，下次重试。 */
function modelRuntime(): Promise<ModelRuntime> {
	if (sharedRuntime === null) {
		sharedRuntime = openModelRuntime(ROOT).catch((e: unknown) => {
			sharedRuntime = null;
			throw new Error(`模型运行时不可用：${String(e)}`);
		});
	}
	return sharedRuntime;
}

function faceFile(root: string, game: string): string | null {
	if (gameFile(root, game) === null) return null;
	const file = join(root, "games", game, "index.html");
	return existsSync(file) ? file : null;
}

function listFaces(root: string): string[] {
	return listGames(root).filter((game) => faceFile(root, game) !== null);
}

/** 全局设置（ROOT/settings.json 即 SDK 的全局设置路径）：每次新建即每次重读；载入错误即抛。 */
function settings(): SettingsManager {
	const manager = SettingsManager.create(ROOT, ROOT, { projectTrusted: false });
	const broken = manager.drainErrors().find((e) => e.scope === "global");
	if (broken !== undefined) throw new Error(`设置文件不可读（${broken.path ?? SETTINGS_FILE}）：${broken.error.message}`);
	return manager;
}

/** 当前模型：defaultProvider/defaultModel，档位取该模型的显式档或全局缺省；未配置即 null。 */
function storedModel(): { provider: string; id: string; level?: ThinkingLevel } | null {
	const manager = settings();
	const provider = manager.getDefaultProvider();
	const id = manager.getDefaultModel();
	if (provider === undefined || id === undefined) return null;
	const level = manager.getModelThinkingLevel(provider, id) ?? manager.getDefaultThinkingLevel();
	return { provider, id, ...(level !== undefined && { level }) };
}

/** 会话规格惰性解析：模型与凭据只在 act/narrate 建会话时求值，设置每次都重读。 */
async function agent(): Promise<AgentSpec> {
	const stored = storedModel();
	if (stored === null) throw new Error(`模型未配置：在启动器选择模型，或在 ${SETTINGS_FILE} 写入 defaultProvider 与 defaultModel`);
	const runtime = await modelRuntime();
	const model = runtime.getModel(stored.provider, stored.id);
	if (model === undefined) throw new Error(`模型 ${stored.provider}/${stored.id} 不存在（${SETTINGS_FILE}）：在启动器选择可用模型`);
	if (!(await runtime.checkAuth(model.provider))) {
		throw new Error(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(ROOT, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
	}
	return { model, modelRuntime: runtime, agentDir: ROOT, ...(stored.level !== undefined && { thinkingLevel: stored.level }) };
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

/** 内容之外的兜底出口：Cmd/Ctrl+Shift+H 回主面（应用面或启动器）。 */
function bindHomeKey(w: BrowserWindow): void {
	w.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || input.isAutoRepeat || !(input.control || input.meta) || !input.shift || input.key.toLowerCase() !== "h") return;
		event.preventDefault();
		void loadHome(w);
	});
}

/** 导航代（按窗口）：末位导航胜出，被取代的装载无论成败（ERR_ABORTED 即其一）都不算本次意图的结果。 */
const navSeq = new WeakMap<BrowserWindow, number>();

function load(w: BrowserWindow, file: string, error?: string): Promise<void> {
	const seq = (navSeq.get(w) ?? 0) + 1;
	navSeq.set(w, seq);
	const job = error === undefined ? w.loadFile(file) : w.loadFile(file, { query: { error } });
	return job.catch((e: unknown) => {
		if (navSeq.get(w) === seq) throw e;
	});
}

/** 主面为启动器：应用面缺席。 */
function launcherHome(): boolean {
	return !existsSync(APP_FILE);
}

/** 装载内置启动器：成功或被取代即 null，失败即原因文本（含来因）。 */
function loadLauncher(w: BrowserWindow, error?: string): Promise<string | null> {
	if (w.isDestroyed()) return Promise.resolve(null);
	return load(w, LAUNCHER_FILE, error).then(
		() => null,
		(e: unknown) => `${error === undefined ? "" : `${error}\n`}启动器装载失败（${LAUNCHER_FILE}）：${String(e)}`,
	);
}

/** 启动器是最后落点：失败即无窗口面。 */
async function requireLauncher(w: BrowserWindow, error?: string): Promise<void> {
	const failure = await loadLauncher(w, error);
	if (failure === null || w.isDestroyed()) return;
	dialog.showErrorBox("cave", failure);
	app.exit(1);
}

/** 装载主面；error 非空即经查询参数透出。应用面自身失败即降启动器携因（唯一自动降级），启动器亦失败即无窗口面。 */
function loadHome(w: BrowserWindow, error?: string): Promise<void> {
	if (w.isDestroyed()) return Promise.resolve();
	if (launcherHome()) return requireLauncher(w, error);
	return load(w, APP_FILE, error).catch((e: unknown) => {
		if (w.isDestroyed()) return;
		return requireLauncher(w, `${error === undefined ? "" : `${error}\n`}应用面装载失败（${APP_FILE}）：${String(e)}`);
	});
}

function gameFile(root: string, id: string): string | null {
	if (!isSegment(id)) return null;
	const file = join(root, "games", id, "index.ts");
	return existsSync(file) ? file : null;
}

/** 列出 <root>/games 下的可用游戏；id 升序。 */
function listGames(root: string): string[] {
	return subdirs(join(root, "games")).filter((id) => gameFile(root, id) !== null).sort();
}

/** 装载游戏实例：default 为 GameDef 或 (core) => GameDef 工厂 */
async function loadGame(root: string, id: string): Promise<sim.GameDef> {
	const file = gameFile(root, id);
	if (file === null) throw new Error(`未知游戏：${id}（可用：${listGames(root).join(", ") || "无"}）`);
	let mod: { default?: unknown };
	try {
		mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
	} catch (e) {
		throw new Error(`游戏 ${id} 装载失败（${file}）：${String(e)}`);
	}
	const def = typeof mod.default === "function" ? (mod.default as (core: typeof sim) => sim.GameDef)(sim) : mod.default;
	if (def === null || typeof def !== "object") throw new Error(`游戏 ${id} 未导出 GameDef（${file}）`);
	return def as sim.GameDef;
}

/** 存档目录的派生清单：runs/<game>/<run>/records.jsonl。 */
interface RunFace {
	game: string;
	run: string;
	mtime: number;
}

/** 枚举存档（按记录文件 mtime 降序） */
function listRuns(root: string, game?: string): RunFace[] {
	const games = game !== undefined ? [game] : subdirs(runsDir(root));
	const out: RunFace[] = [];
	for (const g of games) {
		for (const run of subdirs(runsDir(root, g))) {
			const stat = statSync(recordsPath(root, g, run), { throwIfNoEntry: false });
			if (stat === undefined) continue;
			out.push({ game: g, run, mtime: stat.mtimeMs });
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** 装载（或新建）一次运行并订阅：世界与档案就绪，模型到 act/narrate 建会话时才解析；事件按实例身份分流，界面自行按 (game, run) 过滤。 */
async function createSession(game: string, run: string): Promise<Session> {
	const engine = await Engine.create(await loadGame(ROOT, game), {
		agent,
		archive: openArchive(recordsPath(ROOT, game, run)),
	});
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
function openSession(game: string, run: string): Promise<Session> {
	return slotOf(game, run).opened;
}

/** state/act 只附着已打开的实例（打开中一并等）；未打开即拒绝，不隐式创建。 */
function attached(game: string, run: string): Promise<Session> {
	const slot = sessions.get(sessionKey(game, run));
	if (slot === undefined) throw new Error(`未打开运行 ${game}/${run}：先 open(game, run)`);
	return slot.opened;
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

/** 必填的 game 字段。 */
function gameIn(req: GameRequest | undefined, cmd: string): string {
	const game = idIn(req, cmd);
	if (game === undefined) throw new Error(`${cmd} 需要游戏 id`);
	return game;
}

/** 必填的 game 与 run 字段。 */
function idsIn(req: RunRequest | undefined, cmd: string): { game: string; run: string } {
	const game = gameIn(req, cmd);
	if (!isSegment(req?.run)) throw new Error(`${cmd} 的 run 须为存档 id（路径段，不含分隔符）`);
	return { game, run: req.run };
}

/** 跨游戏的管理/启动面归内容：壳只提供枚举与会话协议；游戏自述与资产由内容自持，壳不设通道。 */
ipcMain.handle("games", () => listGames(ROOT));

/** 存档清单：带 game 即只列该游戏；无记录目录不列。 */
ipcMain.handle("runs", (_event, req: GameRequest | undefined) => listRuns(ROOT, idIn(req, "runs")));

/** 回合记录原样读取（诊断面）：不装载 def、不重放、不改档案；坏行只计数。 */
ipcMain.handle("records", (_event, req: RunRequest | undefined) => {
	const { game, run } = idsIn(req, "records");
	return { game, run, ...openArchive(recordsPath(ROOT, game, run)).snapshot };
});

/** 活实例面：opening 即装载中，其余即引擎单飞态；time 仅在已落定时给出。 */
interface SessionFace {
	game: string;
	run: string;
	state: "opening" | "idle" | "act" | "narrate";
	time?: number;
}

/** 活实例清单（含打开中）：界面换装/重载后据此附着回既有实例。 */
ipcMain.handle("sessions", (): SessionFace[] => [...sessions.values()].map((slot): SessionFace => {
	const { session } = slot;
	if (session === null) return { game: slot.game, run: slot.run, state: "opening" };
	return { ...coords(session), state: session.engine.busy ?? "idle" };
}));

/** 界面清单 */
ipcMain.handle("uis", () => listFaces(ROOT));

/** 进游戏：只导航主窗，不动引擎，不写设置；装载失败即携因回主面。 */
ipcMain.handle("navigate", async (_event, req: GameRequest | undefined) => {
	const game = gameIn(req, "navigate");
	if (gameFile(ROOT, game) === null) throw new Error(`未知游戏：${game}（可用：${listGames(ROOT).join(", ") || "无"}）`);
	const file = faceFile(ROOT, game);
	if (file === null) throw new Error(`游戏 ${game} 没有界面：在 games/${game}/index.html 放置（有界面的游戏：${listFaces(ROOT).join(", ") || "无"}）`);
	const w = win;
	if (w === null || w.isDestroyed()) return;
	try {
		await load(w, file);
	} catch (e) {
		if (w.isDestroyed()) return;
		await loadHome(w, `界面 ${game} 装载失败（${file}）：${String(e)}`);
	}
});

/** 回主面：内容自建的出口（按钮等）与快捷键走同一路径。 */
ipcMain.handle("home", async () => {
	if (win !== null) await loadHome(win);
});

/** 显式打开内置启动器（配置与界面清单）：内容侧入口；失败即回主面携因。 */
ipcMain.handle("launcher:open", async () => {
	const w = win;
	if (w === null || w.isDestroyed()) return;
	const failure = await loadLauncher(w);
	if (failure !== null && !w.isDestroyed()) await loadHome(w, failure);
});

ipcMain.handle("model:current", async (): Promise<ModelFace | { error: string } | null> => {
	const stored = storedModel();
	if (stored === null) return null;
	const runtime = await modelRuntime();
	const model = runtime.getModel(stored.provider, stored.id);
	if (model === undefined) return { error: `模型 ${stored.provider}/${stored.id} 不存在` };
	return {
		provider: stored.provider,
		id: stored.id,
		ref: modelRef(model),
		...(stored.level !== undefined && { level: stored.level }),
		thinkingLevels: supportedThinkingLevels(model),
	};
});

/** 写当前模型（provider 与 id 同为必填）：level 缺席或 null 即清除该模型的显式档。 */
ipcMain.handle("model:set", async (_event, req: { provider?: unknown; id?: unknown; level?: unknown }) => {
	const provider = strIn(req?.provider, "model:set", "provider");
	const id = strIn(req?.id, "model:set", "id");
	const level = req?.level ?? null;
	if (level !== null && !isThinkingLevel(level)) throw new Error("model:set 的 level 须为思考档或 null");
	const manager = settings();
	manager.setDefaultModelAndProvider(provider, id);
	if (level === null) manager.removeModelThinkingLevel(provider, id);
	else manager.setModelThinkingLevel(provider, id, level);
	await manager.flush();
	const failed = manager.drainErrors().find((e) => e.scope === "global");
	if (failed !== undefined) throw new Error(`设置写入失败（${failed.path ?? SETTINGS_FILE}）：${failed.error.message}`);
});

ipcMain.handle("env", () => ({ root: ROOT, home: launcherHome() ? "launcher" : "app" }));

/** 打开根下目录（不存在即建）：界面据此暴露内容与配置的可写位置。 */
ipcMain.handle("reveal", (_event, req: { dir?: unknown }) => {
	const dir = req?.dir ?? "";
	if (dir !== "" && !isSegment(dir)) throw new Error("reveal 的 dir 须为根下的路径段");
	const path = join(ROOT, dir);
	mkdirSync(path, { recursive: true });
	return shell.openPath(path);
});

ipcMain.handle("open", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "open");
	const session = await openSession(game, run);
	return { ...face(session), load: session.engine.load };
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
	return { narration: await session.engine.narrate(instruction) };
});

ipcMain.handle("state", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "state");
	return face(await attached(game, run));
});

app.whenReady().then(() => {
	installModel(modelRuntime);
	win = new BrowserWindow({ ...windowOptions(), width: 1200, height: 820 });
	bindWindow(win);
	bindHomeKey(win);
	// 主窗关闭＝结束应用：实例随进程收束，不存在无主窗的存活态。
	win.on("closed", () => {
		win = null;
		app.quit();
	});
	void loadHome(win);
});
