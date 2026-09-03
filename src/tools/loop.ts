import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Engine, type ActOutcome, type TokenUsage, type TurnWarning } from "../core/engine.ts";
import { Simulation, spineLines } from "../core/sim.ts";
import type { GameDef, TickStep, World } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { devWait, withDevWait } from "./dev.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

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

/** 引擎配置的环境变量按游戏 id 命名空间读取：<GAME>_PROVIDER / <GAME>_MODEL / <GAME>_THINKING。
 *  多游戏并存时各自独立配置，互不覆盖 */
function engineOptsFromEnv(gameId: string): { provider: string; model: string; thinkingLevel?: string } {
	const prefix = gameId.toUpperCase();
	const provider = process.env[`${prefix}_PROVIDER`];
	const model = process.env[`${prefix}_MODEL`];
	if (!provider || !model) throw new Error(`模型未配置：请设置 ${prefix}_PROVIDER 与 ${prefix}_MODEL 环境变量`);
	return { provider, model, thinkingLevel: process.env[`${prefix}_THINKING`] };
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function usageLine(rows: TokenUsage[]): string {
	if (!rows.length) return "";
	let i = 0, o = 0, cr = 0, cw = 0;
	for (const r of rows) { i += r.input; o += r.output; cr += r.cacheRead; cw += r.cacheWrite; }
	return `  tok ×${rows.length}：入 ${k(i)}（缓读 ${k(cr)}／缓写 ${k(cw)}）出 ${k(o)}`;
}

function warnWarnings(ws: TurnWarning[]): void {
	for (const w of ws) console.log(`  ⚠ 叙述兜底 round${w.round}：${w.error}`);
}

function printAct(sim: Simulation, o: {
	turn: number; intent: string; selection?: string | null;
	outcome: ActOutcome; brief?: boolean;
}): void {
	const sel = o.selection ? `（选中：「${o.selection}」）` : "";
	console.log(`\n【#${o.turn} act】${o.intent}${sel}`);
	for (const a of o.outcome.proposals) console.log(`  提案 ${a.verb}${JSON.stringify(a.params ?? {})}`);
	for (const line of spineLines(sim, [...o.outcome.results, ...o.outcome.elapsed])) console.log(`  ${line}`);
	warnWarnings(o.outcome.warnings);
	const u = usageLine(o.outcome.usage);
	if (u) console.log(u);
	const narration = o.outcome.narration;
	if (o.brief) {
		const first = narration.split(/\n/).find((l) => l.trim()) ?? "";
		console.log(`  ┈ ${first.length > 100 ? `${first.slice(0, 100)}…` : first}`);
	} else {
		console.log(`  ┈ ${narration.replace(/\n/g, "\n  ")}`);
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
	// Simulation 挂研究动词（wait 走同一裁决边界）；Engine 仍持原始 def——合成动词不进映射层
	const sim = new Simulation(withDevWait(def), loadState(dir));
	const engine = await Engine.create(def, { ...engineOptsFromEnv(meta.game), sim, sessionManager: SessionManager.open(meta.sessionFile) });
	try {
		await fn({ dir, meta, def, sim, engine });
	} finally {
		engine.dispose();
	}
}

function persistRun(ctx: RunCtx): void {
	ctx.meta.sessionFile = ctx.engine.sessionFile;
	saveMeta(ctx.dir, ctx.meta);
	saveState(ctx.dir, ctx.sim);
}

async function cmdStart(gameId: string, runId: string): Promise<void> {
	const def = getGame(gameId);
	const dir = runDir(gameId, runId);
	mkdirSync(dir, { recursive: true });
	const sim = new Simulation(withDevWait(def));
	const sessionManager = SessionManager.create(process.cwd(), dir);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(gameId), sim, sessionManager });
	try {
		const { narration: scene, warnings, usage } = await engine.narrate("请用文学笔触描写当前场景。");
		const meta: RunMeta = {
			game: gameId,
			runId,
			createdAt: new Date().toISOString(),
			turn: 0,
			sessionFile: engine.sessionFile,
			...engineOptsFromEnv(gameId),
		};
		saveMeta(dir, meta);
		saveState(dir, sim);
		appendTranscript(dir, { phase: "start", scene, warnings, usage });
		console.log(`【${runId}·start】${def.title}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	} finally {
		engine.dispose();
	}
}

async function cmdAct(runId: string, intent: string, selection: string | undefined, gameId: string | undefined): Promise<void> {
	await withEngine(runId, gameId, async (ctx) => {
		const { dir, meta, sim, engine } = ctx;
		const outcome = await engine.act({ intent, selection });

		meta.turn += 1;
		persistRun(ctx);
		appendTranscript(dir, {
			turn: meta.turn,
			phase: "act",
			intent,
			selection: selection ?? null,
			proposals: outcome.proposals,
			results: outcome.results,
			elapsed: outcome.elapsed,
			narration: outcome.narration,
			warnings: outcome.warnings,
			usage: outcome.usage,
		});
		printAct(sim, { turn: meta.turn, intent, selection, outcome });
	});
}

/** 顺序执行意图文件（一行一意图；#注释/@wait N）；同一引擎会话内连跑，A/B 意图集用。 */
async function cmdBatch(runId: string, file: string, gameId: string | undefined): Promise<void> {
	const lines = readFileSync(file, "utf8").split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (!lines.length) throw new Error(`意图文件 ${file} 为空`);
	await withEngine(runId, gameId, async (ctx) => {
		const { dir, meta, sim, engine } = ctx;
		for (const line of lines) {
			if (line.startsWith("@wait")) {
				const n = Number(line.split(/\s+/)[1] ?? 1);
				const res = sim.apply(devWait(n));
				const results = res.elapsed;
				appendTranscript(dir, { phase: "wait", ticks: n, step: res.step, events: results, usage: [] });
				console.log(`\n【wait ${n}】${results.map((r) => r.reason).join("；") || "无事发生"}`);
			} else {
				const outcome = await engine.act({ intent: line });
				meta.turn += 1;
				appendTranscript(dir, {
					turn: meta.turn, phase: "act", intent: line, selection: null,
					proposals: outcome.proposals, results: outcome.results, elapsed: outcome.elapsed,
					narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage,
				});
				printAct(sim, { turn: meta.turn, intent: line, outcome, brief: true });
			}
			persistRun(ctx);
		}
	});
}

async function cmdRender(runId: string, instruction: string, gameId: string | undefined): Promise<void> {
	await withEngine(runId, gameId, async ({ dir, engine }) => {
		const { narration: scene, warnings, usage } = await engine.narrate(instruction);
		appendTranscript(dir, { phase: "render", instruction, scene, warnings, usage });
		console.log(`\n【render】${instruction}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	});
}

async function cmdWait(runId: string, n: number, gameId: string | undefined): Promise<void> {
	await withEngine(runId, gameId, async (ctx) => {
		const { dir, meta, sim, engine } = ctx;
		const res = sim.apply(devWait(n));
		const results = res.elapsed;
		const { narration: scene, warnings, usage } = await engine.narrate(
			"时间流逝。请用文学笔触描写当前场景发生的变化。",
			results,
		);
		persistRun(ctx);
		appendTranscript(dir, { phase: "wait", ticks: n, step: res.step, events: results, scene, warnings, usage });
		console.log(`\n【wait ${n}】${results.map((r) => r.reason).join("；") || "无事发生"}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	});
}

async function cmdState(runId: string, gameId: string | undefined): Promise<void> {
	const dir = locateRunDir(runId, gameId);
	if (!dir) throw new Error(`run "${runId}" 不存在，请先 start`);
	const meta = loadMeta(dir);
	const def = getGame(meta.game);
	const sim = new Simulation(def, loadState(dir));
	console.log(`【${runId}】${meta.game} 已进行 ${meta.turn} 回合`);
	console.log(JSON.stringify(JSON.parse(sim.digest()), null, 1));
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

interface ReportRow {
	dir: string;
	provider?: string;
	model?: string;
	acts: number;
	waits: number;
	tin: number;
	tout: number;
	cread: number;
	firstIn: number | null;
	lastIn: number | null;
}

/** 汇总 runs/ 下各 run 的回合数与 token 用量 */
function collectReport(gameId: string | undefined): ReportRow[] {
	const rows: ReportRow[] = [];
	if (!existsSync(RUNS_ROOT)) return rows;
	for (const g of readdirSync(RUNS_ROOT).sort()) {
		if (gameId && g !== gameId) continue;
		const gdir = join(RUNS_ROOT, g);
		for (const id of readdirSync(gdir).sort()) {
			const dir = join(gdir, id);
			const tp = transcriptPath(dir);
			if (!existsSync(tp)) continue;
			const row: ReportRow = { dir: `${g}/${id}`, acts: 0, waits: 0, tin: 0, tout: 0, cread: 0, firstIn: null, lastIn: null };
			try {
				const meta = JSON.parse(readFileSync(metaPath(dir), "utf8")) as Partial<RunMeta>;
				row.provider = meta.provider;
				row.model = meta.model;
			} catch {
				// meta 缺失不阻断聚合
			}
			for (const l of readFileSync(tp, "utf8").split(/\r?\n/)) {
				if (!l.trim()) continue;
				let e: { phase?: string; usage?: TokenUsage[] };
				try {
					e = JSON.parse(l);
				} catch {
					continue;
				}
				if (e.phase === "act") row.acts++;
				if (e.phase === "wait") row.waits++;
				for (const u of Array.isArray(e.usage) ? e.usage : []) {
					row.tin += u.input;
					row.tout += u.output;
					row.cread += u.cacheRead;
					row.lastIn = u.input;
					row.firstIn ??= u.input;
				}
			}
			rows.push(row);
		}
	}
	return rows;
}

function printReport(rows: ReportRow[], gameId: string | undefined): void {
	const scope = gameId ?? "全部游戏";
	if (!rows.length) {
		console.log(`runs/ 下没有可汇总的 transcript（scope: ${scope}）。`);
		return;
	}
	console.log(`=== loop report（${scope}）===`);
	for (const r of rows) {
		// provider 的 usage.input 不含缓存命中，缓存份额分母 = input + cacheRead
		const cache = r.tin + r.cread ? `${Math.round((r.cread / (r.tin + r.cread)) * 100)}%` : "-";
		const trend = r.firstIn != null ? `${k(r.firstIn)}→${k(r.lastIn ?? 0)}` : "-";
		const model = [r.provider, r.model].filter(Boolean).join("/") || "-";
		console.log(
			`${r.dir.padEnd(26)} ${model.padEnd(24)} act=${r.acts} wait=${r.waits}  入 ${trend}  出 ${k(r.tout)}  缓读 ${cache}`,
		);
	}
	if (rows.length > 1) {
		const sum = (f: (r: ReportRow) => number): number => rows.reduce((a, r) => a + f(r), 0);
		console.log(
			`${"TOTAL".padEnd(26)} ${"-".padEnd(24)} act=${sum((r) => r.acts)} wait=${sum((r) => r.waits)}  出 ${k(sum((r) => r.tout))}`,
		);
	}
}

/** 解析位置参数为完整意图文本（支持不带引号的多词意图）。 */
function joinIntent(positionals: string[]): string {
	return positionals.join(" ").trim();
}

async function main() {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);

	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  loop start --run <id> --game <id>
  loop act <意图文本> --run <id> [--select <选中文本>] [--game <id>]
  loop batch <intents.txt> --run <id> [--game <id>]
  loop render --run <id> [--instruction <指令>] [--game <id>]
  loop state --run <id> [--game <id>]
  loop wait <n> --run <id> [--game <id>]
  loop report [--game <id>]
  loop reset --run <id> [--game <id>]

输出为紧凑人类可读视图（提案/裁决/叙述与 token 用量）；结构化数据以 transcript.jsonl / state.json / meta.json 落盘在 runs/ 下，供 A/B 对照与机械 diff。
batch 意图文件每行一个意图（同一引擎会话内顺序执行，A/B 意图集用）；空行与 # 注释跳过；@wait N 为时间流逝 N 刻。
render/wait 是研究仪器操作（不计回合、不进近况）：render 调用场景呈现服务；wait 以合成研究动词过裁决落钟（tools/dev.ts）。
report 汇总 runs/ 各 run 的回合数与 token 用量（入列首→末展示裁剪后的输入趋势；缓读% 依赖 provider 的 usage 口径）。
--game 在 act/batch/render/state/wait 上为可选（用于跨游戏同名 run 消歧）；start 必须显式 --game。
环境变量: <GAME>_PROVIDER <GAME>_MODEL <GAME>_THINKING（按游戏 id 命名空间；必填，无默认模型）
`);
		return;
	}

	const gameId = flagStr(a, "game");
	const positionals = a.positionals;
	// report 不绑定具体 run；其余命令都需要 --run
	const runId = cmd === "report" ? "" : requireFlag(a, "run", "用 --run <id> 指定回合记录");

	switch (cmd) {
		case "start":
			await cmdStart(requireFlag(a, "game", "用 --game <id> 指定游戏"), runId);
			return;
		case "act": {
			const intent = flagStr(a, "intent") ?? joinIntent(positionals);
			if (!intent) throw new Error("act 需要意图文本（位置参数或 --intent）");
			await cmdAct(runId, intent, flagStr(a, "select"), gameId);
			return;
		}
		case "batch": {
			const file = positionals[0];
			if (!file) throw new Error("batch 需要意图文件路径（位置参数）");
			await cmdBatch(runId, file, gameId);
			return;
		}
		case "render":
			await cmdRender(runId, flagStr(a, "instruction") ?? "请用文学笔触重新描写当前场景。", gameId);
			return;
		case "wait": {
			const n = Number(positionals[0] ?? flagStr(a, "n") ?? 1);
			await cmdWait(runId, n, gameId);
			return;
		}
		case "state":
			await cmdState(runId, gameId);
			return;
		case "report":
			printReport(collectReport(gameId), gameId);
			return;
		case "reset":
			await cmdReset(runId, gameId);
			return;
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

runMain(main);
