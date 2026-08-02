import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Simulation, propGet } from "../core/sim.ts";
import type { Action, GameDef, PropValue, StepResult } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { fixConsole, flagBool, flagStr, out, parseArgs, type ParsedArgs } from "./cli.ts";

interface ScenarioAction {
	verb: string;
	params: Record<string, unknown>;
}

interface StepExpect {
	ok?: boolean;
	reason?: string;
	state?: Record<string, unknown>;
}

interface ScenarioStep {
	name: string;
	action?: ScenarioAction;
	tick?: number;
	expect: StepExpect;
}

interface Scenario {
	name: string;
	steps: ScenarioStep[];
}

interface ScenarioFile {
	game: string;
	name?: string;
	seed?: number;
	scenarios: Scenario[];
}

interface StepReport {
	index: number;
	name: string;
	pass: boolean;
	expected: string;
	actual: string;
	detail: string;
}

interface ScenarioReport {
	name: string;
	passed: number;
	total: number;
	steps: StepReport[];
}

function parseValue(v: unknown): PropValue {
	if (v === null) return null;
	if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(parseValue);
	if (typeof v === "object") {
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, parseValue(val)]));
	}
	return String(v);
}

function asAction(a: ScenarioAction): Action {
	return { verb: a.verb, params: Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, parseValue(v)])) };
}

function checkState(sim: Simulation, checks: Record<string, unknown>): string {
	const failures: string[] = [];
	for (const [path, expected] of Object.entries(checks)) {
		const [id, ...rest] = path.split(".");
		const e = sim.world.entities.find((x) => x.id === id);
		const actual = e ? (propGet(e, rest.join(".")) ?? null) : null;
		if (actual !== expected) {
			failures.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
		}
	}
	return failures.length ? failures.join("; ") : "ok";
}

function runScenario(scenario: Scenario, def: GameDef, seed: number): ScenarioReport {
	const sim = new Simulation(def, seed);
	const reports: StepReport[] = [];
	for (const [i, step] of scenario.steps.entries()) {
		let ok: boolean;
		let reason: string;
		if (step.tick != null) {
			const results = sim.tick(step.tick);
			if (results.length === 0) {
				ok = false;
				reason = "时间流逝，什么也没有发生。";
			} else {
				ok = true;
				reason = results.map((r) => r.reason).join(" ");
			}
		} else if (step.action) {
			const r = sim.apply(asAction(step.action));
			ok = r.ok;
			reason = r.reason;
		} else {
			ok = false;
			reason = "（无效步骤）";
		}

		const problems: string[] = [];
		if (step.expect.ok !== undefined && ok !== step.expect.ok) {
			problems.push(`ok: expected ${step.expect.ok} got ${ok}`);
		}
		if (step.expect.reason && !reason.includes(step.expect.reason)) {
			problems.push(`reason: 期望包含「${step.expect.reason}」，实际「${reason}」`);
		}
		const stateCheck = step.expect.state ? checkState(sim, step.expect.state) : "ok";
		if (stateCheck !== "ok") problems.push(`state: ${stateCheck}`);

		reports.push({
			index: i + 1,
			name: step.name,
			pass: problems.length === 0,
			expected: `ok=${step.expect.ok ?? "-"}${step.expect.reason ? ` reason≈${step.expect.reason}` : ""}${step.expect.state ? ` state[${Object.entries(step.expect.state).map(([k, v]) => `${k}==${JSON.stringify(v)}`).join(" && ")}]` : ""}`,
			actual: `ok=${ok} reason="${reason}"`,
			detail: problems.length ? problems.join(" | ") : "matches",
		});
	}
	return {
		name: scenario.name,
		passed: reports.filter((r) => r.pass).length,
		total: reports.length,
		steps: reports,
	};
}

async function cmdScenario(scenarioPath: string): Promise<void> {
	const file = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile;
	const def = getGame(file.game);
	const reports = file.scenarios.map((s) => runScenario(s, def, file.seed ?? 1));

	const passed = reports.reduce((a, r) => a + r.passed, 0);
	const total = reports.reduce((a, r) => a + r.total, 0);

	for (const sc of reports) {
		console.log(`\n【${sc.name}】`);
		for (const r of sc.steps) {
			console.log(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.index}. ${r.name}`);
			console.log(`    expected: ${r.expected}`);
			console.log(`    actual:   ${r.actual}`);
			if (!r.pass) console.log(`    problems: ${r.detail}`);
		}
	}
	console.log(`\nRESULT: ${passed}/${total} PASS`);

	const reportFile = join("reports", `${basename(scenarioPath, ".json")}.report.json`);
	mkdirSync(dirname(reportFile), { recursive: true });
	writeFileSync(reportFile, JSON.stringify({ scenario: basename(scenarioPath), game: file.game, passed, total, scenarios: reports }, null, 2), "utf8");
	console.log(`REPORT: ${reportFile}`);
	process.exit(passed === total ? 0 : 1);
}

/** 把 token 参数解析为动作；实体参数接受 id 或 name（按世界实体匹配）。 */
function parseActionToken(token: string, def: GameDef): Action {
	const [verb, ...rest] = token.split(/\s+/);
	const resolve = (v: string | undefined): string | undefined => {
		if (!v) return undefined;
		const hit = def.world.entities.find((e) => e.name === v || e.id === v);
		return hit ? hit.id : v;
	};
	if (verb === "move") return { verb: "move", params: { entity: resolve(rest[0]), dest: resolve(rest[1]) } };
	if (verb === "use") return { verb: "use", params: { source: resolve(rest[0]), target: resolve(rest[1]) } };
	if (verb === "set") {
		let value: unknown = rest[2];
		if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (value === "null") value = null;
		else if (value !== undefined && !Number.isNaN(Number(value))) value = Number(value);
		return { verb: "set", params: { entity: resolve(rest[0]), prop: rest[1], value: parseValue(value) } };
	}
	throw new Error(`无法解析动作：${token}（支持 use S T / move X D / set X P V / tick N，实体可用名称）`);
}

function describeAction(action: Action, def: GameDef): string {
	const parts = Object.entries(action.params)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(" ");
	return `${action.verb} ${parts}`.trim();
}

function probeDef(def: GameDef): { gaps: { op: string; reason: string; law?: string }[]; seen: number } {
	const sim = new Simulation(def, 1);
	const ids = [...sim.visible()].filter((id) => id !== def.playerId);
	const itemIds = ids.filter((id) => sim.world.entities.find((e) => e.id === id)?.props.space !== true);
	const gaps: { op: string; reason: string; law?: string }[] = [];
	const seen = new Set<string>();

	const probeAction = (action: Action) => {
		const fresh = new Simulation(def, 1);
		const r = fresh.apply(action);
		if (!r.ok && r.deniedBy === "denyAll") gaps.push({ op: describeAction(action, def), reason: r.reason, law: r.denial?.law });
	};

	const unique = (action: Action) => {
		const key = JSON.stringify(action);
		if (seen.has(key)) return;
		seen.add(key);
		probeAction(action);
	};

	for (const verbName of Object.keys(def.verbs)) {
		const verb = def.verbs[verbName];
		const entityParams = verb.entityParams ?? [];
		const candidates = verb.probe?.(sim) ?? {};
		const paramLists: Record<string, PropValue[]> = {};

		for (const p of entityParams) paramLists[p] = [...itemIds];
		for (const [p, vals] of Object.entries(candidates)) {
			paramLists[p] = vals;
		}

		const keys = Object.keys(paramLists);
		if (!keys.length) continue;

		const generate = (idx: number, acc: Record<string, PropValue>) => {
			if (idx === keys.length) {
				unique({ verb: verbName, params: { ...acc } });
				return;
			}
			const p = keys[idx];
			for (const v of paramLists[p]) {
				acc[p] = v;
				generate(idx + 1, acc);
			}
		};
		generate(0, {});
	}

	return { gaps, seen: seen.size };
}

async function cmdProbe(gameId: string): Promise<void> {
	const def = getGame(gameId);
	const { gaps, seen } = probeDef(def);
	const applyMoveGaps = gaps.filter((g) => g.op.startsWith("use") || g.op.startsWith("move"));
	const setGaps = gaps.filter((g) => g.op.startsWith("set"));
	const byProp = new Map<string, { n: number; examples: string[] }>();
	for (const g of setGaps) {
		const prop = g.op.match(/set \S+ (\S+) /)?.[1] ?? "?";
		const e = byProp.get(prop) ?? { n: 0, examples: [] };
		e.n += 1;
		if (e.examples.length < 3) e.examples.push(g.op);
		byProp.set(prop, e);
	}
	console.log(`=== 法则完整性探测（${def.id}，${seen} 个典型动作）===`);
	console.log(`use/move 缺口: ${applyMoveGaps.length}`);
	for (const g of applyMoveGaps) console.log(`  [GAP] ${g.op} → ${g.reason}`);
	console.log(`set 缺口（按属性分组）: ${setGaps.length}`);
	for (const [prop, e] of [...byProp.entries()].sort((a, b) => b[1].n - a[1].n)) {
		console.log(`  ${prop.padEnd(12)} ×${e.n}  例: ${e.examples.join(" | ")}`);
	}
	console.log(gaps.length === 0 ? "\n无缺口。法则覆盖完整。" : `\n建议为缺口补充具体法则（世界性理由），否则模型会以幻觉填补。`);

	const reportFile = join("reports", `${def.id}.probe.json`);
	mkdirSync(dirname(reportFile), { recursive: true });
	writeFileSync(reportFile, JSON.stringify({ game: def.id, seen, gaps }, null, 2), "utf8");
	console.log(`REPORT: ${reportFile}`);
}

async function cmdRun(tokens: string[], gameId: string, opts: { json: boolean; world: boolean }): Promise<void> {
	const def = getGame(gameId);
	const sim = new Simulation(def, 1);
	const steps: { action: string; result: StepResult }[] = [];
	for (const token of tokens) {
		let results: StepResult[];
		let actionDesc: string;
		if (token === "tick" || token.startsWith("tick ")) {
			const n = Number(token.split(/\s+/)[1] ?? 1);
			actionDesc = `tick ${n}`;
			results = sim.tick(n);
		} else {
			actionDesc = token;
			results = [sim.apply(parseActionToken(token, def))];
		}
		if (results.length === 0) {
			console.log(`\n>>> ${actionDesc}`);
			console.log("（时间流逝，什么也没发生）");
			continue;
		}
		for (const r of results) {
			steps.push({ action: actionDesc, result: r });
			console.log(`\n>>> ${actionDesc}`);
			console.log(`  ${r.ok ? "✓" : "✗"} ${r.reason}`);
			for (const ch of r.changes) console.log(`     ${ch.entity}.${ch.prop}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`);
		}
	}

	if (opts.json) {
		out({
			game: def.id,
			steps: steps.map((s) => s.result),
			world: opts.world ? sim.snapshot() : undefined,
		});
		return;
	}
	if (opts.world) {
		console.log("\n=== 最终世界 ===");
		console.log(sim.serialize());
	}
	console.log("\n=== 变更日志 ===");
	for (const r of sim.log) console.log(`  ${JSON.stringify(r.action)} → ${r.reason}`);
}

async function main(): Promise<void> {
	fixConsole();
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  sim scenario [<scenario.json>] [--game <id>]    运行法则引擎场景验证（默认 scenarios/cave.json）
  sim run <action> [<action>...] [--game <id>] [--json] [--world]    按顺序执行动作并展示结果
    action: use <source> <target> | move <entity> <dest> | set <entity> <prop> <value> | tick <n>
    （实体参数可用名称或 id）
  sim probe [--game <id>]    穷举可见实体的动作组合，报告落到 denyAll 的法则缺口（写 reports/<game>.probe.json）
`);
		return;
	}
	const gameId = flagStr(a, "game") ?? "cave";
	const positionals = a.positionals;
	if (cmd === "scenario") {
		await cmdScenario(positionals[0] ?? "scenarios/cave.json");
		return;
	}
	if (cmd === "run") {
		await cmdRun(positionals, gameId, { json: flagBool(a, "json"), world: flagBool(a, "world") });
		return;
	}
	if (cmd === "probe") {
		await cmdProbe(gameId);
		return;
	}
	throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
