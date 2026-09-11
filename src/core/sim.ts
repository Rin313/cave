import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v as T);
	}
	return value;
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export type Scalar = string | number | boolean;

/** 存储值：标量或其有限序列；缺席由键不在表达，故无 none。 */
export type Value = Scalar | Scalar[];

/** 格写载荷：none（null）即删除。 */
export type Payload = Value | null;

export type ViewValue = string | number | boolean | null | ViewValue[] | { [k: string]: ViewValue };

/** 状态视图的规范序列化：digest() 与 prompt kit 共用同一出口。 */
export function digestOf(view: ViewValue): string {
	return JSON.stringify(view);
}

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

/** δ：绝对写，后态自含；顶点格的 id 取自 next（生）或自身（灭）。 */
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
	/** 引擎文本缺省：除 gate（invisibleEntity）外一切场合回落到此；debug 只入 probe 与构造/装载诊断。 */
	noResponse: string;
	/** 指称门否决的缺省文案（say 的 base）；动词 invisible 更具体，优先。 */
	invisibleEntity?: string;
	/** 静默刻聚合文案（⏱ ×n，n = |{at : 言@at = ∅}|）。 */
	timePassed: string;
}

/** 世界腔文本：答复与陈述。 */
export type Text = string;

/** 字面类型：边值的值域；边值是字面载荷，端点已是引用。 */
export type LitType = "string" | "number" | "boolean";

/** 值域与解释的一根轴：字面标量，或以实体 id 为值的指称。 */
export type SlotType = LitType | "ref";

/** 值声明：值域 × 重数；属性的值、边载荷与动词参数共用这根轴。 */
interface ValueDecl {
	type: SlotType;
	/** 重数：缺省 one（标量），true 为非空序列。 */
	many?: true;
}

/** 注册槽：值声明 + 呈现名；ref 另携生命周期。 */
interface SlotCommon extends ValueDecl {
	/** 呈现名；缺席或 null 即该表缺省（属性无名、边 τ），非空串即该名。 */
	label?: string | null;
}

/** 注册槽：字面值域无生命周期；ref 的 strong 必填——true 强（悬空由 integrity 拒绝），false 弱（随目标删除级联移除引用，值空即删格）。 */
export type SlotDef =
	| (SlotCommon & { type: LitType })
	| (SlotCommon & { type: "ref"; strong: boolean });

/** 裁决点。rule 的 law 只被呈现与探针消费；gate/closure 无载荷，呈现身份由 lawOf 产生。 */
export type Point =
	| { kind: "rule"; law: string }
	| { kind: "gate" }
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

/** invariant 结果：受众与文本；落到记录时受众进点、文本单存。 */
export type Reason =
	| { fault: "world"; reply?: Text }
	| { fault: "engine"; debug: string };

/** 否决的公共记录形状；engine 受众必携文本。 */
export interface Denial {
	point: Point;
	text?: Text;
}

/** 作者否决：Denial 在 rule 点上的特化；text 即答复（缺省 noResponse）。引擎违约走抛出。 */
export type RuleDenial = { point: Extract<Point, { kind: "rule" }>; text?: Text };

/** 引擎合成读者侧文本的场合：记录点的 (point, verb) 与两种边界情形。 */
export type Speech =
	| { kind: "point"; point: Point; verb: string }
	| { kind: "noProposal" }
	| { kind: "interrupted"; phase: "adjudicate" | "project" };

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

/** world 深冻结，越权写即抛；P 是 params 声明派生的编译期形状。判定输入不含 origin。 */
export interface Q<P = Record<string, Value>> {
	readonly world: World;
	readonly player: string;
	readonly params: P;
	/** 确定性骰子；key 以出处路径限定，不同出处的同名 key 不共享结果。 */
	roll(key: string, sides: number): number;
}

/** 裁决结果；price 覆写缺省 cost（授予与否决同轴）；授予的可选 law 缺省即守卫 id，只被呈现与探针消费。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; law?: Text; reply?: Text; statements?: Text[]; price?: number }
	| { ok: false; denial: RuleDenial; price?: number };

export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

export function grant(deltas: Delta[], opts: { law?: Text; reply?: Text; statements?: Text[]; price?: number } = {}): Verdict {
	return {
		ok: true,
		deltas,
		...(opts.law !== undefined && { law: opts.law }),
		...(opts.reply !== undefined && { reply: opts.reply }),
		...(opts.statements !== undefined && { statements: opts.statements }),
		...(opts.price !== undefined && { price: opts.price }),
	};
}

export function deny(law: string, text?: Text, price?: number): Verdict {
	return { ok: false, denial: { point: { kind: "rule", law }, ...(text !== undefined && { text }) }, ...(price !== undefined && { price }) };
}

export const D = {
	set: (entity: string, prop: string, value: Payload): Delta => ({ cell: "prop", entity, prop, next: value }),
	relSet: (from: string, to: string, type: string, value: Payload): Delta => ({ cell: "edge", from, to, type, next: value }),
	spawn: (entity: Entity): Delta => ({ cell: "vertex", next: entity }),
	despawn: (entity: string): Delta => ({ cell: "vertex", id: entity, next: null }),
};

/** 𝒞 反推 δ：绝对写、后态自含。 */
function deltaOf(c: Change): Delta {
	switch (c.cell) {
		case "vertex": return c.prev === null ? { cell: "vertex", next: c.next } : { cell: "vertex", id: c.prev.id, next: null };
		case "prop": return { cell: "prop", entity: c.entity, prop: c.prop, next: c.next };
		case "edge": return { cell: "edge", from: c.from, to: c.to, type: c.type, next: c.next };
	}
}

/** 就地回退：逐变更取 prev；逆序处理同址多写；顶点与边均不级联（边变更已显式列出）。 */
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

/** 动词参数：值声明 + 可选 × 描述。 */
export interface ParamSpec extends ValueDecl {
	optional?: true;
	description?: string;
}

type BaseOf<T extends SlotType> = T extends "number" ? number : T extends "boolean" ? boolean : string;
type ValueOfParam<S extends ParamSpec> = S extends { many: true } ? BaseOf<S["type"]>[] : BaseOf<S["type"]>;

/** 参数声明的可选面：重数 × 可选 × 描述；type 只能由 param 的第一参数给出。 */
type ParamOpts = Omit<ParamSpec, "type">;

/** params 声明派生的编译期类型。 */
export type ParamsOf<P extends Record<string, ParamSpec>> = {
	[K in keyof P as P[K] extends { optional: true } ? never : K]: ValueOfParam<P[K]>;
} & {
	[K in keyof P as P[K] extends { optional: true } ? K : never]?: ValueOfParam<P[K]>;
};

/** 参数声明：类型 × 重数 × 可选 × 描述；ref 值过指称门，many 即非空序列。 */
export function param<T extends SlotType, O extends ParamOpts = object>(
	type: T,
	opts?: O & Record<Exclude<keyof O, keyof ParamOpts>, never>,
): { type: T } & O {
	return Object.assign({ type }, opts ?? ({} as O), { type });
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
	invisible?: string;
	rules: { id: string; judge: (q: Q<ParamsOf<P>>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		params: spec.params,
		cost: spec.cost,
		...(spec.invisible !== undefined && { invisible: spec.invisible }),
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q as Q<ParamsOf<P>>) })),
	};
}

/** 规则链：动词与常驻规则同构的规则序列；两者身份都是 (origin, id)，链内 id 唯一，校验共用。 */
export type RuleChain = Rule[];

/** 意志动词：唯一调用点是 will（玩家经动词面）。 */
export interface VerbDef {
	label: string;
	description: string;
	params: Record<string, ParamSpec>;
	cost: number;
	/** 门否决文案（词表缺省，位于 say 的 base 之下，不进入记录）：无指称参数时不可能被消费；缺省回落 messages.invisibleEntity。 */
	invisible?: string;
	rules: RuleChain;
}

/** 常驻规则：唯一调用点是泵（每刻一次，空参）。不进动词面、无参数、无价、无呈现名；id 只进账本与骰子地址。 */
export interface TickDef {
	id: string;
	rules: RuleChain;
}

/** 面向 AI 的动词派生面：广告与接口模式自此同源，不再各自手写。 */
export interface VerbFace {
	id: string;
	label: string;
	description: string;
	cost: number;
	params: readonly ParamFace[];
}

export interface ParamFace {
	name: string;
	type: SlotType;
	/** ref 值即实体 id，过一次指称门。 */
	ref: boolean;
	many: boolean;
	optional: boolean;
	description?: string;
}

/** 由动词表构造式派生广告面，无对既有图的变换。 */
export function verbFace(verbs: Readonly<Record<string, VerbDef>>): readonly VerbFace[] {
	return Object.entries(verbs).map(([id, v]) => ({
		id,
		label: v.label,
		description: v.description,
		cost: v.cost,
		params: Object.entries(v.params).map(([name, s]) => ({
			name,
			type: s.type,
			ref: s.type === "ref",
			many: s.many === true,
			optional: s.optional === true,
			...(s.description !== undefined && { description: s.description }),
		})),
	}));
}

/** 缺省广告排版：id、label、description、cost 与逐参数（类型、重数、可选、过门注记）。 */
export function catalog(verbs: Readonly<Record<string, VerbDef>>): string {
	const rows: string[] = [];
	for (const v of verbFace(verbs)) {
		rows.push(`${v.id} "${v.label}" — ${v.description} [cost ${v.cost}]`);
		for (const p of v.params) {
			const notes = [p.ref ? "ref (id of a visible or known entity)" : p.type];
			if (p.many) notes.push("non-empty list");
			if (p.optional) notes.push("optional");
			rows.push(`  ${p.name}: ${notes.join(", ")}${p.description !== undefined ? ` — ${p.description}` : ""}`);
		}
	}
	return rows.join("\n");
}

/** 值声明的形状谓词：ref 的运行时表示是 id 字符串，Num 须有限；与世界值同形。返回问题描述（不含位置前缀）。 */
function valueProblem(type: SlotType, many: boolean, v: unknown): string | null {
	if (Array.isArray(v) !== many) return `expects ${many ? "a non-empty sequence" : "a scalar"}, got ${got(v)}`;
	if (many && (v as unknown[]).length === 0) return "expects a non-empty sequence, got an empty sequence";
	for (const x of Array.isArray(v) ? v : [v]) {
		if (type === "ref") {
			if (typeof x !== "string") return `expects id reference, got ${got(x)}`;
			continue;
		}
		if (typeof x !== type) return `expects ${type}, got ${got(x)}`;
		if (type === "number" && !Number.isFinite(x)) return `expects a finite number, got ${got(x)}`;
	}
	return null;
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
		const problem = valueProblem(s.type, s.many === true, v);
		if (problem) out.push(`params.${name}: ${problem}${desc(s)}`);
	}
	return out;
}

/** 判定数据面：verdict 中会进记录的字段（作者可影响的部分）——违约由 engine(grant) 承接。 */
function verdictProblems(v: Verdict, clock: boolean): string[] {
	const out: string[] = [];
	if (v.price !== undefined) {
		if (clock) out.push("常驻规则不得延伸时间");
		else if (!Number.isInteger(v.price) || v.price < 0) out.push(`price 须为非负整数刻数，得到 ${String(v.price)}`);
	}
	if (v.ok) {
		if (v.law !== undefined && typeof v.law !== "string") out.push("law 须为字符串");
		if (!Array.isArray(v.deltas)) out.push("deltas 须为序列");
		if (v.reply !== undefined && (typeof v.reply !== "string" || v.reply === "")) out.push("reply 须为非空字符串");
		if (v.statements !== undefined && (!Array.isArray(v.statements) || !v.statements.every((s) => typeof s === "string" && s !== ""))) out.push("statements 须为非空字符串序列");
		return out;
	}
	const denial = v.denial as { point?: { law?: unknown }; text?: unknown } | undefined;
	if (!denial || typeof denial !== "object") return [...out, "否决须携 denial"];
	if (typeof denial.point?.law !== "string" || denial.point.law === "") out.push("否决的 law 须为非空字符串");
	if (denial.text !== undefined && (typeof denial.text !== "string" || denial.text === "")) out.push("否决的 text 须为非空字符串");
	return out;
}

/** 近况内一条回合的呈现切片 */
export interface RecentEntry {
	time: number;
	utterance: string;
	moves: string[];
}

/** 近况的公共数据面：context 钩子与两种回合提示共用。 */
export interface PromptKit {
	/** 近况 */
	recent: RecentEntry[];
}

/** 状态视图的两种消费形态：本体与规范序列化由同一次求值产生，本体按只读约定消费。 */
export interface ViewKit {
	view: ViewValue;
	/** view 的规范序列化（digestOf(view)）：字节直用与默认排版的出口。 */
	digest: string;
}

/** 意志回合提示数据：状态视图 + 话语 + 近况。 */
export interface TurnKit extends PromptKit, ViewKit {
	/** 玩家话语（verbatim） */
	utterance: string;
}

/** 渲染调用提示数据：状态视图 + 事件骨架 + 指令 + 近况。 */
export interface NarrateKit extends PromptKit, ViewKit {
	/** 事件骨架行 */
	events: string[];
	/** 渲染指令 */
	instruction: string;
}

/** 近况缺省排版：回合坐标、话语与事件行；无事件即显式标记，沉默可读。 */
function recentBlock(recent: readonly RecentEntry[]): string {
	if (recent.length === 0) return "";
	const lines = ["[Recent turns, oldest last]"];
	for (const r of recent) {
		lines.push(`- t${r.time} ${r.utterance}`);
		if (r.moves.length === 0) lines.push("  no visible events");
		else for (const move of r.moves) lines.push(`  ${move}`);
	}
	return lines.join("\n");
}

/** turn 缺省：只有数据通道；表达纪律与回合协议归 prompt.system 与工具描述。 */
export function defaultTurnPrompt(kit: TurnKit): string {
	const blocks: string[] = [];
	const recent = recentBlock(kit.recent);
	if (recent !== "") blocks.push(recent);
	blocks.push(`[World state]\n${kit.digest}`);
	blocks.push(`Player says: ${kit.utterance}`);
	return blocks.join("\n\n");
}

/** narrate 缺省：渲染调用无动作窗口，act 工具仍挂载而调用被吞，故标记必须显式。 */
export function defaultNarratePrompt(kit: NarrateKit): string {
	const blocks: string[] = ["[Rendering service] This call has no action window; do not call act; write the prose text directly."];
	const recent = recentBlock(kit.recent);
	if (recent !== "") blocks.push(recent);
	blocks.push(`[World state]\n${kit.digest}`);
	if (kit.events.length > 0) blocks.push(`[Recent adjudication]\n${kit.events.join("\n")}`);
	blocks.push(kit.instruction);
	return blocks.join("\n\n");
}

export interface GameDef {
	/** 指向普通实体的锚引用 */
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	/** 属性注册表（部分，可缺席）：注册即获值域契约、引用生命周期与呈现名（label）；未注册键即字面（无契约、无缺省名），词法纪律归作者。 */
	props?: Record<string, SlotDef>;
	/** 边类型注册表（部分，可缺席）：注册即获值域契约、引用生命周期与呈现名（label）；未注册 token 即字面（恒以 τ 为名）。 */
	relTypes?: Record<string, SlotDef>;
	/** 常驻规则表（可选）：每刻按声明序由泵以空参调用，后一条看得见前一条的后果。 */
	ticks?: TickDef[];
	/** 格命名：非空 token 即有名，null/空串即无名；顶点无名回落 id。缺省实现（顶点 id、属性/边 label）作为第三参数传入；声明即接管，可委托 base。 */
	name?: (world: World, player: string, base: (cell: Addr) => string | null) => (cell: Addr) => string | null;
	/** 近况选择：收全账本记录（账本序、已冻结）与缺省选择 base，返回要注入 AI 的记录子序列（须严格递增 seq 且取自传入记录）。此钩子只做选择，投影与言默判据归引擎。 */
	recent?: (records: readonly ChronicleEntry[], base: readonly ChronicleEntry[]) => readonly ChronicleEntry[];
	/** 缺省近况选择的窗口大小（回合记录数）；recent 缺席时必填，recent 在时作为 base 的参数（缺省即 base = 全量记录）。 */
	recentWindow?: number;
	/** 披露谓词：顶点格成员即可见；属性/边格谓词即变更行该侧判据。缺省常真，声明即整体替换。 */
	perceives?: (world: World, player: string) => (cell: Addr) => boolean;
	/** 可指称谓词：指称门的域。披露缺省（顶点格 perceives）作为第三参数传入；缺省即披露。 */
	referable?: (world: World, player: string, base: (e: Entity) => boolean) => (e: Entity) => boolean;
	/** 状态视图：收冻结真相、闭合基座与该边界的格视图（命名、披露谓词与可见/可指称/已知域）；返回任意 JSON，缺省即基座；增补部分在闭包之外。 */
	view?: (world: World, player: string, base: ViewBase, field: FieldView) => ViewValue;
	invariants?: Invariant[];
	/** 引擎文本解析：收场合与缺省实现 base，声明即接管总函数；返回值须为非空字符串。只被呈现消费。 */
	say?: (speech: Speech, base: (speech: Speech) => string) => string;
	messages: Messages;
	prompt: {
		system: string;
		/** act 工具描述：base = 协议约束 + 派生动词目录（catalog）；可委托或覆盖（本地化、分区、删减）。 */
		tool?: (base: string) => string;
		/** 意志回合提示：base = 缺省数据排版；可委托或整段覆盖。 */
		turn?: (kit: TurnKit, base: (kit: TurnKit) => string) => string;
		/** 渲染调用提示：base = 缺省数据排版；可委托或整段覆盖。 */
		narrate?: (kit: NarrateKit, base: (kit: NarrateKit) => string) => string;
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

const got = (v: unknown): string => {
	if (v === null) return "null";
	if (typeof v === "number") return Number.isFinite(v) ? "number" : "non-finite number";
	if (Array.isArray(v)) return "array";
	if (typeof v === "object") return "object";
	return typeof v;
};

/** 注册槽的值契约：形状 + ref 在世。返回问题描述（不含位置前缀）。 */
function slotValueProblem(d: SlotDef, v: Value, ids: ReadonlySet<string>): string | null {
	const problem = valueProblem(d.type, d.many === true, v);
	if (problem) return problem;
	if (d.type === "ref") {
		for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && !ids.has(x)) return `-> missing entity ${x}`;
	}
	return null;
}

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
	for (const e of world.entities) {
		if (typeof e.id !== "string" || e.id === "") return "integrity: entity id must be non-empty string";
		for (const k of Object.keys(e)) {
			if (k !== "id" && k !== "props") return `integrity: ${e.id}.${k} is not part of the entity shape`;
		}
		if (e.props === null || typeof e.props !== "object" || Array.isArray(e.props)) return `integrity: ${e.id}.props must be a record`;
		for (const [p, v] of Object.entries(e.props)) {
			if (!isValue(v)) return `integrity: ${e.id}.${p} is not a value (non-null scalar or non-empty scalar array; absence is a missing key)`;
			const pd = def.props?.[p];
			if (pd === undefined) continue;
			const problem = slotValueProblem(pd, v, ids);
			if (problem) return `integrity: ${e.id}.${p} ${problem}`;
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
		const eid = tupleKey(["edge", r.from, r.to, r.type]);
		if (edgeIds.has(eid)) return `integrity: duplicate relation ${r.from}->${r.to} (${r.type})`;
		edgeIds.add(eid);
		if (r.value === null || !isValue(r.value)) return `integrity: relation ${r.type} -> value is not a value (non-null, non-empty; stored edges never hold null)`;
		const rd = def.relTypes?.[r.type];
		if (rd) {
			const problem = slotValueProblem(rd, r.value, ids);
			if (problem) return `integrity: relation ${r.type} ${problem}`;
		}
	}
	return null;
}

/** 实体卡：id 是指称身份（ref 参数用它），name 是顶点 token（只阅读）；props 以格名承载，名字随边界求值。 */
export type Card = {
	id: string;
	name: string;
	props: { name: string; value: Value }[];
};

/** 可指称而不可见者的句柄：id 供指称参数，name 供阅读。 */
export type Handle = {
	id: string;
	name: string;
};

/** 一个提交边界的求值：披露谓词、可显示谓词、可见/可指称/已知域与格命名。由世界即时求值，不入账；命名只被呈现消费。 */
export interface FieldView {
	within: (cell: Addr) => boolean;
	/** 结构化显示的唯一判据：有名 ∧ 披露；顶点名恒在，故退化为披露。 */
	present: (cell: Addr) => boolean;
	visible: Set<string>;
	referable: Set<string>;
	known: Set<string>;
	name: (cell: Addr) => string | null;
}

/** 闭合后的状态视图基座：卡、句柄、边（名字、披露与指称闭包同时成立；边名即呈现 token，不携 τ）；作者视图钩子的缺省值与素材。 */
export type ViewBase = {
	time: number;
	entities: Card[];
	relations: { from: string; to: string; name: string; value: Value }[];
	known?: Handle[];
};

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

function hashStr(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** 同地址恒同值；地址是决策事件的账本位置，不由玩家输入决定；sides 违约即抛，由 *.crash 承接。 */
export function roll(addr: string, key: string, sides: number): number {
	if (!Number.isInteger(sides) || sides < 1) throw new Error(`roll: sides 须为 ≥1 的整数，得到 ${String(sides)}`);
	const h = hashStr(JSON.stringify([addr, key]));
	return 1 + Math.floor(h * sides);
}

/** 入账表态的机器身份：账本位置 (at, origin, id, 序位)——id 即动词或常驻规则。对入账表态单射、且由账本前缀复原：随机是账本位置的纯函数。 */
function attemptAddr(at: number, origin: Origin, verb: string, ordinal: number): string {
	return tupleKey(["attempt", String(at), origin, verb, String(ordinal)]);
}

/** 裁决点的呈现身份（场景断言与探针用）；分类看 kind，不看字符串。 */
export function lawOf(point: Point): string {
	switch (point.kind) {
		case "rule": return point.law;
		case "gate": return "action.invisible";
		case "closure": return "action.unanswered";
		case "invariant": return `invariant.${point.id}`;
		case "engine": return `engine.${point.check}`;
		case "crash": return `${point.site}.crash`;
	}
}

/** 一步（clock 步的 verb 即常驻规则 id，params 恒空）：价 = origin=clock ? 0 : (price ?? cost)；授予记守卫与法则，否决记 Point 与受众；链上规则表态或授予被审查拒绝时守卫随果入账，gate/closure 无守卫。 */
export type Commit =
	| { at: number; origin: Origin; action: Action; price: number; ok: true; rule: string; law: Text; changes: Change[]; reply?: Text; statements?: Text[] }
	| { at: number; origin: Origin; action: Action; price: number; ok: false; rule?: string; denial: Denial };

export interface Resolution {
	step: Commit;
	elapsed: Commit[];
}

/** 记录形状：Point/Denial/Change/Commit 的运行时值域——提交路径（产出）与装载路径（接受）共用同一判据。 */
function isPoint(v: unknown): v is Point {
	if (v === null || typeof v !== "object") return false;
	const p = v as { kind?: unknown; law?: unknown; id?: unknown; fault?: unknown; check?: unknown; site?: unknown };
	switch (p.kind) {
		case "rule": return typeof p.law === "string" && p.law !== "";
		case "gate": return true;
		case "closure": return true;
		case "invariant": return typeof p.id === "string" && p.id !== "" && (p.fault === "world" || p.fault === "engine");
		case "engine": return p.check === "integrity" || p.check === "commit" || p.check === "grant";
		case "crash": return p.site === "rule" || p.site === "invariant";
		default: return false;
	}
}

/** 否决形状：Point + ⟨text⟩?；文本非空；engine 受众必携文本；旧形状（reason/rule id）显式弃置。 */
function isDenial(v: unknown): boolean {
	if (v === null || typeof v !== "object") return false;
	const d = v as { point?: unknown; text?: unknown; reason?: unknown };
	if (d.reason !== undefined) return false;
	if (!isPoint(d.point)) return false;
	if (d.text !== undefined && (typeof d.text !== "string" || d.text === "")) return false;
	return audienceOf(d.point) !== "engine" || typeof d.text === "string";
}

/** 变更形状：投影与重放共用；顶点记录恰一侧为 ⊥（生/灭）。 */
function isChange(v: unknown): boolean {
	if (v === null || typeof v !== "object") return false;
	const c = v as { cell?: unknown; entity?: unknown; prop?: unknown; from?: unknown; to?: unknown; type?: unknown; prev?: unknown; next?: unknown };
	switch (c.cell) {
		case "vertex": return "prev" in c && "next" in c && (c.prev === null) !== (c.next === null);
		case "prop": return typeof c.entity === "string" && typeof c.prop === "string" && "prev" in c && "next" in c;
		case "edge": return typeof c.from === "string" && typeof c.to === "string" && typeof c.type === "string" && "prev" in c && "next" in c;
		default: return false;
	}
}

/** 步形状：授予行 law 必填非空；世界腔文本非空；答复只属于 will；否决的 rule 可缺（gate/closure 无守卫）。 */
export function isCommit(s: unknown): boolean {
	if (s === null || typeof s !== "object") return false;
	const c = s as { at?: unknown; price?: unknown; ok?: unknown; origin?: unknown; action?: unknown; rule?: unknown; law?: unknown; changes?: unknown; reply?: unknown; statements?: unknown; denial?: unknown };
	if (typeof c.at !== "number" || typeof c.ok !== "boolean" || typeof c.price !== "number") return false;
	if (c.origin !== "will" && c.origin !== "clock") return false;
	const a = c.action as { verb?: unknown; params?: unknown } | null | undefined;
	if (a === null || typeof a !== "object" || typeof a.verb !== "string" || a.params === null || typeof a.params !== "object") return false;
	if (c.ok === true) {
		if (typeof c.rule !== "string" || c.rule === "" || !Array.isArray(c.changes) || !c.changes.every(isChange)) return false;
		if (typeof c.law !== "string" || c.law === "") return false;
		if (c.reply !== undefined && (typeof c.reply !== "string" || c.reply === "")) return false;
		if (c.origin === "clock" && c.reply !== undefined) return false;
		return c.statements === undefined || (Array.isArray(c.statements) && c.statements.every((x) => typeof x === "string" && x !== ""));
	}
	if (c.rule !== undefined && (typeof c.rule !== "string" || c.rule === "")) return false;
	return isDenial(c.denial);
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

/** 场合缺省：gate 先取动词 invisible 再取 invisibleEntity（词表缺省，不越级 say），其余一律 noResponse。 */
function baseSpeech(def: GameDef, speech: Speech): string {
	if (speech.kind !== "point" || speech.point.kind !== "gate") return def.messages.noResponse;
	return def.verbs[speech.verb]?.invisible ?? def.messages.invisibleEntity ?? def.messages.noResponse;
}

function speechTag(speech: Speech): string {
	return speech.kind === "point" ? lawOf(speech.point) : speech.kind;
}

/** 引擎文本解析：声明 say 即接管总函数，base 即缺省绑定。 */
export function speak(def: GameDef, speech: Speech): string {
	const base = (s: Speech): string => baseSpeech(def, s);
	if (def.say === undefined) return base(speech);
	const text = def.say(speech, base);
	if (typeof text !== "string" || text.trim() === "") throw new Error(`GameDef.say 须返回非空字符串（场合 ${speechTag(speech)}）`);
	return text;
}

/** 玩家侧文本：world 点携文本即用，其余按场合解析；engine 点的 debug 不过此门。 */
export function renderDenial(def: GameDef, denial: Denial, verb: string): string {
	if (audienceOf(denial.point) === "world" && denial.text !== undefined) return denial.text;
	return speak(def, { kind: "point", point: denial.point, verb });
}

/** 原始文本（含引擎 debug）：装载拒绝等非呈现用途；无文本即空串，不回落 noResponse。 */
export function denialReasonText(denial: Denial): string {
	return denial.text ?? "";
}

/** 脸 token：id 在某个提交边界上的呈现词。脸由该边界的命名在已知域上即时求值，行文不回读活世界。 */
type Face = (id: string) => string;

/** 域外不触命名（回落 id 只是指称句柄的底），故未知者的名字不经任何行文泄漏。 */
function faceAt(field: FieldView, id: string): string {
	return field.known.has(id) ? field.name({ cell: "vertex", id }) ?? id : id;
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

/** 槽声明查表：属性按键、边按类型；未注册即 undefined。 */
function slotDef(def: Pick<GameDef, "props" | "relTypes">, cell: SlotAddr): SlotDef | undefined {
	return cell.cell === "prop" ? def.props?.[cell.prop] : def.relTypes?.[cell.type];
}

/** 弱引用：ref 且 strong 为 false（strong 必填，注册处无缺省）。 */
function isWeakSlot(d: SlotDef | undefined): boolean {
	return d !== undefined && d.type === "ref" && d.strong === false;
}

/** 值声明按契约检查：公共轴（type × many）+ 位点附加；未知字段即违约。 */
function validateDecl(where: string, param: boolean, d: unknown): void {
	const raw = (d ?? {}) as Record<string, unknown>;
	const allowed = param ? ["type", "many", "optional", "description"] : ["type", "many", "label", "strong"];
	for (const k of Object.keys(raw)) {
		if (!allowed.includes(k)) throw new Error(`${where}不接受字段「${k}」（${param ? "参数" : "注册槽"}声明：${allowed.join("/")}）`);
	}
	const type = raw.type;
	if (type !== "string" && type !== "number" && type !== "boolean" && type !== "ref") throw new Error(`${where}的 type 须为 string/number/boolean/ref，得到 ${String(type)}`);
	if (raw.many !== undefined && raw.many !== true) throw new Error(`${where}的 many 只能为 true（缺省即 one），得到 ${String(raw.many)}`);
	if (param) {
		if (raw.optional !== undefined && raw.optional !== true) throw new Error(`${where}的 optional 只能为 true（缺省即必填），得到 ${String(raw.optional)}`);
		if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description === "")) throw new Error(`${where}的 description 须为非空字符串，得到 ${JSON.stringify(raw.description)}`);
		return;
	}
	if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== "string" || raw.label === "")) throw new Error(`${where}的 label 须为 null 或非空字符串，得到 ${JSON.stringify(raw.label)}`);
	if (type === "ref") {
		if (typeof raw.strong !== "boolean") throw new Error(`${where}的 ref 须声明 strong（true 强 / false 弱），得到 ${String(raw.strong)}`);
	} else if (raw.strong !== undefined) {
		throw new Error(`${where}的 strong 只对 ref 有意义`);
	}
}

/** 规则链校验：id 非空且链内唯一；动词与常驻规则共用。 */
function assertRules(where: string, rules: readonly Rule[]): void {
	const ids = new Set<string>();
	for (const r of rules) {
		if (typeof r.id !== "string" || r.id === "") throw new Error(`${where} 的规则 id 须为非空字符串`);
		if (ids.has(r.id)) throw new Error(`${where} 的规则 id 重复：${r.id}`);
		ids.add(r.id);
	}
}

/** 值是否含指称 id：弱载荷随目标删除级联的判据。 */
function valueHasRef(v: Value, id: string): boolean {
	return Array.isArray(v) ? v.includes(id) : v === id;
}

/** 弱引用级联：从值中移除亡者引用；值因此为空（或本来只有该引用）即 null（删格）。 */
function withoutRef(v: Value, id: string): Value | null {
	if (!Array.isArray(v)) return v === id ? null : v;
	const rest = v.filter((x) => x !== id);
	return rest.length > 0 ? rest : null;
}

/** 指称集须落在给定域内：目标不在即整值不披露——披露的指称必有句柄。 */
function valueRefsWithin(v: Value, vis: ReadonlySet<string>): boolean {
	for (const item of Array.isArray(v) ? v : [v]) if (typeof item === "string" && !vis.has(item)) return false;
	return true;
}

/** 值位的指称过已知域。 */
function refsWithin(d: SlotDef | undefined, v: Value, vis: ReadonlySet<string>): boolean {
	return d?.type !== "ref" || valueRefsWithin(v, vis);
}

function fmtChange(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }, name: string): string {
	const val = (v: Payload, ok: boolean, isRef: boolean): string => (ok ? renderValue(face, v, isRef).text : "?");
	if (c.cell === "vertex") return `${c.next === null ? "-" : "+"} ${face(c.next === null ? c.prev.id : c.next.id)}`;
	if (c.cell === "edge") {
		const ref = slotDef(sim.def, c)?.type === "ref";
		return `${face(c.from)}.${name}.${face(c.to)}: ${val(c.prev, sides.prev, ref)} → ${val(c.next, sides.next, ref)}`;
	}
	const ref = slotDef(sim.def, c)?.type === "ref";
	return `${face(c.entity)}.${name}: ${val(c.prev, sides.prev, ref)} → ${val(c.next, sides.next, ref)}`;
}

/** 与渲染消费同一解析：指称集对渲染封闭——凡行铸出的同一性皆指称（prop 行主语在内），未披露侧不数。 */
function referentsOf(sim: Simulation, c: Change, face: Face, sides: { prev: boolean; next: boolean }): string[] {
	if (c.cell === "vertex") return [c.next === null ? c.prev.id : c.next.id];
	if (c.cell === "edge") {
		const out = [c.from, c.to];
		if (slotDef(sim.def, c)?.type === "ref") {
			if (sides.prev) out.push(...renderValue(face, c.prev, true).ids);
			if (sides.next) out.push(...renderValue(face, c.next, true).ids);
		}
		return out;
	}
	const ref = slotDef(sim.def, c)?.type === "ref";
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
			const at = steps[i]!.at;
			const after = clone(w);
			after.time = at;
			afters[i] = deepFreeze(after);
			rewind(w, [steps[i]!]);
			const before = clone(w);
			before.time = at;
			befores[i] = deepFreeze(before);
		}
	}
	/** 一步的渲染器：脸、披露谓词与改名行都由该步的提交边界（冻结读态）即时求值，行文不回读活世界。 */
	const renderer = (i: number): { face: Face; renames: string[]; changeLine: (c: Change) => string | null } => {
		const before = befores[i]!;
		const after = afters[i]!;
		const b = sim.fieldView(before);
		const a = sim.fieldView(after);
		// 跨边界脸查询：两侧已知域之并，域内取顶点 token（后态优先），域外不触命名
		const face = (id: string): string => faceAt(a.known.has(id) ? a : b, id);
		const field = new Set([...b.known, ...a.known]);
		// 改名是投影：一步内顶点 token 变化且两端皆在已知域（才有名可换），不为源属性的无名所滤
		const renames: string[] = [];
		for (const id of a.known) {
			if (!b.known.has(id)) continue;
			const prev = b.name({ cell: "vertex", id });
			const next = a.name({ cell: "vertex", id });
			if (prev !== null && next !== null && prev !== next) renames.push(`~ ${prev} → ${next}`);
		}
		const cellOf = (c: Change): Addr => (c.cell === "vertex" ? { cell: "vertex", id: c.next === null ? c.prev.id : c.next.id } : c);
		// 每侧可显示 ⇔ 该边界对变更格有名且披露（缺席格与在场格同过一门）
		const sidesOf = (c: Change): { prev: boolean; next: boolean } => {
			const cell = cellOf(c);
			return { prev: b.present(cell), next: a.present(cell) };
		};
		const changeLine = (c: Change): string | null => {
			const sides = sidesOf(c);
			if (!sides.prev && !sides.next) return null;
			if (!referentsOf(sim, c, face, sides).every((r) => field.has(r))) return null;
			const cell = cellOf(c);
			return fmtChange(sim, c, face, sides, a.name(cell) ?? b.name(cell) ?? "");
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
		const changes = s.ok ? [...renames, ...s.changes.map(changeLine).filter((x): x is string => x !== null)] : [];
		if (s.origin !== "clock") {
			flush();
			granted = s.price;
			const reply = s.ok ? s.reply : renderDenial(sim.def, s.denial, s.action.verb);
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
				held.denials.push(renderDenial(sim.def, s.denial, s.action.verb));
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

/** 门内裁决的表态；授予记守卫与法则，否决自带裁决点与守卫。 */
type RawResult =
	| { ok: true; deltas: Delta[]; rule: string; law: Text; reply?: Text; statements?: Text[]; price?: number }
	| { ok: false; denial: Denial; rule?: string; price?: number };

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 常驻规则：id → 规则链；每刻按声明序由泵调用。 */
	private readonly ticks: Map<string, readonly Rule[]>;
	/** 入账表态的序位来源：同 (at, origin, verb) 的已入账表态数——账本位置的函数，默不入账也不消耗序位；peek 纯读，mark 只在提交点。 */
	private readonly attemptSeq = new Map<number, Map<string, number>>();

	constructor(def: GameDef, world?: World) {
		this.def = def;
		this.world = clone(world ?? def.world);
		const { messages } = def;
		if (typeof messages.noResponse !== "string" || messages.noResponse.trim() === "") throw new Error("messages.noResponse 须为非空字符串");
		if (typeof messages.timePassed !== "string" || messages.timePassed.trim() === "") throw new Error("messages.timePassed 须为非空字符串");
		if (messages.invisibleEntity !== undefined && (typeof messages.invisibleEntity !== "string" || messages.invisibleEntity.trim() === "")) throw new Error("messages.invisibleEntity 须为非空字符串");
		if (def.say !== undefined && typeof def.say !== "function") throw new Error("GameDef.say 须为函数");
		const invariantIds = new Set<string>();
		for (const inv of def.invariants ?? []) {
			if (typeof inv.id !== "string" || inv.id === "") throw new Error("不变式 id 须为非空字符串");
			if (invariantIds.has(inv.id)) throw new Error(`不变式 id 重复：${inv.id}`);
			invariantIds.add(inv.id);
		}
		for (const [name, v] of Object.entries(def.verbs)) {
			if (!Number.isInteger(v.cost) || v.cost < 0) throw new Error(`动词 ${name} 的 cost 须为非负整数刻数，得到 ${String(v.cost)}`);
			assertRules(`动词 ${name}`, v.rules);
			for (const [p, s] of Object.entries(v.params)) validateDecl(`动词 ${name} 的参数「${p}」`, true, s);
			if (v.invisible !== undefined && (typeof v.invisible !== "string" || v.invisible.trim() === "")) throw new Error(`动词 ${name} 的 invisible 须为非空字符串`);
			if (v.invisible !== undefined && refParamsOf(v).length === 0) throw new Error(`动词 ${name} 无指称参数，invisible 文案不会被消费`);
		}
		const ticks = new Map<string, readonly Rule[]>();
		for (const t of def.ticks ?? []) {
			if (typeof t.id !== "string" || t.id === "") throw new Error("常驻规则 id 须为非空字符串");
			if (ticks.has(t.id)) throw new Error(`常驻规则 id 重复：${t.id}`);
			assertRules(`常驻规则 ${t.id}`, t.rules);
			ticks.set(t.id, t.rules);
		}
		// props 与 relTypes 同制：注册即契约；未注册键即字面，名字由呈现层按 (名, 值) 序列消费，不要求唯一
		for (const [k, d] of Object.entries(def.props ?? {})) validateDecl(`属性「${k}」`, false, d);
		for (const [t, d] of Object.entries(def.relTypes ?? {})) validateDecl(`边类型「${t}」`, false, d);
		this.ticks = ticks;
		// 结构校验恒挂；作者不变式走 admit（历史不重审），开局世界在此另判一次以尽早显形 def 错误
		const broken = integrityProblems(this.def, this.readState());
		if (broken) throw new Error(`初始世界破坏完整性：${broken}`);
		if (world === undefined) {
			const denied = this.admit();
			if (denied) throw new Error(`初始世界违反 ${lawOf(denied.point)}：${denialReasonText(denied)}`);
		}
	}

	get player(): string {
		return this.def.playerId;
	}

	/** steps 之前的世界：自终态逆推变更（与投影同法）；rewind 不触钟，故钟取首步边界。步空即当前世界。 */
	beforeWorld(steps: readonly Commit[]): World {
		const w = this.snapshot();
		rewind(w, steps);
		if (steps[0] !== undefined) w.time = steps[0].at;
		return w;
	}

	/** 披露谓词：缺省全见；声明即接管全部格，返回域外即缺陷。 */
	private perceives(world: World): (cell: Addr) => boolean {
		if (this.def.perceives === undefined) return () => true;
		const within = this.def.perceives(world, this.player);
		if (typeof within !== "function") throw new Error("GameDef.perceives 须返回谓词函数");
		return within;
	}

	/** 三个域的求值：不触命名，门与投影分路。可指称缺省即顶点格披露；声明即接管，返回域外即缺陷。 */
	private boundary(world: World): { within: (cell: Addr) => boolean; visible: Set<string>; referable: Set<string>; known: Set<string> } {
		const within = this.perceives(world);
		const disclosed = (e: Entity): boolean => within({ cell: "vertex", id: e.id });
		let refers = disclosed;
		if (this.def.referable !== undefined) {
			const hook = this.def.referable(world, this.player, disclosed);
			if (typeof hook !== "function") throw new Error("GameDef.referable 须返回谓词函数");
			refers = hook;
		}
		const visible = new Set<string>();
		const referable = new Set<string>();
		for (const e of world.entities) {
			if (within({ cell: "vertex", id: e.id })) visible.add(e.id);
			if (refers(e)) referable.add(e.id);
		}
		return { within, visible, referable, known: new Set([...visible, ...referable]) };
	}

	/** 注册表缺省命名：顶点 id、属性 label、边 label（缺席即 τ）；作为 base 交给作者钩子。 */
	private defaultNaming(): (cell: Addr) => string | null {
		return (cell) => {
			switch (cell.cell) {
				case "vertex": return cell.id;
				case "prop": return this.def.props?.[cell.prop]?.label ?? null;
				case "edge": {
					const label = this.def.relTypes?.[cell.type]?.label;
					return label === undefined ? cell.type : label;
				}
			}
		};
	}

	/** 格命名：作者钩子收缺省实现，可委托或接管；顶点无名回落 id，属性/边无名即 null；声明即全函数，返回域外即缺陷。 */
	private naming(world: World): (cell: Addr) => string | null {
		const base = this.defaultNaming();
		if (this.def.name === undefined) return base;
		const hook = this.def.name(world, this.player, base);
		if (typeof hook !== "function") throw new Error("GameDef.name 须返回命名函数");
		return (cell) => {
			const token = hook(cell);
			if (token === null) return cell.cell === "vertex" ? cell.id : null;
			if (typeof token !== "string" || token === "") throw new Error(`GameDef.name 须返回非空 token 或 null，得到 ${JSON.stringify(token)}`);
			return token;
		};
	}

	/** 提交边界的求值：披露＋三个域＋格命名＋可显示谓词；脸由命名在已知域上即时求值，不物化。 */
	fieldView(world: World = this.readState()): FieldView {
		const field = this.boundary(world);
		const name = this.naming(world);
		return { ...field, name, present: (cell) => name(cell) !== null && field.within(cell) };
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
		if (invalid.length) return { ok: false, denial: { point: { kind: "gate" } } };
		for (const r of rules) {
			const q = this.query(world, action.params, addr);
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, rule: r.id, denial: { point: { kind: "crash", site: "rule" }, text: `rule:${r.id}: ${e instanceof Error ? e.message : String(e)}` } };
			}
			if (!v) continue;
			const problems = verdictProblems(v, clock);
			if (problems.length) return { ok: false, rule: r.id, denial: { point: { kind: "engine", check: "grant" }, text: `rule:${r.id}: ${problems.join("; ")}` } };
			if (v.ok) {
				return { ok: true, deltas: v.deltas, rule: r.id, law: v.law !== undefined && v.law !== "" ? v.law : r.id, ...(v.reply !== undefined && { reply: v.reply }), ...(v.statements !== undefined && { statements: v.statements }), ...(v.price !== undefined && { price: v.price }) };
			}
			return { ok: false, rule: r.id, denial: v.denial, ...(v.price !== undefined && { price: v.price }) };
		}
		return { ok: false, denial: { point: { kind: "closure" } } };
	}

	/** 骰子地址是决策事件的账本位置；同地址同 key 恒同值，与法则重构无关。 */
	private query(world: World, params: Record<string, Value>, addr: string): Q {
		return {
			world,
			player: this.player,
			params,
			roll: (key, sides) => roll(addr, key, sides),
		};
	}

	/** 克隆覆写：冻结引用不得留在活账本上。回滚恒回封装单元（提交或 apply）起点，不越过已入账坐标。 */
	private restore(s0: World): void {
		Object.assign(this.world, clone(s0));
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
			if (!reason) continue;
			if (reason.fault !== "world" && reason.fault !== "engine") throw new Error(`不变式 ${inv.id} 的 fault 须为 world/engine`);
			if (reason.fault === "engine") {
				if (typeof reason.debug !== "string" || reason.debug === "") throw new Error(`不变式 ${inv.id} 的 debug 须为非空字符串`);
				return { point: { kind: "invariant", id: inv.id, fault: "engine" }, text: reason.debug };
			}
			if (reason.reply !== undefined && (typeof reason.reply !== "string" || reason.reply === "")) throw new Error(`不变式 ${inv.id} 的 reply 须为非空字符串`);
			return { point: { kind: "invariant", id: inv.id, fault: "world" }, ...(reason.reply !== undefined && { text: reason.reply }) };
		}
		return null;
	}

	/** 异常逃逸 ⇒ 世界恢复调用前原状再抛；attempt 入界即冻结（Q.params 与步记录同一对象），Resolution 出界即冻结。 */
	apply(action: Action): Resolution {
		deepFreeze(action);
		const s0 = this.readState();
		try {
			const res = this.applyInner(action, s0);
			// 序位随账目一同提交：apply 失败（钩子/投影崩溃）时世界回滚，未入账的尝试不得移动地址
			this.markAttempt(res.step.at, res.step.origin, res.step.action.verb);
			for (const c of res.elapsed) this.markAttempt(c.at, c.origin, c.action.verb);
			this.pruneAttempts();
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
		const gate = this.boundary(s0).referable;
		const r = this.adjudicateRaw(action, rules, refParams, gate, s0, addr, clock);
		let step: Commit;
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.rule, origin, action);
			if (!cc.ok) {
				step = { at, origin, action, price, ok: false, rule: r.rule, denial: cc.denial };
			} else {
				// 答复只属于有提案者的步：clock 授予的 reply 入账前插进 statements，记录层不出现无提案者的答复
				const reply = clock ? undefined : r.reply;
				const statements = clock && r.reply !== undefined ? [r.reply, ...(r.statements ?? [])] : r.statements;
				step = { at, origin, action, price: clock ? 0 : (r.price ?? price), ok: true, rule: r.rule, law: r.law, changes: cc.changes, ...(reply !== undefined && { reply }), ...(statements !== undefined && { statements }) };
			}
		} else {
			step = { at, origin, action, price: clock ? 0 : (r.price ?? price), ok: false, ...(r.rule !== undefined && { rule: r.rule }), denial: r.denial };
		}
		// 绊线：提交产出必落在装载域内（与装载路径同一判据）
		if (!isCommit(step)) throw new Error(`内核缺陷：提交产出的记录被装载判据拒绝 ${JSON.stringify(step)}`);
		return step;
	}

	/** 取序位是纯读，不移动任何状态；仅当步确定入账才 markAttempt——默与崩溃不消耗序位。 */
	private peekAttempt(at: number, origin: Origin, verb: string): number {
		return this.attemptSeq.get(at)?.get(`${origin}\u0000${verb}`) ?? 0;
	}

	private markAttempt(at: number, origin: Origin, verb: string): void {
		let seq = this.attemptSeq.get(at);
		if (seq === undefined) {
			seq = new Map();
			this.attemptSeq.set(at, seq);
		}
		const key = `${origin}\u0000${verb}`;
		seq.set(key, (seq.get(key) ?? 0) + 1);
	}

	/** 成功提交后剪枝：跨成功单元时间不减，at < world.time 的计数不可能再被查询；at = world.time 须留（同刻的 price=0 回合复用）。 */
	private pruneAttempts(): void {
		for (const at of this.attemptSeq.keys()) if (at < this.world.time) this.attemptSeq.delete(at);
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

	/** 尝试行不经跨度门；未过所见者原样回显。 */
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
		this.pruneAttempts();
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

	/** 重放：𝒞 反推 δ 逐条应用（不重裁决、不掷骰、不重算级联），逐变更 prev 校验，终态 integrity；authored 不变式不重审。链断回滚并返回原因。 */
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
			const span = this.clockSpanProblem(record);
			if (span) return fail(span);
			for (const step of record.steps) {
				if (!step.ok) continue;
				for (const c of step.changes) {
					const broken = this.verifyChange(c);
					if (broken) return fail(broken);
					const out = this.commit([deltaOf(c)], false);
					if ("refusal" in out) return fail(`重放提交被拒：${out.refusal}`);
				}
			}
			this.world.time = record.time;
			const broken = integrityProblems(this.def, this.readState());
			if (broken) return fail(broken);
			// 序位只在整条记录通过后推进：失败路径没有非世界状态需要回滚
			for (const step of record.steps) this.markAttempt(step.at, step.origin, step.action.verb);
			this.pruneAttempts();
			return null;
		} catch (e) {
			return fail(errorText(e));
		}
	}

	/** 逐变更 prev 校验：记录前值须与重放世界相符；后态已成立（如删除的槽已不在）即通过。 */
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
				const cur = e.props[c.prop] ?? null;
				if (c.next === null && cur === null) return null;
				return sameValue(cur, c.prev) ? null : `set "${c.entity}.${c.prop}" 前值不符`;
			}
			case "edge": {
				const cur = relVal(this.world, c.from, c.to, c.type);
				if (c.next === null && cur === null) return null;
				return sameValue(cur, c.prev) ? null : `rel ${c.from}->${c.to} (${c.type}) 前值不符`;
			}
		}
	}

	snapshot(): World {
		return clone(this.world);
	}

	/** 闭合基座：可见者出卡，可指称而不可见者出句柄（known）；关系过名字、披露与闭包（H）。 */
	private viewBase(w: World, field: FieldView): ViewBase {
		const entities = w.entities.filter((e) => field.visible.has(e.id)).map((e) => this.cardOf(e, field, faceAt(field, e.id)));
		const known = w.entities.filter((e) => !field.visible.has(e.id) && field.referable.has(e.id)).map((e): Handle => ({ id: e.id, name: faceAt(field, e.id) }));
		const relations = w.relations
			.filter((r) => {
				const cell: EdgeAddr = { cell: "edge", from: r.from, to: r.to, type: r.type };
				const rd = this.def.relTypes?.[r.type];
				return field.present(cell) && field.known.has(r.from) && field.known.has(r.to) && (rd?.type !== "ref" || valueRefsWithin(r.value, field.known));
			})
			.map((r) => ({ from: r.from, to: r.to, name: field.name({ cell: "edge", from: r.from, to: r.to, type: r.type })!, value: r.value }));
		const out: ViewBase = { time: w.time, relations, entities };
		if (known.length) out.known = known;
		return out;
	}

	/** 状态视图数据：闭合基座经作者钩子；null 是合法视图值，仅函数缺席回落基座。 */
	view(): ViewValue {
		const w = this.readState();
		const field = this.fieldView(w);
		const base = this.viewBase(w, field);
		if (this.def.view === undefined) return base;
		const out = this.def.view(w, this.player, base, field);
		if (out === undefined) throw new Error("GameDef.view 须返回 JSON 值（undefined 是缺陷）");
		return out;
	}

	/** 状态视图的规范序列化（digestOf(view())）：探针与日志的便捷出口。 */
	digest(): string {
		return digestOf(this.view());
	}

	/** 卡：属性过格名＋披露＋指称闭包（H），名字与值同一呈现轴。 */
	private cardOf(e: Entity, b: FieldView, name: string): Card {
		const props: { name: string; value: Value }[] = [];
		for (const [k, v] of Object.entries(e.props)) {
			const cell: PropAddr = { cell: "prop", entity: e.id, prop: k };
			if (!b.present(cell)) continue;
			if (!refsWithin(this.def.props?.[k], v, b.known)) continue;
			props.push({ name: b.name(cell)!, value: v });
		}
		return { id: e.id, name, props };
	}

	/** 回合内增量：新进可见域出卡、新进可指称域出句柄（出卡优先）；before 由 steps 逆推，边界一次求值。 */
	reveals(steps: readonly Commit[]): (Card | Handle)[] {
		const w = this.readState();
		const after = this.fieldView(w);
		// 钩子收冻结读态：与回合起点快照下的权限一致
		const before = this.fieldView(deepFreeze(this.beforeWorld(steps)));
		const out: (Card | Handle)[] = [];
		const added = new Set<string>();
		const emit = (e: Entity): void => {
			if (added.has(e.id)) return;
			added.add(e.id);
			out.push(after.visible.has(e.id) ? this.cardOf(e, after, faceAt(after, e.id)) : { id: e.id, name: faceAt(after, e.id) });
		};
		for (const e of w.entities) if (after.visible.has(e.id) && !before.visible.has(e.id)) emit(e);
		for (const e of w.entities) if (after.known.has(e.id) && !before.known.has(e.id)) emit(e);
		return out;
	}

	/** 逐条校验而非预检；幂等跳过的唯一判据是目标状态已成立。cascade 只在前向提交启用（重放逐条应用记录，不重算级联）。 */
	private commit(deltas: Delta[], cascade = true): { changes: Change[] } | { refusal: string } {
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
					// 级联是提交期推导：端点边必死，弱引用载荷移除亡者；重放逐条应用记录，不重算
					const edgeChanges: { from: string; to: string; type: string; prev: Value; next: Value | null }[] = [];
					const propChanges: { entity: string; prop: string; prev: Value; next: Value | null }[] = [];
					if (cascade) {
						// 逆序遍历 + unshift 保边表序
						const existing = this.world.relations;
						for (let j = existing.length - 1; j >= 0; j--) {
							const r = existing[j]!;
							if (r.from === d.id || r.to === d.id) {
								edgeChanges.unshift({ from: r.from, to: r.to, type: r.type, prev: r.value, next: null });
								existing.splice(j, 1);
								continue;
							}
							if (!isWeakSlot(this.def.relTypes?.[r.type]) || !valueHasRef(r.value, d.id)) continue;
							const next = withoutRef(r.value, d.id);
							edgeChanges.unshift({ from: r.from, to: r.to, type: r.type, prev: r.value, next });
							if (next === null) existing.splice(j, 1);
							else r.value = next;
						}
						for (const ent of this.world.entities) {
							for (const [k, v] of Object.entries(ent.props)) {
								if (!isWeakSlot(this.def.props?.[k]) || !valueHasRef(v, d.id)) continue;
								const next = withoutRef(v, d.id);
								propChanges.push({ entity: ent.id, prop: k, prev: v, next });
								if (next === null) delete ent.props[k];
								else ent.props[k] = next;
							}
						}
					}
					// 记录自含克隆，不与活账本共享引用
					changes.push({ cell: "vertex", prev: clone(gone), next: null });
					for (const e of edgeChanges) changes.push({ cell: "edge", from: e.from, to: e.to, type: e.type, prev: e.prev, next: e.next });
					for (const p of propChanges) changes.push({ cell: "prop", entity: p.entity, prop: p.prop, prev: p.prev, next: p.next });
				} else {
					if (entity(this.world, d.next.id)) return refuse(`spawn "${d.next.id}": entity already exists`);
					const ent: Entity = { id: d.next.id, props: d.next.props };
					if (!Object.values(ent.props).every(isValue)) return refuse(`spawn "${d.next.id}": props contain a non-value (non-null non-empty scalar or scalar array; absence is a missing key)`);
					changes.push({ cell: "vertex", prev: null, next: clone(ent) });
					this.world.entities.push(clone(ent));
				}
				continue;
			}
			if (d.cell === "edge") {
				if (d.type === "") return refuse(`relSet ${d.from}->${d.to}: relation type must be non-empty string`);
				const next = d.next;
				if (next !== null && !isValue(next)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): value is not a non-empty value`);
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (sameValue(prev, next)) continue;
				if (next !== null && dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
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
