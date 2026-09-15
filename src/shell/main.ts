import { app, BrowserWindow, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocsPath, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openArchive, readRecords } from "../core/archive.ts";
import { Engine, type ActOutcome, type AgentSpec, type NarrationOutcome } from "../core/engine.ts";
import { isSegment, readJsonObject, recordsPath, rootDir, runsDir, subdirs } from "../core/paths.ts";
import * as sim from "../core/sim.ts";
import { installModel, modelRef, openModelRuntime, resolveModelRef, supportedThinkingLevels, type ModelFace, type ModelResolution } from "./model.ts";

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
const SETTINGS_FILE = join(ROOT, "settings.json");

type Settings = Record<string, unknown>;

/** 缺席与破损都按空对象；破损显形于控制台。 */
function readSettings(): Settings {
	const read = readJsonObject(SETTINGS_FILE);
	if (read === null) return {};
	if (read.value !== null) return read.value;
	console.error(`设置文件不可读（按缺席处理）：${read.error}`);
	return {};
}

/** 写补丁并返回写入后的设置。 */
function patchSettings(patch: Settings): Settings {
	const settings = { ...readSettings(), ...patch };
	mkdirSync(ROOT, { recursive: true });
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	return settings;
}

/** 字符串键：非字符串即未定（不做回退）。 */
function stringSetting(settings: Settings, key: string): string | undefined {
	const v = settings[key];
	return typeof v === "string" ? v : undefined;
}

/** 壳内引导面：随包分发、不属内容、不可遮蔽；配置正确性的兜底，呈现可被 settingsUi 替换。 */
const SETUP_FILE = join(import.meta.dirname, "setup.html");

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

interface UiSite {
	name: string;
	file: string;
	/** 作用域由位置给出：games/<id>/ui 下即绑定 id。 */
	game: string;
}

/** 界面 ref：`<game>/<name>`；两段均来自目录名，不含斜杠。 */
const uiRef = (site: UiSite): string => `${site.game}/${site.name}`;

/** 全部界面（ref 去重）：games/<id>/ui/index.html 为名即 id 的缺省界面，games/<id>/ui/<name>/index.html 为具名界面。 */
function uiRegistry(): ReadonlyMap<string, UiSite> {
	const sites = new Map<string, UiSite>();
	const add = (site: UiSite): void => {
		const ref = uiRef(site);
		if (existsSync(site.file) && !sites.has(ref)) sites.set(ref, site);
	};
	for (const game of subdirs(join(ROOT, "games"))) {
		const ui = join(ROOT, "games", game, "ui");
		add({ name: game, file: join(ui, "index.html"), game });
		for (const name of subdirs(ui)) add({ name, file: join(ui, name, "index.html"), game });
	}
	return sites;
}

/** 界面 ref 清单（诊断文案用）。 */
const uiList = (sites: ReadonlyMap<string, UiSite>): string => [...sites.keys()].join(", ") || "无";

/** 设置中解析出的当前模型：未配置即 null；warning 在此显形。 */
async function configuredModel(): Promise<{ ref: string; runtime: ModelRuntime; resolved: ModelResolution } | null> {
	const ref = stringSetting(readSettings(), "model");
	if (ref === undefined || ref.trim() === "") return null;
	const runtime = await modelRuntime();
	const resolved = resolveModelRef(ref, runtime);
	if (resolved.ok && resolved.warning) console.warn(`⚠ ${resolved.warning}`);
	return { ref, runtime, resolved };
}

/** 模型与凭据惰性解析：只在 act/narrate 建会话时调用，设置每次都重读。 */
async function agent(): Promise<AgentSpec> {
	const current = await configuredModel();
	if (current === null) throw new Error(`模型未配置：在 ${SETTINGS_FILE} 写入 { "model": "provider/model[:thinking]" }`);
	const { ref, runtime, resolved } = current;
	if (!resolved.ok) throw new Error(`模型 "${ref}"（${SETTINGS_FILE}）不可用：${resolved.reason}`);
	const { model, thinkingLevel } = resolved;
	if (!(await runtime.checkAuth(model.provider))) {
		throw new Error(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(ROOT, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
	}
	return { model, modelRuntime: runtime, ...(thinkingLevel !== undefined && { thinkingLevel }) };
}

/** 初始界面：settings.json 指定者优先，其次唯一可用界面；解析失败回落壳内引导面。 */
function bootUi(): UiSite {
	const named = stringSetting(readSettings(), "ui");
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
	if (all.length === 0) throw new Error(`没有可用界面：在 ${join(ROOT, "games")} 下任一 <id>/ui 放置 index.html 或 <name>/index.html`);
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
	const ref = stringSetting(readSettings(), "settingsUi");
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

/** 条目名按此序查找；游戏即 <root>/games 下的同名目录。 */
const ENTRIES = ["index.ts", "index.js", "index.mjs"];

/** id 是路径段：不做路径解析。 */
function gameFile(root: string, id: string): string | null {
	if (!isSegment(id)) return null;
	for (const name of ENTRIES) {
		const file = join(root, "games", id, name);
		if (existsSync(file)) return file;
	}
	return null;
}

/** 列出 <root>/games 下的可用游戏；id 升序。 */
function listGames(root: string): string[] {
	return subdirs(join(root, "games")).filter((id) => gameFile(root, id) !== null).sort();
}

type GameMeta = Record<string, unknown>;

/** 读目录清单：缺失即空对象；坏元数据回落并携错；未知游戏即 null。 */
function readGameMeta(root: string, id: string): { meta: GameMeta; error?: string } | null {
	const entry = gameFile(root, id);
	if (entry === null) return null;
	const parsed = readJsonObject(join(dirname(entry), "game.json"));
	if (parsed === null) return { meta: {} };
	if (parsed.value === null) return { meta: {}, error: `游戏元数据${parsed.error}` };
	return { meta: parsed.value };
}

/** 装载游戏实例：default 为 GameDef 或 (core) => GameDef 工厂；模块缓存按进程，改文件后须重启壳生效。 */
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

/** 枚举存档（按记录文件 mtime 降序）；game 缺席即扫全部游戏目录。 */
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

/** 装载（或新建）一次运行；世界与档案就绪，模型到建会话时才解析。 */
async function openRun(root: string, game: string, run: string, agent: () => Promise<AgentSpec>): Promise<Engine> {
	return Engine.create(await loadGame(root, game), {
		agent,
		agentDir: root,
		archive: openArchive(recordsPath(root, game, run)),
	});
}

/** 事件按实例身份分流；界面自行按 (game, run) 过滤。 */
async function createSession(game: string, run: string): Promise<Session> {
	const engine = await openRun(ROOT, game, run, agent);
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
type SlotFace = sim.SlotDef & { key: string };

function slotFace(slots: Record<string, sim.SlotDef> | undefined): SlotFace[] {
	return Object.entries(slots ?? {}).map(([key, d]) => ({ key, ...d }));
}

const uiFace = (site: UiSite): { name: string; ref: string; game: string } => ({ name: site.name, ref: uiRef(site), game: site.game });

ipcMain.handle("games", () => listGames(ROOT));

/** 存档清单：带 game 即只列该游戏；无记录目录不列。 */
ipcMain.handle("runs", (_event, req: GameRequest | undefined) => listRuns(ROOT, idIn(req, "runs")));

/** 回合记录原样读取（诊断面）：不装载 def、不重放、不改档案；坏行只计数。 */
ipcMain.handle("records", (_event, req: RunRequest | undefined) => {
	const { game, run } = idsIn(req, "records");
	return { game, run, ...readRecords(recordsPath(ROOT, game, run)) };
});

/** 活实例清单（含打开中）：界面换装/重载后据此附着回既有实例。 */
ipcMain.handle("sessions", () => [...sessions.values()].map((slot) => {
	const { session } = slot;
	return session === null ? { game: slot.game, run: slot.run, opening: true } : { ...coords(session), busy: session.engine.busy };
}));

/** 游戏目录 */
ipcMain.handle("meta", (_event, req: GameRequest | undefined) => {
	const game = idIn(req, "meta");
	if (game === undefined) throw new Error("meta 需要游戏 id");
	const read = readGameMeta(ROOT, game);
	if (read === null) throw new Error(`未知游戏：${game}（可用：${listGames(ROOT).join(", ") || "无"}）`);
	return { game, meta: read.meta, ...(read.error !== undefined && { error: read.error }) };
});

/** 游戏的静态派生面：动词目录与注册槽名字；界面据此生成控件，不必硬编码。 */
ipcMain.handle("def", async (_event, req: GameRequest | undefined) => {
	const game = idIn(req, "def");
	if (game === undefined) throw new Error("def 需要游戏 id");
	const def = await loadGame(ROOT, game);
	return { game, verbs: sim.verbFace(def.verbs), props: slotFace(def.props), relTypes: slotFace(def.relTypes) };
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
	patchSettings({ ui: ref });
	if (win !== null && !win.isDestroyed()) loadPage(win, site.file);
});

ipcMain.handle("settings", () => readSettings());

/** 当前模型的解析面：规范化 ref、显式档位与受支持档位；未配置即 null，解析失败即 error。 */
ipcMain.handle("model:current", async (): Promise<ModelFace | { error: string } | null> => {
	const current = await configuredModel();
	if (current === null) return null;
	const { resolved } = current;
	if (!resolved.ok) return { error: resolved.reason };
	return {
		ref: modelRef(resolved.model),
		...(resolved.thinkingLevel !== undefined && { level: resolved.thinkingLevel }),
		thinkingLevels: supportedThinkingLevels(resolved.model),
	};
});

ipcMain.handle("env", () => ({ root: ROOT }));

/** 打开根下目录（不存在即建）：界面据此暴露内容与配置的可写位置。 */
ipcMain.handle("reveal", (_event, req: { dir?: unknown }) => {
	const dir = req?.dir ?? "";
	if (typeof dir !== "string" || (dir !== "" && !isSegment(dir))) throw new Error("reveal 的 dir 须为根下的路径段");
	const path = join(ROOT, dir);
	mkdirSync(path, { recursive: true });
	return shell.openPath(path);
});

/** 写入是哑的：patch 原样落用户层，宿主键的有效性由消费处解析（bootUi/settingsSite 回落、建会话报错）；ui 归 use（写+导航）。 */
ipcMain.handle("settings:set", (_event, req: { patch?: unknown }) => {
	if (req?.patch === null || typeof req?.patch !== "object" || Array.isArray(req.patch)) throw new Error("settings:set 需要 patch 对象");
	const patch = { ...(req.patch as Record<string, unknown>) };
	if (patch.ui !== undefined) throw new Error("ui 只经 use 切换：settings:set 不接受 ui");
	return patchSettings(patch);
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
