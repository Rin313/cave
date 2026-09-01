import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Simulation, fmtChange, propGet } from "../core/sim.ts";
import type { Action, GameDef, PropValue, Step } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { probeScope } from "../games/space.ts";
import { coerceValue } from "../core/util.ts";
import { flagBool, flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

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

function asAction(a: ScenarioAction): Action {
	return { verb: a.verb, params: Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, coerceValue(v)])) };
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

/** 探测域 per-game 配置（tools 层的预算/覆盖裁剪面，非引擎语义）：动词参数的枚举域声明。
 *  entityParams 缺省 = probeScope（可见 - 玩家 - 场景），此处声明覆盖缺省；无域参数（标量等）不枚举。
 *  域是「法则具体覆盖面」的声明：域内目标应越过 fallback 得到具体法则回答，域外落 fallback 兜底、不报告缺口。 */
const PROBE_DOMAINS: Record<string, Partial<Record<string, (sim: Simulation) => Record<string, PropValue[]>>>> = {
	village: {
		buy: (sim) => ({ goods: sim.world.entities.filter((e) => e.props.price != null || e.props.priceBase != null).map((e) => e.id) }),
		sell: (sim) => ({ goods: sim.world.entities.filter((e) => e.props.in === sim.player && e.props.resale != null).map((e) => e.id) }),
		draw: (sim) => ({ source: sim.world.entities.filter((e) => e.props.supply === true).map((e) => e.id) }),
		repair: (sim) => ({ structure: sim.world.entities.filter((e) => typeof e.props.phase === "number").map((e) => e.id) }),
	},
	yume: {
		go: (sim) => ({ dest: sim.world.entities.filter((e) => e.props.space === true).map((e) => e.id) }),
		take: (sim) => ({ entity: [...sim.visible()].filter((id) => sim.world.entities.find((e) => e.id === id)?.props.takable === true) }),
	},
};

function probeDef(def: GameDef, maxCombos = 10000): { gaps: { verb: string; op: string; reason: string; law?: string }[]; bugs: { verb: string; op: string; debug: string }[]; seen: number; truncated: boolean } {
	const sim = new Simulation(def);
	/** 实体参数缺省域 = space 构件的探测投影（可见实体 - 玩家 - space 场景）；逐参数覆盖走 PROBE_DOMAINS。 */
	const scope = new Set(probeScope(sim.world, def.playerId, sim.visible()));
	const gaps: { verb: string; op: string; reason: string; law?: string }[] = [];
	/** 核心级不变拒绝（deniedBy=invariant 且无世界腔理由——integrity/commit 执行校验）= 规则/系统 bug 信号；
	 *  游戏不变式的拒绝带 message（世界的必要性拦截，玩法），不在此列。 */
	const bugs: { verb: string; op: string; debug: string }[] = [];
	const seen = new Set<string>();
	let truncated = false;

	const probeAction = (action: Action) => {
		const fresh = new Simulation(def);
		const r = fresh.apply(action);
		if (!r.ok && r.deniedBy === "denyAll") {
			gaps.push({ verb: action.verb, op: describeAction(action, def), reason: r.reason, law: r.denial?.law });
		}
		if (!r.ok && r.deniedBy === "invariant" && r.denial && r.denial.reason == null) {
			bugs.push({ verb: action.verb, op: describeAction(action, def), debug: r.denial.debug ?? r.denial.law });
		}
	};

	/** 组合预算：按动词均分 maxCombos，超出即截断（报告 truncated），防止大实体量游戏 20^n 级爆炸。 */
	const verbNames = Object.keys(def.verbs);
	const perVerbBudget = verbNames.length ? Math.max(1, Math.ceil(maxCombos / verbNames.length)) : maxCombos;

	for (const verbName of verbNames) {
		const verb = def.verbs[verbName]!;
		const entityParams = verb.entityParams ?? [];
		const domains = PROBE_DOMAINS[def.id]?.[verbName]?.(sim) ?? {};
		const paramLists: Record<string, PropValue[]> = {};

		for (const p of entityParams) paramLists[p] = [...scope];
		for (const [p, vals] of Object.entries(domains)) {
			paramLists[p] = vals;
		}

		const keys = Object.keys(paramLists);
		if (!keys.length) continue;

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
				probeAction(action);
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

	return { gaps, bugs, seen: seen.size, truncated };
}

async function cmdProbe(gameId: string, maxCombos: number): Promise<void> {
	const def = getGame(gameId);
	const { gaps, bugs, seen, truncated } = probeDef(def, maxCombos);
	console.log(`=== 法则完整性探测（${def.id}，${seen} 个典型动作${truncated ? "，已按预算截断" : ""}）===`);
	const byVerb = new Map<string, typeof gaps>();
	for (const g of gaps) {
		const list = byVerb.get(g.verb);
		if (list) list.push(g);
		else byVerb.set(g.verb, [g]);
	}
	for (const [verbName, vg] of byVerb) {
		console.log(`「${verbName}」缺口: ${vg.length}`);
		for (const g of vg) console.log(`  [GAP] ${g.op} → ${g.reason}`);
	}
	if (!gaps.length) console.log(`缺口: 0（${Object.keys(def.verbs).length} 个动词全部越过 denyAll 兜底）`);
	console.log(`执行校验 bug（裁决不可执行/破坏完整性——规则或系统缺陷）: ${bugs.length}`);
	for (const b of bugs) console.log(`  [BUG] ${b.op} → ${b.debug}`);
	if (truncated) console.log("  注：探测被 maxCombos 预算截断，可能遗漏缺口；可用 --max 提高预算，或在 PROBE_DOMAINS（tools 层探测域配置）收窄候选域。");
	console.log(gaps.length === 0 && bugs.length === 0 ? "\n无缺口，法则覆盖完整。" : `\n建议为缺口补充具体法则（世界性理由），否则模型会以幻觉填补。`);
}

async function cmdRun(tokens: string[], gameId: string, opts: { world: boolean }): Promise<void> {
	const def = getGame(gameId);
	const sim = new Simulation(def);
	for (const token of tokens) {
		const parts = token.split(/\s+/);
		const head = parts[0]!;
		const isAdvance = head === "advance";
		const n = isAdvance ? Number(parts[1] ?? 1) : 0;
		const actionDesc = isAdvance ? `advance ${n}` : token;
		const results: Step[] = isAdvance ? sim.tick(n) : [sim.apply(parseActionToken(token, sim))];
		if (results.length === 0) {
			console.log(`\n>>> ${actionDesc}`);
			console.log("（时间流逝，什么也没发生）");
			continue;
		}
		for (const r of results) {
			console.log(`\n>>> ${actionDesc}`);
			const ticks = r.kind === "action" && r.ticks > 0 ? `（裁决授予 ${r.ticks} 刻）` : "";
			console.log(`  ${r.ok ? "✓" : "✗"} ${r.reason}${ticks}${!r.ok && r.deniedBy === "invariant" && r.denial?.debug && r.denial.reason == null ? ` ⚠ ${r.denial.debug}` : ""}`);
			for (const ch of r.changes) console.log(`     ${fmtChange(sim, ch)}`);
		}
	}

	if (opts.world) {
		console.log("\n=== 状态视图 ===");
		console.log(sim.digest());
	}
	console.log("\n=== 变更日志 ===");
	for (const s of sim.log) console.log(`  ${s.kind === "action" ? JSON.stringify(s.action) : `tick@${s.at}`} → ${s.reason}`);
}

// ---------- 词汇 lint：游戏源文件的属性键读取对照 props 注册表 ----------

/** 扫描游戏源文件（src/games/<id>.ts）静态可见的属性键：`.props.x` 与 `.props["x"]`。
 *  未注册键照常工作但失去 label/internal 控制且不受类型契约约束——internal 泄漏与 label 回退由此提前暴露。
 *  盲区（动态索引 props[var]、共享构件 space.ts 内的读取）属 review 面；构件契约键由使用方游戏注册。 */
async function cmdLint(gameId: string): Promise<void> {
	const def = getGame(gameId);
	const file = join("src", "games", `${gameId}.ts`);
	let src: string;
	try {
		src = readFileSync(file, "utf8");
	} catch {
		throw new Error(`找不到游戏源文件 ${file}（词汇 lint 按约定扫描 src/games/<id>.ts）`);
	}
	const declared = new Set(Object.keys(def.props ?? {}));
	const unknown = new Map<string, number>();
	for (const m of src.matchAll(/\.props\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'`])([^"'`]+)\2\s*\])/g)) {
		const key = m[1] ?? m[3]!;
		if (!declared.has(key)) unknown.set(key, (unknown.get(key) ?? 0) + 1);
	}
	console.log(`=== 属性词汇 lint（${def.id}）：${declared.size} 个注册键，扫描 ${file} ===`);
	if (!unknown.size) {
		console.log("规则代码读取的全部属性键均已在 props 注册表声明。");
		return;
	}
	for (const [key, n] of [...unknown].sort()) console.log(`  ⚠ 未声明属性「${key}」（${n} 处）`);
	console.log("未声明属性照常工作（视为普通可见属性），但失去 label/internal 控制且不受注册表约束；建议登记进 GameDef.props。");
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
    研究工具不自动流逝时间（时间律：刻数由裁决授予，引擎按动作交织推进）；advance n 显式摇钟
  sim probe --game <id> [--max <n>]    穷举可见实体的动作组合，报告落到 denyAll 的法则缺口与执行校验 bug（--max 控制组合预算，默认 10000）
  sim lint --game <id>    属性词汇 lint：扫描游戏源文件读取的属性键，报告未在 props 注册表声明的键（advisory）
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
	if (cmd === "lint") {
		await cmdLint(requireFlag(a, "game", "用 --game <id> 指定游戏"));
		return;
	}
	throw new Error(`未知命令: ${cmd}`);
}

runMain(main);
