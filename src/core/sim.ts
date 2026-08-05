import type { TObject } from "typebox";
import { evaluateLaw, type ExprCtx, type Law } from "./expr.ts";
import { roll as rollDice } from "./util.ts";

export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue };

export interface Entity {
	id: string;
	name: string;
	kind: string;
	tags: string[];
	props: Record<string, PropValue>;
}

/** 关系边：社会/叙事状态的原子原语（如"守卫 信任 玩家 10"、"她 记得 你 取走了戒指"）。 */
export interface Rel {
	from: string;
	to: string;
	type: string;
	value: number | string | boolean;
}

export interface World {
	time: number;
	entities: Entity[];
	/** 显著性焦点：本回合动作/拒绝涉及的实体，跨回合指代锚点。 */
	focus?: string | null;
	/** 拒绝痕迹：实体 id → 玩家累计尝试/被拒次数（法则拒绝时累加）。 */
	traces?: Record<string, number>;
	/** 关系边表：from→to 的 type 关系（信任/记忆/派系等）。游戏声明，规则以 deltas 变更。 */
	relations?: Rel[];
	/** 确定性实体 id 计数器：spawn 未显式指定 id 时派生（e0/e1/...）。 */
	nextId?: number;
}

/** 结构化变更原语：法则产出 deltas，模拟层裁定提交。prop 支持点路径（如 relations.guard.trust）。
 *  关系变更 prop 编码为 `rel:<type>@<to>`（entity 为 from 端点），表达层据此格式化。 */
export type Delta =
	| { op: "set"; entity: string; prop: string; value: PropValue }
	| { op: "inc"; entity: string; prop: string; by: number }
	| { op: "push"; entity: string; prop: string; value: PropValue }
	| { op: "del"; entity: string; prop: string }
	| { op: "relSet"; from: string; to: string; type: string; value: number | string | boolean }
	| { op: "relInc"; from: string; to: string; type: string; by: number }
	| { op: "relDel"; from: string; to: string; type: string }
	| { op: "spawn"; id?: string; kind: string; name: string; tags?: string[]; props?: Record<string, PropValue> }
	| { op: "destroy"; entity: string };

export interface Change {
	entity: string;
	prop: string;
	from: PropValue;
	to: PropValue;
	/** 变更来源（law:spread / rule:move / system:burnout），审计与回滚依据。 */
	src?: string;
}

/** 动作提案：由游戏声明的动词表（verb）驱动，参数由动词 schema 约束。 */
export interface Action {
	verb: string;
	params: Record<string, PropValue>;
}

/** core 产出的用户可见文案契约：由游戏经 GameDef.messages 必填注入自有语言，core 不内嵌任何语言。 */
export interface Messages {
	/** 所有法则均未表态时的兜底回应。 */
	noResponse: string;
	/** 动词不存在（core 校验层拒绝，非规则产出）。 */
	unknownVerb: (verb: string) => string;
	/** 参数不在动词 schema 声明范围内（core 校验层拒绝）。 */
	invalidParams: (label: string, known: string) => string;
	/** 实体参数不可见/不存在（core 校验层拒绝）。 */
	invisibleEntity: (ids: string[]) => string;
	/** 容器包含树构件（games 侧可选）的可达性理由（作为 denial.reason 的缺省）。 */
	reachMissing?: string;
	reachCycle?: string;
	reachNotHere?: string;
	reachClosed?: (name: string) => string;
	/** 施动工具前提拒绝（core 产出，游戏注入语言）：工具不可持握时渲染（name 为工具实体名）。 */
	instrumentUnholdable?: (name: string) => string;
	/** 施动工具前提拒绝（core 产出，游戏注入语言）：工具可达性不满足时渲染（name 为工具实体名）。 */
	instrumentUnreachable?: (name: string) => string;
	/** 不变式硬墙拒绝（core 产出，游戏注入语言）：check 返回的 message 渲染为世界腔文案；缺省回落 messages.noResponse（不泄漏实现消息）。 */
	invariantRejected?: (id: string, message: string) => string;
	/** 规则授予但未提供世界腔理由时的占位文案（affordances 据此过滤无描述的动作）。 */
	defaultReason: string;
	/** 行动阶段门闩拦截（表达 pass 中误调 act 工具时的防御性拒绝）。 */
	notInActionPhase: string;
	/** 时间流逝动作（TICK_VERB）的世界腔描述。 */
	timePassed: string;
	/** 时间流逝产生变更时的 StepResult 理由。 */
	timeChanged: string;
}

/** 法则背书的结构化新事实：表达层的合法新事实词汇，防止模型发明后果。 */
export interface Fact {
	/** 世界腔陈述。 */
	text: string;
	/** 陈述涉及的实体 id（声明校验的集合成员依据）。 */
	entities: string[];
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
	 *  非润饰的物理属性须与状态严格一致——一致性由声明契约（structured）与不变式硬墙承担，不再有词表断言扫描器。 */
	stylistic?: boolean;
}

	/** 结构化拒绝：非散文，散文由引擎按法则模板渲染。 */
export interface Denial {
	/** 法则标识，如 "move.reach"（审计与探测依据）。 */
	law: string;
	/** 施动实体 id。 */
	subject?: string;
	/** 受动实体 id。 */
	object?: string;
	/** 涉及属性（denyAll 等按属性兜底的模板用）。 */
	prop?: string;
	/** 世界腔拒绝文案（法则 text 内联渲染 / 可达性构件 prose / 不变式 message）；缺省回落到 messages.noResponse。 */
	reason?: string;
	/** 审计用诊断（不进玩家文案；如不变式拒绝详情）。 */
	debug?: string;
}

/** 引擎保留伪动词：时间系统（tick）产出 StepResult 时的动作标识。
 *  不是游戏声明的动词，游戏不应声明同名动词；describeAction 据此渲染「时间流逝」。 */
export const TICK_VERB = "tick";

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: TObject;
	/** 声明哪些参数是实体 id（供可见性校验与探测）。 */
	entityParams?: string[];
	/** 施动工具参数：这些实体参数作为「工具」被挥动/使用（如 use 的 source）。
	 *  核心在规则前跑共享前提检查：必须可持握（holdable 槽位）且在可达范围；不满足直接拒绝，不进入规则。
	 *  affordances 枚举自动跳过不可持握工具；probe 依此审计「规则授予但前提不满足」的潜在洞。 */
	instrumentParams?: string[];
	/** 非实体参数的候选值；动作空间接地与法则探测共用。不提供则跳过该参数。 */
	candidates?: (sim: Simulation) => Record<string, PropValue[]>;
	/** 声明式法则（数据行，解释器裁决，短路语义：首个授予即裁决）。 */
	laws?: Law[];
}

export interface GameDef {
	id: string;
	title: string;
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	/** 时间系统：每 tick 按注册顺序运行的声明式法则（over/when/each/facts）。 */
	systems?: Law[];
	hint?: string;
	/** 属性注册表：属性类型/世界化标签/内部标记/值域。serialize 与表达校验读 internal，
	 *  describeAction 与拒绝渲染读 label。缺省空注册表（全部属性视为普通可见属性）。 */
	props?: Record<string, PropDef>;
	/** 确定性回退摘要钩子。 */
	summarize?: (input: { world: World; changes: Change[]; actor: string }) => string;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见。 */
	grounding?: (world: World, actor: string) => string[];
	/** 可达性槽位（游戏声明）：实体是否够得着。core 不内嵌任何空间模型——容器包含树等由游戏自选
	 *  构件提供（如 src/games/space.ts），缺省全部可达。P.reach / 施动工具前提共用此谓词。 */
	reach?: (world: World, actor: string, id: string) => boolean;
	/** 可达性理由槽位：不可达时返回世界腔理由（拒绝文案），可达返回 null。缺省 null。 */
	reachReason?: (world: World, actor: string, id: string) => string | null;
	/** 可持握槽位（游戏必须声明）：实体能否被拿起/当施动工具。core 不内嵌任何属性名、不提供缺省——
	 *  未声明的游戏默认全部不可持握；游戏自定语义（grabbable 属性、体力门槛、材质、锋利等）。
	 *  wieldable（= holdable + reach）与施动工具前提共用。 */
	holdable?: (world: World, actor: string, id: string) => boolean;
	/** 法则探测域：sim probe 枚举动作参数候选实体时使用的实体集。缺省 = 可见实体 - 玩家 - space 标记的场景实体。
	 *  大实体量游戏可在此裁剪（如只给可交互实体），控制 probe 组合规模与信号质量。 */
	probeScope?: (world: World, actor: string) => string[];
	/** 动作后因果反应：granted 动作提交后按注册顺序跑一次 systems（默认 false）。 */
	reactiveSystems?: boolean;
	/** 序列化投影：决定状态以什么形态进映射/表达 prompt。缺省 = serialize() 全量 JSON。
	 *  游戏可声明精简/结构化的 digest（如焦点优先、关系格式化、省略冗余字段），以控制 prompt 体积与表达自由度。 */
	digest?: (sim: Simulation) => string;
	/** 不变式：提交后校验，违反即回滚整个提交并拒绝。core 默认恒挂引用完整性硬墙。 */
	invariants?: Invariant[];
	/** core 产出的用户可见文案（游戏自有语言，必填：core 不内嵌任何语言，缺省即空，倒逼游戏注入）。 */
	messages: Messages;
}

/** 不变式检查上下文：世界 + 游戏定义（注册表等）。 */
export interface InvariantCtx {
	def: GameDef;
	actor: string;
}

/** 不变式：提交后校验，返回世界腔/结构化拒绝理由（null 通过）。违反即回滚整个提交并拒绝。 */
export interface Invariant {
	id: string;
	check: (world: World, ctx: InvariantCtx) => string | null;
}

/** core 默认硬墙：引用完整性——实体 id 唯一、in/注册表 id 属性/关系端点/焦点指向存在的实体。
 *  检测规则把世界改坏的 bug（悬空引用），任何提交都无法绕过。 */
export function integrityInvariant(): Invariant {
	return {
		id: "integrity",
		check: (world, ctx) => {
			const ids = new Set(world.entities.map((e) => e.id));
			if (ids.size !== world.entities.length) return "integrity: duplicate entity ids";
			const idProps = new Set<string>();
			for (const [k, p] of Object.entries(ctx.def.props ?? {})) if (p.type === "id") idProps.add(k);
			for (const e of world.entities) {
				for (const p of idProps) {
					const v = e.props[p];
					if (typeof v === "string" && v !== "" && !ids.has(v)) return `integrity: ${e.id}.${p} -> missing entity ${v}`;
				}
			}
			for (const r of world.relations ?? []) {
				if (!ids.has(r.from) || !ids.has(r.to)) return `integrity: relation ${r.type} -> missing endpoint`;
			}
			if (world.focus && !ids.has(world.focus)) return "integrity: focus -> missing entity";
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
	/** 否决来源：具体法则给了世界性理由（rule），还是落到通用兜底（denyAll.* 法则）。 */
	deniedBy?: "rule" | "denyAll";
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

function splitPath(path: string): string[] {
	return path.split(".");
}

export function propGet(e: Entity, path: string): PropValue {
	let cur: PropValue = e.props;
	for (const p of splitPath(path)) {
		if (cur === null || typeof cur !== "object") return null;
		if (Array.isArray(cur)) cur = cur[Number(p)] ?? null;
		else cur = (cur as Record<string, PropValue>)[p] ?? null;
	}
	return cur;
}

export function propSet(e: Entity, path: string, value: PropValue): void {
	const parts = splitPath(path);
	const last = parts.pop()!;
	let cur: Record<string, PropValue> | PropValue[] = e.props;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		const idx = Number(p);
		const next = parts[i + 1];
		const nextIsNum = next !== undefined && !Number.isNaN(Number(next));
		const target: PropValue | undefined = Array.isArray(cur) ? cur[idx] : (cur as Record<string, PropValue>)[p];
		if (target === null || target === undefined || typeof target !== "object") {
			const fresh: PropValue = nextIsNum ? [] : {};
			if (Array.isArray(cur)) cur[idx] = fresh;
			else (cur as Record<string, PropValue>)[p] = fresh;
			cur = fresh as never;
		} else {
			cur = target as never;
		}
	}
	if (Array.isArray(cur)) cur[Number(last)] = value;
	else (cur as Record<string, PropValue>)[last] = value;
}

/** 关系查询：from→to 的指定 type 的值（无则 null）。 */
export function relVal(world: World, from: string, to: string, type: string): number | string | boolean | null {
	return world.relations?.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 关系查询：from 的全部关系边（可按 type 过滤）。 */
export function relAll(world: World, from: string, type?: string): Rel[] {
	return (world.relations ?? []).filter((r) => r.from === from && (type === undefined || r.type === type));
}

/** 序列化：可见实体 + 非内部属性 + 关系表（焦点优先）。 */
export function serialize(world: World, visible: Iterable<string>, internalProps: readonly string[] = []): string {
	const vis = new Set(visible);
	const internal = new Set(internalProps);
	const focus = world.focus ?? null;
	const items = world.entities
		.filter((e) => vis.has(e.id))
		.sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0))
		.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			tags: e.tags,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
		}));
	const rels = (world.relations ?? []).filter((r) => vis.has(r.from) && vis.has(r.to));
	return JSON.stringify({ time: world.time, focus, traces: world.traces ?? {}, relations: rels, entities: items }, null, 2);
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

	constructor(def: GameDef) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(def.world)) as World;
	}

	get actor(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		if (this.def.grounding) return new Set(this.def.grounding(this.world, this.actor));
		return new Set(this.world.entities.map((e) => e.id));
	}

	static fromWorld(def: GameDef, world: World): Simulation {
		const s = new Simulation(def);
		s.world.entities = JSON.parse(JSON.stringify(world.entities)) as Entity[];
		s.world.time = world.time;
		s.world.focus = world.focus ?? null;
		s.world.traces = world.traces ? { ...world.traces } : undefined;
		s.world.relations = world.relations ? JSON.parse(JSON.stringify(world.relations)) : undefined;
		s.world.nextId = world.nextId ?? 0;
		return s;
	}

	/** 只读裁决（不提交、不入日志）：动作空间接地与法则探测共用。
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
		const verb = this.def.verbs[action.verb];
		if (!verb) {
			return { ok: false, reason: messagesFor(this.def).unknownVerb(action.verb), changes: [], deltas: [], action, deniedBy: "rule" };
		}
		const inst = this.probeSkipInstruments ? null : this.instrumentViolation(action, verb);
		if (inst) {
			return { ok: false, reason: renderDenial(this.def, inst), changes: [], deltas: [], action, deniedBy: "rule", denial: inst };
		}
		let denial: Denial | null = null;
		const lctx = this.exprCtx({ ...action.params, actor: this.actor });
		for (const law of verb.laws ?? []) {
			const res = evaluateLaw(lctx, law);
			if (res.granted) {
				return { ok: true, reason: res.reason ?? messagesFor(this.def).defaultReason, changes: [], deltas: res.deltas ?? [], action, facts: res.facts, involved: res.involved, src: `law:${law.id}` };
			}
			if (res.denial != null && denial == null) denial = res.denial;
		}
		// 通用兜底：无具体法则拒绝时，由动词末尾的 denyAll.* 兜底法则产出（deniedBy 据此分类）。
		const deniedBy: "rule" | "denyAll" = denial != null && !denial.law.startsWith("denyAll.") ? "rule" : "denyAll";
		const reason = denial != null
			? renderDenial(this.def, denial)
			: messagesFor(this.def).noResponse;
		return { ok: false, reason, changes: [], deltas: [], action, deniedBy, denial: denial ?? undefined };
	}

	/** 构造表达式求值上下文：世界访问经闭包注入（expr 层零运行时依赖）。 */
	private exprCtx(env: Record<string, PropValue>): ExprCtx {
		const world = this.world;
		const actor = this.actor;
		return {
			actor,
			env,
			prop: (id, path) => {
				const e = entity(world, id);
				return e ? propGet(e, path) : null;
			},
			hasProp: (id, path) => {
				const e = entity(world, id);
				if (!e) return false;
				let cur: PropValue = e.props;
				for (const k of path.split(".")) {
					if (cur === null || typeof cur !== "object") return false;
					if (Array.isArray(cur)) {
						const i = Number(k);
						if (Number.isNaN(i) || !(i in cur)) return false;
						cur = cur[i]!;
					} else {
						const o = cur as Record<string, PropValue>;
						if (!(k in o)) return false;
						cur = o[k]!;
					}
				}
				return true;
			},
			reach: (id) => (this.def.reach ? this.def.reach(world, actor, id) : true),
			rel: (from, to, type) => relVal(world, from, to, type),
			reachReason: (id) => (this.def.reachReason ? this.def.reachReason(world, actor, id) : null),
			name: (id) => entity(world, id)?.name ?? id,
			propLabel: (prop) => propLabelOf(this.def, prop),
			entityIds: world.entities.map((e) => e.id),
			visibleIds: [...this.visible()],
			roll: (key, sides) => rollDice(world, key, sides),
			time: world.time,
		};
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

	/** 提交 + 不变式硬墙：先快照，提交后校验；违反则回滚整个提交并拒绝（原子）。 */
	private commitChecked(deltas: Delta[], src: string): { ok: boolean; changes: Change[]; denial?: Denial; reason?: string } {
		const before = this.snapshot();
		const changes = this.commit(deltas, src);
		const inv = this.checkInvariants();
		if (inv) {
			// 回滚：先删掉提交期间新建的键（relations/nextId 等快照中不存在的），再整体恢复。
			for (const k of Object.keys(this.world)) if (!(k in before)) delete (this.world as unknown as Record<string, unknown>)[k];
			Object.assign(this.world, before);
			const reason = messagesFor(this.def).invariantRejected?.(inv.id, inv.message) ?? messagesFor(this.def).noResponse;
			const d: Denial = { law: `invariant.${inv.id}`, debug: inv.message, reason };
			return { ok: false, changes: [], denial: d, reason };
		}
		return { ok: true, changes };
	}

	/** 运行全部不变式（core 默认引用完整性 + 游戏声明），返回首个违反者。 */
	private checkInvariants(): { id: string; message: string } | null {
		const list: Invariant[] = [integrityInvariant(), ...(this.def.invariants ?? [])];
		for (const inv of list) {
			const err = inv.check(this.world, { def: this.def, actor: this.actor });
			if (err) return { id: inv.id, message: err };
		}
		return null;
	}

	apply(action: Action): StepResult {
		const beforeVisible = this.visible();
		const r = this.adjudicateRaw(action);
		let sr: StepResult;
		if (r.ok) {
			const src = r.src ?? `action:${action.verb}`;
			const cc = this.commitChecked(r.deltas, src);
			if (!cc.ok) {
				// 不变式硬墙拒绝同样维护焦点/拒绝痕迹（与普通拒绝一致）；subject 取动作首个实体参数。
				// 返回的 sr.denial 与 updateFocus 用同一个带 subject 的 denial，保证两处口径一致。
				const denial = cc.denial ? { ...cc.denial, subject: this.firstEntityParam(action) ?? undefined } : undefined;
				sr = { ok: false, reason: cc.reason ?? messagesFor(this.def).noResponse, changes: [], action, deniedBy: "rule", denial };
				this.updateFocus({ ok: false, denial }, action, beforeVisible);
				this.log.push(sr);
				return sr;
			}
			sr = { ok: true, reason: r.reason, changes: cc.changes, action, facts: r.facts, involved: r.involved, src };
		} else {
			sr = { ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial };
		}

		if (r.ok && this.def.reactiveSystems === true) {
			const reactive = this.runSystems(true);
			if (reactive.length) {
				sr = {
					...sr,
					changes: [...sr.changes, ...reactive.flatMap((x) => x.changes)],
					facts: [...(sr.facts ?? []), ...reactive.flatMap((x) => x.facts ?? [])],
					involved: [...new Set([...(sr.involved ?? []), ...reactive.flatMap((x) => x.involved ?? [])])],
				};
			}
		}

		this.updateFocus(r, action, beforeVisible);

		this.log.push(sr);
		return sr;
	}

	/** 焦点与拒绝痕迹的确定性维护。 */
	private updateFocus(r: { ok: boolean; denial?: Denial; involved?: string[] }, action: Action, beforeVisible: Set<string>): void {
		if (r.ok) {
			const revealed = [...this.visible()].filter((id) => id !== this.actor && !beforeVisible.has(id));
			const id = revealed.length ? revealed[0] : (this.firstEntityParam(action) ?? r.involved?.find((x) => x !== this.actor));
			if (id) this.world.focus = id;
		} else {
			const subj = r.denial?.subject;
			if (subj && this.world.entities.some((e) => e.id === subj)) {
				this.world.focus = subj;
				this.world.traces = this.world.traces ?? {};
				this.world.traces[subj] = (this.world.traces[subj] ?? 0) + 1;
			}
		}
	}

	/** 取动作参数中第一个实体 id（作为焦点候选）。 */
	private firstEntityParam(action: Action): string | null {
		for (const v of Object.values(action.params)) {
			if (typeof v === "string" && this.world.entities.some((e) => e.id === v)) return v;
		}
		return null;
	}

	/** 当前焦点实体（跨回合指代锚点）。 */
	get focus(): string | null {
		return this.world.focus ?? null;
	}

	/** 实体是否可持握（游戏声明的 GameDef.holdable 槽位，core 不内嵌任何属性名）。
	 *  未声明的游戏一律不可持握（无缺省属性假设）。 */
	holdable(id: string): boolean {
		return this.def.holdable ? this.def.holdable(this.world, this.actor, id) : false;
	}

	/** 实体是否可作为施动工具（可持握 + 可达）。affordances 枚举与 probe 审计共用。
	 *  可持握走 holdable 槽位，可达性走 GameDef.reach 槽位（core 不内嵌空间模型）。 */
	wieldable(id: string): boolean {
		if (!this.holdable(id)) return false;
		return this.def.reach ? this.def.reach(this.world, this.actor, id) : true;
	}

	/** 动作空间接地：枚举 动词 × 可见实体 × 候选值，返回当前世界会授予的动作（世界腔理由，去重）。
	 *  预算按动词均分（每个动词最多 maxChecks/动词数 次 check），避免组合量大的动词饿死后续动词。 */
	affordances(maxChecks = 400, maxOut = 30): string[] {
		const out: string[] = [];
		let checks = 0;
		const seen = new Set<string>();
		const defaultReason = messagesFor(this.def).defaultReason;
		const verbEntries = Object.entries(this.def.verbs);
		const perVerbBudget = verbEntries.length ? Math.ceil(maxChecks / verbEntries.length) : maxChecks;
		for (const [verbName, verb] of verbEntries) {
			const entityParams = verb.entityParams ?? [];
			const candidates = verb.candidates?.(this) ?? {};
			const paramLists: Record<string, PropValue[]> = {};
			const instruments = new Set(verb.instrumentParams ?? []);
			for (const p of entityParams) {
				let ids = [...this.visible()];
				if (instruments.has(p)) ids = ids.filter((id) => this.wieldable(id));
				paramLists[p] = ids;
			}
			for (const [p, vals] of Object.entries(candidates)) paramLists[p] = vals;
			const keys = Object.keys(paramLists);
			if (!keys.length) continue;
			let verbChecks = 0;
			const gen = (idx: number, acc: Record<string, PropValue>) => {
				if (checks >= maxChecks || verbChecks >= perVerbBudget || out.length >= maxOut) return;
				if (idx === keys.length) {
					checks++;
					verbChecks++;
					const r = this.check({ verb: verbName, params: { ...acc } });
					if (r.ok && r.reason !== defaultReason && !seen.has(r.reason)) {
						seen.add(r.reason);
						out.push(r.reason);
					}
					return;
				}
				const p = keys[idx]!;
				for (const v of paramLists[p]!) gen(idx + 1, { ...acc, [p]: v });
			};
			gen(0, {});
		}
		return out;
	}

	/** 动作的世界腔描述（表达层「本回合尝试」与动作空间兜底描述共用）。 */
	describeAction(action: Action): string {
		const verb = this.def.verbs[action.verb];
		const name = (v: PropValue): string => {
			if (typeof v === "string") {
				const hit = entity(this.world, v);
				if (hit) return hit.name;
			}
			return String(v);
		};
		if (action.verb === TICK_VERB) return messagesFor(this.def).timePassed;
		if (!verb) return `「${action.verb}」`;
		const entityParams = new Set(verb.entityParams ?? []);
		const parts = Object.entries(action.params).map(([k, v]) => {
			if (entityParams.has(k)) return name(v);
			if (typeof v === "string") return name(v);
			return String(v);
		});
		return parts.length ? `${verb.label} ${parts.join("，")}` : verb.label;
	}

	tick(n = 1): StepResult[] {
		const out: StepResult[] = [];
		for (let i = 0; i < n; i++) {
			this.world.time += 1;
			out.push(...this.runSystems());
		}
		return out;
	}

	/** 按注册顺序运行全部系统一次，产出并提交 deltas（tick 与 reactive 共用）。
	 *  silent=true 时不写日志（reactive 场景：事件已并入动作的 sr，避免重复记录）。 */
	private runSystems(silent = false): StepResult[] {
		const out: StepResult[] = [];
		const emit = (sr: StepResult): void => {
			if (!silent) this.log.push(sr);
			out.push(sr);
		};
		for (const sys of this.def.systems ?? []) {
			const src = `system:${sys.id}`;
			// 与动作裁决一致注入 actor 伪参数：系统法则的 when/each 可用 E.v("actor") 引用玩家。
			const res = evaluateLaw(this.exprCtx({ actor: this.actor }), sys, true);
			const deltas = res.deltas ?? [];
			if (!res.granted || deltas.length === 0) continue;
			const cc = this.commitChecked(deltas, src);
			if (!cc.ok) {
				emit({
					ok: false,
					reason: cc.reason ?? messagesFor(this.def).noResponse,
					changes: [],
					action: { verb: TICK_VERB, params: { n: this.world.time } },
					deniedBy: "rule",
					denial: cc.denial,
					src,
				});
				continue;
			}
			emit({
				ok: true,
				reason: res.reason ?? messagesFor(this.def).defaultReason,
				changes: cc.changes,
				action: { verb: TICK_VERB, params: { n: this.world.time } },
				facts: res.facts,
				// 自动派生 id 的 spawn 无法在 deltas 阶段预知实体 id，须并入提交后的 #spawn 变更实体。
				involved: [...new Set([...(res.involved ?? []), ...cc.changes.filter((c) => c.prop === "#spawn").map((c) => String(c.to))])],
				src,
			});
		}
		return out;
	}

	/** 克隆世界，模拟 n 个 tick，返回将要发生的变更（不改变自身状态）。表达层的"即将发生"合法预言来源。
	 *  随机由 games 层以 World 状态自持（纯函数派生），克隆世界即完整预言——无需序列快照机制。 */
	dryTick(n = 1): StepResult[] {
		const clone = Simulation.fromWorld(this.def, this.world);
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
				const id = d.id ?? `e${this.world.nextId ?? 0}`;
				if (!this.world.entities.some((x) => x.id === id)) {
					this.world.entities.push({
						id,
						kind: d.kind,
						name: d.name,
						tags: d.tags ?? [],
						props: d.props ?? {},
					});
					changes.push({ entity: id, prop: "#spawn", from: null, to: id, src });
				}
				if (!d.id) this.world.nextId = (this.world.nextId ?? 0) + 1;
				continue;
			}
			if (d.op === "destroy") {
				if (!entity(this.world, d.entity)) continue;
				this.world.entities = this.world.entities.filter((x) => x.id !== d.entity);
				if (rels.length) {
					const filtered = rels.filter((r) => r.from !== d.entity && r.to !== d.entity);
					rels.length = 0;
					rels.push(...filtered);
				}
				if (this.world.focus === d.entity) this.world.focus = null;
				if (this.world.traces) delete this.world.traces[d.entity];
				const refProps = Object.entries(this.def.props ?? {}).filter(([, p]) => p.type === "id").map(([k]) => k);
				for (const x of this.world.entities) {
					for (const p of refProps) {
						if (x.props[p] === d.entity) x.props[p] = null;
					}
				}
				changes.push({ entity: d.entity, prop: "#destroy", from: d.entity, to: null, src });
				continue;
			}
			if (d.op === "relSet") {
				const from = relVal(this.world, d.from, d.to, d.type);
				if (from === d.value) continue;
				upsertRel(d.from, d.to, d.type, d.value);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from, to: d.value, src });
				continue;
			}
			if (d.op === "relInc") {
				const prev = Number(relVal(this.world, d.from, d.to, d.type) ?? 0);
				if (!Number.isFinite(prev)) continue;
				const to = prev + d.by;
				upsertRel(d.from, d.to, d.type, to);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from: prev, to, src });
				continue;
			}
			if (d.op === "relDel") {
				const from = relVal(this.world, d.from, d.to, d.type);
				if (from === null) continue;
				const idx = rels.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
				if (idx >= 0) rels.splice(idx, 1);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from, to: null, src });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) continue;
			if (d.op === "set") {
				const from = propGet(e, d.prop);
				if (from === d.value) continue;
				propSet(e, d.prop, d.value);
				changes.push({ entity: d.entity, prop: d.prop, from, to: d.value, src });
			} else if (d.op === "inc") {
				const from = Number(propGet(e, d.prop) ?? 0);
				if (!Number.isFinite(from)) continue;
				const to = from + d.by;
				propSet(e, d.prop, to);
				changes.push({ entity: d.entity, prop: d.prop, from, to, src });
			} else if (d.op === "push") {
				const prev = propGet(e, d.prop);
				const arr = Array.isArray(prev) ? [...(prev as PropValue[])] : [];
				arr.push(d.value);
				propSet(e, d.prop, arr);
				changes.push({ entity: d.entity, prop: d.prop, from: prev, to: arr, src });
			} else if (d.op === "del") {
				const from = propGet(e, d.prop);
				if (from === null) continue;
				propSet(e, d.prop, null);
				changes.push({ entity: d.entity, prop: d.prop, from, to: null, src });
			}
		}
		return changes;
	}
}
