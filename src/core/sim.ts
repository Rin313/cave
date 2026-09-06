import { Compile } from "typebox/compile";
import { Type, type Static, type TObject, type TString } from "typebox";
import { deepFreeze, roll as rollDice } from "./util.ts";

/** 存储标量：账本值的原子形态。null 不是值；NaN/Infinity 非标量。 */
export type Scalar = string | number | boolean;

/** 账本值：标量或标量数组（单行渲染所需，对象与 null 洞由硬墙拒绝；自由形态走 ViewValue）。 */
export type LedgerValue = Scalar | Scalar[];

/** 值语言：账本值 ∪ null。null 永不入存储，只出现在读数、清除写入与变更记录。 */
export type PropValue = LedgerValue | null;

/** 视图载荷：形态自由的 JSON 值，仅供呈现——不进账本、不进变更线性化。用户：digestExtra。 */
export type ViewValue = string | number | boolean | null | ViewValue[] | { [k: string]: ViewValue };

export interface Entity {
	id: string;
	name: string;
	props: Record<string, LedgerValue>;
}

/** 关系边：社会/叙事状态的原子原语。存储边永不持 null——「无边」由边表缺席表达（relVal 以 null 回答） */
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

/** 变更原语：全为绝对写（后态自含），只由规则/系统产出、经硬墙提交。set null 即删键、relSet null 即删边；
 *  despawn 级联删边逐条入账，id 型属性引用不清扫（悬空由 integrity 回滚）。 */
export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "relSet"; from: string; to: string; type: string; value: LedgerValue | null }
	| { op: "rename"; entity: string; value: string }
	| { op: "spawn"; entity: Entity }
	| { op: "despawn"; entity: string };

/** 提交产出的变更记录（后态完整 diff）：prop/rename 只留 prev/next，rel 携带完整端点，spawn 携带完整后态实体
 *  （事件流自足于重放），despawn 携带展示名——离场者名字只存在于记录（见 shownDepartedNames）。
 *  出处不进步记录（事件流是纯内容），只住在提交边界（InvariantCtx.src）。 */
export type Change =
	| { kind: "prop"; entity: string; prop: string; prev: PropValue; next: PropValue }
	| { kind: "rename"; entity: string; prev: string; next: string }
	| { kind: "rel"; from: string; to: string; type: string; prev: PropValue; next: PropValue }
	| { kind: "spawn"; entity: Entity }
	| { kind: "despawn"; entity: string; name: string };

export interface Action {
	verb: string;
	/** 参数恒为存储标量（schema 门），不接受 null。 */
	params: Record<string, Scalar>;
}

/** core 产出的用户可见文案，由游戏注入：core 不内嵌文案、不在文案里解析实体名（机器诊断走 Denial.debug）。 */
export interface Messages {
	/** 所有法则均未表态时的兜底回应；core 完整性不变式违反也回落此文案。 */
	noResponse: string;
	/** 指称参数不可见/不存在的统一文案：幻觉 id 与隐藏实体同一文案。 */
	invisibleEntity?: string;
	/** 规则授予但未提供世界腔理由时的占位文案。 */
	defaultReason: string;
	/** 时间流逝的文案（刻步的段头与近况渲染）。 */
	timePassed: string;
}

/** 法则产出的玩家可见事实：进结果视图，供叙述跟随。形式即文本——与 reason 同为规则铸造的世界腔 */
export type Fact = string;

export type PropType = "string" | "number" | "boolean" | "id" | "tags" | "any";

export interface PropDef {
	type: PropType;
	/** 世界化说法（变更线性化文本里的属性名）。 */
	label?: string;
	/** 机械词汇旗标：对一切呈现面（视图/变更行）永不渲染；与感知正交——规则/系统/不变式照常读世界真相。 */
	internal?: boolean;
}

export interface Denial {
	law: string;
	/** 拒绝文案（规则理由 / 可达性构件 / 不变式 message）；缺省回落 messages.noResponse。 */
	reason?: string;
	debug?: string;
}

/** 静态形态违约（未知动词 / schema 不符）：正常拒绝点在工具边界（pi 校验，可重试）；内核收到即调用方违约，
 *  抛出而非按世界拒绝处理。 */
export class ProtocolViolation extends Error {
	readonly law: "action.unknown" | "action.schema";
	readonly debug: string;

	constructor(law: "action.unknown" | "action.schema", debug: string) {
		super(`协议违约 ${law}：${debug}`);
		this.law = law;
		this.debug = debug;
	}
}

/** 规则判定上下文：world 是裁决读态的深冻结副本（越权写即抛），一切后果经返回值表达、由模拟层统一提交/回滚。 */
export interface Q {
	readonly world: World;
	/** def.playerId 的现值。语义主语与视角的推导（无主语动词缺省、附身经空间构件 hostOf）是 games 层职责。 */
	readonly player: string;
	readonly time: number;
	readonly params: Record<string, Scalar>;
	/** 确定性骰子（World 纯函数）。key 由引擎以出处元组编码限定，重名不共享命运；sides 形状违约即抛（*.crash 代谢）。 */
	roll(key: string, sides: number): number;
}

/** 规则表态：授予（deltas + 玩家文案理由 + facts + ticks）或结构化拒绝；null = 不表态，交由后续规则。
 *  ticks 只改写授予分支的流逝（缺省回落动词 cost）；拒绝分支恒为尝试价。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; reason?: string; facts?: Fact[]; ticks?: number }
	| { ok: false; denial: Denial };

/** 动作规则：卫语句式总函数，拒绝/授予优先序即书写顺序。 */
export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

/** 系统规则：每 tick 一次，聚合产出（空产出 = 本 tick 无事）。产出只有 deltas/facts，无 reason 通道。 */
export interface SystemRule {
	id: string;
	run: (q: Q) => { deltas: Delta[]; facts?: Fact[] } | null;
}

export function grant(deltas: Delta[], reason?: string, facts?: Fact[], ticks?: number): Verdict {
	return { ok: true, deltas, ...(reason !== undefined && { reason }), ...(facts !== undefined && { facts }), ...(ticks !== undefined && { ticks }) };
}

/** 尝试时价（刻，缺省 0）：凡入裁决即尝试。拒绝分支恒等此值（四面同价，法则不可改写），ticks 只改写授予分支。 */
function attemptCost(verb: VerbDef | undefined): number {
	return verb?.cost ?? 0;
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

/** 参数 kind：字符串参数的指称性声明，标记住在 schema 属性节点上（schema 即参数词表，与 PropDef.type 同构）。 */
type ParamKind = "ref" | "free";

function paramKind(node: unknown): ParamKind | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const n = node as Record<string, unknown>;
	if (n.ref === true) return "ref";
	if (n.free === true) return "free";
	return undefined;
}

/** 指称参数：值是实体 id——可见性门管辖（不可指名即拒）、尝试行解析为名字、probe 枚举。 */
export function ref(description?: string): TString {
	return Type.String({ ...(description !== undefined && { description }), ref: true });
}

/** 自由字符串：许愿/内容——值按字面进入裁决，径由法则裁决，门与渲染一律不解析。 */
export function free(description?: string): TString {
	return Type.String({ ...(description !== undefined && { description }), free: true });
}

/** 动词的指称参数键（schema 声明序）：可见性门、尝试行渲染与 probe 的共同读取点。 */
export function refParamsOf(verb: VerbDef): string[] {
	const props = verb.schema.properties as Record<string, unknown>;
	return Object.keys(props).filter((k) => paramKind(props[k]) === "ref");
}

/** 动词定义助手：规则参数 p 由 TypeBox schema 推导为编译期类型（边界处已完成 schema 校验）。 */
export function defineVerb<S extends TObject>(spec: {
	label: string;
	description: string;
	schema: S;
	cost?: number;
	internal?: boolean;
	rules: { id: string; judge: (q: Q, p: Static<S>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		...(spec.cost !== undefined && { cost: spec.cost }),
		// 工具边界与内核前置条件同一严格度：多余参数在工具层被拒，而非到内核才触发 ProtocolViolation
		schema: { ...spec.schema, additionalProperties: false },
		...(spec.internal !== undefined && { internal: spec.internal }),
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q, q.params as Static<S>) })),
	};
}

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: TObject;
	/** 尝试时价（刻，缺省 0）：凡入裁决即尝试。拒绝分支恒价（法则不可改写），ticks 只改写授予分支。 */
	cost?: number;
	/** 内部动词：不进映射层（act schema 与系统提示的投影滤除），只由代码直接 apply——同一裁决边界与硬墙。 */
	internal?: boolean;
	/** 卫语句式规则：按序裁决，首个表态即判决；末条可为无条件拒绝的兜底规则。 */
	rules: Rule[];
}

export interface GameDef {
	id: string;
	title: string;
	/** 指向普通实体的居所引用（integrity 恒查其存在）；Q.player 即其值。附身等主语推导是 games 层职责。 */
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	/** 时间系统：每 tick 按注册顺序运行的系统规则（world→deltas 的纯函数）。 */
	systems?: SystemRule[];
	/** 属性注册表：类型/label（变更线性化的属性名）/internal（不进状态视图与变更线性化）。
	 *  词汇闭合由 integrity 钉住：实体属性键 ⊆ 注册表（动态键值走关系边）。 */
	props?: Record<string, PropDef>;
	/** 回退摘要覆写（缺省 = spineLines 单行连接，空步回落 noResponse）。steps 为本回合事件流（动作步+刻步，按序）；
	 *  钩子在世界侧运行，可读 internal 属性。 */
	summarize?: (input: { world: World; player: string; steps: Step[] }) => string;
	/** 近况窗口的地籍条目数——映射层指代与续接锚的时间视界 */
	recentWindow: number;
	/** 可见实体索引：决定哪些实体进序列化。缺省全部可见 */
	grounding?: (world: World, player: string) => string[];
	/** 边感知（缺省恒真）：同一谓词约束状态视图的 relations 与事件投影的 rel 变更行；端点可见过滤是 core 内核，本谓词叠加其上。 */
	edgePerception?: (world: World, player: string) => (r: Rel) => boolean;
	/** 属性感知（缺省恒真）：同一谓词约束状态视图的 props 块与事件投影的 prop 变更行。谓词收意志锚与槽
	 *  （实体×注册表键，含缺席槽——缺席即状态），读物化真相（「知其有不知其值」的知识居所仍是账本——感知
	 *  不物化为内容）；按构造不铸造指称（只对在册槽求值），可感 id 值在变更行中仍受 referents 门控。 */
	propPerception?: (world: World, player: string) => (e: Entity, prop: string) => boolean;
	/** 状态视图的派生纹理，入 extra 键（形态自由 ViewValue）。视图顶层 time/relations/entities 为 core 装配字段，不可覆写；
	 *  extra 无引用声明面：指称的铸造面只有实体卡与关系端点，纹理以名字陈述可指名者、以字面披露其余。 */
	digestExtra?: (world: World, player: string) => Record<string, ViewValue>;
	/** 不变式：提交后校验，违反即回滚整个提交并拒绝。core 默认恒挂引用完整性硬墙。 */
	invariants?: Invariant[];
	/** core 产出的用户可见文案（必填——core 不内嵌文案）。 */
	messages: Messages;
	/** 表达契约（可选）：叙述者人格、世界读法、写作纪律；core 原样注入 system prompt。 */
	voice?: string;
}

/** 不变式检查上下文：起点世界快照（守恒类种子的锚点）+ 本次提交的全部变更与产出方（provenance 审计）。 */
export interface InvariantCtx {
	def: GameDef;
	/** 本 Simulation 起点世界的冻结副本（首提交前捕获）——存档恢复/变体开局时 ≠ def.world。 */
	genesis: World;
	/** 本次提交的全部变更（含 spawn/despawn）；每条规则/系统的提交独立过墙。 */
	changes: Change[];
	/** 本次提交的产出方（rule:<动词>.<id> / system:<id> / def——构造期）。 */
	src: string;
}

/** 不变式：每次提交后校验（null 通过），违反即整提交回滚并拒绝。状态不变式只读 world（守恒类）；
 *  过渡不变式经 ctx.changes 读提交（provenance 类）。world 与 ctx 均为冻结读态，审查者写入即抛。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

/** 存储标量判定：null 不是值；NaN/Infinity 非标量。 */
function isScalarValue(v: unknown): v is Scalar {
	return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** 账本值形状的运行时判定：类型挡不住 as 通道（存档恢复、场景 JSON、probe），存储形状不含 null */
function isLedgerValue(v: unknown): v is LedgerValue {
	return isScalarValue(v) || (Array.isArray(v) && v.every(isScalarValue));
}

/** 账本值等值：幂等跳过的判据是「目标状态已成立」（执行翼契约），标量数组逐位恒等而非引用同一。 */
function sameLedger(a: PropValue, b: PropValue): boolean {
	if (a === b) return true;
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** core 默认硬墙：引用完整性、注册表类型契约与词汇闭合。世界全域扫描
 *  spawn 整包与 t=0 构造期自动覆盖 */
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
			// playerId 每次裁决都被解引用——主体静默 despawn 会让后续裁决级联劣化，故属墙的管辖
			if (!ids.has(ctx.def.playerId)) return `integrity: playerId -> missing entity ${ctx.def.playerId}`;
			const registry = Object.entries(ctx.def.props ?? {});
			const vocabulary = new Set(registry.map(([k]) => k));
			for (const e of world.entities) {
				if (typeof e.id !== "string" || e.id === "") return "integrity: entity id must be non-empty string";
				if (typeof e.name !== "string" || e.name === "") return `integrity: ${e.id}.name must be non-empty string`;
				// 形状封闭：实体顶层键 ⊆ {id, name, props}（记录形状已由 ids 遍历担保）
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
					// any 豁免标量类型检查，不豁免账本值形状；null 不是值（缺席是键不在场）
					if (!isLedgerValue(v)) return `integrity: ${e.id}.${p} is not a ledger value (non-null scalar or scalar array; absence is a missing key)`;
					if (pd.type === "any") continue;
					if (pd.type === "id") {
						// 「无引用」由缺席表达（清除写 null 即删键）
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
				// 形状封闭：边顶层键 ⊆ {from, to, type, value}
				for (const k of Object.keys(r)) {
					if (k !== "from" && k !== "to" && k !== "type" && k !== "value") return `integrity: relation.${k} is not part of the relation shape`;
				}
				if (typeof r.from !== "string" || r.from === "") return "integrity: relation.from must be non-empty string";
				if (typeof r.to !== "string" || r.to === "") return "integrity: relation.to must be non-empty string";
				// type 是边身份的组成（开口 token）：非字符串/空串即身份退化
				if (typeof r.type !== "string" || r.type === "") return "integrity: relation.type must be non-empty string";
				if (!ids.has(r.from) || !ids.has(r.to)) return `integrity: relation ${r.type} -> missing endpoint`;
				// 三元组唯一：边身份是感知快照与可说性的键，影子边让读写静默分叉
				const eid = tupleKey([r.from, r.to, r.type]);
				if (edgeIds.has(eid)) return `integrity: duplicate relation ${r.from}->${r.to} (${r.type})`;
				edgeIds.add(eid);
				if (r.value === null || !isLedgerValue(r.value)) return `integrity: relation ${r.type} -> value is not a ledger value (stored edges never hold null)`;
			}
			return null;
		},
	};
}

/** 从属性注册表计算内部属性集。 */
export function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

/** 实体视图卡（状态视图与新见段共用的唯一形状）：id + 名字 + internal 滤 ∧ 属性感知滤后的属性包。 */
export function viewCard(def: GameDef, e: Entity, perceiveProp?: (e: Entity, prop: string) => boolean): { id: string; name: string; props: Record<string, LedgerValue> } {
	const internal = internalPropsOf(def);
	return { id: e.id, name: e.name, props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k) && (!perceiveProp || perceiveProp(e, k)))) };
}

export function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
}

/** 一次提交边界两侧的感知截面：可见实体集、边键、属性键。感知分辨率继承提交边界的离散化；
 *  裁决时取定，提交后不可重算；值不随截面入账（Change.prev/next 自含）。 */
export interface FieldSpan {
	before: string[];
	after: string[];
	edges?: { before: string[]; after: string[] };
	props?: { before: string[]; after: string[] };
}

/** 元组编码键：id/type/属性键的字符集不受 integrity 约束，分隔符拼接有碰撞面（`a|b`+`c` ≡ `a`+`b|c`）——感知截面与命运地址共用同一教训。 */
function tupleKey(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

/** 事件流条目：动作步（ActionStep）与世界刻步（TickStep）——一个按构造保序的序列，两种条目均携带钟坐标 at。 */
export type Step = ActionStep | TickStep;

/** 动作裁决结果：一次动作过门的完整记录。 */
export interface ActionStep {
	kind: "action";
	/** 裁决发生时刻的钟值（门被调用时；本授予的刻步为 at+1..at+ticks）——与 TickStep.at 同一坐标轴。 */
	at: number;
	ok: boolean;
	reason: string;
	changes: Change[];
	/** 提交边界两侧的可见快照（落钟前闭合；刻步自带）。 */
	field: FieldSpan;
	action: Action;
	/** 本动作授予的刻数（成功取规则 ticks 或动词 cost，失败取动词 cost）；apply 据此逐刻落钟。 */
	ticks: number;
	/** 否决来源：rule＝卫语句链或可见性门（全部未表态的引擎闭合为 law "action.unanswered"）；
	 *  invariant＝必要性拦截（硬墙否决、授予形状违约、法则代码失灵 *.crash）。 */
	deniedBy?: "rule" | "invariant";
	/** 结构化拒绝，供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
}

/** apply 的结果：动作步 + 其授予刻数内产出的刻步（授予数以 ActionStep.ticks 为权威）。 */
export interface Resolution {
	step: ActionStep;
	elapsed: TickStep[];
}

/** 世界刻步：一刻内某个系统的产出（at 为钟已走到的时刻）。无 reason 通道；
 *  失败刻只来自必要性通道（硬墙否决 / system.crash）。 */
export type TickStep =
	| { kind: "tick"; at: number; ok: true; changes: Change[]; field: FieldSpan; facts?: Fact[] }
	| { kind: "tick"; at: number; ok: false; changes: []; field: FieldSpan; deniedBy: "invariant"; denial: Denial };

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

/** 拒绝渲染为玩家文案：优先 denial.reason，缺省兜底 noResponse。 */
export function renderDenial(def: GameDef, denial: Denial): string {
	if (denial.reason != null) return denial.reason;
	return def.messages.noResponse;
}

/** 离场者底表：despawn 记录是离场者名字的唯一来源，渲染窗口（近况传整个窗口）内一切
 *  despawn 记录均入表。 */
export function shownDepartedNames(steps: readonly { changes: Change[] }[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of steps) for (const c of s.changes) if (c.kind === "despawn") m.set(c.entity, c.name);
	return m;
}

/** 取值渲染（渲染与投影的唯一解析点）：ref=true 时字符串元素解析为展示名（在世读态或离场底表），解析不出
 *  原样回显，引用身份随 ids 返回；ref=false 一律字面。引用性由声明决定（见 refProp）。 */
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

/** 值位的引用性判定：注册表 type:"id" 的属性值（标量与引用数组）是引用；关系值与未声明值一律字面。 */
function refProp(sim: Simulation, prop: string): boolean {
	return sim.def.props?.[prop]?.type === "id";
}

/** 变更线性化（core 只做符号连接，name/label 取自游戏声明）。
 *  指称解析走 renderValue：关系端点是引用，关系值、关系类型与未声明属性值一律字面；窗口内 despawn 的实体以 departed 兜底。 */
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

/** internal 属性变更过滤（internal 隔离的机械缺省）：internal 不进表达输入的变更线性化。 */
export function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	const internal = internalPropsOf(def);
	return changes.filter((c) => !(c.kind === "prop" && internal.has(c.prop)));
}

/** 变更行的指称集：与渲染器消费同一解析（renderValue）——渲染会说出名字之处，投影即数指称。
 *  值侧分侧披露下，未披露侧的值不数指称（不渲染即不门控）。指称身份（ids）与名字解析无关
 *  （renderValue 对字符串元素恒记 id），不收离场底表。 */
function referentsOf(sim: Simulation, c: Change, sides?: { prev: boolean; next: boolean }): string[] {
	if (c.kind !== "prop") return c.kind === "rel" ? [c.from, c.to] : c.kind === "spawn" ? [c.entity.id] : [c.entity];
	const ref = refProp(sim, c.prop);
	const out: string[] = [];
	if (sides?.prev ?? true) out.push(...renderValue(sim, c.prev ?? null, ref).ids);
	if (sides?.next ?? true) out.push(...renderValue(sim, c.next ?? null, ref).ids);
	return out;
}

/** 事件流的规范单行渲染（符号承担结构，语言词来自 messages/label/规则文案）。
 *  消费者：act 结果视图、近况投影（compact）、loop 控制台、回退摘要。
 *  契约：变更行按该步的感知截面投影——rel/prop 行的存在性要求键在两侧知觉的并集内（原型知觉：
 *  进入/离开即目睹转变），值侧披露分侧门控（未采样侧以「?」占位）；任一渲染指称不在参照域内
 *  整行沉默；理由与 Fact 不过投影；internal 变更恒滤。刻桶按 at 归并并归属前导动作的授予区间
 *  （ActionStep.ticks 为权威账目），静默刻归账为「timePassed ×n」。 */
export function spineLines(sim: Simulation, steps: Step[], opts?: { compact?: boolean; departed?: ReadonlyMap<string, string> }): string[] {
	const spanOf = (s: Step): Set<string> => new Set([...s.field.before, ...s.field.after]);
	const shownDeparted = opts?.departed ?? shownDepartedNames(steps);
	/** 步内可说变更的渲染：存在性（感知并集）＋值侧披露（分侧采样）＋指称门（参照域并集）共一判定。 */
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
			// 可说判据只认步的参照域（随步冻结，渲染不扩权）；离场名由底表解析，与可说性分立
			if (!referentsOf(sim, c, sides ?? undefined).every((r) => field.has(r))) return null;
			return fmtChange(sim, c, shownDeparted, sides ?? undefined);
		};
	};
	const msgs = sim.def.messages;
	const compact = opts?.compact === true;
	const lines: string[] = [];
	// 静默刻归账：granted − 有桶行的刻
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
			const changes = compact ? [] : narratableChanges(sim.def, s.changes).map(speakableOf(s)).filter((x): x is string => x !== null);
			const tail = [
				changes.length ? `（${changes.join("；")}）` : "",
				s.facts?.length ? `〔${s.facts.join("；")}〕` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, shownDeparted)}：${s.reason}${tail}`);
		} else {
			const held = said.get(s.at) ?? { changes: [], facts: [], denials: [] };
			if (s.ok) {
				if (!compact) held.changes.push(...narratableChanges(sim.def, s.changes).map(speakableOf(s)).filter((x): x is string => x !== null));
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

/** 裁决结果 + 未提交的 deltas（裁决与提交分离）；跨度由 apply 在提交边界闭合。
 *  拒绝态 deniedBy/denial 必填——否决必有来源；*.crash 无世界腔，noResponse 兜底。 */
type RawResult =
	| ({ ok: true; deltas: Delta[]; src: string } & Omit<ActionStep, "kind" | "at" | "field" | "ok" | "deltas" | "deniedBy" | "denial">)
	| ({ ok: false; deltas: Delta[]; deniedBy: "rule" | "invariant"; denial: Denial } & Omit<ActionStep, "kind" | "at" | "field" | "ok" | "deltas" | "deniedBy" | "denial">);

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 不变式种子：实际起点读态的深冻结副本（冻结保护种子不被墙侧代码改写），首次提交前惰性捕获（无不变式的路径零成本）。 */
	private genesisCache?: World;
	/** 动词参数严格校验器（additionalProperties:false） */
	private readonly validators = new Map<string, ReturnType<typeof Compile>>();

	/** 缺省克隆 def.world 作为初始世界；显式传入 world（存档恢复克隆源）则以其为完整真相。 */
	constructor(def: GameDef, world?: World) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(world ?? def.world)) as World;
		// 出处 id 的同作用域唯一：重复即命运共享与归因歧义（def 结构错误，加载期拒绝，与 cost/参数形状同类）
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
			this.validators.set(name, Compile(Type.Object(v.schema.properties, { additionalProperties: false })));
			if (v.cost !== undefined && (!Number.isInteger(v.cost) || v.cost < 0)) throw new Error(`动词 ${name} 的 cost 须为非负整数刻数，得到 ${String(v.cost)}`);
			const ruleIds = new Set<string>();
			for (const r of v.rules) {
				if (ruleIds.has(r.id)) throw new Error(`动词 ${name} 的规则 id 重复：${r.id}`);
				ruleIds.add(r.id);
			}
			// 一次尝试＝一个裁决＝一个时价＝一个拒绝单位：多重性由批次承载，参数须为标量（账本值的标量数组是状态侧形状，不入尝试语言）
			// 字符串参数的 kind 必须显式声明（ref＝指称、free＝自由字符串）——kind 住在词表，漏报在 def 加载时失败，不可静默 fail-open
			for (const p of Object.keys(v.schema.properties)) {
				const node = (v.schema.properties as Record<string, { type?: string } | undefined>)[p];
				if (node?.type !== "string" && node?.type !== "number" && node?.type !== "boolean") {
					throw new Error(`动词 ${name} 的参数「${p}」须为标量（string/number/boolean），得到 ${String(node?.type)}`);
				}
				const kind = paramKind(node);
				if (node.type === "string") {
					if (!kind) throw new Error(`动词 ${name} 的字符串参数「${p}」须声明 kind：ref（指称）或 free（自由字符串）`);
				} else if (kind) {
					throw new Error(`动词 ${name} 的参数「${p}」的 kind 标记只对字符串参数有意义`);
				}
			}
		}
		// 初始世界同样过墙（genesis = 自身，changes = 空，src = def）——def 结构错误与损坏存档在此显形，而非首次提交
		const broken = this.checkInvariants("def", this.readState(), []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.message}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		return this.visibleIn(this.readState());
	}

	/** 参照域 = grounding ∩ 账本：可见性门与状态视图实体索引的共同权威（谎报的 id 静默离场）。 */
	private visibleIn(world: World): Set<string> {
		const ids = new Set(world.entities.map((e) => e.id));
		if (!this.def.grounding) return ids;
		return new Set(this.def.grounding(world, this.player).filter((id) => ids.has(id)));
	}

	/** 边感知快照：结构过滤（端点可见）∧ 游戏语义谓词。*/
	private edgeField(world: World, vis: Set<string>): string[] | undefined {
		const perceive = this.def.edgePerception?.(world, this.player);
		if (!perceive) return undefined;
		const out: string[] = [];
		for (const r of world.relations) if (vis.has(r.from) && vis.has(r.to) && perceive(r)) out.push(tupleKey([r.from, r.to, r.type]));
		return out;
	}

	/** 属性感知快照：全部在册实体 × 注册表属性键经谓词过滤（键为 tupleKey 元组编码；缺省恒真 → undefined，零成本）。
	 *  枚举注册表而非在场键：槽知觉覆盖缺席（缺席即状态——清空后的清单仍须可说「→ null」）。
	 *  槽知觉与宿主知觉正交：prop 行的指称集只含值（居所迁移行的可说性系于值指称，不系于魂的自见性），
	 *  故宿主可见性不是截面的维度，槽谓词是唯一的体验者相对门。 */
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

	/** 裁决读态：快照 + 深冻结。def 侧一切钩子（Q.world、grounding、edgePerception、propPerception、
	 *  digestExtra、summarize）一律收此读态——越权写即在冻结对象上抛错（walltest 钉住跨度两侧）；
	 *  同时是提交的回滚基线。 */
	private readState(): World {
		return deepFreeze(this.snapshot());
	}

	/** 静态形态检查：verb 存在 + 参数严格校验（裁决外的前置条件，违约即抛 ProtocolViolation）。
	 *  批次入口（validateBatch）与单动作裁决（adjudicateRaw）共用同一检查与同一严格度。 */
	private staticForm(action: Action): VerbDef {
		const verb = this.def.verbs[action.verb];
		if (!verb) throw new ProtocolViolation("action.unknown", `verb:${action.verb}`);
		if (!this.validators.get(action.verb)!.Check(action.params)) {
			throw new ProtocolViolation("action.schema", this.schemaErrors(action.verb, action.params));
		}
		return verb;
	}

	/** 批次预校验：整批动作在首个裁决前过静态形态检查。批次执行方（act 工具）必须在裁决循环前调用——
	 *  否则第 n 个动作的静态违约会把前 n-1 个已裁决动作变成无记录后果。 */
	validateBatch(actions: readonly Action[]): void {
		for (const a of actions) this.staticForm(a);
	}

	/** 前态参照域与冻结读态由调用方（apply）逐动作计算传入：同一提案内的多动作不沿用旧读态。 */
	private adjudicateRaw(action: Action, curVis: Set<string>, world: World): RawResult {
		const msgs = this.def.messages;
		const verb = this.staticForm(action);
		const cost = attemptCost(verb);
		// 可见性门：参照域（裁决读态的可见集）外的指称参数即不可指名——空串亦然（id 非空，"" ∉ 参照域）
		const invalid = refParamsOf(verb)
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && !curVis.has(id));
		if (invalid.length) {
			// 幻觉 id 与隐藏实体同一文案，不解析门外实体（审计 id 走 debug）——否则 id 盲猜即存在性 oracle
			const reason = msgs.invisibleEntity ?? msgs.noResponse;
			return { ok: false, reason, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.invisible", reason, debug: invalid.join(",") }, ticks: cost };
		}
		for (const r of verb.rules) {
			// Q 逐法则构造：出处是 def 树的完整路径，命运地址元组编码整条路径（分隔符拼接有碰撞面）
			const src = `rule:${action.verb}.${r.id}`;
			const q = this.query(world, action.params, ["rule", action.verb, r.id]);
			// 法则崩溃代谢为必要性否决：fail-closed，链终止，时价照耗；法则失灵无世界腔，noResponse 兜底
			let v: Verdict | null;
			try {
				v = r.judge(q);
			} catch (e) {
				return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "rule.crash", debug: `${src}: ${e instanceof Error ? e.message : String(e)}` }, ticks: cost };
			}
			if (!v) continue;
			if (v.ok) {
				// 刻数违约走不变式通道拒绝（probe 据此报 bug），尝试仍耗动词时价
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `${src}: ticks 须为非负整数刻数，得到 ${String(v.ticks)}` }, ticks: cost };
				}
				return { ok: true, reason: v.reason ?? msgs.defaultReason, changes: [], deltas: v.deltas, action, ...(v.facts !== undefined && { facts: v.facts }), src, ticks: v.ticks ?? cost };
			}
			return { ok: false, reason: renderDenial(this.def, v.denial), changes: [], deltas: [], action, deniedBy: "rule", denial: v.denial, ticks: cost };
		}
		return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.unanswered" }, ticks: cost };
	}

	/** path 是命运的机器身份（完整出处路径），src 是同一出处的可读渲染（InvariantCtx 审计面）——由调用方成对构造。 */
	private query(world: World, params: Record<string, Scalar>, path: string[]): Q {
		return {
			world,
			player: this.player,
			time: world.time,
			params,
			roll: (key, sides) => rollDice(world, tupleKey([...path, key]), sides),
		};
	}

	/** 实际起点读态：首个提交前的深冻结快照（一切变异都经 commitChecked，此刻必为未变异状态）。 */
	private genesis(): World {
		return (this.genesisCache ??= this.readState());
	}

	private schemaErrors(verbName: string, params: Record<string, PropValue>): string {
		const errs = this.validators.get(verbName)!.Errors(params);
		return errs.length ? errs.map((e) => `${e.instancePath} ${e.message}`).join("; ") : JSON.stringify(params);
	}

	/** 原子回滚：恢复为 s0（先删提交期间新建的顶层键——如 relations——再整体覆写）。
	 *  以克隆赋值解冻：冻结是读隔离手段，冻结引用不得留在活账本上（否则后续提交全部抛错）。 */
	private restore(s0: World): void {
		for (const k of Object.keys(this.world)) if (!(k in s0)) delete (this.world as unknown as Record<string, unknown>)[k];
		Object.assign(this.world, JSON.parse(JSON.stringify(s0)) as World);
	}

	/** 提交 + 硬墙：以裁决读态 s0 为回滚基线。先 commit（执行校验），后不变式校验；
	 *  core 完整性违反只有 debug（回落 noResponse），游戏不变式的 message 直接作玩家文案；
	 *  提交过程的意外异常（坏 delta、审查者越权写）同通道兑为墙否决。 */
	private commitChecked(s0: World, deltas: Delta[], src: string): { ok: true; changes: Change[] } | { ok: false; denial: Denial; reason: string } {
		const genesis = this.genesis(); // 种子先于一切变异捕获：这里是唯一提交入口
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

	/** 运行全部不变式（先 core 引用完整性，后游戏声明），返回首个违反者。审查者收冻结读态与冻结记录。 */
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

	/** 历史原子性：异常逃逸 ⇒ 世界恢复调用前原状再抛。法则/系统崩溃已在门内代谢为否决，
	 *  能逃逸的只有投影钩子与内核 bug（投影不产世界事件）——先回滚后重抛。 */
	apply(action: Action): Resolution {
		const s0 = this.readState();
		try {
			return this.applyInner(action, s0);
		} catch (e) {
			this.restore(s0);
			throw e;
		}
	}

	private applyInner(action: Action, s0: World): Resolution {
		// s0 = 裁决读态，硬墙的回滚基线
		const at = s0.time;
		const before = this.visibleIn(s0);
		const edgesBefore = this.edgeField(s0, before);
		const propsBefore = this.propField(s0);
		const r = this.adjudicateRaw(action, before, s0);
		let step: Omit<ActionStep, "field">;
		if (r.ok) {
			const cc = this.commitChecked(s0, r.deltas, r.src);
			if (!cc.ok) {
				// 硬墙回滚整个授予（含规则改写的刻数）：尝试本身仍消耗动词时价
				step = { kind: "action", at, ok: false, reason: cc.reason, changes: [], action, deniedBy: "invariant", denial: cc.denial, ticks: attemptCost(this.def.verbs[action.verb]) };
			} else {
				step = { kind: "action", at, ok: true, reason: r.reason, changes: cc.changes, action, ...(r.facts !== undefined && { facts: r.facts }), ticks: r.ticks };
			}
		} else {
			step = { kind: "action", at, ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial, ticks: r.ticks };
		}
		// 可见快照在落钟前闭合；无提交（法则拒绝或硬墙回滚）则边界未跨越，after 即 before。
		// 跨度两侧同一冻结契约：后侧与前侧同源于提交后读态，感知钩子不触活账本
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

	/** 尝试行线性化：参数按 schema 声明序渲染，指称参数（ref 标记）解析为名字、其余字面，消费 renderValue
	 *  同一解析链。域外引用不查在世名——活体名解析仅限已感知指称，否则尝试行成为隐藏实体的存在性 oracle；
	 *  离场名兜底，其余原样回显。 */
	describeAction(step: ActionStep, departed?: ReadonlyMap<string, string>): string {
		const action = step.action;
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const field = new Set([...step.field.before, ...step.field.after]);
		const refs = new Set(refParamsOf(verb));
		const parts = Object.keys(verb.schema.properties)
			.filter((k) => k in action.params)
			.map((k) => {
				const v = action.params[k]!;
				if (!refs.has(k) || typeof v !== "string") return renderValue(this, v, false, departed).text;
				if (!field.has(v)) return departed?.get(v) ?? v;
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

	/** 按注册顺序运行全部系统一次，产出并提交 deltas。 */
	private runSystems(): TickStep[] {
		const out: TickStep[] = [];
		for (const sys of this.def.systems ?? []) {
			const src = `system:${sys.id}`;
			const s0 = this.readState();
			// 快照先于运行：失败刻步与提交刻步携带同一形状的真实跨度
			const before = this.visibleIn(s0);
			const edgesBefore = this.edgeField(s0, before);
			const propsBefore = this.propField(s0);
			// 系统崩溃代谢为失败刻步：本系统产出作废，其余系统继续，时刻照走
			let res: ReturnType<SystemRule["run"]> = null;
			try {
				res = sys.run(this.query(s0, {}, ["system", sys.id]));
			} catch (e) {
				out.push({ kind: "tick", at: this.world.time, ok: false, changes: [], deniedBy: "invariant", denial: { law: "system.crash", debug: `${sys.id}: ${e instanceof Error ? e.message : String(e)}` }, field: { before: [...before], after: [...before] } });
				continue;
			}
			if (!res || (res.deltas.length === 0 && !res.facts?.length)) continue;
			// 每系统独立过墙；回滚即边界未跨越，after 即 before——后侧与前侧同源于提交后读态（冻结契约）
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

	/** 状态视图：可见实体（grounding）× internal 滤 ∧ 属性感知 × 关系（端点可见 ∧ edgePerception）；digestExtra 入 extra 键。
	 *  实体集与可见性门同源（同一 visibleIn）——模型可指名的必出现在视图；卡上属性包同理：可感的值必在卡上，卡上的必可感。 */
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

	/** 回退摘要，缺省 = 回合骨架投影（空步回落 noResponse）。声音钩子崩溃回落缺省——呈现缺陷不得丢弃已发生的账目。 */
	summarize(steps: Step[]): string {
		if (this.def.summarize) {
			try {
				return this.def.summarize({ world: this.readState(), player: this.player, steps: deepFreeze(steps) });
			} catch { /* def 缺陷：回落文档化的缺省形态 */ }
		}
		const lines = spineLines(this, steps);
		return lines.length ? lines.join("\n") : this.def.messages.noResponse;
	}

	/** 提交的执行校验：逐条校验而非提交前预检（同一授予内 spawn 后 set 是合法书写），不可执行即拒绝整个提交。
	 *  幂等跳过的唯一判据是目标状态已成立；set 同值以目标存在为前提——存在性拒绝在前，永不回落为跳过。 */
	private commit(deltas: Delta[]): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		// 边表全程同一数组引用（原地增删，不可整体替换）
		const rels = (): Rel[] => this.world.relations;
		const upsertRel = (from: string, to: string, type: string, value: LedgerValue) => {
			const rs = rels();
			const hit = rs.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else rs.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: Denial } => ({ refusal: { law: "invariant.commit", debug: `commit: ${debug}` } });
		const dangling = (from: string, to: string): boolean => !entity(this.world, from) || !entity(this.world, to);
		for (const d of deltas) {
			if (d.op === "spawn") {
				if (entity(this.world, d.entity.id)) return refuse(`spawn "${d.entity.id}": entity already exists`);
				if (!Object.values(d.entity.props).every(isLedgerValue)) return refuse(`spawn "${d.entity.id}": props contain a non-ledger value (non-null scalar or scalar array; absence is a missing key)`);
				this.world.entities.push(JSON.parse(JSON.stringify(d.entity)) as Entity);
				// 记录自含独立克隆：不与活账本共享引用（后续变异不得改写已入账的记录）
				changes.push({ kind: "spawn", entity: JSON.parse(JSON.stringify(d.entity)) as Entity });
				continue;
			}
			if (d.op === "despawn") {
				const i = this.world.entities.findIndex((e) => e.id === d.entity);
				if (i < 0) return refuse(`despawn "${d.entity}": entity missing`);
				const gone = this.world.entities[i]!;
				this.world.entities.splice(i, 1);
				// 原地级联删边并逐条入账；逆序遍历 + unshift 保边表序（确定性），同提交内后续边写入共享同一数组
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
				// 执行翼：type 是边身份的组成，非字符串/空串即身份退化（同一严格度：integrity 对存储边同查）
				if (typeof d.type !== "string" || d.type === "") return refuse(`relSet ${String(d.from)}->${String(d.to)}: relation type must be non-empty string`);
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (sameLedger(prev, d.value)) continue;
				if (dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
				if (d.value !== null && !isLedgerValue(d.value)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): value is not a ledger value`);
				if (d.value === null) {
					// 能走到此处则边必已存在（prev !== null）；原地删——边表是本提交共享的数组，不可整体替换
					const rs = rels();
					const i = rs.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) rs.splice(i, 1);
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
