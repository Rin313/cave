import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type BrowserWindowConstructorOptions } from "electron";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
	readonly opened: Promise<Session>;
	session: Session | null;
}

/** 会话单表：键为 (game, run)；两段均为路径段（isSegment），拼接无歧义。 */
const sessions = new Map<string, SessionSlot>();
const sessionKey = (game: string, run: string): string => `${game}/${run}`;

let win: BrowserWindow | null = null;

/** 窗口未就绪时第二实例带来的游戏：由 whenReady 消费。 */
let pendingGame: string | null = null;

/** 第二实例聚焦主窗（写者唯一由单实例锁保证），并直达其命令行指定的游戏；主窗未就绪即暂存目标。 */
app.on("second-instance", (_event, argv) => {
	const game = gameArg(argv);
	const w = win;
	if (w === null || w.isDestroyed()) {
		pendingGame = game;
		return;
	}
	if (w.isMinimized()) w.restore();
	w.focus();
	if (game !== null) void launchGame(w, game);
});

/** 根：games、runs 与配置（settings、auth、models）的共同所在；即宿主用户数据目录（--user-data-dir 可覆盖）。 */
const ROOT = app.getPath("userData");
const SETTINGS_FILE = join(ROOT, "settings.json");

/** 路径段：id 不做路径解析；控制字符即拒（id 会物化为文件名与双击入口内容）。 */
function isSegment(v: unknown): v is string {
	return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/\x00-\x1f\x7f]/.test(v);
}

/** 启动参数里的游戏 id：--game <id> 或 --game=<id>；缺席或非法即 null。 */
function gameArg(argv: readonly string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--game") {
			const v = argv[i + 1];
			return v !== undefined && !v.startsWith("--") && isSegment(v) ? v : null;
		}
		if (a.startsWith("--game=")) {
			const v = a.slice("--game=".length);
			return isSegment(v) ? v : null;
		}
	}
	return null;
}

function runsDir(root: string, game: string): string {
	return join(root, "runs", game);
}

function recordsPath(root: string, game: string, run: string): string {
	return join(runsDir(root, game), run, "records.jsonl");
}

/** 目录下的直接子目录名；目录缺席即空。 */
function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** 壳内启动器：唯一主面（启动、home 与游戏界面失败回落的落点）。 */
const LAUNCHER_FILE = join(import.meta.dirname, "launcher.html");

/** 入口物化只属发行版：开发态 exe 是 Electron 自身。 */
const entriesActive = app.isPackaged;

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

/** Windows 命令行参数：含空白或引号即整体加引号，引号前加反斜杠（id 可含引号；路径分隔符不是字面反斜杠）。 */
const winArg = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
/** POSIX sh 单引号串。 */
const shArg = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;
/** .desktop 的 Exec 引号：规范只认双引号，反斜杠、引号、反引号与 $ 须转义，字面 % 写作 %%。 */
const execArg = (arg: string): string => `"${arg.replace(/[\\"`$%]/g, (c) => (c === "%" ? "%%" : `\\${c}`))}"`;

/** plist 字符串：转义 XML 元字符。 */
const xmlArg = (v: string): string => v.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** bundle id 段：非字母数字转为 `_` + 固定四位十六进制（字面 `_` 亦在转义内），保持单射。 */
const bundleId = (game: string): string => `cave.game.${game.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;

/** macOS 入口即最小 .app 包裹：.command 会闪 Terminal 且受信任策略限制。 */
function writeMacApp(file: string, game: string, args: readonly string[]): void {
	const macos = join(file, "Contents", "MacOS");
	mkdirSync(macos, { recursive: true });
	const launch = join(macos, "launch");
	writeFileSync(launch, `#!/bin/sh\nexec ${[process.execPath, ...args].map(shArg).join(" ")}\n`);
	chmodSync(launch, 0o755);
	writeFileSync(join(file, "Contents", "Info.plist"), [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0"><dict>`,
		`<key>CFBundleExecutable</key><string>launch</string>`,
		`<key>CFBundleIdentifier</key><string>${bundleId(game)}</string>`,
		`<key>CFBundleName</key><string>${xmlArg(game)}</string>`,
		`<key>CFBundlePackageType</key><string>APPL</string>`,
		`<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>`,
		`<key>CFBundleVersion</key><string>0.0.0</string>`,
		`<key>CFBundleShortVersionString</key><string>0.0.0</string>`,
		`</dict></plist>`,
		``,
	].join("\n"));
}

/** 写一个入口到游戏目录：命令行 = 裸 exe + 数据根 + --game（入口随根自含，双击即回到同一档案）。 */
function writeEntry(dir: string, game: string): void {
	const args = [`--user-data-dir=${ROOT}`, `--game=${game}`];
	if (process.platform === "win32") {
		const file = join(dir, `${game}.lnk`);
		if (!shell.writeShortcutLink(file, "create", { target: process.execPath, args: args.map(winArg).join(" "), description: `cave: ${game}` })) {
			throw new Error(`快捷方式写入失败：${file}`);
		}
		return;
	}
	if (process.platform === "darwin") {
		writeMacApp(join(dir, `${game}.app`), game, args);
		return;
	}
	const file = join(dir, `${game}.desktop`);
	writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${game}\nExec=${[process.execPath, ...args].map(execArg).join(" ")}\nTerminal=false\n`);
	chmodSync(file, 0o755);
}

/** 入口物化：每个游戏面在自身目录内写一个入口，随游戏目录生灭；逐条失败不中断其余，整体失败也在清单内（不抛）。 */
function syncEntries(): string[] {
	const failures: string[] = [];
	try {
		for (const game of listFaces(ROOT)) {
			try {
				writeEntry(join(ROOT, "games", game), game);
			} catch (e) {
				failures.push(`${game}：${String(e)}`);
			}
		}
	} catch (e) {
		failures.push(String(e));
	}
	return failures;
}

/** 全局设置（ROOT/settings.json 即 SDK 的全局设置路径）：每次新建即每次重读；载入错误即抛。 */
function settings(): SettingsManager {
	const manager = SettingsManager.create(ROOT, ROOT, { projectTrusted: false });
	const broken = manager.drainErrors().find((e) => e.scope === "global");
	if (broken !== undefined) throw new Error(`设置文件不可读（${broken.path ?? SETTINGS_FILE}）：${broken.error.message}`);
	return manager;
}

/** 当前模型：defaultProvider/defaultModel 未配置即 null，模型不存在即抛；档位取该模型的显式档或全局缺省。 */
async function currentModel(): Promise<{ runtime: ModelRuntime; model: AgentSpec["model"]; level?: ThinkingLevel } | null> {
	const manager = settings();
	const provider = manager.getDefaultProvider();
	const id = manager.getDefaultModel();
	if (provider === undefined || id === undefined) return null;
	const runtime = await modelRuntime();
	const model = runtime.getModel(provider, id);
	if (model === undefined) throw new Error(`模型 ${provider}/${id} 不存在（${SETTINGS_FILE}）：在启动器选择可用模型`);
	const level = manager.getModelThinkingLevel(provider, id) ?? manager.getDefaultThinkingLevel();
	return { runtime, model, ...(level !== undefined && { level }) };
}

/** 会话规格惰性解析：模型与凭据只在 act/narrate 建会话时求值，设置每次都重读。 */
async function agent(): Promise<AgentSpec> {
	const resolved = await currentModel();
	if (resolved === null) throw new Error(`模型未配置：在启动器选择模型，或在 ${SETTINGS_FILE} 写入 defaultProvider 与 defaultModel`);
	const { runtime, model, level } = resolved;
	if (!(await runtime.checkAuth(model.provider))) {
		throw new Error(`模型 ${model.provider}/${model.id} 未配置凭据：设置该 provider 的 API key 环境变量，或在 ${join(ROOT, "auth.json")} 写入凭据；格式见 ${join(getDocsPath(), "providers.md")}`);
	}
	return { model, modelRuntime: runtime, agentDir: ROOT, ...(level !== undefined && { thinkingLevel: level }) };
}

const windowOptions: BrowserWindowConstructorOptions = {
	show: false,
	backgroundColor: "#14161a",
	webPreferences: {
		preload: join(import.meta.dirname, "preload.cjs"),
		contextIsolation: true,
		sandbox: true,
	},
};

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

/** 导航代（按窗口）：末位导航胜出，被取代的装载无论成败（ERR_ABORTED 即其一）都不算本次意图的结果。 */
const navSeq = new WeakMap<BrowserWindow, number>();

function load(w: BrowserWindow, file: string, query?: Record<string, string>): Promise<void> {
	const seq = (navSeq.get(w) ?? 0) + 1;
	navSeq.set(w, seq);
	const job = query === undefined ? w.loadFile(file) : w.loadFile(file, { query });
	return job.catch((e: unknown) => {
		if (navSeq.get(w) === seq) throw e;
	});
}

/** 启动器查询参数（主进程向自己的页面下发壳内状态，不属协议面）：入口物化只随启动器面装载发生，失败与来因同经 error 呈现。 */
function launcherQuery(error?: string): Record<string, string> {
	const lines = entriesActive ? syncEntries() : [];
	if (error !== undefined) lines.unshift(error);
	return lines.length === 0 ? {} : { error: lines.join("\n") };
}

/** 装载内置启动器：成功或被取代即 null，失败即原因文本（含来因）。 */
function loadLauncher(w: BrowserWindow, error?: string): Promise<string | null> {
	if (w.isDestroyed()) return Promise.resolve(null);
	return load(w, LAUNCHER_FILE, launcherQuery(error)).then(
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

/** 入口唯一路径：启动参数与第二实例直达游戏；未知游戏、无界面或装载失败一律回配置面携因。 */
async function launchGame(w: BrowserWindow, game: string): Promise<void> {
	try {
		const dir = requireGameDir(ROOT, game);
		const file = join(dir, "index.html");
		if (!existsSync(file)) throw new Error(`游戏 ${game} 没有界面：在 games/${game}/index.html 放置（有界面的游戏：${listFaces(ROOT).join(", ") || "无"}）`);
		if (w.isDestroyed()) return;
		try {
			await load(w, file);
		} catch (e) {
			if (!w.isDestroyed()) throw new Error(`界面 ${game} 装载失败（${file}）：${String(e)}`);
		}
	} catch (e) {
		if (!w.isDestroyed()) await requireLauncher(w, String(e));
	}
}

/** 游戏目录：id 合法且 index.ts 在世（游戏身份的唯一定义）；缺席即 null。 */
function gameDir(root: string, id: string): string | null {
	if (!isSegment(id)) return null;
	const dir = join(root, "games", id);
	return existsSync(join(dir, "index.ts")) ? dir : null;
}

/** 列出 <root>/games 下的可用游戏；id 升序。 */
function listGames(root: string): string[] {
	return subdirs(join(root, "games")).filter((id) => gameDir(root, id) !== null).sort();
}

function listFaces(root: string): string[] {
	return listGames(root).filter((id) => existsSync(join(root, "games", id, "index.html")));
}

/** 未知游戏即抛：直达与装载共用同一文案。 */
function requireGameDir(root: string, id: string): string {
	const dir = gameDir(root, id);
	if (dir === null) throw new Error(`未知游戏：${id}（可用：${listGames(root).join(", ") || "无"}）`);
	return dir;
}

/** 装载游戏实例：default 为 GameDef 或 (core) => GameDef 工厂 */
async function loadGame(root: string, id: string): Promise<sim.GameDef> {
	const file = join(requireGameDir(root, id), "index.ts");
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

/** 枚举某游戏的存档（按记录文件 mtime 降序）：存档面只按游戏坐标取，不跨游戏列。 */
function listRuns(root: string, game: string): RunFace[] {
	const out: RunFace[] = [];
	for (const run of subdirs(runsDir(root, game))) {
		const stat = statSync(recordsPath(root, game, run), { throwIfNoEntry: false });
		if (stat === undefined) continue;
		out.push({ game, run, mtime: stat.mtimeMs });
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

/** 装载（或新建）一次运行并订阅：世界与档案就绪，模型到 act/narrate 建会话时才解析；事件携 (game, run) 分流，供句柄按坐标过滤。 */
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

/** 打开或附着：同一 (game, run) 复用同一活实例（并发 open 也只剩一个）；失败即释放位置（打开中不可关闭，故释放无需复核表项身份）。 */
function openSession(game: string, run: string): Promise<Session> {
	const key = sessionKey(game, run);
	const found = sessions.get(key);
	if (found !== undefined) return found.opened;
	const opened = createSession(game, run);
	const slot: SessionSlot = { opened, session: null };
	sessions.set(key, slot);
	opened.then(
		(session) => {
			slot.session = session;
		},
		() => {
			sessions.delete(key);
		},
	);
	return opened;
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

/** 状态快照：视图与坐标由同一读态求值。 */
function stateOf(session: Session): { game: string; run: string; time: number; view: unknown } {
	return { game: session.game, run: session.run, time: session.engine.sim.world.time, view: session.engine.sim.view() };
}

/** IPC 载荷不可信：只声明形状，语义逐命令校验。 */
type GameRequest = { game?: unknown };
type RunRequest = GameRequest & { run?: unknown };

/** 非空字符串字段（trim 后非空）：IPC 边界校验，返回原值。 */
function strIn(value: unknown, cmd: string, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${cmd} 的 ${field} 须为非空字符串`);
	return value;
}

/** 必填的 game 字段，须为游戏 id（路径段）。 */
function gameIn(req: GameRequest | undefined, cmd: string): string {
	const game = req?.game;
	if (game === undefined) throw new Error(`${cmd} 需要游戏 id`);
	if (!isSegment(game)) throw new Error(`${cmd} 的 game 须为游戏 id`);
	return game;
}

/** 必填的 game 与 run 字段。 */
function idsIn(req: RunRequest | undefined, cmd: string): { game: string; run: string } {
	const game = gameIn(req, cmd);
	if (!isSegment(req?.run)) throw new Error(`${cmd} 的 run 须为存档 id（路径段，不含分隔符）`);
	return { game, run: req.run };
}

/** 存档清单：只按给定游戏坐标取，不跨游戏列；无记录目录不列。 */
ipcMain.handle("runs", (_event, req: GameRequest | undefined) => listRuns(ROOT, gameIn(req, "runs")));

/** 回合记录原样读取（诊断面）：不装载 def、不重放、不改档案；坏行只计数。 */
ipcMain.handle("records", (_event, req: RunRequest | undefined) => {
	const { game, run } = idsIn(req, "records");
	return { game, run, ...openArchive(recordsPath(ROOT, game, run)).snapshot };
});

/** 回主面：内容自建的出口（按钮等）；启动器失败即无窗口面。 */
ipcMain.handle("home", async () => {
	if (win !== null) await requireLauncher(win);
});

ipcMain.handle("config:current", async (): Promise<ModelFace | null> => {
	const resolved = await currentModel();
	if (resolved === null) return null;
	const { model, level } = resolved;
	return {
		provider: model.provider,
		id: model.id,
		ref: modelRef(model),
		...(level !== undefined && { level }),
		thinkingLevels: supportedThinkingLevels(model),
	};
});

/** 写当前模型（provider 与 id 同为必填）：level 缺席即保留该模型的显式档，null 即清除，其余须为思考档。 */
ipcMain.handle("config:use", async (_event, req: { provider?: unknown; id?: unknown; level?: unknown }) => {
	const provider = strIn(req?.provider, "config:use", "provider");
	const id = strIn(req?.id, "config:use", "id");
	const level = req?.level;
	if (level !== undefined && level !== null && !isThinkingLevel(level)) throw new Error("config:use 的 level 须为思考档或 null");
	const manager = settings();
	manager.setDefaultModelAndProvider(provider, id);
	if (level === null) manager.removeModelThinkingLevel(provider, id);
	else if (level !== undefined) manager.setModelThinkingLevel(provider, id, level);
	await manager.flush();
	const failed = manager.drainErrors().find((e) => e.scope === "global");
	if (failed !== undefined) throw new Error(`设置写入失败（${failed.path ?? SETTINGS_FILE}）：${failed.error.message}`);
});

ipcMain.handle("env", () => ({ root: ROOT }));

/** 打开根下目录（不存在即建）：界面据此暴露内容与配置的可写位置。 */
ipcMain.handle("reveal", (_event, req: { dir?: unknown }) => {
	const dir = req?.dir ?? "";
	if (dir !== "" && !isSegment(dir)) throw new Error("reveal 的 dir 须为根下的路径段");
	const path = join(ROOT, dir);
	mkdirSync(path, { recursive: true });
	return shell.openPath(path);
});

/** 打开或附着：只回档案健康；状态读走 state（句柄以方法为唯一读态，不携快照）。 */
ipcMain.handle("open", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "open");
	const session = await openSession(game, run);
	return session.engine.load;
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
	return { ...stateOf(session), ...outcome };
});

ipcMain.handle("narrate", async (_event, req: RunRequest & { instruction?: unknown }) => {
	const { game, run } = idsIn(req, "narrate");
	const instruction = strIn(req?.instruction, "narrate", "instruction");
	const session = await attached(game, run);
	return { narration: await session.engine.narrate(instruction) };
});

ipcMain.handle("state", async (_event, req: RunRequest) => {
	const { game, run } = idsIn(req, "state");
	return stateOf(await attached(game, run));
});

app.whenReady().then(() => {
	installModel(modelRuntime);
	if (process.platform !== "darwin") Menu.setApplicationMenu(null);
	win = new BrowserWindow({ ...windowOptions, width: 1200, height: 820 });
	bindWindow(win);
	// 主窗关闭＝结束应用：实例随进程收束，不存在无主窗的存活态。
	win.on("closed", () => {
		win = null;
		app.quit();
	});
	const game = pendingGame ?? gameArg(process.argv);
	void (game === null ? requireLauncher(win) : launchGame(win, game));
});
