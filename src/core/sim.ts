import { Compile } from "typebox/compile";
import { Type, type Static, type TObject } from "typebox";
import { roll as rollDice } from "./util.ts";

export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue };

export interface Entity {
	id: string;
	name: string;
	kind: string;
	tags: string[];
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
 *  提交产出按基底类别同构分形的 Change（kind: prop/rel/spawn/despawn）
 *  spawn/despawn：实体生灭（梦核/authored 世界的动态拓扑原语；relSet 建边/删边（值 null），配合生灭原语让拓扑生长与收缩对称）。
 *  despawn 只级联清理核心结构（关系边）；id 型属性引用不清扫——悬空引用由完整性硬墙回滚。 */
export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "inc"; entity: string; prop: string; by: number }
	| { op: "relSet"; from: string; to: string; type: string; value: number | string | boolean | null }
	| { op: "relInc"; from: string; to: string; type: string; by: number }
	| { op: "spawn"; entity: Entity }
	| { op: "despawn"; entity: string };

/** 世界变更记录（快照线以下的数据协议，commit 的唯一产出）：与 Delta 按基底类别同构——属性写 / 关系边写 / 实体生灭。
 *  set/inc 合流为 prop（提交后不区分操作形态，prev/next 即差异）；rel 携带完整边端点（from/to）与边值（prev/next，next null 即删边）——
 *  spawn/despawn 的 name 是生灭实体的展示名（实体已离开状态，变更是唯一载体）。*/
export type Change =
	| { kind: "prop"; entity: string; prop: string; prev: PropValue; next: PropValue; src: string }
	| { kind: "rel"; from: string; to: string; type: string; prev: PropValue; next: PropValue; src: string }
	| { kind: "spawn"; entity: string; name: string; src: string }
	| { kind: "despawn"; entity: string; name: string; src: string };

/** 动作提案：由游戏声明的动词表（verb）驱动，参数由动词 schema 约束。 */
export interface Action {
	verb: string;
	params: Record<string, PropValue>;
}

/** core 产出的用户可见文案契约：由游戏经 GameDef.messages 必填注入自有语言，core 不内嵌任何语言。
 *  契约只收解析后的 referent（实体名等世界语），不收 id/属性名——机器诊断一律走 Denial.debug。 */
export interface Messages {
	/** 所有法则均未表态时的兜底回应；core 完整性不变式违反也回落此文案。 */
	noResponse: string;
	/** 实体参数不可见/不存在（core 校验层拒绝）：收已存在实体的解析名；全为幻觉 id 时为空列表。 */
	invisibleEntity?: (names: string[]) => string;
	/** 规则授予但未提供世界腔理由时的占位文案。 */
	defaultReason: string;
	/** act 门闩拦截（本回合已裁决后误调 act 工具时的防御性拒绝）。 */
	notInActionPhase: string;
	/** 时间流逝的世界腔描述（刻步的段头与近况渲染；事件流中刻不是动作）。 */
	timePassed: string;
}

/** 法则产出的世界腔事实：进结果视图，供叙述跟随。 */
export interface Fact {
	/** 世界腔陈述。 */
	text: string;
	/** 陈述涉及的实体 id（审计依据，不进世界腔策展）。 */
	entities: string[];
}

/** 属性类型。 */
export type PropType = "string" | "number" | "boolean" | "id" | "any";

/** 属性注册表条目：类型的声明、世界化标签、内部标记 */
export interface PropDef {
	type: PropType;
	/** 世界化说法（拒绝/变更文本里的属性名）。 */
	label?: string;
	/** 内部属性：不进 LLM 序列化、不进变更线性化（从源头杜绝泄漏）。 */
	internal?: boolean;
}

/** 结构化拒绝：法则身份 + 世界腔理由 + 机器诊断 + 兜底自声明。 */
export interface Denial {
	/** 法则标识 */
	law: string;
	/** 世界腔拒绝文案（法则 text 内联渲染 / 可达性构件 prose / 不变式 message）；缺省回落到 messages.noResponse。 */
	reason?: string;
	/** 审计用诊断（不进玩家文案；如不变式拒绝详情）。 */
	debug?: string;
	/** 作者的兜底自声明：probe 据此报告法则缺口 */
	fallback?: boolean;
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

// ---------- 法则内核：规则即代码，产出即数据（快照线以下是 Delta/Denial/Fact） ----------

/** 规则判定上下文：只读世界视图 + 引擎自有语义的唯一入口（关系/骰子/时间/可见性）。
 *  约束：规则只读不写，一切后果经返回的 Delta 表达，由模拟层统一提交/回滚。 */
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
	/** 确定性骰子（World 纯函数，check/apply/dryTick 一致）。 */
	roll(key: string, sides: number): number;
	visible(): Set<string>;
}

/** 裁决：授予（未提交 deltas + 世界腔理由 + facts + 授予刻数）或结构化拒绝；规则返回 null = 不表态。
 *  ticks 是时间律的规则面（DESIGN 公理三）：改写本动作的实际流逝（缺省回落动词时价）。 */
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

export function deny(law: string, o: { reason?: string; fallback?: boolean } = {}): Verdict {
	return { ok: false, denial: { law, ...o } };
}

/** 兜底规则：无条件拒绝，Denial 带 fallback 自声明标记（probe 据此报告法则缺口）。 */
export function fallback(id: string, text: (q: Q) => string): Rule {
	return { id, judge: (q: Q) => deny(id, { reason: text(q), fallback: true }) };
}

/** Delta 构造糖。 */
export const D = {
	set: (entity: string, prop: string, value: PropValue): Delta => ({ op: "set", entity, prop, value }),
	inc: (entity: string, prop: string, by: number): Delta => ({ op: "inc", entity, prop, by }),
	relSet: (from: string, to: string, type: string, value: number | string | boolean | null): Delta => ({ op: "relSet", from, to, type, value }),
	relInc: (from: string, to: string, type: string, by: number): Delta => ({ op: "relInc", from, to, type, by }),
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
	rules: { id: string; judge: (q: Q, p: Static<S>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		cost: spec.cost,
		// 工具边界与内核前置条件同一严格度：多余参数在工具层被拒，而非到内核才触发 ProtocolViolation
		schema: { ...spec.schema, additionalProperties: false },
		entityParams: spec.entityParams,
		rules: spec.rules.map((r) => ({ id: r.id, judge: (q: Q) => r.judge(q, q.params as Static<S>) })),
	};
}

/** 从 deltas + facts 收集涉及实体（审计依据；世界腔策展不渲染参与清单）。 */
function collectInvolved(deltas: Delta[], facts: Fact[] = []): string[] {
	const s = new Set<string>();
	for (const d of deltas) {
		if (d.op === "spawn") s.add(d.entity.id);
		else if (d.op === "despawn") s.add(d.entity);
		else if (d.op === "set" || d.op === "inc") s.add(d.entity);
		else {
			s.add(d.from);
			s.add(d.to);
		}
	}
	for (const f of facts) for (const e of f.entities) s.add(e);
	return [...s];
}

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: TObject;
	/** 尝试时价（刻，缺省 0）：凡入裁决即尝试，成败皆消耗。规则可在授予中以 ticks 改写实际流逝。 */
	cost?: number;
	/** 声明哪些参数是实体 id（供可见性校验与探测）。 */
	entityParams?: string[];
	/** 卫语句式规则：按序裁决，首个表态即判决；末条可为 fallback 兜底。 */
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
	/** 属性注册表：属性类型/世界化标签/内部标记/值域。状态视图与变更线性化读 internal（internal 隔离由 core 机械保证），describeAction 与拒绝渲染读 label。缺省空注册表（全部属性视为普通可见属性）。 */
	props?: Record<string, PropDef>;
	/** 确定性回退摘要钩子（player = 意志居所）。 */
	summarize?: (input: { world: World; changes: Change[]; player: string }) => string;
	/** 近况窗口的回合数（映射层的指代视野）。缺省 0。*/
	memoryLimit?: number;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见（未声明认识论语义的诚实零） */
	grounding?: (world: World, player: string) => string[];
	/** 状态视图的派生纹理（世界 + 玩家 → 顶层附加字段）：出口、随身清单等游戏自持语义的呈现。
	 *  无 id 承诺：参照域由 core 装配并保证 ≡ 可见性门，extra 不承载它；携带可指名 id 时应配合
	 *  非 entityParams 参数消费（地点恒可指名，由法则层回答）。 */
	digestExtra?: (world: World, player: string) => Record<string, PropValue>;
	/** 不变式：提交后校验，违反即回滚整个提交并拒绝。core 默认恒挂引用完整性硬墙。 */
	invariants?: Invariant[];
	/** core 产出的用户可见文案（游戏自有语言，必填：core 不内嵌任何语言，缺省即空，倒逼游戏注入）。 */
	messages: Messages;
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
 *  过渡不变式经 ctx.changes 读提交（provenance 类，防错误再分配）。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

/** core 默认硬墙：引用完整性与注册表类型契约——实体 id 唯一、id 型属性（标量或引用数组）与关系端点指向存在的实体、
 *  注册属性的值与声明类型一致（number 拒非有限值：NaN/Infinity 经 JSON 序列化静默变 null，是账本腐蚀通道；
 *  null/缺席为缺省惯例放行，any 显式豁免）。世界全域扫描：spawn 整包与 t=0 构造期自动覆盖。
 *  检测规则把世界改坏的 bug（悬空引用、类型错写），任何提交都无法绕过。 */
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
			// playerId 是 def 指向世界的唯一数据引用（体验者推导与感知钩子的解引用原点），每次裁决都被解引用，
			// 属于「引擎将解引用的引用必须可解」的墙的管辖——否则 despawn 主体静默过墙，后续裁决级联劣化。
			if (!ids.has(ctx.def.playerId)) return `integrity: playerId -> missing entity ${ctx.def.playerId}`;
			const registry = Object.entries(ctx.def.props ?? {});
			for (const e of world.entities) {
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

/** 获取游戏声明的用户可见文案（core 不内嵌任何语言，由游戏必填注入）。 */
export function messagesFor(def: GameDef): Messages {
	return def.messages;
}

/** 从属性注册表计算内部属性集（不进序列化/变更线性化）。 */
export function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

/** 属性世界化标签（拒绝/变更文本中的说法；无则返回 undefined）。 */
export function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
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
	action: Action;
	/** 本动作授予的时间流逝（刻）：授予取规则 ticks 改写或动词时价，失败取动词时价（凡入裁决即尝试）。
	 *  时间律：世界时间只经裁决边界流逝，刻数由裁决授予；apply 据此在裁决边界内逐刻推进 systems。 */
	ticks: number;
	/** 否决来源：rule——动词法则网络的否决（含全部规则未表态时的引擎闭合回落，law "action.unanswered"；
	 *  可见性门同归此值——感知是世界真相）；invariant——不变式硬墙的必要性拦截（规格违反信号或戏剧性必然）。*/
	deniedBy?: "rule" | "invariant";
	/** 结构化拒绝，供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
	/** 变更来源标识（law:<id> / rule:<verb> / system:<id>），审计依据。 */
	src?: string;
}

/** 动作裁决的完整解析：动作步（意志的果）+ 本动作授予执行出的刻步（世界的因）。
 *  二者在事件流中是并列形态（刻不是动作）；授予数以 ActionStep.ticks 为权威记录。 */
export interface Resolution {
	step: ActionStep;
	elapsed: TickStep[];
}

/** 世界刻步：一刻内某个系统的产出（at 为钟已走到的时刻）。零产出系统不产生条目。 */
export interface TickStep {
	kind: "tick";
	at: number;
	ok: boolean;
	reason: string;
	changes: Change[];
	/** 刻步只会被不变式硬墙拦截（系统产出没有其他否决路径）。 */
	deniedBy?: "invariant";
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
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

/** 离开状态者的名字底表：despawn 变更是其名字的唯一载体（身份卡随实体离开状态）。
 *  渲染历史事件（变更行/尝试行）时必须以渲染窗口内的 despawn 记录兜底解析。 */
export function departedNames(window: readonly { changes: Change[] }[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of window) for (const c of s.changes) if (c.kind === "despawn") m.set(c.entity, c.name);
	return m;
}

/** 值的语言无关取值：id 解析为展示名，其余原样字符串化。 */
export function fmtValue(sim: Simulation, v: PropValue, departed?: ReadonlyMap<string, string>): string {
	if (v === null) return "null";
	if (typeof v === "string") {
		const hit = sim.world.entities.find((e) => e.id === v);
		if (hit) return hit.name;
		const gone = departed?.get(v);
		if (gone !== undefined) return gone;
	}
	return String(v);
}

/** 变更的语言无关线性化（数据渲染，core 不内嵌语言词，只做符号连接，按 Change.kind 分派）：
 *  普通变更 `<name>.<label>: <prev> → <next>`；rel 变更 `<from>.<type>.<to>: <prev> → <next>`；生灭 `+ name` / `- name`。
 *  name/label/type 均为游戏声明的世界语；缺 label 时回退原 prop 名。
 *  渲染窗口内 despawn 的实体以 departed 兜底解析。 */
export function fmtChange(sim: Simulation, c: Change, departed?: ReadonlyMap<string, string>): string {
	if (c.kind === "spawn") return `+ ${c.name}`;
	if (c.kind === "despawn") return `- ${c.name}`;
	if (c.kind === "rel") return `${fmtValue(sim, c.from, departed)}.${c.type}.${fmtValue(sim, c.to, departed)}: ${fmtValue(sim, c.prev, departed)} → ${fmtValue(sim, c.next, departed)}`;
	const e = sim.world.entities.find((x) => x.id === c.entity);
	const name = e?.name ?? departed?.get(c.entity) ?? c.entity;
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	return `${name}.${label}: ${fmtValue(sim, c.prev, departed)} → ${fmtValue(sim, c.next, departed)}`;
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

/** 裁决结果 + 未提交的 deltas（裁决与提交分离：apply 裁决后再经硬墙提交）。 */
interface RawResult extends Omit<ActionStep, "kind"> {
	deltas: Delta[];
}

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	/** 不变式种子：实际起点世界的冻结副本，首次提交前惰性捕获（无不变式的路径零成本）。 */
	private genesisCache?: World;
	/** 骰子键碰撞追踪：同一动作复现同值是随机推论的必然，同刻键重复才是隐性相关 bug。 */
	private rollEpoch = -1;
	private readonly rollKeys = new Set<string>();
	/** 动词参数严格校验器（additionalProperties:false），构造期从动词 schema 编译——所有入口（act 工具/场景/CLI/probe）共用同一裁决瓶颈。 */
	private readonly validators = new Map<string, ReturnType<typeof Compile>>();

	/** 缺省克隆 def.world 作为初始世界；显式传入 world（存档恢复/dryTick 克隆源）则以其为完整真相。 */
	constructor(def: GameDef, world?: World) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(world ?? def.world)) as World;
		for (const [name, v] of Object.entries(def.verbs)) {
			this.validators.set(name, Compile(Type.Object(v.schema.properties, { additionalProperties: false })));
			if (v.cost !== undefined && (!Number.isInteger(v.cost) || v.cost < 0)) throw new Error(`动词 ${name} 的 cost 须为非负整数刻数，得到 ${String(v.cost)}`);
		}
		// 「不变式管永远」包括起点：初始世界同样过墙（genesis = 自身，changes = 空）——
		// 否则 t=0 是必要性自由区，def 结构错误与损坏存档要到首次提交才以全量拒绝的形式显形。
		const broken = this.checkInvariants(this.world, []);
		if (broken) throw new Error(`初始世界违反不变式 ${broken.id}：${broken.message}`);
	}

	get player(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		if (this.def.grounding) return new Set(this.def.grounding(this.world, this.player));
		return new Set(this.world.entities.map((e) => e.id));
	}

	private adjudicateRaw(action: Action): RawResult {
		const msgs = messagesFor(this.def);
		const verb = this.def.verbs[action.verb];
		if (!verb) throw new ProtocolViolation("action.unknown", `verb:${action.verb}`);
		const cost = attemptCost(verb);
		if (!this.validators.get(action.verb)!.Check(action.params)) {
			throw new ProtocolViolation("action.schema", this.schemaErrors(action.verb, action.params));
		}
		// 可见性按当前状态逐动作计算：同一提案内的多动作不沿用旧快照。
		const curVis = this.visible();
		const invalid = (verb.entityParams ?? [])
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && id.length > 0 && !curVis.has(id));
		if (invalid.length) {
			// 世界腔由游戏 messages 注入：已存在但不可见的实体收解析名，幻觉 id 无名字（收空列表）
			const first = invalid[0]!;
			const hit = entity(this.world, first);
			const reason = msgs.invisibleEntity?.(hit ? [hit.name] : []) ?? msgs.noResponse;
			return { ok: false, reason, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.invisible", reason, debug: invalid.join(",") }, ticks: cost };
		}
		const q = this.query(action.params);
		for (const r of verb.rules) {
			const v = r.judge(q);
			if (!v) continue;
			if (v.ok) {
				// 刻数不可执行即授予不可执行（世界不修正判决）：走不变式通道拒绝（probe 据此报 bug），尝试仍耗动词时价
				if (v.ticks !== undefined && (!Number.isInteger(v.ticks) || v.ticks < 0)) {
					return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "invariant", denial: { law: "invariant.grant", debug: `rule ${r.id} ticks 须为非负整数刻数，得到 ${String(v.ticks)}` }, ticks: cost };
				}
				return { ok: true, reason: v.reason ?? messagesFor(this.def).defaultReason, changes: [], deltas: v.deltas, action, facts: v.facts, involved: collectInvolved(v.deltas, v.facts), src: `rule:${r.id}`, ticks: v.ticks ?? cost };
			}
			return { ok: false, reason: renderDenial(this.def, v.denial), changes: [], deltas: [], action, deniedBy: "rule", denial: v.denial, ticks: cost };
		}
		return { ok: false, reason: messagesFor(this.def).noResponse, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.unanswered", fallback: true }, ticks: cost };
	}

	/** 构造规则判定上下文：引擎隐式语义在此唯一收口。 */
	private query(params: Record<string, PropValue>): Q {
		const world = this.world;
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
			roll: (key, sides) => {
				this.traceRollKey(key);
				return rollDice(world, key, sides);
			},
			visible: () => this.visible(),
		};
	}

	/** 同一时刻内骰子键应唯一：重复即两个不同判定共享同一随机值（隐性相关 bug）。 */
	private traceRollKey(key: string): void {
		if (this.world.time !== this.rollEpoch) {
			this.rollEpoch = this.world.time;
			this.rollKeys.clear();
		}
		if (this.rollKeys.has(key)) console.warn(`[sim] t${this.world.time} 骰子键重复：「${key}」——同一时刻两个判定共享同一随机值，应把实体 id 等并入 key`);
		else this.rollKeys.add(key);
	}

	/** 实际起点世界：首个提交前的冻结快照（一切变异都经 commitChecked，此刻必为未变异状态）。 */
	private genesis(): World {
		return (this.genesisCache ??= this.snapshot());
	}

	/** 静态形态违约的机器诊断（进 ProtocolViolation.debug）。 */
	private schemaErrors(verbName: string, params: Record<string, PropValue>): string {
		const errs = this.validators.get(verbName)!.Errors(params);
		return errs.length ? errs.map((e) => `${e.instancePath} ${e.message}`).join("; ") : JSON.stringify(params);
	}

	/** 提交 + 硬墙：先快照；提交内做执行校验（fidelity——裁决必须被完整执行），提交后做不变式校验（执行后的世界必须成立）；
	 *  任一翼违反即原子回滚整个提交并拒绝。渲染按产出方分流：core 完整性违反只有 debug 诊断（回落 noResponse）；
	 *  游戏不变式的 message 是游戏撰写的世界腔，直接作玩家文案。 */
	private commitChecked(deltas: Delta[], src: string): { ok: boolean; changes: Change[]; denial?: Denial; reason?: string } {
		const genesis = this.genesis(); // 种子先于一切变异捕获：这里是唯一提交入口
		const before = this.snapshot();
		const rollback = (): void => {
			// 先删掉提交期间新建的键（relations 等快照中不存在的），再整体恢复。
			for (const k of Object.keys(this.world)) if (!(k in before)) delete (this.world as unknown as Record<string, unknown>)[k];
			Object.assign(this.world, before);
		};
		const out = this.commit(deltas, src);
		if ("refusal" in out) {
			rollback();
			return { ok: false, changes: [], denial: out.refusal, reason: messagesFor(this.def).noResponse };
		}
		const inv = this.checkInvariants(genesis, out.changes);
		if (inv) {
			rollback();
			const denial: Denial = inv.authored
				? { law: `invariant.${inv.id}`, reason: inv.message, debug: inv.message }
				: { law: `invariant.${inv.id}`, debug: inv.message };
			return { ok: false, changes: [], denial, reason: denial.reason ?? messagesFor(this.def).noResponse };
		}
		return { ok: true, changes: out.changes };
	}

	/** 运行全部不变式（先 core 引用完整性，后游戏声明），返回首个违反者（authored 标记产出方）。 */
	private checkInvariants(genesis: World, changes: Change[]): { id: string; message: string; authored: boolean } | null {
		const integrity = integrityInvariant().check(this.world, { def: this.def, genesis, changes });
		if (integrity) return { id: "integrity", message: integrity, authored: false };
		for (const inv of this.def.invariants ?? []) {
			const msg = inv.check(this.world, { def: this.def, genesis, changes });
			if (msg) return { id: inv.id, message: msg, authored: true };
		}
		return null;
	}

	apply(action: Action): Resolution {
		const r = this.adjudicateRaw(action);
		let step: ActionStep;
		if (r.ok) {
			const src = r.src ?? `action:${action.verb}`;
			const cc = this.commitChecked(r.deltas, src);
			if (!cc.ok) {
				// 硬墙回滚整个授予（含规则改写的刻数）：尝试本身仍消耗动词时价
				step = { kind: "action", ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], action, deniedBy: "invariant", denial: cc.denial, ticks: attemptCost(this.def.verbs[action.verb]) };
			} else {
				step = { kind: "action", ok: true, reason: r.reason, changes: cc.changes, action, facts: r.facts, involved: r.involved, src, ticks: r.ticks };
			}
		} else {
			step = { kind: "action", ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial, ticks: r.ticks };
		}
		const elapsed = step.ticks > 0 ? this.tick(step.ticks) : [];
		return { step, elapsed };
	}

	/** 动作线性化（fmtChange 同一纪律：label/name 为游戏世界语，core 只做符号连接）。
	 *  departed 兜底渲染窗口内已 despawn 的参数实体（同提交内先行动作生灭、后续动作被拒的尝试行）。 */
	describeAction(action: Action, departed?: ReadonlyMap<string, string>): string {
		const verb = this.def.verbs[action.verb];
		if (!verb) return action.verb;
		const name = (v: PropValue): string => {
			if (typeof v === "string") {
				const hit = entity(this.world, v);
				if (hit) return hit.name;
				const gone = departed?.get(v);
				if (gone !== undefined) return gone;
			}
			return String(v);
		};
		const entityParams = new Set(verb.entityParams ?? []);
		const parts = Object.entries(action.params).map(([k, v]) => {
			if (entityParams.has(k)) return name(v);
			if (typeof v === "string") return name(v);
			return String(v);
		});
		return parts.length ? `${verb.label}(${parts.join(",")})` : verb.label;
	}

	/** 协议外裸钟：不经裁决直接推进 n 刻并运行 systems（时间律的显式豁免通道，测试/开发工具用）。
	 *  产品路径的唯一合法时钟在 apply 的裁决边界内。 */
	tick(n = 1): TickStep[] {
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
			const res = sys.run(this.query({}));
			// 纯氛围输出（fact-only，无状态变更）同样成立——氛围系统的合法通道
			if (!res || (res.deltas.length === 0 && !res.facts?.length)) continue;
			const cc = this.commitChecked(res.deltas, src);
			const at = this.world.time;
			if (!cc.ok) {
				emit({ kind: "tick", at, ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], deniedBy: "invariant", denial: cc.denial, src });
				continue;
			}
			emit({
				kind: "tick",
				at,
				ok: true,
				reason: res.facts?.length ? res.facts.map((f) => f.text).join(" ") : (res.reason ?? messagesFor(this.def).defaultReason),
				changes: cc.changes,
				facts: res.facts,
				involved: collectInvolved(res.deltas, res.facts),
				src,
			});
		}
		return out;
	}

	/** 克隆世界，模拟 n 个 tick，返回将要发生的变更（不改变自身状态）。合法外推原语：纯函数派生自状态，
	 *  克隆即完整外推（无需序列快照机制）——但派生合法 ≠ 必然：下一动作的 deltas 先于预测刻落地，外推可被干预作废。*/
	dryTick(n = 1): TickStep[] {
		const clone = new Simulation(this.def, this.world);
		return clone.tick(n);
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	/** 状态视图（唯一装配线）：prompt 的状态呈现由 core 组装——可见实体（grounding）× 注册表过滤
	 *  × 关系端点可见过滤，顶层并入 def.digestExtra 派生纹理。
	 *  参照域契约由构造保证：视图实体索引 ≡ 可见性门的权威集——模型看得见的才可指名，可指名的必看得见。 */
	digest(): string {
		const vis = this.visible();
		const internal = internalPropsOf(this.def);
		const entities = this.world.entities
			.filter((e) => vis.has(e.id))
			.map((e) => ({
				id: e.id,
				name: e.name,
				kind: e.kind,
				tags: e.tags,
				props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
			}));
		const relations = (this.world.relations ?? []).filter((r) => vis.has(r.from) && vis.has(r.to));
		const extra = this.def.digestExtra?.(this.world, this.player) ?? {};
		// 保留键归装配线：extra 不得覆写 time/relations/entities（参照域契约的构造保证），冲突键被忽略并告警
		const collisions = Object.keys(extra).filter((k) => k === "time" || k === "relations" || k === "entities");
		if (collisions.length) console.warn(`[sim] digestExtra 与状态视图保留键冲突（被忽略）：${collisions.join("、")}`);
		return JSON.stringify({ ...extra, time: this.world.time, relations, entities });
	}

	/** 提交 = 裁决的完整执行（执行翼；状态翼不变式在 commitChecked）。每条 delta 在其应用时刻必须可执行
	 *  （逐条校验而非提交前预检：同一授予内 spawn 后 set 是合法书写）：目标实体/关系端点必须存在、spawn 的 id 必须未占用、
	 *  inc/relInc 的现值必须是有限数（缺席/null 按 0 的既定语义——承重墙泛化承重于它，如 field.grow 对新实体；
	 *  非数现值拒绝而非静默跳过或改写类型）、一切数值后果必须有限可说（NaN/Infinity 无法经 JSON 存活，
	 *  序列化即静默变 null——账本腐蚀通道在提交侧封死）。不可执行即拒绝整个提交（commitChecked 原子回滚，
	 *  与不变式同一通道）——裁决是判决，世界执行它或拒绝它，从不修正它；静默丢弃 delta 即裁决理由对变更流说谎。
	 *  幂等跳过的唯一判据是目标状态已成立：relSet 删不存在的边成立（无边即状态，悬空端点之间本不容边）；
 *  set 同值与零效果增量以目标存在为前提——主语不存在的「已成立」不可判定，存在性拒绝在前，永不回落为跳过。 */
	private commit(deltas: Delta[], src: string): { changes: Change[] } | { refusal: Denial } {
		const changes: Change[] = [];
		const rels = (this.world.relations = this.world.relations ?? []);
		const upsertRel = (from: string, to: string, type: string, value: number | string | boolean) => {
			const hit = rels.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else rels.push({ from, to, type, value });
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
				// 原地级联删边：rels 是本次提交共享的数组，必须保持引用有效（重赋值会让同提交内后续 relSet/relInc 写入失联数组）
				for (let j = rels.length - 1; j >= 0; j--) {
					const r = rels[j]!;
					if (r.from === d.entity || r.to === d.entity) rels.splice(j, 1);
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
					// 值 null 即删边（拓扑收缩与生长对称）；原地删——rels 是本次提交共享的数组，不可整体替换
					const i = rels.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
					if (i >= 0) rels.splice(i, 1);
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
