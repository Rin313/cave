import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolViolation, Simulation, fmtChange, refParamsOf, renderDenial, shownDepartedNames, spineLines } from "../core/sim.ts";
import type { Action, Denial, GameDef, Q, Scalar, Step, TickStep, VerbDef, Verdict } from "../core/sim.ts";
import { getGame } from "../games/registry.ts";
import { devWait, withDevWait } from "./dev.ts";
import { walltest } from "./walltest.ts";
import { flagBool, flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

/** 游戏解析：探针走注册表；结构墙夹具（core 契约锁）住工具层，不入探针馆。 */
const gameOf = (id: string): GameDef => (id === walltest.id ? walltest : getGame(id));

// —— 场景运行器（契约锁） ——

interface StepExpect {
	ok?: boolean;
	/** reason 子串匹配。 */
	reason?: string;
	/** 动作步的否决律（Denial.law）：否决来源的结构判据。 */
	law?: string;
	/** 期望前置条件违约（未知动词/schema 不符——场景笔误通道，不混同于世界拒绝）。 */
	protocol?: "action.unknown" | "action.schema";
	/** 期望裁决中抛错（结构墙拦截：越权写在冻结读态上即抛）；值为错误信息子串。 */
	throws?: string;
	/** 期望本步骤的刻步被必要性通道拦截（墙否决或法则失灵代谢），拦截即通过。 */
	tickDenied?: boolean;
	/** spineLines 于本步骤 [动作步, ...刻步] 的精确行集。 */
	lines?: string[];
	/** 步骤后的状态断言：`实体.属性` 点径或 `$world.*` 世界径，deepEq。 */
	state?: Record<string, unknown>;
	/** 步骤后的状态视图断言：digest() 的子串包含/排除——感知通道（internal 重露、边隐藏、extra 纹理）的契约锁。 */
	viewIncludes?: string[];
	viewExcludes?: string[];
}

interface ScenarioStep {
	name: string;
	action?: { verb: string; params: Record<string, unknown> };
	/** 时间流逝 N 刻：脱糖为 dev.wait 动作，与 action 同走唯一执行路径。 */
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

/** 结构等值：对象按键集递归、数组按位（$world 探针的精确键集断言所需）；标量行为同 ===。 */
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

/** 状态径读数：`$world.*` 走世界对象，其余首段为实体 id、余段为属性键；缺席渲染为 null。 */
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

/** 唯一执行路径：tick 步脱糖为 dev.wait；apply 含落钟，抛错即前置条件违约/投影缺陷（世界已由 apply 回滚）。 */
function runStep(sim: Simulation, step: ScenarioStep): { steps: Step[]; error?: unknown } {
	if (step.tick == null && !step.action) return { steps: [], error: new Error("无效步骤：缺 action/tick") };
	try {
		const action: Action = step.tick != null
			? devWait(step.tick)
			: { verb: step.action!.verb, params: step.action!.params as Record<string, Scalar> };
		const res = sim.apply(action);
		return { steps: [res.step, ...res.elapsed] };
	} catch (e) {
		return { steps: [], error: e };
	}
}

/** 断言词汇的唯一语义：ok/reason/law 恒指动作步（tick 步的动作步是 dev.wait 授予，恒真——
 *  刻步现象用 tickDenied/lines 断言）；protocol/throws 断言抛错通道，二者与 ok 断言互斥；
 *  state/lines 对抛错步同样断言（回滚探针：抛错后世界必须是调用前原状，steps 为空）。 */
function assertStep(sim: Simulation, step: ScenarioStep, ex: { steps: Step[]; error?: unknown }): string[] {
	const p: string[] = [];
	const e = step.expect;
	const msg = ex.error instanceof Error ? ex.error.message : ex.error != null ? String(ex.error) : null;
	if (msg !== null) {
		if (e.throws !== undefined) {
			if (!msg.includes(e.throws)) p.push(`throws: 期望包含「${e.throws}」，实际「${msg}」`);
		} else if (e.protocol !== undefined) {
			const law = ex.error instanceof ProtocolViolation ? ex.error.law : null;
			if (law !== e.protocol) p.push(`protocol: expected ${e.protocol}, got ${law ?? msg}`);
		} else {
			p.push(`步骤异常中断: ${msg}`);
		}
	} else if (e.throws !== undefined || e.protocol !== undefined) {
		p.push(e.throws !== undefined ? `throws: 期望抛出包含「${e.throws}」的错误，未抛` : `protocol: 期望协议违约 ${e.protocol}，未抛`);
	} else {
		const a = ex.steps[0];
		if (a?.kind !== "action") return ["（无动作步）"];
		const denied = ex.steps.filter((s): s is Extract<TickStep, { ok: false }> => s.kind === "tick" && !s.ok);
		if (e.ok !== undefined && a.ok !== e.ok) p.push(`ok: expected ${e.ok} got ${a.ok}`);
		if (e.reason !== undefined && !a.reason.includes(e.reason)) p.push(`reason: 期望包含「${e.reason}」，实际「${a.reason}」`);
		if (e.law !== undefined && (a.denial?.law ?? null) !== e.law) p.push(`law: expected ${e.law} got ${a.denial?.law ?? null}`);
		if (e.tickDenied === true && denied.length === 0) p.push("tickDenied: 期望刻步被必要性通道拦截，未发生");
		if (e.tickDenied !== true) for (const t of denied) p.push(`刻步被硬墙拦截: ${t.denial.debug}`);
	}
	if (e.state) {
		const c = checkState(sim, e.state);
		if (c !== "ok") p.push(`state: ${c}`);
	}
	if (e.lines) {
		const got = spineLines(sim, ex.steps);
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

function runScenario(scenario: Scenario, def: GameDef): ScenarioReport {
	const sim = new Simulation(def);
	const reports: StepReport[] = [];
	for (const [i, step] of scenario.steps.entries()) {
		const ex = runStep(sim, step);
		const problems = assertStep(sim, step, ex);
		const a = ex.steps[0];
		const denied = ex.steps.filter((s) => s.kind === "tick" && !s.ok).length;
		reports.push({
			index: i + 1,
			name: step.name,
			pass: problems.length === 0,
			expected: JSON.stringify(step.expect),
			actual: ex.error !== undefined
				? `throw「${ex.error instanceof Error ? ex.error.message : String(ex.error)}」`
				: a?.kind === "action"
					? `ok=${a.ok}${a.denial ? ` law=${a.denial.law}` : ""} reason="${a.reason}"${denied ? ` 拦截刻×${denied}` : ""}`
					: "（无动作步）",
			detail: problems.length ? problems.join(" | ") : "matches",
		});
	}
	return { name: scenario.name, passed: reports.filter((r) => r.pass).length, total: reports.length, steps: reports };
}

function loadScenarioFile(scenarioPath: string): { file: ScenarioFile; reports: ScenarioReport[]; passed: number; total: number } {
	const file = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile;
	// dev.wait 挂 internal 研究动词：tick 步经同一裁决边界落钟
	const def = withDevWait(gameOf(file.game));
	const reports = file.scenarios.map((s) => runScenario(s, def));
	return {
		file,
		reports,
		passed: reports.reduce((a, r) => a + r.passed, 0),
		total: reports.reduce((a, r) => a + r.total, 0),
	};
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

// —— 手动研究（run） ——

function parseScalar(s: string): Scalar {
	if (s === "true") return true;
	if (s === "false") return false;
	if (s.trim() !== "" && !Number.isNaN(Number(s))) return Number(s);
	return s;
}

/** 指称参数解析：按 id 或 name 匹配当前世界的实体（不存在的字符串原样返回）。 */
function resolveEntity(v: string, sim: Simulation): string {
	const hit = sim.world.entities.find((e) => e.name === v || e.id === v);
	return hit ? hit.id : v;
}

/** CLI 动作解析：指称参数按 id/name 解析，自由字符串与其余参数按动词 schema 的属性顺序解析为标量。 */
function parseActionToken(token: string, sim: Simulation): Action {
	const [verbName, ...rest] = token.split(/\s+/);
	const verb = sim.def.verbs[verbName!];
	if (!verb) {
		throw new Error(`未知动词：${verbName}（可用：${Object.keys(sim.def.verbs).join(" / ")}；advance n 研究摇钟；指称参数可用名称或 id）`);
	}
	const paramOrder = Object.keys(verb.schema.properties);
	if (rest.length > paramOrder.length) {
		throw new Error(`动词「${verbName}」最多接受 ${paramOrder.length} 个参数（${paramOrder.join(" ")}），得到 ${rest.length} 个`);
	}
	const refs = new Set(refParamsOf(verb));
	const params: Record<string, Scalar> = {};
	rest.forEach((raw, i) => {
		const p = paramOrder[i];
		if (p === undefined) return;
		params[p] = refs.has(p) ? resolveEntity(raw, sim) : parseScalar(raw);
	});
	return { verb: verbName!, params };
}

type DenialBearer = { ok: boolean; deniedBy?: "rule" | "invariant"; denial?: Denial };

/** bug 判据：deniedBy=invariant 且无世界腔理由（核心级拦截）；authored 墙否决有 reason，不算 bug。 */
function bugOf(s: DenialBearer): string | undefined {
	if (s.ok || s.deniedBy !== "invariant" || !s.denial || s.denial.reason != null) return undefined;
	return s.denial.debug ?? s.denial.law;
}

/** 刻步的可说文本：成功刻 = 事实串联，失败刻 = 拒绝的世界腔。 */
function tickText(def: GameDef, s: TickStep): string {
	return s.ok ? (s.facts?.join(" ") ?? "") : renderDenial(def, s.denial);
}

async function cmdRun(tokens: string[], gameId: string, opts: { world: boolean }): Promise<void> {
	const def = gameOf(gameId);
	const sim = new Simulation(withDevWait(def));
	const steps: Step[] = [];
	for (const token of tokens) {
		const parts = token.split(/\s+/);
		const action = parts[0] === "advance" ? devWait(Number(parts[1] ?? 1)) : parseActionToken(token, sim);
		const res = sim.apply(action);
		const results: Step[] = [res.step, ...res.elapsed];
		steps.push(...results);
		console.log(`\n>>> ${token}`);
		if (!results.length) {
			console.log("（时间流逝，什么也没发生）");
			continue;
		}
		const departed = shownDepartedNames(results);
		for (const r of results) {
			const ticks = r.kind === "action" && r.ticks > 0 ? `（裁决授予 ${r.ticks} 刻）` : "";
			const bug = bugOf(r);
			console.log(`  ${r.ok ? "✓" : "✗"} ${r.kind === "action" ? r.reason : tickText(sim.def, r)}${ticks}${bug ? ` ⚠ ${bug}` : ""}`);
			for (const ch of r.changes) console.log(`     ${fmtChange(sim, ch, departed)}`);
		}
	}
	if (opts.world) {
		console.log("\n=== 状态视图 ===");
		console.log(sim.digest());
	}
	console.log("\n=== 变更日志 ===");
	for (const s of steps) {
		const head = s.kind === "action" ? JSON.stringify(s.action) : `tick@${s.at}`;
		console.log(`  ${head} → ${s.kind === "action" ? s.reason : tickText(sim.def, s)}`);
	}
}

// —— 裁决地图（probe） ——

/** 裁决地图行：拒绝（含法则与理由）或协议违约。授予不逐行记，按动词计数。 */
interface MapRow {
	verb: string;
	op: string;
	law: string;
	reason: string;
	bug?: string;
}

/** 规则判定踪迹：instrumentDef 的包装规则在真实裁决链上逐条记录。 */
interface RuleTrace {
	verb: string;
	rule: string;
	/** undefined＝弃权（返回 null）；true/false＝表态（首表态即判决，后继规则的缺席即未达）。 */
	ok?: boolean | undefined;
}

/** 给 def 组合上记录包装（不改原 def、不复制裁决逻辑）：规则仍在真实裁决链上运行，
 *  踪迹即「谁表态、谁弃权、谁未达」的忠实记录。 */
function instrumentDef(def: GameDef, trace: RuleTrace[]): GameDef {
	const verbs: Record<string, VerbDef> = {};
	for (const [name, v] of Object.entries(def.verbs)) {
		verbs[name] = {
			...v,
			rules: v.rules.map((r) => ({
				id: r.id,
				judge: (q: Q): Verdict | null => {
					const verdict = r.judge(q);
					trace.push({ verb: name, rule: r.id, ok: verdict?.ok });
					return verdict;
				},
			})),
		};
	}
	return { ...def, verbs };
}

function opLabel(action: Action): string {
	const parts = Object.entries(action.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
	return `${action.verb} ${parts}`.trim();
}

/** 裁决地图：对每动词穷举指称参数 × 可见实体（每动作在初始世界的独立 Simulation 上裁决）。
 *  liveness＝法则×动词活性矩阵（法则 id 为行）：授予/拒绝/弃权/未达计数——
 *  永远弃权的法则（死法则，或条件未在初始域成立）只有这里可见，拒绝行清单看不见弃权。 */
function probeDef(def: GameDef, maxCombos = 10000): {
	rows: MapRow[];
	grants: Map<string, number>;
	skipped: { verb: string; params: string[] }[];
	total: number;
	truncated: boolean;
	liveness: Map<string, { grant: number; deny: number; abstain: number; unreached: number }>;
} {
	const sim = new Simulation(def);
	const scope = [...sim.visible()];
	const rows: MapRow[] = [];
	const grants = new Map<string, number>();
	const skipped: { verb: string; params: string[] }[] = [];
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
			const bug = bugOf(step);
			if (step.ok) grants.set(action.verb, (grants.get(action.verb) ?? 0) + 1);
			else rows.push({ verb: action.verb, op, law: step.denial?.law ?? "-", reason: step.reason, ...(bug !== undefined && { bug }) });
			// 授予与拒绝两条路径都要查刻步：拦截即 bug（authored 墙否决有世界腔理由，不算）
			for (const t of elapsed) {
				if (t.ok) continue;
				const b = bugOf(t);
				if (b) rows.push({ verb: action.verb, op, law: t.denial.law, reason: renderDenial(def, t.denial), bug: b });
			}
		} catch (e) {
			if (e instanceof ProtocolViolation) rows.push({ verb: action.verb, op, law: e.law, reason: "协议违约：探测组合越过动词 schema" });
			else rows.push({ verb: action.verb, op, law: "apply.crash", reason: "apply 抛错（原子回滚后重抛——投影钩子或内核缺陷）", bug: e instanceof Error ? e.message : String(e) });
		}
		for (const t of trace) {
			const key = `${t.verb}|${t.rule}`;
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
		// 必填非指称参数（自由字符串）的探测域无法机械穷举：显式跳过而非报违约
		const required = ((verb.schema as unknown as { required?: string[] }).required ?? []).filter((p) => !refs.includes(p));
		if (required.length) {
			skipped.push({ verb: verbName, params: required });
			continue;
		}
		const generate = (idx: number, acc: Record<string, Scalar>): void => {
			if (truncated) return;
			if (idx === refs.length) {
				probeAction({ verb: verbName, params: { ...acc } });
				return;
			}
			for (const v of scope) {
				acc[refs[idx]!] = v;
				generate(idx + 1, acc);
			}
		};
		generate(0, {});
	}
	const liveness = new Map<string, { grant: number; deny: number; abstain: number; unreached: number }>();
	const skippedVerbs = new Set(skipped.map((s) => s.verb));
	for (const [verbName, verb] of Object.entries(def.verbs)) {
		if (skippedVerbs.has(verbName)) continue;
		const n = combos.get(verbName) ?? 0;
		if (n === 0) continue; // 截断未覆盖的动词：矩阵行留空，由截断注记说明
		for (const r of verb.rules) {
			const s = stats.get(`${verbName}|${r.id}`) ?? { grant: 0, deny: 0, abstain: 0 };
			// 行键 = 限定身份 verb.id：法则的同一性随出处路径，裸 id 跨动词不合并
			liveness.set(`${verbName}.${r.id}`, { ...s, unreached: n - s.grant - s.deny - s.abstain });
		}
	}
	return { rows, grants, skipped, total, truncated, liveness };
}

async function cmdProbe(gameId: string, maxCombos: number): Promise<void> {
	const def = gameOf(gameId);
	const { rows, grants, skipped, total, truncated, liveness } = probeDef(def, maxCombos);
	console.log(`=== 裁决地图（${def.id}）：可见域穷举 ${total} 个动作${truncated ? "，已达预算截断" : ""} ===`);
	console.log("法则×动词活性矩阵（域＝初始世界×可见域穷举；✓授予 ✗拒绝 ·弃权 —未达）——零表态的法则是否死法则属作者判读：条件可能随状态演化成立");
	for (const [law, c] of liveness) {
		const stated = c.grant + c.deny;
		console.log(`  ${law.padEnd(18)}✓×${c.grant} ✗×${c.deny} ·×${c.abstain} —×${c.unreached}${stated === 0 ? "  ⚠ 零表态" : ""}`);
	}
	console.log("");
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
	for (const s of skipped) console.log(`「${s.verb}」跳过：必填参数 ${s.params.join("/")} 不是指称参数，探测域无法机械穷举`);
	const bugs = rows.filter((r) => r.bug);
	console.log(`\n执行校验 bug（裁决不可执行/破坏完整性——规则或系统缺陷）: ${bugs.length}`);
	for (const b of bugs) console.log(`  [BUG] ${b.op} → ${b.bug}`);
	if (truncated) console.log("注：已达 --max 预算，地图可能不完整。");
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	const a: ParsedArgs = parseArgs(argv);
	if (!cmd || cmd === "--help" || cmd === "-h") {
		process.stdout.write(`用法:
  sim scenario <scenario.json>    运行单个法则引擎场景验证（场景文件内声明 game）
  sim verify                     运行 scenarios/ 下全部场景（自动发现，跳过未注册游戏）
  sim run <action> [<action>...] --game <id> [--world]    按顺序执行动作并展示结果
    action: <动词> <参数>... | advance <n>    动词与参数顺序见游戏的动词表（指称参数可用名称或 id）
    动作按裁决授予的刻数自动流逝；advance n 为研究摇钟（dev.wait 合成动词，过同一裁决边界）
  sim probe --game <id> [--max <n>]    裁决地图：每动词穷举指称参数 × 可见实体——法则×动词活性矩阵（授予/拒绝/弃权/未达，零表态可见：死法则判读属作者）+ 逐输入拒绝行；核心级不变拒绝单列为 bug（--max 控制预算，默认 10000）
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
