// 编译通过、场景通过、e2e 映射与表达准确都是伪信号，不证明设计正确；验证靠阅读 e2e 会话与分析源码。e2e 的 provider 用 `opencode-go`，model 用 `mimo-v2.5`。
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Engine, type ActOutcome, type TokenUsage } from "../core/engine.ts";
import { resume } from "../core/context.ts";
import { spineLines, type Simulation } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

const runDir = (game: string, runId: string): string => join("runs", game, runId);
/** 会话文件固定名：run 的存在性即此文件的存在性，路径无需 sidecar 记载。 */
const sessionPath = (dir: string): string => join(dir, "session.jsonl");
const transcriptPath = (dir: string): string => join(dir, "transcript.jsonl");

function appendTranscript(dir: string, entry: unknown): void {
	appendFileSync(transcriptPath(dir), JSON.stringify(entry) + "\n", "utf8");
}

function requireRunDir(gameId: string, runId: string): { dir: string; sessionFile: string } {
	const dir = runDir(gameId, runId);
	const sessionFile = sessionPath(dir);
	if (!existsSync(sessionFile)) throw new Error(`run "${runId}" 不存在（game: ${gameId}），请先 start`);
	return { dir, sessionFile };
}

/** 引擎配置按游戏 id 命名空间读取环境变量，多游戏并存互不覆盖。 */
function engineOptsFromEnv(gameId: string): { provider: string; model: string; thinkingLevel?: string } {
	const prefix = gameId.toUpperCase();
	const provider = process.env[`${prefix}_PROVIDER`];
	const model = process.env[`${prefix}_MODEL`];
	if (!provider || !model) throw new Error(`模型未配置：请设置 ${prefix}_PROVIDER 与 ${prefix}_MODEL 环境变量`);
	const thinkingLevel = process.env[`${prefix}_THINKING`];
	return { provider, model, ...(thinkingLevel !== undefined && { thinkingLevel }) };
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function usageLine(rows: TokenUsage[]): string {
	if (!rows.length) return "";
	let i = 0, o = 0, cr = 0, cw = 0;
	for (const r of rows) { i += r.input; o += r.output; cr += r.cacheRead; cw += r.cacheWrite; }
	return `  tok ×${rows.length}：入 ${k(i)}（缓读 ${k(cr)}／缓写 ${k(cw)}）出 ${k(o)}`;
}

function warnWarnings(ws: string[]): void {
	for (const w of ws) console.log(`  ⚠ 叙述兜底：${w}`);
}

function printAct(sim: Simulation, o: {
	turn: number; intent: string;
	outcome: ActOutcome; brief?: boolean;
}): void {
	console.log(`\n【#${o.turn} act】${o.intent}`);
	for (const line of spineLines(sim, o.outcome.steps)) console.log(`  ${line}`);
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
	sim: Simulation;
	engine: Engine;
}

async function withEngine(gameId: string, runId: string, fn: (ctx: RunCtx) => Promise<void>): Promise<void> {
	const { dir, sessionFile } = requireRunDir(gameId, runId);
	const def = getGame(gameId);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(gameId), sessionManager: SessionManager.open(sessionFile) });
	for (const w of engine.loadWarnings) console.log(`  ⚠ ${w}`);
	try {
		await fn({ dir, sim: engine.sim, engine });
	} finally {
		engine.dispose();
	}
}

async function cmdStart(gameId: string, runId: string): Promise<void> {
	const def = getGame(gameId);
	const dir = runDir(gameId, runId);
	const sessionFile = sessionPath(dir);
	if (existsSync(sessionFile)) throw new Error(`run "${runId}" 已存在（game: ${gameId}），loop reset 后再 start`);
	const engine = await Engine.create(def, { ...engineOptsFromEnv(gameId), sessionManager: SessionManager.open(sessionFile) });
	try {
		const { narration: scene, warnings, usage } = await engine.narrate("请用文学笔触描写当前场景。");
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

async function cmdAct(gameId: string, runId: string, intent: string, selection: string | undefined): Promise<void> {
	await withEngine(gameId, runId, async (ctx) => {
		const { dir, sim, engine } = ctx;
		const utterance = selection === undefined ? intent : `${intent}（选中：「${selection}」）`;
		const outcome = await engine.act({ utterance });
		const turn = engine.turn;
		appendTranscript(dir, {
			turn,
			phase: "act",
			raw: intent,
			selection: selection ?? null,
			intent: utterance,
			steps: outcome.steps,
			narration: outcome.narration,
			warnings: outcome.warnings,
			usage: outcome.usage,
		});
		printAct(sim, { turn, intent: utterance, outcome });
	});
}

/** 顺序执行意图文件（一行一意图；#注释跳过）；同一引擎会话内连跑，A/B 意图集用。 */
async function cmdBatch(gameId: string, runId: string, file: string): Promise<void> {
	const lines = readFileSync(file, "utf8").split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (!lines.length) throw new Error(`意图文件 ${file} 为空`);
	await withEngine(gameId, runId, async (ctx) => {
		const { dir, sim, engine } = ctx;
		for (const line of lines) {
			const outcome = await engine.act({ utterance: line });
			const turn = engine.turn;
			appendTranscript(dir, {
				turn, phase: "act", raw: line, selection: null, intent: line,
				steps: outcome.steps,
				narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage,
			});
			printAct(sim, { turn, intent: line, outcome, brief: true });
		}
	});
}

async function cmdRender(gameId: string, runId: string, instruction: string): Promise<void> {
	await withEngine(gameId, runId, async ({ dir, engine }) => {
		const { narration: scene, warnings, usage } = await engine.narrate(instruction);
		appendTranscript(dir, { phase: "render", instruction, scene, warnings, usage });
		console.log(`\n【render】${instruction}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	});
}

function cmdState(gameId: string, runId: string, out: string | undefined): void {
	const { sessionFile } = requireRunDir(gameId, runId);
	const def = getGame(gameId);
	const { sim, lastSeq, warnings } = resume(def, SessionManager.open(sessionFile).getEntries());
	console.log(`【${runId}】${gameId} 已进行 ${lastSeq} 回合`);
	for (const w of warnings) console.log(`  ⚠ ${w}`);
	if (out === undefined) {
		console.log(JSON.stringify(JSON.parse(sim.digest()), null, 1));
		return;
	}
	writeFileSync(out, `${JSON.stringify(sim.snapshot(), null, 1)}\n`, "utf8");
	console.log(`世界快照已导出 → ${out}`);
}

function cmdReset(gameId: string, runId: string): void {
	const { dir } = requireRunDir(gameId, runId);
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

	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  loop start --run <id> --game <id>
  loop act <意图文本> --run <id> --game <id> [--select <选中文本>]
  loop batch <intents.txt> --run <id> --game <id>
  loop render --run <id> --game <id> [--instruction <指令>]
  loop state --run <id> --game <id> [--out <file>]
  loop reset --run <id> --game <id>

输出为紧凑人类可读视图（提案/裁决/叙述与 token 用量）。run 目录 = runs/<game>/<runId>/：session.jsonl 是机器全量档案（回合记录与检查点，装载对账的主侧），transcript.jsonl 是每回合一条的扁平人读视图（A/B 对照与机械 diff）。
batch 意图文件每行一个意图（同一引擎会话内顺序执行，A/B 意图集用）；空行与 # 注释跳过。
--select 由本工具并合进意图（transcript 记 raw/selection 分解）。
render 是研究仪器操作（回合计数不增）：调用场景呈现服务；时间流逝走玩家动词（映射回合），引擎无第二条提案通道。
state 打印状态视图；--out 按需导出世界快照 JSON（机械 diff 用）。
--game 恒必填：run 按游戏分目录，无跨游戏消歧。
环境变量: <GAME>_PROVIDER <GAME>_MODEL <GAME>_THINKING（按游戏 id 命名空间；必填，无默认模型）
`);
		return;
	}

	const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
	const positionals = a.positionals;
	const runId = requireFlag(a, "run", "用 --run <id> 指定回合记录");

	switch (cmd) {
		case "start":
			await cmdStart(gameId, runId);
			return;
		case "act": {
			const intent = flagStr(a, "intent") ?? joinIntent(positionals);
			if (!intent) throw new Error("act 需要意图文本（位置参数或 --intent）");
			await cmdAct(gameId, runId, intent, flagStr(a, "select"));
			return;
		}
		case "batch": {
			const file = positionals[0];
			if (!file) throw new Error("batch 需要意图文件路径（位置参数）");
			await cmdBatch(gameId, runId, file);
			return;
		}
		case "render":
			await cmdRender(gameId, runId, flagStr(a, "instruction") ?? "请用文学笔触重新描写当前场景。");
			return;
		case "state":
			cmdState(gameId, runId, flagStr(a, "out"));
			return;
		case "reset":
			cmdReset(gameId, runId);
			return;
		default:
			throw new Error(`未知命令: ${cmd}`);
	}
}

runMain(main);
