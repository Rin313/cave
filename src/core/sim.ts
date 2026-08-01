export type PropValue = string | number | boolean | null;

export interface Entity {
	id: string;
	name: string;
	props: Record<string, PropValue>;
}

export interface World {
	entities: Entity[];
	time: number;
}

export type Op =
	| { kind: "apply"; source: string; target: string }
	| { kind: "move"; entity: string; dest: string }
	| { kind: "set"; entity: string; prop: string; value: PropValue };

export interface Delta {
	entity: string;
	prop: string;
	to: PropValue;
}

export interface Change {
	entity: string;
	prop: string;
	from: PropValue;
	to: PropValue;
}

export interface LawCtx {
	world: World;
	op: Op | null;
	actor: string;
	rng: () => number;
}

export interface LawResult {
	granted: boolean;
	reason?: string;
	denyReason?: string;
	changes?: Delta[];
}

export type OpLaw = (ctx: LawCtx) => LawResult;
export type TickLaw = (ctx: LawCtx) => LawResult;

export interface GameDef {
	id: string;
	title: string;
	playerId: string;
	world: World;
	opLaws: OpLaw[];
	tickLaws?: TickLaw[];
	hint?: string;
	/** set 只允许写入这些属性；未声明即全部拒绝（结构性属性必须走 apply/move）。未设置时退回纯法则裁决。 */
	settableProps?: string[];
	/** 表达层后置校验钩子：返回错误信息或 null。text 中出现的实体/断言不得与 world + changes 矛盾。 */
	validateText?: (input: { text: string; world: World; changes: Change[]; actor: string }) => string | null;
}

export type StepOp = Op | { kind: "tick"; n: number };

export interface StepResult {
	ok: boolean;
	reason: string;
	changes: Change[];
	op: StepOp;
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

export function requireOp<K extends Op["kind"]>(c: LawCtx, kind: K): Extract<Op, { kind: K }> | null {
	return c.op?.kind === kind ? (c.op as Extract<Op, { kind: K }>) : null;
}

export function prop(world: World, id: string, name: string): PropValue {
	return entity(world, id)?.props[name] ?? null;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function accessible(world: World, id: string, actor: string): { ok: boolean; reason: string } {
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

export function visibleIds(world: World, actor: string): Set<string> {
	const vis = new Set<string>([actor]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (accessible(world, e.id, actor).ok) vis.add(e.id);
	}
	return vis;
}

const INTERNAL_PROPS = new Set(["actor", "burnTicks"]);

export function serialize(world: World, actor: string): string {
	const vis = visibleIds(world, actor);
	const items = world.entities
		.filter((e) => vis.has(e.id))
		.map((e) => ({
			id: e.id,
			name: e.name,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !INTERNAL_PROPS.has(k))),
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

	get visibleIds(): Set<string> {
		return visibleIds(this.world, this.actor);
	}

	static fromWorld(def: GameDef, world: World, seed = 1): Simulation {
		const s = new Simulation(def, seed);
		s.world.entities = JSON.parse(JSON.stringify(world.entities)) as Entity[];
		s.world.time = world.time;
		return s;
	}

	apply(op: Op): StepResult {
		if (op.kind === "set" && this.def.settableProps && !this.def.settableProps.includes(op.prop)) {
			const e = entity(this.world, op.entity);
			const reason = `世界不这样运转——${e?.name ?? op.entity}的${op.prop}无法被改变。`;
			const sr: StepResult = { ok: false, reason, changes: [], op };
			this.log.push(sr);
			return sr;
		}
		const ctx: LawCtx = { world: this.world, op, actor: this.actor, rng: this.rand };
		let denial: string | null = null;
		for (const law of this.def.opLaws) {
			const res = law(ctx);
			if (res.granted) {
				const changes = this.commit(res.changes ?? []);
				const sr: StepResult = { ok: true, reason: res.reason ?? "……", changes, op };
				this.log.push(sr);
				return sr;
			}
			if (res.denyReason != null && denial == null) denial = res.denyReason;
		}
		const sr: StepResult = { ok: false, reason: denial ?? "世界没有回应这个操作。", changes: [], op };
		this.log.push(sr);
		return sr;
	}

	tick(n = 1): StepResult[] {
		const out: StepResult[] = [];
		for (let i = 0; i < n; i++) {
			this.world.time += 1;
			for (const law of this.def.tickLaws ?? []) {
				const ctx: LawCtx = { world: this.world, op: null, actor: this.actor, rng: this.rand };
				const res = law(ctx);
				if (res.granted && (res.changes?.length ?? 0) > 0) {
					const changes = this.commit(res.changes ?? []);
					const sr: StepResult = { ok: true, reason: res.reason ?? "……", changes, op: { kind: "tick", n: this.world.time } };
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
		return serialize(this.world, this.actor);
	}

	private commit(deltas: Delta[]): Change[] {
		const changes: Change[] = [];
		for (const d of deltas) {
			const e = entity(this.world, d.entity);
			if (!e) continue;
			const from = e.props[d.prop] ?? null;
			if (from === d.to) continue;
			e.props[d.prop] = d.to;
			changes.push({ entity: d.entity, prop: d.prop, from, to: d.to });
		}
		return changes;
	}
}
