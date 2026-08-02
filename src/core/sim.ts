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

export interface RuleResult {
	granted: boolean;
	reason?: string;
	denyReason?: string;
	changes?: Delta[];
	/** 法则背书的新事实（表达层的合法新事实词汇，防止模型发明后果）。 */
	facts?: string[];
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
	/** 探测工具的非实体参数候选值；不提供则跳过该参数。 */
	probe?: (sim: Simulation) => Record<string, PropValue[]>;
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
	facts?: string[];
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
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

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
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

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	readonly log: StepResult[] = [];
	private rand: () => number;

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

	static fromWorld(def: GameDef, world: World, seed = 1): Simulation {
		const s = new Simulation(def, seed);
		s.world.entities = JSON.parse(JSON.stringify(world.entities)) as Entity[];
		s.world.time = world.time;
		return s;
	}

	apply(action: Action): StepResult {
		const verb = this.def.verbs[action.verb];
		if (!verb) {
			const sr: StepResult = { ok: false, reason: `世界不认识「${action.verb}」这种操作。`, changes: [], action, deniedBy: "rule" };
			this.log.push(sr);
			return sr;
		}
		const ctx: RuleCtx = { world: this.world, action, actor: this.actor, rng: this.rand };
		let denial: string | null = null;
		for (const rule of verb.rules) {
			const res = rule(ctx);
			if (res.granted) {
				const changes = this.commit(res.changes ?? []);
				const sr: StepResult = { ok: true, reason: res.reason ?? "……", changes, action, facts: res.facts };
				this.log.push(sr);
				return sr;
			}
			if (res.denyReason != null && denial == null) denial = res.denyReason;
		}
		const deniedBy: "rule" | "denyAll" = denial != null ? "rule" : "denyAll";
		const reason = denial ?? (this.def.denyAll ? this.def.denyAll(ctx).denyReason : null) ?? "世界没有回应这个操作。";
		const sr: StepResult = { ok: false, reason, changes: [], action, deniedBy };
		this.log.push(sr);
		return sr;
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
					};
					this.log.push(sr);
					out.push(sr);
				}
			}
		}
		return out;
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
