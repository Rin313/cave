import type { AssertionRule, Change, Entity, GameDef, PropDef, PropValue, Simulation, VerbDef, World } from "../core/sim.ts";
import { entity, inTreeVisible, internalPropsOf } from "../core/sim.ts";
import { sumProp } from "../core/util.ts";
import { E, P, type Expr, type ExprCtx, type Law } from "../core/expr.ts";
import { Type } from "typebox";

/** 实体名解析：world 版（拒绝模板用）。 */
function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

/** 楔在门缝里的东西仍可从门缝够到：对关着的门放行（wedgedBy 是 cave 的机制，不属标准库）。 */
function containerAccess(world: World, container: Entity, id: string): boolean {
	return container.props.wedgedBy === id;
}

const MATERIAL_LABELS: Record<string, string> = {
	copper: "铜", bone: "骨", wood: "木", iron: "铁", stone: "石", wax: "蜡", steel: "钢", ash: "灰烬",
};

/** 属性注册表：类型/世界化标签/内部标记。取代 internalProps + propLabels。 */
const CAVE_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "位置" },
	actor: { type: "boolean", internal: true },
	burnTicks: { type: "number", internal: true },
	burning: { type: "boolean", label: "燃烧状态" },
	lit: { type: "boolean", label: "明火" },
	open: { type: "boolean", label: "开合" },
	openable: { type: "boolean", label: "可开启" },
	material: { type: "string", label: "材质" },
	grabbable: { type: "boolean", label: "可持握" },
	flammable: { type: "boolean", label: "可燃性" },
	lightable: { type: "boolean", label: "可点燃" },
	wedgeable: { type: "boolean", label: "可楔入" },
	attachedTo: { type: "id", label: "固定" },
	jammed: { type: "boolean", label: "卡住" },
	wedgedBy: { type: "id", label: "楔住" },
	space: { type: "boolean", label: "场景" },
	container: { type: "boolean", label: "容器" },
	isDoor: { type: "boolean", label: "门" },
	marked: { type: "boolean", label: "刻痕", stylistic: true, access: "soft" },
	coins: { type: "number", label: "铜币" },
};

/** 属性世界化标签（由注册表派生，供 summarizeCave/denyAll 模板使用）。 */
const PROP_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(CAVE_PROPS).filter(([, p]) => p.label).map(([k, p]) => [k, p.label!]),
);

function summarizeCave(input: { world: World; changes: Change[]; actor: string }): string {
	const { world, changes, actor } = input;
	const lines: string[] = [];
	const player = entity(world, actor);
	const loc = player?.props["in"] as string | null;
	const place = entity(world, loc ?? "")?.name ?? "原地";
	lines.push(`你站在${place}。`);
	for (const id of inTreeVisible(world, actor, { containerAccess })) {
		if (id === actor) continue;
		const e = entity(world, id);
		if (!e) continue;
		if (e.props.space === true) continue;
		const bits: string[] = [];
		if (e.props.lit === true) bits.push("燃着");
		if (e.props.burning === true) bits.push("正在燃烧");
		if (e.props.open === true) bits.push("开着");
		else if (e.props.openable === true) bits.push("关着");
		if (e.props.attachedTo != null) bits.push("固定在别处");
		if (e.props.material === "ash") bits.push("已成灰烬");
		else if (typeof e.props.material === "string") bits.push(`${MATERIAL_LABELS[e.props.material] ?? e.props.material}质`);
		const container = e.props["in"] as string | null;
		if (container && container !== actor) {
			const parent = entity(world, container);
			if (parent) bits.push(`在${parent.name}里`);
		}
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
		const label = PROP_LABELS[ch.prop] ?? ch.prop;
		lines.push(`变更：${e?.name ?? ch.entity}的${label} ${fmt(ch.from)} → ${fmt(ch.to)}`);
	}
	return lines.join("\n");
}

/** 序列化投影（R6）：映射/表达 prompt 用的紧凑状态呈现。
 *  保持 JSON 结构（映射层需实体 id 与属性做 grounding），但裁剪冗余（tags 省略）、
 *  关系表合并呈现（社会/叙事状态进 prompt）、焦点实体置顶。缺省可由引擎 serialize() 兜底。 */
function digestCave(sim: Simulation): string {
	const vis = sim.visible();
	const internal = internalPropsOf(sim.def);
	const focus = sim.focus ?? null;
	const items = sim.world.entities
		.filter((e) => vis.has(e.id))
		.sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0))
		.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			props: Object.fromEntries(Object.entries(e.props).filter(([k]) => !internal.has(k))),
		}));
	const rels = (sim.world.relations ?? [])
		.filter((r) => vis.has(r.from) && vis.has(r.to))
		.map((r) => ({
			from: entity(sim.world, r.from)?.name ?? r.from,
			to: entity(sim.world, r.to)?.name ?? r.to,
			type: r.type,
			value: r.value,
		}));
	return JSON.stringify({ time: sim.world.time, focus, traces: sim.world.traces ?? {}, relations: rels, entities: items }, null, 2);
}

const HARD_MIN = 4;
/** 材质硬度决策表（数据）：material → 硬度数值。 */
const MATERIAL_HARD: [string, number][] = [
	["steel", 6], ["stone", 5], ["iron", 4], ["wood", 3], ["bone", 2], ["copper", 1], ["wax", 0],
];

/** 材质硬度表达式（数据决策表：material → 硬度数值，未知材质为 0）。 */
function hardExpr(e: Expr): Expr {
	let acc: Expr = E.lit(0);
	for (const [m, h] of MATERIAL_HARD) acc = { k: "if", c: P.eq(E.prop(e, "material"), E.lit(m)), t: E.lit(h), f: acc };
	return acc;
}

/** move 授予理由：拿起 / 放到（场景）/ 放进（打开的容器）。 */
const moveReason = (ctx: ExprCtx): string => {
	const x = String(ctx.env.entity);
	const d = String(ctx.env.dest);
	if (d === ctx.actor) return `你拿起了${ctx.name(x)}。`;
	return ctx.prop(d, "space") === true ? `你放到了${ctx.name(x)}。` : `你放进了${ctx.name(x)}。`;
};

const moveLaws: Law[] = [
	{
		id: "move.wedge",
		when: [P.eq(E.p("entity", "wedgeable"), E.lit(true)), P.eq(E.p("dest", "isDoor"), E.lit(true)), P.neq(E.p("dest", "jammed"), E.lit(true)), P.reach(E.v("entity"))],
		each: [
			{ op: "set", e: E.v("entity"), p: "in", v: E.v("dest") },
			{ op: "set", e: E.v("dest"), p: "jammed", v: E.lit(true) },
			{ op: "set", e: E.v("dest"), p: "wedgedBy", v: E.v("entity") },
		],
		denies: [
			{ when: [P.eq(E.p("dest", "jammed"), E.lit(true)), P.reach(E.v("entity"))], denial: { law: "wedge.jammed", subject: E.v("entity"), object: E.v("dest") } },
		],
		reason: (ctx) => `你把${ctx.name(String(ctx.env.entity))}塞进了${ctx.name(String(ctx.env.dest))}的门缝，门被卡住了。`,
	},
	{ id: "move.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: { law: "reach", subject: E.v("entity"), reason: { k: "reachReason", e: E.v("entity") } } } },
	{ id: "move.grabbable", reject: { when: [P.reach(E.v("entity")), P.neq(E.p("entity", "grabbable"), E.lit(true))], denial: { law: "move.grabbable", subject: E.v("entity") } } },
	{
		id: "move.hold",
		when: [P.reach(E.v("entity")), P.eq(E.p("entity", "grabbable"), E.lit(true)), P.eq(E.v("dest"), E.v("actor")), P.eq(E.p("entity", "in"), E.v("actor"))],
		reason: (ctx) => `${ctx.name(String(ctx.env.entity))}已经在你的手中。`,
	},
	{
		id: "move.attached",
		reject: {
			when: [
				P.reach(E.v("entity")),
				P.eq(E.p("entity", "grabbable"), E.lit(true)),
				P.eq(E.v("dest"), E.v("actor")),
				P.neq(E.p("entity", "in"), E.v("actor")),
				P.neq(E.p("entity", "attachedTo"), E.lit(null)),
			],
			denial: { law: "move.attached", subject: E.v("entity") },
		},
	},
	{
		id: "move.withWedge",
		// 抽出楔子的完整级联（解门卡 + 移动）
		over: [{ var: "w", source: "entities", where: [P.eq(E.p("w", "wedgedBy"), E.v("entity"))] }],
		when: [
			P.reach(E.v("entity")),
			P.eq(E.p("entity", "grabbable"), E.lit(true)),
			P.or([
				P.and([P.eq(E.v("dest"), E.v("actor")), P.neq(E.p("entity", "in"), E.v("actor")), P.eq(E.p("entity", "attachedTo"), E.lit(null))]),
				P.and([P.neq(E.v("dest"), E.v("actor")), P.exists(E.v("dest")), P.or([P.eq(E.p("dest", "space"), E.lit(true)), P.eq(E.p("dest", "open"), E.lit(true))])]),
			]),
		],
		each: [
			{ op: "del", e: E.v("w"), p: "jammed" },
			{ op: "del", e: E.v("w"), p: "wedgedBy" },
			{ op: "set", e: E.v("entity"), p: "in", v: E.v("dest") },
		],
		reason: moveReason,
	},
	{ id: "move.dest", reject: { when: [P.not(P.exists(E.v("dest")))], denial: { law: "move.dest", subject: E.v("entity"), object: E.v("dest") } } },
	{
		id: "move.closed",
		reject: {
			when: [P.neq(E.v("dest"), E.v("actor")), P.exists(E.v("dest")), P.neq(E.p("dest", "space"), E.lit(true)), P.neq(E.p("dest", "open"), E.lit(true)), P.eq(E.p("dest", "openable"), E.lit(true))],
			denial: { law: "move.closed", subject: E.v("entity"), object: E.v("dest") },
		},
	},
	{
		id: "move.capacity",
		reject: {
			when: [P.neq(E.v("dest"), E.v("actor")), P.exists(E.v("dest")), P.neq(E.p("dest", "space"), E.lit(true)), P.neq(E.p("dest", "open"), E.lit(true)), P.neq(E.p("dest", "openable"), E.lit(true))],
			denial: { law: "move.capacity", subject: E.v("entity"), object: E.v("dest") },
		},
	},
	// 拿起/放下/放入的合并法则：desired 绑定 entity/dest，移动由本法则裁决。
	{
		id: "move.open",
		when: [
			P.reach(E.v("entity")),
			P.eq(E.p("entity", "grabbable"), E.lit(true)),
			P.exists(E.v("dest")),
			P.or([
				P.and([P.eq(E.v("dest"), E.v("actor")), P.eq(E.p("entity", "attachedTo"), E.lit(null))]),
				P.and([P.neq(E.v("dest"), E.v("actor")), P.or([P.eq(E.p("dest", "space"), E.lit(true)), P.eq(E.p("dest", "open"), E.lit(true))])]),
			]),
		],
		each: [{ op: "set", e: E.v("entity"), p: "in", v: E.v("dest") }],
		reason: moveReason,
	},
	// 通用兜底：上述法则均未授予/拒绝时落此（denyAll 语义由数据法则承载）。
	{ id: "denyAll.move", reject: { when: [], denial: { law: "denyAll.move", subject: E.v("entity"), object: E.v("dest") } } },
];

const useLaws: Law[] = [
	{
		id: "use.pry",
		when: [
			P.eq(E.p("target", "openable"), E.lit(true)),
			P.neq(E.p("target", "open"), E.lit(true)),
			P.neq(E.p("target", "jammed"), E.lit(true)),
			P.neq(E.p("source", "lit"), E.lit(true)),
			P.gte(hardExpr(E.v("source")), E.lit(HARD_MIN)),
			P.gt(hardExpr(E.v("source")), hardExpr(E.v("target"))),
			P.reach(E.v("source")),
		],
		each: [{ op: "set", e: E.v("target"), p: "open", v: E.lit(true) }],
		denies: [
			{ when: [P.eq(E.p("target", "open"), E.lit(true))], denial: { law: "pry.open", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.eq(E.p("target", "jammed"), E.lit(true))], denial: { law: "pry.jammed", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.neq(E.p("source", "lit"), E.lit(true)), P.lt(hardExpr(E.v("source")), E.lit(HARD_MIN))], denial: { law: "pry.soft", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.neq(E.p("source", "lit"), E.lit(true)), P.lte(hardExpr(E.v("source")), hardExpr(E.v("target")))], denial: { law: "pry.hardness", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.not(P.reach(E.v("source")))], denial: { law: "reach", subject: E.v("source"), reason: { k: "reachReason", e: E.v("source") } } },
		],
		reason: (ctx) => `你用${ctx.name(String(ctx.env.source))}撬开了${ctx.name(String(ctx.env.target))}。`,
	},
	{
		id: "use.ignite.lightable",
		when: [
			P.eq(E.p("source", "lit"), E.lit(true)),
			P.reach(E.v("target")),
			P.eq(E.p("target", "flammable"), E.lit(true)),
			P.eq(E.p("target", "lightable"), E.lit(true)),
			P.neq(E.p("target", "lit"), E.lit(true)),
		],
		each: [{ op: "set", e: E.v("target"), p: "lit", v: E.lit(true) }],
		reason: (ctx) => `你点燃了${ctx.name(String(ctx.env.target))}。`,
	},
	{
		id: "use.ignite.burn",
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
			{ when: [P.neq(E.p("source", "lit"), E.lit(true))], denial: { law: "ignite.nolight", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.not(P.reach(E.v("target")))], denial: { law: "reach", subject: E.v("target"), reason: { k: "reachReason", e: E.v("target") } } },
			{ when: [P.neq(E.p("target", "flammable"), E.lit(true))], denial: { law: "ignite.notflammable", subject: E.v("source"), object: E.v("target") } },
			{ when: [P.eq(E.p("target", "burning"), E.lit(true))], denial: { law: "ignite.burning", subject: E.v("source"), object: E.v("target") } },
		],
		reason: (ctx) => `${ctx.name(String(ctx.env.target))}燃起来了！`,
	},
	// 通用兜底：上述法则均未授予/拒绝时落此（denyAll 语义由数据法则承载）。
	{ id: "denyAll.use", reject: { when: [], denial: { law: "denyAll.use", subject: E.v("source"), object: E.v("target") } } },
];

const setLaws: Law[] = [
	{
		id: "set.detach",
		when: [
			P.eq(E.v("prop"), E.lit("attachedTo")),
			P.eq(E.v("value"), E.lit(null)),
			P.neq(E.p("entity", "attachedTo"), E.lit(null)),
			P.reach(E.v("entity")),
		],
		each: [
			{ op: "set", e: E.v("entity"), p: "attachedTo", v: E.lit(null) },
			{ op: "set", e: E.v("entity"), p: "in", v: E.v("actor") },
			{ op: "if", c: [P.exists(E.p("entity", "attachedTo")), P.neq(E.p("entity", "attachedTo"), E.v("actor"))], then: [{ op: "relSet", from: E.p("entity", "attachedTo"), to: E.v("actor"), type: "记忆", v: E.lit(true) }] },
		],
		denies: [
			{ when: [P.eq(E.v("prop"), E.lit("attachedTo")), P.eq(E.v("value"), E.lit(null)), P.eq(E.p("entity", "attachedTo"), E.lit(null))], denial: { law: "detach.none", subject: E.v("entity") } },
			{ when: [P.eq(E.v("prop"), E.lit("attachedTo")), P.eq(E.v("value"), E.lit(null)), P.not(P.reach(E.v("entity")))], denial: { law: "reach", subject: E.v("entity"), reason: { k: "reachReason", e: E.v("entity") } } },
		],
		reason: (ctx) => `你解下了${ctx.name(String(ctx.env.entity))}，它落入了你的手中。`,
	},
	{
		id: "set.open",
		when: [
			P.eq(E.v("prop"), E.lit("open")),
			P.eq(E.v("value"), E.lit(true)),
			P.eq(E.p("entity", "openable"), E.lit(true)),
			P.neq(E.p("entity", "open"), E.lit(true)),
			P.neq(E.p("entity", "jammed"), E.lit(true)),
		],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(true) }],
		denies: [
			{ when: [P.eq(E.v("prop"), E.lit("open")), P.eq(E.v("value"), E.lit(true)), P.neq(E.p("entity", "openable"), E.lit(true))], denial: { law: "open.notopenable", subject: E.v("entity") } },
			{ when: [P.eq(E.v("prop"), E.lit("open")), P.eq(E.v("value"), E.lit(true)), P.eq(E.p("entity", "open"), E.lit(true))], denial: { law: "open.already", subject: E.v("entity") } },
			{ when: [P.eq(E.v("prop"), E.lit("open")), P.eq(E.v("value"), E.lit(true)), P.eq(E.p("entity", "jammed"), E.lit(true))], denial: { law: "open.jammed", subject: E.v("entity") } },
		],
		reason: (ctx) => `你打开了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "set.close",
		when: [
			P.eq(E.v("prop"), E.lit("open")),
			P.eq(E.v("value"), E.lit(false)),
			P.eq(E.p("entity", "openable"), E.lit(true)),
			P.eq(E.p("entity", "open"), E.lit(true)),
		],
		each: [{ op: "set", e: E.v("entity"), p: "open", v: E.lit(false) }],
		denies: [
			{ when: [P.eq(E.v("prop"), E.lit("open")), P.eq(E.v("value"), E.lit(false)), P.eq(E.p("entity", "openable"), E.lit(true)), P.neq(E.p("entity", "open"), E.lit(true))], denial: { law: "close.closed", subject: E.v("entity") } },
		],
		reason: (ctx) => `你关上了${ctx.name(String(ctx.env.entity))}。`,
	},
	{
		id: "set.extinguish",
		when: [
			P.eq(E.v("prop"), E.lit("lit")),
			P.eq(E.v("value"), E.lit(false)),
			P.eq(E.p("entity", "lit"), E.lit(true)),
			P.neq(E.p("entity", "burning"), E.lit(true)),
		],
		each: [{ op: "set", e: E.v("entity"), p: "lit", v: E.lit(false) }],
		denies: [
			{ when: [P.eq(E.v("prop"), E.lit("lit")), P.eq(E.v("value"), E.lit(false)), P.neq(E.p("entity", "lit"), E.lit(true))], denial: { law: "extinguish.unlit", subject: E.v("entity") } },
			{ when: [P.eq(E.v("prop"), E.lit("lit")), P.eq(E.v("value"), E.lit(false)), P.eq(E.p("entity", "burning"), E.lit(true))], denial: { law: "extinguish.burning", subject: E.v("entity") } },
		],
		reason: (ctx) => `你吹灭了${ctx.name(String(ctx.env.entity))}。`,
	},
	// 通用兜底：上述法则均未授予/拒绝时落此（denyAll 语义由数据法则承载）。
	{ id: "denyAll.set", reject: { when: [], denial: { law: "denyAll.set", subject: E.v("entity"), prop: E.v("prop") } } },
];

/** 软通道动词（do）的兜底法则：无 proof 时一律拒绝（soft 授予在 fallback 通道进行）。 */
const doLaws: Law[] = [
	{ id: "denyAll.do", reject: { when: [], denial: { law: "denyAll.do" } } },
];

/** tick 系统：燃着的火（lit 非蜡烛）在可燃容器内引燃容器（火把入箱）。 */
const kindleSys: Law = {
	id: "kindle",
	over: [
		{
			var: "x",
			source: "entities",
			where: [P.eq(E.p("x", "lit"), E.lit(true)), P.neq(E.p("x", "burning"), E.lit(true)), P.neq(E.p("x", "lightable"), E.lit(true))],
		},
	],
	when: [
		P.neq(E.p("x", "in"), E.lit(null)),
		P.eq(E.pp("x", "in", "flammable"), E.lit(true)),
		P.neq(E.pp("x", "in", "burning"), E.lit(true)),
		P.neq(E.pp("x", "in", "lit"), E.lit(true)),
	],
	each: [
		{ op: "set", e: E.prop(E.v("x"), "in"), p: "burning", v: E.lit(true) },
		{ op: "set", e: E.prop(E.v("x"), "in"), p: "lit", v: E.lit(true) },
	],
	facts: (ctx) => {
		const host = String(ctx.prop(String(ctx.env.x), "in"));
		return [{ text: `${ctx.name(String(ctx.env.x))}的火焰点燃了${ctx.name(host)}！`, entities: [String(ctx.env.x), host] }];
	},
};

/** tick 系统：火焰蔓延到同处或容器内的可燃物。 */
const spreadSys: Law = {
	id: "spread",
	over: [
		{ var: "b", source: "entities", where: [P.eq(E.p("b", "burning"), E.lit(true))] },
		{ var: "t", source: "entities", where: [P.eq(E.p("t", "flammable"), E.lit(true))] },
	],
	when: [
		P.neq(E.v("b"), E.v("t")),
		P.neq(E.p("t", "burning"), E.lit(true)),
		P.neq(E.p("t", "lit"), E.lit(true)),
		P.or([P.eq(E.p("t", "in"), E.p("b", "in")), P.eq(E.p("t", "in"), E.v("b"))]),
	],
	each: [
		{ op: "set", e: E.v("t"), p: "burning", v: E.lit(true) },
		{ op: "set", e: E.v("t"), p: "lit", v: E.lit(true) },
	],
	facts: (ctx) => [
		{ text: `${ctx.name(String(ctx.env.b))}的火焰蔓延到了${ctx.name(String(ctx.env.t))}！`, entities: [String(ctx.env.b), String(ctx.env.t)] },
	],
};

/** tick 系统：燃烧计数（burnTicks 递增，供燃尽判定）。 */
const burnTickSys: Law = {
	id: "burnout.tick",
	over: [{ var: "b", source: "entities", where: [P.eq(E.p("b", "burning"), E.lit(true))] }],
	each: [{ op: "inc", e: E.v("b"), p: "burnTicks", by: E.lit(1) }],
};

/** tick 系统：燃尽——燃烧满 3 tick 后烧成灰烬（在 burnTickSys 之后注册，看到的是递增后的值）。 */
const burnAshSys: Law = {
	id: "burnout.ash",
	over: [
		{
			var: "b",
			source: "entities",
			where: [P.eq(E.p("b", "burning"), E.lit(true)), P.gte(E.p("b", "burnTicks"), E.lit(3))],
		},
	],
	each: [
		{ op: "set", e: E.v("b"), p: "burning", v: E.lit(false) },
		{ op: "set", e: E.v("b"), p: "lit", v: E.lit(false) },
		{ op: "set", e: E.v("b"), p: "material", v: E.lit("ash") },
		{ op: "set", e: E.v("b"), p: "flammable", v: E.lit(false) },
	],
	facts: (ctx) => [{ text: `${ctx.name(String(ctx.env.b))}烧成了灰烬。`, entities: [String(ctx.env.b)] }],
};

/** 通用断言校验规则（声明式）：
 *  火断言（强词必须当前成立，弱词豁免"即将燃"的预言）+ 手断言（可持握且未持有）。 */
const CAVE_ASSERTION_RULES: AssertionRule[] = [
	{
		prop: "burning",
		strong: ["焦烟", "冒烟", "火舌", "烧焦", "烧成灰烬"],
		weak: ["燃烧", "点燃", "燃起", "烧起来"],
		targets: (world, actor) =>
			world.entities.filter((e) => e.id !== actor && e.props.space !== true && !(e.props.lit === true || e.props.burning === true || e.props.material === "ash")),
		error: (e) => `描述虚构了「${e.name}」的燃烧/点燃/烧焦，但当前状态并非如此。`,
	},
	{
		prop: "in",
		weak: ["手中", "手上", "掌心", "手里", "握"],
		exemptPending: false,
		targets: (world, actor) =>
			world.entities.filter((e) => e.id !== actor && e.props.space !== true && e.props.grabbable === true && e.props["in"] !== actor),
		error: (e) => `描述虚构了「${e.name}」在你手中，但当前它不在你这里。`,
	},
];

const CAVE_NEGATIONS = ["未", "没", "无", "不", "别", "休", "尚未", "未曾", "不曾"];
/** 句子边界：断言作用域按此切分。 */
const CAVE_SENTENCE_PUNCT = /[。！？!?；;]/;
/** 词-实体相邻判定：名字与断言之间出现这些才算"不相邻"（跨主语误报拦截）。空白不算边界。 */
const CAVE_ASSERTION_PUNCT = /[，。；！？、—]/;

/** set 动词的候选值：仅覆盖 set 规则（detach/open/close/extinguish）实际裁决的属性与值（布尔/空/实体 id）。 */
const setCandidates: VerbDef["candidates"] = (sim) => {
	const values = new Set<PropValue>([true, false, null]);
	for (const ent of sim.world.entities) {
		const v = ent.props.attachedTo;
		if (typeof v === "string") values.add(v);
	}
	for (const id of sim.visible()) values.add(id);
	return { prop: ["open", "lit", "attachedTo"], value: [...values] };
};

const moveVerb: VerbDef = {
	label: "移动",
	description: "把某实体移动到目标位置（拿起/放下/放入容器/楔入门缝）。",
	schema: Type.Object({
		entity: Type.String({ description: "要移动的实体 id" }),
		dest: Type.String({ description: "目标位置 id（玩家 / 场景 / 打开的容器 / 门缝）" }),
	}),
	entityParams: ["entity", "dest"],
	candidates: (sim) => ({
		dest: [...sim.visible(), sim.actor],
	}),
	laws: moveLaws,
};

const useVerb: VerbDef = {
	label: "作用",
	description: "用一件东西作用于另一件东西（点燃 / 撬动）。施动的东西必须拿得动且够得着。",
	schema: Type.Object({
		source: Type.String({ description: "施动实体 id（必须可持握且可达）" }),
		target: Type.String({ description: "受动实体 id" }),
	}),
	entityParams: ["source", "target"],
	instrumentParams: ["source"],
	laws: useLaws,
};

const setVerb: VerbDef = {
	label: "改变状态",
	description: "请求改变某实体的某项属性（打开 / 关闭 / 解下 / 吹灭）。",
	schema: Type.Object({
		entity: Type.String({ description: "目标实体 id" }),
		prop: Type.String({ description: "属性名（open / attachedTo / lit）" }),
		value: Type.Any({ description: "新值（布尔 / 数字 / 字符串 / null）" }),
	}),
	entityParams: ["entity"],
	propParams: ["prop"],
	candidates: setCandidates,
	laws: setLaws,
};

/** 软通道动词（do）：proof 给出期望后果（desired）与可选前置事实（claims），
 *  世界以约束校验授予——实体须可见/可达、属性须注册为 access:"soft"（此处为 marked 刻痕），
 *  结构性属性（材质/位置/燃烧/钱币等）一律拒绝。不再需要枚举 openLaws（去菜单化）。 */
const doVerb: VerbDef = {
	label: "行动",
	description: "提出一个未被预设动词覆盖的自由动作。proof 结构：{ \"claims\": [前置事实，可选], \"desired\": [期望后果，至少一条] }。世界只允许更改软属性（access:\"soft\"）：当前可写的是 marked 刻痕（desired=[{op:\"set\",entity:\"<id>\",prop:\"marked\",value:true}]，实体须可达）。结构性属性（位置 in、材质 material、明火 lit、燃烧 burning、钱币 coins 等）由世界法则管理，直接更改会被拒绝。",
	schema: Type.Object({}),
	laws: doLaws,
	fallback: "soft",
};

export const cave: GameDef = {
	id: "cave",
	title: "地窖（法则引擎）",
	playerId: "player",
	messages: {
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
	},
	verbs: {
		move: moveVerb,
		use: useVerb,
		set: setVerb,
		do: doVerb,
	},
	world: {
		time: 0,
		entities: [
			{ id: "cave", name: "地窖", kind: "space", tags: ["room"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "cave", coins: 40 } },
			{ id: "ring", name: "铜戒", kind: "item", tags: ["metal"], props: { in: "skeleton", attachedTo: "skeleton", material: "copper", grabbable: true } },
			{ id: "skeleton", name: "骷髅", kind: "corpse", tags: [], props: { in: "cave", material: "bone" } },
			{ id: "torch", name: "火把", kind: "item", tags: ["flammable", "light"], props: { in: "cave", material: "wood", flammable: true, lit: true, grabbable: true } },
			{ id: "candle", name: "蜡烛", kind: "item", tags: ["flammable", "lightable", "wedgeable"], props: { in: "chest", material: "wax", flammable: true, grabbable: true, wedgeable: true, lightable: true, lit: false } },
			{ id: "chest", name: "木箱", kind: "container", tags: ["wood"], props: { in: "cave", material: "wood", flammable: true, openable: true, open: false, container: true, coins: 60 } },
			{ id: "door", name: "石门", kind: "door", tags: ["stone"], props: { in: "cave", material: "stone", openable: true, open: false, isDoor: true } },
			{ id: "crowbar", name: "铁钎", kind: "item", tags: ["metal"], props: { in: "cave", material: "iron", grabbable: true } },
		],
	},
	systems: [
		kindleSys,
		spreadSys,
		burnTickSys,
		burnAshSys,
	],
	containerAccess,
	denialTemplates: {
		reach: (d, w) => d.reason ?? "它不在这里。",
		"wedge.jammed": (d, w) => `${name(w, d.object ?? "")}的门缝里已经塞着东西了。`,
		"move.grabbable": (d, w) => `你搬不动${name(w, d.subject ?? "")}。`,
		"move.attached": (d, w) => `${name(w, d.subject ?? "")}被固定在别处，先解下来。`,
		"move.dest": (d, w) => `${name(w, d.object ?? "")}？这里没有这个东西。`,
		"move.closed": (d, w) => `${name(w, d.object ?? "")}是关着的，放不进去。`,
		"move.capacity": (d, w) => `${name(w, d.object ?? "")}放不下东西。`,
		"detach.none": () => "它没有被固定住。",
		"open.notopenable": (d, w) => `${name(w, d.subject ?? "")}打不开。`,
		"open.already": () => "它已经开了。",
		"open.jammed": (d, w) => `${name(w, d.subject ?? "")}被东西卡住了，打不开。`,
		"close.closed": () => "它已经关着。",
		"pry.open": (d, w) => `${name(w, d.object ?? "")}已经开着。`,
		"pry.jammed": (d, w) => `${name(w, d.object ?? "")}被东西卡住，撬不开。`,
		"pry.soft": (d, w) => `${name(w, d.subject ?? "")}太软，撬不动${name(w, d.object ?? "")}。`,
		"pry.hardness": (d, w) => `${name(w, d.subject ?? "")}的硬度不足以撬开${name(w, d.object ?? "")}。`,
		"ignite.nolight": (d, w) => `${name(w, d.subject ?? "")}没有火。`,
		"ignite.notflammable": (d, w) => `${name(w, d.object ?? "")}烧不起来。`,
		"ignite.burning": (d, w) => `${name(w, d.object ?? "")}已经在燃烧。`,
		"extinguish.unlit": () => "它没有在燃烧。",
		"extinguish.burning": () => "火已经烧起来了，吹不灭。",
		"instrument.unholdable": (d, w) => `${name(w, d.subject ?? "")}太沉重，你拿不动它来施力。`,
		"instrument.unreachable": (d, w) => `${name(w, d.subject ?? "")}在你够不到的地方，没法拿来使。`,
		"denyAll.use": (d, w) => `你把${name(w, d.subject ?? "")}凑向${name(w, d.object ?? "")}，但什么也没有发生。`,
		"denyAll.move": (d, w) => `你无法把${name(w, d.subject ?? "")}放到${name(w, d.object ?? "")}。`,
		"denyAll.do": () => "世界没有以这种方式回应。",
		"proof.fail": (d) => d.debug ?? "世界没有以这种方式回应。",
		"soft.fail": (d) => d.debug ?? "世界没有以这种方式回应。",
		"invariant.integrity": () => "世界拒绝了这个变化。",
		"invariant.fire.coherent": (d) => d.debug ?? "世界拒绝了这个变化。",
		"invariant.coins.conserved": (d) => d.debug ?? "世界拒绝了这个变化。",
		"denyAll.set": (d, w) => {
			const subj = name(w, d.subject ?? "");
			const label = PROP_LABELS[d.prop ?? ""];
			return label ? `你试着改变${subj}的${label}，但它没有任何变化。` : `你试着改变${subj}，但它没有任何变化。`;
		},
	},
	props: CAVE_PROPS,
	invariants: [
		{
			id: "fire.coherent",
			check: (world) => {
				for (const e of world.entities) {
					if (e.props.burning === true && e.props.lit !== true) return `「${e.name}」燃着却没有明火。`;
				}
				return null;
			},
		},
		{
			id: "coins.conserved",
			// 守恒模式（era/DoL 资源经济）：铜币总量 == 种子值（从初始世界自派生）。
			// 任何提交（AI 开放通道/法则/系统 bug）凭空铸币或灭币都会被回滚。
			check: (world, ctx) => {
				const seed = sumProp(ctx.def.world, "coins");
				const now = sumProp(world, "coins");
				return now === seed ? null : `铜币总量 ${now} ≠ 种子值 ${seed}，经济被打破。`;
			},
		},
	],
	assertionRules: CAVE_ASSERTION_RULES,
	negationWords: CAVE_NEGATIONS,
	sentencePunct: CAVE_SENTENCE_PUNCT,
	assertionPunct: CAVE_ASSERTION_PUNCT,
	summarize: summarizeCave,
	digest: digestCave,
	grounding: (world, actor) => [...inTreeVisible(world, actor, { containerAccess })],
	hint: `世界法则（模拟层强制执行）：
1. 火源（lit=true）作用于可燃物（flammable=true）：可点燃蜡烛（lightable=true，点燃后 lit=true），或让普通可燃物燃烧（burning=true）；燃烧会随时间蔓延到同处或容器内的可燃物，并最终烧成灰烬（material=ash）。
2. 燃着的火（lit 且非蜡烛类）放进可燃容器，容器会被引燃（如把火把放进木箱）。
3. 可开启物（openable=true）可被打开/关闭；被卡住（jammed=true）时打不开。
4. 物品可被拿起（move 到玩家）、放下（move 到场景）、放入（move 到打开的容器）、解下（把 attachedTo 设为 null）。
5. 硬物（iron/steel 材质，如铁钎）可撬开比它软的可开启物（如木箱）；撬不动比它硬的（石门是 stone）。`,
};
