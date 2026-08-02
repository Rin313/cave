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
	/** 拒绝痕迹：实体 id → 玩家累计尝试/被拒次数（rule 与 denyAll 拒绝时累加）。 */
	traces?: Record<string, number>;
	/** 关系边表：from→to 的 type 关系（信任/记忆/派系等）。游戏声明，规则以 deltas 变更。 */
	relations?: Rel[];
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
	| { op: "relDel"; from: string; to: string; type: string };

export interface Change {
	entity: string;
	prop: string;
	from: PropValue;
	to: PropValue;
}

/** 动作提案：由游戏声明的动词表（verb）驱动，参数由动词 schema 约束。 */
export interface Action {
	verb: string;
	params: Record<string, PropValue>;
}

export interface RuleCtx {
	world: World;
	action: Action | null;
	actor: string;
	rng: () => number;
	def: GameDef;
}

/** core 产出的用户可见文案：游戏可经 GameDef.messages 覆写，缺省中文兜底。 */
export interface Messages {
	/** 所有法则均未表态时的兜底回应。 */
	noResponse: string;
	/** 动词不存在（core 校验层拒绝，非规则产出）。 */
	unknownVerb: (verb: string) => string;
	/** 参数不在动词 schema 声明范围内（core 校验层拒绝）。 */
	invalidParams: (label: string, known: string) => string;
	/** 实体参数不可见/不存在（core 校验层拒绝）。 */
	invisibleEntity: (ids: string[]) => string;
	/** 标准库 inTreeReach 的可达性理由（作为 denial.reason 的缺省）。 */
	reachMissing: string;
	reachCycle: string;
	reachNotHere: string;
	reachClosed: (name: string) => string;
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

/** 结构化拒绝：非散文，散文由引擎按法则模板渲染。 */
export interface Denial {
	/** 法则标识，如 "pry.soft"（审计与探测依据）。 */
	law: string;
	/** 施动实体 id。 */
	subject?: string;
	/** 受动实体 id。 */
	object?: string;
	/** 涉及属性（denyAll 等按属性兜底的模板用）。 */
	prop?: string;
	/** 可选世界腔覆盖文本（如标准库返回的 prose）；缺省用 GameDef.denialTemplates。 */
	reason?: string;
}

export interface RuleResult {
	granted: boolean;
	/** 授予时的世界腔陈述（可选，表达层可自由发挥；缺省由引擎生成）。 */
	reason?: string;
	changes?: Delta[];
	/** 法则背书的结构化新事实（表达层的合法新事实词汇，防止模型发明后果）。 */
	facts?: Fact[];
	/** 因果涉及集：本法则涉及的全部实体（含未变更的因果源，如引燃木箱的火把）。声明校验依据。 */
	involved?: string[];
	/** 结构化拒绝（granted=false 时给出）。 */
	denial?: Denial;
}

export type Rule = (ctx: RuleCtx) => RuleResult;

/** 时间系统：每 tick 按注册顺序运行，产出 deltas。 */
export type SystemDef = { id: string; run: Rule };

/** 引擎保留伪动词：时间系统（tick）产出 StepResult 时的动作标识。
 *  不是游戏声明的动词，游戏不应声明同名动词；describeAction 据此渲染「时间流逝」。 */
export const TICK_VERB = "tick";

export interface VerbDef {
	label: string;
	description: string;
	/** TypeBox object schema，引擎据此生成 act 工具参数校验。 */
	schema: unknown;
	/** 声明哪些参数是实体 id（供可见性校验与探测）。 */
	entityParams?: string[];
	/** 施动工具参数：这些实体参数作为「工具」被挥动/使用（如 use 的 source）。
	 *  核心在规则前跑共享前提检查：必须可持握（grabbable）且在可达范围；不满足直接拒绝，不进入规则。
	 *  affordances 枚举自动跳过不可持握工具；probe 依此审计「规则授予但前提不满足」的潜在洞。 */
	instrumentParams?: string[];
	/** 属性选择参数：这些非实体参数的取值是实体属性名。core 据此做 propLabels 标签替换、
	 *  affordances 按属性相关性排序、probe 的有意义缺口过滤——不再硬编码参数名 "prop"。 */
	propParams?: string[];
	/** 非实体参数的候选值；动作空间接地与法则探测共用。不提供则跳过该参数。 */
	candidates?: (sim: Simulation) => Record<string, PropValue[]>;
	rules: Rule[];
}

export interface GameDef {
	id: string;
	title: string;
	playerId: string;
	verbs: Record<string, VerbDef>;
	world: World;
	systems?: SystemDef[];
	/** 兜底法则：某动词所有法则未表态且无具体理由时调用。 */
	denyAll?: Rule;
	/** 结构化拒绝的世界腔渲染：按法则 id 提供模板。缺省返回通用兜底。 */
	denialTemplates?: Record<string, (d: Denial, world: World) => string>;
	hint?: string;
	/** 属性展示名：拒绝/变更文本中属性名的世界化说法。 */
	propLabels?: Record<string, string>;
	/** 内部属性：不进 LLM 序列化、不进变更列表、不进表达校验。 */
	internalProps?: string[];
	/** 表达层后置校验钩子；pending 为即将发生（下一 tick）的变更，供钩子区分"预言"与"已发生"。 */
	validateText?: (input: { text: string; world: World; changes: Change[]; actor: string; pending: Change[] }) => string | null;
	/** 确定性回退摘要钩子。 */
	summarize?: (input: { world: World; changes: Change[]; actor: string }) => string;
	/** 可见实体索引：决定哪些实体进 LLM 序列化。缺省全部可见。 */
	grounding?: (world: World, actor: string) => string[];
	/** 法则探测域：sim probe 枚举动作参数候选实体时使用的实体集。缺省 = 可见实体 - 玩家 - space 标记的场景实体。
	 *  大实体量游戏可在此裁剪（如只给可交互实体），控制 probe 组合规模与信号质量。 */
	probeScope?: (world: World, actor: string) => string[];
	/** 动作后因果反应：granted 动作提交后按注册顺序跑一次 systems（默认 false）。 */
	reactiveSystems?: boolean;
	/** 序列化投影：决定状态以什么形态进映射/表达 prompt。缺省 = serialize() 全量 JSON。
	 *  游戏可声明精简/结构化的 digest（如焦点优先、关系格式化、省略冗余字段），以控制 prompt 体积与表达自由度。 */
	digest?: (sim: Simulation) => string;
	/** 额外禁止词：游戏自定义的实现术语（内部概念名等），表达校验按词边界匹配，不进散文。
	 *  语言相关的词汇约束由游戏声明（引擎不感知语言）。 */
	forbiddenTerms?: string[];
	/** core 产出的用户可见文案覆写；缺省为 DEFAULT_MESSAGES（中文）。 */
	messages?: Partial<Messages>;
}

/** core 文案缺省值（中文）。 */
export const DEFAULT_MESSAGES: Messages = {
	noResponse: "世界没有回应这个操作。",
	unknownVerb: (verb) => `世界不认识「${verb}」这种操作。`,
	invalidParams: (label, known) => `「${label}」的参数不在声明范围内（可接受：${known}）。`,
	invisibleEntity: (ids) => `实体 ${ids.join("、")} 不可见或不存在。`,
	reachMissing: "这里没有这个东西。",
	reachCycle: "位置存在循环引用。",
	reachNotHere: "它不在这里。",
	reachClosed: (name) => `${name}是关着的。`,
	defaultReason: "……",
	notInActionPhase: "当前不在行动阶段，无法执行操作。",
	timePassed: "时间流逝",
	timeChanged: "时间流逝，世界发生了变化。",
};

/** 合并游戏覆写：缺省使用 DEFAULT_MESSAGES。 */
export function messagesFor(def: GameDef): Messages {
	return { ...DEFAULT_MESSAGES, ...def.messages };
}

export interface StepResult {
	ok: boolean;
	reason: string;
	changes: Change[];
	action: Action;
	/** 否决来源：具体法则给了世界性理由（rule），还是所有法则都未表态落到兜底（denyAll）。 */
	deniedBy?: "rule" | "denyAll";
	/** 结构化拒绝（deniedBy=rule 时给出），供表达层/审计使用。 */
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
}

export function entity(world: World, id: string): Entity | undefined {
	return world.entities.find((e) => e.id === id);
}

/** 把结构化拒绝渲染为世界腔文本：优先 denial.reason 覆盖，其次按法则模板，缺省兜底。 */
export function renderDenial(def: GameDef, denial: Denial, world: World): string {
	if (denial.reason != null) return denial.reason;
	const tmpl = def.denialTemplates?.[denial.law];
	if (tmpl) return tmpl(denial, world);
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
		const p = parts[i];
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

export function prop(world: World, id: string, path: string): PropValue {
	const e = entity(world, id);
	return e ? propGet(e, path) : null;
}

/** delta 构造器命名空间：法则用 D.set/inc/push/del 表达结构化变更。 */
export const D = {
	set: (entity: string, prop: string, value: PropValue): Delta => ({ op: "set", entity, prop, value }),
	inc: (entity: string, prop: string, by: number): Delta => ({ op: "inc", entity, prop, by }),
	push: (entity: string, prop: string, value: PropValue): Delta => ({ op: "push", entity, prop, value }),
	del: (entity: string, prop: string): Delta => ({ op: "del", entity, prop }),
	relSet: (from: string, to: string, type: string, value: number | string | boolean): Delta => ({ op: "relSet", from, to, type, value }),
	relInc: (from: string, to: string, type: string, by: number): Delta => ({ op: "relInc", from, to, type, by }),
	relDel: (from: string, to: string, type: string): Delta => ({ op: "relDel", from, to, type }),
};

/** 关系查询：from→to 的指定 type 的值（无则 null）。 */
export function relVal(world: World, from: string, to: string, type: string): number | string | boolean | null {
	return world.relations?.find((r) => r.from === from && r.to === to && r.type === type)?.value ?? null;
}

/** 关系查询：from 的全部关系边（可按 type 过滤）。 */
export function relAll(world: World, from: string, type?: string): Rel[] {
	return (world.relations ?? []).filter((r) => r.from === from && (type === undefined || r.type === type));
}

/** 可快照/恢复的确定性随机数。快照后可克隆同一随机序列（dryTick 的「即将发生」预言用）。 */
export interface Rng {
	(): number;
	snapshot: () => number;
}

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	const f = (() => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}) as Rng;
	f.snapshot = () => a;
	return f;
}

export function restoreRng(snapshot: number): Rng {
	return mulberry32(snapshot);
}

/** 标准库可达性：容器包含树语义（space / openable / open / in）。游戏可选接入。
 *  理由文案可用 msgs 定制（缺省 DEFAULT_MESSAGES 中文）。 */
export function inTreeReach(world: World, actor: string, id: string, msgs: Messages = DEFAULT_MESSAGES): { ok: boolean; reason: string } {
	const e = entity(world, id);
	if (!e) return { ok: false, reason: msgs.reachMissing };
	let cur = e.props["in"] as string | null;
	const seen = new Set<string>();
	while (cur != null && cur !== actor) {
		if (seen.has(cur)) return { ok: false, reason: msgs.reachCycle };
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return { ok: false, reason: msgs.reachNotHere };
		if (parent.props.space === true) {
			return parent.id === (entity(world, actor)?.props["in"] as string)
				? { ok: true, reason: "" }
				: { ok: false, reason: msgs.reachNotHere };
		}
		if (parent.props.openable === true && parent.props.open !== true) {
			if (parent.props.wedgedBy === id) return { ok: true, reason: "" };
			return { ok: false, reason: msgs.reachClosed(parent.name) };
		}
		cur = parent.props["in"] as string | null;
	}
	return { ok: true, reason: "" };
}

/** 标准库可见性：容器包含树语义下玩家可达的全部实体。 */
export function inTreeVisible(world: World, actor: string): Set<string> {
	const vis = new Set<string>([actor]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (inTreeReach(world, actor, e.id).ok) vis.add(e.id);
	}
	return vis;
}

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
	private rand: Rng;
	/** 探测模式：跳过施动工具前提（instrumentParams）检查，仅 probeGrant 临时开启，审计「规则本身是否会在不可持握工具上授予」。 */
	private probeSkipInstruments = false;

	constructor(def: GameDef, seed = 1) {
		this.def = def;
		this.world = JSON.parse(JSON.stringify(def.world)) as World;
		this.rand = mulberry32(seed);
	}

	get actor(): string {
		return this.def.playerId;
	}

	visible(): Set<string> {
		if (this.def.grounding) return new Set(this.def.grounding(this.world, this.actor));
		return new Set(this.world.entities.map((e) => e.id));
	}

	static fromWorld(def: GameDef, world: World, rng?: Rng): Simulation {
		const s = new Simulation(def, 1);
		s.world.entities = JSON.parse(JSON.stringify(world.entities)) as Entity[];
		s.world.time = world.time;
		s.world.focus = world.focus ?? null;
		s.world.traces = world.traces ? { ...world.traces } : undefined;
		s.world.relations = world.relations ? JSON.parse(JSON.stringify(world.relations)) : undefined;
		if (rng) s.rand = rng;
		return s;
	}

	/** 只读裁决（不提交、不入日志、不扰动主随机序列）：动作空间接地与法则探测共用。 */
	check(action: Action): StepResult {
		const r = this.adjudicateRaw(action, () => 0.5);
		return { ok: r.ok, reason: r.reason, changes: [], action, facts: r.facts, involved: r.involved, deniedBy: r.deniedBy, denial: r.denial };
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

	private adjudicateRaw(action: Action, rng: Rng | (() => number)): RawResult {
		const verb = this.def.verbs[action.verb];
		if (!verb) {
			return { ok: false, reason: messagesFor(this.def).unknownVerb(action.verb), changes: [], deltas: [], action, deniedBy: "rule" };
		}
		const inst = this.probeSkipInstruments ? null : this.instrumentViolation(action, verb);
		if (inst) {
			return { ok: false, reason: renderDenial(this.def, inst, this.world), changes: [], deltas: [], action, deniedBy: "rule", denial: inst };
		}
		const ctx: RuleCtx = { world: this.world, action, actor: this.actor, rng, def: this.def };
		let denial: Denial | null = null;
		for (const rule of verb.rules) {
			const res = rule(ctx);
			if (res.granted) {
				return { ok: true, reason: res.reason ?? messagesFor(this.def).defaultReason, changes: [], deltas: res.changes ?? [], action, facts: res.facts, involved: res.involved };
			}
			if (res.denial != null && denial == null) denial = res.denial;
		}
		const deniedBy: "rule" | "denyAll" = denial != null ? "rule" : "denyAll";
		const denyAllDenial = !denial && this.def.denyAll ? this.def.denyAll(ctx).denial : null;
		const reason = denial != null
			? renderDenial(this.def, denial, this.world)
			: (denyAllDenial ? renderDenial(this.def, denyAllDenial, this.world) : "世界没有回应这个操作。");
		return { ok: false, reason, changes: [], deltas: [], action, deniedBy, denial: denial ?? denyAllDenial ?? undefined };
	}

	/** 施动工具前提检查：声明为 instrumentParams 的参数实体必须可持握（grabbable）且可达。
	 *  只产出结构化拒绝（law + subject），散文由 GameDef.denialTemplates 渲染，core 不撰写理由。 */
	private instrumentViolation(action: Action, verb: VerbDef): Denial | null {
		for (const p of verb.instrumentParams ?? []) {
			const id = action.params[p];
			if (typeof id !== "string" || !id) continue;
			if (!entity(this.world, id)) continue;
			if (!this.wieldable(id)) {
				if (prop(this.world, id, "grabbable") !== true) return { law: "instrument.unholdable", subject: id };
				return { law: "instrument.unreachable", subject: id };
			}
		}
		return null;
	}

	apply(action: Action): StepResult {
		const beforeVisible = this.visible();
		const r = this.adjudicateRaw(action, this.rand);
		const changes = r.ok ? this.commit(r.deltas) : [];
		let sr: StepResult = r.ok
			? { ok: true, reason: r.reason, changes, action, facts: r.facts, involved: r.involved }
			: { ok: false, reason: r.reason, changes: [], action, deniedBy: r.deniedBy, denial: r.denial };

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
	private updateFocus(r: { ok: boolean; denial?: Denial }, action: Action, beforeVisible: Set<string>): void {
		if (r.ok) {
			const revealed = [...this.visible()].filter((id) => id !== this.actor && !beforeVisible.has(id));
			const id = revealed.length ? revealed[0] : this.firstEntityParam(action);
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

	/** 实体是否可作为施动工具（可持握 + 可达）。affordances 枚举与 probe 审计共用。 */
	wieldable(id: string): boolean {
		if (prop(this.world, id, "grabbable") !== true) return false;
		return inTreeReach(this.world, this.actor, id).ok;
	}

	/** 动作空间接地：枚举 动词 × 可见实体 × 候选值，返回当前世界会授予的动作（世界腔理由，去重）。
	 *  预算按动词均分（每个动词最多 maxChecks/动词数 次 check），避免组合量大的动词饿死后续动词；
	 *  实体参数按「是否持有该动词的候选属性」排序，让可能授予的组合先被枚举，截断只损失低价值组合。 */
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
			const propParams = verb.propParams ?? [];
			const propDomain = new Set<string>();
			for (const [p, vals] of Object.entries(candidates)) {
				if (!propParams.includes(p)) continue;
				for (const v of vals) if (typeof v === "string") propDomain.add(v);
			}
			const rank = (id: string): number => {
				const e = entity(this.world, id);
				if (!e) return 0;
				let n = 0;
				for (const p of propDomain) if (p in e.props) n++;
				return n;
			};
			const visibleIds = [...this.visible()];
			const paramLists: Record<string, PropValue[]> = {};
			const instruments = new Set(verb.instrumentParams ?? []);
			for (const p of entityParams) {
				let ids = propDomain.size
					? visibleIds.slice().sort((a, b) => rank(b) - rank(a))
					: visibleIds;
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
				const p = keys[idx];
				for (const v of paramLists[p]) gen(idx + 1, { ...acc, [p]: v });
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
		const propParams = verb.propParams ?? [];
		const parts = Object.entries(action.params).map(([k, v]) => {
			if (propParams.includes(k)) return this.def.propLabels?.[String(v)] ?? String(v);
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
		for (const sys of this.def.systems ?? []) {
			const ctx: RuleCtx = { world: this.world, action: null, actor: this.actor, rng: this.rand, def: this.def };
			const res = sys.run(ctx);
			if (res.granted && (res.changes?.length ?? 0) > 0) {
				const changes = this.commit(res.changes ?? []);
				const sr: StepResult = {
					ok: true,
					reason: res.reason ?? messagesFor(this.def).defaultReason,
					changes,
					action: { verb: TICK_VERB, params: { n: this.world.time } },
					facts: res.facts,
					involved: res.involved,
				};
				if (!silent) this.log.push(sr);
				out.push(sr);
			}
		}
		return out;
	}

	/** 克隆世界与随机序列，模拟 n 个 tick，返回将要发生的变更（不改变自身状态）。表达层的"即将发生"合法预言来源。 */
	dryTick(n = 1): StepResult[] {
		const clone = Simulation.fromWorld(this.def, this.world, restoreRng(this.rand.snapshot()));
		return clone.tick(n);
	}

	snapshot(): World {
		return JSON.parse(JSON.stringify(this.world)) as World;
	}

	serialize(): string {
		return serialize(this.world, this.visible(), this.def.internalProps);
	}

	/** 序列化投影：映射/表达 prompt 用的状态呈现。游戏可声明 def.digest 覆盖。 */
	digest(): string {
		if (this.def.digest) return this.def.digest(this);
		return this.serialize();
	}

	private commit(deltas: Delta[]): Change[] {
		const changes: Change[] = [];
		const rels = (this.world.relations = this.world.relations ?? []);
		const upsertRel = (from: string, to: string, type: string, value: number | string | boolean) => {
			const hit = rels.find((r) => r.from === from && r.to === to && r.type === type);
			if (hit) hit.value = value;
			else rels.push({ from, to, type, value });
		};
		for (const d of deltas) {
			if (d.op === "relSet") {
				const from = relVal(this.world, d.from, d.to, d.type);
				if (from === d.value) continue;
				upsertRel(d.from, d.to, d.type, d.value);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from, to: d.value });
				continue;
			}
			if (d.op === "relInc") {
				const prev = Number(relVal(this.world, d.from, d.to, d.type) ?? 0);
				if (!Number.isFinite(prev)) continue;
				const to = prev + d.by;
				upsertRel(d.from, d.to, d.type, to);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from: prev, to });
				continue;
			}
			if (d.op === "relDel") {
				const from = relVal(this.world, d.from, d.to, d.type);
				if (from === null) continue;
				const idx = rels.findIndex((r) => r.from === d.from && r.to === d.to && r.type === d.type);
				if (idx >= 0) rels.splice(idx, 1);
				changes.push({ entity: d.from, prop: `rel:${d.type}@${d.to}`, from, to: null });
				continue;
			}
			const e = entity(this.world, d.entity);
			if (!e) continue;
			if (d.op === "set") {
				const from = propGet(e, d.prop);
				if (from === d.value) continue;
				propSet(e, d.prop, d.value);
				changes.push({ entity: d.entity, prop: d.prop, from, to: d.value });
			} else if (d.op === "inc") {
				const from = Number(propGet(e, d.prop) ?? 0);
				if (!Number.isFinite(from)) continue;
				const to = from + d.by;
				propSet(e, d.prop, to);
				changes.push({ entity: d.entity, prop: d.prop, from, to });
			} else if (d.op === "push") {
				const prev = propGet(e, d.prop);
				const arr = Array.isArray(prev) ? [...(prev as PropValue[])] : [];
				arr.push(d.value);
				propSet(e, d.prop, arr);
				changes.push({ entity: d.entity, prop: d.prop, from: prev, to: arr });
			} else if (d.op === "del") {
				const from = propGet(e, d.prop);
				if (from === null) continue;
				propSet(e, d.prop, null);
				changes.push({ entity: d.entity, prop: d.prop, from, to: null });
			}
		}
		return changes;
	}
}
