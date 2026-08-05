import type { GameDef, PropDef, PropValue, Simulation, VerbDef, World } from "../core/sim.ts";
import { entity, internalPropsOf } from "../core/sim.ts";
import { sumProp } from "../core/util.ts";
import { E, P, type DenialDef, type Expr, type ExprCtx, type Law, type Pred } from "../core/expr.ts";
import { reachFor, inTreeVisible } from "./space.ts";
import { Type } from "typebox";

/**
 * era/DoL 极研究探针：河畔村。
 * 用现有 core 原语（零 core 改动）构造最小"强一致数值系统"：
 * 多尺度时间调度、三数值互锁、经济守恒、NPC 关系、顺序过程（阶段链）。
 * 验证目标：core 是否服务 era/DoL 极；缺的是机制还是原语。
 */

const VILLAGE_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "位置" },
	actor: { type: "boolean", internal: true },
	space: { type: "boolean", label: "场景" },
	grabbable: { type: "boolean", label: "可持握" },
	alive: { type: "boolean", label: "存活" },
	hp: { type: "number", label: "体力" },
	fatigue: { type: "number", label: "疲劳" },
	satiety: { type: "number", label: "饱腹" },
	down: { type: "boolean", label: "状态" },
	coins: { type: "number", label: "铜币" },
	berries: { type: "number", label: "浆果" },
	ripe: { type: "boolean", label: "成熟" },
	price: { type: "number", label: "价钱" },
	phase: { type: "number", label: "阶段" },
	supply: { type: "boolean", label: "出水量" },
	aggressive: { type: "boolean", label: "攻击性" },
	grain: { type: "number", label: "谷物" },
	water: { type: "number", label: "清水" },
	wheat: { type: "boolean", internal: true },
};

const PROP_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(VILLAGE_PROPS).filter(([, p]) => p.label).map(([k, p]) => [k, p.label!]),
);

function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

function summarizeVillage(input: { world: World; changes: import("../core/sim.ts").Change[]; actor: string }): string {
	const { world, changes, actor } = input;
	const player = entity(world, actor);
	const bits: string[] = [];
	if (player) {
		bits.push(`体力 ${player.props.hp ?? 0}，疲劳 ${player.props.fatigue ?? 0}，饱腹 ${player.props.satiety ?? 0}，铜币 ${player.props.coins ?? 0}，浆果 ${player.props.berries ?? 0}`);
		if (Number(player.props.grain ?? 0) > 0) bits.push(`谷物 ${player.props.grain}`);
		if (Number(player.props.water ?? 0) > 0) bits.push(`清水 ${player.props.water}`);
		if (player.props.down === true) bits.push("你昏迷着。");
	}
	return ["你站在河畔村。"].concat(bits, changes.filter((c) => !c.prop.startsWith("#")).map((c) => `变更：${name(world, c.entity)}的${PROP_LABELS[c.prop] ?? c.prop} ${String(c.from)} → ${String(c.to)}`)).join("\n");
}

function digestVillage(sim: Simulation): string {
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
	const rels = (sim.world.relations ?? []).filter((r) => vis.has(r.from) && vis.has(r.to));
	return JSON.stringify({ time: sim.world.time, relations: rels, entities: items }, null, 2);
}

/** 老店主对玩家的信任：>=2 时米价 8 折（关系边 → 经济耦合，算术表达式：10 - 折扣）。 */
const trustPred: { k: "rel"; from: Expr; to: Expr; type: string; op: "gte"; b: Expr } = {
	k: "rel", from: E.lit("merchant"), to: E.lit("player"), type: "信任", op: "gte", b: E.lit(2),
};
const priceExpr = (sign: 1 | -1): Expr =>
	E.mul(E.lit(sign), E.sub(E.lit(10), { k: "if", c: trustPred, t: E.lit(2), f: E.lit(0) }));

/** 可达性拒绝（core 空槽 reach/reachReason 接线）：reason（构件 prose）优先，缺省"它不在这里。"。 */
const unreachable = (e: Expr): DenialDef => ({
	law: "reach",
	subject: e,
	reason: { k: "reachReason", e },
	text: () => "它不在这里。",
});

const gatherLaws: Law[] = [
	{ id: "gather.take", when: [P.reach(E.v("entity")), P.eq(E.p("entity", "grabbable"), E.lit(true)), P.neq(E.p("entity", "in"), E.v("actor"))], each: [{ op: "set", e: E.v("entity"), p: "in", v: E.v("actor") }], reason: (ctx) => `你拾起了${ctx.name(String(ctx.env.entity))}。` },
	{ id: "gather.reach", reject: { when: [P.not(P.reach(E.v("entity")))], denial: unreachable(E.v("entity")) } },
	{ id: "gather.grabbable", reject: { when: [P.reach(E.v("entity")), P.neq(E.p("entity", "grabbable"), E.lit(true))], denial: { law: "gather.grabbable", subject: E.v("entity"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}搬不动。` } } },
	{ id: "denyAll.gather", reject: { when: [], denial: { law: "denyAll.gather", subject: E.v("entity"), text: (d, ctx) => `你拿不起${ctx.name(d.subject ?? "")}。` } } },
];

const eatLaws: Law[] = [
	{ id: "eat.berry", when: [P.gte(E.p("actor", "berries"), E.lit(1))], each: [{ op: "inc", e: E.v("actor"), p: "berries", by: E.lit(-1) }, { op: "inc", e: E.v("actor"), p: "satiety", by: E.lit(25) }, { op: "inc", e: E.v("actor"), p: "hp", by: E.lit(5) }], reason: () => "你吃下了一颗浆果，肚子舒服了些。" },
	{ id: "eat.none", reject: { when: [P.eq(E.p("actor", "berries"), E.lit(0))], denial: { law: "eat.none", text: () => "你翻遍了口袋，没有浆果可吃。" } } },
	{ id: "denyAll.eat", reject: { when: [], denial: { law: "denyAll.eat", text: () => "你暂时吃不了东西。" } } },
];

const restLaws: Law[] = [
	{ id: "rest.down", when: [P.eq(E.p("actor", "down"), E.lit(true))], each: [{ op: "set", e: E.v("actor"), p: "down", v: E.lit(false) }, { op: "set", e: E.v("actor"), p: "fatigue", v: E.lit(0) }, { op: "set", e: E.v("actor"), p: "hp", v: E.lit(30) }, { op: "set", e: E.v("actor"), p: "satiety", v: E.lit(10) }], reason: () => "你昏昏沉沉睡了一夜，醒来后重新站起。" },
	{ id: "rest.normal", when: [P.neq(E.p("actor", "down"), E.lit(true))], each: [{ op: "set", e: E.v("actor"), p: "fatigue", v: E.lit(0) }, { op: "inc", e: E.v("actor"), p: "hp", by: E.lit(8) }, { op: "inc", e: E.v("actor"), p: "satiety", by: E.lit(-5) }], reason: () => "你歇了歇，缓过劲来。" },
	{ id: "denyAll.rest", reject: { when: [], denial: { law: "denyAll.rest", text: () => "你无法在这里歇息。" } } },
];

/** 交谈（实体不可知：对任意 npc 提升其对自己的信任）。 */
const talkLaws: Law[] = [
	{ id: "talk.nice", when: [P.reach(E.v("target"))], each: [{ op: "relInc", from: E.v("target"), to: E.lit("player"), type: "信任", by: E.lit(1) }], reason: (ctx) => `你和${ctx.name(String(ctx.env.target))}攀谈了一阵，关系亲近了些。` },
	{ id: "talk.bored", reject: { when: [P.reach(E.v("target")), { k: "rel", from: E.v("target"), to: E.lit("player"), type: "信任", op: "gte", b: E.lit(5) }], denial: { law: "talk.bored", subject: E.v("target"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}已经没什么新鲜话可说了。` } } },
	{ id: "denyAll.talk", reject: { when: [], denial: { law: "denyAll.talk", subject: E.v("target"), text: (d, ctx) => `你试着和${ctx.name(d.subject ?? "")}搭话，但对方没有回应。` } } },
];

/** 入夜（time%4==3）歇业：era 时间门控的强制调度。 */
const isNight = (): Pred => P.eq(E.mod(E.time(), E.lit(4)), E.lit(3));

const buyLaws: Law[] = [
	{
		id: "buy.flour",
		reject: { when: [isNight()], denial: { law: "buy.night", text: () => "夜色已深，老店主已经打烊歇息了。" } },
		when: [P.reach(E.lit("flour")), P.eq(E.p("flour", "in"), E.lit("village")), P.gte(E.p("actor", "coins"), priceExpr(1))],
		each: [{ op: "set", e: E.lit("flour"), p: "in", v: E.lit("player") }, { op: "inc", e: E.lit("merchant"), p: "coins", by: priceExpr(1) }, { op: "inc", e: E.v("actor"), p: "coins", by: priceExpr(-1) }],
		reason: () => "你用铜币买了一袋米。",
	},
	{ id: "buy.held", reject: { when: [P.eq(E.p("flour", "in"), E.v("actor"))], denial: { law: "buy.held", text: () => "你手里已经有一袋米了。" } } },
	{ id: "buy.broke", reject: { when: [P.lt(E.p("actor", "coins"), priceExpr(1))], denial: { law: "buy.broke", text: () => "你的钱不够买这袋米。" } } },
	{ id: "denyAll.buy", reject: { when: [], denial: { law: "denyAll.buy", text: () => "货摊上暂时没有可买的。" } } },
];

const sellLaws: Law[] = [
	{
		id: "sell.flour",
		reject: { when: [isNight()], denial: { law: "sell.night", text: () => "夜色已深，老店主已经歇下了。" } },
		when: [P.eq(E.p("flour", "in"), E.v("actor"))],
		each: [{ op: "set", e: E.lit("flour"), p: "in", v: E.lit("village") }, { op: "inc", e: E.v("actor"), p: "coins", by: E.lit(5) }, { op: "inc", e: E.lit("merchant"), p: "coins", by: E.lit(-5) }],
		reason: () => "你把一袋米卖回给了老店主。",
	},
	{ id: "sell.notheld", reject: { when: [P.neq(E.p("flour", "in"), E.v("actor"))], denial: { law: "sell.notheld", text: () => "你手里没有米可卖。" } } },
	{ id: "denyAll.sell", reject: { when: [], denial: { law: "denyAll.sell", text: () => "你没有可卖的东西。" } } },
];

const harvestLaws: Law[] = [
	{ id: "harvest.bush", when: [P.reach(E.v("bush")), P.eq(E.p("bush", "ripe"), E.lit(true))], each: [{ op: "inc", e: E.v("actor"), p: "berries", by: E.lit(1) }, { op: "set", e: E.v("bush"), p: "ripe", v: E.lit(false) }], reason: () => "你采下了一颗浆果。" },
	{ id: "harvest.unripe", reject: { when: [P.eq(E.p("bush", "ripe"), E.lit(false))], denial: { law: "harvest.unripe", subject: E.v("bush"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}还没有成熟。` } } },
	{ id: "denyAll.harvest", reject: { when: [], denial: { law: "denyAll.harvest", subject: E.v("bush"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}无法被采集。` } } },
];

/** 顺序过程（阶段链）：清理 → 修葺 → 封底。每步有显式顺序守卫（phase == N），拒绝走具体法则而非 denyAll。
 *  常量实体直接写 E.p("well","phase")——var 回退把名字解析为实体 id，无需 E.prop(E.lit(...))。 */
const wellClearLaws: Law[] = [
	{ id: "well.clear", when: [P.reach(E.lit("well")), P.eq(E.p("well", "phase"), E.lit(0))], each: [{ op: "inc", e: E.lit("well"), p: "phase", by: E.lit(1) }], reason: () => "你清理了枯井里的淤泥。" },
	{ id: "well.order", reject: { when: [P.neq(E.p("well", "phase"), E.lit(0))], denial: { law: "well.order", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}当前不需要这一步，顺序不对。` } } },
	{ id: "denyAll.clear", reject: { when: [], denial: { law: "denyAll.clear", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}没有动静。` } } },
];

const wellFixLaws: Law[] = [
	{ id: "well.fix", when: [P.reach(E.lit("well")), P.eq(E.p("well", "phase"), E.lit(1)), P.eq(E.p("timber", "in"), E.v("actor"))], each: [{ op: "inc", e: E.lit("well"), p: "phase", by: E.lit(1) }], reason: () => "你用木料加固了井壁。" },
	{ id: "well.order", reject: { when: [P.neq(E.p("well", "phase"), E.lit(1))], denial: { law: "well.order", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}当前不需要这一步，顺序不对。` } } },
	{ id: "well.needtimber", reject: { when: [P.neq(E.p("timber", "in"), E.v("actor"))], denial: { law: "well.needtimber", subject: E.lit("well"), text: () => "你得先把木料拿到手。" } } },
	{ id: "denyAll.fix", reject: { when: [], denial: { law: "denyAll.fix", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}修不了。` } } },
];

const wellSealLaws: Law[] = [
	{ id: "well.seal", when: [P.reach(E.lit("well")), P.eq(E.p("well", "phase"), E.lit(2))], each: [{ op: "inc", e: E.lit("well"), p: "phase", by: E.lit(1) }, { op: "set", e: E.lit("well"), p: "supply", v: E.lit(true) }, { op: "set", e: E.lit("well"), p: "water", v: E.lit(10) }, { op: "inc", e: E.v("actor"), p: "coins", by: E.lit(10) }, { op: "inc", e: E.lit("merchant"), p: "coins", by: E.lit(-10) }], reason: () => "你为枯井封好了底，清泉涌出！老店主赏了你十枚铜币。" },
	{ id: "well.order", reject: { when: [P.neq(E.p("well", "phase"), E.lit(2))], denial: { law: "well.order", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}当前不需要这一步，顺序不对。` } } },
	{ id: "denyAll.seal", reject: { when: [], denial: { law: "denyAll.seal", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}封不了底。` } } },
];

/** 驱逐野狗：伤害 = -(2 + 骰子 d3)，随 tick 变化（roll 是 World 纯函数，check/apply/dryTick 一致）。 */
const dogBite = (): Expr => E.mul(E.lit(-1), E.add(E.lit(2), E.roll(E.lit("dog.bite"), E.lit(3))));

const subdueLaws: Law[] = [
	{ id: "dog.chase", when: [P.reach(E.v("dog")), P.eq(E.p("dog", "alive"), E.lit(true)), P.lt(E.p("actor", "fatigue"), E.lit(40))], each: [{ op: "set", e: E.v("dog"), p: "alive", v: E.lit(false) }, { op: "inc", e: E.v("actor"), p: "hp", by: dogBite() }], reason: (ctx) => `你抄起家伙赶跑了${ctx.name(String(ctx.env.dog))}，被它咬了一口。` },
	{ id: "dog.gone", reject: { when: [P.reach(E.v("dog")), P.neq(E.p("dog", "alive"), E.lit(true))], denial: { law: "dog.gone", subject: E.v("dog"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}已经被赶跑了，不在这里了。` } } },
	{ id: "dog.tired", reject: { when: [P.reach(E.v("dog")), P.gte(E.p("actor", "fatigue"), E.lit(40))], denial: { law: "dog.tired", subject: E.v("dog"), text: (d, ctx) => `你太疲惫了，挥不动手，${ctx.name(d.subject ?? "")}只是远远地龇牙。` } } },
	{ id: "denyAll.subdue", reject: { when: [], denial: { law: "denyAll.subdue", subject: E.v("dog"), text: (d, ctx) => `你没能赶走${ctx.name(d.subject ?? "")}。` } } },
];

/** 侦察：roll-in-when 演示——运气门槛（骰子 >= 3 命中得 2 铜币；守恒：从店主账上扣）。 */
const scoutLaws: Law[] = [
	{ id: "scout.luck", when: [P.reach(E.lit("merchant")), P.gte(E.roll(E.lit("find.coin"), E.lit(4)), E.lit(3))], each: [{ op: "inc", e: E.v("actor"), p: "coins", by: E.lit(2) }, { op: "inc", e: E.lit("merchant"), p: "coins", by: E.lit(-2) }], reason: () => "你四处翻了翻，在墙角捡到了两枚铜币。" },
	{ id: "scout.unlucky", reject: { when: [P.lt(E.roll(E.lit("find.coin"), E.lit(4)), E.lit(3))], denial: { law: "scout.unlucky", text: () => "你翻找了一圈，一无所获。" } } },
	{ id: "denyAll.scout", reject: { when: [], denial: { law: "denyAll.scout", text: () => "这里没什么可找的。" } } },
];

/** 老农对玩家的信任：>=2 时谷物减价。 */
const farmerTrustPred: { k: "rel"; from: Expr; to: Expr; type: string; op: "gte"; b: Expr } = {
	k: "rel", from: E.lit("farmer"), to: E.lit("player"), type: "信任", op: "gte", b: E.lit(2),
};

/** 谷物动态价格：13 - 麦田存粮（存粮越少越贵）；老农信任 >= 2 时再减 2 铜币。 */
const grainDiscount: Expr = { k: "if", c: farmerTrustPred, t: E.lit(2), f: E.lit(0) };
const grainPrice = (): Expr => E.sub(E.sub(E.lit(13), E.p("wheatfield", "grain")), grainDiscount);

const buyGrainLaws: Law[] = [
	{
		id: "buygrain.take",
		reject: { when: [isNight()], denial: { law: "buygrain.night", text: () => "夜色已深，老农已经回屋睡了。" } },
		when: [P.reach(E.lit("wheatfield")), P.gte(E.p("wheatfield", "grain"), E.lit(1)), P.gte(E.p("actor", "coins"), grainPrice())],
		each: [
			{ op: "inc", e: E.lit("wheatfield"), p: "grain", by: E.lit(-1) },
			{ op: "inc", e: E.v("actor"), p: "grain", by: E.lit(1) },
			{ op: "inc", e: E.v("actor"), p: "coins", by: E.mul(E.lit(-1), grainPrice()) },
			{ op: "inc", e: E.lit("farmer"), p: "coins", by: grainPrice() },
		],
		reason: (ctx) => {
			const price = 13 - Number(ctx.prop("wheatfield", "grain") ?? 0) - (Number(ctx.rel("farmer", "player", "信任") ?? 0) >= 2 ? 2 : 0);
			return `你花${price}铜币从老农手里买了一捧谷物。`;
		},
	},
	{ id: "buygrain.empty", reject: { when: [P.reach(E.lit("wheatfield")), P.lt(E.p("wheatfield", "grain"), E.lit(1))], denial: { law: "buygrain.empty", subject: E.lit("wheatfield"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}已经空了，没有谷物可卖。` } } },
	{ id: "buygrain.broke", reject: { when: [P.reach(E.lit("wheatfield")), P.lt(E.p("actor", "coins"), grainPrice())], denial: { law: "buygrain.broke", text: () => "你的钱不够买这捧谷物。" } } },
	{ id: "denyAll.buygrain", reject: { when: [], denial: { law: "denyAll.buygrain", subject: E.lit("wheatfield"), text: (d, ctx) => `你没能从${ctx.name(d.subject ?? "")}买到谷物。` } } },
];

const eatGrainLaws: Law[] = [
	{ id: "eatgrain.eat", when: [P.gte(E.p("actor", "grain"), E.lit(1))], each: [{ op: "inc", e: E.v("actor"), p: "grain", by: E.lit(-1) }, { op: "inc", e: E.v("actor"), p: "satiety", by: E.lit(30) }, { op: "inc", e: E.v("actor"), p: "hp", by: E.lit(6) }], reason: () => "你嚼了一把谷物，腹中稍安。" },
	{ id: "eatgrain.none", reject: { when: [P.lt(E.p("actor", "grain"), E.lit(1))], denial: { law: "eatgrain.none", text: () => "你翻遍口袋，没有谷物可吃。" } } },
	{ id: "denyAll.eatgrain", reject: { when: [], denial: { law: "denyAll.eatgrain", text: () => "你现在吃不下谷物。" } } },
];

const drawLaws: Law[] = [
	{ id: "draw.water", when: [P.reach(E.lit("well")), P.eq(E.p("well", "supply"), E.lit(true)), P.gte(E.p("well", "water"), E.lit(1))], each: [{ op: "inc", e: E.lit("well"), p: "water", by: E.lit(-1) }, { op: "inc", e: E.v("actor"), p: "water", by: E.lit(1) }], reason: () => "你从井口提上一桶清水。" },
	{ id: "draw.dry", reject: { when: [P.reach(E.lit("well")), P.neq(E.p("well", "supply"), E.lit(true))], denial: { law: "draw.dry", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}还是枯的，打不出水。` } } },
	{ id: "draw.empty", reject: { when: [P.reach(E.lit("well")), P.eq(E.p("well", "supply"), E.lit(true)), P.lt(E.p("well", "water"), E.lit(1))], denial: { law: "draw.empty", subject: E.lit("well"), text: (d, ctx) => `${ctx.name(d.subject ?? "")}的井水已经见底了。` } } },
	{ id: "denyAll.draw", reject: { when: [], denial: { law: "denyAll.draw", subject: E.lit("well"), text: (d, ctx) => `你没能从${ctx.name(d.subject ?? "")}里打出水。` } } },
];

const drinkLaws: Law[] = [
	{ id: "drink.sip", when: [P.gte(E.p("actor", "water"), E.lit(1))], each: [{ op: "inc", e: E.v("actor"), p: "water", by: E.lit(-1) }, { op: "inc", e: E.v("actor"), p: "fatigue", by: E.lit(-20) }, { op: "inc", e: E.v("actor"), p: "hp", by: E.lit(3) }], reason: () => "你喝了几口清水，精神一振。" },
	{ id: "drink.none", reject: { when: [P.lt(E.p("actor", "water"), E.lit(1))], denial: { law: "drink.none", text: () => "你没有水可喝。" } } },
	{ id: "denyAll.drink", reject: { when: [], denial: { law: "denyAll.drink", text: () => "你喝不到水。" } } },
];

/** 时间调度 + 随机判定：入夜（time%4==3）时野狗有 1/4 概率偷袭玩家。roll 是 World 纯函数，确定性可验证。 */
const dogNightSys: Law = {
	id: "dog.night",
	over: [{ var: "d", source: "entities", where: [P.eq(E.p("d", "alive"), E.lit(true)), P.eq(E.p("d", "aggressive"), E.lit(true)), P.neq(E.p("actor", "down"), E.lit(true))] }],
	when: [P.eq(E.mod(E.time(), E.lit(4)), E.lit(3)), P.eq(E.roll(E.lit("dog.night"), E.lit(4)), E.lit(1))],
	each: [{ op: "inc", e: E.v("actor"), p: "hp", by: E.lit(-1) }],
	facts: (ctx) => [{ text: "夜色里，野狗窜出来在你小腿上咬了一口！", entities: [String(ctx.env.d), ctx.actor] }],
};

/** 每 tick = 一个时段。数值互锁：疲劳累积、饥饿消耗、饿到扣体力、累到昏厥、体力见底昏迷。 */
const bodyFatigue: Law = { id: "body.fatigue", over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.neq(E.p("p", "down"), E.lit(true))] }], each: [{ op: "inc", e: E.v("p"), p: "fatigue", by: E.lit(2) }] };
const bodyHunger: Law = { id: "body.hunger", over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.neq(E.p("p", "down"), E.lit(true)), P.gt(E.p("p", "satiety"), E.lit(0))] }], each: [{ op: "inc", e: E.v("p"), p: "satiety", by: E.lit(-6) }] };
const bodyStarve: Law = { id: "body.starve", over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.neq(E.p("p", "down"), E.lit(true)), P.lte(E.p("p", "satiety"), E.lit(0))] }], each: [{ op: "set", e: E.v("p"), p: "satiety", v: E.lit(0) }, { op: "inc", e: E.v("p"), p: "hp", by: E.lit(-4) }] };
const bodyExhaust: Law = { id: "body.exhaust", over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.neq(E.p("p", "down"), E.lit(true)), P.gte(E.p("p", "fatigue"), E.lit(100))] }], each: [{ op: "set", e: E.v("p"), p: "down", v: E.lit(true) }, { op: "set", e: E.v("p"), p: "fatigue", v: E.lit(0) }] };
const bodyCollapse: Law = { id: "body.collapse", over: [{ var: "p", source: "entities", where: [P.eq(E.p("p", "actor"), E.lit(true)), P.neq(E.p("p", "down"), E.lit(true)), P.lte(E.p("p", "hp"), E.lit(0))] }], each: [{ op: "set", e: E.v("p"), p: "down", v: E.lit(true) }, { op: "set", e: E.v("p"), p: "hp", v: E.lit(0) }] };

/** 麦田再生长：每 4 个时段补 1 单位存粮（上限 10），供给端驱动米/谷价格波动。 */
const fieldGrow: Law = { id: "field.grow", over: [{ var: "w", source: "entities", where: [P.eq(E.p("w", "wheat"), E.lit(true)), P.lt(E.p("w", "grain"), E.lit(10))] }], when: [P.eq(E.mod(E.time(), E.lit(4)), E.lit(0))], each: [{ op: "inc", e: E.v("w"), p: "grain", by: E.lit(1) }] };

/** 容器包含树可达性的理由文案与接线（游戏侧构件接入 core 的 reach/reachReason 槽位）。 */
const REACH_MSGS = { reachMissing: "这里没有这个东西。", reachCycle: "位置存在循环引用。", reachNotHere: "它不在这里。", reachClosed: (n: string) => `${n}是关着的。` };
const REACH_OPTS = { msgs: REACH_MSGS };

export const village: GameDef = {
	id: "village",
	title: "河畔村（era/DoL 极探针）",
	playerId: "player",
	messages: {
		noResponse: "世界没有以这种方式回应。",
		unknownVerb: (verb) => `世界不认识「${verb}」这种动作。`,
		invalidParams: (label, known) => `「${label}」的参数不在声明范围内（可接受：${known}）。`,
		invisibleEntity: (ids) => `实体 ${ids.join("、")} 不可见或不存在。`,
		...REACH_MSGS,
		invariantRejected: (id, msg) => (id === "coins.conserved" ? msg : "世界拒绝了这个变化。"),
		defaultReason: "……",
		notInActionPhase: "当前不在行动阶段，无法执行操作。",
		timePassed: "时间流逝",
		timeChanged: "时间流逝，世界发生了变化。",
	},
	verbs: {
		gather: {
			label: "拾取", description: "把可达的可持握物品拿到手中（如木料、掉在地上的米）。", schema: Type.Object({ entity: Type.String({ description: "目标物品 id" }) }), entityParams: ["entity"], candidates: (sim) => ({ entity: sim.world.entities.filter((e) => e.props.grabbable === true).map((e) => e.id) }), laws: gatherLaws,
		},
		eat: { label: "进食", description: "吃一颗浆果：饱腹 +25、体力 +5，消耗 1 颗浆果。", schema: Type.Object({}), laws: eatLaws },
		rest: { label: "歇息", description: "休息：疲劳归零、体力 +8、饱腹 -5；昏迷时休息可醒来恢复。", schema: Type.Object({}), laws: restLaws },
		talk: { label: "交谈", description: "与村民攀谈（老店主/老农）：对方对自己的信任 +1；信任 >= 2 后其物价有折扣。", schema: Type.Object({ target: Type.String({ description: "交谈对象 id" }) }), entityParams: ["target"], candidates: (sim) => ({ target: sim.world.entities.filter((e) => e.kind === "npc").map((e) => e.id) }), laws: talkLaws },
		buy: { label: "购买", description: "从老店主处买一袋米（10 铜币，信任 >= 2 后 8 铜币），钱不够被拒；入夜歇业。", schema: Type.Object({}), laws: buyLaws },
		sell: { label: "出售", description: "把手里的米以 5 铜币卖回给老店主；入夜歇业。", schema: Type.Object({}), laws: sellLaws },
		buyGrain: { label: "买谷物", description: "从老农处买一捧谷物（价格随麦田存粮波动：存粮越少越贵；老农信任 >= 2 减价），入夜歇业。", schema: Type.Object({}), laws: buyGrainLaws },
		eatGrain: { label: "吃谷物", description: "吃一捧谷物：饱腹 +30、体力 +6，消耗 1 份谷物。", schema: Type.Object({}), laws: eatGrainLaws },
		draw: { label: "汲水", description: "从封好底的井里打上一桶清水（井水有限，约 10 桶）。", schema: Type.Object({}), laws: drawLaws },
		drink: { label: "饮水", description: "喝一口随身带的清水：疲劳 -20、体力 +3，消耗 1 份水。", schema: Type.Object({}), laws: drinkLaws },
		harvest: { label: "采集", description: "从成熟的浆果丛采下一颗浆果。", schema: Type.Object({ bush: Type.String({ description: "浆果丛 id" }) }), entityParams: ["bush"], candidates: (sim) => ({ bush: sim.world.entities.filter((e) => e.props.ripe === true).map((e) => e.id) }), laws: harvestLaws },
		clear: { label: "清理枯井", description: "清理枯井里的淤泥（阶段 0 → 1）。", schema: Type.Object({}), laws: wellClearLaws },
		fix: { label: "修葺枯井", description: "手持木料时加固井壁（阶段 1 → 2）。", schema: Type.Object({}), laws: wellFixLaws },
		seal: { label: "封底枯井", description: "为枯井封底，清泉涌出，获 10 铜币（阶段 2 → 3）。", schema: Type.Object({}), laws: wellSealLaws },
		subdue: { label: "驱逐野狗", description: "在不太疲惫时驱赶野狗，代价是被咬一口（骰子伤害，随时刻变化）。", schema: Type.Object({ dog: Type.String({ description: "野狗 id" }) }), entityParams: ["dog"], candidates: (sim) => ({ dog: sim.world.entities.filter((e) => e.props.aggressive === true).map((e) => e.id) }), laws: subdueLaws },
		scout: { label: "侦察", description: "四处翻找：骰子运气 >= 3 时捡到 2 铜币（从店主账上扣，守恒），否则一无所获。", schema: Type.Object({}), laws: scoutLaws },
	},
	world: {
		time: 0,
		entities: [
			{ id: "village", name: "河畔村", kind: "space", tags: ["room"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "village", hp: 50, fatigue: 0, satiety: 60, coins: 40, berries: 2, grain: 0, water: 0, down: false } },
			{ id: "merchant", name: "老店主", kind: "npc", tags: ["villager"], props: { in: "village", alive: true, coins: 80 } },
			{ id: "farmer", name: "老农", kind: "npc", tags: ["villager"], props: { in: "village", alive: true, coins: 60 } },
			{ id: "flour", name: "一袋米", kind: "item", tags: ["goods"], props: { in: "village", grabbable: true, price: 10 } },
			{ id: "timber", name: "木料", kind: "item", tags: ["wood"], props: { in: "village", grabbable: true } },
			{ id: "bush", name: "浆果丛", kind: "plant", tags: [], props: { in: "village", ripe: true } },
			{ id: "well", name: "枯井", kind: "structure", tags: ["quest"], props: { in: "village", phase: 0, supply: false, water: 0 } },
			{ id: "wheatfield", name: "麦田", kind: "plant", tags: ["farm"], props: { in: "village", wheat: true, grain: 10 } },
			{ id: "dog", name: "野狗", kind: "creature", tags: ["beast"], props: { in: "village", alive: true, aggressive: true, hp: 10 } },
		],
		relations: [
			{ from: "merchant", to: "player", type: "信任", value: 0 },
			{ from: "farmer", to: "player", type: "信任", value: 0 },
		],
	},
	systems: [dogNightSys, bodyFatigue, bodyHunger, bodyStarve, bodyExhaust, bodyCollapse, fieldGrow],
	props: VILLAGE_PROPS,
	invariants: [
		{
			id: "coins.conserved",
			// era/DoL 守恒模式：铜币总量 == 种子值。任何提交凭空铸币/灭币都被回滚。
			check: (world, ctx) => {
				const seed = sumProp(ctx.def.world, "coins");
				const now = sumProp(world, "coins");
				return now === seed ? null : `铜币总量 ${now} ≠ 种子值 ${seed}，经济被打破。`;
			},
		},
	],
	grounding: (world, actor) => [...inTreeVisible(world, actor, REACH_OPTS)],
	...reachFor(REACH_OPTS),
	// 可持握语义由游戏声明（core 不假定属性名）：河畔村同样只有 grabbable 的东西可被拿起。
	holdable: (world, _actor, id) => entity(world, id)?.props.grabbable === true,
	summarize: summarizeVillage,
	digest: digestVillage,
	hint: `世界法则（模拟层强制执行）：
1. 每个时刻（tick）：疲劳 +2；饱腹 > 0 时饱腹 -6；饱腹耗尽后体力每刻 -4；疲劳满 100 昏厥；体力见底昏迷。歇息可恢复，昏迷时歇息可醒来。
2. 入夜（时刻 % 4 == 3）时：老店主与老农歇业，买卖谷米一律被拒；野狗有 1/4 概率偷袭（骰子判定，确定性）。
3. 浆果可采集（成熟时）可进食；米可买卖：买入 10 铜币（店主信任 >= 2 后 8 铜币）、卖出 5 铜币；侦察掷骰子运气 >= 3 可得 2 铜币。
4. 与村民交谈提升对方对你的信任（关系边），各自物价有折扣。
5. 谷物经济：从老农处买谷物（价格 = 13 - 麦田存粮，存粮越少越贵，每 4 个时段麦田补 1 单位）；吃谷物补饱腹与体力。
6. 枯井修缮是顺序过程：清理 →（手持木料）修葺 → 封底，不得跳步；封底后井里有约 10 桶清水，可汲水（draw）再饮用（drink）恢复疲劳。
7. 铜币总量守恒；结构性属性（体力/钱币/位置等）只能由世界法则变更。`,
};
