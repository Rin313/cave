import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../core/engine.ts";
import { listGames } from "../core/games.ts";
import { errorText, spineLines } from "../core/sim.ts";
import { configDir, openRun, runPaths } from "../tools/runs.ts";

interface Current {
	game: string;
	run: string;
	engine: Engine;
	unsubscribe: () => void;
}

let win: BrowserWindow | null = null;
let current: Current | null = null;

const APP_ROOT = app.getAppPath();
const DATA_ROOT = app.isPackaged ? app.getPath("userData") : APP_ROOT;
/** 游戏查找链：用户目录（可写、可覆盖）→ 包内；同名前者遮蔽后者。 */
const GAME_ROOTS = [DATA_ROOT, APP_ROOT];
/** 配置根（用户级全局）：凭据、模型与界面偏好，与 CLI 共用；运行数据（runs）另按 DATA_ROOT。 */
const CONFIG_DIR = configDir();
/** 界面查序：用户目录（可写、可覆盖）→ 包外资源 → 包内；同名前者遮蔽后者。 */
const UI_ROOTS = app.isPackaged
	? [join(DATA_ROOT, "ui"), join(process.resourcesPath, "ui"), join(APP_ROOT, "ui")]
	: [join(APP_ROOT, "ui")];
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");
const SETTINGS_FILES = app.isPackaged
	? [SETTINGS_FILE, join(process.resourcesPath, "settings.json"), join(APP_ROOT, "settings.json")]
	: [SETTINGS_FILE, join(APP_ROOT, "settings.json")];

/** 界面名即目录名，只认 <root>/<name>/index.html；名字不做路径。 */
function uiFile(name: string): string | null {
	if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) return null;
	for (const root of UI_ROOTS) {
		const file = join(root, name, "index.html");
		if (existsSync(file)) return file;
	}
	return null;
}

function uis(): string[] {
	const names = new Set<string>();
	for (const root of UI_ROOTS) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(root, entry.name, "index.html"))) names.add(entry.name);
		}
	}
	return [...names].sort();
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

/** 初始界面：settings.json 指定者优先，其次唯一可用界面；不猜、不兜底（shell 不自带界面）。 */
function bootUi(): string {
	const named = readUiSetting();
	if (named !== undefined && uiFile(named) !== null) return named;
	const names = uis();
	if (names.length === 1) return names[0]!;
	if (names.length === 0) throw new Error(`没有可用界面：在 ${UI_ROOTS.join(" 或 ")} 下放置 <name>/index.html`);
	throw new Error(`未指定界面：可用 ${names.join(", ")}；在 ${SETTINGS_FILE} 写入 { "ui": "<name>" }`);
}

let ui: string;
try {
	ui = bootUi();
} catch (e) {
	console.error(errorText(e));
	process.exit(2);
}
const uiPath = uiFile(ui)!;

function closeCurrent(): void {
	if (!current) return;
	current.unsubscribe();
	current.engine.dispose();
	current = null;
}

function live(): Engine {
	if (!current) throw new Error("未打开运行：先 open(game, run)");
	return current.engine;
}

/** 状态快照：视图与坐标由同一读态求值，与 act 结果同形。 */
function snapshot(): { turn: number; time: number; view: unknown } {
	const engine = live();
	return { turn: engine.turn, time: engine.sim.world.time, view: engine.sim.view() };
}

function pair(req: { game?: unknown; run?: unknown } | undefined): { game: string; run: string } {
	const name = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== "." && v !== ".." && !/[\\/]/.test(v);
	if (!name(req?.game) || !name(req?.run)) throw new Error("需要非空 game 与 run（run 是路径段，不含分隔符）");
	return { game: req.game, run: req.run };
}

ipcMain.handle("cave:games", () => listGames(GAME_ROOTS));

ipcMain.handle("cave:uis", () => uis());

/** 换界面：只导航当前窗口，不动引擎与 run；选择写入设置供下次启动。 */
ipcMain.handle("cave:use", (_event, req: { name?: unknown }) => {
	if (typeof req?.name !== "string") throw new Error("use 需要界面名");
	const file = uiFile(req.name);
	if (file === null) throw new Error(`未知界面：${req.name}（可用：${uis().join(", ") || "无"}）`);
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(Object.assign({}, ...loadSettings().reverse(), { ui: req.name }), null, "\t")}\n`, "utf8");
	void win?.loadFile(file);
});

ipcMain.handle("cave:open", async (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	closeCurrent();
	const engine = await openRun(game, run, DATA_ROOT, GAME_ROOTS);
	current = { game, run, engine, unsubscribe: engine.subscribe((event) => win?.webContents.send("cave:event", event)) };
	return { game, run, ...snapshot(), warnings: [...engine.loadWarnings] };
});

ipcMain.handle("cave:act", async (_event, req: { utterance?: unknown }) => {
	if (typeof req?.utterance !== "string" || req.utterance.trim() === "") throw new Error("act 需要非空 utterance");
	const engine = live();
	const outcome = await engine.act({ utterance: req.utterance });
	const warnings = [...outcome.warnings];
	// 两相投影各自降级：账目已在定稿，呈现失灵不得使已入账回合变成调用失败
	let lines: string[] = [];
	let reveals: unknown[] = [];
	try {
		lines = spineLines(engine.sim, outcome.steps, engine.sim.snapshot());
	} catch (e) {
		warnings.push(`事件投影抛错：${errorText(e)}`);
	}
	try {
		reveals = engine.sim.reveals(outcome.steps);
	} catch (e) {
		warnings.push(`新见段投影抛错：${errorText(e)}`);
	}
	return { ...snapshot(), steps: outcome.steps, lines, reveals, narration: outcome.narration, warnings, usage: outcome.usage };
});

ipcMain.handle("cave:narrate", async (_event, req: { instruction?: unknown }) => {
	if (typeof req?.instruction !== "string" || req.instruction.trim() === "") throw new Error("narrate 需要非空 instruction");
	const outcome = await live().narrate(req.instruction);
	return { narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage };
});

ipcMain.handle("cave:state", () => snapshot());

ipcMain.handle("cave:reset", (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	if (current?.game === game && current.run === run) closeCurrent();
	rmSync(runPaths(game, run, DATA_ROOT).dir, { recursive: true, force: true });
});

app.whenReady().then(() => {
	win = new BrowserWindow({
		width: 1200,
		height: 820,
		backgroundColor: "#14161a",
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
		},
	});
	win.on("closed", () => {
		win = null;
		closeCurrent();
	});
	void win.loadFile(uiPath);
});

app.on("window-all-closed", () => app.quit());
