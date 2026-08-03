import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Simulation, TICK_VERB, propGet } from "../core/sim.ts";
import type { Action, GameDef, PropValue, StepResult, VerbDef } from "../core/sim.ts";
import type { Proof } from "../core/verify.ts";
import { getGame } from "../games/registry.ts";
import { fixConsole, flagBool, flagStr, out, parseArgs, requireFlag, type ParsedArgs } from "./cli.ts";

interface ScenarioAction {
	verb: string;
	params: Record<string, unknown>;
	/** 开放通道（fallback:"proven" 动词）：前置事实（claims）+ 期望后果（desired），世界经开放法则反向解析。 */
	proof?: unknown;
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

function runScenario(scenario: Scenario, def: GameDef): ScenarioReport {
	const sim = new Simulation(def);
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
			const r = sim.apply(asAction(step.action), step.action.proof ? (parseValue(step.action.proof) as unknown as Proof) : undefined);
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

function loadScenarioFile(scenarioPath: string): { file: ScenarioFile; reports: ScenarioReport[]; passed: number; total: number } {
	const file = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile;
	const def = getGame(file.game);
	const reports = file.scenarios.map((s) => runScenario(s, def));
	const passed = reports.reduce((a, r) => a + r.passed, 0);
	const total = reports.reduce((a, r) => a + r.total, 0);
	return { file, reports, passed, total };
}

function printReports(reports: ScenarioReport[]): void {
	for (const sc of reports) {
		console.log(`\n【${sc.name}】`);
		for (const r of sc.steps) {
			console.log(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.index}. ${r.name}`);
			console.log(`    expected: ${r.expected}`);
			console.log(`    actual:   ${r.actual}`);
			if (!r.pass) console.log(`    problems: ${r.detail}`);
		}
	}
}

async function cmdScenario(scenarioPath: string): Promise<void> {
	const { reports, passed, total } = loadScenarioFile(scenarioPath);
	printReports(reports);
	console.log(`\nRESULT: ${passed}/${total} PASS`);
	process.exit(passed === total ? 0 : 1);
}

/** 验证全部场景：自动发现 scenarios/*.json，跳过未注册游戏（归档的游戏场景保留作参考）。
 *  不绑定任何特定游戏/场景文件——新增场景即被纳入，移除游戏只需从注册表摘除。 */
async function cmdVerify(): Promise<void> {
	let files: string[];
	try {
		files = readdirSync("scenarios").filter((f) => f.endsWith(".json")).sort();
	} catch {
		console.log("scenarios/ 目录不存在，无场景可验证。");
		process.exit(0);
	}
	if (files.length === 0) {
		console.log("scenarios/ 下没有场景文件。");
		process.exit(0);
	}
	let allPassed = 0;
	let allTotal = 0;
	let failedFiles = 0;
	let skipped = 0;
	for (const f of files) {
		const path = join("scenarios", f);
		try {
			const { file, reports, passed, total } = loadScenarioFile(path);
			console.log(`\n=== ${path}（game: ${file.game}${file.name ? `，${file.name}` : ""}）===`);
			printReports(reports);
			console.log(`RESULT: ${passed}/${total} PASS`);
			allPassed += passed;
			allTotal += total;
			if (passed !== total) failedFiles++;
		} catch (err) {
			skipped++;
			console.log(`\n=== ${path} === 跳过：${err instanceof Error ? err.message : String(err)}`);
		}
	}
	console.log(`\nVERIFY: ${allPassed}/${allTotal} PASS（跳过 ${skipped} 个文件，失败 ${failedFiles} 个文件）`);
	process.exit(failedFiles > 0 ? 1 : 0);
}

/** 标量参数解析：true/false/null/数字/字符串（实体参数不走这里）。 */
function parseScalar(s: string): PropValue {
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null") return null;
	if (s.trim() !== "" && !Number.isNaN(Number(s))) return Number(s);
	return s;
}

/** 实体参数解析：按 id 或 name 匹配当前世界的实体（不存在的字符串原样返回）。 */
function resolveEntity(v: string, sim: Simulation): string {
	const hit = sim.world.entities.find((e) => e.name === v || e.id === v);
	return hit ? hit.id : v;
}

/** 从游戏声明的动词表解析 CLI 动作：实体参数（entityParams）按 id/name 解析，
 *  其余参数按动词 schema 的属性顺序解析为标量。动词与参数名不再硬编码。 */
function parseActionToken(token: string, sim: Simulation): Action {
	const [verbName, ...rest] = token.split(/\s+/);
	const verb = sim.def.verbs[verbName!];
	if (!verb) {
		throw new Error(`未知动词：${verbName}（可用：${Object.keys(sim.def.verbs).join(" / ")}；tick N 流逝时间；实体参数可用名称或 id）`);
	}
	const props = verb.schema.properties;
	const paramOrder = Object.keys(props);
	if (rest.length > paramOrder.length) {
		throw new Error(`动词「${verbName}」最多接受 ${paramOrder.length} 个参数（${paramOrder.join(" ")}），得到 ${rest.length} 个`);
	}
	const entityParams = verb.entityParams ?? [];
	const params: Record<string, PropValue> = {};
	rest.forEach((raw, i) => {
		const p = paramOrder[i];
		if (p === undefined) return;
		params[p] = entityParams.includes(p) ? resolveEntity(raw, sim) : parseScalar(raw);
	});
	return { verb: verbName!, params };
}

function describeAction(action: Action, def: GameDef): string {
	const parts = Object.entries(action.params)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(" ");
	return `${action.verb} ${parts}`.trim();
}

function probeDef(def: GameDef, maxCombos = 10000): { gaps: { verb: string; op: string; reason: string; law?: string }[]; latent: { verb: string; op: string; ruleGranted: string }[]; seen: number; truncated: boolean } {
	const sim = new Simulation(def);
	const ids = [...sim.visible()].filter((id) => id !== def.playerId);
	/** 动作参数候选域：游戏可经 GameDef.probeScope 裁剪；缺省 = 可见实体 - 玩家 - space 标记的场景实体。 */
	const scope = def.probeScope
		? new Set(def.probeScope(sim.world, def.playerId))
		: new Set(ids.filter((id) => sim.world.entities.find((e) => e.id === id)?.props.space !== true));
	const gaps: { verb: string; op: string; reason: string; law?: string }[] = [];
	/** 规则会在不可持握工具上授予的潜在洞（作者漏声明 instrumentParams）。 */
	const latent: { verb: string; op: string; ruleGranted: string }[] = [];
	const seen = new Set<string>();
	let truncated = false;

	/** 有意义的缺口：声明了 propParams（set 类）的动词，只报告实体确实拥有该属性、非空操作、值类型匹配；
	 *  其余动词（use/move 等无 propParams）一律视为有意义。参数由动词元数据推导，不硬编码参数名。 */
	const isMeaningfulGap = (verb: VerbDef, action: Action): boolean => {
		const propParams = verb.propParams ?? [];
		if (!propParams.length) return true;
		const entityParam = (verb.entityParams ?? []).find((p) => p in action.params);
		const propParam = propParams.find((p) => p in action.params);
		if (!entityParam || !propParam) return true;
		const e = sim.world.entities.find((x) => x.id === action.params[entityParam]);
		const prop = String(action.params[propParam] ?? "");
		if (!e || !(prop in e.props)) return false;
		const cur = e.props[prop];
		const valueParam = Object.keys(action.params).find((k) => k !== entityParam && !propParams.includes(k));
		const val = valueParam ? action.params[valueParam] : undefined;
		if (cur === val) return false;
		if (typeof cur === "boolean" && (val !== true && val !== false)) return false;
		if (typeof cur === "string" && (val === true || val === false || val === null)) return false;
		return true;
	};

	const probeAction = (verb: VerbDef, action: Action) => {
		const fresh = new Simulation(def);
		const r = fresh.apply(action);
		if (!r.ok && r.deniedBy === "denyAll" && isMeaningfulGap(verb, action)) {
			gaps.push({ verb: action.verb, op: describeAction(action, def), reason: r.reason, law: r.denial?.law });
		}
		if (!r.ok && r.denial?.law?.startsWith("instrument.")) {
			const rb = fresh.probeGrant(action);
			if (rb.ok) {
				latent.push({ verb: action.verb, op: describeAction(action, def), ruleGranted: rb.reason });
			}
		}
	};

	for (const verbName of Object.keys(def.verbs)) {
		const verb = def.verbs[verbName]!;
		const entityParams = verb.entityParams ?? [];
		const candidates = verb.candidates?.(sim) ?? {};
		const paramLists: Record<string, PropValue[]> = {};

		for (const p of entityParams) paramLists[p] = [...scope];
		for (const [p, vals] of Object.entries(candidates)) {
			paramLists[p] = vals;
		}

		const keys = Object.keys(paramLists);
		if (!keys.length) continue;

		/** 组合预算：按动词均分 maxCombos，超出即截断（报告 truncated），防止大实体量游戏 20^n 级爆炸。 */
		const verbNames = Object.keys(def.verbs);
		const perVerbBudget = verbNames.length ? Math.max(1, Math.ceil(maxCombos / verbNames.length)) : maxCombos;
		let verbChecks = 0;
		const generate = (idx: number, acc: Record<string, PropValue>) => {
			if (verbChecks >= perVerbBudget) {
				truncated = true;
				return;
			}
			if (idx === keys.length) {
				const action = { verb: verbName, params: { ...acc } };
				const key = JSON.stringify(action);
				if (seen.has(key)) return;
				seen.add(key);
				verbChecks++;
				probeAction(verb, action);
				return;
			}
			const p = keys[idx]!;
			for (const v of paramLists[p]!) {
				acc[p] = v;
				generate(idx + 1, acc);
			}
		};
		generate(0, {});
	}

	return { gaps, latent, seen: seen.size, truncated };
}

async function cmdProbe(gameId: string, maxCombos: number): Promise<void> {
	const def = getGame(gameId);
	const { gaps, latent, seen, truncated } = probeDef(def, maxCombos);
	console.log(`=== 法则完整性探测（${def.id}，${seen} 个典型动作${truncated ? "，已按预算截断" : ""}）===`);
	for (const verbName of Object.keys(def.verbs)) {
		const vg = gaps.filter((g) => g.verb === verbName);
		console.log(`「${verbName}」缺口: ${vg.length}`);
		for (const g of vg) console.log(`  [GAP] ${g.op} → ${g.reason}`);
	}
	console.log(`规则未自行检查施动工具（运行时被动词级 instrument 前提拦截）: ${latent.length}`);
	for (const l of latent) console.log(`  [LATENT] ${l.op} → 规则本身会授予「${l.ruleGranted}」`);
	if (latent.length) console.log("  建议：在规则内部自行检查施动工具前提（或保持 instrumentParams 声明），否则一旦 instrument 拦截被绕开规则会开出荒谬授予。");
	if (truncated) console.log("  注：探测被 maxCombos 预算截断，可能遗漏缺口；可用 --max 提高预算，或用 GameDef.probeScope 收窄候选域。");
	console.log(gaps.length === 0 && latent.length === 0 ? "\n无缺口，法则覆盖完整。" : `\n建议为缺口补充具体法则（世界性理由），否则模型会以幻觉填补。`);
	console.log("注：probe 只覆盖已声明 instrumentParams 的动词；若某动词漏声明施动工具前提且规则也未自检，此洞不会出现在报告（如 use 的 source 不可持握仍被授予）。请对 use 类动词逐一确认 instrumentParams 已声明。");
}

async function cmdRun(tokens: string[], gameId: string, opts: { json: boolean; world: boolean }): Promise<void> {
	const def = getGame(gameId);
	const sim = new Simulation(def);
	const steps: { action: string; result: StepResult }[] = [];
	for (const token of tokens) {
		let results: StepResult[];
		let actionDesc: string;
		const verbName = token.split(/\s+/)[0];
		// tick 是引擎保留关键字（时间流逝）；若游戏声明了同名动词则走游戏动词
		if (verbName === TICK_VERB && !sim.def.verbs[TICK_VERB]) {
			const n = Number(token.split(/\s+/)[1] ?? 1);
			actionDesc = `tick ${n}`;
			results = sim.tick(n);
		} else {
			actionDesc = token;
			results = [sim.apply(parseActionToken(token, sim))];
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
  sim scenario <scenario.json>    运行单个法则引擎场景验证（场景文件内声明 game）
  sim verify                     运行 scenarios/ 下全部场景（自动发现，跳过未注册游戏）
  sim run <action> [<action>...] --game <id> [--json] [--world]    按顺序执行动作并展示结果
    action: <动词> <参数>... | tick <n>    动词与参数顺序见游戏的动词表（实体参数可用名称或 id）
  sim probe --game <id> [--max <n>]    穷举可见实体的动作组合，报告落到 denyAll 的法则缺口与 latent 潜在洞（--max 控制组合预算，默认 10000）
`);
		return;
	}
	const positionals = a.positionals;
	if (cmd === "scenario") {
		const path = positionals[0];
		if (!path) throw new Error("scenario 需要场景文件路径（如 scenarios/waste.json）");
		await cmdScenario(path);
		return;
	}
	if (cmd === "verify") {
		await cmdVerify();
		return;
	}
	if (cmd === "run") {
		const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
		await cmdRun(positionals, gameId, { json: flagBool(a, "json"), world: flagBool(a, "world") });
		return;
	}
	if (cmd === "probe") {
		const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
		const max = Number(flagStr(a, "max") ?? 10000);
		await cmdProbe(gameId, Number.isFinite(max) && max > 0 ? max : 10000);
		return;
	}
	throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
