import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolViolation, Simulation, departedNames, fmtChange, propGet } from "../core/sim.ts";
import type { Action, GameDef, PropValue, Step } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { flagBool, flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

interface ScenarioAction {
	verb: string;
	params: Record<string, unknown>;
}

interface StepExpect {
	ok?: boolean;
	reason?: string;
	state?: Record<string, unknown>;
	/** 内核契约断言（结构性墙）：期望本步骤触发前置条件违约（未知动词/schema 不符）*/
	protocol?: "action.unknown" | "action.schema";
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

/** 场景文件是手写 JSON，参数原样入裁决瓶颈：动词/schema 错写触发内核前置条件违约（ProtocolViolation） */
function asAction(a: ScenarioAction): Action {
	return { verb: a.verb, params: a.params as Record<string, PropValue> };
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
		const problems: string[] = [];
		if (step.tick != null) {
			const results = sim.tick(step.tick);
			if (results.length === 0) {
				ok = false;
				reason = "时间流逝，什么也没有发生。";
			} else {
				ok = true;
				reason = results.map((r) => r.reason).join(" ");
				for (const t of results) if (!t.ok) problems.push(`刻步被硬墙拦截: ${t.denial?.debug ?? t.reason}`);
			}
		} else if (step.action) {
			try {
				const res = sim.apply(asAction(step.action));
				ok = res.step.ok;
				reason = res.step.reason;
				for (const t of res.elapsed) if (!t.ok) problems.push(`刻步被硬墙拦截: ${t.denial?.debug ?? t.reason}`);
			} catch (e) {
				// 前置条件违约在裁决之外：场景文件的动词/参数笔误，不得洗白为「世界拒绝」类的合法失败；
				// 显式声明 expect.protocol 的步骤例外——作者在此断言内核契约（结构性墙）
				ok = false;
				reason = e instanceof Error ? e.message : String(e);
				if (step.expect.protocol && e instanceof ProtocolViolation) {
					ok = e.law === step.expect.protocol;
					reason = e.debug;
					if (!ok) problems.push(`协议违约类不符: expected ${step.expect.protocol} got ${e.law}`);
				} else {
					problems.push(`协议违约（场景笔误，非世界拒绝）: ${reason}`);
				}
			}
		} else {
			ok = false;
			reason = "（无效步骤）";
		}

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
			expected: `ok=${step.expect.ok ?? "-"}${step.expect.reason ? ` reason≈${step.expect.reason}` : ""}${step.expect.protocol ? ` protocol=${step.expect.protocol}` : ""}${step.expect.state ? ` state[${Object.entries(step.expect.state).map(([k, v]) => `${k}==${JSON.stringify(v)}`).join(" && ")}]` : ""}`,
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
 *  其余参数按动词 schema 的属性顺序解析为标量；动词与参数名均取自游戏的动词表声明。 */
function parseActionToken(token: string, sim: Simulation): Action {
	const [verbName, ...rest] = token.split(/\s+/);
	const verb = sim.def.verbs[verbName!];
	if (!verb) {
		throw new Error(`未知动词：${verbName}（可用：${Object.keys(sim.def.verbs).join(" / ")}；advance n 显式摇钟；实体参数可用名称或 id）`);
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

/** 裁决地图行：拒绝（含法则与理由）或协议违约。授予不逐行记，按动词计数。 */
interface MapRow {
	verb: string;
	op: string;
	law: string;
	reason: string;
	/** 核心级不变拒绝（deniedBy=invariant 且无世界腔理由）——规则/系统 bug 信号。 */
	bug?: string;
}

/** 裁决地图：对每动词穷举 entityParams × 可见实体（每动作在初始世界的独立 Simulation 上裁决） */
function probeDef(def: GameDef, maxCombos = 10000): { rows: MapRow[]; grants: Map<string, number>; skipped: { verb: string; params: string[] }[]; total: number; truncated: boolean } {
	const sim = new Simulation(def);
	const scope = [...sim.visible()];
	const rows: MapRow[] = [];
	const grants = new Map<string, number>();
	const skipped: { verb: string; params: string[] }[] = [];
	let total = 0;
	let truncated = false;

	const probeAction = (action: Action) => {
		if (total >= maxCombos) {
			truncated = true;
			return;
		}
		total++;
		const fresh = new Simulation(def);
		const op = describeAction(action, def);
		try {
			const { step, elapsed } = fresh.apply(action);
			if (step.ok) {
				grants.set(action.verb, (grants.get(action.verb) ?? 0) + 1);
			} else {
				const bug = step.deniedBy === "invariant" && step.denial && step.denial.reason == null ? (step.denial.debug ?? step.denial.law) : undefined;
				rows.push({ verb: action.verb, op, law: step.denial?.law ?? "-", reason: step.reason, bug });
			}
			// 刻步只会被不变式硬墙拦截：拦截即系统 bug——授予与拒绝两条路径都要查（授予后落钟的 systems 产出同样过墙）
			for (const t of elapsed) {
				if (!t.ok && t.deniedBy === "invariant" && t.denial && t.denial.reason == null) {
					rows.push({ verb: action.verb, op, law: t.denial.law ?? "invariant", reason: t.reason, bug: t.denial.debug ?? t.denial.law });
				}
			}
		} catch (e) {
			if (e instanceof ProtocolViolation) rows.push({ verb: action.verb, op, law: e.law, reason: "协议违约：探测组合越过动词 schema" });
			else throw e;
		}
	};

	for (const verbName of Object.keys(def.verbs)) {
		const verb = def.verbs[verbName]!;
		const entityParams = verb.entityParams ?? [];
		// 必填非实体参数的探测域无法机械穷举（如「地点恒可指名」的 dest）：显式跳过而非报违约
		const required = ((verb.schema as unknown as { required?: string[] }).required ?? []).filter((p) => !entityParams.includes(p));
		if (required.length) {
			skipped.push({ verb: verbName, params: required });
			continue;
		}
		const generate = (idx: number, acc: Record<string, PropValue>) => {
			if (truncated) return;
			if (idx === entityParams.length) {
				probeAction({ verb: verbName, params: { ...acc } });
				return;
			}
			for (const v of scope) {
				acc[entityParams[idx]!] = v;
				generate(idx + 1, acc);
			}
		};
		generate(0, {});
	}
	return { rows, grants, skipped, total, truncated };
}

async function cmdProbe(gameId: string, maxCombos: number): Promise<void> {
	const def = getGame(gameId);
	const { rows, grants, skipped, total, truncated } = probeDef(def, maxCombos);
	console.log(`=== 裁决地图（${def.id}）：可见域穷举 ${total} 个动作${truncated ? "，已达预算截断" : ""} ===`);
	const byVerb = new Map<string, MapRow[]>();
	for (const r of rows) {
		const list = byVerb.get(r.verb);
		if (list) list.push(r);
		else byVerb.set(r.verb, [r]);
	}
	const skippedVerbs = new Set(skipped.map((s) => s.verb));
	for (const verbName of Object.keys(def.verbs)) {
		if (skippedVerbs.has(verbName)) continue;
		const vr = byVerb.get(verbName) ?? [];
		console.log(`「${verbName}」✓ ×${grants.get(verbName) ?? 0}${vr.length ? `  ✗ ×${vr.length}` : ""}`);
		for (const r of vr) console.log(`  ✗ ${r.op} → ${r.law}「${r.reason}」${r.bug ? ` ⚠ ${r.bug}` : ""}`);
	}
	for (const s of skipped) console.log(`「${s.verb}」跳过：必填参数 ${s.params.join("/")} 不在 entityParams，探测域无法机械穷举`);
	const bugs = rows.filter((r) => r.bug);
	console.log(`\n执行校验 bug（裁决不可执行/破坏完整性——规则或系统缺陷）: ${bugs.length}`);
	for (const b of bugs) console.log(`  [BUG] ${b.op} → ${b.bug}`);
	if (truncated) console.log("注：已达 --max 预算，地图可能不完整。");
}

async function cmdRun(tokens: string[], gameId: string, opts: { world: boolean }): Promise<void> {
	const def = getGame(gameId);
	const sim = new Simulation(def);
	const steps: Step[] = [];
	for (const token of tokens) {
		const parts = token.split(/\s+/);
		const head = parts[0]!;
		const isAdvance = head === "advance";
		const n = isAdvance ? Number(parts[1] ?? 1) : 0;
		const actionDesc = isAdvance ? `advance ${n}` : token;
		// apply 即完整裁决边界：动作按授予刻数自动流逝（时间律）；advance n 是协议外的显式摇钟（纯等待）
		let results: Step[];
		if (isAdvance) {
			results = sim.tick(n);
		} else {
			const res = sim.apply(parseActionToken(token, sim));
			results = [res.step, ...res.elapsed];
		}
		steps.push(...results);
		if (results.length === 0) {
			console.log(`\n>>> ${actionDesc}`);
			console.log("（时间流逝，什么也没发生）");
			continue;
		}
		const departed = departedNames(results);
		for (const r of results) {
			console.log(`\n>>> ${actionDesc}`);
			const ticks = r.kind === "action" && r.ticks > 0 ? `（裁决授予 ${r.ticks} 刻）` : "";
			console.log(`  ${r.ok ? "✓" : "✗"} ${r.reason}${ticks}${!r.ok && r.deniedBy === "invariant" && r.denial?.debug && r.denial.reason == null ? ` ⚠ ${r.denial.debug}` : ""}`);
			for (const ch of r.changes) console.log(`     ${fmtChange(sim, ch, departed)}`);
		}
	}

	if (opts.world) {
		console.log("\n=== 状态视图 ===");
		console.log(sim.digest());
	}
	console.log("\n=== 变更日志 ===");
	for (const s of steps) console.log(`  ${s.kind === "action" ? JSON.stringify(s.action) : `tick@${s.at}`} → ${s.reason}`);
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  sim scenario <scenario.json>    运行单个法则引擎场景验证（场景文件内声明 game）
  sim verify                     运行 scenarios/ 下全部场景（自动发现，跳过未注册游戏）
  sim run <action> [<action>...] --game <id> [--world]    按顺序执行动作并展示结果
    action: <动词> <参数>... | advance <n>    动词与参数顺序见游戏的动词表（实体参数可用名称或 id）
    动作按裁决授予的刻数自动流逝（时间律：apply 即完整裁决边界）；advance n 为协议外显式摇钟（纯等待）
  sim probe --game <id> [--max <n>]    裁决地图：每动词穷举 entityParams × 可见实体，按法则分组呈现每输入的落点（授予计数/拒绝行）；核心级不变拒绝单列为 bug（--max 控制预算，默认 10000）
`);
		return;
	}
	const positionals = a.positionals;
	if (cmd === "scenario") {
		const path = positionals[0];
		if (!path) throw new Error("scenario 需要场景文件路径");
		await cmdScenario(path);
		return;
	}
	if (cmd === "verify") {
		await cmdVerify();
		return;
	}
	if (cmd === "run") {
		const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
		await cmdRun(positionals, gameId, { world: flagBool(a, "world") });
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

runMain(main);
