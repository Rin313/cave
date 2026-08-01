import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Engine } from "../core/engine.ts";
import { Simulation } from "../core/sim.ts";
import type { Change, GameDef, World } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";

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

function loadState(dir: string): World {
	return JSON.parse(readFileSync(statePath(dir), "utf8")) as World;
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

interface ValidationFailure {
	round: number;
	error: string;
	attempt: string;
}

function collectEvents(engine: Engine): { unsub: () => void; texts: string[]; validations: ValidationFailure[] } {
	const texts: string[] = [];
	const validations: ValidationFailure[] = [];
	const unsub = engine.subscribe((e) => {
		if (e.type === "text_delta") texts.push(e.delta);
		else if (e.type === "validation") validations.push({ round: e.round, error: e.error, attempt: e.attempt });
	});
	return { unsub, texts, validations };
}

async function renderScene(engine: Engine, instruction: string, changes: Change[] = []): Promise<{ text: string; validations: ValidationFailure[] }> {
	const { unsub, texts, validations } = collectEvents(engine);
	await engine.render(instruction, changes);
	unsub();
	return { text: texts.join(""), validations };
}

async function cmdStart(gameId: string, runId: string): Promise<void> {
	const def = getGame(gameId);
	const dir = runDir(gameId, runId);
	mkdirSync(dir, { recursive: true });
	const sim = new Simulation(def);
	const sessionManager = SessionManager.create(process.cwd(), dir);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const { text: scene, validations } = await renderScene(engine, "请用文学笔触描写当前场景。");
		const meta: RunMeta = {
			game: gameId,
			runId,
			createdAt: new Date().toISOString(),
			turn: 1,
			sessionFile: engine.sessionFile,
			...engineOptsFromEnv(),
		};
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		saveState(dir, sim);
		appendTranscript(dir, { turn: 1, phase: "start", scene, validations });
		out({ run: runId, game: gameId, turn: 1, phase: "start", scene, validations, world: sim.snapshot() });
	} finally {
		engine.dispose();
	}
}

async function cmdAct(runId: string, intent: string, selection: string | undefined, gameId?: string): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = Simulation.fromWorld(def, loadState(dir));
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件（${meta.sessionFile ?? "(无)"}），请重新 start`);
	}
	const sessionManager = SessionManager.open(meta.sessionFile);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const { unsub, texts, validations } = collectEvents(engine);
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
			refusal: outcome.refusal ?? null,
			results: outcome.results,
			narration,
			validations,
		});
		out({
			run: runId,
			game: meta.game,
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			kind: outcome.kind,
			refusal: outcome.refusal ?? null,
			results: outcome.results,
			narration,
			validations,
			world: sim.snapshot(),
		});
	} finally {
		engine.dispose();
	}
}

async function cmdRender(runId: string, instruction: string, gameId?: string): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = Simulation.fromWorld(def, loadState(dir));
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件，请重新 start`);
	}
	const sessionManager = SessionManager.open(meta.sessionFile);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const { text: scene, validations } = await renderScene(engine, instruction);
		meta.turn += 1;
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		appendTranscript(dir, { turn: meta.turn, phase: "render", instruction, scene, validations });
		out({ run: runId, game: meta.game, turn: meta.turn, phase: "render", scene, validations });
	} finally {
		engine.dispose();
	}
}

async function cmdWait(runId: string, n: number, gameId?: string): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = Simulation.fromWorld(def, loadState(dir));
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件，请重新 start`);
	}
	const sessionManager = SessionManager.open(meta.sessionFile);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(), sim, sessionManager });
	try {
		const results = sim.tick(n);
		const { text: scene, validations } = await renderScene(
			engine,
			"时间流逝。请用文学笔触描写当前场景发生的变化。",
			results.flatMap((r) => r.changes),
		);
		meta.turn += 1;
		meta.sessionFile = engine.sessionFile;
		writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
		saveState(dir, sim);
		appendTranscript(dir, {
			turn: meta.turn,
			phase: "wait",
			ticks: n,
			events: results,
			scene,
			validations,
			world: sim.snapshot(),
		});
		out({
			run: runId,
			game: meta.game,
			turn: meta.turn,
			phase: "wait",
			ticks: n,
			events: results,
			scene,
			validations,
			world: sim.snapshot(),
		});
	} finally {
		engine.dispose();
	}
}

async function cmdState(runId: string, gameId?: string): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = Simulation.fromWorld(def, loadState(dir));
	out({ run: runId, game: meta.game, turn: meta.turn, sessionFile: meta.sessionFile, serialize: sim.serialize(), world: sim.snapshot() });
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
  loop start [--run <id>] [--game <id>]
  loop act <意图文本> [--select <选中文本>] [--run <id>] [--game <id>]
  loop render [--instruction <指令>] [--run <id>] [--game <id>]
  loop state [--run <id>] [--game <id>]
  loop wait <n> [--run <id>] [--game <id>]
  loop reset [--run <id>] [--game <id>]

环境变量: CAVE_PROVIDER CAVE_MODEL CAVE_THINKING
`);
		return;
	}
	const runId = argValue("--run") ?? "default";
	const gameId = argValue("--game");
	const selection = argValue("--select");
	const instruction = argValue("--instruction") ?? "请用文学笔触重新描写当前场景。";

	switch (cmd) {
		case "start":
			await cmdStart(gameId ?? "cave", runId);
			return;
		case "act": {
			const intent = rest[0];
			if (!intent) throw new Error("act 需要意图文本");
			await cmdAct(runId, intent, selection, gameId);
			return;
		}
		case "render":
			await cmdRender(runId, instruction, gameId);
			return;
		case "wait": {
			const n = Number(rest[0] ?? 1);
			await cmdWait(runId, n, gameId);
			return;
		}
		case "state":
			await cmdState(runId, gameId);
			return;
		case "reset":
			await cmdReset(runId, gameId);
			return;
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
