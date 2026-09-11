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

/** 值域与解释的一根轴：字面标量或以实体 id 为值的指称。 */
export type SlotType = "string" | "number" | "boolean" | "ref";

/**
 * 属性声明：类型 × 重数 × 呈现。type 定值域与解释（ref 即实体 id）；
 * many 声明重数；label 是槽的模型面名字（缺席即非槽）。
 * 身份键在 GameDef.identity（结构上全域至多一），其属性恒为无 label 的非 many string。
 */
export interface PropDef {
	type: SlotType;
	/** 重数：缺省 one（标量），true 为非空序列 many(Seq)。 */
	many?: true;
	/** 槽的模型面名字；缺席即不进槽呈现。 */
	label?: string;
}

/** 否决受众：world = 世界腔（玩家可见，voice 缺省即 noResponse）；engine = 引擎/作者契约违约（仅 debug）。 */
export interface Denial {
	/** 理由身份：作者 token 或引擎保留 id；前缀不承担分类。 */
	law: string;
	fault: "world" | "engine";
	/** 作者世界语（不过投影），渲染为否决声；缺席即回落 noResponse。 */
	voice?: Fact;
	debug?: string;
}

/** 静态形态违约（未知动词 / schema 不符）：正常拒绝点在工具边界，内核收到即调用方违约。 */
export class ProtocolViolation extends Error {
	readonly code: "action.unknown" | "action.schema";
	readonly debug: string;

	constructor(code: "action.unknown" | "action.schema", debug: string) {
		super(`Protocol violation ${code}: ${debug}`);
		this.code = code;
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

/** 授予：deltas 是轨迹，voice 是声，facts 是附加世界腔事实，ticks 覆写价。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; voice?: Fact; facts?: Fact[]; ticks?: number }
	| { ok: false; denial: Denial };

export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

export function grant(deltas: Delta[], opts: { voice?: Fact; facts?: Fact[]; ticks?: number } = {}): Verdict {
	return {
		ok: true,
		deltas,
		...(opts.voice !== undefined && { voice: opts.voice }),
		...(opts.facts !== undefined && { facts: opts.facts }),
		...(opts.ticks !== undefined && { ticks: opts.ticks }),
	};
}

export function deny(law: string, voice?: Fact): Verdict {
	return { ok: false, denial: { law, fault: "world", ...(voice !== undefined && { voice }) } };
}

export const D = {
	set: (entity: string, prop: string, value: Payload): Delta => ({ cell: "prop", entity, prop, next: value }),
	relSet: (from: string, to: string, type: string, value: Payload): Delta => ({ cell: "edge", from, to, type, next: value }),
	spawn: (entity: Entity): Delta => ({ cell: "vertex", id: entity.id, next: entity }),
	despawn: (entity: string): Delta => ({ cell: "vertex", id: entity, next: null }),
};

/** 格的机器身份：键、截面与记录共用同一编码。 */
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

/** 动词参数的声明面：类型 × 可选 × 描述。 */
export interface ParamSpec {
	type: SlotType;
	optional?: true;
	description?: string;
}

type ScalarOf<S extends { type: SlotType }> = S["type"] extends "number" ? number : S["type"] extends "boolean" ? boolean : string;

/** 规则参数的编译期类型，由 params 声明推导。 */
export type ParamsOf<P extends Record<string, ParamSpec>> = {
	[K in keyof P as P[K] extends { optional: true } ? never : K]: ScalarOf<P[K]>;
} & {
	[K in keyof P as P[K] extends { optional: true } ? K : never]?: ScalarOf<P[K]>;
};

/** 指称参数：值是实体 id，过所指门。 */
export function ref(description?: string): { type: "ref"; description?: string } {
	return { type: "ref", ...(description !== undefined && { description }) };
}

/** 自由字符串：值按字面进入裁决。 */
export function free(description?: string): { type: "string"; description?: string } {
	return { type: "string", ...(description !== undefined && { description }) };
}

export function refParamsOf(verb: VerbDef): string[] {
	return Object.keys(verb.params).filter((k) => verb.params[k]?.type === "ref");
}

/** 规则参数由 params 声明推导编译期类型。 */
export function defineVerb<P extends Record<string, ParamSpec>>(spec: {
	label: string;
	description: string;
	params: P;
	cost: number;
	private?: boolean;
	clock?: boolean;
	rules: { id: string; judge: (q: Q<ParamsOf<P>>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		params: spec.params,
		cost: spec.cost,
		...(spec.private !== undefined && { private: spec.private }),
		...(spec.clock !== undefined && { clock: spec.clock }),
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q as Q<ParamsOf<P>>) })),
	};
}

export interface VerbDef {
	label: string;
	description: string;
	params: Record<string, ParamSpec>;
	cost: number;
	/** 不进广告面、不可被 will 提案；仍可由代码直连 apply。 */
	private?: boolean;
	clock?: boolean;
	rules: Rule[];
}

/** 类型匹配：ref 的运行时表示是 id 字符串。 */
function matchesType(type: SlotType, v: unknown): boolean {
	switch (type) {
		case "string": case "ref": return typeof v === "string";
		case "number": return typeof v === "number";
		case "boolean": return typeof v === "boolean";
	}
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
		if (!matchesType(s.type, v)) out.push(`params.${name}: must be ${s.type}${desc(s)}`);
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
	verbs: Record<string, VerbDef>;
	world: World;
	/** 属性注册表：κ 的全定义域，必填。 */
	props: Record<string, PropDef>;
	/** 身份键：props 里的一个 string 属性，结构上全域至多一；其值提升为实体名，渲染取 `~` 形。 */
	identity?: string;
	/** 近况窗口的回合记录数。 */
	recentWindow: number;
	/** 所指域：意志能点名什么（ref 参数门）。缺省全见。 */
	naming?: (world: World, player: string) => (id: string) => boolean;
	/** 所见域：呈现能显什么，按格求值（顶点格的成员即卡）。缺省顶点随所指、边/槽恒真；声明即接管全部格，边/属性截面随之存在。 */
	sight?: (world: World, player: string) => (cell: Addr) => boolean;
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
	source: Source;
}

/** null 通过；违反即整提交回滚并拒绝。收冻结读态，写入即抛。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

function isScalarValue(v: unknown): v is Scalar {
	return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** 类型挡不住 as 通道（存档恢复、场景 JSON、probe），存储形状运行时复核；空序列无席位（缺席是唯一的零，空序列不是它的拼写）。 */
function isValue(v: unknown): v is Value {
	return isScalarValue(v) || (Array.isArray(v) && v.length > 0 && v.every(isScalarValue));
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
			const registry = Object.entries(ctx.def.props);
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
					if (!isValue(v)) return `integrity: ${e.id}.${p} is not a value (non-null scalar or non-empty scalar array; absence is a missing key)`;
					const many = pd.many === true;
					if (Array.isArray(v) !== many) return `integrity: ${e.id}.${p} expects ${many ? "a sequence" : "a scalar"}, got ${got(v)}`;
					if (p === ctx.def.identity && v === "") return `integrity: ${e.id}.${p} must be non-empty string (empty designation is absence; omit the key)`;
					for (const x of Array.isArray(v) ? v : [v]) {
						if (pd.type === "ref") {
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
			if (r.value === null || !isValue(r.value)) return `integrity: relation ${r.type} -> value is not a value (non-null, non-empty; stored edges never hold null)`;
		}
		return null;
	},
};

/** 非槽且非身份的属性不进呈现面。 */
function hiddenProp(def: GameDef, prop: string): boolean {
	const pd = def.props[prop];
	return pd !== undefined && pd.label === undefined && prop !== def.identity;
}

function hasLabel(def: GameDef, prop: string): boolean {
	return def.props[prop]?.label !== undefined;
}

/** 身份值：非空 string；缺席即无名。 */
export function designation(def: GameDef, e: Entity): string | undefined {
	const key = def.identity;
	if (key === undefined) return undefined;
	const v = e.props[key];
	return typeof v === "string" && v !== "" ? v : undefined;
}

export function viewCard(def: GameDef, e: Entity, vis: ReadonlySet<string>, perceiveProp?: (e: Entity, prop: string) => boolean): { id: string; name?: string; props: Record<string, Value> } {
	const name = def.identity === undefined || (perceiveProp !== undefined && !perceiveProp(e, def.identity)) ? undefined : designation(def, e);
	const props: Record<string, Value> = {};
	for (const [k, v] of Object.entries(e.props)) {
		if (!hasLabel(def, k)) continue;
		if (perceiveProp && !perceiveProp(e, k)) continue;
		if (!refsWithin(def, k, v, vis)) continue;
		props[propLabelOf(def, k)] = v;
	}
	return { id: e.id, ...(name !== undefined && { name }), props };
}

/** 槽的模型面名字；加载期保证一切可渲染槽携非空 label。 */
function propLabelOf(def: GameDef, prop: string): string {
	const label = def.props[prop]?.label;
	if (label === undefined) throw new Error(`属性「${prop}」无模型面名字：key 不进模型面`);
	return label;
}

/** 边界脸表：id → 呈现名（null = 在世但无可披露名）。成员即所见域，值即冻结的身份披露。 */
export type FaceList = readonly (readonly [string, string | null])[];

/** 提交边界两侧的呈现前提：脸表（顶点格）恒在，边/属性截面仅于 sight 声明时存在；裁决时取定，提交后不可重算。 */
export interface FieldSpan {
	before: FaceList;
	after: FaceList;
	edges?: { before: string[]; after: string[] };
	props?: { before: string[]; after: string[] };
}

/** 所见域与格谓词的同一次求值：卡集合即谓词于顶点格的成员。 */
export interface SightView {
	within: (cell: Addr) => boolean;
	cards: Set<string>;
}

/** 无碰撞元组编码：成分字符集不受约束。 */
function tupleKey(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

/** 触发通道，由调用点决定并随步入账：意志（玩家经广告面提案）、时钟（泵逐刻自鸣）、代码（引擎直连 apply）。 */
export type Origin = "will" | "clock" | "code";

/** 裁决出处（发言者地址）。 */
export type Decision =
	| { kind: "rule"; rule: string }
	| { kind: "gate"; law: "action.invisible" | "action.unanswered" };

/** 装载出处：审查的起点不是裁决。 */
export type Ingest = { kind: "init" } | { kind: "replay"; seq: number };

/** 审查可见的出处。 */
export type Source = Decision | Ingest;

/** 决策事件的机器身份：账本位置 (at, origin, verb, 序位)。对尝试单射、且由账本复原——随机是账本位置的纯函数。 */
function attemptAddr(at: number, origin: Origin, verb: string, ordinal: number): string {
	return tupleKey(["attempt", String(at), origin, verb, String(ordinal)]);
}

/** 可读渲染；不参与机器判定。 */
function renderSource(s: Source): string {
	switch (s.kind) {
		case "rule": return `rule:${s.rule}`;
		case "gate": return `gate:${s.law}`;
		case "init": return "init";
		case "replay": return `replay:${s.seq}`;
	}
}

/** 步一律携公共载荷 action（clock 的 params 恒空，是空参提案）。价 = origin=clock ? 0 : ok ? (granted ?? cost) : cost。声：授予带 voice/facts，否决带 denial。source 是裁决出处。 */
export type Commit =
	| { at: number; source: Decision; origin: Origin; action: Action; price: number; ok: true; changes: Change[]; field: FieldSpan; voice?: Fact; facts?: Fact[] }
	| { at: number; source: Decision; origin: Origin; action: Action; price: number; ok: false; changes: []; field: FieldSpan; denial: Denial };

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
	return denial.voice ?? def.messages.noResponse;
}

/** 脸 token：id 在某个提交边界上的呈现词。脸表冻结，行文不回读活世界。 */
type Face = (id: string) => string;

function faceOf(faces: ReadonlyMap<string, string | null>): Face {
	return (id) => faces.get(id) ?? id;
}

function faceMap(faces: FaceList): Map<string, string | null> {
	return new Map(faces);
}

function renderValue(face: Face, v: Payload, isRef: boolean): { text: string; ids: string[] } {
	if (!isRef) return { text: String(v), ids: [] };
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

/** 注册表指称模式的值是引用；关系值与字面值一律字面。 */
function isRefProp(def: Pick<GameDef, "props">, prop: string): boolean {
	return def.props[prop]?.type === "ref";
}

/** 值位指称与边端点同过所见域：目标不在所见域则整槽遮蔽——披露的指称必有卡。 */
function refsWithin(def: Pick<GameDef, "props">, prop: string, v: Value, vis: ReadonlySet<string>): boolean {
	if (!isRefProp(def, prop)) return true;
	for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string" && !vis.has(item)) return false;
	return true;
}

function fmtChange(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string {
	const val = (v: Payload, ok: boolean, isRef: boolean): string => (ok ? renderValue(face, v, isRef).text : "?");
	if (c.cell === "vertex") return `${c.next === null ? "-" : "+"} ${face(c.id)}`;
	if (c.cell === "edge") {
		// 空侧（创生/消散）随行广播、豁免截面；? 只占位有值未读
		const readable = (v: Payload, side: boolean): boolean => v === null || side;
		return `${face(c.from)}.${c.type}.${face(c.to)}: ${val(c.prev, readable(c.prev, sides.prev), false)} → ${val(c.next, readable(c.next, sides.next), false)}`;
	}
	if (sim.identityKey !== undefined && c.prop === sim.identityKey) return `~ ${val(c.prev, sides.prev, false)} → ${val(c.next, sides.next, false)}`;
	const name = face(c.entity);
	const label = propLabelOf(sim.def, c.prop);
	return `${name}.${label}: ${val(c.prev, sides.prev, isRefProp(sim.def, c.prop))} → ${val(c.next, sides.next, isRefProp(sim.def, c.prop))}`;
}

function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	return changes.filter((c) => !(c.cell === "prop" && hiddenProp(def, c.prop)));
}

/** 与渲染消费同一解析：指称集对渲染封闭——凡行铸出的同一性皆指称（prop 行主语在内），未披露侧不数。 */
function referentsOf(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string[] {
	if (c.cell === "vertex") return [c.id];
	if (c.cell === "edge") return [c.from, c.to];
	const ref = isRefProp(sim.def, c.prop);
	const out: string[] = [c.entity];
	if (sides.prev) out.push(...renderValue(face, c.prev, ref).ids);
	if (sides.next) out.push(...renderValue(face, c.next, ref).ids);
	return out;
}
/** 事件流的规范单行渲染（✓/✗/⏱/×n）；可说性按冻结截面与冻结脸表判据，言默不随消费面改变（刻账目闭合）。 */
export function spineLines(sim: Simulation, steps: readonly Commit[]): string[] {
	/** 一步的渲染器：脸表是该步提交边界的冻结快照，行文不回读活世界。 */
	const renderer = (s: Commit): { face: Face; changeLine: (c: Change) => string | null } => {
		const faces = faceMap([...s.field.before, ...s.field.after]);
		const face = faceOf(faces);
		const field = new Set(faces.keys());
		const edgeSides = s.field.edges && { before: new Set(s.field.edges.before), after: new Set(s.field.edges.after) };
		const propSides = s.field.props && { before: new Set(s.field.props.before), after: new Set(s.field.props.after) };
		const sidesOf = (c: Change): { prev: boolean; next: boolean } | null => {
			if (c.cell === "edge" && edgeSides) return { prev: edgeSides.before.has(addrKey(c)), next: edgeSides.after.has(addrKey(c)) };
			if (c.cell === "prop" && propSides) return { prev: propSides.before.has(addrKey(c)), next: propSides.after.has(addrKey(c)) };
			return null;
		};
		const changeLine = (c: Change): string | null => {
			const sides = sidesOf(c);
			if (sides && !sides.prev && !sides.next) return null;
			const effective = sides ?? { prev: true, next: true };
			if (!referentsOf(sim, c, face, effective).every((r) => field.has(r))) return null;
			return fmtChange(sim, c, face, effective);
		};
		return { face, changeLine };
	};
	const msgs = sim.def.messages;
	const lines: string[] = [];
	const said = new Map<number, { changes: string[]; voice: Fact[]; facts: Fact[]; denials: string[] }>();
	let granted = 0;
	const flush = (): void => {
		for (const { changes, voice, facts, denials } of said.values()) {
			const spoken = [...voice, ...facts];
			if (changes.length || spoken.length) lines.push(`⏱ ${[
				changes.length ? `(${changes.join("; ")})` : "",
				spoken.length ? `[${spoken.join("; ")}]` : "",
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
			const { face, changeLine } = renderer(s);
			const changes = narratableChanges(sim.def, s.changes).map(changeLine).filter((x): x is string => x !== null);
			const voice = s.ok ? s.voice : renderDenial(sim.def, s.denial);
			const facts = s.ok ? (s.facts ?? []) : [];
			const tail = [
				changes.length ? `(${changes.join("; ")})` : "",
				facts.length ? `[${facts.join("; ")}]` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, face)}${voice !== undefined ? `：${voice}` : ""}${tail}`);
		} else {
			const held = said.get(s.at) ?? { changes: [], voice: [], facts: [], denials: [] };
			if (s.ok) {
				held.changes.push(...narratableChanges(sim.def, s.changes).map(renderer(s).changeLine).filter((x): x is string => x !== null));
				if (s.voice !== undefined) held.voice.push(s.voice);
				if (s.facts?.length) held.facts.push(...s.facts);
			} else {
				held.denials.push(renderDenial(sim.def, s.denial));
			}
			if (held.changes.length || held.voice.length || held.facts.length || held.denials.length) said.set(s.at, held);
		}
	}
	flush();
	return lines;
}

export function relVal(world: World, from: string, to: string, type: string): Value | null {
	return world.relations.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 门内裁决的表态；source 是裁决出处，随提交入账。 */
type RawResult =
	| { ok: true; deltas: Delta[]; source: Decision; voice?: Fact; facts?: Fact[]; ticks?: number }
	| { ok: false; source: Decision; denial: Denial };

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 身份键 = def.identity；缺席时实体以 id 示人。 */
	readonly identityKey: string | undefined;
	/** 实际起点读态的冻结副本 */
	private genesisCache?: World;
	/** 骰子地址的序位来源：同 (at, origin, verb) 的第 n 次表态——账本位置的一部分，重放可复原（静默时钟步不入账，故序位按 origin 分账）。 */
	private attemptAt = -1;
	private readonly attemptSeq = new Map<string, number>();

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
				if (s.type !== "string" && s.type !== "number" && s.type !== "boolean" && s.type !== "ref") throw new Error(`动词 ${name} 的参数「${p}」的类型须为 string/number/boolean/ref，得到 ${String(s.type)}`);
			}
			if (v.clock) {
				const required = Object.values(v.params).filter((s) => !s.optional);
				if (required.length) throw new Error(`时钟动词 ${name} 不得有必填参数：泵以空参提案过门，时钟不是能改错重提的调用者`);
			}
		}
		// props 必填；label 非空且两两相异；identity 为结构事实，其属性须为无 label 的非 many string
		const labels = new Map<string, string>();
		for (const [k, pd] of Object.entries(def.props)) {
			if (pd.type !== "string" && pd.type !== "number" && pd.type !== "boolean" && pd.type !== "ref") throw new Error(`属性「${k}」的类型须为 string/number/boolean/ref，得到 ${String(pd.type)}`);
			if (pd.many !== undefined && pd.many !== true) throw new Error(`属性「${k}」的 many 只能为 true（缺省即 one），得到 ${String(pd.many)}`);
			if (pd.label !== undefined) {
				if (pd.label === "") throw new Error(`属性「${k}」的 label 须非空：key 不进模型面`);
				const prev = labels.get(pd.label);
				if (prev !== undefined) throw new Error(`属性 label 重复：「${pd.label}」为「${prev}」与「${k}」共有`);
				labels.set(pd.label, k);
			}
		}
		const identityKey = def.identity;
		if (identityKey !== undefined) {
			const pd = def.props[identityKey];
			if (!pd) throw new Error(`identity「${identityKey}」未在 props 注册`);
			if (pd.type !== "string" || pd.many === true || pd.label !== undefined) throw new Error(`identity「${identityKey}」须为无 label 的非 many string 属性`);
		}
		this.identityKey = identityKey;
		// 初始世界过审查：def 结构错误与损坏存档在此显形
		const broken = this.checkInvariants({ kind: "init" }, this.readState(), []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.message}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	/** 所指域（意志能点名什么）：指称参数门。 */
	domain(): Set<string> {
		return this.namingIn(this.readState());
	}

	/** 所见域（呈现能显什么）：卡的存在域。 */
	sights(): Set<string> {
		return this.sightView(this.readState()).cards;
	}

	/** 所指谓词：缺省全见。 */
	private namingOf(world: World): (id: string) => boolean {
		return this.def.naming?.(world, this.player) ?? (() => true);
	}

	/** 所见谓词：缺省顶点随所指、边/槽恒真；作者声明 sight 即接管全部格。 */
	private sightOf(world: World): (cell: Addr) => boolean {
		const sight = this.def.sight?.(world, this.player);
		if (sight) return sight;
		const naming = this.def.naming?.(world, this.player);
		if (!naming) return () => true;
		return (cell) => cell.cell !== "vertex" || naming(cell.id);
	}

	private namingIn(world: World): Set<string> {
		const within = this.namingOf(world);
		return new Set(world.entities.map((e) => e.id).filter((id) => within(id)));
	}

	/** 所见域与格谓词的同一次求值：卡集合即谓词于顶点格的成员。 */
	sightView(world: World): SightView {
		const within = this.sightOf(world);
		return { within, cards: new Set(world.entities.filter((e) => within({ cell: "vertex", id: e.id })).map((e) => e.id)) };
	}

	/** 边界脸表：所见域内实体 × 身份披露。冻结后行文不回读活世界。 */
	private faceList(world: World, seen: SightView): FaceList {
		const key = this.identityKey;
		const out: [string, string | null][] = [];
		for (const e of world.entities) {
			if (!seen.cards.has(e.id)) continue;
			const readable = key !== undefined && seen.within({ cell: "prop", entity: e.id, prop: key });
			out.push([e.id, readable ? (designation(this.def, e) ?? null) : null]);
		}
		return out;
	}

	/** 边键截面：边格谓词于键空间求值，端点闭合另行把门（见 changeLine）。 */
	private edgeField(world: World, seen: SightView): string[] {
		const out: string[] = [];
		for (const r of world.relations) if (seen.within({ cell: "edge", from: r.from, to: r.to, type: r.type })) out.push(addrKey({ cell: "edge", from: r.from, to: r.to, type: r.type }));
		return out;
	}

	/** 属性键截面：枚举注册表键而非在场键，槽格谓词对全集求值——缺席槽可感，在场由闭合另行把门。 */
	private propField(world: World, seen: SightView): string[] {
		const keys = Object.keys(this.def.props);
		const out: string[] = [];
		for (const e of world.entities) {
			for (const k of keys) if (seen.within({ cell: "prop", entity: e.id, prop: k })) out.push(addrKey({ cell: "prop", entity: e.id, prop: k }));
		}
		return out;
	}

	/** 跨度开口：前侧截面于裁决/提交前采集（键截面仅于 sight 声明时存在）。 */
	private openField(world: World, seen: SightView): { edges?: string[]; props?: string[] } {
		if (!this.def.sight) return {};
		return { edges: this.edgeField(world, seen), props: this.propField(world, seen) };
	}

	/** 跨度闭合：后侧仅在世界实际变更时重算，无变更则后侧即前侧（同一前提不再重算）。 */
	private closeField(before: FaceList, open: { edges?: string[] | undefined; props?: string[] | undefined }, changed: boolean): FieldSpan {
		let faces = before;
		let edges = open.edges;
		let props = open.props;
		if (changed) {
			const w1 = this.readState();
			const seen = this.sightView(w1);
			faces = this.faceList(w1, seen);
			if (this.def.sight) {
				edges = this.edgeField(w1, seen);
				props = this.propField(w1, seen);
			}
		}
		const field: FieldSpan = { before, after: faces };
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

	private adjudicateRaw(action: Action, verb: VerbDef, gate: Set<string>, world: World, addr: string, origin: Origin): RawResult {
		const invalid = refParamsOf(verb)
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && !gate.has(id));
		if (invalid.length) {
			const invisible = this.def.messages.invisibleEntity;
			return { ok: false, source: { kind: "gate", law: "action.invisible" }, denial: { law: "action.invisible", fault: "world", ...(invisible !== undefined && { voice: invisible }) } };
		}
		for (const r of verb.rules) {
			const source: Decision = { kind: "rule", rule: r.id };
			const q = this.query(world, action.params, addr);
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, source, denial: { law: "rule.crash", fault: "engine", debug: `${renderSource(source)}: ${e instanceof Error ? e.message : String(e)}` } };
			}
			if (!v) continue;
			if (v.ok) {
				if (origin === "clock" && v.ticks !== undefined) {
					return { ok: false, source, denial: { law: "invariant.grant", fault: "engine", debug: `${renderSource(source)}: 时钟提案不得延伸时间` } };
				}
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, source, denial: { law: "invariant.grant", fault: "engine", debug: `${renderSource(source)}: ticks 须为非负整数刻数，得到 ${String(v.ticks)}` } };
				}
				return { ok: true, deltas: v.deltas, source, ...(v.voice !== undefined && { voice: v.voice }), ...(v.facts !== undefined && { facts: v.facts }), ...(v.ticks !== undefined && { ticks: v.ticks }) };
			}
			return { ok: false, source, denial: v.denial };
		}
		return { ok: false, source: { kind: "gate", law: "action.unanswered" }, denial: { law: "action.unanswered", fault: "world" } };
	}

	/** 骰子地址是决策事件的账本位置；同地址同 key 恒同值，与法则重构无关。 */
	private query(world: World, params: Record<string, Scalar>, addr: string): Q {
		return {
			world,
			player: this.player,
			params,
			roll: (key, sides) => rollDice(addr, key, sides),
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
	private commitChecked(s0: World, deltas: Delta[], source: Decision): { ok: true; changes: Change[] } | { ok: false; denial: Denial } {
		const genesis = this.genesis();
		try {
			const out = this.commit(deltas);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, denial: out.refusal };
			}
			const inv = this.checkInvariants(source, genesis, out.changes);
			if (inv) {
				this.restore(s0);
				const denial: Denial = inv.authored
					? { law: `invariant.${inv.id}`, fault: "world", voice: inv.message }
					: { law: `invariant.${inv.id}`, fault: "engine", debug: inv.message };
				return { ok: false, denial };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, denial: { law: "invariant.crash", fault: "engine", debug } };
		}
	}

	private checkInvariants(source: Source, genesis: World, changes: Change[]): { id: string; message: string; authored: boolean } | null {
		const world = this.readState();
		const frozen = deepFreeze(changes);
		const broken = integrityInvariant.check(world, { def: this.def, genesis, changes: frozen, source });
		if (broken) return { id: "integrity", message: broken, authored: false };
		for (const inv of this.def.invariants ?? []) {
			const msg = inv.check(world, { def: this.def, genesis, changes: frozen, source });
			if (msg) return { id: inv.id, message: msg, authored: true };
		}
		return null;
	}

	/** 历史原子性：异常逃逸 ⇒ 世界恢复调用前原状再抛。attempt 入界即冻结（Q.params 与步记录同一对象），Resolution 出界即冻结（记录是证据而非视图）。 */
	apply(action: Action, origin: Exclude<Origin, "clock"> = "will"): Resolution {
		deepFreeze(action);
		const s0 = this.readState();
		try {
			return deepFreeze(this.applyInner(action, s0, origin));
		} catch (e) {
			this.restore(s0);
			throw e;
		}
	}

	private applyInner(action: Action, s0: World, origin: Exclude<Origin, "clock">): Resolution {
		const step = this.attempt(s0, action, origin);
		return { step, elapsed: this.pump(step.price) };
	}

	private attempt(s0: World, action: Action, origin: Origin): Commit {
		const at = s0.time;
		const verb = this.staticForm(action);
		const addr = attemptAddr(at, origin, action.verb, this.noteAttempt(at, origin, action.verb));
		const clock = origin === "clock";
		const gate = this.namingIn(s0);
		const seen = this.sightView(s0);
		const before = this.faceList(s0, seen);
		const open = this.openField(s0, seen);
		const r = this.adjudicateRaw(action, verb, gate, s0, addr, origin);
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.source);
			const field = this.closeField(before, open, cc.ok && cc.changes.length > 0);
			if (!cc.ok)
				return { at, source: r.source, origin, action, price: clock ? 0 : verb.cost, ok: false, changes: [], field, denial: cc.denial };
			return { at, source: r.source, origin, action, price: clock ? 0 : (r.ticks ?? verb.cost), ok: true, changes: cc.changes, field, ...(r.voice !== undefined && { voice: r.voice }), ...(r.facts !== undefined && { facts: r.facts }) };
		}
		const field = this.closeField(before, open, false);
		return { at, source: r.source, origin, action, price: clock ? 0 : verb.cost, ok: false, changes: [], field, denial: r.denial };
	}

	private noteAttempt(at: number, origin: Origin, verb: string): number {
		if (at !== this.attemptAt) {
			this.attemptAt = at;
			this.attemptSeq.clear();
		}
		const key = `${origin}\u0000${verb}`;
		const n = this.attemptSeq.get(key) ?? 0;
		this.attemptSeq.set(key, n + 1);
		return n;
	}

	private pump(price: number): Commit[] {
		const out: Commit[] = [];
		for (let i = 0; i < price; i++) {
			this.world.time += 1;
			for (const [name, v] of Object.entries(this.def.verbs)) {
				if (!v.clock) continue;
				const c = this.attempt(this.readState(), { verb: name, params: {} }, "clock");
				if (!c.ok ? c.denial.law !== "action.unanswered" : c.changes.length > 0 || c.voice !== undefined || !!c.facts?.length) out.push(c);
			}
		}
		return out;
	}

	/** 尝试行恒可说而指称不经跨度门：合法性由裁决读态的所指域判（门已把），脸面由该步所见域给，未过所见者原样回显。 */
	describeAction(s: Commit, face: Face): string {
		const action = s.action;
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const refs = new Set(refParamsOf(verb));
		const parts = Object.keys(verb.params)
			.filter((k) => k in action.params)
			.map((k) => {
				const v = action.params[k]!;
				if (!refs.has(k) || typeof v !== "string") return renderValue(face, v, false).text;
				return face(v);
			});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	/** 检查点已含其后果的回合仍须按账本复原点数：世界的重放可以跳过，序位的演进不可以（否则续掷与连续会话分叉）。 */
	seedAttempts(record: ChronicleEntry): void {
		for (const step of record.steps) this.noteAttempt(step.at, step.origin, step.action.verb);
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
				this.noteAttempt(step.at, step.origin, step.action.verb);
				for (const c of step.changes) {
					const broken = this.verifyChange(c);
					if (broken) return fail(broken);
					const out = this.commit([deltaOf(c)]);
					if ("refusal" in out) return fail(`重放提交被拒：${out.refusal.debug}`);
				}
			}
			this.world.time = record.time;
			const broken = integrityInvariant.check(this.readState(), { def: this.def, genesis: s0, changes: [], source: { kind: "replay", seq: record.seq } });
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

	/** 状态视图：卡的集合即所见域；模型可指名的必在所指域，所见可窄于所指。 */
	digest(): string {
		const w = this.readState();
		const seen = this.sightView(w);
		const entities = w.entities.filter((e) => seen.cards.has(e.id)).map((e) => this.cardOf(e, seen));
		const relations = w.relations.filter((r) => seen.cards.has(r.from) && seen.cards.has(r.to) && seen.within({ cell: "edge", from: r.from, to: r.to, type: r.type }));
		const out: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) out.extra = extra;
		return JSON.stringify(out);
	}

	/** 卡：身份与槽按所见谓词遮蔽，值位指称须在所见域。 */
	cardOf(e: Entity, seen: SightView): { id: string; name?: string; props: Record<string, Value> } {
		return viewCard(this.def, e, seen.cards, (x, prop) => seen.within({ cell: "prop", entity: x.id, prop }));
	}

	/** 逐条校验而非预检；幂等跳过的唯一判据是目标状态已成立。 */
	private commit(deltas: Delta[]): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		const upsertRel = (from: string, to: string, type: string, value: Value) => {
			const hit = this.world.relations.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else this.world.relations.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: Denial } => ({ refusal: { law: "invariant.commit", fault: "engine", debug: `commit: ${debug}` } });
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
					const ent: Entity = { id: d.next.id, props: d.next.props };
					if (!Object.values(ent.props).every(isValue)) return refuse(`spawn "${d.id}": props contain a non-value (non-null non-empty scalar or scalar array; absence is a missing key)`);
					changes.push({ cell: "vertex", id: d.id, prev: null, next: JSON.parse(JSON.stringify(ent)) as Entity });
					this.world.entities.push(JSON.parse(JSON.stringify(ent)) as Entity);
				}
				continue;
			}
			if (d.cell === "edge") {
				if (d.type === "") return refuse(`relSet ${d.from}->${d.to}: relation type must be non-empty string`);
				const next = d.next;
				if (next !== null && !isValue(next)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): value is not a non-empty value`);
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (sameValue(prev, next)) continue;
				if (dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
				if (next === null) {
					// 能走到此处则边必已存在（prev !== null）
					const i = this.world.relations.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) this.world.relations.splice(i, 1);
				} else {
					upsertRel(d.from, d.to, d.type, next);
				}
				changes.push({ cell: "edge", from: d.from, to: d.to, type: d.type, prev, next });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) return refuse(`set "${d.entity}.${d.prop}": target entity missing`);
			const next = d.next;
			if (next !== null && !isValue(next)) return refuse(`set "${d.entity}.${d.prop}": value is not a non-empty value (non-null scalar or non-empty scalar array)`);
			const prev = e.props[d.prop] ?? null;
			if (sameValue(prev, next)) continue;
			if (next === null) delete e.props[d.prop];
			else e.props[d.prop] = next;
			changes.push({ cell: "prop", entity: d.entity, prop: d.prop, prev, next });
		}
		return { changes };
	}
}
