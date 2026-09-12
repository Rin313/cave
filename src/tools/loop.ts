// 编译通过、场景通过、e2e 映射与表达准确都是伪信号，不证明设计正确；验证靠阅读 e2e 会话与分析源码。e2e 的 provider 用 `opencode-go`，model 用 `mimo-v2.5`。
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type ActOutcome, type Engine, type TokenUsage } from "../core/engine.ts";
import { openArchive } from "../core/archive.ts";
import { spineLines, type Simulation } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";
import { openRun, runPaths, type RunPaths } from "./runs.ts";

function appendTranscript(path: string, entry: unknown): void {
	appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

function requirePaths(gameId: string, runId: string): RunPaths {
	const paths = runPaths(gameId, runId);
	if (!existsSync(paths.records) && !existsSync(paths.session)) throw new Error(`run "${runId}" 不存在（game: ${gameId}），请先 start`);
	return paths;
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
	turn: number; utterance: string;
	outcome: ActOutcome; brief?: boolean;
}): void {
	console.log(`\n【#${o.turn} act】${o.utterance}`);
	for (const line of spineLines(sim, o.outcome.steps, sim.snapshot())) console.log(`  ${line}`);
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
	paths: RunPaths;
	sim: Simulation;
	engine: Engine;
}

async function withEngine(gameId: string, runId: string, fn: (ctx: RunCtx) => Promise<void>): Promise<void> {
	const paths = requirePaths(gameId, runId);
	const engine = await openRun(gameId, runId);
	for (const w of engine.loadWarnings) console.log(`  ⚠ ${w}`);
	try {
		await fn({ paths, sim: engine.sim, engine });
	} finally {
		engine.dispose();
	}
}

async function cmdStart(gameId: string, runId: string): Promise<void> {
	const paths = runPaths(gameId, runId);
	if (existsSync(paths.records) || existsSync(paths.session)) throw new Error(`run "${runId}" 已存在（game: ${gameId}），loop reset 后再 start`);
	const engine = await openRun(gameId, runId);
	try {
		const { narration: scene, warnings, usage } = await engine.narrate("请用文学笔触描写当前场景。");
		appendTranscript(paths.transcript, { phase: "start", scene, warnings, usage });
		console.log(`【${runId}·start】${gameId}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	} finally {
		engine.dispose();
	}
}

async function cmdAct(gameId: string, runId: string, raw: string, selection: string | undefined): Promise<void> {
	await withEngine(gameId, runId, async (ctx) => {
		const { paths, sim, engine } = ctx;
		const utterance = selection === undefined ? raw : `${raw}（选中：「${selection}」）`;
		const outcome = await engine.act({ utterance });
		const turn = engine.turn;
		appendTranscript(paths.transcript, {
			turn,
			phase: "act",
			raw,
			selection: selection ?? null,
			utterance,
			steps: outcome.steps,
			narration: outcome.narration,
			warnings: outcome.warnings,
			usage: outcome.usage,
		});
		printAct(sim, { turn, utterance, outcome });
	});
}

/** 顺序执行话语文件（一行一话语；#注释跳过）；同一引擎会话内连跑，A/B 话语集用。 */
async function cmdBatch(gameId: string, runId: string, file: string): Promise<void> {
	const lines = readFileSync(file, "utf8").split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (!lines.length) throw new Error(`话语文件 ${file} 为空`);
	await withEngine(gameId, runId, async (ctx) => {
		const { paths, sim, engine } = ctx;
		for (const line of lines) {
			const outcome = await engine.act({ utterance: line });
			const turn = engine.turn;
			appendTranscript(paths.transcript, {
				turn, phase: "act", raw: line, selection: null, utterance: line,
				steps: outcome.steps,
				narration: outcome.narration, warnings: outcome.warnings, usage: outcome.usage,
			});
			printAct(sim, { turn, utterance: line, outcome, brief: true });
		}
	});
}

async function cmdRender(gameId: string, runId: string, instruction: string): Promise<void> {
	await withEngine(gameId, runId, async ({ paths, engine }) => {
		const { narration: scene, warnings, usage } = await engine.narrate(instruction);
		appendTranscript(paths.transcript, { phase: "render", instruction, scene, warnings, usage });
		console.log(`\n【render】${instruction}`);
		console.log(scene);
		warnWarnings(warnings);
		const u = usageLine(usage);
		if (u) console.log(u);
	});
}

function cmdState(gameId: string, runId: string, out: string | undefined): void {
	const { records } = requirePaths(gameId, runId);
	const def = getGame(gameId);
	const { sim, lastSeq, warnings } = openArchive(records).load(def);
	console.log(`【${runId}】${gameId} 已进行 ${lastSeq} 回合`);
	for (const w of warnings) console.log(`  ⚠ ${w}`);
	if (out === undefined) {
		console.log(JSON.stringify(sim.view(), null, 1));
		return;
	}
	writeFileSync(out, `${JSON.stringify(sim.snapshot(), null, 1)}\n`, "utf8");
	console.log(`世界快照已导出 → ${out}`);
}

function cmdReset(gameId: string, runId: string): void {
	const { dir } = requirePaths(gameId, runId);
	rmSync(dir, { recursive: true, force: true });
	process.stdout.write(`已重置 run "${runId}"\n`);
}

/** 解析位置参数为完整话语（支持不带引号的多词文本）。 */
function joinUtterance(positionals: string[]): string {
	return positionals.join(" ").trim();
}

async function main() {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);

	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  loop start --run <id> --game <id>
  loop act <话语> --run <id> --game <id> [--select <选中文本>]
  loop batch <utterances.txt> --run <id> --game <id>
  loop render --run <id> --game <id> [--instruction <指令>]
  loop state --run <id> --game <id> [--out <file>]
  loop reset --run <id> --game <id>

输出为紧凑人类可读视图（提案/裁决/叙述与 token 用量）。run 目录 = runs/<game>/<runId>/：records.jsonl 是机器档案（回合记录，装载重放的主侧），session.jsonl 是 pi 原始会话 trace（非证据），transcript.jsonl 是每回合一条的扁平人读视图（A/B 对照与机械 diff）。
batch 话语文件每行一条（同一引擎会话内顺序执行，A/B 话语集用）；空行与 # 注释跳过。
--select 由本工具并合进话语（transcript 记 raw/selection 分解）。
render 是研究操作（回合计数不增）：调用场景呈现服务；时间流逝走玩家动词（映射回合）。
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
			const utterance = flagStr(a, "utterance") ?? joinUtterance(positionals);
			if (!utterance) throw new Error("act 需要话语（位置参数或 --utterance）");
			await cmdAct(gameId, runId, utterance, flagStr(a, "select"));
			return;
		}
		case "batch": {
			const file = positionals[0];
			if (!file) throw new Error("batch 需要文件路径（位置参数）");
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
