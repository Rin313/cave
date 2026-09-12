import { app, BrowserWindow, ipcMain } from "electron";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Engine } from "../core/engine.ts";
import { errorText, spineLines } from "../core/sim.ts";
import { GAMES } from "../games/registry.ts";
import { openRun, runPaths } from "../tools/runs.ts";

interface Current {
	game: string;
	run: string;
	engine: Engine;
	unsubscribe: () => void;
}

let win: BrowserWindow | null = null;
let current: Current | null = null;

// runs/ 与 pi 资源根锚在项目根：直接启动二进制时 cwd 不在项目内也不会漂移
process.chdir(join(import.meta.dirname, "..", ".."));

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

ipcMain.handle("cave:games", () => Object.keys(GAMES));

ipcMain.handle("cave:open", async (_event, req: { game?: unknown; run?: unknown }) => {
	const { game, run } = pair(req);
	closeCurrent();
	const engine = await openRun(game, run);
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
	rmSync(runPaths(game, run).dir, { recursive: true, force: true });
});

/** --ui 接受本地文件路径或 URL：任何 HTML 页都可作为界面，preload 注入的 cave 是唯一通道。 */
function uiTarget(): string {
	const at = process.argv.indexOf("--ui");
	const target = (at >= 0 ? process.argv[at + 1] : undefined) ?? join(import.meta.dirname, "ui.html");
	return target.includes("://") ? target : pathToFileURL(resolve(target)).href;
}

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
	void win.loadURL(uiTarget());
	if (process.argv.includes("--devtools")) win.webContents.openDevTools();
});

app.on("window-all-closed", () => app.quit());
