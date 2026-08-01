import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Engine } from "../core/engine.ts";
import { Simulation } from "../core/sim.ts";
import type { GameState } from "../core/types.ts";
import { loadGame } from "../games/index.ts";

interface RunMeta {
	game: string;
	runId: string;
	createdAt: string;
	turn: number;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

const RUNS_ROOT = "runs";

function runDir(game: string, runId: string): string {
	return join(RUNS_ROOT, game, runId);
}

function metaPath(dir: string): string {
	return join(dir, "meta.json");
}

function statePath(dir: string): string {
	return join(dir, "state.json");
}

function transcriptPath(dir: string): string {
	return join(dir, "transcript.jsonl");
}

function loadMeta(dir: string): RunMeta {
	return JSON.parse(readFileSync(metaPath(dir), "utf8")) as RunMeta;
}

function loadState(dir: string): GameState {
	return JSON.parse(readFileSync(statePath(dir), "utf8")) as GameState;
}

function saveState(dir: string, sim: Simulation): void {
	writeFileSync(statePath(dir), JSON.stringify(sim.snapshot(), null, 2), "utf8");
}

function appendTranscript(dir: string, entry: unknown): void {
	appendFileSync(transcriptPath(dir), JSON.stringify(entry) + "\n", "utf8");
}

function locateRunDir(runId: string, game?: string): string | null {
	if (game) {
		const dir = runDir(game, runId);
		return existsSync(metaPath(dir)) ? dir : null;
	}
	if (!existsSync(RUNS_ROOT)) return null;
	const matches: string[] = [];
	for (const g of readdirSync(RUNS_ROOT)) {
		const dir = join(RUNS_ROOT, g, runId);
		if (existsSync(metaPath(dir))) matches.push(dir);
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`run "${runId}" 在多个游戏下存在，请用 --game 指定`);
	return null;
}

function argValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function engineOptsFromEnv() {
	return {
		provider: process.env.CAVE_PROVIDER,
		model: process.env.CAVE_MODEL,
		thinkingLevel: process.env.CAVE_THINKING,
	};
}

function out(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function renderScene(engine: Engine, instruction: string): Promise<string> {
	let text = "";
	const unsub = engine.subscribe((e) => {
		if (e.type === "text_delta") text += e.delta;
	});
	await engine.render(instruction);
	unsub();
	return text;
}

async function cmdStart(game: string, runId: string): Promise<void> {
	const dir = runDir(game, runId);
	mkdirSync(dir, { recursive: true });
	const config = await loadGame(game);
	const sim = new Simulation(config);
	const sessionManager = SessionManager.create(process.cwd(), dir);
	const engine = await Engine.create(config, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const scene = await renderScene(engine, "请用文学笔触描写当前场景。");
		const meta: RunMeta = {
			game,
			runId,
			createdAt: new Date().toISOString(),
			turn: 1,
			sessionFile: engine.sessionFile,
			...engineOptsFromEnv(),
		};
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		saveState(dir, sim);
		appendTranscript(dir, { turn: 1, phase: "start", scene });
		out({
			run: runId,
			turn: 1,
			phase: "start",
			scene,
			visible_entities: sim.visibleEntityIds(),
			state: sim.snapshot(),
		});
	} finally {
		engine.dispose();
	}
}

async function cmdAct(runId: string, intent: string, selection: string | undefined, gameHint?: string): Promise<void> {
	const dir = locateRunDir(runId, gameHint);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const config = await loadGame(meta.game);
	const sim = Simulation.fromState(config, loadState(dir));
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件（${meta.sessionFile ?? "(无)"}），请重新 start`);
	}
	const sessionManager = SessionManager.open(meta.sessionFile);
	const engine = await Engine.create(config, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const texts: string[] = [];
		const unsub = engine.subscribe((e) => {
			if (e.type === "text_delta") texts.push(e.delta);
		});
		const outcome = await engine.act({ intent, selection });
		const narration = texts.join("");
		unsub();

		meta.turn += 1;
		meta.sessionFile = engine.sessionFile;
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		saveState(dir, sim);
		appendTranscript(dir, {
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			kind: outcome.kind,
			intent_label: outcome.intent ?? null,
			result: outcome.result ?? null,
			narration,
		});
		out({
			run: runId,
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			kind: outcome.kind,
			intent_label: outcome.intent ?? null,
			result: outcome.result ?? null,
			narration,
			visible_entities: sim.visibleEntityIds(),
			state: sim.snapshot(),
		});
	} finally {
		engine.dispose();
	}
}

async function cmdRender(runId: string, instruction: string, gameHint?: string): Promise<void> {
	const dir = locateRunDir(runId, gameHint);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const config = await loadGame(meta.game);
	const sim = Simulation.fromState(config, loadState(dir));
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件，请重新 start`);
	}
	const sessionManager = SessionManager.open(meta.sessionFile);
	const engine = await Engine.create(config, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const scene = await renderScene(engine, instruction);
		meta.turn += 1;
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		appendTranscript(dir, { turn: meta.turn, phase: "render", instruction, scene });
		out({
			run: runId,
			turn: meta.turn,
			phase: "render",
			scene,
			visible_entities: sim.visibleEntityIds(),
			state: sim.snapshot(),
		});
	} finally {
		engine.dispose();
	}
}

async function cmdState(runId: string, gameHint?: string): Promise<void> {
	const dir = locateRunDir(runId, gameHint);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const config = await loadGame(meta.game);
	const sim = Simulation.fromState(config, loadState(dir));
	out({
		run: runId,
		turn: meta.turn,
		sessionFile: meta.sessionFile,
		visible_entities: sim.visibleEntityIds(),
		state: sim.snapshot(),
	});
}

async function cmdReset(runId: string, game?: string): Promise<void> {
	const dir = locateRunDir(runId, game);
	if (!dir) {
		process.stdout.write(`run "${runId}" 不存在，无需重置\n`);
		return;
	}
	rmSync(dir, { recursive: true, force: true });
	process.stdout.write(`已重置 run "${runId}"\n`);
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  loop start [--game <id>] [--run <id>]
  loop act <意图文本> [--select <选中文本>] [--run <id>] [--game <id>]
  loop render [--instruction <指令>] [--run <id>] [--game <id>]
  loop state [--run <id>] [--game <id>]
  loop reset [--run <id>] [--game <id>]

选项:
  --game <id>        游戏 id（start 必需；其余命令省略时按 run 自动定位）
  --run <id>         run 标识，默认 "default"
  --select <文本>    act 的可选选中文本
  --instruction <指令>  render 的渲染指令（默认"请用文学笔触重新描写当前场景。"）

环境变量: CAVE_PROVIDER CAVE_MODEL CAVE_THINKING
`);
		return;
	}
	const runId = argValue("--run") ?? "default";
	const game = argValue("--game");
	const selection = argValue("--select");
	const instruction = argValue("--instruction") ?? "请用文学笔触重新描写当前场景。";

	switch (cmd) {
		case "start": {
			if (!game) throw new Error("start 需要 --game <id>");
			await cmdStart(game, runId);
			return;
		}
		case "act": {
			const intent = rest[0];
			if (!intent) throw new Error("act 需要意图文本，例如: loop act \"解下铜戒\"");
			await cmdAct(runId, intent, selection, game);
			return;
		}
		case "render":
			await cmdRender(runId, instruction, game);
			return;
		case "state":
			await cmdState(runId, game);
			return;
		case "reset":
			await cmdReset(runId, game);
			return;
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
