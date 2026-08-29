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
	/** 所有法则均未表态时的兜底回应；协议性拒绝（映射层形态错误）与 core 完整性不变式违反也回落此文案。 */
	noResponse: string;
	/** 实体参数不可见/不存在（core 校验层拒绝）：收已存在实体的解析名；全为幻觉 id 时为空列表。 */
	invisibleEntity?: (names: string[]) => string;
	/** 施动工具前提拒绝（core 产出，游戏注入语言）：工具不可持握时渲染（name 为工具实体名）。 */
	instrumentUnholdable?: (name: string) => string;
	/** 施动工具前提拒绝（core 产出，游戏注入语言）：工具可达性不满足时渲染（name 为工具实体名）。 */
	instrumentUnreachable?: (name: string) => string;
	/** 规则授予但未提供世界腔理由时的占位文案。 */
	defaultReason: string;
	/** act 门闩拦截（本回合已裁决后误调 act 工具时的防御性拒绝）。 */
	notInActionPhase: string;
	/** 时间流逝动作（TICK_VERB）的世界腔描述。 */
	timePassed: string;
}

/** 法则背书的结构化新事实：表达层的合法新事实词汇，防止模型发明后果。 */
export interface Fact {
	/** 世界腔陈述。 */
	text: string;
	/** 陈述涉及的实体 id（声明校验的集合成员依据）。 */
	entities: string[];
	/** 认识论身份：percept（缺省）＝对世界状态的知觉，实体进声明契约 touched 集；
	 *  utterance＝世界之言（氛围话语/低语），实体不进 touched——话语只许被转述，不许据以断言状态。 */
	kind?: "percept" | "utterance";
}

/** 属性类型。 */
export type PropType = "string" | "number" | "boolean" | "id" | "any";

/** 属性注册表条目：类型的声明、世界化标签、内部标记、可选值域。
 *  取代 GameDef 的 internalProps（internal 标记）与 propLabels（label）。 */
export interface PropDef {
	type: PropType;
	/** 世界化说法（拒绝/变更文本里的属性名）。 */
	label?: string;
	/** 内部属性：不进 LLM 序列化、不进变更列表、不进表达校验（从源头杜绝泄漏）。 */
	internal?: boolean;
	/** 润饰属性：表达层可对此属性做合理文学润饰（系统提示注入可润饰属性，如「刻痕斑驳」）。
	 *  非润饰的物理属性须与状态严格一致 */
	stylistic?: boolean;
}

/** 结构化拒绝：非散文，散文由引擎按法则模板渲染。协议性标记由 StepResult.deniedBy:"protocol" 承担（单一事实源），Denial 只携带 referent 与诊断。 */
export interface Denial {
	/** 法则标识，如 "move.reach"（审计与探测依据）。 */
	law: string;
	/** 施动实体 id。结构化亲证：进声明契约 touched（engine 的 involvedEntities）。 */
	subject?: string;
	/** 受动实体 id。结构化亲证：进声明契约 touched（engine 的 involvedEntities）。 */
	object?: string;
	/** 涉及属性（denyAll 等按属性兜底的模板用）。 */
	prop?: string;
	/** 世界腔拒绝文案（法则 text 内联渲染 / 可达性构件 prose / 不变式 message）；缺省回落到 messages.noResponse。 */
	reason?: string;
	/** 审计用诊断（不进玩家文案；如不变式拒绝详情）。 */
	debug?: string;
	/** 终局兜底标记：probe 据此报告法则缺口（取代 denyAll. 前缀字符串分类）。 */
	fallback?: boolean;
}

/** 引擎保留伪动词：时间系统（tick）产出 StepResult 时的动作标识。
 *  不是游戏声明的动词，游戏不应声明同名动词；describeAction 据此渲染「时间流逝」。 */
export const TICK_VERB = "tick";

// ---------- 法则内核：规则即代码，产出即数据（快照线以下是 Delta/Denial/Fact） ----------

/** 规则判定上下文：只读世界视图 + 引擎隐式语义的唯一入口（可达性/关系/骰子/时间）。
 *  约束：规则只读不写，一切后果经返回的 Delta 表达，由模拟层统一提交/回滚。 */
export interface Q {
	readonly world: World;
	/** 玩家（def.playerId，意志的居所）：意志在世界的全部足迹是一根引用，本字段即其值。
	 *  对规则它只承担一个缺省角色——无主语动词的缺省主语；显式主语动词的语义主语从参数取
	 *  （上帝视角的主语全在参数里，后果落在被指令者）。现宿主（附身/换躯的器皿）由游戏从世界态推导，
	 *  不在此字段——第一人称游戏里居所=现宿主，二者同一。 */
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
	canReach(id: string): boolean;
	reachWhy(id: string): string | null;
	visible(): Set<string>;
}

/** 裁决：授予（未提交 deltas + 世界腔理由 + facts）或结构化拒绝；规则返回 null = 不表态。 */
export type Verdict =
	| { ok: true; deltas: Delta[]; reason?: string; facts?: Fact[] }
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

export function grant(deltas: Delta[], reason?: string, facts?: Fact[]): Verdict {
	return { ok: true, deltas, reason, facts };
}

export function deny(law: string, o: { subject?: string; object?: string; prop?: string; reason?: string; fallback?: boolean } = {}): Verdict {
	return { ok: false, denial: { law, ...o } };
}

/** 终局兜底规则：无条件拒绝并带 fallback 标记（probe 据此报告法则缺口）。 */
export function fallback(id: string, text: (q: Q) => string): Rule {
	// 同 defineVerb：包装 judge 挂原始文案闭包源码，兜底文案里的属性键读取对 lint 可见
	return { id, judge: Object.assign((q: Q) => deny(id, { reason: text(q), fallback: true }), { source: String(text) }) };
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
	entityParams?: string[];
	instrumentParams?: string[];
	candidates?: (sim: Simulation) => Record<string, PropValue[]>;
	rules: { id: string; judge: (q: Q, p: Static<S>) => Verdict | null }[];
}): VerbDef {
	return {
		label: spec.label,
		description: spec.description,
		// 工具边界与裁决瓶颈同一严格度：多余参数在工具层被拒，而非到 sim 才成协议性拒绝（反馈只剩 noResponse）
		schema: { ...spec.schema, additionalProperties: false },
		entityParams: spec.entityParams,
		instrumentParams: spec.instrumentParams,
		candidates: spec.candidates,
		// 包装为单参 judge（引擎口径）保留类型化二参 DX；原始 judge 源码挂在 wrapper.source 供静态扫描——
		// String(wrapper) 看不见闭包体内的属性键读取，丢失原始源码会使词汇闭包检查对规则体整体失明。
		rules: spec.rules.map((r) => ({ id: r.id, judge: Object.assign((q: Q) => r.judge(q, q.params as Static<S>), { source: String(r.judge) }) })),
	};
}

/** 从 deltas + facts 收集涉及实体（表达层声明校验与审计用）。 */
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
	/** 声明哪些参数是实体 id（供可见性校验与探测）。 */
	entityParams?: string[];
	/** 施动工具参数：这些实体参数作为「工具」被挥动/使用（如 use 的 source）。
	 *  核心在规则前跑共享前提检查：必须可持握（holdable 槽位）且在可达范围；不满足直接拒绝，不进入规则。
	 *  probe 依此审计「规则授予但前提不满足」的潜在洞。 */
	instrumentParams?: string[];
	/** 参数的动态值域（动作空间第三轴：动词 × 实体 × 候选）。动态域进不了静态 schema，也不可进工具 schema
	 *  （逐回合变化的工具块击穿字节级稳定前缀），故由 def 携带。当前消费者是 sim probe（逐参数收窄枚举域）；
	 *  预期消费者：意图菜单（快捷方式的原料）、act 工具参数提示。 */
	candidates?: (sim: Simulation) => Record<string, PropValue[]>;
	/** 卫语句式规则：按序裁决，首个表态即判决；末条可为 fallback 兜底。 */
	rules: Rule[];
}

export interface GameDef {
	id: string;
	title: string;
	/** 意志的居所：def 指向世界的唯一数据引用。意志（act 通道的说话人，每回合恰好一个）不在世界里——账本里只有这根引用；
	 *  它同时是五个缺省角色的缺省值：无主语动词的缺省主语、感知谓词的缺省视点、声明契约的常任成员、叙述「你」的缺省指称、
	 *  integrity 墙的保护对象。前四者是「现宿主」角色的缺省（体验者一侧，附身时属器皿；附身游戏在钩子与规则内从世界态推导
	 *  现宿主并无视本引用，居所退为空壳），只有墙保护属引用自身的必要性。居所上的状态全是身体态，意志自身无状态。
	 *  视角是感知面钩子的现值（缺省全见全达即上帝视角；第一人称是游戏声明，非引擎立场）。 */
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	/** 时间系统：每 tick 按注册顺序运行的系统规则（world→deltas 的纯函数）。 */
	systems?: SystemRule[];
	hint?: string;
	/** 属性注册表：属性类型/世界化标签/内部标记/值域。serialize 与表达校验读 internal，
	 *  describeAction 与拒绝渲染读 label。缺省空注册表（全部属性视为普通可见属性）。 */
	props?: Record<string, PropDef>;
	/** 确定性回退摘要钩子（player = 意志居所）。 */
	summarize?: (input: { world: World; changes: Change[]; player: string }) => string;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见。 */
	grounding?: (world: World, player: string) => string[];
	/** 可达性槽位（游戏声明）：实体是否够得着。core 不内嵌任何空间模型——容器包含树等由游戏自选
	 *  构件提供（如 src/games/space.ts），缺省全部可达。P.reach / 施动工具前提共用此谓词。 */
	reach?: (world: World, player: string, id: string) => boolean;
	/** 可达性理由槽位：不可达时返回世界腔理由（拒绝文案），可达返回 null。缺省 null。 */
	reachReason?: (world: World, player: string, id: string) => string | null;
	/** 可持握槽位（游戏必须声明）：实体能否被拿起/当施动工具。core 不内嵌任何属性名、不提供缺省——
	 *  未声明的游戏默认全部不可持握；游戏自定语义（grabbable 属性、体力门槛、材质、锋利等）。
	 *  wieldable（= holdable + reach）与施动工具前提共用。 */
	holdable?: (world: World, player: string, id: string) => boolean;
	/** 回合级时间驱动：引擎在 act 一次性裁决后、描写前推进 n 刻并运行 systems（缺省 0 不流逝）。 */
	turnTicks?: number;
	/** 序列化投影：决定状态以什么形态进回合 prompt。缺省 = serialize() 全量 JSON。
	 *  游戏可声明精简/结构化的 digest（如关系格式化、省略冗余字段），以控制 prompt 体积与表达自由度。 */
	digest?: (sim: Simulation) => string;
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
	/** 本次提交的全部变更（含 spawn/despawn 与 src 产出方标识）：过渡不变式据此审计 provenance（DESIGN §3.3）。
	 *  每条规则/系统的提交独立过墙，粒度即单次提交。 */
	changes: Change[];
}

/** 不变式：提交后校验，返回世界腔/结构化拒绝理由（null 通过）。违反即回滚整个提交并拒绝。
 *  两种形态共用本接口（DESIGN §3.3）：状态不变式只读 world（守恒类，防总量漂移）；
 *  过渡不变式经 ctx.changes 读提交（provenance 类，防错误再分配）。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

/** core 默认硬墙：引用完整性——实体 id 唯一、注册表 id 属性（标量或引用数组）与关系端点指向存在的实体。
 *  检测规则把世界改坏的 bug（悬空引用），任何提交都无法绕过。 */
export function integrityInvariant(): Invariant {
	return {
		id: "integrity",
		check: (world, ctx) => {
			const ids = new Set(world.entities.map((e) => e.id));
			if (ids.size !== world.entities.length) return "integrity: duplicate entity ids";
			// playerId 是 def 指向世界的唯一数据引用（无主语动词与感知钩子的解引用原点），每次裁决都被解引用，
			// 属于「引擎将解引用的引用必须可解」的墙的管辖——否则 despawn 主体静默过墙，后续裁决级联劣化。
			if (!ids.has(ctx.def.playerId)) return `integrity: playerId -> missing entity ${ctx.def.playerId}`;
			const idProps = new Set<string>();
			for (const [k, p] of Object.entries(ctx.def.props ?? {})) if (p.type === "id") idProps.add(k);
			for (const e of world.entities) {
				for (const p of idProps) {
					const v = e.props[p];
					// id 型属性契约：标量引用或引用数组（如背包）；空串视为无引用，与标量规则一致
					for (const ref of Array.isArray(v) ? v : [v]) {
						if (typeof ref === "string" && ref !== "" && !ids.has(ref)) return `integrity: ${e.id}.${p} -> missing entity ${ref}`;
					}
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

/** 从属性注册表计算内部属性集（不进序列化/变更/表达校验）。 */
export function internalPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.internal) s.add(k);
	return s;
}

/** 从属性注册表计算润饰属性集（表达层可文学润饰、不参与断言校验）。 */
export function stylisticPropsOf(def: GameDef): Set<string> {
	const s = new Set<string>();
	for (const [k, p] of Object.entries(def.props ?? {})) if (p.stylistic) s.add(k);
	return s;
}

/** 属性世界化标签（拒绝/变更文本中的说法；无则返回 undefined）。 */
export function propLabelOf(def: GameDef, prop: string): string | undefined {
	return def.props?.[prop]?.label;
}

export interface StepResult {
	ok: boolean;
	reason: string;
	changes: Change[];
	action: Action;
	/** 否决来源：具体法则给了世界性理由（rule）、通用兜底（denyAll）、映射层形态错误的协议性拒绝（protocol，引擎↔模型通道流量，表达层整体过滤），
	 *  或不变式硬墙的必要性拦截（invariant——规格违反信号或戏剧性必然，与法则否决是不同语义来源，审计应可区分）。 */
	deniedBy?: "rule" | "denyAll" | "protocol" | "invariant";
	/** 结构化拒绝（deniedBy=rule 时给出），供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
	/** 变更来源标识（law:<id> / rule:<verb> / system:<id>），审计依据。 */
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

/** 序列化：可见实体 + 非内部属性 + 关系表。 */
export function serialize(world: World, visible: Iterable<string>, internalProps: readonly string[] = []): string {
	const vis = new Set(visible);
	const internal = new Set(internalProps);
	const items = world.entities
		.filter((e) => vis.has(e.id))
		.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			tags: e.tags,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
		}));
	const rels = (world.relations ?? []).filter((r) => vis.has(r.from) && vis.has(r.to));
	return JSON.stringify({ time: world.time, relations: rels, entities: items });
}

/** 裁决结果 + 未提交的 deltas（apply 用）；check 丢弃 deltas 作为只读裁决。 */
interface RawResult extends StepResult {
	deltas: Delta[];
}

export class Simulation {
	readonly def: GameDef;
	readonly world: World;
	readonly log: StepResult[] = [];
	/** 探测模式：跳过施动工具前提（instrumentParams）检查，仅 probeGrant 临时开启，审计「规则本身是否会在不可持握工具上授予」。 */
	private probeSkipInstruments = false;
	/** 不变式种子：实际起点世界的冻结副本，首次提交前惰性捕获（无不变式的路径零成本）。 */
	private genesisCache?: World;
	/** 骰子键碰撞追踪：仅 apply/tick 提交链开启；check 的只读重估不追踪——同一动作复现同值是公理 4，不是碰撞。 */
	private tracingRolls = false;
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
		}
		// 公理 6「不变式管永远」包括起点：初始世界同样过墙（genesis = 自身，changes = 空）——
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

	/** 只读裁决（不提交、不入日志）：法则探测的通道（probeGrant 唯一消费）。
	 *  随机必须是 World 的纯函数（games 层自持计数器），check 与 apply 对同一状态天然一致。 */
	check(action: Action): StepResult {
		const r = this.adjudicateRaw(action);
		return { ok: r.ok, reason: r.reason, changes: [], action, facts: r.facts, involved: r.involved, deniedBy: r.deniedBy, denial: r.denial, src: r.src };
	}

	/** 探测专用：跳过施动工具前提（instrumentParams）检查的只读裁决。
	 *  用于审计「规则本身是否会在不可持握/不可达工具上授予」（作者漏声明前提时的潜在洞）。
	 *  只读、不入日志；probe 使用，游戏逻辑不得调用。 */
	probeGrant(action: Action): StepResult {
		const prev = this.probeSkipInstruments;
		this.probeSkipInstruments = true;
		try {
			return this.check(action);
		} finally {
			this.probeSkipInstruments = prev;
		}
	}

	private adjudicateRaw(action: Action): RawResult {
		const msgs = messagesFor(this.def);
		const verb = this.def.verbs[action.verb];
		if (!verb) {
			return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "protocol", denial: { law: "action.unknown", debug: `verb:${action.verb}` } };
		}
		if (!this.validators.get(action.verb)!.Check(action.params)) {
			return { ok: false, reason: msgs.noResponse, changes: [], deltas: [], action, deniedBy: "protocol", denial: { law: "action.schema", debug: this.schemaErrors(action.verb, action.params) } };
		}
		// 施动工具前提先于可见性：工具够不够得着是关于「手」的问题，能点名工具（比通用不可见文案更具体）；
		// 不存在的 id 由 instrument 跳过、交给可见性门兜住。
		const inst = this.probeSkipInstruments ? null : this.instrumentViolation(action, verb);
		if (inst) {
			return { ok: false, reason: renderDenial(this.def, inst), changes: [], deltas: [], action, deniedBy: "rule", denial: inst };
		}
		// 可见性按当前状态逐动作计算：同一提案内的多动作（如先 travel 再移动实体）不沿用旧快照。
		const curVis = this.visible();
		const invalid = (verb.entityParams ?? [])
			.map((p) => action.params[p])
			.filter((id): id is string => typeof id === "string" && id.length > 0 && !curVis.has(id));
		if (invalid.length) {
			// 已存在但不可见的实体用游戏自己的可达性理由解释（关着的容器/不在本地）；幻觉 id 无名字，回落通用文案
			const first = invalid[0]!;
			const hit = entity(this.world, first);
			const reason =
				(hit ? (this.def.reachReason?.(this.world, this.player, first) ?? msgs.invisibleEntity?.([hit.name])) : msgs.invisibleEntity?.([])) ?? msgs.noResponse;
			return { ok: false, reason, changes: [], deltas: [], action, deniedBy: "rule", denial: { law: "action.invisible", subject: first, reason, debug: invalid.join(",") } };
		}
		const q = this.query(action.params);
		for (const r of verb.rules) {
			const v = r.judge(q);
			if (!v) continue;
			if (v.ok) {
				return { ok: true, reason: v.reason ?? messagesFor(this.def).defaultReason, changes: [], deltas: v.deltas, action, facts: v.facts, involved: collectInvolved(v.deltas, v.facts), src: `rule:${r.id}` };
			}
			return { ok: false, reason: renderDenial(this.def, v.denial), changes: [], deltas: [], action, deniedBy: v.denial.fallback ? "denyAll" : "rule", denial: v.denial };
		}
		return { ok: false, reason: messagesFor(this.def).noResponse, changes: [], deltas: [], action, deniedBy: "denyAll" };
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
			canReach: (id) => (this.def.reach ? this.def.reach(world, player, id) : true),
			reachWhy: (id) => (this.def.reachReason ? this.def.reachReason(world, player, id) : null),
			visible: () => this.visible(),
		};
	}

	/** 同一时刻内骰子键应唯一：重复即两个不同判定共享同一随机值（隐性相关 bug）。 */
	private traceRollKey(key: string): void {
		if (!this.tracingRolls) return;
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

	/** 协议性 schema 错误的机器诊断（进 Denial.debug，不进玩家文案）。 */
	private schemaErrors(verbName: string, params: Record<string, PropValue>): string {
		const errs = this.validators.get(verbName)!.Errors(params);
		return errs.length ? errs.map((e) => `${e.instancePath} ${e.message}`).join("; ") : JSON.stringify(params);
	}

	/** 施动工具前提检查：声明为 instrumentParams 的参数实体必须可持握（holdable 槽位）且可达。
	 *  只产出结构化拒绝（law + subject + reason），世界腔文案由游戏经 messages 注入，core 不撰写理由。 */
	private instrumentViolation(action: Action, verb: VerbDef): Denial | null {
		const msgs = messagesFor(this.def);
		for (const p of verb.instrumentParams ?? []) {
			const id = action.params[p];
			if (typeof id !== "string" || !id) continue;
			if (!entity(this.world, id)) continue;
			if (!this.wieldable(id)) {
				const name = entity(this.world, id)?.name ?? id;
				if (!this.holdable(id)) {
					return { law: "instrument.unholdable", subject: id, reason: msgs.instrumentUnholdable?.(name) };
				}
				return { law: "instrument.unreachable", subject: id, reason: msgs.instrumentUnreachable?.(name) };
			}
		}
		return null;
	}

	/** 提交 + 不变式硬墙：先快照，提交后校验；违反则回滚整个提交并拒绝（原子）。
	 *  渲染按产出方分流：core 完整性违反只有 debug 诊断（回落 noResponse）；游戏不变式的 message 是游戏撰写的世界腔，直接作玩家文案。 */
	private commitChecked(deltas: Delta[], src: string): { ok: boolean; changes: Change[]; denial?: Denial; reason?: string } {
		const genesis = this.genesis(); // 种子先于一切变异捕获：这里是唯一提交入口
		const before = this.snapshot();
		const changes = this.commit(deltas, src);
		const inv = this.checkInvariants(genesis, changes);
		if (inv) {
			// 回滚：先删掉提交期间新建的键（relations 等快照中不存在的），再整体恢复。
			for (const k of Object.keys(this.world)) if (!(k in before)) delete (this.world as unknown as Record<string, unknown>)[k];
			Object.assign(this.world, before);
			const denial: Denial = inv.authored
				? { law: `invariant.${inv.id}`, reason: inv.message, debug: inv.message }
				: { law: `invariant.${inv.id}`, debug: inv.message };
			return { ok: false, changes: [], denial, reason: denial.reason ?? messagesFor(this.def).noResponse };
		}
		return { ok: true, changes };
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

	apply(action: Action): StepResult {
		this.tracingRolls = true;
		try {
			return this.applyTraced(action);
		} finally {
			this.tracingRolls = false;
		}
	}

	private applyTraced(action: Action): StepResult {
		const r = this.adjudicateRaw(action);
		let sr: StepResult;
		if (r.ok) {
			const src = r.src ?? `action:${action.verb}`;
			const cc = this.commitChecked(r.deltas, src);
			if (!cc.ok) {
				sr = { ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], action, deniedBy: "invariant", denial: cc.denial };
				this.log.push(sr);
				return sr;
			}
			sr = { ok: true, reason: r.reason, changes: cc.changes, action, facts: r.facts, involved: r.involved, src };
		} else {
			sr = { ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial };
		}

		this.log.push(sr);
		return sr;
	}

	/** 实体是否可持握（游戏声明的 GameDef.holdable 槽位，core 不内嵌任何属性名）。
	 *  未声明的游戏一律不可持握（无缺省属性假设）。 */
	holdable(id: string): boolean {
		return this.def.holdable ? this.def.holdable(this.world, this.player, id) : false;
	}

	/** 实体是否可作为施动工具（可持握 + 可达）：施动工具前提门（instrumentViolation）的共享谓词。
	 *  可持握走 holdable 槽位，可达性走 GameDef.reach 槽位（core 不内嵌空间模型）。 */
	wieldable(id: string): boolean {
		if (!this.holdable(id)) return false;
		return this.def.reach ? this.def.reach(this.world, this.player, id) : true;
	}

	/** 动作线性化（fmtChange 同一纪律：label/name 为游戏世界语，core 只做符号连接）；tick 伪动词无游戏词可连，走 Messages.timePassed。 */
	describeAction(action: Action): string {
		const verb = this.def.verbs[action.verb];
		if (action.verb === TICK_VERB) return messagesFor(this.def).timePassed;
		if (!verb) return action.verb;
		const name = (v: PropValue): string => {
			if (typeof v === "string") {
				const hit = entity(this.world, v);
				if (hit) return hit.name;
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

	tick(n = 1): StepResult[] {
		this.tracingRolls = true;
		try {
			const out: StepResult[] = [];
			for (let i = 0; i < n; i++) {
				this.world.time += 1;
				out.push(...this.runSystems());
			}
			return out;
		} finally {
			this.tracingRolls = false;
		}
	}

	/** 按注册顺序运行全部系统一次，产出并提交 deltas。 */
	private runSystems(): StepResult[] {
		const out: StepResult[] = [];
		const emit = (sr: StepResult): void => {
			this.log.push(sr);
			out.push(sr);
		};
		for (const sys of this.def.systems ?? []) {
			const src = `system:${sys.id}`;
			const res = sys.run(this.query({}));
			// 纯氛围输出（fact-only，无状态变更）同样成立——氛围系统的合法通道
			if (!res || (res.deltas.length === 0 && !res.facts?.length)) continue;
			const cc = this.commitChecked(res.deltas, src);
			if (!cc.ok) {
				emit({
					ok: false,
					reason: cc.reason ?? messagesFor(this.def).noResponse,
					changes: [],
					action: { verb: TICK_VERB, params: { n: this.world.time } },
					deniedBy: "invariant",
					denial: cc.denial,
					src,
				});
				continue;
			}
			emit({
				ok: true,
				reason: res.facts?.length ? res.facts.map((f) => f.text).join(" ") : (res.reason ?? messagesFor(this.def).defaultReason),
				changes: cc.changes,
				action: { verb: TICK_VERB, params: { n: this.world.time } },
				facts: res.facts,
				involved: collectInvolved(res.deltas, res.facts),
				src,
			});
		}
		return out;
	}

	/** 克隆世界，模拟 n 个 tick，返回将要发生的变更（不改变自身状态）。表达层的"即将发生"合法预言来源。
	 *  随机由 games 层以 World 状态自持（纯函数派生），克隆世界即完整预言——无需序列快照机制。 */
	dryTick(n = 1): StepResult[] {
		const clone = new Simulation(this.def, this.world);
		return clone.tick(n);
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	serialize(): string {
		return serialize(this.world, this.visible(), [...internalPropsOf(this.def)]);
	}

	/** 序列化投影：映射/表达 prompt 用的状态呈现。游戏可声明 def.digest 覆盖。 */
	digest(): string {
		if (this.def.digest) return this.def.digest(this);
		return this.serialize();
	}

	private commit(deltas: Delta[], src: string): Change[] {
		const changes: Change[] = [];
		const rels = (this.world.relations = this.world.relations ?? []);
		const upsertRel = (from: string, to: string, type: string, value: number | string | boolean) => {
			const hit = rels.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else rels.push({ from, to, type, value });
		};
		for (const d of deltas) {
			if (d.op === "spawn") {
				if (entity(this.world, d.entity.id)) continue;
				this.world.entities.push(JSON.parse(JSON.stringify(d.entity)) as Entity);
				changes.push({ kind: "spawn", entity: d.entity.id, name: d.entity.name, src });
				continue;
			}
			if (d.op === "despawn") {
				const i = this.world.entities.findIndex((e) => e.id === d.entity);
				if (i < 0) continue;
				const gone = this.world.entities[i]!;
				this.world.entities.splice(i, 1);
				this.world.relations = (this.world.relations ?? []).filter((r) => r.from !== d.entity && r.to !== d.entity);
				changes.push({ kind: "despawn", entity: d.entity, name: gone.name, src });
				continue;
			}
			if (d.op === "relSet") {
				const prev = relVal(this.world, d.from, d.to, d.type);
				if (prev === d.value) continue;
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
				const prev = Number(relVal(this.world, d.from, d.to, d.type) ?? 0);
				if (!Number.isFinite(prev)) continue;
				const next = prev + d.by;
				upsertRel(d.from, d.to, d.type, next);
				changes.push({ kind: "rel", from: d.from, to: d.to, type: d.type, prev, next, src });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) continue;
			if (d.op === "set") {
				const prev = e.props[d.prop] ?? null;
				if (prev === d.value) continue;
				e.props[d.prop] = d.value;
				changes.push({ kind: "prop", entity: d.entity, prop: d.prop, prev, next: d.value, src });
			} else {
				const prev = Number(e.props[d.prop] ?? 0);
				if (!Number.isFinite(prev)) continue;
				const next = prev + d.by;
				e.props[d.prop] = next;
				changes.push({ kind: "prop", entity: d.entity, prop: d.prop, prev, next, src });
			}
		}
		return changes;
	}
}
