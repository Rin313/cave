import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Simulation } from "../core/sim2.ts";
import type { Op, PropValue } from "../core/sim2.ts";
import { caveSim2 } from "../games/cave.sim2.ts";

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

function runScenario(scenario: Scenario, def: typeof caveSim2, seed: number): ScenarioReport {
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
	const reports = file.scenarios.map((s) => runScenario(s, caveSim2, file.seed ?? 1));

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

	const reportFile = join("reports", `${basename(scenarioPath, ".json")}.sim2.report.json`);
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

async function cmdRun(tokens: string[]): Promise<void> {
	const sim = new Simulation(caveSim2, 1);
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
		await cmdScenario(rest[0] ?? "scenarios/sim2.cave.json");
		return;
	}
	if (cmd === "run") {
		await cmdRun(rest);
		return;
	}
	console.log(`用法:
  sim2 scenario [<scenario.json>]   运行法则引擎场景验证（默认 scenarios/sim2.cave.json）
  sim2 run <op> [<op>...]           按顺序执行操作并展示世界与变更
    op: apply <source> <target> | move <entity> <dest> | set <entity> <prop> <value> | tick <n>
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
