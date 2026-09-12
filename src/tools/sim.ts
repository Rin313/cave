import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolViolation, Simulation, audienceOf, lawOf, refParamsOf, renderDenial, spineLines } from "../core/sim.ts";
import type { Action, Change, Commit, Denial, GameDef, Q, Rule, Value, VerbDef, Verdict } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { devWait, withDevWait } from "./dev.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

interface StepExpect {
	ok?: boolean;
	reason?: string;
	/** 提交的决策律（授予的 law；否决的 lawOf(Denial.point)）。 */
	law?: string;
	/** 期望前置条件违约（未知动词/schema 不符），不混同于世界拒绝。 */
	protocol?: "action.unknown" | "action.schema";
	/** 期望抛错（错误信息子串）。 */
	throws?: string;
	/** 期望时钟提交被必要性通道拦截。 */
	tickDenied?: boolean;
	/** spineLines 于本步 [尝试提交, ...时钟提交] 的精确行集。 */
	lines?: string[];
	/** 步骤后的状态断言：`实体.属性` 点径或 `$world.*` 世界径，deepEq。 */
	state?: Record<string, unknown>;
	/** 状态视图断言：digest() 的子串包含/排除。 */
	viewIncludes?: string[];
	viewExcludes?: string[];
}

export interface ScenarioStep {
	name: string;
	action?: { verb: string; params: Record<string, unknown> };
	/** 时间流逝 N 刻：脱糖为 dev.wait 动作，与 action 同走唯一执行路径。 */
	tick?: number;
	expect: StepExpect;
}

export interface Scenario {
	name: string;
	steps: ScenarioStep[];
}

interface ScenarioFile {
	game: string;
	name?: string;
	scenarios: Scenario[];
}

export interface StepReport {
	index: number;
	name: string;
	pass: boolean;
	actual: string;
	detail: string;
}

export interface ScenarioReport {
	name: string;
	passed: number;
	total: number;
	steps: StepReport[];
}

function deepEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
	}
	return false;
}

function readPath(sim: Simulation, path: string): unknown {
	if (path.startsWith("$world.")) {
		let actual: unknown = sim.world;
		for (const seg of path.slice("$world.".length).split(".")) {
			actual = actual !== null && typeof actual === "object" ? (actual as Record<string, unknown>)[seg] : undefined;
		}
		return actual ?? null;
	}
	const [id, ...rest] = path.split(".");
	const e = sim.world.entities.find((x) => x.id === id);
	if (!e || rest.length === 0) return null;
	return e.props[rest.join(".")] ?? null;
}

function checkState(sim: Simulation, checks: Record<string, unknown>): string {
	const failures: string[] = [];
	for (const [path, expected] of Object.entries(checks)) {
		const actual = readPath(sim, path);
		if (!deepEq(actual, expected)) failures.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
	}
	return failures.length ? failures.join("; ") : "ok";
}

function runStep(sim: Simulation, step: ScenarioStep): { steps: Commit[]; error?: unknown } {
	if (step.tick == null && !step.action) return { steps: [], error: new Error("无效步骤：缺 action/tick") };
	try {
		const action: Action = step.tick != null
			? devWait(step.tick)
			: { verb: step.action!.verb, params: step.action!.params as Record<string, Value> };
		const res = sim.apply(action);
		return { steps: [res.step, ...res.elapsed] };
	} catch (e) {
		return { steps: [], error: e };
	}
}

/** ok/reason/law 恒指尝试提交（tick 场景步的尝试是 dev.wait 授予，恒真）；protocol/throws 断言抛错通道；state/lines 兼断抛错提交（回滚探针）。 */
function assertStep(sim: Simulation, step: ScenarioStep, ex: { steps: Commit[]; error?: unknown }): string[] {
	const p: string[] = [];
	const e = step.expect;
	const msg = ex.error instanceof Error ? ex.error.message : ex.error != null ? String(ex.error) : null;
	if (msg !== null) {
		if (e.throws !== undefined) {
			if (!msg.includes(e.throws)) p.push(`throws: 期望包含「${e.throws}」，实际「${msg}」`);
		} else if (e.protocol !== undefined) {
			const law = ex.error instanceof ProtocolViolation ? ex.error.code : null;
			if (law !== e.protocol) p.push(`protocol: expected ${e.protocol}, got ${law ?? msg}`);
		} else {
			p.push(`步骤异常中断: ${msg}`);
		}
	} else if (e.throws !== undefined || e.protocol !== undefined) {
		p.push(e.throws !== undefined ? `throws: 期望抛出包含「${e.throws}」的错误，未抛` : `protocol: 期望协议违约 ${e.protocol}，未抛`);
	} else {
		const a = ex.steps[0];
		if (a === undefined || a.origin === "clock") return ["（无尝试提交）"];
		const denied = ex.steps.filter((s): s is Extract<Commit, { ok: false }> => s.origin === "clock" && !s.ok);
		const reply = a.ok ? a.reply : renderDenial(sim.def, a.denial, a.action.verb);
		if (e.ok !== undefined && a.ok !== e.ok) p.push(`ok: expected ${e.ok} got ${a.ok}`);
		if (e.reason !== undefined && !(reply ?? "").includes(e.reason)) p.push(`reason: 期望包含「${e.reason}」，实际「${reply ?? ""}」`);
		if (e.law !== undefined) {
			const got = a.ok ? a.law : lawOf(a.denial.point);
			if (got !== e.law) p.push(`law: expected ${e.law} got ${got}`);
		}
		if (e.tickDenied === true && denied.length === 0) p.push("tickDenied: 期望刻步被必要性通道拦截，未发生");
		if (e.tickDenied !== true) for (const t of denied) if (audienceOf(t.denial.point) === "engine") p.push(`刻步被硬墙拦截: ${t.denial.text ?? ""}`);
	}
	if (e.state) {
		const c = checkState(sim, e.state);
		if (c !== "ok") p.push(`state: ${c}`);
	}
	if (e.lines) {
		const rendered = spineLines(sim, ex.steps, sim.snapshot());
		// tick 步的合成 will 行不属事件流：只投影其推钟的刻
		const got = step.tick != null ? rendered.slice(1) : rendered;
		if (got.length !== e.lines.length || e.lines.some((l, i) => got[i] !== l)) p.push(`lines: 期望 ${JSON.stringify(e.lines)}，实际 ${JSON.stringify(got)}`);
	}
	if (e.viewIncludes?.length || e.viewExcludes?.length) {
		const view = sim.digest();
		const missing = (e.viewIncludes ?? []).filter((s) => !view.includes(s));
		const leaked = (e.viewExcludes ?? []).filter((s) => view.includes(s));
		if (missing.length) p.push(`viewIncludes: 视图中缺席 ${JSON.stringify(missing)}`);
		if (leaked.length) p.push(`viewExcludes: 视图中泄漏 ${JSON.stringify(leaked)}`);
	}
	return p;
}

export function runScenario(scenario: Scenario, def: GameDef): ScenarioReport {
	const sim = new Simulation(def);
	const reports: StepReport[] = [];
	for (const [i, step] of scenario.steps.entries()) {
		const ex = runStep(sim, step);
		const problems = assertStep(sim, step, ex);
		const a = ex.steps[0];
		const denied = ex.steps.filter((s) => s.origin === "clock" && !s.ok).length;
		reports.push({
			index: i + 1,
			name: step.name,
			pass: problems.length === 0,
			actual: ex.error !== undefined
				? `throw「${ex.error instanceof Error ? ex.error.message : String(ex.error)}」`
				: a !== undefined && a.origin !== "clock"
					? `ok=${a.ok}${a.ok ? "" : ` law=${lawOf(a.denial.point)}`} reason="${a.ok ? (a.reply ?? "") : renderDenial(def, a.denial, a.action.verb)}"${denied ? ` 拦截刻×${denied}` : ""}`
					: "（无尝试提交）",
			detail: problems.length ? problems.join(" | ") : "matches",
		});
	}
	return { name: scenario.name, passed: reports.filter((r) => r.pass).length, total: reports.length, steps: reports };
}

function loadScenarioFile(scenarioPath: string): { file: ScenarioFile; reports: ScenarioReport[]; passed: number; total: number } {
	const file = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile;
	const def = withDevWait(getGame(file.game));
	const reports = file.scenarios.map((s) => runScenario(s, def));
	return {
		file,
		reports,
		passed: reports.reduce((a, r) => a + r.passed, 0),
		total: reports.reduce((a, r) => a + r.total, 0),
	};
}

export function printReports(reports: ScenarioReport[]): void {
	for (const sc of reports) {
		console.log(`\n【${sc.name}】`);
		for (const r of sc.steps) {
			console.log(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.index}. ${r.name}`);
			console.log(`    actual:   ${r.actual}`);
			if (!r.pass) console.log(`    problems: ${r.detail}`);
		}
	}
}

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

/** bug 判据：引擎侧违约（必要性通道）。 */
function bugOf(denial: Denial | undefined): string | undefined {
	return !denial || audienceOf(denial.point) !== "engine" ? undefined : denial.text;
}

interface MapRow {
	verb: string;
	op: string;
	law: string;
	reason: string;
	bug?: string;
}

/** 授予行：按决策律×守卫×变更形状分组，机械后果的逐 op 落点——分组上界是规则代码分支而非指称域。 */
interface GrantRow {
	verb: string;
	law: string;
	rule: string;
	shape: string;
	count: number;
	rep: string;
}

interface RuleTrace {
	verb: string;
	rule: string;
	/** undefined＝弃权；true/false＝表态。 */
	ok?: boolean | undefined;
	/** 常驻规则的踪迹与动词同名不同物，分账。 */
	clock: boolean;
}

function traceKey(clock: boolean, verb: string, rule: string): string {
	return `${clock ? "clock" : "will"}\u0000${verb}\u0000${rule}`;
}

/** 包装规则记录踪迹：不改原 def，不复制裁决逻辑。 */
function instrumentDef(def: GameDef, trace: RuleTrace[]): GameDef {
	const wrap = (name: string, clock: boolean) => (rules: Rule[]): Rule[] => rules.map((r) => ({
		id: r.id,
		judge: (q: Q): Verdict | null => {
			const verdict = r.judge(q);
			trace.push({ verb: name, rule: r.id, ok: verdict?.ok, clock });
			return verdict;
		},
	}));
	const verbs: Record<string, VerbDef> = {};
	for (const [name, v] of Object.entries(def.verbs)) verbs[name] = { ...v, rules: wrap(name, false)(v.rules) };
	const ticks = def.ticks?.map((t) => ({ ...t, rules: wrap(t.id, true)(t.rules) }));
	return { ...def, verbs, ...(ticks !== undefined && { ticks }) };
}

function opLabel(action: Action): string {
	const parts = Object.entries(action.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
	return `${action.verb} ${parts}`.trim();
}

/** 授予的变更形状指纹：格＋键（prop 名/rel 型）。 */
function deltaShape(changes: Change[]): string {
	if (!changes.length) return "∅";
	return changes.map((c) => (c.cell === "prop" ? `prop:${c.prop}` : c.cell === "edge" ? `rel:${c.type}` : c.next === null ? "despawn" : "spawn")).sort().join("+");
}

/** 穷举指称参数 × 所指域（每动作在独立 Simulation 上裁决）；liveness 为法则×动词活性矩阵——永远弃权的法则只有此处可见。 */
function probeDef(def: GameDef, maxCombos = 10000): {
	rows: MapRow[];
	grants: Map<string, number>;
	grantRows: GrantRow[];
	total: number;
	truncated: boolean;
	liveness: Map<string, { grant: number; deny: number; abstain: number; unreached: number }>;
	tickLiveness: Map<string, { grant: number; deny: number; abstain: number }>;
} {
	const sim = new Simulation(def);
	const scope = [...sim.fieldView().referable];
	const rows: MapRow[] = [];
	const grantRows = new Map<string, GrantRow>();
	const grants = new Map<string, number>();
	const combos = new Map<string, number>();
	const stats = new Map<string, { grant: number; deny: number; abstain: number }>();
	const trace: RuleTrace[] = [];
	const instrumented = instrumentDef(def, trace);
	let total = 0;
	let truncated = false;

	const probeAction = (action: Action) => {
		if (total >= maxCombos) {
			truncated = true;
			return;
		}
		total++;
		combos.set(action.verb, (combos.get(action.verb) ?? 0) + 1);
		trace.length = 0;
		const op = opLabel(action);
		try {
			const { step, elapsed } = new Simulation(instrumented).apply(action);
			if (step.ok) {
				grants.set(action.verb, (grants.get(action.verb) ?? 0) + 1);
				const { rule, law } = step;
				const shape = deltaShape(step.changes);
				const key = `${action.verb}|${law}|${rule}|${shape}`;
				const row = grantRows.get(key);
				if (row) row.count += 1;
				else grantRows.set(key, { verb: action.verb, law, rule, shape, count: 1, rep: op });
			}
			else {
				const bug = bugOf(step.denial);
				rows.push({ verb: action.verb, op, law: lawOf(step.denial.point), reason: renderDenial(def, step.denial, step.action.verb), ...(bug !== undefined && { bug }) });
			}
			for (const t of elapsed) {
				if (t.ok) continue;
				const b = bugOf(t.denial);
				if (b) rows.push({ verb: action.verb, op, law: lawOf(t.denial.point), reason: renderDenial(def, t.denial, t.action.verb), bug: b });
			}
		} catch (e) {
			if (e instanceof ProtocolViolation) rows.push({ verb: action.verb, op, law: e.code, reason: "协议违约：探测组合越过动词 schema" });
			else rows.push({ verb: action.verb, op, law: "apply.crash", reason: "apply 抛错（原子回滚后重抛——投影钩子或内核缺陷）", bug: e instanceof Error ? e.message : String(e) });
		}
		for (const t of trace) {
			const key = traceKey(t.clock, t.verb, t.rule);
			const s = stats.get(key) ?? { grant: 0, deny: 0, abstain: 0 };
			if (t.ok === true) s.grant++;
			else if (t.ok === false) s.deny++;
			else s.abstain++;
			stats.set(key, s);
		}
	};

	for (const verbName of Object.keys(def.verbs)) {
		const verb = def.verbs[verbName]!;
		const refs = refParamsOf(verb);
		// 尝试空间的有限生成集：指称参数穷举所指域，必填自由参数取载体代表常量——值条件法则之于常量，同状态条件之于初始世界，归作者判读
		const seed: Record<string, Value> = {};
		for (const [p, s] of Object.entries(verb.params)) {
			if (s.optional || refs.includes(p)) continue;
			const base = s.type === "number" ? 1 : s.type === "boolean" ? true : "…";
			seed[p] = s.many === true ? [base] : base;
		}
		// 指称参数的有限生成集：many 取逐元素单例与全域
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
	const liveness = new Map<string, { grant: number; deny: number; abstain: number; unreached: number }>();
	for (const [verbName, verb] of Object.entries(def.verbs)) {
		const n = combos.get(verbName) ?? 0;
		if (n === 0) continue;
		for (const r of verb.rules) {
			const s = stats.get(traceKey(false, verbName, r.id)) ?? { grant: 0, deny: 0, abstain: 0 };
			liveness.set(`${verbName}.${r.id}`, { ...s, unreached: Math.max(0, n - s.grant - s.deny - s.abstain) });
		}
	}
	// 常驻规则不被提案驱动，未达列不适用；域＝各探针动作推钟的刻
	const tickLiveness = new Map<string, { grant: number; deny: number; abstain: number }>();
	for (const t of def.ticks ?? []) {
		for (const r of t.rules) tickLiveness.set(`⏱${t.id}.${r.id}`, stats.get(traceKey(true, t.id, r.id)) ?? { grant: 0, deny: 0, abstain: 0 });
	}
	return { rows, grants, grantRows: [...grantRows.values()], total, truncated, liveness, tickLiveness };
}

async function cmdProbe(gameId: string, maxCombos: number): Promise<void> {
	const def = getGame(gameId);
	const { rows, grants, grantRows, total, truncated, liveness, tickLiveness } = probeDef(def, maxCombos);
	console.log(`=== 裁决地图（${gameId}）：所指域穷举 ${total} 个动作${truncated ? "，已达预算截断" : ""} ===`);
	console.log("法则×动词活性矩阵（域＝初始世界×所指域穷举；✓授予 ✗拒绝 ·弃权 —未达）——零表态的法则是否死法则属作者判读：条件可能随状态演化成立");
	for (const [law, c] of liveness) {
		const stated = c.grant + c.deny;
		console.log(`  ${law.padEnd(18)}✓×${c.grant} ✗×${c.deny} ·×${c.abstain} —×${c.unreached}${stated === 0 ? "  ⚠ 零表态" : ""}`);
	}
	if (tickLiveness.size) {
		console.log("常驻规则活性（泵每刻调用；域＝各探针动作推钟的刻，未达列不适用）——零表态的常驻规则只有此处可见：");
		for (const [law, c] of tickLiveness) console.log(`  ${law.padEnd(24)}✓×${c.grant} ✗×${c.deny} ·×${c.abstain}${c.grant + c.deny === 0 ? "  ⚠ 零表态" : ""}`);
	}
	console.log("");
	console.log("动词段逐 op 落行：✗ 载法则与理由（兜底落点）；✓ 按决策律×守卫×变更形状分组（∅＝零变更授予）、载代表 op。");
	const byVerb = new Map<string, MapRow[]>();
	for (const r of rows) {
		const list = byVerb.get(r.verb);
		if (list) list.push(r);
		else byVerb.set(r.verb, [r]);
	}
	const grantByVerb = new Map<string, GrantRow[]>();
	for (const r of grantRows) {
		const list = grantByVerb.get(r.verb);
		if (list) list.push(r);
		else grantByVerb.set(r.verb, [r]);
	}
	for (const verbName of Object.keys(def.verbs)) {
		const vr = byVerb.get(verbName) ?? [];
		console.log(`「${verbName}」✓ ×${grants.get(verbName) ?? 0}${vr.length ? `  ✗ ×${vr.length}` : ""}`);
		for (const r of grantByVerb.get(verbName) ?? []) console.log(`  ✓ ${r.shape} ×${r.count} ← ${r.law}${r.law === r.rule ? "" : `(${r.rule})`}（代表 ${r.rep}）`);
		for (const r of vr) console.log(`  ✗ ${r.op} → ${r.law}「${r.reason}」${r.bug ? ` ⚠ ${r.bug}` : ""}`);
	}
	const bugs = rows.filter((r) => r.bug);
	console.log(`\n执行校验 bug（裁决不可执行/破坏完整性——规则或系统缺陷）: ${bugs.length}`);
	for (const b of bugs) console.log(`  [BUG] ${b.op} → ${b.bug}`);
	if (truncated) console.log("注：已达 --max 预算，地图可能不完整。");
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd) throw new Error("缺少命令");
	if (cmd === "verify") {
		await cmdVerify();
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
