export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue };

export interface Entity {
	id: string;
	name: string;
	kind: string;
	tags: string[];
	props: Record<string, PropValue>;
}

export interface World {
	time: number;
	entities: Entity[];
}

/** 结构化变更原语：法则产出 deltas，模拟层裁定提交。prop 支持点路径（如 relations.guard.trust）。 */
export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "inc"; entity: string; prop: string; by: number }
	| { op: "push"; entity: string; prop: string; value: PropValue }
	| { op: "del"; entity: string; prop: string };

export interface Change {
	entity: string;
	prop: string;
	from: PropValue;
	to: PropValue;
}

/** 动作提案：由游戏声明的动词表（verb）驱动，参数由动词 schema 约束。 */
export interface Action {
	verb: string;
	params: Record<string, PropValue>;
}

export interface RuleCtx {
	world: World;
	action: Action | null;
	actor: string;
	rng: () => number;
}

/** 法则背书的结构化新事实：表达层的合法新事实词汇，防止模型发明后果。 */
export interface Fact {
	/** 世界腔陈述。 */
	text: string;
	/** 陈述涉及的实体 id（声明校验的集合成员依据）。 */
	entities: string[];
}

/** 结构化拒绝：非散文，散文由引擎按法则模板渲染。 */
export interface Denial {
	/** 法则标识，如 "pry.soft"（审计与探测依据）。 */
	law: string;
	/** 施动实体 id。 */
	subject?: string;
	/** 受动实体 id。 */
	object?: string;
	/** 涉及属性（denyAll 等按属性兜底的模板用）。 */
	prop?: string;
	/** 可选世界腔覆盖文本（如标准库返回的 prose）；缺省用 GameDef.denialTemplates。 */
	reason?: string;
}

export interface RuleResult {
	granted: boolean;
	/** 授予时的世界腔陈述（可选，表达层可自由发挥；缺省由引擎生成）。 */
	reason?: string;
	changes?: Delta[];
	/** 法则背书的结构化新事实（表达层的合法新事实词汇，防止模型发明后果）。 */
	facts?: Fact[];
	/** 因果涉及集：本法则涉及的全部实体（含未变更的因果源，如引燃木箱的火把）。声明校验依据。 */
	involved?: string[];
	/** 结构化拒绝（granted=false 时给出）。 */
	denial?: Denial;
}

export type Rule = (ctx: RuleCtx) => RuleResult;

/** 时间系统：每 tick 按注册顺序运行，产出 deltas。 */
export type SystemDef = { id: string; run: Rule };

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: unknown;
	/** 声明哪些参数是实体 id（供可见性校验与探测）。 */
	entityParams?: string[];
	/** 非实体参数的候选值；动作空间接地与法则探测共用。不提供则跳过该参数。 */
	candidates?: (sim: Simulation) => Record<string, PropValue[]>;
	rules: Rule[];
}

export interface GameDef {
	id: string;
	title: string;
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	systems?: SystemDef[];
	/** 兜底法则：某动词所有法则未表态且无具体理由时调用。 */
	denyAll?: Rule;
	/** 结构化拒绝的世界腔渲染：按法则 id 提供模板。缺省返回通用兜底。 */
	denialTemplates?: Record<string, (d: Denial, world: World) => string>;
	hint?: string;
	/** 属性展示名：拒绝/变更文本中属性名的世界化说法。 */
	propLabels?: Record<string, string>;
	/** 内部属性：不进 LLM 序列化、不进变更列表、不进表达校验。 */
	internalProps?: string[];
	/** 表达层后置校验钩子。 */
	validateText?: (input: { text: string; world: World; changes: Change[]; actor: string }) => string | null;
	/** 确定性回退摘要钩子。 */
	summarize?: (input: { world: World; changes: Change[]; actor: string }) => string;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见。 */
	grounding?: (world: World, actor: string) => string[];
}

export interface StepResult {
	ok: boolean;
	reason: string;
	changes: Change[];
	action: Action;
	/** 否决来源：具体法则给了世界性理由（rule），还是所有法则都未表态落到兜底（denyAll）。 */
	deniedBy?: "rule" | "denyAll";
	/** 结构化拒绝（deniedBy=rule 时给出），供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

/** 把结构化拒绝渲染为世界腔文本：优先 denial.reason 覆盖，其次按法则模板，缺省兜底。 */
export function renderDenial(def: GameDef, denial: Denial, world: World): string {
	if (denial.reason != null) return denial.reason;
	const tmpl = def.denialTemplates?.[denial.law];
	if (tmpl) return tmpl(denial, world);
	return "世界没有回应这个操作。";
}

function splitPath(path: string): string[] {
	return path.split(".");
}

export function propGet(e: Entity, path: string): PropValue {
	let cur: PropValue = e.props;
	for (const p of splitPath(path)) {
		if (cur === null || typeof cur !== "object") return null;
		if (Array.isArray(cur)) cur = cur[Number(p)] ?? null;
		else cur = (cur as Record<string, PropValue>)[p] ?? null;
	}
	return cur;
}

export function propSet(e: Entity, path: string, value: PropValue): void {
	const parts = splitPath(path);
	const last = parts.pop()!;
	let cur: Record<string, PropValue> | PropValue[] = e.props;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		const idx = Number(p);
		const next = parts[i + 1];
		const nextIsNum = next !== undefined && !Number.isNaN(Number(next));
		const target: PropValue | undefined = Array.isArray(cur) ? cur[idx] : (cur as Record<string, PropValue>)[p];
		if (target === null || target === undefined || typeof target !== "object") {
			const fresh: PropValue = nextIsNum ? [] : {};
			if (Array.isArray(cur)) cur[idx] = fresh;
			else (cur as Record<string, PropValue>)[p] = fresh;
			cur = fresh as never;
		} else {
			cur = target as never;
		}
	}
	if (Array.isArray(cur)) cur[Number(last)] = value;
	else (cur as Record<string, PropValue>)[last] = value;
}

export function prop(world: World, id: string, path: string): PropValue {
	const e = entity(world, id);
	return e ? propGet(e, path) : null;
}

/** delta 构造器命名空间：法则用 D.set/inc/push/del 表达结构化变更。 */
export const D = {
	set: (entity: string, prop: string, value: PropValue): Delta => ({ op: "set", entity, prop, value }),
	inc: (entity: string, prop: string, by: number): Delta => ({ op: "inc", entity, prop, by }),
	push: (entity: string, prop: string, value: PropValue): Delta => ({ op: "push", entity, prop, value }),
	del: (entity: string, prop: string): Delta => ({ op: "del", entity, prop }),
};

/** 可快照/恢复的确定性随机数。快照后可克隆同一随机序列（dryTick 的「即将发生」预言用）。 */
export interface Rng {
	(): number;
	snapshot: () => number;
}

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	const f = (() => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}) as Rng;
	f.snapshot = () => a;
	return f;
}

export function restoreRng(snapshot: number): Rng {
	return mulberry32(snapshot);
}

/** 标准库可达性：容器包含树语义（space / openable / open / in）。游戏可选接入。 */
export function inTreeReach(world: World, actor: string, id: string): { ok: boolean; reason: string } {
	const e = entity(world, id);
	if (!e) return { ok: false, reason: "这里没有这个东西。" };
	let cur = e.props["in"] as string | null;
	const seen = new Set<string>();
	while (cur != null && cur !== actor) {
		if (seen.has(cur)) return { ok: false, reason: "位置存在循环引用。" };
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return { ok: false, reason: "它不在这里。" };
		if (parent.props.space === true) {
			return parent.id === (entity(world, actor)?.props["in"] as string)
				? { ok: true, reason: "" }
				: { ok: false, reason: "它不在这里。" };
		}
		if (parent.props.openable === true && parent.props.open !== true) {
			return { ok: false, reason: `${parent.name}是关着的。` };
		}
		cur = parent.props["in"] as string | null;
	}
	return { ok: true, reason: "" };
}

/** 标准库可见性：容器包含树语义下玩家可达的全部实体。 */
export function inTreeVisible(world: World, actor: string): Set<string> {
	const vis = new Set<string>([actor]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (inTreeReach(world, actor, e.id).ok) vis.add(e.id);
	}
	return vis;
}

export function serialize(world: World, visible: Iterable<string>, internalProps: readonly string[] = []): string {
	const vis = new Set(visible);
	const internal = new Set(internalProps);
	const items = world.entities
		.filter((e) => vis.has(e.id))
		.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			tags: e.tags,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
		}));
	return JSON.stringify({ time: world.time, entities: items }, null, 2);
}

/** 裁决结果 + 未提交的 deltas（apply 用）；check 丢弃 deltas 作为只读裁决。 */
interface RawResult extends StepResult {
	deltas: Delta[];
}

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	readonly log: StepResult[] = [];
	private rand: Rng;

	constructor(def: GameDef, seed = 1) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(def.world)) as World;
		this.rand = mulberry32(seed);
	}

	get actor(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		if (this.def.grounding) return new Set(this.def.grounding(this.world, this.actor));
		return new Set(this.world.entities.map((e) => e.id));
	}

	static fromWorld(def: GameDef, world: World, rng?: Rng): Simulation {
		const s = new Simulation(def, 1);
		s.world.entities = JSON.parse(JSON.stringify(world.entities)) as Entity[];
		s.world.time = world.time;
		if (rng) s.rand = rng;
		return s;
	}

	/** 只读裁决（不提交、不入日志、不扰动主随机序列）：动作空间接地与法则探测共用。 */
	check(action: Action): StepResult {
		const r = this.adjudicateRaw(action, () => 0.5);
		return { ok: r.ok, reason: r.reason, changes: [], action, facts: r.facts, involved: r.involved, deniedBy: r.deniedBy, denial: r.denial };
	}

	private adjudicateRaw(action: Action, rng: Rng | (() => number)): RawResult {
		const verb = this.def.verbs[action.verb];
		if (!verb) {
			return { ok: false, reason: `世界不认识「${action.verb}」这种操作。`, changes: [], deltas: [], action, deniedBy: "rule" };
		}
		const ctx: RuleCtx = { world: this.world, action, actor: this.actor, rng };
		let denial: Denial | null = null;
		for (const rule of verb.rules) {
			const res = rule(ctx);
			if (res.granted) {
				return { ok: true, reason: res.reason ?? "……", changes: [], deltas: res.changes ?? [], action, facts: res.facts, involved: res.involved };
			}
			if (res.denial != null && denial == null) denial = res.denial;
		}
		const deniedBy: "rule" | "denyAll" = denial != null ? "rule" : "denyAll";
		const denyAllDenial = !denial && this.def.denyAll ? this.def.denyAll(ctx).denial : null;
		const reason = denial != null
			? renderDenial(this.def, denial, this.world)
			: (denyAllDenial ? renderDenial(this.def, denyAllDenial, this.world) : "世界没有回应这个操作。");
		return { ok: false, reason, changes: [], deltas: [], action, deniedBy, denial: denial ?? denyAllDenial ?? undefined };
	}

	apply(action: Action): StepResult {
		const r = this.adjudicateRaw(action, this.rand);
		const changes = r.ok ? this.commit(r.deltas) : [];
		const sr: StepResult = r.ok
			? { ok: true, reason: r.reason, changes, action, facts: r.facts, involved: r.involved }
			: { ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial };
		this.log.push(sr);
		return sr;
	}

	/** 动作空间接地：枚举 动词 × 可见实体 × 候选值，返回当前世界会授予的动作（世界腔理由，去重）。
	 *  预算按动词均分（每个动词最多 maxChecks/动词数 次 check），避免组合量大的动词饿死后续动词；
	 *  实体参数按「是否持有该动词的候选属性」排序，让可能授予的组合先被枚举，截断只损失低价值组合。 */
	affordances(maxChecks = 400, maxOut = 30): string[] {
		const out: string[] = [];
		let checks = 0;
		const seen = new Set<string>();
		const verbEntries = Object.entries(this.def.verbs);
		const perVerbBudget = verbEntries.length ? Math.ceil(maxChecks / verbEntries.length) : maxChecks;
		for (const [verbName, verb] of verbEntries) {
			const entityParams = verb.entityParams ?? [];
			const candidates = verb.candidates?.(this) ?? {};
			const propDomain = new Set<string>();
			for (const [p, vals] of Object.entries(candidates)) {
				if (p !== "prop") continue;
				for (const v of vals) if (typeof v === "string") propDomain.add(v);
			}
			const rank = (id: string): number => {
				const e = entity(this.world, id);
				if (!e) return 0;
				let n = 0;
				for (const p of propDomain) if (p in e.props) n++;
				return n;
			};
			const visibleIds = [...this.visible()];
			const paramLists: Record<string, PropValue[]> = {};
			for (const p of entityParams) {
				paramLists[p] = propDomain.size
					? visibleIds.slice().sort((a, b) => rank(b) - rank(a))
					: visibleIds;
			}
			for (const [p, vals] of Object.entries(candidates)) paramLists[p] = vals;
			const keys = Object.keys(paramLists);
			if (!keys.length) continue;
			let verbChecks = 0;
			const gen = (idx: number, acc: Record<string, PropValue>) => {
				if (checks >= maxChecks || verbChecks >= perVerbBudget || out.length >= maxOut) return;
				if (idx === keys.length) {
					checks++;
					verbChecks++;
					const r = this.check({ verb: verbName, params: { ...acc } });
					if (r.ok && r.reason !== "……" && !seen.has(r.reason)) {
						seen.add(r.reason);
						out.push(r.reason);
					}
					return;
				}
				const p = keys[idx];
				for (const v of paramLists[p]) gen(idx + 1, { ...acc, [p]: v });
			};
			gen(0, {});
		}
		return out;
	}

	/** 动作的世界腔描述（表达层「本回合尝试」与动作空间兜底描述共用）。 */
	describeAction(action: Action): string {
		const verb = this.def.verbs[action.verb];
		const name = (v: PropValue): string => {
			if (typeof v === "string") {
				const hit = entity(this.world, v);
				if (hit) return hit.name;
			}
			return String(v);
		};
		if (action.verb === "tick") return "时间流逝";
		if (!verb) return `「${action.verb}」`;
		const entityParams = new Set(verb.entityParams ?? []);
		const parts = Object.entries(action.params).map(([k, v]) => {
			if (k === "prop") return this.def.propLabels?.[String(v)] ?? String(v);
			if (entityParams.has(k)) return name(v);
			if (typeof v === "string") return name(v);
			return String(v);
		});
		return parts.length ? `${verb.label} ${parts.join("，")}` : verb.label;
	}

	tick(n = 1): StepResult[] {
		const out: StepResult[] = [];
		for (let i = 0; i < n; i++) {
			this.world.time += 1;
			for (const sys of this.def.systems ?? []) {
				const ctx: RuleCtx = { world: this.world, action: null, actor: this.actor, rng: this.rand };
				const res = sys.run(ctx);
				if (res.granted && (res.changes?.length ?? 0) > 0) {
					const changes = this.commit(res.changes ?? []);
					const sr: StepResult = {
						ok: true,
						reason: res.reason ?? "……",
						changes,
						action: { verb: "tick", params: { n: this.world.time } },
						facts: res.facts,
						involved: res.involved,
					};
					this.log.push(sr);
					out.push(sr);
				}
			}
		}
		return out;
	}

	/** 克隆世界与随机序列，模拟 n 个 tick，返回将要发生的变更（不改变自身状态）。表达层的"即将发生"合法预言来源。 */
	dryTick(n = 1): StepResult[] {
		const clone = Simulation.fromWorld(this.def, this.world, restoreRng(this.rand.snapshot()));
		return clone.tick(n);
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	serialize(): string {
		return serialize(this.world, this.visible(), this.def.internalProps);
	}

	private commit(deltas: Delta[]): Change[] {
		const changes: Change[] = [];
		for (const d of deltas) {
			const e = entity(this.world, d.entity);
			if (!e) continue;
			if (d.op === "set") {
				const from = propGet(e, d.prop);
				if (from === d.value) continue;
				propSet(e, d.prop, d.value);
				changes.push({ entity: d.entity, prop: d.prop, from, to: d.value });
			} else if (d.op === "inc") {
				const from = Number(propGet(e, d.prop) ?? 0);
				if (!Number.isFinite(from)) continue;
				const to = from + d.by;
				propSet(e, d.prop, to);
				changes.push({ entity: d.entity, prop: d.prop, from, to });
			} else if (d.op === "push") {
				const prev = propGet(e, d.prop);
				const arr = Array.isArray(prev) ? [...(prev as PropValue[])] : [];
				arr.push(d.value);
				propSet(e, d.prop, arr);
				changes.push({ entity: d.entity, prop: d.prop, from: prev, to: arr });
			} else if (d.op === "del") {
				const from = propGet(e, d.prop);
				if (from === null) continue;
				propSet(e, d.prop, null);
				changes.push({ entity: d.entity, prop: d.prop, from, to: null });
			}
		}
		return changes;
	}
}
