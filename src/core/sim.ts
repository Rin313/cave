import { Compile } from "typebox/compile";
import { Type, type Static, type TObject } from "typebox";
import { deepFreeze, roll as rollDice } from "./util.ts";

export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue };

export interface Entity {
	id: string;
	name: string;
	props: Record<string, PropValue>;
}

/** 关系边：社会/叙事状态的原子原语（存储边永不持 null——「无边」由数组缺席表达，relVal 以 null 回答） */
export interface Rel {
	from: string;
	to: string;
	type: string;
	value: number | string | boolean;
}

export interface World {
	time: number;
	entities: Entity[];
	/** 关系边表：from→to 的 type 关系（信任/记忆/派系等）。游戏声明，规则以 deltas 变更。 */
	relations?: Rel[];
}

/** 结构化变更原语：规则产出 deltas，模拟层裁定提交（快照线以下的数据协议）。
 *  提交产出按基底类别同构分形的 Change（kind: prop/rename/rel/spawn/despawn）
 *  spawn/despawn：实体生灭（authored 世界的动态拓扑原语；relSet 建边/删边（值 null），配合生灭原语让拓扑生长与收缩对称）。
 *  despawn 只级联清理核心结构（关系边）；id 型属性引用不清扫——悬空引用由完整性硬墙回滚。 */
export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "inc"; entity: string; prop: string; by: number }
	| { op: "relSet"; from: string; to: string; type: string; value: number | string | boolean | null }
	| { op: "relInc"; from: string; to: string; type: string; by: number }
	| { op: "rename"; entity: string; value: string }
	| { op: "spawn"; entity: Entity }
	| { op: "despawn"; entity: string };

/** 世界变更记录（快照线以下的数据协议，commit 的唯一产出）：与 Delta 按基底类别同构——属性写 / 名字写 / 关系边写 / 实体生灭。
 *  set/inc 合流为 prop（提交后不区分操作形态，prev/next 即差异）；rel 携带完整边端点（from/to）与边值（prev/next，next null 即删边）；
 *  spawn/despawn 的 name 是生灭实体的展示名（实体已离开状态，变更是唯一载体）。*/
export type Change =
	| { kind: "prop"; entity: string; prop: string; prev: PropValue; next: PropValue; src: string }
	| { kind: "rename"; entity: string; prev: string; next: string; src: string }
	| { kind: "rel"; from: string; to: string; type: string; prev: PropValue; next: PropValue; src: string }
	| { kind: "spawn"; entity: string; name: string; src: string }
	| { kind: "despawn"; entity: string; name: string; src: string };

/** 动作提案：由游戏声明的动词表（verb）驱动，参数由动词 schema 约束。 */
export interface Action {
	verb: string;
	params: Record<string, PropValue>;
}

/** core 产出的用户可见文案契约：由游戏经 GameDef.messages 必填注入自有语言，core 不内嵌任何语言、
 *  不解析实体名进文案——涉及实体的指称由规则在自家世界腔理由内解析（法则可见世界真相，门只可见公开状态）；
 *  机器诊断一律走 Denial.debug。 */
export interface Messages {
	/** 所有法则均未表态时的兜底回应；core 完整性不变式违反也回落此文案。 */
	noResponse: string;
	/** 实体参数不可见/不存在（core 校验层拒绝）的统一世界腔：幻觉 id 与隐藏实体同一文案。 */
	invisibleEntity?: string;
	/** 规则授予但未提供世界腔理由时的占位文案。 */
	defaultReason: string;
	/** act 门闩拦截（本回合已裁决后误调 act 工具时的防御性拒绝）。 */
	notInActionPhase: string;
	/** 时间流逝的世界腔描述（刻步的段头与近况渲染；事件流中刻不是动作）。 */
	timePassed: string;
}

/** 法则产出的世界腔事实：进结果视图，供叙述跟随。 */
export interface Fact {
	text: string;
}

/** 属性类型。 */
export type PropType = "string" | "number" | "boolean" | "id" | "tags" | "any";

/** 属性注册表条目：类型的声明、世界化标签、内部标记 */
export interface PropDef {
	type: PropType;
	/** 世界化说法（拒绝/变更文本里的属性名）。 */
	label?: string;
	/** 内部属性：不进 LLM 序列化、不进变更线性化（从源头杜绝泄漏）。 */
	internal?: boolean;
}

/** 结构化拒绝：法则身份 + 世界腔理由 + 机器诊断。 */
export interface Denial {
	/** 法则标识 */
	law: string;
	/** 世界腔拒绝文案（法则 text 内联渲染 / 可达性构件 prose / 不变式 message）；缺省回落到 messages.noResponse。 */
	reason?: string;
	/** 审计用诊断 */
	debug?: string;
}

/** 静态形态前置条件违约：未知动词 / schema 不符。
 *  静态形态错在裁决之外——工具边界由 pi 校验拒绝（错误回模型、可重试、门闩未耗）；
 *  内核收到同类动作即调用方违约（工具边界偏斜 / 场景笔误 / probe 域声明错误）。
 *  世界真相（含感知——不可见）在裁决之内，走世界性拒绝。 */
export class ProtocolViolation extends Error {
	readonly law: "action.unknown" | "action.schema";
	readonly debug: string;

	constructor(law: "action.unknown" | "action.schema", debug: string) {
		super(`协议违约 ${law}：${debug}`);
		this.law = law;
		this.debug = debug;
	}
}

/** 规则判定上下文：冻结读态 + 引擎自有语义的唯一入口（关系/骰子/时间/可见性）。
 *  只读由结构保证：world 是裁决时读态的深冻结副本；一切后果经返回的 Delta 表达，由模拟层统一提交/回滚。 */
export interface Q {
	readonly world: World;
	/** 玩家（def.playerId，意志的居所）：意志在世界的全部足迹是一根引用，本字段即其值——体验者推导的根与兜底。
	 *  无主语动词的缺省主语是体验者而非本字段：第一人称下二者恒等（退化读法）；附身游戏经空间构件 hostOf
	 *  从本字段推导链上器皿，不直接以本字段作主语。显式主语动词的语义主语从参数取
	 *  （上帝视角的主语全在参数里，后果落在被指令者）。 */
	readonly player: string;
	readonly time: number;
	readonly params: Record<string, PropValue>;
	entity(id: string): Entity | undefined;
	name(id: string): string;
	/** 关系值（无边为 null）。 */
	rel(from: string, to: string, type: string): number | string | boolean | null;
	/** 关系数值比较：缺边/非数按 dflt 参与——缺省语义显式命名在调用点。 */
	relNum(from: string, to: string, type: string, dflt: number): number;
	/** 确定性骰子（World 纯函数，apply/存档恢复一致）。 */
	roll(key: string, sides: number): number;
	visible(): Set<string>;
}

/** 裁决：授予（未提交 deltas + 世界腔理由 + facts + 授予刻数）或结构化拒绝；规则返回 null = 不表态。
 *  ticks 是时间律的规则面（回合协议）：改写本动作的实际流逝（缺省回落动词时价）。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; reason?: string; facts?: Fact[]; ticks?: number }
	| { ok: false; denial: Denial };

/** 动作规则：卫语句式总函数，拒绝/授予优先序即书写顺序。 */
export interface Rule {
	id: string;
	judge: (q: Q) => Verdict | null;
}

/** 系统规则：每 tick 一次，聚合产出（空产出 = 本 tick 无事）。 */
export interface SystemRule {
	id: string;
	run: (q: Q) => { deltas: Delta[]; facts?: Fact[]; reason?: string } | null;
}

export function grant(deltas: Delta[], reason?: string, facts?: Fact[], ticks?: number): Verdict {
	return { ok: true, deltas, reason, facts, ticks };
}

/** 尝试时价（刻，缺省 0）：凡入裁决即尝试，成败皆消耗。 */
function attemptCost(verb: VerbDef | undefined): number {
	return verb?.cost ?? 0;
}

export function deny(law: string, o: { reason?: string } = {}): Verdict {
	return { ok: false, denial: { law, ...o } };
}

/** Delta 构造糖。 */
export const D = {
	set: (entity: string, prop: string, value: PropValue): Delta => ({ op: "set", entity, prop, value }),
	inc: (entity: string, prop: string, by: number): Delta => ({ op: "inc", entity, prop, by }),
	relSet: (from: string, to: string, type: string, value: number | string | boolean | null): Delta => ({ op: "relSet", from, to, type, value }),
	relInc: (from: string, to: string, type: string, by: number): Delta => ({ op: "relInc", from, to, type, by }),
	rename: (entity: string, value: string): Delta => ({ op: "rename", entity, value }),
	spawn: (entity: Entity): Delta => ({ op: "spawn", entity }),
	despawn: (entity: string): Delta => ({ op: "despawn", entity }),
};

/** 动词定义助手：规则参数 p 由 TypeBox schema 推导为编译期类型（边界处已完成 schema 校验）。 */
export function defineVerb<S extends TObject>(spec: {
	label: string;
	description: string;
	schema: S;
	cost?: number;
	entityParams?: string[];
	beyondField?: string[];
	rules: { id: string; judge: (q: Q, p: Static<S>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		cost: spec.cost,
		// 工具边界与内核前置条件同一严格度：多余参数在工具层被拒，而非到内核才触发 ProtocolViolation
		schema: { ...spec.schema, additionalProperties: false },
		entityParams: spec.entityParams,
		beyondField: spec.beyondField,
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q, q.params as Static<S>) })),
	};
}

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: TObject;
	/** 尝试时价（刻，缺省 0）：凡入裁决即尝试，成败皆消耗。规则可在授予中以 ticks 改写实际流逝。 */
	cost?: number;
	/** 声明哪些参数是实体指称：机械渲染按声明解析为名字、probe 按其枚举；可见性门缺省管辖（可指名必看得见）。 */
	entityParams?: string[];
	/** 域外可指的引用参数（⊆ entityParams）：名字来源在实体索引之外，
	 *  可见性门对其退位——存在性与可达性由法则层给出世界性回答。指称的历史积累不随视野蒸发，
	 *  瞬时参照域表达不了它，只能由声明让位（地点恒可指名的肯定式声明）。 */
	beyondField?: string[];
	/** 卫语句式规则：按序裁决，首个表态即判决；末条可为无条件拒绝的兜底规则。 */
	rules: Rule[];
}

export interface GameDef {
	id: string;
	title: string;
	/** 意志的居所：def 指向世界的唯一数据引用。意志（act 通道的说话人，每回合恰好一个）不在世界里——账本里只有这根引用。
	 *  它承担两个角色：integrity 墙的保护对象（凡被解引用者必须可解），与体验者推导的根与兜底——无主语动词的缺省主语是
	 *  体验者而非本地址，第一人称下二者恒等（退化读法）；附身 = 地址的空间迁移（魂以 in 居于器皿），体验者 =
	 *  链上最近器皿（space 构件 hostOf 推导，视角与门随链跟随）。居所上的状态全是游戏建模态（第一人称下恰好是身体态），
	 *  意志自身无状态。视角是感知面钩子的现值（缺省全见全达即上帝视角；第一人称是游戏声明）。 */
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	/** 时间系统：每 tick 按注册顺序运行的系统规则（world→deltas 的纯函数）。 */
	systems?: SystemRule[];
	/** 属性注册表：属性类型/世界化标签/内部标记。状态视图与变更线性化读 internal（internal 隔离由 core 机械保证），describeAction 与拒绝渲染读 label。词汇闭合：实体的属性键 ⊆ 注册表（integrity 墙钉住），缺省空注册表即不允许任何属性。 */
	props?: Record<string, PropDef>;
	/** 回退摘要的声音覆写（可选）：缺省由引擎装配回合骨架投影（spineLines 单行连接，空步回落 noResponse）。
	 *  覆写用于文学化兜底：steps 是本回合事件流（动作步+刻步，按序）；钩子是世界侧代码，可读 internal
	 *  （internal 隔离是模型面纪律，不约束世界侧文案），玩家文案的忠实自负。 */
	summarize?: (input: { world: World; player: string; steps: Step[] }) => string;
	/** 近况窗口的回合数（映射层的指代视野）。缺省 0。*/
	memoryLimit?: number;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见（未声明认识论语义的诚实零） */
	grounding?: (world: World, player: string) => string[];
	/** 边感知（感知推论在关系边上的闭合）：体验者知觉哪些关系边。core 只保留不可覆写的结构过滤。
	 *  同一谓词约束两面：状态视图（digest.relations）与事件投影（rel 变更行，经 FieldSpan.edges 随步快照） */
	edgePerception?: (world: World, player: string) => (r: Rel) => boolean;
	/** 状态视图的派生纹理（世界 + 玩家 → 视图 extra 键下的附加纹理）：出口、随身清单等游戏自持语义的呈现。
	 *  命名空间分区：core 装配字段（time/relations/entities）独占视图顶层，纹理覆写不可表示。
	 *  无 id 承诺：参照域由 core 装配并保证 ≡ 可见性门，纹理不承载它；携带可指名 id 时应配合
	 *  beyondField 引用参数消费（地点恒可指名的声明面：名字来源在实体索引之外，门退位，由法则层回答）。 */
	digestExtra?: (world: World, player: string) => Record<string, PropValue>;
	/** 不变式：提交后校验，违反即回滚整个提交并拒绝。core 默认恒挂引用完整性硬墙。 */
	invariants?: Invariant[];
	/** core 产出的用户可见文案（游戏自有语言，必填：core 不内嵌任何语言，缺省即空，倒逼游戏注入）。 */
	messages: Messages;
	/** 表达契约（世界语言，可选）：叙述者人格、世界读法、写作纪律——表达侧的作者供稿面。*/
	voice?: string;
}

/** 不变式检查上下文：世界 + 游戏定义（注册表等）+ 本实例的实际起点世界（守恒类种子的正确锚点）+ 本次提交的变更。 */
export interface InvariantCtx {
	def: GameDef;
	/** 创世快照：本 Simulation 起点世界的冻结副本（首提交前捕获）——存档恢复/变体开局时 ≠ def.world。 */
	genesis: World;
	/** 本次提交的全部变更（含 spawn/despawn 与 src 产出方标识）：过渡不变式据此审计 provenance。
	 *  每条规则/系统的提交独立过墙，粒度即单次提交。 */
	changes: Change[];
}

/** 不变式：提交后校验，返回世界腔/结构化拒绝理由（null 通过）。违反即回滚整个提交并拒绝。
 *  两种形态共用本接口：状态不变式只读 world（守恒类，防总量漂移）；
 *  过渡不变式经 ctx.changes 读提交（provenance 类，防错误再分配）。
 *  审查者与裁决侧同权隔离：world / ctx.genesis / ctx.changes 均为冻结读态或冻结记录 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

/** core 默认硬墙：引用完整性、注册表类型契约与词汇闭合（属性键 ⊆ 注册表）。
 * 世界全域扫描：spawn 整包与 t=0 构造期自动覆盖，检测规则把世界改坏的 bug（悬空引用、类型错写、未声明词汇）。 */
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
			const ids = new Set(world.entities.map((e) => e.id));
			if (ids.size !== world.entities.length) return "integrity: duplicate entity ids";
			if (!Number.isInteger(world.time) || world.time < 0) return "integrity: world.time must be a non-negative integer";
			// playerId 是 def 指向世界的唯一数据引用（体验者推导与感知钩子的解引用原点），每次裁决都被解引用，
			// 属于「引擎将解引用的引用必须可解」的墙的管辖——否则 despawn 主体静默过墙，后续裁决级联劣化。
			if (!ids.has(ctx.def.playerId)) return `integrity: playerId -> missing entity ${ctx.def.playerId}`;
			const registry = Object.entries(ctx.def.props ?? {});
			const vocabulary = new Set(registry.map(([k]) => k));
			for (const e of world.entities) {
				// 卡片契约：id 与名字是引擎自有词汇的在场保证（存档恢复路径无类型检查，腐蚀通道在此封死）
				if (typeof e.id !== "string" || e.id === "") return "integrity: entity id must be non-empty string";
				if (typeof e.name !== "string" || e.name === "") return `integrity: ${e.id}.name must be non-empty string`;
				// 词汇闭合：type 层封闭、token 层开放（与动词表同构），未声明词汇不入账；动态键值对走关系边、自由值形状走 any/tags
				for (const k of Object.keys(e.props)) {
					if (!vocabulary.has(k)) return `integrity: ${e.id}.${k} is not declared in the prop registry`;
				}
				for (const [p, pd] of registry) {
					const v = e.props[p];
					if (v === null || v === undefined || pd.type === "any") continue;
					if (pd.type === "id") {
						// id 型属性契约：标量引用或引用数组；空串视为无引用，与标量规则一致；非字符串即违约
						for (const ref of Array.isArray(v) ? v : [v]) {
							if (typeof ref !== "string") return `integrity: ${e.id}.${p} expects id reference, got ${got(ref)}`;
							if (ref !== "" && !ids.has(ref)) return `integrity: ${e.id}.${p} -> missing entity ${ref}`;
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
			for (const r of world.relations ?? []) {
				if (!ids.has(r.from) || !ids.has(r.to)) return `integrity: relation ${r.type} -> missing endpoint`;
			}
			return null;
		},
	};
}

/** 获取游戏声明的用户可见文案 */
export function messagesFor(def: GameDef): Messages {
	return def.messages;
}

/** 从属性注册表计算内部属性集（不进序列化/变更线性化）。 */
export function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

/** 实体视图卡（状态视图与新见段共用的唯一形状）：id + 名字 + 注册表过滤后的属性包。 */
export function viewCard(def: GameDef, e: Entity): { id: string; name: string; props: Record<string, PropValue> } {
	const internal = internalPropsOf(def);
	return { id: e.id, name: e.name, props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))) };
}

/** 属性世界化标签（拒绝/变更文本中的说法；无则返回 undefined）。 */
export function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
}

/** 参照域跨度：裁决边界两侧的感知投影快照——事件投影的判定输入
 *  与 Change.prev/next 同一本体：提交后不可重算的历史，只存在于记录，不是账本状态。
 *  edges 是边感知快照 */
export interface FieldSpan {
	before: string[];
	after: string[];
	edges?: { before: string[]; after: string[] };
}

/** 边键：跨度内边感知快照的形态（from|to|type——知觉判定只需边的身份，值随变更行携带）。 */
function edgeKey(r: Pick<Rel, "from" | "to" | "type">): string {
	return `${r.from}|${r.to}|${r.type}`;
}

/** 事件流条目（审计与表达输入的基本形态）：动作裁决与世界刻步是两种本体——
 *  刻是世界的因（驱动 systems 的因果步，提交失败不回退时间），不是意志的果 */
export type Step = ActionStep | TickStep;

/** 动作裁决结果：一次动作过门的完整记录。 */
export interface ActionStep {
	kind: "action";
	ok: boolean;
	reason: string;
	changes: Change[];
	/** 参照域跨度：提交边界两侧的感知投影快照（落钟前闭合——刻步自带跨度）。 */
	field: FieldSpan;
	action: Action;
	/** 本动作授予的时间流逝（刻）：授予取规则 ticks 改写或动词时价，失败取动词时价（凡入裁决即尝试）。
	 *  时间律：世界时间只经裁决边界流逝，刻数由裁决授予；apply 据此在裁决边界内逐刻推进 systems。 */
	ticks: number;
	/** 否决来源：rule——动词卫语句链的否决（含全部规则未表态时的引擎闭合回落，law "action.unanswered"；
	 *  可见性门同归此值——感知是世界真相）；invariant——不变式硬墙的必要性拦截（规格违反信号或戏剧性必然）。*/
	deniedBy?: "rule" | "invariant";
	/** 结构化拒绝，供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
	/** 变更来源标识（law:<id> / rule:<verb> / system:<id>），审计依据。 */
	src?: string;
}

/** 动作裁决的完整解析：动作步（意志的果）+ 本动作授予执行出的刻步（世界的因）。
 *  二者在事件流中是并列形态（刻不是动作）；授予数以 ActionStep.ticks 为权威记录。 */
export interface Resolution {
	step: ActionStep;
	elapsed: TickStep[];
}

/** 世界刻步：一刻内某个系统的产出（at 为钟已走到的时刻） */
export interface TickStep {
	kind: "tick";
	at: number;
	ok: boolean;
	reason: string;
	changes: Change[];
	/** 参照域跨度：本系统提交边界两侧的感知投影快照。 */
	field: FieldSpan;
	/** 刻步只会被不变式硬墙拦截（系统产出没有其他否决路径）。 */
	deniedBy?: "invariant";
	denial?: Denial;
	facts?: Fact[];
	/** 变更来源标识（system:<id>），审计依据。 */
	src?: string;
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

/** 把结构化拒绝渲染为世界腔文本：优先 denial.reason（法则内联 text 渲染 / 可达性 prose / 不变式 message），缺省兜底 noResponse。 */
export function renderDenial(def: GameDef, denial: Denial): string {
	if (denial.reason != null) return denial.reason;
	return messagesFor(def).noResponse;
}

/** 离开状态者的名字底表：despawn 变更是其名字的唯一载体（名字随实体离开状态）。
 *  渲染历史事件（变更行/尝试行）时必须以渲染窗口内的 despawn 记录兜底解析。 */
export function departedNames(window: readonly { changes: Change[] }[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of window) for (const c of s.changes) if (c.kind === "despawn") m.set(c.entity, c.name);
	return m;
}

/** 声明驱动的取值渲染（渲染与投影的唯一解析点）：ref=true 的取值按引用解析——
 *  字符串元素解析为展示名（在世读态，或渲染窗口内的离场底表），解析不出原样回显，
 *  引用身份随 ids 返回（投影据此计指称，id 数组逐元素覆盖）；ref=false 一律字面。
 *  引用性是声明事实不是推断事实：只有关系端点（结构性引用）与注册表 type:"id" 的属性值是引用。 */
function renderValue(sim: Simulation, v: PropValue, ref: boolean, departed?: ReadonlyMap<string, string>): { text: string; ids: string[] } {
	if (!ref) return { text: String(v), ids: [] };
	const items = Array.isArray(v) ? v : [v];
	const texts: string[] = [];
	const ids: string[] = [];
	for (const item of items) {
		if (typeof item !== "string" || item === "") {
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

/** 变更的语言无关线性化（数据渲染，core 不内嵌语言词，只做符号连接，按 Change.kind 分派）。
 *  name/label/type 均为游戏声明的世界语；缺 label 时回退原 prop 名。
 *  指称解析走 renderValue（声明驱动）：关系端点是引用，关系值与未声明属性值是字面。
 *  渲染窗口内 despawn 的实体以 departed 兜底解析。 */
export function fmtChange(sim: Simulation, c: Change, departed?: ReadonlyMap<string, string>): string {
	if (c.kind === "spawn") return `+ ${c.name}`;
	if (c.kind === "despawn") return `- ${c.name}`;
	if (c.kind === "rename") return `~ ${c.prev} → ${c.next}`;
	if (c.kind === "rel") {
		const val = (v: PropValue): string => renderValue(sim, v, false, departed).text;
		return `${renderValue(sim, c.from, true, departed).text}.${c.type}.${renderValue(sim, c.to, true, departed).text}: ${val(c.prev)} → ${val(c.next)}`;
	}
	const e = sim.world.entities.find((x) => x.id === c.entity);
	const name = e?.name ?? departed?.get(c.entity) ?? c.entity;
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	const ref = refProp(sim, c.prop);
	return `${name}.${label}: ${renderValue(sim, c.prev, ref, departed).text} → ${renderValue(sim, c.next, ref, departed).text}`;
}

/** internal 属性变更过滤（internal 隔离的机械缺省）：internal 不进表达输入的变更线性化。 */
export function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	const internal = internalPropsOf(def);
	return changes.filter((c) => !(c.kind === "prop" && internal.has(c.prop)));
}

/** 变更行的指称集：与渲染器消费同一解析（renderValue）——渲染会说出名字之处，投影即数指称。
 *  主语、关系端点、声明为引用的属性取值（id 型标量与数组元素，解析与否不论——引用身份由声明，
 *  在场由投影审）。 */
function referentsOf(sim: Simulation, c: Change, departed: ReadonlyMap<string, string>): string[] {
	if (c.kind !== "prop") return c.kind === "rel" ? [c.from, c.to] : [c.entity];
	const ref = refProp(sim, c.prop);
	return [
		...renderValue(sim, c.prev ?? null, ref, departed).ids,
		...renderValue(sim, c.next ?? null, ref, departed).ids,
	];
}

/** 回合骨架：事件流的规范单行渲染（线级可说单元的唯一机械）。
 *  符号承担结构（✓/✗/⏱/×n），语言词全部来自 messages/label/规则文案。
 *  刻步按时刻归并：刻是世界的因果步，同刻多系统的产出共享一条 ⏱ 行。
 *  compact 省略变更行（近况投影：变更由状态视图承载，裁决行保留 verdict/理由/事实）；
 *  internal 属性变更恒滤（模型面纪律的机械保证，覆写者仍可从 steps 原样读取）。
 *  事件投影（受话人是体验者——与状态视图同一 grounding）：变更行按步的参照域跨度投影，
 *  全部指称在场才可说，任一缺席即整行沉默；理由与 Fact 是规则铸造的世界语，不过投影。
 *  无可说内容的刻并入尾部的静默流逝聚合 ×n。
 *  消费者：act 结果视图（模型）、近况（compact）、控制台、缺省回退摘要（玩家）。 */
export function spineLines(sim: Simulation, steps: Step[], opts?: { compact?: boolean }): string[] {
	// 先裁生灭行（指称只有主语，与离场名互不依赖）定「已公开离场者」：被投影的 despawn 不铸造合法名字，
	// 引用隐藏离场者的行在指称判定中随之沉默；指称匹配宇宙 = 在世实体 ∪ 窗口内全部离场者。
	const departedAll = departedNames(steps);
	const spanOf = (s: Step): Set<string> => new Set([...s.field.before, ...s.field.after]);
	const shownDeparted = new Map<string, string>();
	for (const s of steps) {
		const field = spanOf(s);
		for (const c of s.changes) if (c.kind === "despawn" && field.has(c.entity)) shownDeparted.set(c.entity, c.name);
	}
	const perceivableOf = (s: Step): ((c: Change) => boolean) => {
		const field = spanOf(s);
		// 边感知（与状态视图同一谓词的跨度快照）：rel 变更行要求边在跨度两侧知觉的并集内
		const edgeSpan = s.field.edges ? new Set([...s.field.edges.before, ...s.field.edges.after]) : undefined;
		return (c) => {
			if (c.kind === "rel" && edgeSpan && !edgeSpan.has(edgeKey(c))) return false;
			return referentsOf(sim, c, departedAll).every((r) => (departedAll.has(r) ? shownDeparted.has(r) : field.has(r)));
		};
	};
	const msgs = messagesFor(sim.def);
	const compact = opts?.compact === true;
	const lines: string[] = [];
	const said = new Map<number, { changes: Change[]; facts: Fact[] }>();
	for (const s of steps) {
		if (s.kind === "action") {
			const changes = compact ? [] : narratableChanges(sim.def, s.changes).filter(perceivableOf(s));
			const tail = [
				changes.length ? `（${changes.map((c) => fmtChange(sim, c, shownDeparted)).join("；")}）` : "",
				s.facts?.length ? `〔${s.facts.map((f) => f.text).join("；")}〕` : "",
			].join("");
			lines.push(`${s.ok ? "✓" : "✗"} ${sim.describeAction(s, shownDeparted)}：${s.reason}${tail}`);
		} else if (!s.ok) {
			// 被硬墙拦截的刻步：bug 信号，独立成行（不与同刻产出混写）
			lines.push(`⏱ ✗ ${s.reason || msgs.defaultReason}`);
		} else {
			const held = said.get(s.at) ?? { changes: [], facts: [] };
			if (!compact) held.changes.push(...narratableChanges(sim.def, s.changes).filter(perceivableOf(s)));
			if (s.facts?.length) held.facts.push(...s.facts);
			if (held.changes.length || held.facts.length) said.set(s.at, held);
		}
	}
	for (const { changes, facts } of said.values()) {
		lines.push(`⏱ ${[
			changes.length ? `（${changes.map((c) => fmtChange(sim, c, shownDeparted)).join("；")}）` : "",
			facts.length ? `〔${facts.map((f) => f.text).join("；")}〕` : "",
		].join("")}`);
	}
	// 静默刻聚合：每个被授予的刻恰有一个时间标记——同刻产出行、拦截行（独立 ⏱ ✗）、或 ×n 的一份
	const granted = steps.reduce((n, s) => n + (s.kind === "action" ? s.ticks : 0), 0);
	const deniedTicks = steps.reduce((n, s) => n + (s.kind === "tick" && !s.ok ? 1 : 0), 0);
	if (granted - said.size - deniedTicks > 0) lines.push(`⏱ ${msgs.timePassed} ×${granted - said.size - deniedTicks}`);
	return lines;
}

/** 属性读取 */
export function propGet(e: Entity, prop: string): PropValue {
	return e.props[prop] ?? null;
}

/** 关系查询：from→to 的指定 type 的值（无则 null）。 */
export function relVal(world: World, from: string, to: string, type: string): number | string | boolean | null {
	return world.relations?.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 关系查询：from 的全部关系边（可按 type 过滤）。 */
export function relAll(world: World, from: string, type?: string): Rel[] {
	return (world.relations ?? []).filter((r) => r.from === from && (type === undefined || r.type === type));
}

/** 裁决结果 + 未提交的 deltas（裁决与提交分离：apply 裁决后再经硬墙提交）；跨度由 apply 在提交边界闭合。 */
interface RawResult extends Omit<ActionStep, "kind" | "field"> {
	deltas: Delta[];
}

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
		for (const [name, v] of Object.entries(def.verbs)) {
			this.validators.set(name, Compile(Type.Object(v.schema.properties, { additionalProperties: false })));
			if (v.cost !== undefined && (!Number.isInteger(v.cost) || v.cost < 0)) throw new Error(`动词 ${name} 的 cost 须为非负整数刻数，得到 ${String(v.cost)}`);
			for (const p of v.beyondField ?? []) {
				if (!(v.entityParams ?? []).includes(p)) throw new Error(`动词 ${name} 的 beyondField「${p}」未声明为 entityParams——域外可指是引用参数的修饰，不是独立的参数通道`);
			}
		}
		// 「不变式管永远」包括起点：初始世界同样过墙（genesis = 自身，changes = 空）——
		// 否则 t=0 是必要性自由区，def 结构错误与损坏存档要到首次提交才以全量拒绝的形式显形。
		const broken = this.checkInvariants(this.readState(), []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.message}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		return this.visibleIn(this.readState());
	}

	/** 参照域计算：grounding 收冻结读态（投影是状态的函数——纯度按构造成立）。 */
	private visibleIn(world: World): Set<string> {
		if (this.def.grounding) return new Set(this.def.grounding(world, this.player));
		return new Set(world.entities.map((e) => e.id));
	}

	/** 边感知快照：结构过滤（端点可见）∧ 游戏语义谓词。*/
	private edgeField(world: World, vis: Set<string>): string[] | undefined {
		const perceive = this.def.edgePerception?.(world, this.player);
		if (!perceive) return undefined;
		const out: string[] = [];
		for (const r of world.relations ?? []) if (vis.has(r.from) && vis.has(r.to) && perceive(r)) out.push(edgeKey(r));
		return out;
	}

	/** 裁决时读态：快照 + 深冻结。裁决侧代码（Q.world / grounding / digestExtra / summarize）一律收此读态——
	 *  活世界不出 core，任何时机（含异步）无从触账本；它同时是提交的回滚基线 S0。 */
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

	/** 批次预校验：整批动作在首个裁决前过静态形态检查，违约即整批原子拒绝。
	 *  批次执行方（act 工具）必须在裁决循环前调用——否则第 n 个动作的静态违约会把
	 *  前 n-1 个已裁决动作变成不可说后果 */
	validateBatch(actions: readonly Action[]): void {
		for (const a of actions) this.staticForm(a);
	}

	/** 前态参照域与冻结读态由调用方（apply）逐动作计算传入：同一提案内的多动作不沿用旧读态。 */
	private adjudicateRaw(action: Action, curVis: Set<string>, world: World): RawResult {
		const msgs = messagesFor(this.def);
		const verb = this.staticForm(action);
		const cost = attemptCost(verb);
		// 门的管辖面 = 引用参数 − 域外可指（beyondField 的名字来源在实体索引之外，门无从审，法则层回答）
		const beyond = new Set(verb.beyondField ?? []);
		const invalid = (verb.entityParams ?? [])
			.filter((p) => !beyond.has(p))
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && id.length > 0 && !curVis.has(id));
		if (invalid.length) {
			// 门的世界腔是可见状态的函数：幻觉 id 与隐藏实体同一文案，不解析门外实体——
			// 「拒绝不携带涉及实体」在门上同样成立（审计 id 走 debug），否则 id 盲猜即存在性 oracle
			const reason = msgs.invisibleEntity ?? msgs.noResponse;
			return { ok: false, reason, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.invisible", reason, debug: invalid.join(",") }, ticks: cost };
		}
		const q = this.query(world, action.params);
		for (const r of verb.rules) {
			const v = r.judge(q);
			if (!v) continue;
			if (v.ok) {
				// 刻数不可执行即授予不可执行（世界不修正判决）：走不变式通道拒绝（probe 据此报 bug），尝试仍耗动词时价
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `rule ${r.id} ticks 须为非负整数刻数，得到 ${String(v.ticks)}` }, ticks: cost };
				}
				return { ok: true, reason: v.reason ?? messagesFor(this.def).defaultReason, changes: [], deltas: v.deltas, action, facts: v.facts, src: `rule:${r.id}`, ticks: v.ticks ?? cost };
			}
			return { ok: false, reason: renderDenial(this.def, v.denial), changes: [], deltas: [], action, deniedBy: "rule", denial: v.denial, ticks: cost };
		}
		return { ok: false, reason: messagesFor(this.def).noResponse, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.unanswered" }, ticks: cost };
	}

	private query(world: World, params: Record<string, PropValue>): Q {
		const player = this.player;
		return {
			world,
			player,
			time: world.time,
			params,
			entity: (id) => entity(world, id),
			name: (id) => entity(world, id)?.name ?? id,
			rel: (from, to, type) => relVal(world, from, to, type),
			relNum: (from, to, type, dflt) => {
				const v = relVal(world, from, to, type);
				if (v === null) return dflt;
				const n = Number(v);
				return Number.isFinite(n) ? n : dflt;
			},
			roll: (key, sides) => rollDice(world, key, sides),
			visible: () => this.visibleIn(world),
		};
	}

	/** 实际起点读态：首个提交前的深冻结快照（一切变异都经 commitChecked，此刻必为未变异状态）。 */
	private genesis(): World {
		return (this.genesisCache ??= this.readState());
	}

	/** 静态形态违约的机器诊断 */
	private schemaErrors(verbName: string, params: Record<string, PropValue>): string {
		const errs = this.validators.get(verbName)!.Errors(params);
		return errs.length ? errs.map((e) => `${e.instancePath} ${e.message}`).join("; ") : JSON.stringify(params);
	}

	/** 原子回滚：世界内容恢复为 s0（先删提交期间新建的顶层键——relations 等快照中不存在的——再整体覆写）。
	 *  s0 是裁决读态（深冻结）：回滚以克隆赋值解冻——冻结是裁决侧的读隔离手段，不是账本的属性，
	 *  冻结引用入账即砖死后续提交。 */
	private restore(s0: World): void {
		for (const k of Object.keys(this.world)) if (!(k in s0)) delete (this.world as unknown as Record<string, unknown>)[k];
		Object.assign(this.world, JSON.parse(JSON.stringify(s0)) as World);
	}

	/** 提交 + 硬墙：以裁决时读态 s0 为回滚基线（提交成功就地生效，任一翼违反即恢复 s0 并拒绝）。
	 *  提交内做执行校验（fidelity——每条 delta 在其应用时刻必须可执行），提交后做不变式校验；
	 *  渲染按产出方分流：core 完整性违反只有 debug 诊断（回落 noResponse）；游戏不变式的 message 直接作玩家文案。
	 *  提交过程的意外异常（规则铸出的坏 delta、审查者自身的 bug——含冻结读态上的越权写）同通道兑为墙否决。 */
	private commitChecked(s0: World, deltas: Delta[], src: string): { ok: boolean; changes: Change[]; denial?: Denial; reason?: string } {
		const genesis = this.genesis(); // 种子先于一切变异捕获：这里是唯一提交入口
		try {
			const out = this.commit(deltas, src);
			if ("refusal" in out) {
				this.restore(s0);
				return { ok: false, changes: [], denial: out.refusal, reason: messagesFor(this.def).noResponse };
			}
			const inv = this.checkInvariants(genesis, out.changes);
			if (inv) {
				this.restore(s0);
				const denial: Denial = inv.authored
					? { law: `invariant.${inv.id}`, reason: inv.message, debug: inv.message }
					: { law: `invariant.${inv.id}`, debug: inv.message };
				return { ok: false, changes: [], denial, reason: denial.reason ?? messagesFor(this.def).noResponse };
			}
			return { ok: true, changes: out.changes };
		} catch (e) {
			this.restore(s0);
			const debug = `commit/invariant threw: ${e instanceof Error ? e.message : String(e)}`;
			return { ok: false, changes: [], denial: { law: "invariant.crash", debug }, reason: messagesFor(this.def).noResponse };
		}
	}

	/** 运行全部不变式（先 core 引用完整性，后游戏声明），返回首个违反者。
	 *  审查者收冻结读态（world 取快照、changes 深冻结——与裁决侧同权隔离）。 */
	private checkInvariants(genesis: World, changes: Change[]): { id: string; message: string; authored: boolean } | null {
		const world = this.readState();
		const frozen = deepFreeze(changes);
		const integrity = integrityInvariant().check(world, { def: this.def, genesis, changes: frozen });
		if (integrity) return { id: "integrity", message: integrity, authored: false };
		for (const inv of this.def.invariants ?? []) {
			const msg = inv.check(world, { def: this.def, genesis, changes: frozen });
			if (msg) return { id: inv.id, message: msg, authored: true };
		}
		return null;
	}

	apply(action: Action): Resolution {
		// 结构墙：S0 = 裁决时读态（深冻结）；
		// 出口世界 ≡ S0 ⊕ 已提交 deltas 按构造成立。
		const s0 = this.readState();
		const before = this.visibleIn(s0);
		const edgesBefore = this.edgeField(s0, before);
		const r = this.adjudicateRaw(action, before, s0);
		let step: Omit<ActionStep, "field">;
		if (r.ok) {
			const src = r.src ?? `action:${action.verb}`;
			const cc = this.commitChecked(s0, r.deltas, src);
			if (!cc.ok) {
				// 硬墙回滚整个授予（含规则改写的刻数）：尝试本身仍消耗动词时价
				step = { kind: "action", ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], action, deniedBy: "invariant", denial: cc.denial, ticks: attemptCost(this.def.verbs[action.verb]) };
			} else {
				step = { kind: "action", ok: true, reason: r.reason, changes: cc.changes, action, facts: r.facts, src, ticks: r.ticks };
			}
		} else {
			step = { kind: "action", ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial, ticks: r.ticks };
		}
		// 跨度在落钟前闭合：提交边界是感知的离散单位，刻步自带跨度；
		// 无提交（法则拒绝或硬墙回滚）则边界未跨越——世界仍是前态，after 即 before
		const afterVis = step.ok ? this.visible() : before;
		const afterEdges = step.ok ? this.edgeField(this.world, afterVis) : edgesBefore;
		const field: FieldSpan = { before: [...before], after: [...afterVis] };
		if (edgesBefore && afterEdges) field.edges = { before: edgesBefore, after: afterEdges };
		const elapsed = step.ticks > 0 ? this.tick(step.ticks) : [];
		return { step: { ...step, field }, elapsed };
	}

	/** 动作线性化（label/name 为游戏世界语，core 只做符号连接）。
	 *  departed 兜底渲染窗口内已 despawn 的参数实体（同提交内先行动作生灭、后续动作被拒的尝试行）。
	 *  机械指称解析按声明进行且受步的参照域管辖：只有引用参数（entityParams）解析为名字，
	 *  其余参数一律字面——模型自己的词不是新信息；域内引用解析名字，
	 *  域外引用原样回显或以已公开离场者的名字兜底（可见性拒绝的参数必在域外——门以裁决前读态
	 *  为权威集、拒绝不提交）。 */
	describeAction(step: ActionStep, departed?: ReadonlyMap<string, string>): string {
		const action = step.action;
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const field = new Set([...step.field.before, ...step.field.after]);
		const refs = new Set(verb.entityParams ?? []);
		const parts = Object.entries(action.params).map(([k, v]) => {
			if (!refs.has(k) || typeof v !== "string") return String(v);
			if (field.has(v)) return entity(this.world, v)?.name ?? departed?.get(v) ?? v;
			return departed?.get(v) ?? v;
		});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	/** 落钟执行器 */
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
		const emit = (sr: TickStep): void => {
			out.push(sr);
		};
		for (const sys of this.def.systems ?? []) {
			const src = `system:${sys.id}`;
			const s0 = this.readState();
			const res = sys.run(this.query(s0, {}));
			if (!res || (res.deltas.length === 0 && !res.facts?.length)) continue;
			// 每系统的提交是独立过墙边界；回滚即未跨越——世界仍是前态，after 即 before
			const before = this.visibleIn(s0);
			const edgesBefore = this.edgeField(s0, before);
			const cc = this.commitChecked(s0, res.deltas, src);
			const afterVis = cc.ok ? this.visible() : before;
			const afterEdges = cc.ok ? this.edgeField(this.world, afterVis) : edgesBefore;
			const field: FieldSpan = { before: [...before], after: [...afterVis] };
			if (edgesBefore && afterEdges) field.edges = { before: edgesBefore, after: afterEdges };
			const at = this.world.time;
			if (!cc.ok) {
				emit({ kind: "tick", at, ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], deniedBy: "invariant", denial: cc.denial, src, field });
				continue;
			}
			emit({
				kind: "tick",
				at,
				ok: true,
				reason: res.facts?.length ? res.facts.map((f) => f.text).join(" ") : (res.reason ?? messagesFor(this.def).defaultReason),
				changes: cc.changes,
				facts: res.facts,
				src,
				field,
			});
		}
		return out;
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	/** 状态视图（唯一装配线）：prompt 的状态呈现由 core 组装——可见实体（grounding）× 注册表过滤
	 *  × 关系投影（端点可见的结构过滤 ∧ edgePerception 语义谓词）；def.digestExtra 派生纹理入独立 extra 键
	 *  参照域契约由构造保证：视图实体索引 ≡ 可见性门的权威集——模型看得见的才可指名，可指名的必看得见。 */
	digest(): string {
		const w = this.readState();
		const vis = this.visibleIn(w);
		const perceiveEdge = this.def.edgePerception?.(w, this.player);
		const entities = w.entities.filter((e) => vis.has(e.id)).map((e) => viewCard(this.def, e));
		const relations = (w.relations ?? []).filter((r) => vis.has(r.from) && vis.has(r.to) && (!perceiveEdge || perceiveEdge(r)));
		const view: Record<string, unknown> = { time: w.time, relations, entities };
		const extra = this.def.digestExtra?.(w, this.player) ?? {};
		if (Object.keys(extra).length) view.extra = extra;
		return JSON.stringify(view);
	}

	/** 回退摘要，缺省 = 回合骨架投影（空步回落 noResponse）。 */
	summarize(steps: Step[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.readState(), player: this.player, steps: deepFreeze(steps) });
		const lines = spineLines(this, steps);
		return lines.length ? lines.join("\n") : messagesFor(this.def).noResponse;
	}

	/** 提交 = 裁决的完整执行（执行翼；状态翼不变式在 commitChecked）。每条 delta 在其应用时刻必须可执行
	 *  逐条校验而非提交前预检：同一授予内 spawn 后 set 是合法书写
	 * 不可执行即拒绝整个提交（commitChecked 原子回滚，与不变式同一通道）
	 *  幂等跳过的唯一判据是目标状态已成立：relSet 删不存在的边成立（无边即状态，悬空端点之间本不容边）；
 *  set 同值与零效果增量以目标存在为前提——主语不存在的「已成立」不可判定，存在性拒绝在前，永不回落为跳过。 */
	private commit(deltas: Delta[], src: string): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		// 边表只在首个需要写入的边 delta 到来时入账
		// 一经入账，本提交内保持同一数组引用
		const rels = (): Rel[] => (this.world.relations ??= []);
		const upsertRel = (from: string, to: string, type: string, value: number | string | boolean) => {
			const rs = rels();
			const hit = rs.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else rs.push({ from, to, type, value });
		};
		const refuse = (debug: string): { refusal: Denial } => ({ refusal: { law: "invariant.commit", debug: `commit: ${debug}` } });
		const sayable = (v: PropValue): boolean => {
			if (typeof v === "number") return Number.isFinite(v);
			if (Array.isArray(v)) return v.every(sayable);
			if (v !== null && typeof v === "object") return Object.values(v).every(sayable);
			return true;
		};
		const dangling = (from: string, to: string): boolean => !entity(this.world, from) || !entity(this.world, to);
		for (const d of deltas) {
			if (d.op === "spawn") {
				if (entity(this.world, d.entity.id)) return refuse(`spawn "${d.entity.id}": entity already exists`);
				if (!sayable(d.entity.props)) return refuse(`spawn "${d.entity.id}": non-finite number in props`);
				this.world.entities.push(JSON.parse(JSON.stringify(d.entity)) as Entity);
				changes.push({ kind: "spawn", entity: d.entity.id, name: d.entity.name, src });
				continue;
			}
			if (d.op === "despawn") {
				const i = this.world.entities.findIndex((e) => e.id === d.entity);
				if (i < 0) return refuse(`despawn "${d.entity}": entity missing`);
				const gone = this.world.entities[i]!;
				this.world.entities.splice(i, 1);
				// 原地级联删边：只清已存在的边表，不为级联建表；同提交内后续边写入仍共享同一数组
				const existing = this.world.relations;
				if (existing) {
					for (let j = existing.length - 1; j >= 0; j--) {
						const r = existing[j]!;
						if (r.from === d.entity || r.to === d.entity) existing.splice(j, 1);
					}
				}
				changes.push({ kind: "despawn", entity: d.entity, name: gone.name, src });
				continue;
			}
			if (d.op === "relSet") {
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (prev === d.value) continue;
				if (dangling(d.from, d.to)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): endpoint missing`);
				if (!sayable(d.value)) return refuse(`relSet ${d.from}->${d.to} (${d.type}): non-finite number`);
				if (d.value === null) {
					// 值 null 即删边（拓扑收缩与生长对称）；能走到此处则边必已存在（prev !== null），rels() 只取已入账的数组；
					// 原地删——边表是本次提交共享的数组，不可整体替换
					const rs = rels();
					const i = rs.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) rs.splice(i, 1);
				} else {
					upsertRel(d.from, d.to, d.type, d.value);
				}
				changes.push({ kind: "rel", from: d.from, to: d.to, type: d.type, prev, next: d.value, src });
				continue;
			}
			if (d.op === "relInc") {
				if (dangling(d.from, d.to)) return refuse(`relInc ${d.from}->${d.to} (${d.type}): endpoint missing`);
				const cur = relVal(this.world, d.from, d.to, d.type);
				const prev = cur ?? 0;
				if (typeof prev !== "number" || !Number.isFinite(prev)) return refuse(`relInc ${d.from}->${d.to} (${d.type}): current value is not a finite number`);
				const next = prev + d.by;
				if (!Number.isFinite(next)) return refuse(`relInc ${d.from}->${d.to} (${d.type}): result is not a finite number`);
				if (next === prev) continue;
				upsertRel(d.from, d.to, d.type, next);
				changes.push({ kind: "rel", from: d.from, to: d.to, type: d.type, prev, next, src });
				continue;
			}
			if (d.op === "rename") {
				const e = entity(this.world, d.entity);
				if (!e) return refuse(`rename "${d.entity}": target entity missing`);
				if (typeof d.value !== "string" || d.value === "") return refuse(`rename "${d.entity}": name must be non-empty string`);
				if (e.name === d.value) continue;
				const prev = e.name;
				e.name = d.value;
				changes.push({ kind: "rename", entity: d.entity, prev, next: d.value, src });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) return refuse(`${d.op} "${d.entity}.${d.prop}": target entity missing`);
			if (d.op === "set") {
				if (!sayable(d.value)) return refuse(`set "${d.entity}.${d.prop}": non-finite number`);
				const prev = e.props[d.prop] ?? null;
				if (prev === d.value) continue;
				e.props[d.prop] = d.value;
				changes.push({ kind: "prop", entity: d.entity, prop: d.prop, prev, next: d.value, src });
			} else {
				const cur = e.props[d.prop];
				const prev = cur ?? 0;
				if (typeof prev !== "number" || !Number.isFinite(prev)) return refuse(`inc "${d.entity}.${d.prop}": current value is not a finite number`);
				const next = prev + d.by;
				if (!Number.isFinite(next)) return refuse(`inc "${d.entity}.${d.prop}": result is not a finite number`);
				if (next === prev) continue;
				e.props[d.prop] = next;
				changes.push({ kind: "prop", entity: d.entity, prop: d.prop, prev, next, src });
			}
		}
		return { changes };
	}
}
