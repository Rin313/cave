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

/** 规则产生的世界腔文本（答复与陈述），进结果视图供叙述跟随。 */
export type Text = string;

/** 字面类型：边值的值域；边值是字面载荷，端点已是引用。 */
export type LitType = "string" | "number" | "boolean";

/** 值域与解释的一根轴：字面标量，或以实体 id 为值的指称（值位指称只注册在属性上）。 */
export type SlotType = LitType | "ref";

/**
 * 属性声明：值域 × 重数 × 呈现。label 即呈现名，缺席即内部变量（键不进模型面）。
 * ref 是强引用：值即实体 id，须在世、渲染为脸。
 */
export interface PropDef {
	type: SlotType;
	/** 重数：缺省 one（标量），true 为非空序列 many(Seq)。 */
	many?: true;
	/** 呈现名；缺席即内部变量。 */
	label?: string;
}

/**
 * 边类型注册：值域契约 × 呈现。注册可选，未注册即开口 token（值按字面、无契约、无静态隐藏）。
 * present 三态：缺席即 token（类型的公开身份），"hidden" 即静态遮蔽，{ label } 即改名。
 */
export interface RelDef {
	type: LitType;
	/** 重数：缺省 one（标量），true 为非空序列 many(Seq)。 */
	many?: true;
	present?: "hidden" | { label: string };
}

/** 世界腔否决（法则的具名否决）：玩家可见，reply 缺席即回落 noResponse；引擎违约走抛出 → crash(rule)。 */
export type Deny = { law: string; reply?: Text };

/** 裁决点：一次尝试的最终发言者。rule 的 law 是作者理由 token（必填），只被呈现与探针消费。 */
export type Point =
	| { kind: "rule"; law: string }
	| { kind: "gate"; law: "action.invisible" }
	| { kind: "closure" }
	| { kind: "invariant"; id: string; fault: "world" | "engine" }
	| { kind: "engine"; check: "integrity" | "commit" | "grant" }
	| { kind: "crash"; site: "rule" | "invariant" };

/** 受众：裁决点的全函数；唯一由作者选择的是 invariant 的 fault。 */
export function audienceOf(point: Point): "world" | "engine" {
	switch (point.kind) {
		case "rule": case "gate": case "closure": return "world";
		case "invariant": return point.fault;
		case "engine": case "crash": return "engine";
	}
}

/** 作者 invariant 结果的输入形态：受众与文本；落到记录时受众进点、文本单存。 */
export type Reason =
	| { fault: "world"; reply?: Text }
	| { fault: "engine"; debug: string };

/** 折叠后的否决：判定、门、闭合、审查、自检、崩溃共用同一记录形状；engine 受众必携文本。 */
export interface Denial {
	point: Point;
	text?: Text;
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

/**
 * world 为深冻结裁决读态，越权写即抛；一切后果经返回值表达。P 为参数的编译期形状（defineVerb 从 params 声明派生）。
 * 两个调用点不相交（意志动词唯一调用者是 will，常驻规则唯一调用者是泵），故判定输入不含 origin：调用点由声明决定，不是规则读得到的变量。
 */
export interface Q<P = Record<string, Value>> {
	readonly world: World;
	readonly player: string;
	readonly params: P;
	/** 确定性骰子；key 以出处路径限定，不同出处的同名 key 不共享结果。 */
	roll(key: string, sides: number): number;
}

/** 授予：deltas 是变更序列，reply 是答复句（每步至多一条；无提案者的步上入账时前插进 statements），statements 是授予许可的 0..n 条世界腔陈述，ticks 覆写价。法则的否决恒 world 受众；作者的引擎违约走抛出。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; reply?: Text; statements?: Text[]; ticks?: number }
	| { ok: false; denial: Deny };

export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

export function grant(deltas: Delta[], opts: { reply?: Text; statements?: Text[]; ticks?: number } = {}): Verdict {
	return {
		ok: true,
		deltas,
		...(opts.reply !== undefined && { reply: opts.reply }),
		...(opts.statements !== undefined && { statements: opts.statements }),
		...(opts.ticks !== undefined && { ticks: opts.ticks }),
	};
}

export function deny(law: string, reply?: Text): Verdict {
	return { ok: false, denial: { law, ...(reply !== undefined && { reply }) } };
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
		const step = steps[s]!;
		const changes = step.ok ? step.changes : [];
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

/** 指称参数：值是实体 id，过指称门。 */
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
	rules: { id: string; judge: (q: Q<ParamsOf<P>>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		params: spec.params,
		cost: spec.cost,
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q as Q<ParamsOf<P>>) })),
	};
}

/** 意志动词：唯一调用点是 will（玩家经动词面）。 */
export interface VerbDef {
	label: string;
	description: string;
	params: Record<string, ParamSpec>;
	cost: number;
	rules: Rule[];
}

/** 常驻规则：唯一调用点是泵（每刻一次，空参）。不进动词面、无参数、无价、无呈现名；id 只进账本与骰子地址。 */
export interface TickDef {
	id: string;
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

/** 内核形态检查（动词表全集） */
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
	/** 边类型注册表（可选）：注册即获值域契约与呈现（hidden/token/改名）；未注册即开口 token（字面、以 token 示人）。 */
	relTypes?: Record<string, RelDef>;
	/** 常驻规则表（可选）：每刻按声明序由泵以空参调用，后一条看得见前一条的后果。 */
	ticks?: TickDef[];
	/**
	 * 脸：所见域上的命名，缺省 id。只被呈现消费，不产生指称（指称恒为 id）；所见域内须返回非空串，否则回落 id。
	 * 改名不是格：一步内 token 变化即派生出 `~ 旧 → 新`。
	 */
	face?: (world: World, player: string) => (e: Entity) => string;
	/** 近况窗口的回合记录数。 */
	recentWindow: number;
	/**
	 * 披露谓词：顶点格成员即卡，属性/边格的谓词值即变更行每一侧的判据（缺席格与在场格同过一门）。
	 * 缺省常真（全见），声明即整体替换（无格级缺省回退）；命名在注册表，两轴互不代替。
	 * 指称门与卡白名单读同一个所见集：可指名者必在所见集，所见者必可指名——对结构化面的定义与闭合。
	 */
	perceives?: (world: World, player: string) => (cell: Addr) => boolean;
	/** 状态视图的派生纹理：读世界真相，非指称通道（不产生指称，不改变所见域）。 */
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

/** 检查相读态：world 是提交后读态，before 是提交前读态（回滚锚），changes 是本次提交的全部变更；proposal 携本次尝试。 */
export interface CheckCtx {
	def: GameDef;
	player: string;
	proposal: Proposal;
	before: World;
	changes: readonly Change[];
}

/** 检查相的作者否决点：null 通过，理由即整提交回滚并拒绝。收冻结读态，写入即抛。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: CheckCtx) => Reason | null;
}

function isScalarValue(v: unknown): v is Scalar {
	return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** 类型挡不住 as 通道（存档恢复、场景 JSON、probe），存储形状运行时复核；空序列不是值（表示无只用缺席）。 */
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

/** 存储层 integrity：引擎自检，恒 engine 受众。 */
function integrityProblems(def: GameDef, world: World): string | null {
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
	if (!ids.has(def.playerId)) return `integrity: playerId -> missing entity ${def.playerId}`;
	const registry = Object.entries(def.props);
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
		const rd = def.relTypes?.[r.type];
		if (rd) {
			const many = rd.many === true;
			if (Array.isArray(r.value) !== many) return `integrity: relation ${r.type} expects ${many ? "a sequence" : "a scalar"}, got ${got(r.value)}`;
			for (const x of Array.isArray(r.value) ? r.value : [r.value]) {
				if (typeof x !== rd.type) return `integrity: relation ${r.type} expects ${rd.type}, got ${got(x)}`;
			}
		}
	}
	return null;
}

function hasLabel(def: GameDef, prop: string): boolean {
	return def.props[prop]?.label !== undefined;
}

/** 实体卡：id 是指称身份（ref 参数用它），name 是脸 token（只阅读）。 */
export interface Card {
	id: string;
	name: string;
	props: Record<string, Value>;
}

/** 属性的呈现名；加载期保证一切可渲染属性携非空 label。 */
function propLabelOf(def: GameDef, prop: string): string {
	const label = def.props[prop]?.label;
	if (label === undefined) throw new Error(`属性「${prop}」无模型面名字：key 不进模型面`);
	return label;
}

/** 一个提交边界上的呈现前提：脸表＋格披露谓词。由世界即时求值，不入账。 */
export interface FieldView {
	faces: Map<string, string>;
	discloses: (cell: Addr) => boolean;
}

/** 所见域的求值结果：所见谓词于顶点格的成员集。 */
export type SightView = Set<string>;

/** 无碰撞元组编码：成分字符集不受约束。 */
function tupleKey(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

/** 入账来源：will（玩家经动词面）、clock（泵逐刻）。 */
export type Origin = "will" | "clock";

/** 提案者：审查上下文用；rule 携授予法则与本次尝试的 origin/action，admit 是以零变更审查整世界（装载终点）。 */
export type Proposal =
	| { kind: "rule"; rule: string; origin: Origin; action: Action }
	| { kind: "admit" };

/** 入账表态的机器身份：账本位置 (at, origin, id, 序位)——id 即动词或常驻规则。对入账表态单射、且由账本前缀复原：随机是账本位置的纯函数。 */
function attemptAddr(at: number, origin: Origin, verb: string, ordinal: number): string {
	return tupleKey(["attempt", String(at), origin, verb, String(ordinal)]);
}

/** 裁决点的呈现身份（场景断言与探针用）；分类看 kind，不看字符串。 */
export function lawOf(point: Point): string {
	switch (point.kind) {
		case "rule": return point.law;
		case "gate": return point.law;
		case "closure": return "action.unanswered";
		case "invariant": return `invariant.${point.id}`;
		case "engine": return `engine.${point.check}`;
		case "crash": return `${point.site}.crash`;
	}
}

/** 步一律携公共载荷 action（clock 步的 verb 即常驻规则 id，params 恒空）。价 = origin=clock ? 0 : ok ? (granted ?? cost) : cost。授予记授予法则；否决记裁决点与受众，曾被授予而拦回者记提案法则。 */
export type Commit =
	| { at: number; origin: Origin; action: Action; price: number; ok: true; rule: string; changes: Change[]; reply?: Text; statements?: Text[] }
	| { at: number; origin: Origin; action: Action; price: number; ok: false; denial: Denial; proposedBy?: string };

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

/** 玩家侧文本：world 给文本（缺省 noResponse），engine 恒 noResponse。 */
export function renderDenial(def: GameDef, denial: Denial): string {
	return audienceOf(denial.point) === "world" ? (denial.text ?? def.messages.noResponse) : def.messages.noResponse;
}

/** 原始文本（含引擎 debug）：装载拒绝等非呈现用途。 */
export function denialReasonText(def: GameDef, denial: Denial): string {
	return audienceOf(denial.point) === "world" ? (denial.text ?? def.messages.noResponse) : (denial.text ?? "");
}

/** 脸 token：id 在某个提交边界上的呈现词。脸表由该边界的世界即时求值，行文不回读活世界。 */
type Face = (id: string) => string;

function faceOf(faces: ReadonlyMap<string, string>): Face {
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

/** 边类型的呈现名：registered named 取 label，其余即 token 原样；hidden 由 hiddenRel 先行遮蔽。 */
function relName(def: Pick<GameDef, "relTypes">, type: string): string {
	const present = def.relTypes?.[type]?.present;
	return present !== undefined && present !== "hidden" ? present.label : type;
}

/** 静态隐藏的注册边类型；开口 token 无隐藏能力（注册即取得）。 */
function hiddenRel(def: Pick<GameDef, "relTypes">, type: string): boolean {
	return def.relTypes?.[type]?.present === "hidden";
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
	if (c.cell === "edge") return `${face(c.from)}.${relName(sim.def, c.type)}.${face(c.to)}: ${val(c.prev, sides.prev, false)} → ${val(c.next, sides.next, false)}`;
	const name = face(c.entity);
	const label = propLabelOf(sim.def, c.prop);
	return `${name}.${label}: ${val(c.prev, sides.prev, isRefProp(sim.def, c.prop))} → ${val(c.next, sides.next, isRefProp(sim.def, c.prop))}`;
}

/** 可呈现的变更行：无呈现名的属性与静态隐藏边零泄漏。 */
function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	return changes.filter((c) => !(c.cell === "prop" && !hasLabel(def, c.prop)) && !(c.cell === "edge" && hiddenRel(def, c.type)));
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
 * 事件流的规范单行渲染（✓/✗/⏱/×n）。各行是否呈现由世界即时判据，言默不随消费面改变（刻账目闭合）。
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
	/** 一步的渲染器：脸表、披露谓词与改名行都由该步的提交边界即时求值，行文不回读活世界。 */
	const renderer = (i: number): { face: Face; renames: string[]; changeLine: (c: Change) => string | null } => {
		const before = befores[i]!;
		const after = afters[i]!;
		before.time = steps[i]!.at;
		after.time = steps[i]!.at;
		const b = sim.fieldView(before);
		const a = sim.fieldView(after);
		const faces = new Map<string, string>([...b.faces, ...a.faces]);
		const face = faceOf(faces);
		const field = new Set(faces.keys());
		// 改名是投影：一步内 token 变化且两端皆在所见域（才有名可换），不为源属性的无 label 所滤
		const renames: string[] = [];
		for (const [id, name] of a.faces) {
			const prev = b.faces.get(id);
			if (prev !== undefined && prev !== name) renames.push(`~ ${prev} → ${name}`);
		}
		// 每一侧都由该边界对变更格的披露谓词判：缺席格与在场格同过一门
		const sidesOf = (c: Change): { prev: boolean; next: boolean } => {
			const cell: Addr = c.cell === "vertex" ? { cell: "vertex", id: c.next === null ? c.prev.id : c.next.id } : c;
			return { prev: b.discloses(cell), next: a.discloses(cell) };
		};
		const changeLine = (c: Change): string | null => {
			const sides = sidesOf(c);
			if (!sides.prev && !sides.next) return null;
			if (!referentsOf(sim, c, face, sides).every((r) => field.has(r))) return null;
			return fmtChange(sim, c, face, sides);
		};
		return { face, renames, changeLine };
	};
	const msgs = sim.def.messages;
	const lines: string[] = [];
	const said = new Map<number, { changes: string[]; reply: Text[]; statements: Text[]; denials: string[] }>();
	let granted = 0;
	const flush = (): void => {
		for (const { changes, reply, statements, denials } of said.values()) {
			const spoken = [...reply, ...statements];
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
		const { face, renames, changeLine } = renderer(i);
		const changes = s.ok ? [...renames, ...narratableChanges(sim.def, s.changes).map(changeLine).filter((x): x is string => x !== null)] : [];
		if (s.origin !== "clock") {
			flush();
			granted = s.price;
			const reply = s.ok ? s.reply : renderDenial(sim.def, s.denial);
			const statements = s.ok ? (s.statements ?? []) : [];
			const tail = [
				changes.length ? `(${changes.join("; ")})` : "",
				statements.length ? `[${statements.join("; ")}]` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, face)}${reply !== undefined ? `：${reply}` : ""}${tail}`);
		} else {
			const held = said.get(s.at) ?? { changes: [], reply: [], statements: [], denials: [] };
			if (s.ok) {
				held.changes.push(...changes);
				if (s.reply !== undefined) held.reply.push(s.reply);
				if (s.statements?.length) held.statements.push(...s.statements);
			} else {
				held.denials.push(renderDenial(sim.def, s.denial));
			}
			if (held.changes.length || held.reply.length || held.statements.length || held.denials.length) said.set(s.at, held);
		}
	}
	flush();
	return lines;
}

export function relVal(world: World, from: string, to: string, type: string): Value | null {
	return world.relations.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 门内裁决的表态；授予记法则，否决自带裁决点。 */
type RawResult =
	| { ok: true; deltas: Delta[]; rule: string; reply?: Text; statements?: Text[]; ticks?: number }
	| { ok: false; denial: Denial };

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 常驻规则：id → 规则链；每刻按声明序由泵调用。 */
	private readonly ticks: Map<string, readonly Rule[]>;
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
		}
		const ticks = new Map<string, readonly Rule[]>();
		for (const t of def.ticks ?? []) {
			if (typeof t.id !== "string" || t.id === "") throw new Error("常驻规则 id 须为非空字符串");
			if (ticks.has(t.id)) throw new Error(`常驻规则 id 重复：${t.id}`);
			const ruleIds = new Set<string>();
			for (const r of t.rules) {
				if (ruleIds.has(r.id)) throw new Error(`常驻规则 ${t.id} 的规则 id 重复：${r.id}`);
				ruleIds.add(r.id);
			}
			ticks.set(t.id, t.rules);
		}
		// props 必填；呈现名（label）只在位置内要求唯一
		const propNames = new Map<string, string>();
		for (const [k, pd] of Object.entries(def.props)) {
			if (pd.type !== "string" && pd.type !== "number" && pd.type !== "boolean" && pd.type !== "ref") throw new Error(`属性「${k}」的类型须为 string/number/boolean/ref，得到 ${String(pd.type)}`);
			if (pd.many !== undefined && pd.many !== true) throw new Error(`属性「${k}」的 many 只能为 true（缺省即 one），得到 ${String(pd.many)}`);
			if (pd.label !== undefined) {
				if (pd.label === "") throw new Error(`属性「${k}」的 label 须非空：键不进模型面`);
				const prev = propNames.get(pd.label);
				if (prev !== undefined) throw new Error(`属性呈现名重复：「${pd.label}」为「${prev}」与「${k}」共有`);
				propNames.set(pd.label, k);
			}
		}
		// 边类型呈现名：注册集内有效名（hidden 即无名）两两相异；开口 token 不在注册表，无法在 def 期穷举
		const relNames = new Map<string, string>();
		for (const [t, rd] of Object.entries(def.relTypes ?? {})) {
			if (rd.type !== "string" && rd.type !== "number" && rd.type !== "boolean") throw new Error(`边类型「${t}」的值类型须为 string/number/boolean（边值是字面），得到 ${String(rd.type)}`);
			if (rd.many !== undefined && rd.many !== true) throw new Error(`边类型「${t}」的 many 只能为 true（缺省即 one），得到 ${String(rd.many)}`);
			const claim = (name: string): void => {
				const prev = relNames.get(name);
				if (prev !== undefined) throw new Error(`边类型呈现名重复：「${name}」为「${prev}」与「${t}」共有`);
				relNames.set(name, t);
			};
			const present = rd.present;
			if (present === undefined) {
				claim(t);
			} else if (present !== "hidden") {
				const label = present !== null && typeof present === "object" ? (present as { label?: unknown }).label : undefined;
				if (typeof label !== "string" || label === "") throw new Error(`边类型「${t}」的 present 须为 "hidden" 或 { label: 非空字串 }，得到 ${JSON.stringify(present)}`);
				claim(label);
			}
		}
		this.ticks = ticks;
		// 结构校验恒挂；作者不变式走 admit（装载终点判当下世界，历史不重审），开局世界在此另判一次以尽早显形 def 错误
		const broken = integrityProblems(this.def, this.readState());
		if (broken) throw new Error(`初始世界破坏完整性：${broken}`);
		if (world === undefined) {
			const denied = this.admit();
			if (denied) throw new Error(`初始世界违反 ${lawOf(denied.point)}：${denialReasonText(this.def, denied)}`);
		}
	}

	get player(): string {
		return this.def.playerId;
	}

	/** 所见域（呈现能显什么，也是意志能点名什么）：卡的存在域。门只读它，不触脸——裁决不得经呈现钩子。 */
	sights(world: World = this.readState()): SightView {
		const within = this.perceives(world);
		return new Set(world.entities.filter((e) => within({ cell: "vertex", id: e.id })).map((e) => e.id));
	}

	/** 所见谓词：缺省全见；声明即接管全部格。 */
	private perceives(world: World): (cell: Addr) => boolean {
		return this.def.perceives?.(world, this.player) ?? (() => true);
	}

	/** 所见域＋脸表的同一次求值：卡集合即谓词于顶点格的成员；脸在所见域上全（非空串，否则回落 id）。 */
	private boundaryView(world: World): { within: (cell: Addr) => boolean; seen: SightView; faces: Map<string, string> } {
		const within = this.perceives(world);
		const token = this.def.face?.(world, this.player) ?? ((e: Entity) => e.id);
		const seen: SightView = new Set();
		const faces = new Map<string, string>();
		for (const e of world.entities) {
			if (!within({ cell: "vertex", id: e.id })) continue;
			seen.add(e.id);
			const name = token(e);
			faces.set(e.id, typeof name === "string" && name !== "" ? name : e.id);
		}
		return { within, seen, faces };
	}

	/** 一个提交边界上的呈现前提：脸表＋格披露谓词（缺省全见）；投影时由世界即时求值。 */
	fieldView(world: World): FieldView {
		const { within, faces } = this.boundaryView(world);
		return { faces, discloses: within };
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

	/** 常驻规则的规则链；泵只按声明表调用，未注册即内核缺陷。 */
	private tickRules(id: string): readonly Rule[] {
		const rules = this.ticks.get(id);
		if (!rules) throw new Error(`常驻规则 ${id} 未注册`);
		return rules;
	}

	private adjudicateRaw(action: Action, rules: readonly Rule[], refParams: readonly string[], gate: Set<string>, world: World, addr: string, clock: boolean): RawResult {
		const invalid = refParams
			.flatMap((p) => {
				const v = action.params[p];
				return (Array.isArray(v) ? v : [v]).filter((id): id is string => typeof id === "string" && !gate.has(id));
			});
		if (invalid.length) {
			const invisible = this.def.messages.invisibleEntity;
			return { ok: false, denial: { point: { kind: "gate", law: "action.invisible" }, ...(invisible !== undefined && { text: invisible }) } };
		}
		for (const r of rules) {
			const q = this.query(world, action.params, addr);
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, denial: { point: { kind: "crash", site: "rule" }, text: `rule:${r.id}: ${e instanceof Error ? e.message : String(e)}` } };
			}
			if (!v) continue;
			if (v.ok) {
				if (clock && v.ticks !== undefined) {
					return { ok: false, denial: { point: { kind: "engine", check: "grant" }, text: `rule:${r.id}: 常驻规则不得延伸时间` } };
				}
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, denial: { point: { kind: "engine", check: "grant" }, text: `rule:${r.id}: ticks 须为非负整数刻数，得到 ${String(v.ticks)}` } };
				}
				return { ok: true, deltas: v.deltas, rule: r.id, ...(v.reply !== undefined && { reply: v.reply }), ...(v.statements !== undefined && { statements: v.statements }), ...(v.ticks !== undefined && { ticks: v.ticks }) };
			}
			return { ok: false, denial: { point: { kind: "rule", law: v.denial.law }, ...(v.denial.reply !== undefined && { text: v.denial.reply }) } };
		}
		return { ok: false, denial: { point: { kind: "closure" } } };
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
	private commitChecked(s0: World, deltas: Delta[], rule: string, origin: Origin, action: Action): { ok: true; changes: Change[] } | { ok: false; denial: Denial } {
		try {
			const out = this.commit(deltas);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, denial: { point: { kind: "engine", check: "commit" }, text: out.refusal } };
			}
			const inv = this.checkInvariants({ kind: "rule", rule, origin, action }, s0, out.changes);
			if (inv) {
				this.restore(s0);
				return { ok: false, denial: inv };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, denial: { point: { kind: "crash", site: "invariant" }, text: debug } };
		}
	}

	/** 装载终点的零变更审查：当前世界 × 当下法则。 */
	admit(): Denial | null {
		return this.checkInvariants({ kind: "admit" }, this.readState(), []);
	}

	/** 审查：先 integrity 后游戏不变式；world 是提交后读态，before 是提交前读态（回滚锚），changes 是本次提交的全部变更。 */
	private checkInvariants(proposal: Proposal, before: World, changes: Change[]): Denial | null {
		const world = this.readState();
		const ctx: CheckCtx = { def: this.def, player: this.player, proposal, before, changes: deepFreeze(changes) };
		const broken = integrityProblems(this.def, world);
		if (broken) return { point: { kind: "engine", check: "integrity" }, text: broken };
		for (const inv of this.def.invariants ?? []) {
			const reason = inv.check(world, ctx);
			if (reason) return {
				point: { kind: "invariant", id: inv.id, fault: reason.fault },
				...(reason.fault === "world" ? (reason.reply !== undefined && { text: reason.reply }) : { text: reason.debug }),
			};
		}
		return null;
	}

	/** 历史原子性：异常逃逸 ⇒ 世界恢复调用前原状再抛。attempt 入界即冻结（Q.params 与步记录同一对象），Resolution 出界即冻结（记录是证据而非视图）。 */
	apply(action: Action): Resolution {
		deepFreeze(action);
		const s0 = this.readState();
		try {
			const res = this.applyInner(action, s0);
			// 序位随账目一同提交：apply 失败（钩子/投影崩溃）时世界回滚，未入账的尝试不得移动地址
			this.markAttempt(res.step.at, res.step.origin, res.step.action.verb);
			for (const c of res.elapsed) this.markAttempt(c.at, c.origin, c.action.verb);
			return deepFreeze(res);
		} catch (e) {
			this.restore(s0);
			throw e;
		}
	}

	private applyInner(action: Action, s0: World): Resolution {
		const step = this.attempt(s0, action, "will");
		return { step, elapsed: this.pump(step.price) };
	}

	private attempt(s0: World, action: Action, origin: Origin): Commit {
		deepFreeze(action);
		const at = s0.time;
		const clock = origin === "clock";
		let rules: readonly Rule[];
		let refParams: readonly string[];
		let price: number;
		if (clock) {
			rules = this.tickRules(action.verb);
			refParams = [];
			price = 0;
		} else {
			const verb = this.staticForm(action);
			rules = verb.rules;
			refParams = refParamsOf(verb);
			price = verb.cost;
		}
		const addr = attemptAddr(at, origin, action.verb, this.peekAttempt(at, origin, action.verb));
		const gate = this.sights(s0);
		const r = this.adjudicateRaw(action, rules, refParams, gate, s0, addr, clock);
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.rule, origin, action);
			if (!cc.ok)
				return { at, origin, action, price, ok: false, denial: cc.denial, proposedBy: r.rule };
			// 答复只属于有提案者的步：clock 授予的 reply 入账前插进 statements，记录层不出现无提案者的答复
			const reply = clock ? undefined : r.reply;
			const statements = clock && r.reply !== undefined ? [r.reply, ...(r.statements ?? [])] : r.statements;
			return { at, origin, action, price: clock ? 0 : (r.ticks ?? price), ok: true, rule: r.rule, changes: cc.changes, ...(reply !== undefined && { reply }), ...(statements !== undefined && { statements }) };
		}
		return { at, origin, action, price, ok: false, denial: r.denial };
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
			for (const id of this.ticks.keys()) {
				const c = this.attempt(this.readState(), { verb: id, params: {} }, "clock");
				if (!c.ok ? c.denial.point.kind !== "closure" : c.changes.length > 0 || c.reply !== undefined || !!c.statements?.length) out.push(c);
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

	/** 钟算术全段：首步为 will；后一 will 步 at = 前一 will 步 at + 前一 price；其间 clock 步 price 恒 0、at 落在 (前一 will 步 at, 前一 will 步 at + 前一 price] 内非降。 */
	private clockSpanProblem(record: ChronicleEntry): string | null {
		const steps = record.steps;
		if (steps.length === 0) return null;
		const first = steps[0]!;
		if (first.origin === "clock") return "首步为时钟步";
		if (!Number.isInteger(first.at) || !Number.isInteger(first.price) || first.price < 0) return `首步坐标/价格非整数（at ${String(first.at)}，price ${String(first.price)}）`;
		let base = first.at;
		let limit = base + first.price;
		for (let i = 1; i < steps.length; i++) {
			const s = steps[i]!;
			if (s.origin === "clock") {
				if (s.price !== 0) return `时钟步 price ${String(s.price)} ≠ 0`;
				if (!Number.isInteger(s.at)) return `时钟步 at 非整数（${String(s.at)}）`;
				if (s.at <= base || s.at > limit) return `时钟步 at ${s.at} 出界 (${base}, ${limit}]`;
				if (s.at < steps[i - 1]!.at) return `时钟步 at ${s.at} 逆序`;
				continue;
			}
			if (!Number.isInteger(s.price) || s.price < 0) return `will 步 price 非负整数（${String(s.price)}）`;
			if (s.at !== limit) return `will 步 at ${s.at} ≠ ${limit}`;
			base = s.at;
			limit = base + s.price;
		}
		return null;
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
			const span = this.clockSpanProblem(record);
			if (span) return fail(span);
			for (const step of record.steps) {
				this.markAttempt(step.at, step.origin, step.action.verb);
				if (!step.ok) continue;
				for (const c of step.changes) {
					const broken = this.verifyChange(c);
					if (broken) return fail(broken);
					const out = this.commit([deltaOf(c)]);
					if ("refusal" in out) return fail(`重放提交被拒：${out.refusal}`);
				}
			}
			this.world.time = record.time;
			const broken = integrityProblems(this.def, this.readState());
			if (broken) return fail(broken);
			return null;
		} catch (e) {
			return fail(errorText(e));
		}
	}

	/** 逐变更 prev 校验：记录前值须与重放世界相符；被 despawn 连带删除的边可已不在（后态已成立即通过）。 */
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
		const { within, seen, faces } = this.boundaryView(w);
		const entities = w.entities.filter((e) => seen.has(e.id)).map((e) => this.cardOf(e, seen, within, faces.get(e.id)!));
		const relations = w.relations
			.filter((r) => !hiddenRel(this.def, r.type) && seen.has(r.from) && seen.has(r.to) && within({ cell: "edge", from: r.from, to: r.to, type: r.type }))
			.map((r) => ({ from: r.from, to: r.to, type: relName(this.def, r.type), value: r.value }));
		const out: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) out.extra = extra;
		return JSON.stringify(out);
	}

	/** 卡：脸 token 与属性按所见谓词遮蔽，值位指称须在所见域。 */
	private cardOf(e: Entity, seen: SightView, within: (cell: Addr) => boolean, name: string): Card {
		const props: Record<string, Value> = {};
		for (const [k, v] of Object.entries(e.props)) {
			if (!hasLabel(this.def, k)) continue;
			if (!within({ cell: "prop", entity: e.id, prop: k })) continue;
			if (!refsWithin(this.def, k, v, seen)) continue;
			props[propLabelOf(this.def, k)] = v;
		}
		return { id: e.id, name, props };
	}

	/** 所见域内实体的卡；不在所见域即 null（不产生非所见卡）。 */
	card(world: World, id: string): Card | null {
		const { within, seen, faces } = this.boundaryView(world);
		const e = entity(world, id);
		return e !== undefined && seen.has(id) ? this.cardOf(e, seen, within, faces.get(id)!) : null;
	}

	/** 逐条校验而非预检；幂等跳过的唯一判据是目标状态已成立。 */
	private commit(deltas: Delta[]): { changes: Change[] } | { refusal: string } {
		const changes: Change[] = [];
		const upsertRel = (from: string, to: string, type: string, value: Value) => {
			const hit = this.world.relations.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else this.world.relations.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: string } => ({ refusal: `commit: ${debug}` });
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
