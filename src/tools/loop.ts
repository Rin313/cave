import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Engine } from "../core/engine.ts";
import { Simulation } from "../core/sim.ts";
import type { Change, GameDef, World } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { flagBool, flagStr, out, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

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

function saveMeta(dir: string, meta: RunMeta): void {
	writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
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

/** 把 SDK 会话文件逐条（不过滤）转换为可审阅 MD，写到同名 .review.md 旁。 */
function writeSessionReview(sessionFile: string): void {
	const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return;
	const header = JSON.parse(lines[0]!) as { id?: string };
	const md: string[] = [
		"# 会话审阅 " + (header.id ?? basename(sessionFile)),
		"",
		"> 由 `" + sessionFile + "` 逐条转换，未过滤任何字段。",
		"",
	];
	for (const [i, l] of lines.entries()) {
		const e = JSON.parse(l) as { type: string; message?: { role?: string } };
		md.push("### " + (i + 1) + ". " + e.type + (e.message?.role ? "（" + e.message.role + "）" : ""), "", "```json", l, "```", "");
	}
	writeFileSync(sessionFile.replace(/\.jsonl$/, ".review.md"), md.join("\n"), "utf8");
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
	if (matches.length === 1) return matches[0] ?? null;
	if (matches.length > 1) throw new Error(`run "${runId}" 在多个游戏下存在，请用 --game 指定`);
	return null;
}

/** 引擎配置的环境变量按游戏 id 命名空间读取：<GAME>_PROVIDER / <GAME>_MODEL / <GAME>_THINKING（如 CAVE_PROVIDER）。
 *  多游戏并存时各自独立配置，互不覆盖。 */
function engineOptsFromEnv(gameId: string) {
	const prefix = gameId.toUpperCase();
	return {
		provider: process.env[`${prefix}_PROVIDER`],
		model: process.env[`${prefix}_MODEL`],
		thinkingLevel: process.env[`${prefix}_THINKING`],
	};
}

interface ValidationFailure {
	round: number;
	error: string;
	attempt: string;
}

interface CollectEventsResult {
	unsub: () => void;
	texts: string[];
	validations: ValidationFailure[];
	/** 映射层提交的原始动作提案（tool_call 事件）。 */
	toolCalls: unknown[];
}

function collectEvents(engine: Engine): CollectEventsResult {
	const texts: string[] = [];
	const validations: ValidationFailure[] = [];
	const toolCalls: unknown[] = [];
	const unsub = engine.subscribe((e) => {
		if (e.type === "text_delta") texts.push(e.delta);
		else if (e.type === "validation") validations.push({ round: e.round, error: e.error, attempt: e.attempt });
		else if (e.type === "tool_call") toolCalls.push({ actionCount: e.actionCount, actions: e.actions });
	});
	return { unsub, texts, validations, toolCalls };
}

async function renderScene(engine: Engine, instruction: string, changes: Change[] = []): Promise<{ text: string; validations: ValidationFailure[] }> {
	const { unsub, texts, validations } = collectEvents(engine);
	await engine.render(instruction, changes);
	unsub();
	return { text: texts.join(""), validations };
}

interface CmdOpts {
	json: boolean;
	world: boolean;
}

function emit(entry: unknown, opts: CmdOpts): void {
	if (opts.json) out(entry);
	else {
		const { world, ...rest } = entry as Record<string, unknown>;
		out(opts.world ? { ...rest, world } : rest);
	}
}

interface RunCtx {
	dir: string;
	meta: RunMeta;
	def: GameDef;
	sim: Simulation;
	engine: Engine;
}

/** 打开既有 run 并装配引擎（load meta/state → open session → Engine.create），fn 结束后 dispose。 */
async function withEngine(runId: string, gameId: string | undefined, fn: (ctx: RunCtx) => Promise<void>): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	if (!meta.sessionFile || !existsSync(meta.sessionFile)) {
		throw new Error(`run "${runId}" 缺少 session 文件，请重新 start`);
	}
	const def = getGame(meta.game);
	const sim = new Simulation(def, loadState(dir));
	const engine = await Engine.create(def, { ...engineOptsFromEnv(meta.game), sim, sessionManager: SessionManager.open(meta.sessionFile) });
	try {
		await fn({ dir, meta, def, sim, engine });
	} finally {
		engine.dispose();
	}
}

async function cmdStart(gameId: string, runId: string, opts: CmdOpts): Promise<void> {
	const def = getGame(gameId);
	const dir = runDir(gameId, runId);
	mkdirSync(dir, { recursive: true });
	const sim = new Simulation(def);
	const sessionManager = SessionManager.create(process.cwd(), dir);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(gameId), sim, sessionManager });
	try {
		const { text: scene, validations } = await renderScene(engine, "请用文学笔触描写当前场景。");
		const meta: RunMeta = {
			game: gameId,
			runId,
			createdAt: new Date().toISOString(),
			turn: 1,
			sessionFile: engine.sessionFile,
			...engineOptsFromEnv(gameId),
		};
		saveMeta(dir, meta);
		saveState(dir, sim);
		appendTranscript(dir, { turn: 1, phase: "start", scene, validations });
		writeSessionReview(meta.sessionFile!);
		emit({ run: runId, game: gameId, turn: 1, phase: "start", scene, validations, world: sim.snapshot() }, opts);
	} finally {
		engine.dispose();
	}
}

async function cmdAct(runId: string, intent: string, selection: string | undefined, gameId: string | undefined, opts: CmdOpts): Promise<void> {
	await withEngine(runId, gameId, async ({ dir, meta, sim, engine }) => {
		const { unsub, texts, validations, toolCalls } = collectEvents(engine);
		const outcome = await engine.act({ intent, selection });
		unsub();

		meta.turn += 1;
		meta.sessionFile = engine.sessionFile;
		saveMeta(dir, meta);
		saveState(dir, sim);
		const narration = texts.join("");
		appendTranscript(dir, {
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			toolCalls,
			kind: outcome.kind,
			refusal: outcome.refusal ?? null,
			results: outcome.results,
			narration,
			validations,
		});
		writeSessionReview(meta.sessionFile!);
		emit({
			run: runId,
			game: meta.game,
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			toolCalls,
			kind: outcome.kind,
			refusal: outcome.refusal ?? null,
			results: outcome.results,
			narration,
			validations,
			world: sim.snapshot(),
		}, opts);
	});
}

async function cmdRender(runId: string, instruction: string, gameId: string | undefined, opts: CmdOpts): Promise<void> {
	await withEngine(runId, gameId, async ({ dir, meta, engine }) => {
		const { text: scene, validations } = await renderScene(engine, instruction);
		meta.turn += 1;
		saveMeta(dir, meta);
		appendTranscript(dir, { turn: meta.turn, phase: "render", instruction, scene, validations });
		writeSessionReview(engine.sessionFile!);
		emit({ run: runId, game: meta.game, turn: meta.turn, phase: "render", scene, validations }, opts);
	});
}

async function cmdWait(runId: string, n: number, gameId: string | undefined, opts: CmdOpts): Promise<void> {
	await withEngine(runId, gameId, async ({ dir, meta, sim, engine }) => {
		const results = sim.tick(n);
		const { text: scene, validations } = await renderScene(
			engine,
			"时间流逝。请用文学笔触描写当前场景发生的变化。",
			results.flatMap((r) => r.changes),
		);
		meta.turn += 1;
		meta.sessionFile = engine.sessionFile;
		saveMeta(dir, meta);
		saveState(dir, sim);
		appendTranscript(dir, {
			turn: meta.turn,
			phase: "wait",
			ticks: n,
			events: results,
			scene,
			validations,
		});
		writeSessionReview(meta.sessionFile!);
		emit({
			run: runId,
			game: meta.game,
			turn: meta.turn,
			phase: "wait",
			ticks: n,
			events: results,
			scene,
			validations,
			world: sim.snapshot(),
		}, opts);
	});
}

async function cmdState(runId: string, gameId: string | undefined, opts: CmdOpts): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = new Simulation(def, loadState(dir));
	emit({ run: runId, game: meta.game, turn: meta.turn, sessionFile: meta.sessionFile, serialize: sim.serialize(), world: sim.snapshot() }, opts);
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

/** 解析位置参数为完整意图文本（支持不带引号的多词意图）。 */
function joinIntent(positionals: string[]): string {
	return positionals.join(" ").trim();
}

async function main() {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	const opts: CmdOpts = { json: flagBool(a, "json"), world: flagBool(a, "world") };

	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  loop start --run <id> --game <id> [--json] [--world]
  loop act <意图文本> --run <id> [--select <选中文本>] [--game <id>] [--json] [--world]
  loop render --run <id> [--instruction <指令>] [--game <id>] [--json] [--world]
  loop state --run <id> [--game <id>] [--json] [--world]
  loop wait <n> --run <id> [--game <id>] [--json] [--world]
  loop reset --run <id> [--game <id>]

意图文本可省略引号（多个位置参数自动拼接）；--json 输出完整结构化结果，缺省精简输出（不含 world）。
--game 在 act/render/state/wait 上为可选（用于跨游戏同名 run 消歧）；start 必须显式 --game。
环境变量: <GAME>_PROVIDER <GAME>_MODEL <GAME>_THINKING（按游戏 id 命名空间，如 CAVE_PROVIDER）
`);
		return;
	}

	const runId = requireFlag(a, "run", "用 --run <id> 指定回合记录");
	const gameId = flagStr(a, "game");
	const positionals = a.positionals;

	switch (cmd) {
		case "start":
			await cmdStart(requireFlag(a, "game", "用 --game <id> 指定游戏"), runId, opts);
			return;
		case "act": {
			const intent = flagStr(a, "intent") ?? joinIntent(positionals);
			if (!intent) throw new Error("act 需要意图文本（位置参数或 --intent）");
			await cmdAct(runId, intent, flagStr(a, "select"), gameId, opts);
			return;
		}
		case "render":
			await cmdRender(runId, flagStr(a, "instruction") ?? "请用文学笔触重新描写当前场景。", gameId, opts);
			return;
		case "wait": {
			const n = Number(positionals[0] ?? flagStr(a, "n") ?? 1);
			await cmdWait(runId, n, gameId, opts);
			return;
		}
		case "state":
			await cmdState(runId, gameId, opts);
			return;
		case "reset":
			await cmdReset(runId, gameId);
			return;
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

runMain(main);
