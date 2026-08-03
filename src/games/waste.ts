import type { AssertionRule, Change, Entity, GameDef, PropDef, PropValue, Simulation, VerbDef, World } from "../core/sim.ts";
import { entity, inTreeVisible, internalPropsOf } from "../core/sim.ts";
import { E, P, type ExprCtx, type Law } from "../core/expr.ts";
import { Type } from "typebox";

/**
 * 极端用例：规则极少、超高灵活度的开放世界（流沙荒原）。
 *  - 只有 3 个动词：travel（沿路径移动）、move（拿起/放下/放入）、do（开放通道）。
 *  - 预设法则极简且全部按属性键控（不特判实体 id）：邻接路径、可持握+可达、容器开合。
 *  - 自由探索与自由交互全部经开放通道（fallback:"proven"）反向解析——AI 只提期望后果（desired），
 *    世界在开放法则（Law.open）里反查，命中才经该法则提交（级联/时间系统/不变式照常）。
 *  - 验证目标：AI 无法凭一句话凭空改材质、传送不可达物体、创造/销毁实体、击杀生物——
 *    开放世界的自由度是"开放法则声明的后果"的枚举，不是模型幻觉。
 */

const MATERIAL_LABELS: Record<string, string> = {
	stone: "石", wood: "木", iron: "铁", clay: "陶", ash: "灰烬", seed: "种",
};

const WASTE_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "位置" },
	actor: { type: "boolean", internal: true },
	space: { type: "boolean", label: "场景" },
	grabbable: { type: "boolean", label: "可持握" },
	openable: { type: "boolean", label: "可开启" },
	open: { type: "boolean", label: "开合" },
	container: { type: "boolean", label: "容器" },
	material: { type: "string", label: "材质" },
	flammable: { type: "boolean", label: "可燃性" },
	lit: { type: "boolean", label: "明火" },
	burning: { type: "boolean", label: "燃烧状态" },
	warm: { type: "boolean", label: "温暖" },
	lasting: { type: "boolean", label: "持久" },
	sharp: { type: "boolean", label: "锋利" },
	tall: { type: "boolean", label: "高大" },
	aggressive: { type: "boolean", label: "攻击性" },
	alive: { type: "boolean", label: "存活" },
	ripe: { type: "boolean", label: "成熟" },
	berries: { type: "number", label: "浆果" },
	marked: { type: "boolean", label: "刻痕", stylistic: true },
	examined: { type: "boolean", label: "勘察" },
	inscription: { type: "string", label: "铭文" },
	burnTicks: { type: "number", internal: true },
	regrowTicks: { type: "number", internal: true },
};

const PROP_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(WASTE_PROPS).filter(([, p]) => p.label).map(([k, p]) => [k, p.label!]),
);

function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

function summarizeWaste(input: { world: World; changes: Change[]; actor: string }): string {
	const { world, changes, actor } = input;
	const player = entity(world, actor);
	const loc = player?.props["in"] as string | null;
	const place = entity(world, loc ?? "")?.name ?? "原地";
	const lines: string[] = [`你身处${place}。`];
	for (const e of world.entities) {
		if (e.id === actor || e.props.space === true) continue;
		if (e.props["in"] !== loc) continue;
		const bits: string[] = [];
		if (e.props.burning === true) bits.push("燃着");
		else if (e.props.lit === true) bits.push("有明火");
		if (e.props.openable === true) bits.push(e.props.open === true ? "开着" : "关着");
		if (e.props.ripe === true) bits.push("浆果成熟");
		if (typeof e.props.material === "string") bits.push(`${MATERIAL_LABELS[e.props.material] ?? e.props.material}质`);
		lines.push(`- ${e.name}${bits.length ? `（${bits.join("，")}）` : ""}`);
	}
	const fmt = (v: PropValue): string => {
		if (v === null) return "无";
		if (v === true) return "有";
		if (v === false) return "无";
		if (typeof v === "string") {
			const hit = entity(world, v);
			if (hit) return hit.name;
			return MATERIAL_LABELS[v] ?? v;
		}
		return String(v);
	};
	for (const ch of changes) {
		if (ch.prop.startsWith("#")) continue;
		const e = entity(world, ch.entity);
		lines.push(`变更：${e?.name ?? ch.entity}的${PROP_LABELS[ch.prop] ?? ch.prop} ${fmt(ch.from)} → ${fmt(ch.to)}`);
	}
	return lines.join("\n");
}

function digestWaste(sim: Simulation): string {
	const vis = sim.visible();
	const internal = internalPropsOf(sim.def);
	const items = sim.world.entities
		.filter((e) => vis.has(e.id))
		.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
		}));
	const rels = (sim.world.relations ?? []).map((r) => ({
		from: entity(sim.world, r.from)?.name ?? r.from,
		to: entity(sim.world, r.to)?.name ?? r.to,
		type: r.type,
	}));
	return JSON.stringify({ time: sim.world.time, relations: rels, entities: items }, null, 2);
}

/** 移动授予理由：拿起 / 放到（当前场景）/ 放进（打开的容器）。 */
const moveReason = (ctx: ExprCtx): string => {
	const x = String(ctx.env.entity);
	const d = String(ctx.env.dest);
	if (d === ctx.actor) return `你拿起了${ctx.name(x)}。`;
	return ctx.prop(d, "space") === true ? `你把${ctx.name(x)}放在${ctx.name(d)}。` : `你把${ctx.name(x)}放进了${ctx.name(d)}。`;
};

const travelLaws: Law[] = [
	{
		id: "travel.walk",
		when: [
			P.exists(E.v("dest")),
			P.eq(E.p("dest", "space"), E.lit(true)),
			P.neq(E.p("actor", "in"), E.v("dest")),
			{ k: "rel", from: E.p("actor", "in"), to: E.v("dest"), type: "path" },
		],
		each: [{ op: "set", e: E.v("actor"), p: "in", v: E.v("dest") }],
		denies: [
			{ when: [P.eq(E.p("actor", "in"), E.v("dest"))], denial: { law: "travel.stay", object: E.v("dest") } },
			{
				when: [P.exists(E.v("dest")), P.eq(E.p("dest", "space"), E.lit(true)), P.not({ k: "rel", from: E.p("actor", "in"), to: E.v("dest"), type: "path" })],
				denial: { law: "travel.noway", subject: E.p("actor", "in"), object: E.v("dest") },
			},
		],
		reason: (ctx) => `你沿荒径走向${ctx.name(String(ctx.env.dest))}。`,
	},
	{ id: "travel.dest", reject: { when: [P.not(P.exists(E.v("dest")))], denial: { law: "travel.dest", object: E.v("dest") } } },
	{ id: "denyAll.travel", reject: { when: [], denial: { law: "denyAll.travel", subject: E.p("actor", "in"), object: E.v("dest") } } },
];

const moveLaws: Law[] = [
	{
		id: "move.open",
		open: true,
		when: [
			P.reach(E.v("entity")),
			P.eq(E.p("entity", "grabbable"), E.lit(true)),
			P.exists(E.v("dest")),
			P.neq(E.v("entity"), E.v("dest")),
			P.or([
				P.and([P.eq(E.v("dest"), E.v("actor")), P.neq(E.p("entity", "in"), E.v("actor"))]),
				P.and([
					P.neq(E.v("dest"), E.v("actor")),
					P.or([
						P.and([P.eq(E.v("dest"), E.p("actor", "in")), P.eq(E.p("dest", "space"), E.lit(true))]),
						P.and([P.eq(E.p("dest", "openable"), E.lit(true)), P.eq(E.p("dest", "open"), E.lit(true))]),
					]),
				]),
			]),
		],
		each: [{ op: "set", e: E.v("entity"), p: "in", v: E.v("dest") }],
		denies: [
			{ when: [P.eq(E.p("entity", "in"), E.v("actor")), P.eq(E.v("dest"), E.v("actor"))], denial: { law: "move.hold", subject: E.v("entity") } },
		],
		reason: moveReason,
	},
	{ id: "move.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: { law: "reach", subject: E.v("entity"), reason: { k: "reachReason", e: E.v("entity") } } } },
	{ id: "move.grabbable", reject: { when: [P.reach(E.v("entity")), P.neq(E.p("entity", "grabbable"), E.lit(true))], denial: { law: "move.grabbable", subject: E.v("entity") } } },
	{ id: "move.dest", reject: { when: [P.not(P.exists(E.v("dest")))], denial: { law: "move.dest", subject: E.v("entity"), object: E.v("dest") } } },
	{ id: "denyAll.move", reject: { when: [], denial: { law: "denyAll.move", subject: E.v("entity"), object: E.v("dest") } } },
];

/**
 * 开放法则：开放的后果集合 = 荒野里"世界愿意授予"的自由动作。
 *  AI 的 desired 只有能由其中某法则产出时才会被授予——这是"AI 提后果、世界走法则"的重量所在。
 */
const openLaws: Law[] = [
	{
		id: "mark",
		open: true,
		when: [P.reach(E.v("entity"))],
		each: [{ op: "set", e: E.v("entity"), p: "marked", v: E.lit(true) }],
		reason: (ctx) => `你在${ctx.name(String(ctx.env.entity))}上留下了一道刻痕。`,
	},
	{
		id: "observe",
		open: true,
		when: [P.reach(E.v("entity"))],
		each: [{ op: "set", e: E.v("entity"), p: "examined", v: E.lit(true) }],
		reason: (ctx) => `你仔细察看了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "container.open",
		open: true,
		when: [P.reach(E.v("entity")), P.eq(E.p("entity", "openable"), E.lit(true)), P.neq(E.p("entity", "open"), E.lit(true))],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(true) }],
		reason: (ctx) => `你打开了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "container.close",
		open: true,
		when: [P.reach(E.v("entity")), P.eq(E.p("entity", "openable"), E.lit(true)), P.eq(E.p("entity", "open"), E.lit(true))],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(false) }],
		reason: (ctx) => `你合上了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "fire",
		open: true,
		over: [{ var: "s", source: "entities", where: [P.eq(E.p("s", "lit"), E.lit(true)), P.reach(E.v("s"))] }],
		when: [
			P.reach(E.v("t")),
			P.eq(E.p("t", "flammable"), E.lit(true)),
			P.neq(E.p("t", "burning"), E.lit(true)),
			P.neq(E.v("t"), E.v("s")),
		],
		each: [
			{ op: "set", e: E.v("t"), p: "burning", v: E.lit(true) },
			{ op: "set", e: E.v("t"), p: "lit", v: E.lit(true) },
		],
		reason: (ctx) => `${ctx.name(String(ctx.env.t))}燃起来了。`,
	},
	{
		id: "gather",
		open: true,
		// desired 只含 inc player.berries（t 无法从 desired 反解），t 必须声明为 over 由世界枚举（首个成熟可达者）。
		over: [{ var: "t", source: "entities", where: [P.eq(E.p("t", "ripe"), E.lit(true))] }],
		when: [P.reach(E.v("t"))],
		each: [
			{ op: "inc", e: E.lit("player"), p: "berries", by: E.lit(1) },
			{ op: "set", e: E.v("t"), p: "ripe", v: E.lit(false) },
		],
		reason: (ctx) => `你采下了一颗浆果。`,
	},
];

/** 开放通道动词的兜底：无 proof 或无法则可解析时一律拒绝（proven 通道优先于本法则）。 */
const doLaws: Law[] = [
	{ id: "denyAll.do", reject: { when: [], denial: { law: "denyAll.do" } } },
];

/** 时间系统：燃烧计数 → 烧成灰烬；浆果丛再生。极简、全按属性键控。 */
const burnTickSys: Law = {
	id: "burn.tick",
	over: [{ var: "b", source: "entities", where: [P.eq(E.p("b", "burning"), E.lit(true))] }],
	each: [{ op: "inc", e: E.v("b"), p: "burnTicks", by: E.lit(1) }],
};

const burnAshSys: Law = {
	id: "burn.ash",
	over: [{ var: "b", source: "entities", where: [P.eq(E.p("b", "burning"), E.lit(true)), P.neq(E.p("b", "lasting"), E.lit(true)), P.gte(E.p("b", "burnTicks"), E.lit(3))] }],
	each: [
		{ op: "set", e: E.v("b"), p: "burning", v: E.lit(false) },
		{ op: "set", e: E.v("b"), p: "lit", v: E.lit(false) },
		{ op: "set", e: E.v("b"), p: "material", v: E.lit("ash") },
		{ op: "set", e: E.v("b"), p: "flammable", v: E.lit(false) },
	],
	facts: (ctx) => [{ text: `${ctx.name(String(ctx.env.b))}烧成了灰烬。`, entities: [String(ctx.env.b)] }],
};

const growTickSys: Law = {
	id: "grow.tick",
	over: [{ var: "b", source: "entities", where: [P.eq(E.p("b", "ripe"), E.lit(false))] }],
	each: [{ op: "inc", e: E.v("b"), p: "regrowTicks", by: E.lit(1) }],
};

const growRipeSys: Law = {
	id: "grow.ripe",
	over: [{ var: "b", source: "entities", where: [P.gte(E.p("b", "regrowTicks"), E.lit(5))] }],
	each: [
		{ op: "set", e: E.v("b"), p: "ripe", v: E.lit(true) },
		{ op: "set", e: E.v("b"), p: "regrowTicks", v: E.lit(0) },
	],
};

const WASTE_ASSERTION_RULES: AssertionRule[] = [
	{
		prop: "burning",
		strong: ["焦烟", "冒烟", "烧成灰烬"],
		weak: ["燃烧", "点燃", "燃起", "烧起来"],
		targets: (world, actor) =>
			world.entities.filter((e) => e.id !== actor && e.props.space !== true && !(e.props.lit === true || e.props.burning === true || e.props.material === "ash")),
		error: (e) => `描述虚构了「${e.name}」的燃烧/点燃，但当前状态并非如此。`,
	},
	{
		prop: "in",
		weak: ["手中", "手里", "握着", "拿着"],
		exemptPending: false,
		targets: (world, actor) =>
			world.entities.filter((e) => e.id !== actor && e.props.space !== true && e.props.grabbable === true && e.props["in"] !== actor),
		error: (e) => `描述虚构了「${e.name}」在你手中，但当前它不在你这里。`,
	},
];

const WASTE_NEGATIONS = ["未", "没", "无", "不", "别", "休", "尚未", "未曾", "不曾"];
const WASTE_SENTENCE_PUNCT = /[。！？!?；;]/;
const WASTE_ASSERTION_PUNCT = /[，。；！？、—]/;

const travelVerb: VerbDef = {
	label: "跋涉",
	description: "沿荒原小径前往相邻的地点（dest 是当前所在地的相邻场景 id）。",
	schema: Type.Object({ dest: Type.String({ description: "相邻地点的实体 id（见路径关系）" }) }),
	entityParams: ["dest"],
	candidates: (sim) => {
		const cur = sim.world.entities.find((e) => e.id === sim.actor)?.props["in"] as string | null;
		const paths = (sim.world.relations ?? []).filter((r) => r.from === cur && r.type === "path").map((r) => r.to);
		return { dest: paths };
	},
	laws: travelLaws,
};

const moveVerb: VerbDef = {
	label: "拾取与放置",
	description: "拿起/放下/放入：把可达的可持握物品移到目标位置（玩家手中 / 当前地点 / 打开的容器）。",
	schema: Type.Object({
		entity: Type.String({ description: "要移动的物品 id（必须可持握且可达）" }),
		dest: Type.String({ description: "目标 id（你 / 当前地点 / 打开的容器）" }),
	}),
	entityParams: ["entity", "dest"],
	candidates: (sim) => ({ dest: [...sim.visible(), sim.actor] }),
	laws: moveLaws,
};

const doVerb: VerbDef = {
	label: "自由行动",
	description: `提出一个没有被预设动词覆盖的自由动作。proof 格式：{ "claims": [可选前置事实，须全部为真], "desired": [期望后果，至少一条] }。世界只在开放法则中反向解析——你的期望后果能由某条法则精确产出时才授予，不能则拒绝。可授予的后果（desired）：
- 刻痕: {"op":"set","entity":"<id>","prop":"marked","value":true}
- 勘察: {"op":"set","entity":"<id>","prop":"examined","value":true}
- 打开可开启物: {"op":"set","entity":"<id>","prop":"open","value":true}
- 关闭可开启物: {"op":"set","entity":"<id>","prop":"open","value":false}
- 点燃可达的可燃物（需附近有明火源）: {"op":"set","entity":"<id>","prop":"burning","value":true}
- 采摘成熟浆果丛（得 1 颗浆果）: {"op":"inc","entity":"player","prop":"berries","by":1}
- 拿起/放下/放入可持握物: {"op":"set","entity":"<id>","prop":"in","value":"<目标id>"}
claims 示例：{"k":"reach","e":{"k":"lit","v":"<实体id>"}}、{"k":"exists","e":{"k":"lit","v":"<实体id>"}}、{"k":"cmp","a":{"k":"prop","e":{"k":"lit","v":"<id>"},"p":"<属性>"},"op":"eq","b":{"k":"lit","v":"<值>"}}。凭空改变材质、凭空创造/销毁实体、击杀生物等无对应法则的后果一律被拒。`,
	schema: Type.Object({}),
	laws: doLaws,
	fallback: "proven",
};

export const waste: GameDef = {
	id: "waste",
	title: "流沙荒原（开放世界）",
	playerId: "player",
	messages: {
		noResponse: "世界没有以这种方式回应。",
		unknownVerb: (verb) => `世界不认识「${verb}」这种动作。`,
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
	},
	verbs: {
		travel: travelVerb,
		move: moveVerb,
		do: doVerb,
	},
	world: {
		time: 0,
		entities: [
			{ id: "camp", name: "破败的营地", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "riverbed", name: "干涸的河床", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "mound", name: "风蚀的土丘", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "dune", name: "沙海边缘", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "forest", name: "枯林", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "camp", berries: 0 } },
			{ id: "campfire", name: "火堆", kind: "structure", tags: ["fire"], props: { in: "camp", material: "wood", flammable: true, lit: true, burning: true, warm: true, lasting: true, grabbable: false } },
			{ id: "flint", name: "燧石", kind: "item", tags: ["stone"], props: { in: "camp", material: "stone", grabbable: true, sharp: true } },
			{ id: "pot", name: "陶罐", kind: "container", tags: ["clay"], props: { in: "camp", material: "clay", openable: true, open: false, container: true } },
			{ id: "seed", name: "旧种子", kind: "item", tags: ["seed"], props: { in: "pot", material: "seed", grabbable: true } },
			{ id: "drywood", name: "朽木", kind: "item", tags: ["wood", "fuel"], props: { in: "camp", material: "wood", flammable: true, grabbable: true } },
			{ id: "sword", name: "旧铁剑", kind: "item", tags: ["metal"], props: { in: "riverbed", material: "iron", grabbable: true, sharp: true } },
			{ id: "stele", name: "无名石碑", kind: "structure", tags: ["stone"], props: { in: "mound", material: "stone", inscription: "我无口却能语，无腿却能行，无手却能握，无翼却能飞。" } },
			{ id: "worm", name: "沙虫", kind: "creature", tags: ["beast"], props: { in: "dune", aggressive: true, alive: true } },
			{ id: "box", name: "兽皮箱", kind: "container", tags: ["leather"], props: { in: "dune", openable: true, open: false, container: true } },
			{ id: "shard", name: "陶片", kind: "item", tags: ["clay"], props: { in: "box", material: "clay", grabbable: true } },
			{ id: "drytree", name: "枯树", kind: "structure", tags: ["wood"], props: { in: "forest", material: "wood", flammable: true, tall: true } },
			{ id: "bush", name: "浆果丛", kind: "plant", tags: ["bush"], props: { in: "forest", ripe: true, regrowTicks: 0 } },
		],
		relations: [
			{ from: "camp", to: "riverbed", type: "path", value: true },
			{ from: "riverbed", to: "camp", type: "path", value: true },
			{ from: "camp", to: "forest", type: "path", value: true },
			{ from: "forest", to: "camp", type: "path", value: true },
			{ from: "riverbed", to: "mound", type: "path", value: true },
			{ from: "mound", to: "riverbed", type: "path", value: true },
			{ from: "mound", to: "dune", type: "path", value: true },
			{ from: "dune", to: "mound", type: "path", value: true },
			{ from: "dune", to: "forest", type: "path", value: true },
			{ from: "forest", to: "dune", type: "path", value: true },
		],
	},
	systems: [burnTickSys, burnAshSys, growTickSys, growRipeSys],
	openLaws,
	denialTemplates: {
		reach: (d, w) => d.reason ?? "它不在这里。",
		"travel.stay": () => "你已经在目的地了。",
		"travel.noway": (d, w) => `从这里（${name(w, d.subject ?? "")}）没有路径通往${name(w, d.object ?? "")}。`,
		"travel.dest": (d, w) => `${name(w, d.object ?? "")}？这里没有这个地方。`,
		"move.hold": (d, w) => `${name(w, d.subject ?? "")}已经在你的手中。`,
		"move.grabbable": (d, w) => `你搬不动${name(w, d.subject ?? "")}。`,
		"move.dest": (d, w) => `${name(w, d.object ?? "")}？这里没有这个东西。`,
		"denyAll.move": (d, w) => `你无法把${name(w, d.subject ?? "")}放到${name(w, d.object ?? "")}。`,
		"denyAll.travel": (d, w) => `你无法前往${name(w, d.object ?? "")}。`,
		"denyAll.do": () => "世界没有以这种方式回应。",
		"proof.fail": (d) => d.debug ?? "世界没有以这种方式回应。",
		"invariant.integrity": () => "世界拒绝了这个变化。",
	},
	props: WASTE_PROPS,
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	summarize: summarizeWaste,
	digest: digestWaste,
	assertionRules: WASTE_ASSERTION_RULES,
	negationWords: WASTE_NEGATIONS,
	sentencePunct: WASTE_SENTENCE_PUNCT,
	assertionPunct: WASTE_ASSERTION_PUNCT,
	hint: `世界法则（模拟层强制执行）：
1. 荒原有五处地点，经路径（relations type "path"）连通；travel 只能沿路径前往相邻地点，凭空换地点被拒。
2. 可持握（grabbable）物品可用 move 拿起（放到你手中）、放下（放到当前地点）、放入打开的容器；搬不动、够不着、目标不存在一律被拒。
3. 自由动作走 do（开放通道）：只能提出开放法则声明的后果——刻痕、勘察、开/关容器、点燃可燃物（需附近有明火源）、采摘成熟浆果（每次 1 颗，采后需等浆果丛再生）、拿起/放下/放入。凭空改材质、凭空创造/销毁物体、击杀生物等无对应后果的请求一律被世界拒绝。
4. 时间系统：燃烧 3 个时刻后烧成灰烬；浆果丛被采后约 5 个时刻再生。`,
};
