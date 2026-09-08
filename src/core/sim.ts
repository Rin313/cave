import { deepFreeze, roll as rollDice } from "./util.ts";

export type Scalar = string | number | boolean;

export type LedgerValue = Scalar | Scalar[];

export type PropValue = LedgerValue | null;

/** 呈现面自由载荷：不进账本、不进变更线性化。 */
export type ViewValue = string | number | boolean | null | ViewValue[] | { [k: string]: ViewValue };

export interface Entity {
	id: string;
	name: string;
	props: Record<string, LedgerValue>;
}

export interface Rel {
	from: string;
	to: string;
	type: string;
	value: LedgerValue;
}

export interface World {
	time: number;
	entities: Entity[];
	relations: Rel[];
}

export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "relSet"; from: string; to: string; type: string; value: LedgerValue | null }
	| { op: "rename"; entity: string; value: string }
	| { op: "spawn"; entity: Entity }
	| { op: "despawn"; entity: string };

/** 后态完整 diff；despawn.name 是离场名的唯一来源。 */
export type Change =
	| { kind: "prop"; entity: string; prop: string; prev: PropValue; next: PropValue }
	| { kind: "rename"; entity: string; prev: string; next: string }
	| { kind: "rel"; from: string; to: string; type: string; prev: PropValue; next: PropValue }
	| { kind: "spawn"; entity: Entity }
	| { kind: "despawn"; entity: string; name: string };

export interface Action {
	verb: string;
	params: Record<string, Scalar>;
}

export interface Messages {
	/** 所有法则未表态时的兜底回应。 */
	noResponse: string;
	/** 指称参数不可见/不存在的统一文案：幻觉 id 与隐藏实体同一文案。 */
	invisibleEntity?: string;
	/** 规则授予但未提供世界腔理由时的占位文案。 */
	defaultReason: string;
	/** 时间流逝的文案（刻步的段头与近况渲染）。 */
	timePassed: string;
}

/** 规则铸造的世界腔，进结果视图供叙述跟随。 */
export type Fact = string;

export type PropType = "string" | "number" | "boolean" | "id" | "tags" | "any";

export interface PropDef {
	type: PropType;
	/** 变更线性化里的属性名。 */
	label?: string;
	/** 对一切呈现面永不渲染；与感知正交，裁决侧照常读。 */
	internal?: boolean;
}

export interface Denial {
	law: string;
	reason?: string;
	debug?: string;
}

/** 静态形态违约（未知动词 / schema 不符）：正常拒绝点在工具边界，内核收到即调用方违约。 */
export class ProtocolViolation extends Error {
	readonly law: "action.unknown" | "action.schema";
	readonly debug: string;

	constructor(law: "action.unknown" | "action.schema", debug: string) {
		super(`协议违约 ${law}：${debug}`);
		this.law = law;
		this.debug = debug;
	}
}

/** world 为深冻结裁决读态，越权写即抛；一切后果经返回值表达。 */
export interface Q {
	readonly world: World;
	readonly player: string;
	readonly time: number;
	readonly params: Record<string, Scalar>;
	/** 确定性骰子；key 以出处路径限定，重名不共享命运。 */
	roll(key: string, sides: number): number;
}

export type Verdict =
	| { ok: true; deltas: Delta[]; reason?: string; facts?: Fact[]; ticks?: number }
	| { ok: false; denial: Denial };

export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

/** 每 tick 一次；产出只有 deltas/facts，无应答通道。 */
export interface SystemRule {
	id: string;
	run: (q: Q) => { deltas: Delta[]; facts?: Fact[] } | null;
}

export function grant(deltas: Delta[], reason?: string, facts?: Fact[], ticks?: number): Verdict {
	return { ok: true, deltas, ...(reason !== undefined && { reason }), ...(facts !== undefined && { facts }), ...(ticks !== undefined && { ticks }) };
}

export function deny(law: string, o: { reason?: string } = {}): Verdict {
	return { ok: false, denial: { law, ...o } };
}

export const D = {
	set: (entity: string, prop: string, value: PropValue): Delta => ({ op: "set", entity, prop, value }),
	relSet: (from: string, to: string, type: string, value: LedgerValue | null): Delta => ({ op: "relSet", from, to, type, value }),
	rename: (entity: string, value: string): Delta => ({ op: "rename", entity, value }),
	spawn: (entity: Entity): Delta => ({ op: "spawn", entity }),
	despawn: (entity: string): Delta => ({ op: "despawn", entity }),
};

/** 动词参数的声明面：惰性描述符——内核校验、宿主面与规则参数类型皆由构造派生。 */
export interface ParamSpec {
	type: "string" | "number" | "boolean";
	/** 字符串参数的语义：ref＝实体 id（过可见性门），free＝字面。 */
	kind?: "ref" | "free";
	optional?: true;
	description?: string;
}

type ScalarOf<T extends ParamSpec["type"]> = T extends "number" ? number : T extends "boolean" ? boolean : string;

/** 规则参数的编译期类型，由 params 声明推导。 */
export type ParamsOf<P extends Record<string, ParamSpec>> = {
	[K in keyof P as P[K] extends { optional: true } ? never : K]: ScalarOf<P[K]["type"]>;
} & {
	[K in keyof P as P[K] extends { optional: true } ? K : never]?: ScalarOf<P[K]["type"]>;
};

/** 指称参数：值是实体 id，过可见性门。 */
export function ref(description?: string): { type: "string"; kind: "ref"; description?: string } {
	return { type: "string", kind: "ref", ...(description !== undefined && { description }) };
}

/** 自由字符串：值按字面进入裁决。 */
export function free(description?: string): { type: "string"; kind: "free"; description?: string } {
	return { type: "string", kind: "free", ...(description !== undefined && { description }) };
}

export function refParamsOf(verb: VerbDef): string[] {
	return Object.keys(verb.params).filter((k) => verb.params[k]?.kind === "ref");
}

/** 规则参数由 params 声明推导编译期类型。 */
export function defineVerb<P extends Record<string, ParamSpec>>(spec: {
	label: string;
	description: string;
	params: P;
	cost: number;
	internal?: boolean;
	rules: { id: string; judge: (q: Q, p: ParamsOf<P>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		params: spec.params,
		cost: spec.cost,
		...(spec.internal !== undefined && { internal: spec.internal }),
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q, q.params as ParamsOf<P>) })),
	};
}

export interface VerbDef {
	label: string;
	description: string;
	params: Record<string, ParamSpec>;
	cost: number;
	/** 不进映射层，由代码直接 apply——同一裁决边界与审查。 */
	internal?: boolean;
	rules: Rule[];
}

/** 内核形态检查（裁决面全集）：指名违约点并携带参数描述，报错措辞走通道语言单源。 */
function paramProblems(verb: VerbDef, params: Record<string, unknown>): string[] {
	if (params === null || typeof params !== "object" || Array.isArray(params)) return ["params：须为对象"];
	const out: string[] = [];
	const desc = (s: ParamSpec): string => (s.description !== undefined ? `（${s.description}）` : "");
	for (const name of Object.keys(params)) {
		if (!Object.hasOwn(verb.params, name)) out.push(`params.${name}：未知参数（可用：${Object.keys(verb.params).join("、") || "无"}）`);
	}
	for (const [name, s] of Object.entries(verb.params)) {
		const v = (params as Record<string, unknown>)[name];
		if (v === undefined) {
			if (!s.optional) out.push(`params.${name}：缺少必填参数${desc(s)}`);
			continue;
		}
		if (typeof v !== s.type) out.push(`params.${name}：须为 ${s.type}${desc(s)}`);
	}
	return out;
}

export interface GameDef {
	id: string;
	title: string;
	/** 指向普通实体的锚引用，integrity 恒查其在世；Q.player 即其值。 */
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	systems?: SystemRule[];
	props?: Record<string, PropDef>;
	summarize?: (input: { world: World; player: string; steps: Step[] }) => string;
	/** 近况窗口的回合记录数。 */
	recentWindow: number;
	grounding?: (world: World, player: string) => string[];
	/** 同一谓词约束状态视图 relations 与事件投影 rel 行；端点可见过滤叠加其上，缺省恒真。 */
	edgePerception?: (world: World, player: string) => (r: Rel) => boolean;
	/** 槽谓词（实体×注册表键，含缺席槽）；同一谓词约束状态视图 props 块与事件投影 prop 行，缺省恒真。 */
	propPerception?: (world: World, player: string) => (e: Entity, prop: string) => boolean;
	/** 状态视图的派生纹理，入 extra 键（顶层装配字段不可覆写）；无指称声明面。 */
	digestExtra?: (world: World, player: string) => Record<string, ViewValue>;
	invariants?: Invariant[];
	messages: Messages;
	voice?: string;
}

export interface InvariantCtx {
	def: GameDef;
	/** 起点世界的冻结副本；存档恢复时 ≠ def.world。 */
	genesis: World;
	changes: Change[];
	src: string;
}

/** null 通过；违反即整提交回滚并拒绝。收冻结读态，写入即抛。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

function isScalarValue(v: unknown): v is Scalar {
	return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** 类型挡不住 as 通道（存档恢复、场景 JSON、probe），存储形状运行时复核。 */
function isLedgerValue(v: unknown): v is LedgerValue {
	return isScalarValue(v) || (Array.isArray(v) && v.every(isScalarValue));
}

/** 幂等跳过的判据是目标状态已成立；标量数组逐位恒等。 */
function sameLedger(a: PropValue, b: PropValue): boolean {
	if (a === b) return true;
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

export function integrityInvariant(): Invariant {
	const got = (v: PropValue): string => {
		if (v === null) return "null";
		if (typeof v === "number") return Number.isFinite(v) ? "number" : "non-finite number";
		if (Array.isArray(v)) return "array";
		if (typeof v === "object") return "object";
		return typeof v;
	};
	return {
		id: "integrity",
		check: (world, ctx) => {
			if (!Array.isArray(world.entities)) return "integrity: world.entities must be an array";
			if (!Array.isArray(world.relations)) return "integrity: world.relations must be an array";
			for (const k of Object.keys(world)) {
				if (k !== "time" && k !== "entities" && k !== "relations") return `integrity: world.${k} is not part of the ledger shape`;
			}
			const ids = new Set<string>();
			for (const e of world.entities) {
				if (e === null || typeof e !== "object" || Array.isArray(e)) return "integrity: entity must be a record";
				ids.add(e.id);
			}
			if (ids.size !== world.entities.length) return "integrity: duplicate entity ids";
			if (!Number.isInteger(world.time) || world.time < 0) return "integrity: world.time must be a non-negative integer";
			if (!ids.has(ctx.def.playerId)) return `integrity: playerId -> missing entity ${ctx.def.playerId}`;
			const registry = Object.entries(ctx.def.props ?? {});
			const vocabulary = new Set(registry.map(([k]) => k));
			for (const e of world.entities) {
				if (typeof e.id !== "string" || e.id === "") return "integrity: entity id must be non-empty string";
				if (typeof e.name !== "string" || e.name === "") return `integrity: ${e.id}.name must be non-empty string`;
				for (const k of Object.keys(e)) {
					if (k !== "id" && k !== "name" && k !== "props") return `integrity: ${e.id}.${k} is not part of the entity shape`;
				}
				if (e.props === null || typeof e.props !== "object" || Array.isArray(e.props)) return `integrity: ${e.id}.props must be a record`;
				for (const k of Object.keys(e.props)) {
					if (!vocabulary.has(k)) return `integrity: ${e.id}.${k} is not declared in the prop registry`;
				}
				for (const [p, pd] of registry) {
					const v = e.props[p];
					if (v === undefined) continue;
					if (!isLedgerValue(v)) return `integrity: ${e.id}.${p} is not a ledger value (non-null scalar or scalar array; absence is a missing key)`;
					if (pd.type === "any") continue;
					if (pd.type === "id") {
						for (const ref of Array.isArray(v) ? v : [v]) {
							if (typeof ref !== "string") return `integrity: ${e.id}.${p} expects id reference, got ${got(ref)}`;
							if (!ids.has(ref)) return `integrity: ${e.id}.${p} -> missing entity ${ref}`;
						}
						continue;
					}
					if (pd.type === "tags") {
						if (!Array.isArray(v)) return `integrity: ${e.id}.${p} expects tags (string array), got ${got(v)}`;
						for (const t of v) if (typeof t !== "string") return `integrity: ${e.id}.${p} expects string element, got ${got(t)}`;
						continue;
					}
					if (pd.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `integrity: ${e.id}.${p} expects number, got ${got(v)}`;
					if (pd.type === "boolean" && typeof v !== "boolean") return `integrity: ${e.id}.${p} expects boolean, got ${got(v)}`;
					if (pd.type === "string" && typeof v !== "string") return `integrity: ${e.id}.${p} expects string, got ${got(v)}`;
				}
			}
			const edgeIds = new Set<string>();
			for (const r of world.relations ?? []) {
				if (r === null || typeof r !== "object" || Array.isArray(r)) return "integrity: relation must be a record";
				for (const k of Object.keys(r)) {
					if (k !== "from" && k !== "to" && k !== "type" && k !== "value") return `integrity: relation.${k} is not part of the relation shape`;
				}
				if (typeof r.from !== "string" || r.from === "") return "integrity: relation.from must be non-empty string";
				if (typeof r.to !== "string" || r.to === "") return "integrity: relation.to must be non-empty string";
				if (typeof r.type !== "string" || r.type === "") return "integrity: relation.type must be non-empty string";
				if (!ids.has(r.from) || !ids.has(r.to)) return `integrity: relation ${r.type} -> missing endpoint`;
				const eid = tupleKey([r.from, r.to, r.type]);
				if (edgeIds.has(eid)) return `integrity: duplicate relation ${r.from}->${r.to} (${r.type})`;
				edgeIds.add(eid);
				if (r.value === null || !isLedgerValue(r.value)) return `integrity: relation ${r.type} -> value is not a ledger value (stored edges never hold null)`;
			}
			return null;
		},
	};
}

export function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

export function viewCard(def: GameDef, e: Entity, perceiveProp?: (e: Entity, prop: string) => boolean): { id: string; name: string; props: Record<string, LedgerValue> } {
	const internal = internalPropsOf(def);
	return { id: e.id, name: e.name, props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k) && (!perceiveProp || perceiveProp(e, k)))) };
}

export function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
}

/** 提交边界两侧的感知截面；裁决时取定，提交后不可重算。 */
export interface FieldSpan {
	before: string[];
	after: string[];
	edges?: { before: string[]; after: string[] };
	props?: { before: string[]; after: string[] };
}

/** 无碰撞元组编码：成分字符集不受约束。 */
function tupleKey(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

export type Step = ActionStep | TickStep;

export interface ActionStep {
	kind: "action";
	/** 裁决发生时刻的钟值；本授予的刻步为 at+1..at+ticks。 */
	at: number;
	ok: boolean;
	reason: string;
	changes: Change[];
	field: FieldSpan;
	action: Action;
	ticks: number;
	/** rule＝卫语句链或可见性门（含 unanswered 闭合）；invariant＝必要性拦截。 */
	deniedBy?: "rule" | "invariant";
	denial?: Denial;
	facts?: Fact[];
}

export interface Resolution {
	step: ActionStep;
	elapsed: TickStep[];
}

/** 一刻内某个系统的产出；失败刻只来自必要性通道。 */
export type TickStep =
	| { kind: "tick"; at: number; ok: true; changes: Change[]; field: FieldSpan; facts?: Fact[] }
	| { kind: "tick"; at: number; ok: false; changes: []; field: FieldSpan; deniedBy: "invariant"; denial: Denial };

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

export function renderDenial(def: GameDef, denial: Denial): string {
	if (denial.reason != null) return denial.reason;
	return def.messages.noResponse;
}

/** 离场名表：窗口内一切 despawn 记录入表。只可查合法指称；出域引用恒不查。 */
export function shownDepartedNames(steps: readonly { changes: Change[] }[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of steps) for (const c of s.changes) if (c.kind === "despawn") m.set(c.entity, c.name);
	return m;
}

/** 渲染与投影共用的解析点：ref=true 解析为展示名（在世读态或离场名表），解析不出原样回显。 */
function renderValue(sim: Simulation, v: PropValue, ref: boolean, departed?: ReadonlyMap<string, string>): { text: string; ids: string[] } {
	if (!ref) return { text: String(v), ids: [] };
	const items = Array.isArray(v) ? v : [v];
	const texts: string[] = [];
	const ids: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") {
			texts.push(String(item));
			continue;
		}
		ids.push(item);
		texts.push(entity(sim.world, item)?.name ?? departed?.get(item) ?? item);
	}
	return { text: texts.join("、"), ids };
}

/** 注册表 type:"id" 的属性值是引用；关系值与未声明值一律字面。 */
function refProp(sim: Simulation, prop: string): boolean {
	return sim.def.props?.[prop]?.type === "id";
}

export function fmtChange(sim: Simulation, c: Change, departed?: ReadonlyMap<string, string>, sides?: { prev: boolean; next: boolean }): string {
	const val = (v: PropValue, ok: boolean, ref: boolean): string => (ok ? renderValue(sim, v, ref, departed).text : "?");
	if (c.kind === "spawn") return `+ ${c.entity.name}`;
	if (c.kind === "despawn") return `- ${c.name}`;
	if (c.kind === "rename") return `~ ${c.prev} → ${c.next}`;
	if (c.kind === "rel") {
		return `${renderValue(sim, c.from, true, departed).text}.${c.type}.${renderValue(sim, c.to, true, departed).text}: ${val(c.prev, sides?.prev ?? true, false)} → ${val(c.next, sides?.next ?? true, false)}`;
	}
	const e = sim.world.entities.find((x) => x.id === c.entity);
	const name = e?.name ?? departed?.get(c.entity) ?? c.entity;
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	return `${name}.${label}: ${val(c.prev, sides?.prev ?? true, refProp(sim, c.prop))} → ${val(c.next, sides?.next ?? true, refProp(sim, c.prop))}`;
}

export function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	const internal = internalPropsOf(def);
	return changes.filter((c) => !(c.kind === "prop" && internal.has(c.prop)));
}

/** 与渲染消费同一解析：指称集对渲染封闭——凡行铸出的同一性皆指称（prop 行主语在内），未披露侧不数。 */
function referentsOf(sim: Simulation, c: Change, sides?: { prev: boolean; next: boolean }): string[] {
	if (c.kind !== "prop") return c.kind === "rel" ? [c.from, c.to] : c.kind === "spawn" ? [c.entity.id] : [c.entity];
	const ref = refProp(sim, c.prop);
	const out: string[] = [c.entity];
	if (sides?.prev ?? true) out.push(...renderValue(sim, c.prev ?? null, ref).ids);
	if (sides?.next ?? true) out.push(...renderValue(sim, c.next ?? null, ref).ids);
	return out;
}

/** 事件流的规范单行渲染（✓/✗/⏱/×n）；可说性按冻结截面判据，言默不随消费面改变（刻账目闭合）。 */
export function spineLines(sim: Simulation, steps: Step[], opts?: { departed?: ReadonlyMap<string, string> }): string[] {
	const spanOf = (s: Step): Set<string> => new Set([...s.field.before, ...s.field.after]);
	const shownDeparted = opts?.departed ?? shownDepartedNames(steps);
	/** 步内可说变更的渲染：存在性、值侧披露与指称门共一判定。 */
	const speakableOf = (s: Step): ((c: Change) => string | null) => {
		const field = spanOf(s);
		const edgeSides = s.field.edges && { before: new Set(s.field.edges.before), after: new Set(s.field.edges.after) };
		const propSides = s.field.props && { before: new Set(s.field.props.before), after: new Set(s.field.props.after) };
		const sidesOf = (c: Change): { prev: boolean; next: boolean } | null => {
			if (c.kind === "rel" && edgeSides) {
				const k = tupleKey([c.from, c.to, c.type]);
				return { prev: edgeSides.before.has(k), next: edgeSides.after.has(k) };
			}
			if (c.kind === "prop" && propSides) {
				const k = tupleKey([c.entity, c.prop]);
				return { prev: propSides.before.has(k), next: propSides.after.has(k) };
			}
			return null;
		};
		return (c) => {
			const sides = sidesOf(c);
			if (sides && !sides.prev && !sides.next) return null;
			if (!referentsOf(sim, c, sides ?? undefined).every((r) => field.has(r))) return null;
			return fmtChange(sim, c, shownDeparted, sides ?? undefined);
		};
	};
	const msgs = sim.def.messages;
	const lines: string[] = [];
	const said = new Map<number, { changes: string[]; facts: Fact[]; denials: string[] }>();
	let granted = 0;
	const flush = (): void => {
		for (const { changes, facts, denials } of said.values()) {
			if (changes.length || facts.length) lines.push(`⏱ ${[
				changes.length ? `（${changes.join("；")}）` : "",
				facts.length ? `〔${facts.join("；")}〕` : "",
			].join("")}`);
			for (const d of denials) lines.push(`⏱ ✗ ${d}`);
		}
		const silent = granted - said.size;
		if (silent > 0) lines.push(`⏱ ${msgs.timePassed} ×${silent}`);
		said.clear();
	};
	for (const s of steps) {
		if (s.kind === "action") {
			flush();
			granted = s.ticks;
			if (sim.def.verbs[s.action.verb]?.internal) continue;
			const changes = narratableChanges(sim.def, s.changes).map(speakableOf(s)).filter((x): x is string => x !== null);
			const tail = [
				changes.length ? `（${changes.join("；")}）` : "",
				s.facts?.length ? `〔${s.facts.join("；")}〕` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, shownDeparted)}：${s.reason}${tail}`);
		} else {
			const held = said.get(s.at) ?? { changes: [], facts: [], denials: [] };
			if (s.ok) {
				held.changes.push(...narratableChanges(sim.def, s.changes).map(speakableOf(s)).filter((x): x is string => x !== null));
				if (s.facts?.length) held.facts.push(...s.facts);
			} else {
				held.denials.push(renderDenial(sim.def, s.denial));
			}
			if (held.changes.length || held.facts.length || held.denials.length) said.set(s.at, held);
		}
	}
	flush();
	return lines;
}

export function relVal(world: World, from: string, to: string, type: string): LedgerValue | null {
	return world.relations.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 拒绝态 deniedBy/denial 必填；*.crash 无世界腔，noResponse 兜底。 */
type RawResult =
	| ({ ok: true; deltas: Delta[]; src: string } & Omit<ActionStep, "kind" | "at" | "field" | "ok" | "deltas" | "deniedBy" | "denial">)
	| ({ ok: false; deltas: Delta[]; deniedBy: "rule" | "invariant"; denial: Denial } & Omit<ActionStep, "kind" | "at" | "field" | "ok" | "deltas" | "deniedBy" | "denial">);

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 呈现回落的显形出口；消费方取走（splice 清空）后随回合诊断显形。 */
	readonly warnings: string[] = [];
	/** 实际起点读态的冻结副本，首次提交前惰性捕获。 */
	private genesisCache?: World;

	constructor(def: GameDef, world?: World) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(world ?? def.world)) as World;
		const systemIds = new Set<string>();
		for (const s of def.systems ?? []) {
			if (systemIds.has(s.id)) throw new Error(`系统 id 重复：${s.id}`);
			systemIds.add(s.id);
		}
		const invariantIds = new Set<string>();
		for (const inv of def.invariants ?? []) {
			if (invariantIds.has(inv.id)) throw new Error(`不变式 id 重复：${inv.id}`);
			invariantIds.add(inv.id);
		}
		for (const [name, v] of Object.entries(def.verbs)) {
			if (!Number.isInteger(v.cost) || v.cost < 0) throw new Error(`动词 ${name} 的 cost 须为非负整数刻数，得到 ${String(v.cost)}`);
			const ruleIds = new Set<string>();
			for (const r of v.rules) {
				if (ruleIds.has(r.id)) throw new Error(`动词 ${name} 的规则 id 重复：${r.id}`);
				ruleIds.add(r.id);
			}
			for (const [p, s] of Object.entries(v.params)) {
				if (s.type !== "string" && s.type !== "number" && s.type !== "boolean") throw new Error(`动词 ${name} 的参数「${p}」须为标量（string/number/boolean），得到 ${String(s.type)}`);
				if (s.type === "string" && !s.kind) throw new Error(`动词 ${name} 的字符串参数「${p}」须声明 kind：ref（指称）或 free（自由字符串）`);
				if (s.kind !== undefined && s.type !== "string") throw new Error(`动词 ${name} 的参数「${p}」的 kind 标记只对字符串参数有意义`);
			}
		}
		// 初始世界过审查：def 结构错误与损坏存档在此显形
		const broken = this.checkInvariants("def", this.readState(), []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.message}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		return this.visibleIn(this.readState());
	}

	/** 参照域 = grounding ∩ 账本：可见性门与状态视图的共同权威，谎报的 id 静默离场。 */
	private visibleIn(world: World): Set<string> {
		const ids = new Set(world.entities.map((e) => e.id));
		if (!this.def.grounding) return ids;
		return new Set(this.def.grounding(world, this.player).filter((id) => ids.has(id)));
	}

	private edgeField(world: World, vis: Set<string>): string[] | undefined {
		const perceive = this.def.edgePerception?.(world, this.player);
		if (!perceive) return undefined;
		const out: string[] = [];
		for (const r of world.relations) if (vis.has(r.from) && vis.has(r.to) && perceive(r)) out.push(tupleKey([r.from, r.to, r.type]));
		return out;
	}

	/** 枚举注册表键而非在场键：缺席槽可感。 */
	private propField(world: World): string[] | undefined {
		const perceive = this.def.propPerception?.(world, this.player);
		if (!perceive) return undefined;
		const keys = Object.keys(this.def.props ?? {});
		const out: string[] = [];
		for (const e of world.entities) {
			for (const k of keys) if (perceive(e, k)) out.push(tupleKey([e.id, k]));
		}
		return out;
	}

	/** 一切 def 侧钩子与提交回滚共用的冻结读态。 */
	private readState(): World {
		return deepFreeze(this.snapshot());
	}

	private staticForm(action: Action): VerbDef {
		const verb = this.def.verbs[action.verb];
		if (!verb) throw new ProtocolViolation("action.unknown", `verb:${action.verb}`);
		const problems = paramProblems(verb, action.params);
		if (problems.length) throw new ProtocolViolation("action.schema", problems.join("; "));
		return verb;
	}

	/** 整批须在首个裁决前过静态检查，否则已裁决动作失去记录；全集是裁决面，internal 动词经直连 apply 合法进入（act 通道的广告面排除住引擎）。 */
	validateBatch(actions: readonly Action[]): void {
		for (const a of actions) this.staticForm(a);
	}

	private adjudicateRaw(action: Action, curVis: Set<string>, world: World): RawResult {
		const msgs = this.def.messages;
		const verb = this.staticForm(action);
		const cost = verb.cost;
		const invalid = refParamsOf(verb)
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && !curVis.has(id));
		if (invalid.length) {
			// 幻觉 id 与隐藏实体同一文案：门对参照域外零泄漏
			const reason = msgs.invisibleEntity ?? msgs.noResponse;
			return { ok: false, reason, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.invisible", reason, debug: invalid.join(",") }, ticks: cost };
		}
		for (const r of verb.rules) {
			const src = `rule:${action.verb}.${r.id}`;
			const q = this.query(world, action.params, ["rule", action.verb, r.id]);
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "rule.crash", debug: `${src}: ${e instanceof Error ? e.message : String(e)}` }, ticks: cost };
			}
			if (!v) continue;
			if (v.ok) {
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `${src}: ticks 须为非负整数刻数，得到 ${String(v.ticks)}` }, ticks: cost };
				}
				return { ok: true, reason: v.reason ?? msgs.defaultReason, changes: [], deltas: v.deltas, action, ...(v.facts !== undefined && { facts: v.facts }), src, ticks: v.ticks ?? cost };
			}
			return { ok: false, reason: renderDenial(this.def, v.denial), changes: [], deltas: [], action, deniedBy: "rule", denial: v.denial, ticks: cost };
		}
		return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.unanswered" }, ticks: cost };
	}

	/** path 是骰子地址的机器身份，src 是其可读渲染，成对构造。 */
	private query(world: World, params: Record<string, Scalar>, path: string[]): Q {
		return {
			world,
			player: this.player,
			time: world.time,
			params,
			roll: (key, sides) => rollDice(world, tupleKey([...path, key]), sides),
		};
	}

	private genesis(): World {
		return (this.genesisCache ??= this.readState());
	}

	/** 克隆覆写：冻结引用不得留在活账本上。回滚恒回封装单元（提交或 apply）起点，不越过已入账坐标。 */
	private restore(s0: World): void {
		Object.assign(this.world, JSON.parse(JSON.stringify(s0)) as World);
	}

	/** 先执行校验后不变式；审查过程的意外异常同通道兑为审查否决。 */
	private commitChecked(s0: World, deltas: Delta[], src: string): { ok: true; changes: Change[] } | { ok: false; denial: Denial; reason: string } {
		const genesis = this.genesis();
		const msgs = this.def.messages;
		try {
			const out = this.commit(deltas);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, denial: out.refusal, reason: msgs.noResponse };
			}
			const inv = this.checkInvariants(src, genesis, out.changes);
			if (inv) {
				this.restore(s0);
				const denial: Denial = inv.authored
					? { law: `invariant.${inv.id}`, reason: inv.message, debug: inv.message }
					: { law: `invariant.${inv.id}`, debug: inv.message };
				return { ok: false, denial, reason: denial.reason ?? msgs.noResponse };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, denial: { law: "invariant.crash", debug }, reason: msgs.noResponse };
		}
	}

	private checkInvariants(src: string, genesis: World, changes: Change[]): { id: string; message: string; authored: boolean } | null {
		const world = this.readState();
		const frozen = deepFreeze(changes);
		const integrity = integrityInvariant().check(world, { def: this.def, genesis, changes: frozen, src });
		if (integrity) return { id: "integrity", message: integrity, authored: false };
		for (const inv of this.def.invariants ?? []) {
			const msg = inv.check(world, { def: this.def, genesis, changes: frozen, src });
			if (msg) return { id: inv.id, message: msg, authored: true };
		}
		return null;
	}

	/** 历史原子性：异常逃逸 ⇒ 世界恢复调用前原状再抛。attempt 入界即冻结（Q.params 与步记录同一对象），Resolution 出界即冻结（记录是证据而非视图）。 */
	apply(action: Action): Resolution {
		deepFreeze(action);
		const s0 = this.readState();
		try {
			return deepFreeze(this.applyInner(action, s0));
		} catch (e) {
			this.restore(s0);
			throw e;
		}
	}

	private applyInner(action: Action, s0: World): Resolution {
		const at = s0.time;
		const before = this.visibleIn(s0);
		const edgesBefore = this.edgeField(s0, before);
		const propsBefore = this.propField(s0);
		const r = this.adjudicateRaw(action, before, s0);
		let step: Omit<ActionStep, "field">;
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.src);
			if (!cc.ok) {
				step = { kind: "action", at, ok: false, reason: cc.reason, changes: [], action, deniedBy: "invariant", denial: cc.denial, ticks: this.def.verbs[action.verb]!.cost };
			} else {
				step = { kind: "action", at, ok: true, reason: r.reason, changes: cc.changes, action, ...(r.facts !== undefined && { facts: r.facts }), ticks: r.ticks };
			}
		} else {
			step = { kind: "action", at, ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial, ticks: r.ticks };
		}
		// 可见快照在落钟前闭合；无提交则边界未跨越，after 即 before
		let afterVis = before;
		let afterEdges = edgesBefore;
		let afterProps = propsBefore;
		if (step.ok) {
			const w1 = this.readState();
			afterVis = this.visibleIn(w1);
			afterEdges = this.edgeField(w1, afterVis);
			afterProps = this.propField(w1);
		}
		const field: FieldSpan = { before: [...before], after: [...afterVis] };
		if (edgesBefore && afterEdges) field.edges = { before: edgesBefore, after: afterEdges };
		if (propsBefore && afterProps) field.props = { before: propsBefore, after: afterProps };
		const elapsed = step.ticks > 0 ? this.tick(step.ticks) : [];
		return { step: { ...step, field }, elapsed };
	}

	/** 尝试行恒可说而指称不经跨度门：合法性由裁决读态参照域判，出域引用恒原样回显（在世名与离场名都不查）。 */
	describeAction(step: ActionStep, departed?: ReadonlyMap<string, string>): string {
		const action = step.action;
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const legal = new Set(step.field.before);
		const refs = new Set(refParamsOf(verb));
		const parts = Object.keys(verb.params)
			.filter((k) => k in action.params)
			.map((k) => {
				const v = action.params[k]!;
				if (!refs.has(k) || typeof v !== "string") return renderValue(this, v, false, departed).text;
				if (!legal.has(v)) return v;
				return renderValue(this, v, true, departed).text;
			});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	private tick(n = 1): TickStep[] {
		const out: TickStep[] = [];
		for (let i = 0; i < n; i++) {
			this.world.time += 1;
			out.push(...this.runSystems());
		}
		return out;
	}

	private runSystems(): TickStep[] {
		const out: TickStep[] = [];
		for (const sys of this.def.systems ?? []) {
			const src = `system:${sys.id}`;
			const s0 = this.readState();
			const before = this.visibleIn(s0);
			const edgesBefore = this.edgeField(s0, before);
			const propsBefore = this.propField(s0);
			let res: ReturnType<SystemRule["run"]> = null;
			try {
				res = sys.run(this.query(s0, {}, ["system", sys.id]));
			} catch (e) {
				out.push({ kind: "tick", at: this.world.time, ok: false, changes: [], deniedBy: "invariant", denial: { law: "system.crash", debug: `${sys.id}: ${e instanceof Error ? e.message : String(e)}` }, field: { before: [...before], after: [...before] } });
				continue;
			}
			if (!res || (res.deltas.length === 0 && !res.facts?.length)) continue;
			const cc = this.commitChecked(s0, res.deltas, src);
			let afterVis = before;
			let afterEdges = edgesBefore;
			let afterProps = propsBefore;
			if (cc.ok) {
				const w1 = this.readState();
				afterVis = this.visibleIn(w1);
				afterEdges = this.edgeField(w1, afterVis);
				afterProps = this.propField(w1);
			}
			const field: FieldSpan = { before: [...before], after: [...afterVis] };
			if (edgesBefore && afterEdges) field.edges = { before: edgesBefore, after: afterEdges };
			if (propsBefore && afterProps) field.props = { before: propsBefore, after: afterProps };
			const at = this.world.time;
			if (!cc.ok) {
				out.push({ kind: "tick", at, ok: false, changes: [], deniedBy: "invariant", denial: cc.denial, field });
				continue;
			}
			out.push({
				kind: "tick",
				at,
				ok: true,
				changes: cc.changes,
				...(res.facts !== undefined && { facts: res.facts }),
				field,
			});
		}
		return out;
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	/** 实体集与可见性门同源（同一 visibleIn）：模型可指名的必在视图。 */
	digest(): string {
		const w = this.readState();
		const vis = this.visibleIn(w);
		const perceiveEdge = this.def.edgePerception?.(w, this.player);
		const perceiveProp = this.def.propPerception?.(w, this.player);
		const entities = w.entities.filter((e) => vis.has(e.id)).map((e) => viewCard(this.def, e, perceiveProp));
		const relations = w.relations.filter((r) => vis.has(r.from) && vis.has(r.to) && (!perceiveEdge || perceiveEdge(r)));
		const view: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) view.extra = extra;
		return JSON.stringify(view);
	}

	/** 声音钩子崩溃回落缺省：呈现缺陷不得丢弃账目，也不得无痕。 */
	summarize(steps: Step[]): string {
		if (this.def.summarize) {
			try {
				return this.def.summarize({ world: this.readState(), player: this.player, steps: deepFreeze(steps) });
			} catch (e) {
				this.warnings.push(`summarize 崩溃回落缺省：${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const lines = spineLines(this, steps);
		return lines.length ? lines.join("\n") : this.def.messages.noResponse;
	}

	/** 逐条校验而非预检（同一授予内 spawn 后 set 是合法书写）；幂等跳过的唯一判据是目标状态已成立。 */
	private commit(deltas: Delta[]): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		const upsertRel = (from: string, to: string, type: string, value: LedgerValue) => {
			const hit = this.world.relations.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else this.world.relations.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: Denial } => ({ refusal: { law: "invariant.commit", debug: `commit: ${debug}` } });
		const dangling = (from: string, to: string): boolean => !entity(this.world, from) || !entity(this.world, to);
		for (const d of deltas) {
			if (d.op === "spawn") {
				if (entity(this.world, d.entity.id)) return refuse(`spawn "${d.entity.id}": entity already exists`);
				if (!Object.values(d.entity.props).every(isLedgerValue)) return refuse(`spawn "${d.entity.id}": props contain a non-ledger value (non-null scalar or scalar array; absence is a missing key)`);
				this.world.entities.push(JSON.parse(JSON.stringify(d.entity)) as Entity);
				// 记录自含克隆，不与活账本共享引用
				changes.push({ kind: "spawn", entity: JSON.parse(JSON.stringify(d.entity)) as Entity });
				continue;
			}
			if (d.op === "despawn") {
				const i = this.world.entities.findIndex((e) => e.id === d.entity);
				if (i < 0) return refuse(`despawn "${d.entity}": entity missing`);
				const gone = this.world.entities[i]!;
				this.world.entities.splice(i, 1);
				// 逆序遍历 + unshift 保边表序
				const existing = this.world.relations;
				const dissolved: Rel[] = [];
				for (let j = existing.length - 1; j >= 0; j--) {
					const r = existing[j]!;
					if (r.from === d.entity || r.to === d.entity) {
						dissolved.unshift(r);
						existing.splice(j, 1);
					}
				}
				changes.push({ kind: "despawn", entity: d.entity, name: gone.name });
				for (const r of dissolved) changes.push({ kind: "rel", from: r.from, to: r.to, type: r.type, prev: r.value, next: null });
				continue;
			}
			if (d.op === "relSet") {
				if (typeof d.type !== "string" || d.type === "") return refuse(`relSet ${String(d.from)}->${String(d.to)}: relation type must be non-empty string`);
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (sameLedger(prev, d.value)) continue;
				if (dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
				if (d.value !== null && !isLedgerValue(d.value)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): value is not a ledger value`);
				if (d.value === null) {
					// 能走到此处则边必已存在（prev !== null）
					const i = this.world.relations.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) this.world.relations.splice(i, 1);
				} else {
					upsertRel(d.from, d.to, d.type, d.value);
				}
				changes.push({ kind: "rel", from: d.from, to: d.to, type: d.type, prev, next: d.value });
				continue;
			}
			if (d.op === "rename") {
				const e = entity(this.world, d.entity);
				if (!e) return refuse(`rename "${d.entity}": target entity missing`);
				if (typeof d.value !== "string" || d.value === "") return refuse(`rename "${d.entity}": name must be non-empty string`);
				if (e.name === d.value) continue;
				const prev = e.name;
				e.name = d.value;
				changes.push({ kind: "rename", entity: d.entity, prev, next: d.value });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) return refuse(`set "${d.entity}.${d.prop}": target entity missing`);
			if (d.value !== null && !isLedgerValue(d.value)) return refuse(`set "${d.entity}.${d.prop}": value is not a ledger value (non-null scalar or scalar array)`);
			const prev = e.props[d.prop] ?? null;
			if (sameLedger(prev, d.value)) continue;
			if (d.value === null) delete e.props[d.prop];
			else e.props[d.prop] = d.value;
			changes.push({ kind: "prop", entity: d.entity, prop: d.prop, prev, next: d.value });
		}
		return { changes };
	}
}
