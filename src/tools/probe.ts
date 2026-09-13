import { loadGame } from "../core/games.ts";
import { ProtocolViolation, Simulation, audienceOf, lawOf, refParamsOf, renderDenial } from "../core/sim.ts";
import type { Action, Change, Denial, GameDef, Q, Rule, Value, Verdict, VerbDef } from "../core/sim.ts";
import { flagStr, parseArgs, requireFlag, runMain, type ParsedArgs } from "./cli.ts";

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
	return `${clock ? "clock" : "act"}\u0000${verb}\u0000${rule}`;
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

/** 穷举指称参数 × 所指域（每动作在独立 Simulation 上裁决）；liveness 为法则×动词表态矩阵——永远弃权的法则只有此处可见。 */
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
	const def = await loadGame(gameId, ["."]);
	const { rows, grants, grantRows, total, truncated, liveness, tickLiveness } = probeDef(def, maxCombos);
	console.log(`=== 裁决地图（${gameId}）：所指域穷举 ${total} 个动作${truncated ? "，已达预算截断" : ""} ===`);
	console.log("法则×动词表态矩阵（域＝初始世界×所指域穷举；✓授予 ✗拒绝 ·弃权 —未达）——表态分布只描述初始世界，不构成对游戏设计的评判：");
	for (const [law, c] of liveness) {
		const stated = c.grant + c.deny;
		console.log(`  ${law.padEnd(18)}✓×${c.grant} ✗×${c.deny} ·×${c.abstain} —×${c.unreached}${stated === 0 ? "  （初始世界零表态）" : ""}`);
	}
	if (tickLiveness.size) {
		console.log("常驻规则表态（泵每刻调用；域＝各探针动作推钟的刻，未达列不适用）：");
		for (const [law, c] of tickLiveness) console.log(`  ${law.padEnd(24)}✓×${c.grant} ✗×${c.deny} ·×${c.abstain}${c.grant + c.deny === 0 ? "  （零表态）" : ""}`);
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
	if (cmd === "probe") {
		const gameId = requireFlag(a, "game", "用 --game <id> 指定游戏");
		const max = Number(flagStr(a, "max") ?? 10000);
		await cmdProbe(gameId, Number.isFinite(max) && max > 0 ? max : 10000);
		return;
	}
	throw new Error(`未知命令: ${cmd}`);
}

runMain(main);
