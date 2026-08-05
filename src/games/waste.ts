import type { Change, GameDef, PropDef, PropValue, Simulation, VerbDef, World } from "../core/sim.ts";
import { entity, internalPropsOf } from "../core/sim.ts";
import { E, P, type DenialDef, type Expr, type ExprCtx, type Law } from "../core/expr.ts";
import { reachFor, inTreeVisible } from "./space.ts";
import { Type } from "typebox";

/**
 * 开放世界（流沙荒原）：约束化重量（声明式法则）示例。
 *  - 预设动词覆盖物理/资源动作：travel（路径移动）、move（拿起/放下/放入）、open（开合）、use（点燃）、harvest（采集）。
 *  - 环境响应走声明式动词：mark（刻记号 marked）、examine（勘察 examined）——实体不可知法则按 reach 授予。
 *  - 结构性属性（位置/材质/明火/燃烧/生灭/钱币）由法则/系统变更，凭任意通道都改不了（提交硬墙 + 不变式）。
 *  - 验证目标：AI 无法凭一句话凭空改材质、传送不可达物体、创造/销毁实体、击杀生物——开放世界的自由度
 *    由 动词表 + 法则 + 不变式硬墙 给出，不再需要 core 的 AI 提后果通道。
 */

const MATERIAL_LABELS: Record<string, string> = {
	stone: "石", wood: "木", iron: "铁", clay: "陶", ash: "灰烬", seed: "种", bone: "骨",
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
	hp: { type: "number", label: "体力" },
	thirst: { type: "number", label: "渴感" },
	water: { type: "number", label: "存水" },
	marked: { type: "boolean", label: "刻痕", stylistic: true },
	examined: { type: "boolean", label: "勘察" },
	inscription: { type: "string", label: "铭文" },
	burnTicks: { type: "number", internal: true },
	regrowTicks: { type: "number", internal: true },
};

const PROP_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(WASTE_PROPS).filter(([, p]) => p.label).map(([k, p]) => [k, p.label!]),
);

/** 可达性拒绝（core 空槽 reach/reachReason 接线）：reason（构件 prose）优先，缺省"它不在这里。"。 */
const unreachable = (e: Expr): DenialDef => ({
	law: "reach",
	subject: e,
	reason: { k: "reachReason", e },
	text: () => "它不在这里。",
});

function summarizeWaste(input: { world: World; changes: Change[]; actor: string }): string {
	const { world, changes, actor } = input;
	const player = entity(world, actor);
	const loc = player?.props["in"] as string | null;
	const place = entity(world, loc ?? "")?.name ?? "原地";
	const lines: string[] = [`你身处${place}。`];
	if (player) {
		if (Number(player.props.thirst ?? 0) > 0) lines.push(`渴感 ${player.props.thirst}`);
		if (Number(player.props.water ?? 0) > 0) lines.push(`随身水 ${player.props.water}`);
	}
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
			{ when: [P.eq(E.p("actor", "in"), E.v("dest"))], denial: { law: "travel.stay", object: E.v("dest"), text: () => "你已经在目的地了。" } },
			{
				when: [P.exists(E.v("dest")), P.eq(E.p("dest", "space"), E.lit(true)), P.not({ k: "rel", from: E.p("actor", "in"), to: E.v("dest"), type: "path" })],
				denial: { law: "travel.noway", subject: E.p("actor", "in"), object: E.v("dest"), text: (d, ctx) => `从这里（${ctx.name(d.subject ?? "")}）没有路径通往${ctx.name(d.object ?? "")}。` },
			},
		],
		reason: (ctx) => `你沿荒径走向${ctx.name(String(ctx.env.dest))}。`,
	},
	{ id: "travel.dest", reject: { when: [P.not(P.exists(E.v("dest")))], denial: { law: "travel.dest", object: E.v("dest"), text: (d, ctx) => `${ctx.name(d.object ?? "")}？这里没有这个地方。` } } },
	{ id: "denyAll.travel", reject: { when: [], denial: { law: "denyAll.travel", subject: E.p("actor", "in"), object: E.v("dest"), text: (d, ctx) => `你无法前往${ctx.name(d.object ?? "")}。` } } },
];

const moveLaws: Law[] = [
	{
		id: "move.open",
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
			{ when: [P.eq(E.p("entity", "in"), E.v("actor")), P.eq(E.v("dest"), E.v("actor"))], denial: { law: "move.hold", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}已经在你的手中。` } },
		],
		reason: moveReason,
	},
	{ id: "move.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: unreachable(E.v("entity")) } },
	{ id: "move.grabbable", reject: { when: [P.reach(E.v("entity")), P.neq(E.p("entity", "grabbable"), E.lit(true))], denial: { law: "move.grabbable", subject: E.v("entity"), text: (d, ctx) => `你搬不动${ctx.name(d.subject ?? "")}。` } } },
	{ id: "move.dest", reject: { when: [P.not(P.exists(E.v("dest")))], denial: { law: "move.dest", subject: E.v("entity"), object: E.v("dest"), text: (d, ctx) => `${ctx.name(d.object ?? "")}？这里没有这个东西。` } } },
	{ id: "denyAll.move", reject: { when: [], denial: { law: "denyAll.move", subject: E.v("entity"), object: E.v("dest"), text: (d, ctx) => `你无法把${ctx.name(d.subject ?? "")}放到${ctx.name(d.object ?? "")}。` } } },
];

/** 容器开合（原 openLaws.container.open/close 迁为预设动词法则）。 */
const openVerbLaws: Law[] = [
	{
		id: "open.open",
		when: [P.reach(E.v("entity")), P.eq(E.p("entity", "openable"), E.lit(true)), P.neq(E.p("entity", "open"), E.lit(true))],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(true) }],
		denies: [{ when: [P.eq(E.p("entity", "openable"), E.lit(true)), P.eq(E.p("entity", "open"), E.lit(true))], denial: { law: "open.already", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}已经开着。` } }],
		reason: (ctx) => `你打开了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "open.close",
		when: [P.reach(E.v("entity")), P.eq(E.p("entity", "openable"), E.lit(true)), P.eq(E.p("entity", "open"), E.lit(true))],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(false) }],
		reason: (ctx) => `你合上了${ctx.name(String(ctx.env.entity))}。`,
	},
	{ id: "open.notopenable", reject: { when: [P.reach(E.v("entity")), P.neq(E.p("entity", "openable"), E.lit(true))], denial: { law: "open.notopenable", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}打不开。` } } },
	{ id: "denyAll.open", reject: { when: [], denial: { law: "denyAll.open", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}没有变化。` } } },
];

/** 点燃（原 openLaws.fire 迁为预设动词法则：source 有明火 → target 可燃）。 */
const useLaws: Law[] = [
	{
		id: "use.ignite",
		when: [
			P.eq(E.p("source", "lit"), E.lit(true)),
			P.reach(E.v("target")),
			P.eq(E.p("target", "flammable"), E.lit(true)),
			P.neq(E.p("target", "burning"), E.lit(true)),
		],
		each: [
			{ op: "set", e: E.v("target"), p: "burning", v: E.lit(true) },
			{ op: "set", e: E.v("target"), p: "lit", v: E.lit(true) },
		],
		denies: [
			{ when: [P.neq(E.p("source", "lit"), E.lit(true))], denial: { law: "ignite.nolight", subject: E.v("source"), object: E.v("target"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}没有火。` } },
			{ when: [P.not(P.reach(E.v("target")))], denial: unreachable(E.v("target")) },
			{ when: [P.neq(E.p("target", "flammable"), E.lit(true))], denial: { law: "ignite.notflammable", subject: E.v("source"), object: E.v("target"), text: (d, ctx) => `${ctx.name(d.object ?? "")}烧不起来。` } },
			{ when: [P.eq(E.p("target", "burning"), E.lit(true))], denial: { law: "ignite.burning", subject: E.v("source"), object: E.v("target"), text: (d, ctx) => `${ctx.name(d.object ?? "")}已经在燃烧。` } },
		],
		reason: (ctx) => `${ctx.name(String(ctx.env.target))}燃起来了。`,
	},
	{ id: "denyAll.use", reject: { when: [], denial: { law: "denyAll.use", subject: E.v("source"), object: E.v("target"), text: (d, ctx) => `你用${ctx.name(d.subject ?? "")}碰了碰${ctx.name(d.object ?? "")}，什么也没有发生。` } } },
];

/** 采集浆果（原 openLaws.gather 迁为预设动词法则：成熟可达的浆果丛 → 得 1 颗浆果）。 */
const harvestLaws: Law[] = [
	{
		id: "harvest.berries",
		when: [P.reach(E.v("bush")), P.eq(E.p("bush", "ripe"), E.lit(true))],
		each: [
			{ op: "inc", e: E.lit("player"), p: "berries", by: E.lit(1) },
			{ op: "set", e: E.v("bush"), p: "ripe", v: E.lit(false) },
		],
		denies: [{ when: [P.eq(E.p("bush", "ripe"), E.lit(false))], denial: { law: "harvest.unripe", subject: E.v("bush"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}还没有成熟。` } }],
		reason: (ctx) => `你采下了一颗浆果。`,
	},
	{ id: "denyAll.harvest", reject: { when: [], denial: { law: "denyAll.harvest", subject: E.v("bush"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}无法被采集。` } } },
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

/** 渴感：每 tick +3（开放世界生存压力，无休息动词——干渴是不可逆的累积）。 */
const thirstRise: Law = {
	id: "thirst.rise",
	over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true))] }],
	each: [{ op: "inc", e: E.v("p"), p: "thirst", by: E.lit(3) }],
};

/** 干渴伤身：渴感 >= 100 后每 tick -5 体力。 */
const thirstHurt: Law = {
	id: "thirst.hurt",
	over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.gte(E.p("p", "thirst"), E.lit(100))] }],
	each: [{ op: "inc", e: E.v("p"), p: "hp", by: E.lit(-5) }],
	facts: (ctx) => [{ text: "干渴灼烧着你的喉咙，你感到头昏眼花。", entities: [ctx.actor] }],
};

/** 夜袭（实体不可知）：同地且有攻击性的活物，入夜（time%4==3）时扑咬玩家。 */
const beastNight: Law = {
	id: "beast.night",
	over: [{ var: "b", source: "entities", where: [P.eq(E.p("b", "alive"), E.lit(true)), P.eq(E.p("b", "aggressive"), E.lit(true)), P.eq(E.p("b", "in"), E.p("actor", "in"))] }],
	when: [P.eq(E.mod(E.time(), E.lit(4)), E.lit(3))],
	each: [{ op: "inc", e: E.v("actor"), p: "hp", by: E.lit(-2) }],
	facts: (ctx) => [{ text: `夜色里，${ctx.name(String(ctx.env.b))}扑上来在你身上留下了一道伤口。`, entities: [String(ctx.env.b), ctx.actor] }],
};

/** 舀水（泉眼）：随身水囊容量 2，装满了不能再舀。 */
const fillLaws: Law[] = [
	{ id: "fill.water", when: [P.reach(E.lit("spring")), P.lt(E.p("actor", "water"), E.lit(2))], each: [{ op: "inc", e: E.v("actor"), p: "water", by: E.lit(1) }], reason: () => "你俯身舀起一袋清水。" },
	{ id: "fill.full", reject: { when: [P.reach(E.lit("spring")), P.gte(E.p("actor", "water"), E.lit(2))], denial: { law: "fill.full", subject: E.lit("spring"), text: (d, ctx) => `你的水囊已经满了，装不下更多。` } } },
	{ id: "denyAll.fill", reject: { when: [], denial: { law: "denyAll.fill", subject: E.lit("spring"), text: (d, ctx) => `这里没有水可舀。` } } },
];

/** 饮水：在泉眼直接喝（渴感归零）；或喝随身水（消耗 1 份水，渴感归零）。 */
const drinkLaws: Law[] = [
	{ id: "drink.spring", when: [P.reach(E.lit("spring"))], each: [{ op: "set", e: E.v("actor"), p: "thirst", v: E.lit(0) }], reason: () => "你俯身喝了口清泉，渴意尽消。" },
	{ id: "drink.carry", when: [P.gte(E.p("actor", "water"), E.lit(1))], each: [{ op: "inc", e: E.v("actor"), p: "water", by: E.lit(-1) }, { op: "set", e: E.v("actor"), p: "thirst", v: E.lit(0) }], reason: () => "你喝了口随身带着的水，精神一振。" },
	{ id: "denyAll.drink", reject: { when: [], denial: { law: "denyAll.drink", text: () => "你口干舌燥，却找不到水喝。" } } },
];

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

/** 刻记号/勘察：实体不可知法则（按 reach 授予），自由环境响应脱离枚举，但结构性属性仍由法则管理。 */
const markLaws: Law[] = [
	{
		id: "mark.carve",
		when: [P.reach(E.v("entity")), P.neq(E.p("entity", "marked"), E.lit(true))],
		each: [{ op: "set", e: E.v("entity"), p: "marked", v: E.lit(true) }],
		denies: [{ when: [P.eq(E.p("entity", "marked"), E.lit(true))], denial: { law: "mark.done", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}上已经刻过记号了。` } }],
		reason: (ctx) => `你在${ctx.name(String(ctx.env.entity))}上刻下了一道记号。`,
	},
	{ id: "mark.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: unreachable(E.v("entity")) } },
	{ id: "denyAll.mark", reject: { when: [], denial: { law: "denyAll.mark", subject: E.v("entity"), text: () => "你没能在这上面刻下记号。" } } },
];

const examineLaws: Law[] = [
	{
		id: "examine.look",
		when: [P.reach(E.v("entity"))],
		each: [{ op: "set", e: E.v("entity"), p: "examined", v: E.lit(true) }],
		reason: (ctx) => `你仔细勘察了${ctx.name(String(ctx.env.entity))}。`,
	},
	{ id: "examine.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: unreachable(E.v("entity")) } },
	{ id: "denyAll.examine", reject: { when: [], denial: { law: "denyAll.examine", subject: E.v("entity"), text: () => "你没能看清这个东西。" } } },
];

/** 环境响应动词的候选域：可见实体 - 玩家 - 场景（mark/examine 共用）。 */
const envTargetCandidates = (sim: Simulation): Record<string, string[]> => ({
	entity: [...sim.visible()].filter((id) => id !== sim.actor && sim.world.entities.find((e) => e.id === id)?.props.space !== true),
});

const markVerb: VerbDef = {
	label: "刻记号",
	description: "在可达的实体上刻下一道记号（marked）。刻过的不能再刻。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	candidates: envTargetCandidates,
	laws: markLaws,
};

const examineVerb: VerbDef = {
	label: "勘察",
	description: "仔细查看一个可达的实体（examined），记下它的细节。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	candidates: envTargetCandidates,
	laws: examineLaws,
};

const openVerb: VerbDef = {
	label: "开合",
	description: "打开或关闭一个可开启物（entity 用 open:true / false）。",
	schema: Type.Object({
		entity: Type.String({ description: "目标实体 id" }),
		open: Type.Boolean({ description: "true 打开 / false 关闭" }),
	}),
	entityParams: ["entity"],
	candidates: () => ({ open: [true, false] }),
	laws: openVerbLaws,
};

const useVerb: VerbDef = {
	label: "作用",
	description: "用一件东西作用于另一件东西（点燃：source 必须有明火，target 必须可燃）。施动的东西必须拿得动且够得着。",
	schema: Type.Object({
		source: Type.String({ description: "施动实体 id（必须可持握且可达）" }),
		target: Type.String({ description: "受动实体 id" }),
	}),
	entityParams: ["source", "target"],
	instrumentParams: ["source"],
	laws: useLaws,
};

const harvestVerb: VerbDef = {
	label: "采集",
	description: "从成熟的可达浆果丛采下一颗浆果（bush 是浆果丛实体 id）。",
	schema: Type.Object({ bush: Type.String({ description: "浆果丛实体 id（必须成熟且可达）" }) }),
	entityParams: ["bush"],
	candidates: (sim) => ({ bush: sim.world.entities.filter((e) => e.props.ripe === true).map((e) => e.id) }),
	laws: harvestLaws,
};

const fillVerb: VerbDef = {
	label: "舀水",
	description: "在泉眼处把随身水囊装满一袋清水（水囊容量 2）。",
	schema: Type.Object({}),
	laws: fillLaws,
};

const drinkVerb: VerbDef = {
	label: "饮水",
	description: "在泉眼直接喝（渴感归零）；或喝随身带着的水（消耗 1 份，渴感归零）。",
	schema: Type.Object({}),
	laws: drinkLaws,
};

/** 容器包含树可达性的理由文案与接线（游戏侧构件接入 core 的 reach/reachReason 槽位）。 */
const REACH_MSGS = { reachMissing: "这里没有这个东西。", reachCycle: "位置存在循环引用。", reachNotHere: "它不在这里。", reachClosed: (n: string) => `${n}是关着的。` };
const REACH_OPTS = { msgs: REACH_MSGS };

export const waste: GameDef = {
	id: "waste",
	title: "流沙荒原（开放世界）",
	playerId: "player",
	messages: {
		noResponse: "世界没有以这种方式回应。",
		unknownVerb: (verb) => `世界不认识「${verb}」这种动作。`,
		invalidParams: (label, known) => `「${label}」的参数不在声明范围内（可接受：${known}）。`,
		invisibleEntity: (ids) => `实体 ${ids.join("、")} 不可见或不存在。`,
		...REACH_MSGS,
		instrumentUnholdable: (name) => `${name}太沉重，你拿不动它来施力。`,
		instrumentUnreachable: (name) => `${name}在你够不到的地方，没法拿来使。`,
		invariantRejected: () => "世界拒绝了这个变化。",
		defaultReason: "……",
		notInActionPhase: "当前不在行动阶段，无法执行操作。",
		timePassed: "时间流逝",
		timeChanged: "时间流逝，世界发生了变化。",
	},
	verbs: {
		travel: travelVerb,
		move: moveVerb,
		open: openVerb,
		use: useVerb,
		harvest: harvestVerb,
		fill: fillVerb,
		drink: drinkVerb,
		mark: markVerb,
		examine: examineVerb,
	},
	world: {
		time: 0,
		entities: [
			{ id: "camp", name: "破败的营地", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "riverbed", name: "干涸的河床", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "mound", name: "风蚀的土丘", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "dune", name: "沙海边缘", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "forest", name: "枯林", kind: "space", tags: ["landmark"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "camp", berries: 0, hp: 100, thirst: 0, water: 0 } },
			{ id: "campfire", name: "火堆", kind: "structure", tags: ["fire"], props: { in: "camp", material: "wood", flammable: true, lit: true, burning: true, warm: true, lasting: true, grabbable: false } },
			{ id: "torch", name: "火把", kind: "item", tags: ["light"], props: { in: "camp", material: "wood", flammable: true, lit: true, grabbable: true } },
			{ id: "flint", name: "燧石", kind: "item", tags: ["stone"], props: { in: "camp", material: "stone", grabbable: true, sharp: true } },
			{ id: "pot", name: "陶罐", kind: "container", tags: ["clay"], props: { in: "camp", material: "clay", openable: true, open: false, container: true } },
			{ id: "seed", name: "旧种子", kind: "item", tags: ["seed"], props: { in: "pot", material: "seed", grabbable: true } },
			{ id: "drywood", name: "朽木", kind: "item", tags: ["wood", "fuel"], props: { in: "camp", material: "wood", flammable: true, grabbable: true } },
			{ id: "sword", name: "旧铁剑", kind: "item", tags: ["metal"], props: { in: "riverbed", material: "iron", grabbable: true, sharp: true } },
			{ id: "spring", name: "泉眼", kind: "scenery", tags: ["water"], props: { in: "riverbed", material: "stone" } },
			{ id: "stele", name: "无名石碑", kind: "structure", tags: ["stone"], props: { in: "mound", material: "stone", inscription: "我无口却能语，无腿却能行，无手却能握，无翼却能飞。" } },
			{ id: "altar", name: "石台", kind: "structure", tags: ["stone"], props: { in: "mound", material: "stone", inscription: "把最重的想念放下，路就会轻。" } },
			{ id: "worm", name: "沙虫", kind: "creature", tags: ["beast"], props: { in: "dune", aggressive: true, alive: true } },
			{ id: "fox", name: "沙狐", kind: "creature", tags: ["beast"], props: { in: "dune", aggressive: true, alive: true } },
			{ id: "sage", name: "沙鼠", kind: "creature", tags: ["beast"], props: { in: "riverbed", alive: true } },
			{ id: "skull", name: "颅骨", kind: "item", tags: ["bone"], props: { in: "dune", material: "bone", grabbable: true } },
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
	systems: [burnTickSys, burnAshSys, growTickSys, growRipeSys, thirstRise, thirstHurt, beastNight],
	props: WASTE_PROPS,
	grounding: (world, actor) => [...inTreeVisible(world, actor, REACH_OPTS)],
	...reachFor(REACH_OPTS),
	// 可持握语义由游戏声明（core 不假定属性名）：荒原上只有明确可持握（grabbable）的东西能当工具/被拿起。
	holdable: (world, _actor, id) => entity(world, id)?.props.grabbable === true,
	summarize: summarizeWaste,
	digest: digestWaste,
	hint: `世界法则（模拟层强制执行）：
1. 荒原有五处地点，经路径（relations type "path"）连通；travel 只能沿路径前往相邻地点，凭空换地点被拒。
2. 可持握（grabbable）物品可用 move 拿起（放到你手中）、放下（放到当前地点）、放入打开的容器；搬不动、够不着、目标不存在一律被拒。
3. 开/关可开启物用 open；明火源（lit）用 use 点燃可燃物（flammable）；成熟（ripe）的可达浆果丛用 harvest 采下 1 颗浆果。
4. 渴感每刻 +3，满 100 后每刻 -5 体力；在河床泉眼（spring）可 drink 直接喝或用 fill 舀进随身水囊（容量 2）带走。
5. 入夜（时刻 % 4 == 3）时，同地的攻击性活物（沙虫、沙狐）会扑咬你；天黑前离开它们的领地。
6. 在可达实体上刻记号用 mark，细看一个实体用 examine（石碑、石台、颅骨、沙鼠等都能交互）。
7. 时间系统：燃烧 3 个时刻后烧成灰烬；浆果丛被采后约 5 个时刻再生。`,
};
