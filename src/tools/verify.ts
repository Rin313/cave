import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Simulation } from "../core/sim.ts";
import type { ActionResult, GameConfig } from "../core/types.ts";
import { loadGame } from "../games/index.ts";

export interface ScenarioStep {
	name: string;
	intent: string;
	entity_ids?: string[];
	expect: {
		ok?: boolean;
		state?: Record<string, unknown>;
	};
}

export interface Scenario {
	game: string;
	name?: string;
	mode?: string;
	steps: ScenarioStep[];
}

export interface StepReport {
	index: number;
	name: string;
	pass: boolean;
	expected: string;
	actual: string;
	detail: string;
}

function stateToChecks(state: Record<string, unknown>): string {
	return Object.entries(state)
		.map(([path, value]) => `${path}==${JSON.stringify(value)}`)
		.join(" && ");
}

function entityAttr(sim: Simulation, id: string, path: string): unknown {
	const [head, ...rest] = path.split(".");
	const e = sim.entity(head);
	if (!e) return undefined;
	if (rest.length === 0 || rest.join(".") === "location") return e.location;
	return e.attrs[rest.join(".")];
}

function checkState(sim: Simulation, checks: Record<string, unknown>): string {
	const failures: string[] = [];
	for (const [path, expected] of Object.entries(checks)) {
		const actual = entityAttr(sim, path.split(".")[0], path);
		if (actual !== expected) {
			failures.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
		}
	}
	return failures.length === 0 ? "ok" : failures.join("; ");
}

function verifyUnit(config: GameConfig, scenario: Scenario): StepReport[] {
	const sim = new Simulation(config);
	const reports: StepReport[] = [];

	for (const [i, step] of scenario.steps.entries()) {
		const result: ActionResult = sim.applyIntent(step.intent, step.entity_ids ?? []);
		const checks = step.expect.state ? checkState(sim, step.expect.state) : "ok";

		let pass = true;
		const problems: string[] = [];
		if (step.expect.ok !== undefined && result.ok !== step.expect.ok) {
			pass = false;
			problems.push(`ok: expected ${step.expect.ok} got ${result.ok}`);
		}
		if (checks !== "ok") {
			pass = false;
			problems.push(`state: ${checks}`);
		}

		reports.push({
			index: i + 1,
			name: step.name,
			pass,
			expected: `ok=${step.expect.ok ?? "-"}${step.expect.state ? ` state[${stateToChecks(step.expect.state)}]` : ""}`,
			actual: `ok=${result.ok} message="${result.message}"`,
			detail: problems.length ? problems.join(" | ") : "matches",
		});
	}
	return reports;
}

async function main() {
	const scenarioPath = process.argv[2];
	if (!scenarioPath) {
		console.error("用法: node src/tools/verify.ts <scenario.json>");
		process.exit(1);
	}
	const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
	const config = await loadGame(scenario.game);

	const started = Date.now();
	const reports = verifyUnit(config, scenario);
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);

	const passed = reports.filter((r) => r.pass).length;
	const total = reports.length;

	const report = {
		scenario: basename(scenarioPath),
		game: scenario.game,
		passed,
		total,
		elapsedSec: elapsed,
		steps: reports,
	};

	const reportFile = join("reports", `${basename(scenarioPath, ".json")}.report.json`);
	mkdirSync(dirname(reportFile), { recursive: true });
	writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

	for (const r of reports) {
		console.log(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.index}. ${r.name}`);
		console.log(`    expected: ${r.expected}`);
		console.log(`    actual:   ${r.actual}`);
		if (!r.pass) console.log(`    problems: ${r.detail}`);
	}
	console.log(`RESULT: ${passed}/${total} PASS (${elapsed}s)`);
	console.log(`REPORT: ${reportFile}`);
	process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
