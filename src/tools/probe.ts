import { existsSync, readFileSync } from "node:fs";
import { parseRecordLines } from "../core/archive.ts";
import { loadGame } from "../core/games.ts";
import { dataDir, runPaths } from "../core/paths.ts";
import { ProtocolViolation, Simulation, audienceOf, lawOf, refParamsOf } from "../core/sim.ts";
import type { Action, Denial, GameDef, Value } from "../core/sim.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

/** 违约判据：引擎侧否决（必要性通道）——出现即缺陷；冒烟无见证不证明无缺陷。 */
interface Witness {
	where?: string;
	op: string;
	point: string;
	debug: string;
}

function witnessOf(op: string, denial: Denial): Witness | null {
	if (audienceOf(denial.point) !== "engine") return null;
	return { op, point: lawOf(denial.point), debug: denial.text ?? "" };
}

function opLabel(action: Action): string {
	const parts = Object.entries(action.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
	return `${action.verb} ${parts}`.trim();
}

/** 冒烟生成域＝初始世界 × 可指称域：指称穷举，必填自由参数取代表常量，值条件与状态条件不被穷举。 */
function smoke(def: GameDef, maxCombos: number): { witnesses: Witness[]; total: number; truncated: boolean } {
	const scope = [...new Simulation(def).fieldView().referable];
	const witnesses: Witness[] = [];
	let total = 0;
	let truncated = false;

	const probeAction = (action: Action): void => {
		if (total >= maxCombos) {
			truncated = true;
			return;
		}
		total++;
		const op = opLabel(action);
		try {
			const { step, elapsed } = new Simulation(def).apply(action);
			if (!step.ok) {
				const w = witnessOf(op, step.denial);
				if (w) witnesses.push(w);
			}
			for (const t of elapsed) {
				if (t.ok) continue;
				const w = witnessOf(op, t.denial);
				if (w) witnesses.push(w);
			}
		} catch (e) {
			if (e instanceof ProtocolViolation) throw new Error(`探测生成越界（${e.code}）：${op}`);
			witnesses.push({ op, point: "apply.crash", debug: e instanceof Error ? e.message : String(e) });
		}
	};

	for (const [verbName, verb] of Object.entries(def.verbs)) {
		const refs = refParamsOf(verb);
		const seed: Record<string, Value> = {};
		for (const [p, s] of Object.entries(verb.params)) {
			if (s.optional || refs.includes(p)) continue;
			const base = s.type === "number" ? 1 : s.type === "boolean" ? true : "…";
			seed[p] = s.many === true ? [base] : base;
		}
		const candidates = (p: string): Value[] => {
			if (verb.params[p]?.many === true) {
				const singles = scope.map((v): Value => [v]);
				return scope.length > 1 ? [...singles, [...scope]] : singles;
			}
			return [...scope];
		};
		const generate = (idx: number, acc: Record<string, Value>): void => {
			if (truncated) return;
			if (idx === refs.length) {
				probeAction({ verb: verbName, params: { ...seed, ...acc } });
				return;
			}
			const p = refs[idx]!;
			for (const v of candidates(p)) {
				acc[p] = v;
				generate(idx + 1, acc);
			}
		};
		generate(0, {});
	}
	return { witnesses, total, truncated };
}

/** 扫档：记录内的 engine 点；不装载 def、不重放，坏 def 亦可读。 */
function scanRecords(game: string, run: string, root: string): { witnesses: Witness[]; turns: number; broken: number } {
	const path = runPaths(game, run, root).records;
	if (!existsSync(path)) throw new Error(`运行 ${game}/${run} 无回合记录（${path}）`);
	const witnesses: Witness[] = [];
	let turns = 0;
	let broken = 0;
	for (const line of parseRecordLines(readFileSync(path, "utf8"))) {
		if (line.kind === "broken") {
			broken++;
			continue;
		}
		turns++;
		for (const step of line.record.steps) {
			if (step.ok) continue;
			const w = witnessOf(opLabel(step.action), step.denial);
			if (w) witnesses.push({ ...w, where: `#${line.record.seq} t${step.at}` });
		}
	}
	return { witnesses, turns, broken };
}

const USAGE = `用法：probe --game <id> [--run <name>] [--data-dir <目录>] [--max <预算>]
  缺 --run：初始世界 × 可指称域的单步冒烟（见证搜索，不构成验证）
  带 --run：扫该档回合记录里的 engine 点（真实故障所在；不装载 def）`;

async function cmdSmoke(gameId: string, root: string, maxCombos: number): Promise<void> {
	const def = await loadGame(gameId, [root]);
	const { witnesses, total, truncated } = smoke(def, maxCombos);
	console.log(`=== 冒烟检查（${gameId}）：生成 ${total} 个动作${truncated ? "，已达 --max 预算截断" : ""} ===`);
	if (!witnesses.length) {
		console.log("未发现引擎侧违约（见证搜索，不构成验证）。");
		return;
	}
	for (const w of witnesses) console.log(`[违约] ${w.op} → ${w.point}：${w.debug}`);
	console.log(`\n引擎侧违约见证 ${witnesses.length} 条（规则抛错、engine 点、invariant engine fault、apply 崩溃）。`);
	process.exitCode = 1;
}

function cmdRecords(gameId: string, run: string, root: string): void {
	const { witnesses, turns, broken } = scanRecords(gameId, run, root);
	console.log(`=== 记录检查（${gameId}/${run}）：${turns} 回合${broken ? `，${broken} 条形状损坏` : ""} ===`);
	if (!witnesses.length) {
		console.log("未发现引擎侧违约（记录内 engine 受众的否决）。");
		return;
	}
	for (const w of witnesses) console.log(`[违约] ${w.where} ${w.op} → ${w.point}：${w.debug}`);
	console.log(`\n引擎侧违约见证 ${witnesses.length} 条。`);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd) throw new Error(USAGE);
	if (cmd !== "probe") throw new Error(`未知命令: ${cmd}\n${USAGE}`);
	const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
	const root = flagStr(a, "data-dir") ?? dataDir();
	const run = flagStr(a, "run");
	if (run !== undefined) {
		cmdRecords(gameId, run, root);
		return;
	}
	const max = Number(flagStr(a, "max") ?? 10000);
	await cmdSmoke(gameId, root, Number.isFinite(max) && max > 0 ? max : 10000);
}

runMain(main);
