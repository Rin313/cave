import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { deepFreeze, errorText, roll as rollDice } from "./util.ts";

export type Scalar = string | number | boolean;

/** 存储值：标量或其有限序列；缺席由键不在表达，故无 none。 */
export type Value = Scalar | Scalar[];

/** 槽写载荷：none（null）即删除。 */
export type Payload = Value | null;

export type ViewValue = string | number | boolean | null | ViewValue[] | { [k: string]: ViewValue };

export interface Entity {
	id: string;
	props: Record<string, Value>;
}

export interface Rel {
	from: string;
	to: string;
	type: string;
	value: Value;
}

export interface World {
	time: number;
	entities: Entity[];
	relations: Rel[];
}

/** 账本格：顶点（存在）／槽（属性）／边（关系）——写与记录的共同坐标。 */
export type VertexAddr = { cell: "vertex"; id: string };
export type PropAddr = { cell: "prop"; entity: string; prop: string };
export type EdgeAddr = { cell: "edge"; from: string; to: string; type: string };
export type SlotAddr = PropAddr | EdgeAddr;
export type Addr = VertexAddr | SlotAddr;

/** δ：绝对写，后态自含。顶点格后态是实体或 none（生/灭），槽格后态是值或 none（写/删）。 */
export type Delta = (VertexAddr & { next: Entity | null }) | (SlotAddr & { next: Payload });

/** 𝒞：同一格的前态与后态——δ 是缺前态的写，记录是补全前态的 δ。 */
type Recorded<D> = D extends { next: infer N } ? D & { prev: N } : never;
export type Change = Recorded<Delta>;

export interface Action {
	verb: string;
	params: Record<string, Scalar>;
}

export interface Messages {
	/** 所有法则未表态时的兜底回应。 */
	noResponse: string;
	/** 指称参数不可见/不存在的统一文案 */
	invisibleEntity?: string;
	/** 时间流逝的文案（刻步的段头与近况渲染）。 */
	timePassed: string;
}

/** 规则铸造的世界腔，进结果视图供叙述跟随。 */
export type Fact = string;

export type PropType = "string" | "number" | "boolean" | "id" | "any";

export interface PropDef {
	/** 元素种类；值形状由种类 × 重数张成。 */
	type: PropType;
	/** 重数：缺省 one（标量），true 为有限序列 many(Seq)。 */
	many?: boolean;
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
		super(`Protocol violation ${law}: ${debug}`);
		this.law = law;
		this.debug = debug;
	}
}

/** world 为深冻结裁决读态，越权写即抛；一切后果经返回值表达。P 为参数的编译期形状（defineVerb 从 params 声明派生）。 */
export interface Q<P = Record<string, Scalar>> {
	readonly world: World;
	readonly player: string;
	readonly params: P;
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

export function grant(deltas: Delta[], reason?: string, facts?: Fact[], ticks?: number): Verdict {
	return { ok: true, deltas, ...(reason !== undefined && { reason }), ...(facts !== undefined && { facts }), ...(ticks !== undefined && { ticks }) };
}

export function deny(law: string, o: { reason?: string } = {}): Verdict {
	return { ok: false, denial: { law, ...o } };
}

export const D = {
	set: (entity: string, prop: string, value: Payload): Delta => ({ cell: "prop", entity, prop, next: value }),
	relSet: (from: string, to: string, type: string, value: Payload): Delta => ({ cell: "edge", from, to, type, next: value }),
	spawn: (entity: Entity): Delta => ({ cell: "vertex", id: entity.id, next: entity }),
	despawn: (entity: string): Delta => ({ cell: "vertex", id: entity, next: null }),
};

/** 格的机器身份：参照域、截面与记录共用同一编码。 */
function addrKey(a: Addr): string {
	switch (a.cell) {
		case "vertex": return JSON.stringify(["vertex", a.id]);
		case "prop": return JSON.stringify(["prop", a.entity, a.prop]);
		case "edge": return JSON.stringify(["edge", a.from, a.to, a.type]);
	}
}

/** 𝒞 反推 δ：绝对写、后态自含——重放不需读前值。 */
function deltaOf(c: Change): Delta {
	switch (c.cell) {
		case "vertex": return { cell: "vertex", id: c.id, next: c.next };
		case "prop": return { cell: "prop", entity: c.entity, prop: c.prop, next: c.next };
		case "edge": return { cell: "edge", from: c.from, to: c.to, type: c.type, next: c.next };
	}
}

/** 动词参数的声明面。 */
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
	clock?: boolean;
	rules: { id: string; judge: (q: Q<ParamsOf<P>>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		params: spec.params,
		cost: spec.cost,
		...(spec.internal !== undefined && { internal: spec.internal }),
		...(spec.clock !== undefined && { clock: spec.clock }),
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q as Q<ParamsOf<P>>) })),
	};
}

export interface VerbDef {
	label: string;
	description: string;
	params: Record<string, ParamSpec>;
	cost: number;
	internal?: boolean;
	clock?: boolean;
	rules: Rule[];
}

/** 内核形态检查（裁决面全集） */
function paramProblems(verb: VerbDef, params: Record<string, unknown>): string[] {
	if (params === null || typeof params !== "object" || Array.isArray(params)) return ["params: must be an object"];
	const out: string[] = [];
	const desc = (s: ParamSpec): string => (s.description !== undefined ? ` (${s.description})` : "");
	for (const name of Object.keys(params)) {
		if (!Object.hasOwn(verb.params, name)) out.push(`params.${name}: unknown parameter (available: ${Object.keys(verb.params).join(", ") || "none"})`);
	}
	for (const [name, s] of Object.entries(verb.params)) {
		const v = (params as Record<string, unknown>)[name];
		if (v === undefined) {
			if (!s.optional) out.push(`params.${name}: missing required parameter${desc(s)}`);
			continue;
		}
		if (typeof v !== s.type) out.push(`params.${name}: must be ${s.type}${desc(s)}`);
	}
	return out;
}

/** 近况窗口内一条回合的呈现切片 */
export interface RecentEntry {
	time: number;
	utterance: string;
	moves: string[];
}

export interface PromptKit {
	/** 近况 */
	recent: RecentEntry[];
	/** 状态视图 */
	view?: string;
	utterance?: string;
	/** 事件骨架行 */
	events?: string[];
	/** 渲染指令 */
	instruction?: string;
}

export interface GameDef {
	id: string;
	title: string;
	/** 指向普通实体的锚引用 */
	playerId: string;
	/** 指称呈现的键 */
	designationKey: string;
	verbs: Record<string, VerbDef>;
	world: World;
	props?: Record<string, PropDef>;
	/** 近况窗口的回合记录数。 */
	recentWindow: number;
	grounding?: (world: World, player: string) => string[];
	/** 同一谓词约束状态视图 relations 与事件投影 rel 行；端点可见过滤叠加其上，缺省恒真。 */
	edgePerception?: (world: World, player: string) => (r: Rel) => boolean;
	/** 槽谓词（实体×注册表键，含缺席槽）；同一谓词约束状态视图 props 块与事件投影 prop 行，缺省恒真。 */
	propPerception?: (world: World, player: string) => (e: Entity, prop: string) => boolean;
	/** 状态视图的派生纹理；无指称声明面。 */
	digestExtra?: (world: World, player: string) => Record<string, ViewValue>;
	invariants?: Invariant[];
	messages: Messages;
	prompt: {
		system: string;
		turn?: (kit: PromptKit & { view: string; utterance: string }) => string;
		narrate?: (kit: PromptKit & { view: string; events: string[]; instruction: string }) => string;
		context?: (messages: ContextEvent["messages"], kit: PromptKit) => ContextEvent["messages"];
	};
}

export interface InvariantCtx {
	def: GameDef;
	/** 起点世界的冻结副本 */
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
function isValue(v: unknown): v is Value {
	return isScalarValue(v) || (Array.isArray(v) && v.every(isScalarValue));
}

/** 幂等跳过的判据是目标状态已成立；标量数组逐位恒等。 */
function sameValue(a: Payload, b: Payload): boolean {
	if (a === b) return true;
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameEntity(a: Entity, b: Entity): boolean {
	if (a.id !== b.id) return false;
	const ka = Object.keys(a.props);
	const kb = Object.keys(b.props);
	return ka.length === kb.length && ka.every((k) => sameValue(a.props[k] ?? null, b.props[k] ?? null));
}

const got = (v: Payload): string => {
	if (v === null) return "null";
	if (typeof v === "number") return Number.isFinite(v) ? "number" : "non-finite number";
	if (Array.isArray(v)) return "array";
	if (typeof v === "object") return "object";
	return typeof v;
};

const integrityInvariant: Invariant = {
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
				for (const k of Object.keys(e)) {
					if (k !== "id" && k !== "props") return `integrity: ${e.id}.${k} is not part of the entity shape`;
				}
				if (e.props === null || typeof e.props !== "object" || Array.isArray(e.props)) return `integrity: ${e.id}.props must be a record`;
				for (const k of Object.keys(e.props)) {
					if (!vocabulary.has(k)) return `integrity: ${e.id}.${k} is not declared in the prop registry`;
				}
				for (const [p, pd] of registry) {
					const v = e.props[p];
					if (v === undefined) continue;
					if (!isValue(v)) return `integrity: ${e.id}.${p} is not a value (non-null scalar or scalar array; absence is a missing key)`;
					const many = pd.many === true;
					if (Array.isArray(v) !== many) return `integrity: ${e.id}.${p} expects ${many ? "a sequence" : "a scalar"}, got ${got(v)}`;
					if (p === ctx.def.designationKey && v === "") return `integrity: ${e.id}.${p} must be non-empty string (empty designation is absence; omit the key)`;
					for (const x of Array.isArray(v) ? v : [v]) {
						if (pd.type === "any") continue;
						if (pd.type === "id") {
							if (typeof x !== "string") return `integrity: ${e.id}.${p} expects id reference, got ${got(x)}`;
							if (!ids.has(x)) return `integrity: ${e.id}.${p} -> missing entity ${x}`;
							continue;
						}
						if (typeof x !== pd.type) return `integrity: ${e.id}.${p} expects ${pd.type}, got ${got(x)}`;
					}
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
				const eid = addrKey({ cell: "edge", from: r.from, to: r.to, type: r.type });
				if (edgeIds.has(eid)) return `integrity: duplicate relation ${r.from}->${r.to} (${r.type})`;
				edgeIds.add(eid);
			if (r.value === null || !isValue(r.value)) return `integrity: relation ${r.type} -> value is not a value (stored edges never hold null)`;
		}
		return null;
	},
};

function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

/** designated 槽的值 */
export function designation(def: Pick<GameDef, "designationKey">, e: Entity): string | undefined {
	const v = e.props[def.designationKey];
	return typeof v === "string" && v !== "" ? v : undefined;
}

/** 指称呈现，没有时回落 id。 */
export function designationOf(def: Pick<GameDef, "designationKey">, e: Entity): string {
	return designation(def, e) ?? e.id;
}

export function viewCard(def: GameDef, e: Entity, vis: ReadonlySet<string>, perceiveProp?: (e: Entity, prop: string) => boolean): { id: string; name?: string; props: Record<string, Value> } {
	const internal = internalPropsOf(def);
	const name = perceiveProp && !perceiveProp(e, def.designationKey) ? undefined : designation(def, e);
	const props: Record<string, Value> = {};
	for (const [k, v] of Object.entries(e.props)) {
		if (internal.has(k) || k === def.designationKey) continue;
		if (perceiveProp && !perceiveProp(e, k)) continue;
		if (!refsWithin(def, k, v, vis)) continue;
		props[k] = v;
	}
	return { id: e.id, ...(name !== undefined && { name }), props };
}

function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
}

/** 提交边界两侧的感知截面：参照域（顶点 id）恒在，边/属性截面仅于对应钩子声明时存在；裁决时取定，提交后不可重算。 */
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

/** 步的来源：意志（玩家经广告面提案）、时钟（泵逐刻自鸣）、代码（internal 动词直连）。于构造时由 (泵?, 动词.internal?) 定，随步入账——记录自含分类，投影不复依赖 def。 */
export type Origin = "will" | "clock" | "code";

/** 携提案的源（意志或代码直连）；时钟无提案。 */
type ProposedOrigin = Exclude<Origin, "clock">;

/** 步的来源归属：will/code 携提案（proposal.verb 即动词），clock 无提案故自带 verb。价 = granted ?? cost；时钟步恒 0。声：授予带 reason?/facts?，否决带 denial。src 是发言者地址：rule:<verb>.<rule> 或 gate:<law>。deniedBy: rule＝卫语句链/可见性门/unanswered，invariant＝必要性拦截。 */
export type Commit =
	| { at: number; src: string; origin: ProposedOrigin; proposal: Action; price: number; ok: true; changes: Change[]; field: FieldSpan; reason?: string; facts?: Fact[] }
	| { at: number; src: string; origin: ProposedOrigin; proposal: Action; price: number; ok: false; changes: []; field: FieldSpan; deniedBy: "rule" | "invariant"; denial: Denial }
	| { at: number; src: string; origin: "clock"; verb: string; price: 0; ok: true; changes: Change[]; field: FieldSpan; facts?: Fact[] }
	| { at: number; src: string; origin: "clock"; verb: string; price: 0; ok: false; changes: []; field: FieldSpan; deniedBy: "rule" | "invariant"; denial: Denial };

export type Attempt = Extract<Commit, { proposal: Action }>;

export interface Resolution {
	step: Commit;
	elapsed: Commit[];
}

/** 回合定稿记录（档案主侧条目的载荷）：seq 是全日志单调序位，time 是回合末钟。 */
export interface ChronicleEntry {
	seq: number;
	time: number;
	utterance: string;
	steps: Commit[];
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

export function renderDenial(def: GameDef, denial: Denial): string {
	if (denial.reason != null) return denial.reason;
	return def.messages.noResponse;
}

/** 离场名表：窗口内 despawn 记录的 designated 槽入表。 */
export function shownDepartedNames(def: GameDef, steps: readonly { changes: Change[] }[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of steps)
		for (const c of s.changes) {
			if (c.cell !== "vertex" || c.next !== null || c.prev === null) continue;
			const v = designation(def, c.prev);
			if (v !== undefined) m.set(c.id, v);
		}
	return m;
}

/** 脸 token：id 的呈现词。在世且 πₚ 可读其 designated 槽者以 designated 呈现（无名回落 id），离场者取冻结离场脸，其余原样回显。 */
type Face = (id: string) => string;

function faceOf(sim: Simulation, departed: ReadonlyMap<string, string>, perceive?: (e: Entity, prop: string) => boolean): Face {
	return (id) => {
		const e = entity(sim.world, id);
		if (!e) return departed.get(id) ?? id;
		if (perceive && !perceive(e, sim.def.designationKey)) return id;
		return designationOf(sim.def, e);
	};
}

function renderValue(face: Face, v: Payload, ref: boolean): { text: string; ids: string[] } {
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
		texts.push(face(item));
	}
	return { text: texts.join(", "), ids };
}

/** 注册表 type:"id" 的属性值是引用；关系值与未声明值一律字面。 */
function refProp(def: Pick<GameDef, "props">, prop: string): boolean {
	return def.props?.[prop]?.type === "id";
}

/** 值位指称与边端点同过参照门：目标不在参照域则整槽遮蔽——披露的指称必有卡。 */
function refsWithin(def: Pick<GameDef, "props">, prop: string, v: Value, vis: ReadonlySet<string>): boolean {
	if (!refProp(def, prop)) return true;
	for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string" && !vis.has(item)) return false;
	return true;
}

function fmtChange(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string {
	const val = (v: Payload, ok: boolean, ref: boolean): string => (ok ? renderValue(face, v, ref).text : "?");
	if (c.cell === "vertex") return `${c.next === null ? "-" : "+"} ${face(c.id)}`;
	if (c.cell === "edge") {
		// 空侧（创生/消散）随行广播、豁免截面；? 只占位有值未读
		const readable = (v: Payload, side: boolean): boolean => v === null || side;
		return `${face(c.from)}.${c.type}.${face(c.to)}: ${val(c.prev, readable(c.prev, sides.prev), false)} → ${val(c.next, readable(c.next, sides.next), false)}`;
	}
	if (c.prop === sim.def.designationKey) return `~ ${val(c.prev, sides.prev, false)} → ${val(c.next, sides.next, false)}`;
	const name = face(c.entity);
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	return `${name}.${label}: ${val(c.prev, sides.prev, refProp(sim.def, c.prop))} → ${val(c.next, sides.next, refProp(sim.def, c.prop))}`;
}

function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	const internal = internalPropsOf(def);
	return changes.filter((c) => !(c.cell === "prop" && internal.has(c.prop)));
}

/** 与渲染消费同一解析：指称集对渲染封闭——凡行铸出的同一性皆指称（prop 行主语在内），未披露侧不数。 */
function referentsOf(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string[] {
	if (c.cell === "vertex") return [c.id];
	if (c.cell === "edge") return [c.from, c.to];
	const ref = refProp(sim.def, c.prop);
	const out: string[] = [c.entity];
	if (sides.prev) out.push(...renderValue(face, c.prev, ref).ids);
	if (sides.next) out.push(...renderValue(face, c.next, ref).ids);
	return out;
}

/** 事件流的规范单行渲染（✓/✗/⏱/×n）；可说性按冻结截面判据，言默不随消费面改变（刻账目闭合）。 */
export function spineLines(sim: Simulation, steps: readonly Commit[], opts?: { departed?: ReadonlyMap<string, string> }): string[] {
	const shownDeparted = opts?.departed ?? shownDepartedNames(sim.def, steps);
	const perceive = sim.def.propPerception?.(deepFreeze(sim.snapshot()), sim.player);
	const face = faceOf(sim, shownDeparted, perceive);
	/** 步内可说变更的渲染：存在性、值侧披露与指称门共一判定。 */
	const speakableOf = (s: Commit): ((c: Change) => string | null) => {
		const field = new Set([...s.field.before, ...s.field.after]);
		const edgeSides = s.field.edges && { before: new Set(s.field.edges.before), after: new Set(s.field.edges.after) };
		const propSides = s.field.props && { before: new Set(s.field.props.before), after: new Set(s.field.props.after) };
		const sidesOf = (c: Change): { prev: boolean; next: boolean } | null => {
			if (c.cell === "edge" && edgeSides) return { prev: edgeSides.before.has(addrKey(c)), next: edgeSides.after.has(addrKey(c)) };
			if (c.cell === "prop" && propSides) return { prev: propSides.before.has(addrKey(c)), next: propSides.after.has(addrKey(c)) };
			return null;
		};
		return (c) => {
			const sides = sidesOf(c);
			if (sides && !sides.prev && !sides.next) return null;
			const effective = sides ?? { prev: true, next: true };
			if (!referentsOf(sim, c, face, effective).every((r) => field.has(r))) return null;
			return fmtChange(sim, c, face, effective);
		};
	};
	const msgs = sim.def.messages;
	const lines: string[] = [];
	const said = new Map<number, { changes: string[]; facts: Fact[]; denials: string[] }>();
	let granted = 0;
	const flush = (): void => {
		for (const { changes, facts, denials } of said.values()) {
			if (changes.length || facts.length) lines.push(`⏱ ${[
				changes.length ? `(${changes.join("; ")})` : "",
				facts.length ? `[${facts.join("; ")}]` : "",
			].join("")}`);
			for (const d of denials) lines.push(`⏱ ✗ ${d}`);
		}
		const silent = granted - said.size;
		if (silent > 0) lines.push(`⏱ ${msgs.timePassed} ×${silent}`);
		said.clear();
	};
	for (const s of steps) {
		if (s.origin !== "clock") {
			flush();
			granted = s.price;
			// 代码直连步不入事件流：不产尝试行，后果由状态视图与新见段承接
			if (s.origin === "code") continue;
			const changes = narratableChanges(sim.def, s.changes).map(speakableOf(s)).filter((x): x is string => x !== null);
			const tail = [
				changes.length ? `(${changes.join("; ")})` : "",
				s.ok && s.facts?.length ? `[${s.facts.join("; ")}]` : "",
			].join("");
			const voice = s.ok ? s.reason : renderDenial(sim.def, s.denial);
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, face)}${voice !== undefined ? `：${voice}` : ""}${tail}`);
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

export function relVal(world: World, from: string, to: string, type: string): Value | null {
	return world.relations.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 门内裁决的表态；src 是发言者地址（法则表态 rule:<verb>.<rule>，门的自判 gate:<law>），随提交入账。 */
type RawResult =
	| { ok: true; deltas: Delta[]; src: string; reason?: string; facts?: Fact[]; ticks?: number }
	| { ok: false; src: string; deniedBy: "rule" | "invariant"; denial: Denial };

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 实际起点读态的冻结副本 */
	private genesisCache?: World;

	constructor(def: GameDef, world?: World) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(world ?? def.world)) as World;
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
			if (v.clock) {
				const required = Object.values(v.params).filter((s) => !s.optional);
				if (required.length) throw new Error(`时钟动词 ${name} 不得有必填参数：泵以空参提案过门，时钟不是能改错重提的调用者`);
			}
		}
		for (const [k, pd] of Object.entries(def.props ?? {})) {
			if (pd.type !== "string" && pd.type !== "number" && pd.type !== "boolean" && pd.type !== "id" && pd.type !== "any") throw new Error(`属性「${k}」的 type 须为 string/number/boolean/id/any，得到 ${String(pd.type)}`);
			if (pd.many !== undefined && typeof pd.many !== "boolean") throw new Error(`属性「${k}」的 many 须为布尔，得到 ${String(pd.many)}`);
		}
		if (typeof def.designationKey !== "string" || def.designationKey === "") throw new Error("GameDef.designationKey 必填：指称呈现的键");
		const designated = def.props?.[def.designationKey];
		if (!designated) throw new Error(`designated 键「${def.designationKey}」未注册于 props`);
		if (designated.type !== "string" || designated.many === true) throw new Error(`designated 键「${def.designationKey}」须为标量 string 型`);
		if (designated.internal) throw new Error(`designated 键「${def.designationKey}」不得 internal`);
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

	/** 参照域 = grounding ∩ 账本 */
	private visibleIn(world: World): Set<string> {
		const ids = new Set(world.entities.map((e) => e.id));
		if (!this.def.grounding) return ids;
		return new Set(this.def.grounding(world, this.player).filter((id) => ids.has(id)));
	}

	private edgeField(world: World, vis: Set<string>): string[] | undefined {
		const perceive = this.def.edgePerception?.(world, this.player);
		if (!perceive) return undefined;
		const out: string[] = [];
		for (const r of world.relations) if (vis.has(r.from) && vis.has(r.to) && perceive(r)) out.push(addrKey({ cell: "edge", from: r.from, to: r.to, type: r.type }));
		return out;
	}

	/** 枚举注册表键而非在场键：缺席槽可感。 */
	private propField(world: World): string[] | undefined {
		const perceive = this.def.propPerception?.(world, this.player);
		if (!perceive) return undefined;
		const keys = Object.keys(this.def.props ?? {});
		const out: string[] = [];
		for (const e of world.entities) {
			for (const k of keys) if (perceive(e, k)) out.push(addrKey({ cell: "prop", entity: e.id, prop: k }));
		}
		return out;
	}

	/** 跨度开口：前侧截面于裁决/提交前采集（键截面仅于对应钩子声明时存在）。 */
	private openField(world: World, vis: Set<string>): { edges?: string[] | undefined; props?: string[] | undefined } {
		return { edges: this.edgeField(world, vis), props: this.propField(world) };
	}

	/** 跨度闭合：后侧仅在世界实际变更时重算，无变更则后侧即前侧（同一截面不再枚举）。 */
	private closeField(before: Set<string>, open: { edges?: string[] | undefined; props?: string[] | undefined }, changed: boolean): FieldSpan {
		let after = before;
		let edges = open.edges;
		let props = open.props;
		if (changed) {
			const w1 = this.readState();
			after = this.visibleIn(w1);
			edges = this.edgeField(w1, after);
			props = this.propField(w1);
		}
		const field: FieldSpan = { before: [...before], after: [...after] };
		if (open.edges && edges) field.edges = { before: open.edges, after: edges };
		if (open.props && props) field.props = { before: open.props, after: props };
		return field;
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

	private adjudicateRaw(action: Action, verb: VerbDef, curVis: Set<string>, world: World, pump: boolean): RawResult {
		const invalid = refParamsOf(verb)
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && !curVis.has(id));
		if (invalid.length) {
			const invisible = this.def.messages.invisibleEntity;
			return { ok: false, src: "gate:action.invisible", deniedBy: "rule", denial: { law: "action.invisible", ...(invisible !== undefined && { reason: invisible }), debug: invalid.join(",") } };
		}
		for (const r of verb.rules) {
			const src = `rule:${action.verb}.${r.id}`;
			const q = this.query(world, action.params, ["rule", action.verb, r.id]);
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, src, deniedBy: "invariant", denial: { law: "rule.crash", debug: `${src}: ${e instanceof Error ? e.message : String(e)}` } };
			}
			if (!v) continue;
			if (v.ok) {
				if (pump && v.ticks !== undefined) {
					return { ok: false, src, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `${src}: 时钟提案不得延伸时间` } };
				}
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, src, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `${src}: ticks 须为非负整数刻数，得到 ${String(v.ticks)}` } };
				}
				return { ok: true, deltas: v.deltas, src, ...(v.reason !== undefined && { reason: v.reason }), ...(v.facts !== undefined && { facts: v.facts }), ...(v.ticks !== undefined && { ticks: v.ticks }) };
			}
			return { ok: false, src, deniedBy: "rule", denial: v.denial };
		}
		return { ok: false, src: "gate:action.unanswered", deniedBy: "rule", denial: { law: "action.unanswered" } };
	}

	/** path 是骰子地址的机器身份，src 是其可读渲染，成对构造。 */
	private query(world: World, params: Record<string, Scalar>, path: string[]): Q {
		return {
			world,
			player: this.player,
			params,
			roll: (key, sides) => rollDice(world.time, tupleKey([...path, key]), sides),
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
	private commitChecked(s0: World, deltas: Delta[], src: string): { ok: true; changes: Change[] } | { ok: false; denial: Denial } {
		const genesis = this.genesis();
		try {
			const out = this.commit(deltas);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, denial: out.refusal };
			}
			const inv = this.checkInvariants(src, genesis, out.changes);
			if (inv) {
				this.restore(s0);
				const denial: Denial = inv.authored
					? { law: `invariant.${inv.id}`, reason: inv.message, debug: inv.message }
					: { law: `invariant.${inv.id}`, debug: inv.message };
				return { ok: false, denial };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, denial: { law: "invariant.crash", debug } };
		}
	}

	private checkInvariants(src: string, genesis: World, changes: Change[]): { id: string; message: string; authored: boolean } | null {
		const world = this.readState();
		const frozen = deepFreeze(changes);
		const broken = integrityInvariant.check(world, { def: this.def, genesis, changes: frozen, src });
		if (broken) return { id: "integrity", message: broken, authored: false };
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
		const step = this.attempt(s0, action, false);
		return { step, elapsed: this.pump(step.price) };
	}

	private attempt(s0: World, action: Action, pump: boolean): Commit {
		const at = s0.time;
		const verb = this.staticForm(action);
		const source = verb.internal ? "code" : "will";
		const before = this.visibleIn(s0);
		const open = this.openField(s0, before);
		const r = this.adjudicateRaw(action, verb, before, s0, pump);
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.src);
			const field = this.closeField(before, open, cc.ok && cc.changes.length > 0);
			if (!cc.ok)
				return pump
					? { at, src: r.src, origin: "clock", verb: action.verb, price: 0, ok: false, changes: [], field, deniedBy: "invariant", denial: cc.denial }
					: { at, src: r.src, origin: source, proposal: action, price: verb.cost, ok: false, changes: [], field, deniedBy: "invariant", denial: cc.denial };
			return pump
				? { at, src: r.src, origin: "clock", verb: action.verb, price: 0, ok: true, changes: cc.changes, field, ...(r.facts !== undefined && { facts: r.facts }) }
				: { at, src: r.src, origin: source, proposal: action, price: r.ticks ?? verb.cost, ok: true, changes: cc.changes, field, ...(r.reason !== undefined && { reason: r.reason }), ...(r.facts !== undefined && { facts: r.facts }) };
		}
		const field = this.closeField(before, open, false);
		return pump
			? { at, src: r.src, origin: "clock", verb: action.verb, price: 0, ok: false, changes: [], field, deniedBy: r.deniedBy, denial: r.denial }
			: { at, src: r.src, origin: source, proposal: action, price: verb.cost, ok: false, changes: [], field, deniedBy: r.deniedBy, denial: r.denial };
	}

	private pump(price: number): Commit[] {
		const out: Commit[] = [];
		for (let i = 0; i < price; i++) {
			this.world.time += 1;
			for (const [name, v] of Object.entries(this.def.verbs)) {
				if (!v.clock) continue;
				const c = this.attempt(this.readState(), { verb: name, params: {} }, true);
				if (!c.ok ? c.denial.law !== "action.unanswered" : c.changes.length > 0 || !!c.facts?.length) out.push(c);
			}
		}
		return out;
	}

	/** 尝试行恒可说而指称不经跨度门：合法性由裁决读态参照域判，过门者取 πₚ 可读之脸，否则原样回显——幻觉、隐藏、离场同一回显。 */
	describeAction(s: Attempt, face: Face): string {
		const action = s.proposal;
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const legal = new Set(s.field.before);
		const refs = new Set(refParamsOf(verb));
		const parts = Object.keys(verb.params)
			.filter((k) => k in action.params)
			.map((k) => {
				const v = action.params[k]!;
				if (!refs.has(k) || typeof v !== "string") return renderValue(face, v, false).text;
				if (!legal.has(v)) return v;
				return renderValue(face, v, true).text;
			});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	/** 重放一条回合记录：𝒞 反推 δ 过门内执行段（不重裁决、不掷骰），逐变更 prev 校验，终态 integrity；authored 不变式不重审——历史由当时的法则裁判过。链断回滚并返回原因。 */
	replayRecord(record: ChronicleEntry): string | null {
		const s0 = this.readState();
		const fail = (reason: string): string => {
			this.restore(s0);
			return `seq${record.seq} ${reason}`;
		};
		try {
			const start = record.steps.length ? record.steps[0]!.at : record.time;
			if (!Number.isInteger(start) || start !== this.world.time) return fail(`起点钟 ${String(start)} 不接续当前钟 ${this.world.time}`);
			const grants = record.steps.reduce((n, s) => n + s.price, 0);
			if (!Number.isInteger(record.time) || record.time !== start + grants) return fail(`末钟 ${String(record.time)} ≠ 起点 ${start} + 刻账 ${grants}`);
			for (const step of record.steps) {
				for (const c of step.changes) {
					const broken = this.verifyChange(c);
					if (broken) return fail(broken);
					const out = this.commit([deltaOf(c)]);
					if ("refusal" in out) return fail(`重放提交被拒：${out.refusal.debug}`);
				}
			}
			this.world.time = record.time;
			const broken = integrityInvariant.check(this.readState(), { def: this.def, genesis: s0, changes: [], src: `replay:${record.seq}` });
			if (broken) return fail(`integrity：${broken}`);
			return null;
		} catch (e) {
			return fail(errorText(e));
		}
	}

	/** 逐变更 prev 校验：记录前值须与重放世界相符；消散行的边可已随 despawn 消散（后态已成立即通过）。 */
	private verifyChange(c: Change): string | null {
		switch (c.cell) {
			case "vertex": {
				if (c.next === null) {
					const gone = entity(this.world, c.id);
					if (!gone) return `despawn "${c.id}" 不在世`;
					return c.prev !== null && sameEntity(gone, c.prev) ? null : `despawn "${c.id}" 离场态不符`;
				}
				return entity(this.world, c.id) ? `spawn "${c.id}" 已在世` : null;
			}
			case "prop": {
				const e = entity(this.world, c.entity);
				if (!e) return `set "${c.entity}.${c.prop}" 主语不在世`;
				return sameValue(e.props[c.prop] ?? null, c.prev) ? null : `set "${c.entity}.${c.prop}" 前值不符`;
			}
			case "edge": {
				const cur = relVal(this.world, c.from, c.to, c.type);
				if (c.next === null && cur === null) return null;
				return sameValue(cur, c.prev) ? null : `rel ${c.from}->${c.to} (${c.type}) 前值不符`;
			}
		}
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
		const entities = w.entities.filter((e) => vis.has(e.id)).map((e) => viewCard(this.def, e, vis, perceiveProp));
		const relations = w.relations.filter((r) => vis.has(r.from) && vis.has(r.to) && (!perceiveEdge || perceiveEdge(r)));
		const view: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) view.extra = extra;
		return JSON.stringify(view);
	}

	/** 逐条校验而非预检；幂等跳过的唯一判据是目标状态已成立。 */
	private commit(deltas: Delta[]): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		const upsertRel = (from: string, to: string, type: string, value: Value) => {
			const hit = this.world.relations.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else this.world.relations.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: Denial } => ({ refusal: { law: "invariant.commit", debug: `commit: ${debug}` } });
		const dangling = (from: string, to: string): boolean => !entity(this.world, from) || !entity(this.world, to);
		for (const d of deltas) {
			if (d.cell === "vertex") {
				if (d.next === null) {
					const i = this.world.entities.findIndex((e) => e.id === d.id);
					if (i < 0) return refuse(`despawn "${d.id}": entity missing`);
					const gone = this.world.entities[i]!;
					this.world.entities.splice(i, 1);
					// 逆序遍历 + unshift 保边表序
					const existing = this.world.relations;
					const dissolved: Rel[] = [];
					for (let j = existing.length - 1; j >= 0; j--) {
						const r = existing[j]!;
						if (r.from === d.id || r.to === d.id) {
							dissolved.unshift(r);
							existing.splice(j, 1);
						}
					}
					// 记录自含克隆，不与活账本共享引用
					changes.push({ cell: "vertex", id: d.id, prev: JSON.parse(JSON.stringify(gone)) as Entity, next: null });
					for (const r of dissolved) changes.push({ cell: "edge", from: r.from, to: r.to, type: r.type, prev: r.value, next: null });
				} else {
					if (entity(this.world, d.id)) return refuse(`spawn "${d.id}": entity already exists`);
					if (!Object.values(d.next.props).every(isValue)) return refuse(`spawn "${d.id}": props contain a non-value (non-null scalar or scalar array; absence is a missing key)`);
					changes.push({ cell: "vertex", id: d.id, prev: null, next: JSON.parse(JSON.stringify(d.next)) as Entity });
					this.world.entities.push(JSON.parse(JSON.stringify(d.next)) as Entity);
				}
				continue;
			}
			if (d.cell === "edge") {
				if (d.type === "") return refuse(`relSet ${d.from}->${d.to}: relation type must be non-empty string`);
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (sameValue(prev, d.next)) continue;
				if (dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
				if (d.next !== null && !isValue(d.next)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): value is not a value`);
				if (d.next === null) {
					// 能走到此处则边必已存在（prev !== null）
					const i = this.world.relations.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) this.world.relations.splice(i, 1);
				} else {
					upsertRel(d.from, d.to, d.type, d.next);
				}
				changes.push({ cell: "edge", from: d.from, to: d.to, type: d.type, prev, next: d.next });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) return refuse(`set "${d.entity}.${d.prop}": target entity missing`);
			if (d.next !== null && !isValue(d.next)) return refuse(`set "${d.entity}.${d.prop}": value is not a value (non-null scalar or scalar array)`);
			const prev = e.props[d.prop] ?? null;
			if (sameValue(prev, d.next)) continue;
			if (d.next === null) delete e.props[d.prop];
			else e.props[d.prop] = d.next;
			changes.push({ cell: "prop", entity: d.entity, prop: d.prop, prev, next: d.next });
		}
		return { changes };
	}
}
