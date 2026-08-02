import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Simulation } from "../core/sim.ts";
import type { Op, PropValue } from "../core/sim.ts";
import type { GameDef } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";

type OpLike =
	| { kind: "apply"; source: string; target: string }
	| { kind: "move"; entity: string; dest: string }
	| { kind: "set"; entity: string; prop: string; value: unknown };

interface StepExpect {
	ok?: boolean;
	reason?: string;
	state?: Record<string, unknown>;
}

interface ScenarioStep {
	name: string;
	op?: OpLike;
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
	return String(v);
}

function asOp(op: OpLike): Op {
	if (op.kind === "set") return { kind: "set", entity: op.entity, prop: op.prop, value: parseValue(op.value) };
	return op;
}

function checkState(sim: Simulation, checks: Record<string, unknown>): string {
	const failures: string[] = [];
	for (const [path, expected] of Object.entries(checks)) {
		const [id, ...rest] = path.split(".");
		const e = sim.world.entities.find((x) => x.id === id);
		const actual = e ? (e.props[rest.join(".")] ?? null) : null;
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
		} else if (step.op) {
			const r = sim.apply(asOp(step.op));
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

function parseOpToken(token: string): Op {
	const [kind, ...rest] = token.split(/\s+/);
	if (kind === "apply") return { kind: "apply", source: rest[0], target: rest[1] };
	if (kind === "move") return { kind: "move", entity: rest[0], dest: rest[1] };
	if (kind === "set") {
		let value: unknown = rest[2];
		if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (value === "null") value = null;
		else if (value !== undefined && !Number.isNaN(Number(value))) value = Number(value);
		return { kind: "set", entity: rest[0], prop: rest[1], value: parseValue(value) };
	}
	throw new Error(`无法解析操作：${token}（支持 apply S T / move X D / set X P V / tick N）`);
}

const BOOL_PROPS = ["open", "lit", "burning", "jammed", "flammable", "lightable", "openable", "grabbable", "wedgeable"];

function describeOp(op: Op): string {
	if (op.kind === "apply") return `apply ${op.source} ${op.target}`;
	if (op.kind === "move") return `move ${op.entity} ${op.dest}`;
	return `set ${op.entity} ${op.prop} ${JSON.stringify(op.value)}`;
}

function probeDef(def: GameDef): { gaps: { op: string; reason: string }[]; seen: number } {
	const sim = new Simulation(def, 1);
	const ids = [...sim.visibleIds].filter((id) => id !== def.playerId);
	const itemIds = ids.filter((id) => sim.world.entities.find((e) => e.id === id)?.props.space !== true);
	const internal = new Set(def.internalProps ?? []);
	const gaps: { op: string; reason: string }[] = [];
	const seen = new Set<string>();

	const probeOp = (op: Op) => {
		const fresh = new Simulation(def, 1);
		const r = fresh.apply(op);
		if (!r.ok && r.deniedBy === "denyAll") gaps.push({ op: describeOp(op), reason: r.reason });
	};

	const unique = (op: Op) => {
		const key = describeOp(op);
		if (seen.has(key)) return;
		seen.add(key);
		probeOp(op);
	};

	for (const s of itemIds) {
		for (const t of ids) {
			if (s === t) continue;
			unique({ kind: "apply", source: s, target: t });
		}
	}
	for (const e of itemIds) {
		for (const d of ids) {
			if (e === d) continue;
			unique({ kind: "move", entity: e, dest: d });
		}
	}
	for (const e of itemIds) {
		const props = new Set<string>([...BOOL_PROPS, "attachedTo", "material", "in"]);
		for (const ent of sim.world.entities) {
			if (ent.id === e) continue;
			for (const k of Object.keys(ent.props)) {
				if (!internal.has(k)) props.add(k);
			}
		}
		for (const p of props) {
			const values = new Set<PropValue>([true, false, null]);
			for (const ent of sim.world.entities) {
				const v = ent.props[p];
				if (typeof v === "string") values.add(v);
			}
			if (p === "in" || p === "attachedTo") for (const d of ids) values.add(d);
			for (const v of values) unique({ kind: "set", entity: e, prop: p, value: v });
		}
	}

	return { gaps, seen: seen.size };
}

async function cmdProbe(gameId: string): Promise<void> {
	const def = getGame(gameId);
	const { gaps, seen } = probeDef(def);
	const applyMoveGaps = gaps.filter((g) => g.op.startsWith("apply") || g.op.startsWith("move"));
	const setGaps = gaps.filter((g) => g.op.startsWith("set"));
	const byProp = new Map<string, { n: number; examples: string[] }>();
	for (const g of setGaps) {
		const prop = g.op.match(/set \S+ (\S+) /)?.[1] ?? "?";
		const e = byProp.get(prop) ?? { n: 0, examples: [] };
		e.n += 1;
		if (e.examples.length < 3) e.examples.push(g.op);
		byProp.set(prop, e);
	}
	console.log(`=== 法则完整性探测（${def.id}，${seen} 个典型 op）===`);
	console.log(`apply/move 缺口: ${applyMoveGaps.length}`);
	for (const g of applyMoveGaps) console.log(`  [GAP] ${g.op} → ${g.reason}`);
	console.log(`set 缺口（按属性分组）: ${setGaps.length}`);
	for (const [prop, e] of [...byProp.entries()].sort((a, b) => b[1].n - a[1].n)) {
		console.log(`  ${prop.padEnd(12)} ×${e.n}  例: ${e.examples.join(" | ")}`);
	}
	console.log(gaps.length === 0 ? "\n无缺口。法则覆盖完整。" : `\n建议为缺口补充具体法则（世界性理由），否则模型会以幻觉填补。`);
}

async function cmdRun(tokens: string[], gameId: string): Promise<void> {
	const def = getGame(gameId);
	const sim = new Simulation(def, 1);
	console.log("=== 初始世界 ===");
	console.log(sim.serialize());
	for (const token of tokens) {
		console.log(`\n>>> ${token}`);
		if (token === "tick" || token.startsWith("tick ")) {
			const n = Number(token.split(/\s+/)[1] ?? 1);
			const results = sim.tick(n);
			if (results.length === 0) console.log("（时间流逝，什么也没发生）");
			for (const r of results) console.log(`  [tick ${(r.op as { n: number }).n}] ${r.reason}`);
		} else {
			const r = sim.apply(parseOpToken(token));
			console.log(`  ${r.ok ? "✓" : "✗"} ${r.reason}`);
			for (const ch of r.changes) console.log(`     ${ch.entity}.${ch.prop}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`);
		}
	}
	console.log("\n=== 最终世界 ===");
	console.log(sim.serialize());
	console.log("\n=== 变更日志 ===");
	for (const r of sim.log) console.log(`  ${JSON.stringify(r.op)} → ${r.reason}`);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "scenario") {
		await cmdScenario(rest[0] ?? "scenarios/cave.json");
		return;
	}
	if (cmd === "run") {
		const gameIdx = rest.indexOf("--game");
		const gameId = gameIdx >= 0 ? rest[gameIdx + 1] : "cave";
		const tokens = rest.filter((_, i) => i !== gameIdx && i !== gameIdx + 1);
		await cmdRun(tokens, gameId);
		return;
	}
	if (cmd === "probe") {
		const gameIdx = rest.indexOf("--game");
		const gameId = gameIdx >= 0 ? rest[gameIdx + 1] : "cave";
		await cmdProbe(gameId);
		return;
	}
	console.log(`用法:
  sim scenario [<scenario.json>]    运行法则引擎场景验证（默认 scenarios/cave.json）
  sim run <op> [<op>...] [--game <id>]    按顺序执行操作并展示世界与变更
    op: apply <source> <target> | move <entity> <dest> | set <entity> <prop> <value> | tick <n>
  sim probe [--game <id>]           穷举可见实体的 op 组合，报告落到 denyAll 的法则缺口
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
