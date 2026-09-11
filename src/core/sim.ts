import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { clone, deepFreeze, errorText, roll as rollDice } from "./util.ts";

export type Scalar = string | number | boolean;

/** 存储值：标量或其有限序列；缺席由键不在表达，故无 none。 */
export type Value = Scalar | Scalar[];

/** 格写载荷：none（null）即删除。 */
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

/** 账本格：顶点（存在）／属性／边（关系）——写与记录的共同坐标。 */
export type VertexAddr = { cell: "vertex"; id: string };
export type PropAddr = { cell: "prop"; entity: string; prop: string };
export type EdgeAddr = { cell: "edge"; from: string; to: string; type: string };
export type SlotAddr = PropAddr | EdgeAddr;
export type Addr = VertexAddr | SlotAddr;

/** δ：绝对写，后态自含。顶点格的身份即实体 id，故 spawn 的格取自 next、despawn 的格取自 id；属性格与边格的后态是值或 none（写/删）。 */
export type Delta =
	| { cell: "vertex"; next: Entity }
	| { cell: "vertex"; id: string; next: null }
	| (SlotAddr & { next: Payload });

/** 𝒞：记录是补全前态的 δ。顶点记录恰一侧为 ⊥（生/灭，不另存 id）；属性/边记录前后态相异。 */
export type Change =
	| { cell: "vertex"; prev: null; next: Entity }
	| { cell: "vertex"; prev: Entity; next: null }
	| (SlotAddr & { prev: Payload; next: Payload });

export interface Action {
	verb: string;
	params: Record<string, Value>;
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
 * 格声明（属性与边类型共用）：类型 × 重数 × 呈现。type 定值域与解释，many 声明重数；
 * 呈现名 = hidden ? ⊥ : (label ?? fallback)——属性 fallback 缺席（键是内部标识），边 fallback 是 token（类型的公开身份）。
 * 属性可 ref（值即实体 id）；边值是字面（端点已是引用）。
 * 身份键在 GameDef.identity（结构上全域至多一），其属性恒为无 label、未 hidden 的非 many string。
 */
export interface PropDef {
	type: SlotType;
	/** 重数：缺省 one（标量），true 为非空序列 many(Seq)。 */
	many?: true;
	/** 呈现名；属性缺席即键不上模型面，边缺席即以 token 示人。 */
	label?: string;
	/** 静态隐藏：true 即不进任何呈现面（属性可无 label 隐藏；边以此为静态隐藏的唯一途径）。 */
	hidden?: true;
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
export interface Q<P = Record<string, Value>> {
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
	spawn: (entity: Entity): Delta => ({ cell: "vertex", next: entity }),
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
		case "vertex": return c.prev === null ? { cell: "vertex", next: c.next } : { cell: "vertex", id: c.prev.id, next: null };
		case "prop": return { cell: "prop", entity: c.entity, prop: c.prop, next: c.next };
		case "edge": return { cell: "edge", from: c.from, to: c.to, type: c.type, next: c.next };
	}
}

/**
 * 账本逆推：把某记录之后的世界就地回退到该记录之前——逐变更取 prev。
 * 逆序处理同址多写；顶点与边均不级联（边变更已在记录中显式列出）。
 */
export function rewind(world: World, steps: readonly Commit[]): void {
	for (let s = steps.length - 1; s >= 0; s--) {
		const changes = steps[s]!.changes;
		for (let i = changes.length - 1; i >= 0; i--) {
			const c = changes[i]!;
			if (c.cell === "vertex") {
				// 生的逆是删 next，灭的逆是恢复 prev；身份由实体自身携带
				if (c.next === null) {
					const at = world.entities.findIndex((e) => e.id === c.prev.id);
					if (at >= 0) world.entities[at] = clone(c.prev);
					else world.entities.push(clone(c.prev));
				} else {
					const at = world.entities.findIndex((e) => e.id === c.next.id);
					if (at >= 0) world.entities.splice(at, 1);
				}
				continue;
			}
			if (c.cell === "prop") {
				const e = world.entities.find((x) => x.id === c.entity);
				if (!e) continue;
				if (c.prev === null) delete e.props[c.prop];
				else e.props[c.prop] = c.prev;
				continue;
			}
			const at = world.relations.findIndex((r) => r.from === c.from && r.to === c.to && r.type === c.type);
			if (c.prev === null) {
				if (at >= 0) world.relations.splice(at, 1);
			} else if (at >= 0) {
				world.relations[at]!.value = c.prev;
			} else {
				world.relations.push({ from: c.from, to: c.to, type: c.type, value: c.prev });
			}
		}
	}
}

/** 动词参数的声明面：类型 × 可选 × 重数 × 描述。 */
export interface ParamSpec {
	type: SlotType;
	optional?: true;
	/** 重数：缺省 one（标量），true 为非空序列。 */
	many?: true;
	description?: string;
}

type BaseOf<T extends SlotType> = T extends "number" ? number : T extends "boolean" ? boolean : string;
type ValueOfParam<S extends ParamSpec> = S extends { many: true } ? BaseOf<S["type"]>[] : BaseOf<S["type"]>;

/** 规则参数的编译期类型，由 params 声明推导；重数与世界值对称（多重性不是批次）。 */
export type ParamsOf<P extends Record<string, ParamSpec>> = {
	[K in keyof P as P[K] extends { optional: true } ? never : K]: ValueOfParam<P[K]>;
} & {
	[K in keyof P as P[K] extends { optional: true } ? K : never]?: ValueOfParam<P[K]>;
};

/** 指称参数：值是实体 id，过所指门。 */
export function ref(description?: string): { type: "ref"; description?: string } {
	return { type: "ref", ...(description !== undefined && { description }) };
}

/** 自由字符串：值按字面进入裁决。 */
export function free(description?: string): { type: "string"; description?: string } {
	return { type: "string", ...(description !== undefined && { description }) };
}

/** 多重指称参数：非空实体 id 序列，逐项过门。 */
export function manyRef(description?: string): { type: "ref"; many: true; description?: string } {
	return { type: "ref", many: true, ...(description !== undefined && { description }) };
}

/** 多重自由字符串参数。 */
export function manyFree(description?: string): { type: "string"; many: true; description?: string } {
	return { type: "string", many: true, ...(description !== undefined && { description }) };
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

/** 类型匹配：ref 的运行时表示是 id 字符串；many 为非空序列。 */
function matchesScalar(type: SlotType, v: unknown): boolean {
	switch (type) {
		case "string": case "ref": return typeof v === "string";
		case "number": return typeof v === "number";
		case "boolean": return typeof v === "boolean";
	}
}

function matchesParam(spec: ParamSpec, v: unknown): boolean {
	if (spec.many === true) return Array.isArray(v) && v.length > 0 && v.every((x) => matchesScalar(spec.type, x));
	return matchesScalar(spec.type, v);
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
		if (!matchesParam(s, v)) out.push(`params.${name}: must be ${s.many === true ? `a non-empty ${s.type} sequence` : s.type}${desc(s)}`);
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
	/** 边类型注册表（可选）：注册即获值域契约、改名与静态隐藏能力；未注册即开口 token（字面、以 token 示人）。 */
	relTypes?: Record<string, PropDef>;
	/** 身份键：props 里的一个 string 属性，结构上全域至多一；其值提升为实体名，渲染取 `~` 形。 */
	identity?: string;
	/** 近况窗口的回合记录数。 */
	recentWindow: number;
	/**
	 * 感知：意志能点名、呈现能显什么，按格求值——所见谓词是全定义（顶点格成员即卡）。
	 * 指称门与卡白名单读同一个所见集，不存在第二条命名轴：可指名者必在所见集，所见者必可指名。
	 * 缺省全见；声明即接管全部格（未列格即 false），边/属性截面随之存在。钥匙是格：
	 * 顶点格成员即卡，属性/边格的键截面即披露前提；缺席属性亦按格求值（枚举注册表键）。
	 */
	perceives?: (world: World, player: string) => (cell: Addr) => boolean;
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

/** 检查相读态：world 是提交后读态，before 是提交前读态（回滚锚），changes 是本次提交的全部变更。 */
export interface CheckCtx {
	def: GameDef;
	player: string;
	source: Source;
	before: World;
	changes: readonly Change[];
}

/** 世界腔违反理由；engine 侧违反附 debug。检查相的唯一出口。 */
export interface Reason {
	voice?: string;
	debug?: string;
}

/** 检查相的作者否决点：null 通过，理由即整提交回滚并拒绝。收冻结读态，写入即抛。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: CheckCtx) => Reason | null;
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
		const bad = (debug: string): Reason => ({ debug });
		if (!Array.isArray(world.entities)) return bad("integrity: world.entities must be an array");
			if (!Array.isArray(world.relations)) return bad("integrity: world.relations must be an array");
			for (const k of Object.keys(world)) {
				if (k !== "time" && k !== "entities" && k !== "relations") return bad(`integrity: world.${k} is not part of the ledger shape`);
			}
			const ids = new Set<string>();
			for (const e of world.entities) {
				if (e === null || typeof e !== "object" || Array.isArray(e)) return bad("integrity: entity must be a record");
				ids.add(e.id);
			}
			if (ids.size !== world.entities.length) return bad("integrity: duplicate entity ids");
			if (!Number.isInteger(world.time) || world.time < 0) return bad("integrity: world.time must be a non-negative integer");
			if (!ids.has(ctx.def.playerId)) return bad(`integrity: playerId -> missing entity ${ctx.def.playerId}`);
			const registry = Object.entries(ctx.def.props);
			const vocabulary = new Set(registry.map(([k]) => k));
			for (const e of world.entities) {
				if (typeof e.id !== "string" || e.id === "") return bad("integrity: entity id must be non-empty string");
				for (const k of Object.keys(e)) {
					if (k !== "id" && k !== "props") return bad(`integrity: ${e.id}.${k} is not part of the entity shape`);
				}
				if (e.props === null || typeof e.props !== "object" || Array.isArray(e.props)) return bad(`integrity: ${e.id}.props must be a record`);
				for (const k of Object.keys(e.props)) {
					if (!vocabulary.has(k)) return bad(`integrity: ${e.id}.${k} is not declared in the prop registry`);
				}
				for (const [p, pd] of registry) {
					const v = e.props[p];
					if (v === undefined) continue;
					if (!isValue(v)) return bad(`integrity: ${e.id}.${p} is not a value (non-null scalar or non-empty scalar array; absence is a missing key)`);
					const many = pd.many === true;
					if (Array.isArray(v) !== many) return bad(`integrity: ${e.id}.${p} expects ${many ? "a sequence" : "a scalar"}, got ${got(v)}`);
					if (p === ctx.def.identity && v === "") return bad(`integrity: ${e.id}.${p} must be non-empty string (empty designation is absence; omit the key)`);
					for (const x of Array.isArray(v) ? v : [v]) {
						if (pd.type === "ref") {
							if (typeof x !== "string") return bad(`integrity: ${e.id}.${p} expects id reference, got ${got(x)}`);
							if (!ids.has(x)) return bad(`integrity: ${e.id}.${p} -> missing entity ${x}`);
							continue;
						}
						if (typeof x !== pd.type) return bad(`integrity: ${e.id}.${p} expects ${pd.type}, got ${got(x)}`);
					}
				}
			}
			const edgeIds = new Set<string>();
			for (const r of world.relations ?? []) {
				if (r === null || typeof r !== "object" || Array.isArray(r)) return bad("integrity: relation must be a record");
				for (const k of Object.keys(r)) {
					if (k !== "from" && k !== "to" && k !== "type" && k !== "value") return bad(`integrity: relation.${k} is not part of the relation shape`);
				}
				if (typeof r.from !== "string" || r.from === "") return bad("integrity: relation.from must be non-empty string");
				if (typeof r.to !== "string" || r.to === "") return bad("integrity: relation.to must be non-empty string");
				if (typeof r.type !== "string" || r.type === "") return bad("integrity: relation.type must be non-empty string");
				if (!ids.has(r.from) || !ids.has(r.to)) return bad(`integrity: relation ${r.type} -> missing endpoint`);
				const eid = addrKey({ cell: "edge", from: r.from, to: r.to, type: r.type });
				if (edgeIds.has(eid)) return bad(`integrity: duplicate relation ${r.from}->${r.to} (${r.type})`);
				edgeIds.add(eid);
				if (r.value === null || !isValue(r.value)) return bad(`integrity: relation ${r.type} -> value is not a value (non-null, non-empty; stored edges never hold null)`);
				const rd = ctx.def.relTypes?.[r.type];
				if (rd) {
					const many = rd.many === true;
					if (Array.isArray(r.value) !== many) return bad(`integrity: relation ${r.type} expects ${many ? "a sequence" : "a scalar"}, got ${got(r.value)}`);
					for (const x of Array.isArray(r.value) ? r.value : [r.value]) {
						if (typeof x !== rd.type) return bad(`integrity: relation ${r.type} expects ${rd.type}, got ${got(x)}`);
					}
				}
			}
			return null;
	},
};

/** 呈现名缺席的属性：显式 hidden，或无 label 且非身份（键是内部标识，不是名字）。 */
function hiddenProp(def: GameDef, prop: string): boolean {
	const pd = def.props[prop];
	return pd !== undefined && (pd.hidden === true || (pd.label === undefined && prop !== def.identity));
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
		if (hiddenProp(def, k) || !hasLabel(def, k)) continue;
		if (perceiveProp && !perceiveProp(e, k)) continue;
		if (!refsWithin(def, k, v, vis)) continue;
		props[propLabelOf(def, k)] = v;
	}
	return { id: e.id, ...(name !== undefined && { name }), props };
}

/** 属性的呈现名；加载期保证一切可渲染属性携非空 label。 */
function propLabelOf(def: GameDef, prop: string): string {
	const label = def.props[prop]?.label;
	if (label === undefined) throw new Error(`属性「${prop}」无模型面名字：key 不进模型面`);
	return label;
}

/** 一个提交边界上的呈现前提：脸表＋键截面（仅 perceives 声明时存在）。由世界即时求值，不入账。 */
export interface FieldView {
	faces: Map<string, string | null>;
	edgeKeys?: Set<string>;
	propKeys?: Set<string>;
}

/** 所见域的求值结果：所见谓词于顶点格的成员集。 */
export type SightView = Set<string>;

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

/** 入账表态的机器身份：账本位置 (at, origin, verb, 序位)。对入账表态单射、且由账本前缀复原——随机是账本位置的纯函数。 */
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
	| { at: number; source: Decision; origin: Origin; action: Action; price: number; ok: true; changes: Change[]; voice?: Fact; facts?: Fact[] }
	| { at: number; source: Decision; origin: Origin; action: Action; price: number; ok: false; changes: []; denial: Denial };

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

/** 脸 token：id 在某个提交边界上的呈现词。脸表由该边界的世界即时求值，行文不回读活世界。 */
type Face = (id: string) => string;

function faceOf(faces: ReadonlyMap<string, string | null>): Face {
	return (id) => faces.get(id) ?? id;
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

/** 边类型的呈现名：注册取 label，未注册即开口 token 原样；hidden 由 hiddenRel 先行遮蔽。 */
function relName(def: Pick<GameDef, "relTypes">, type: string): string {
	return def.relTypes?.[type]?.label ?? type;
}

/** 静态隐藏的注册边类型；开口 token 无隐藏能力（注册即取得）。 */
function hiddenRel(def: Pick<GameDef, "relTypes">, type: string): boolean {
	return def.relTypes?.[type]?.hidden === true;
}

/** 值位指称与边端点同过所见域：目标不在所见域则整属性遮蔽——披露的指称必有卡。 */
function refsWithin(def: Pick<GameDef, "props">, prop: string, v: Value, vis: ReadonlySet<string>): boolean {
	if (!isRefProp(def, prop)) return true;
	for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string" && !vis.has(item)) return false;
	return true;
}

function fmtChange(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string {
	const val = (v: Payload, ok: boolean, isRef: boolean): string => (ok ? renderValue(face, v, isRef).text : "?");
	if (c.cell === "vertex") return `${c.next === null ? "-" : "+"} ${face(c.next === null ? c.prev.id : c.next.id)}`;
	if (c.cell === "edge") {
		// 空侧（创生/消散）随行广播、豁免截面；? 只占位有值未读
		const readable = (v: Payload, side: boolean): boolean => v === null || side;
		return `${face(c.from)}.${relName(sim.def, c.type)}.${face(c.to)}: ${val(c.prev, readable(c.prev, sides.prev), false)} → ${val(c.next, readable(c.next, sides.next), false)}`;
	}
	if (sim.identityKey !== undefined && c.prop === sim.identityKey) return `~ ${val(c.prev, sides.prev, false)} → ${val(c.next, sides.next, false)}`;
	const name = face(c.entity);
	const label = propLabelOf(sim.def, c.prop);
	return `${name}.${label}: ${val(c.prev, sides.prev, isRefProp(sim.def, c.prop))} → ${val(c.next, sides.next, isRefProp(sim.def, c.prop))}`;
}

/** 呈现面的变更行：隐藏属性与隐藏边零泄漏。 */
function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	return changes.filter((c) => !(c.cell === "prop" && hiddenProp(def, c.prop)) && !(c.cell === "edge" && hiddenRel(def, c.type)));
}

/** 与渲染消费同一解析：指称集对渲染封闭——凡行铸出的同一性皆指称（prop 行主语在内），未披露侧不数。 */
function referentsOf(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string[] {
	if (c.cell === "vertex") return [c.next === null ? c.prev.id : c.next.id];
	if (c.cell === "edge") return [c.from, c.to];
	const ref = isRefProp(sim.def, c.prop);
	const out: string[] = [c.entity];
	if (sides.prev) out.push(...renderValue(face, c.prev, ref).ids);
	if (sides.next) out.push(...renderValue(face, c.next, ref).ids);
	return out;
}
/**
 * 事件流的规范单行渲染（✓/✗/⏱/×n）。可说性由世界即时判据，言默不随消费面改变（刻账目闭合）。
 * worldAfter 是 steps 之后的世界，据此逆推每步的提交边界；t 不入变更，渲染前归位。
 */
export function spineLines(sim: Simulation, steps: readonly Commit[], worldAfter: World): string[] {
	const n = steps.length;
	if (n === 0) return [];
	const befores: World[] = new Array(n);
	const afters: World[] = new Array(n);
	{
		let w = clone(worldAfter);
		for (let i = n - 1; i >= 0; i--) {
			afters[i] = w;
			w = clone(w);
			rewind(w, [steps[i]!]);
			befores[i] = w;
		}
	}
	/** 一步的渲染器：脸表与截面由该步的提交边界即时求值，行文不回读活世界。 */
	const renderer = (i: number): { face: Face; changeLine: (c: Change) => string | null } => {
		const before = befores[i]!;
		const after = afters[i]!;
		before.time = steps[i]!.at;
		after.time = steps[i]!.at;
		const b = sim.fieldView(before);
		const a = sim.fieldView(after);
		const faces = new Map<string, string | null>([...b.faces, ...a.faces]);
		const face = faceOf(faces);
		const field = new Set(faces.keys());
		const edgeSides = b.edgeKeys && a.edgeKeys ? { before: b.edgeKeys, after: a.edgeKeys } : undefined;
		const propSides = b.propKeys && a.propKeys ? { before: b.propKeys, after: a.propKeys } : undefined;
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
	for (let i = 0; i < n; i++) {
		const s = steps[i]!;
		if (s.origin !== "clock") {
			flush();
			granted = s.price;
			// 代码直连步不入事件流：不产尝试行，后果由状态视图与新见段承接
			if (s.origin === "code") continue;
			const { face, changeLine } = renderer(i);
			const changes = narratableChanges(sim.def, s.changes).map(changeLine).filter((x): x is string => x !== null);
			const voice = s.ok ? s.voice : renderDenial(sim.def, s.denial);
			const facts = s.ok ? (s.facts ?? []) : [];
			const tail = [
				changes.length ? `(${changes.join("; ")})` : "",
				facts.length ? `[${facts.join("; ")}]` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, face)}${voice !== undefined ? `：${voice}` : ""}${tail}`);
		} else {
			const { changeLine } = renderer(i);
			const held = said.get(s.at) ?? { changes: [], voice: [], facts: [], denials: [] };
			if (s.ok) {
				held.changes.push(...narratableChanges(sim.def, s.changes).map(changeLine).filter((x): x is string => x !== null));
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
	/** 入账表态的序位来源：同 (at, origin, verb) 的已入账表态数——账本位置的函数，默不入账也不消耗序位。 */
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
		// props 必填；呈现名只在位置内要求唯一，且按有效名（hidden 即无名）计算
		const propNames = new Map<string, string>();
		for (const [k, pd] of Object.entries(def.props)) {
			if (pd.type !== "string" && pd.type !== "number" && pd.type !== "boolean" && pd.type !== "ref") throw new Error(`属性「${k}」的类型须为 string/number/boolean/ref，得到 ${String(pd.type)}`);
			if (pd.many !== undefined && pd.many !== true) throw new Error(`属性「${k}」的 many 只能为 true（缺省即 one），得到 ${String(pd.many)}`);
			if (pd.hidden !== undefined && pd.hidden !== true) throw new Error(`属性「${k}」的 hidden 只能为 true（缺省即呈现），得到 ${String(pd.hidden)}`);
			if (pd.label !== undefined) {
				if (pd.label === "") throw new Error(`属性「${k}」的 label 须非空：键不进模型面`);
				if (pd.hidden !== true) {
					const prev = propNames.get(pd.label);
					if (prev !== undefined) throw new Error(`属性呈现名重复：「${pd.label}」为「${prev}」与「${k}」共有`);
					propNames.set(pd.label, k);
				}
			}
		}
		const identityKey = def.identity;
		if (identityKey !== undefined) {
			const pd = def.props[identityKey];
			if (!pd) throw new Error(`identity「${identityKey}」未在 props 注册`);
			if (pd.type !== "string" || pd.many === true || pd.label !== undefined || pd.hidden === true) throw new Error(`identity「${identityKey}」须为无 label、未 hidden 的非 many string 属性`);
		}
		// 边类型呈现名：注册集内有效名（hidden 即无名）两两相异；开口 token 不在注册表，无法在 def 期穷举
		const relNames = new Map<string, string>();
		for (const [t, rd] of Object.entries(def.relTypes ?? {})) {
			if (rd.type !== "string" && rd.type !== "number" && rd.type !== "boolean") throw new Error(`边类型「${t}」的值类型须为 string/number/boolean（边值是字面），得到 ${String(rd.type)}`);
			if (rd.many !== undefined && rd.many !== true) throw new Error(`边类型「${t}」的 many 只能为 true（缺省即 one），得到 ${String(rd.many)}`);
			if (rd.hidden !== undefined && rd.hidden !== true) throw new Error(`边类型「${t}」的 hidden 只能为 true（缺省即以 token 示人），得到 ${String(rd.hidden)}`);
			if (rd.label === "") throw new Error(`边类型「${t}」的 label 须非空：空词不是名字`);
			if (rd.hidden !== true) {
				const name = rd.label ?? t;
				const prev = relNames.get(name);
				if (prev !== undefined) throw new Error(`边类型呈现名重复：「${name}」为「${prev}」与「${t}」共有`);
				relNames.set(name, t);
			}
		}
		this.identityKey = identityKey;
		// 初始世界过审查：def 结构错误与损坏存档在此显形
		const before = this.readState();
		const broken = this.checkInvariants({ kind: "init" }, before, []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.denial.voice ?? broken.denial.debug}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	/** 所见域（呈现能显什么，也是意志能点名什么）：卡的存在域。 */
	sights(world: World = this.readState()): SightView {
		return this.sightView(world);
	}

	/** 所见谓词：缺省全见；声明即接管全部格。 */
	private perceives(world: World): (cell: Addr) => boolean {
		return this.def.perceives?.(world, this.player) ?? (() => true);
	}

	/** 所见域与格谓词的同一次求值：卡集合即谓词于顶点格的成员。 */
	sightView(world: World): SightView {
		const within = this.perceives(world);
		return new Set(world.entities.filter((e) => within({ cell: "vertex", id: e.id })).map((e) => e.id));
	}

	/** 边界脸表：所见域内实体 × 身份披露。由世界即时求值，不持久化。 */
	private faceList(world: World): Map<string, string | null> {
		const key = this.identityKey;
		const within = this.perceives(world);
		const out = new Map<string, string | null>();
		for (const e of world.entities) {
			if (!within({ cell: "vertex", id: e.id })) continue;
			const readable = key !== undefined && within({ cell: "prop", entity: e.id, prop: key });
			out.set(e.id, readable ? (designation(this.def, e) ?? null) : null);
		}
		return out;
	}

	/** 边键截面：边格谓词于键空间求值，端点闭合另行把门（见 changeLine）。 */
	private edgeField(world: World, within: (cell: Addr) => boolean): string[] {
		const out: string[] = [];
		for (const r of world.relations) if (within({ cell: "edge", from: r.from, to: r.to, type: r.type })) out.push(addrKey({ cell: "edge", from: r.from, to: r.to, type: r.type }));
		return out;
	}

	/** 属性键截面：枚举注册表键而非在场键，属性格谓词对全集求值——缺席属性可感，在场由闭合另行把门。 */
	private propField(world: World, within: (cell: Addr) => boolean): string[] {
		const keys = Object.keys(this.def.props);
		const out: string[] = [];
		for (const e of world.entities) {
			for (const k of keys) if (within({ cell: "prop", entity: e.id, prop: k })) out.push(addrKey({ cell: "prop", entity: e.id, prop: k }));
		}
		return out;
	}

	/** 一个提交边界上的呈现前提：脸表＋键截面（仅 perceives 声明时）；投影时由世界即时求值。 */
	fieldView(world: World): FieldView {
		const faces = this.faceList(world);
		if (!this.def.perceives) return { faces };
		const within = this.perceives(world);
		return { faces, edgeKeys: new Set(this.edgeField(world, within)), propKeys: new Set(this.propField(world, within)) };
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
			.flatMap((p) => {
				const v = action.params[p];
				return (Array.isArray(v) ? v : [v]).filter((id): id is string => typeof id === "string" && !gate.has(id));
			});
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
	private query(world: World, params: Record<string, Value>, addr: string): Q {
		return {
			world,
			player: this.player,
			params,
			roll: (key, sides) => rollDice(addr, key, sides),
		};
	}

	/** 克隆覆写：冻结引用不得留在活账本上。回滚恒回封装单元（提交或 apply）起点，不越过已入账坐标。 */
	private restore(s0: World): void {
		Object.assign(this.world, JSON.parse(JSON.stringify(s0)) as World);
	}

	/** 先执行校验后不变式；审查过程的意外异常同通道兑为审查否决。 */
	private commitChecked(s0: World, deltas: Delta[], source: Decision): { ok: true; changes: Change[] } | { ok: false; denial: Denial } {
		try {
			const out = this.commit(deltas);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, denial: out.refusal };
			}
			const inv = this.checkInvariants(source, s0, out.changes);
			if (inv) {
				this.restore(s0);
				return { ok: false, denial: inv.denial };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, denial: { law: "invariant.crash", fault: "engine", debug } };
		}
	}

	/** 审查：先 integrity 后游戏不变式；world 是提交后读态，before 是提交前读态（回滚锚），changes 是本次提交的全部变更。 */
	private checkInvariants(source: Source, before: World, changes: Change[]): { id: string; denial: Denial } | null {
		const world = this.readState();
		const ctx: CheckCtx = { def: this.def, player: this.player, source, before, changes: deepFreeze(changes) };
		const broken = integrityInvariant.check(world, ctx);
		if (broken) return { id: "integrity", denial: { law: "invariant.integrity", fault: "engine", ...broken } };
		for (const inv of this.def.invariants ?? []) {
			const reason = inv.check(world, ctx);
			if (reason) return { id: inv.id, denial: reason.debug !== undefined ? { law: `invariant.${inv.id}`, fault: "engine", ...reason } : { law: `invariant.${inv.id}`, fault: "world", ...reason } };
		}
		return null;
	}

	/** 历史原子性：异常逃逸 ⇒ 世界恢复调用前原状再抛。attempt 入界即冻结（Q.params 与步记录同一对象），Resolution 出界即冻结（记录是证据而非视图）。 */
	apply(action: Action, origin: Exclude<Origin, "clock"> = "will"): Resolution {
		deepFreeze(action);
		const s0 = this.readState();
		try {
			const res = this.applyInner(action, s0, origin);
			// 序位随账目一同提交：apply 失败（钩子/投影崩溃）时世界回滚，未入账的尝试不得移动地址
			this.markAttempt(res.step.at, res.step.origin, res.step.action.verb);
			for (const c of res.elapsed) this.markAttempt(c.at, c.origin, c.action.verb);
			return deepFreeze(res);
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
		const addr = attemptAddr(at, origin, action.verb, this.peekAttempt(at, origin, action.verb));
		const clock = origin === "clock";
		const gate = this.sightView(s0);
		const r = this.adjudicateRaw(action, verb, gate, s0, addr, origin);
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.source);
			if (!cc.ok)
				return { at, source: r.source, origin, action, price: clock ? 0 : verb.cost, ok: false, changes: [], denial: cc.denial };
			return { at, source: r.source, origin, action, price: clock ? 0 : (r.ticks ?? verb.cost), ok: true, changes: cc.changes, ...(r.voice !== undefined && { voice: r.voice }), ...(r.facts !== undefined && { facts: r.facts }) };
		}
		return { at, source: r.source, origin, action, price: clock ? 0 : verb.cost, ok: false, changes: [], denial: r.denial };
	}

	/** 取序位不消耗；仅当步确定入账才 markAttempt——默与崩溃不移动任何地址。 */
	private peekAttempt(at: number, origin: Origin, verb: string): number {
		if (at !== this.attemptAt) {
			this.attemptAt = at;
			this.attemptSeq.clear();
		}
		return this.attemptSeq.get(`${origin}\u0000${verb}`) ?? 0;
	}

	private markAttempt(at: number, origin: Origin, verb: string): void {
		this.attemptSeq.set(`${origin}\u0000${verb}`, this.peekAttempt(at, origin, verb) + 1);
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
				if (!refs.has(k)) return renderValue(face, v, false).text;
				const items = Array.isArray(v) ? v : [v];
				return items.map((item) => (typeof item === "string" ? face(item) : String(item))).join(", ");
			});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	/** 检查点已含其后果的回合仍须按账本复原点数：世界的重放可以跳过，序位的演进不可以（否则续掷与连续会话分叉）。 */
	seedAttempts(record: ChronicleEntry): void {
		for (const step of record.steps) this.markAttempt(step.at, step.origin, step.action.verb);
	}

	/** 重放一条回合记录：𝒞 反推 δ 过门内执行段（不重裁决、不掷骰），逐变更 prev 校验，终态 integrity；authored 不变式不重审——历史由当时的法则裁判过。链断回滚并返回原因。 */
	replayRecord(record: ChronicleEntry): string | null {
		const s0 = this.readState();
		const seqAt = this.attemptAt;
		const seqMark = new Map(this.attemptSeq);
		const fail = (reason: string): string => {
			this.restore(s0);
			// 未入账记录的序位随世界一并回滚：地址只由存活账本前缀决定
			this.attemptAt = seqAt;
			this.attemptSeq.clear();
			for (const [key, n] of seqMark) this.attemptSeq.set(key, n);
			return `seq${record.seq} ${reason}`;
		};
		try {
			const start = record.steps.length ? record.steps[0]!.at : record.time;
			if (!Number.isInteger(start) || start !== this.world.time) return fail(`起点钟 ${String(start)} 不接续当前钟 ${this.world.time}`);
			const grants = record.steps.reduce((n, s) => n + s.price, 0);
			if (!Number.isInteger(record.time) || record.time !== start + grants) return fail(`末钟 ${String(record.time)} ≠ 起点 ${start} + 刻账 ${grants}`);
			for (const step of record.steps) {
				this.markAttempt(step.at, step.origin, step.action.verb);
				for (const c of step.changes) {
					const broken = this.verifyChange(c);
					if (broken) return fail(broken);
					const out = this.commit([deltaOf(c)]);
					if ("refusal" in out) return fail(`重放提交被拒：${out.refusal.debug}`);
				}
			}
			this.world.time = record.time;
			const ctx: CheckCtx = { def: this.def, player: this.player, source: { kind: "replay", seq: record.seq }, before: s0, changes: [] };
			const broken = integrityInvariant.check(this.readState(), ctx);
			if (broken) return fail(`${broken.debug}`);
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
					const gone = entity(this.world, c.prev.id);
					if (!gone) return `despawn "${c.prev.id}" 不在世`;
					return sameEntity(gone, c.prev) ? null : `despawn "${c.prev.id}" 离场态不符`;
				}
				return entity(this.world, c.next.id) ? `spawn "${c.next.id}" 已在世` : null;
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

	/** 状态视图：卡的集合即所见域（门与卡白名单同源）。 */
	digest(): string {
		const w = this.readState();
		const seen = this.sightView(w);
		const within = this.perceives(w);
		const entities = w.entities.filter((e) => seen.has(e.id)).map((e) => this.cardOf(e, seen, w));
		const relations = w.relations
			.filter((r) => !hiddenRel(this.def, r.type) && seen.has(r.from) && seen.has(r.to) && within({ cell: "edge", from: r.from, to: r.to, type: r.type }))
			.map((r) => ({ from: r.from, to: r.to, type: relName(this.def, r.type), value: r.value }));
		const out: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) out.extra = extra;
		return JSON.stringify(out);
	}

	/** 卡：身份与属性按所见谓词遮蔽，值位指称须在所见域（谓词于给定读态求值）。 */
	cardOf(e: Entity, seen: SightView, world: World): { id: string; name?: string; props: Record<string, Value> } {
		const within = this.perceives(world);
		return viewCard(this.def, e, seen, (x, prop) => within({ cell: "prop", entity: x.id, prop }));
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
					changes.push({ cell: "vertex", prev: JSON.parse(JSON.stringify(gone)) as Entity, next: null });
					for (const r of dissolved) changes.push({ cell: "edge", from: r.from, to: r.to, type: r.type, prev: r.value, next: null });
				} else {
					if (entity(this.world, d.next.id)) return refuse(`spawn "${d.next.id}": entity already exists`);
					const ent: Entity = { id: d.next.id, props: d.next.props };
					if (!Object.values(ent.props).every(isValue)) return refuse(`spawn "${d.next.id}": props contain a non-value (non-null non-empty scalar or scalar array; absence is a missing key)`);
					changes.push({ cell: "vertex", prev: null, next: JSON.parse(JSON.stringify(ent)) as Entity });
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
