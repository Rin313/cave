import { loadGame } from "../core/games.ts";
import { dataDir } from "../core/paths.ts";
import { ProtocolViolation, Simulation, audienceOf, lawOf, refParamsOf } from "../core/sim.ts";
import type { Action, Denial, GameDef, Value } from "../core/sim.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

/** 违约判据：引擎侧否决（必要性通道）——出现即缺陷；搜索无见证不证明无缺陷。 */
interface Witness {
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

/** 生成域＝初始世界×所指域：指称参数穷举，必填自由参数取代表常量，值条件与状态条件不被穷举。 */
function scan(def: GameDef, maxCombos: number): { witnesses: Witness[]; total: number; truncated: boolean } {
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

async function cmdProbe(gameId: string, root: string, maxCombos: number): Promise<void> {
	const def = await loadGame(gameId, [root]);
	const { witnesses, total, truncated } = scan(def, maxCombos);
	console.log(`=== 执行检查（${gameId}）：生成 ${total} 个动作${truncated ? "，已达 --max 预算截断" : ""} ===`);
	if (!witnesses.length) {
		console.log("未发现引擎侧违约（见证搜索，不构成验证）。");
		return;
	}
	for (const w of witnesses) console.log(`[违约] ${w.op} → ${w.point}：${w.debug}`);
	console.log(`\n引擎侧违约见证 ${witnesses.length} 条（规则抛错、engine 点、invariant engine fault、apply 崩溃）。`);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd) throw new Error("缺少命令");
	if (cmd === "probe") {
		const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
		const root = flagStr(a, "data-dir") ?? dataDir();
		const max = Number(flagStr(a, "max") ?? 10000);
		await cmdProbe(gameId, root, Number.isFinite(max) && max > 0 ? max : 10000);
		return;
	}
	throw new Error(`未知命令: ${cmd}`);
}

runMain(main);
