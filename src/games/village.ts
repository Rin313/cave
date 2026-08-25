import type { Change, GameDef, PropDef, Q, Simulation, SystemRule, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, fallback, grant, internalPropsOf } from "../core/sim.ts";
import { sumProp } from "../core/util.ts";
import { denyUnreachable, inTreeVisible, reachFor } from "./space.ts";
import { Type } from "typebox";

/**
 * era/DoL 极研究探针：河畔村。
 * 用现有 core 原语构造最小"强一致数值系统"：
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

const num = (v: unknown): number => Number(v ?? 0);
const isNight = (q: Q): boolean => q.time % 4 === 3;
/** NPC 对玩家的信任（缺边按 0 显式参与比较）。 */
const trust = (q: Q, from: string): number => q.relNum(from, q.actor, "信任", 0);
/** 老店主对玩家的信任 >=2 时米价 8 折（关系边 → 经济耦合）。 */
const flourPrice = (q: Q): number => 10 - (trust(q, "merchant") >= 2 ? 2 : 0);
/** 谷物动态价格：13 - 麦田存粮（存粮越少越贵）；老农信任 >= 2 时再减 2。 */
const grainPrice = (q: Q): number => 13 - num(entity(q.world, "wheatfield")?.props.grain) - (trust(q, "farmer") >= 2 ? 2 : 0);

function summarizeVillage(input: { world: World; changes: Change[]; actor: string }): string {
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
	return JSON.stringify({ time: sim.world.time, relations: rels, entities: items });
}

export const village: GameDef = {
	id: "village",
	title: "河畔村（era/DoL 极探针）",
	playerId: "player",
	messages: {
		noResponse: "世界没有以这种方式回应。",
		unknownVerb: (verb) => `世界不认识「${verb}」这种动作。`,
		invalidParams: (label, known) => `「${label}」的参数不在声明范围内（可接受：${known}）。`,
		invisibleEntity: (ids) => `实体 ${ids.join("、")} 不可见或不存在。`,
		invariantRejected: (id, msg) => (id === "coins.conserved" ? msg : "世界拒绝了这个变化。"),
		defaultReason: "……",
		notInActionPhase: "当前不在行动阶段，无法执行操作。",
		timePassed: "时间流逝",
		timeChanged: "时间流逝，世界发生了变化。",
	},
	verbs: {
		gather: defineVerb({
			label: "拾取",
			description: "把可达的可持握物品拿到手中（如木料、掉在地上的米）。",
			schema: Type.Object({ entity: Type.String({ description: "目标物品 id" }) }),
			entityParams: ["entity"],
			candidates: (sim) => ({ entity: sim.world.entities.filter((e) => e.props.grabbable === true).map((e) => e.id) }),
			rules: [
				{
					id: "gather.take",
					judge: (q, p) => {
						if (!q.canReach(p.entity)) return denyUnreachable(q, p.entity);
						const t = q.entity(p.entity);
						if (t?.props.grabbable !== true) return deny("gather.grabbable", { subject: p.entity, reason: `${q.name(p.entity)}搬不动。` });
						if (t.props.in === q.actor) return null;
						return grant([D.set(p.entity, "in", q.actor)], `你拾起了${q.name(p.entity)}。`);
					},
				},
				fallback("denyAll.gather", (q) => `你拿不起${q.name(String(q.params.entity))}。`),
			],
		}),
		eat: defineVerb({
			label: "进食",
			description: "吃一颗浆果：饱腹 +25、体力 +5，消耗 1 颗浆果。",
			schema: Type.Object({}),
			rules: [{
				id: "eat.berry",
				judge: (q) => {
					if (num(q.entity(q.actor)?.props.berries) < 1) return deny("eat.none", { reason: "你翻遍了口袋，没有浆果可吃。" });
					return grant([D.inc(q.actor, "berries", -1), D.inc(q.actor, "satiety", 25), D.inc(q.actor, "hp", 5)], "你吃下了一颗浆果，肚子舒服了些。");
				},
			}],
		}),
		rest: defineVerb({
			label: "歇息",
			description: "休息：疲劳归零、体力 +8、饱腹 -5；昏迷时休息可醒来恢复。",
			schema: Type.Object({}),
			rules: [{
				id: "rest.take",
				judge: (q) => {
					const a = q.entity(q.actor)!;
					if (a.props.down === true) return grant([D.set(q.actor, "down", false), D.set(q.actor, "fatigue", 0), D.set(q.actor, "hp", 30), D.set(q.actor, "satiety", 10)], "你昏昏沉沉睡了一夜，醒来后重新站起。");
					return grant([D.set(q.actor, "fatigue", 0), D.inc(q.actor, "hp", 8), D.inc(q.actor, "satiety", -5)], "你歇了歇，缓过劲来。");
				},
			}],
		}),
		talk: defineVerb({
			label: "交谈",
			description: "与村民攀谈（老店主/老农）：对方对自己的信任 +1；信任 >= 5 后无话可说；各自物价折扣看 hint。",
			schema: Type.Object({ target: Type.String({ description: "交谈对象 id" }) }),
			entityParams: ["target"],
			candidates: (sim) => ({ target: sim.world.entities.filter((e) => e.kind === "npc").map((e) => e.id) }),
			rules: [{
				id: "talk.nice",
				judge: (q, p) => {
					if (trust(q, p.target) >= 5) return deny("talk.bored", { subject: p.target, reason: `${q.name(p.target)}已经没什么新鲜话可说了。` });
					return grant([D.relInc(p.target, q.actor, "信任", 1)], `你和${q.name(p.target)}攀谈了一阵，关系亲近了些。`);
				},
			}],
		}),
		buy: defineVerb({
			label: "购买",
			description: "从老店主处买一袋米（10 铜币，信任 >= 2 后 8 铜币），钱不够被拒；入夜歇业。",
			schema: Type.Object({}),
			rules: [{
				id: "buy.flour",
				judge: (q) => {
					if (isNight(q)) return deny("buy.night", { reason: "夜色已深，老店主已经打烊歇息了。" });
					if (entity(q.world, "flour")?.props.in === q.actor) return deny("buy.held", { reason: "你手里已经有一袋米了。" });
					const price = flourPrice(q);
					if (num(q.entity(q.actor)?.props.coins) < price) return deny("buy.broke", { reason: "你的钱不够买这袋米。" });
					const flour = entity(q.world, "flour");
					if (!flour || !q.canReach("flour") || flour.props.in !== "village") return deny("denyAll.buy", { reason: "货摊上暂时没有可买的。", fallback: true });
					return grant([D.set("flour", "in", q.actor), D.inc("merchant", "coins", price), D.inc(q.actor, "coins", -price)], "你用铜币买了一袋米。");
				},
			}],
		}),
		sell: defineVerb({
			label: "出售",
			description: "把手里的米以 5 铜币卖回给老店主；入夜歇业。",
			schema: Type.Object({}),
			rules: [{
				id: "sell.flour",
				judge: (q) => {
					if (isNight(q)) return deny("sell.night", { reason: "夜色已深，老店主已经歇下了。" });
					if (entity(q.world, "flour")?.props.in !== q.actor) return deny("sell.notheld", { reason: "你手里没有米可卖。" });
					return grant([D.set("flour", "in", "village"), D.inc(q.actor, "coins", 5), D.inc("merchant", "coins", -5)], "你把一袋米卖回给了老店主。");
				},
			}],
		}),
		buyGrain: defineVerb({
			label: "买谷物",
			description: "从老农处买一捧谷物（价格随麦田存粮波动：存粮越少越贵；老农信任 >= 2 减价），入夜歇业。",
			schema: Type.Object({}),
			rules: [{
				id: "buygrain.take",
				judge: (q) => {
					if (isNight(q)) return deny("buygrain.night", { reason: "夜色已深，老农已经回屋睡了。" });
					const field = entity(q.world, "wheatfield");
					const reachable = field ? q.canReach("wheatfield") : false;
					if (!field || !reachable || num(field.props.grain) < 1) {
						if (reachable && field && num(field.props.grain) < 1) return deny("buygrain.empty", { subject: "wheatfield", reason: `${q.name("wheatfield")}已经空了，没有谷物可卖。` });
						return deny("denyAll.buygrain", { subject: "wheatfield", reason: `你没能从${q.name("wheatfield")}买到谷物。`, fallback: true });
					}
					const price = grainPrice(q);
					if (num(q.entity(q.actor)?.props.coins) < price) return deny("buygrain.broke", { reason: "你的钱不够买这捧谷物。" });
					return grant([D.inc("wheatfield", "grain", -1), D.inc(q.actor, "grain", 1), D.inc(q.actor, "coins", -price), D.inc("farmer", "coins", price)], `你花${price}铜币从老农手里买了一捧谷物。`);
				},
			}],
		}),
		eatGrain: defineVerb({
			label: "吃谷物",
			description: "吃一捧谷物：饱腹 +30、体力 +6，消耗 1 份谷物。",
			schema: Type.Object({}),
			rules: [{
				id: "eatgrain.eat",
				judge: (q) => {
					if (num(q.entity(q.actor)?.props.grain) < 1) return deny("eatgrain.none", { reason: "你翻遍口袋，没有谷物可吃。" });
					return grant([D.inc(q.actor, "grain", -1), D.inc(q.actor, "satiety", 30), D.inc(q.actor, "hp", 6)], "你嚼了一把谷物，腹中稍安。");
				},
			}],
		}),
		draw: defineVerb({
			label: "汲水",
			description: "从封好底的井里打上一桶清水（井水有限，约 10 桶）。",
			schema: Type.Object({}),
			rules: [{
				id: "draw.water",
				judge: (q) => {
					const well = entity(q.world, "well");
					if (!well || !q.canReach("well")) return deny("denyAll.draw", { subject: "well", reason: `你没能从${q.name("well")}里打出水。`, fallback: true });
					if (well.props.supply !== true) return deny("draw.dry", { subject: "well", reason: `${q.name("well")}还是枯的，打不出水。` });
					if (num(well.props.water) < 1) return deny("draw.empty", { subject: "well", reason: `${q.name("well")}的井水已经见底了。` });
					return grant([D.inc("well", "water", -1), D.inc(q.actor, "water", 1)], "你从井口提上一桶清水。");
				},
			}],
		}),
		drink: defineVerb({
			label: "饮水",
			description: "喝一口随身带的清水：疲劳 -20、体力 +3，消耗 1 份水。",
			schema: Type.Object({}),
			rules: [{
				id: "drink.sip",
				judge: (q) => {
					if (num(q.entity(q.actor)?.props.water) < 1) return deny("drink.none", { reason: "你没有水可喝。" });
					return grant([D.inc(q.actor, "water", -1), D.inc(q.actor, "fatigue", -20), D.inc(q.actor, "hp", 3)], "你喝了几口清水，精神一振。");
				},
			}],
		}),
		harvest: defineVerb({
			label: "采集",
			description: "从成熟的浆果丛采下一颗浆果。",
			schema: Type.Object({ bush: Type.String({ description: "浆果丛 id" }) }),
			entityParams: ["bush"],
			candidates: (sim) => ({ bush: sim.world.entities.filter((e) => e.props.ripe === true).map((e) => e.id) }),
			rules: [{
				id: "harvest.bush",
				judge: (q, p) => {
					if (q.entity(p.bush)?.props.ripe !== true) return deny("harvest.unripe", { subject: p.bush, reason: `${q.name(p.bush)}还没有成熟。` });
					if (!q.canReach(p.bush)) return deny("denyAll.harvest", { subject: p.bush, reason: `${q.name(p.bush)}无法被采集。`, fallback: true });
					return grant([D.inc(q.actor, "berries", 1), D.set(p.bush, "ripe", false)], "你采下了一颗浆果。");
				},
			}],
		}),
		clear: defineVerb({
			label: "清理枯井",
			description: "清理枯井里的淤泥（阶段 0 → 1）。",
			schema: Type.Object({}),
			rules: [{
				id: "well.clear",
				judge: (q) => {
					if (num(entity(q.world, "well")?.props.phase) !== 0) return deny("well.order", { subject: "well", reason: `${q.name("well")}当前不需要这一步，顺序不对。` });
					return grant([D.inc("well", "phase", 1)], "你清理了枯井里的淤泥。");
				},
			}],
		}),
		fix: defineVerb({
			label: "修葺枯井",
			description: "手持木料时加固井壁（阶段 1 → 2）。",
			schema: Type.Object({}),
			rules: [{
				id: "well.fix",
				judge: (q) => {
					if (num(entity(q.world, "well")?.props.phase) !== 1) return deny("well.order", { subject: "well", reason: `${q.name("well")}当前不需要这一步，顺序不对。` });
					if (entity(q.world, "timber")?.props.in !== q.actor) return deny("well.needtimber", { subject: "well", reason: "你得先把木料拿到手。" });
					return grant([D.inc("well", "phase", 1)], "你用木料加固了井壁。");
				},
			}],
		}),
		seal: defineVerb({
			label: "封底枯井",
			description: "为枯井封底，清泉涌出，获 10 铜币（阶段 2 → 3）。",
			schema: Type.Object({}),
			rules: [{
				id: "well.seal",
				judge: (q) => {
					if (num(entity(q.world, "well")?.props.phase) !== 2) return deny("well.order", { subject: "well", reason: `${q.name("well")}当前不需要这一步，顺序不对。` });
					return grant([D.inc("well", "phase", 1), D.set("well", "supply", true), D.set("well", "water", 10), D.inc(q.actor, "coins", 10), D.inc("merchant", "coins", -10)], "你为枯井封好了底，清泉涌出！老店主赏了你十枚铜币。");
				},
			}],
		}),
		subdue: defineVerb({
			label: "驱逐野狗",
			description: "在不太疲惫时驱赶野狗，代价是被咬一口（骰子伤害，随时刻变化）。",
			schema: Type.Object({ dog: Type.String({ description: "野狗 id" }) }),
			entityParams: ["dog"],
			candidates: (sim) => ({ dog: sim.world.entities.filter((e) => e.props.aggressive === true).map((e) => e.id) }),
			rules: [{
				id: "dog.chase",
				judge: (q, p) => {
					if (!q.canReach(p.dog)) return deny("denyAll.subdue", { subject: p.dog, reason: `你没能赶走${q.name(p.dog)}。`, fallback: true });
					if (q.entity(p.dog)?.props.alive !== true) return deny("dog.gone", { subject: p.dog, reason: `${q.name(p.dog)}已经被赶跑了，不在这里了。` });
					if (num(q.entity(q.actor)?.props.fatigue) >= 40) return deny("dog.tired", { subject: p.dog, reason: `你太疲惫了，挥不动手，${q.name(p.dog)}只是远远地龇牙。` });
					const bite = -(2 + q.roll("dog.bite", 3));
					return grant([D.set(p.dog, "alive", false), D.inc(q.actor, "hp", bite)], `你抄起家伙赶跑了${q.name(p.dog)}，被它咬了一口。`);
				},
			}],
		}),
		scout: defineVerb({
			label: "侦察",
			description: "四处翻找：骰子运气 >= 3 时捡到 2 铜币（从店主账上扣，守恒），否则一无所获。",
			schema: Type.Object({}),
			rules: [{
				id: "scout.luck",
				judge: (q) => {
					if (!q.canReach("merchant")) return deny("denyAll.scout", { reason: "这里没什么可找的。", fallback: true });
					if (q.roll("find.coin", 4) < 3) return deny("scout.unlucky", { reason: "你翻找了一圈，一无所获。" });
					return grant([D.inc(q.actor, "coins", 2), D.inc("merchant", "coins", -2)], "你四处翻了翻，在墙角捡到了两枚铜币。");
				},
			}],
		}),
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
	systems: [
		{
			id: "dog.night",
			// roll 在条件层只掷一次（与旧 when-外置骰子一致）；每只野兽各扣 1 体力。
			run: (q) => {
				if (q.time % 4 !== 3 || q.roll("dog.night", 4) !== 1) return null;
				if (q.entity(q.actor)?.props.down === true) return null;
				const beasts = q.world.entities.filter((e) => e.props.alive === true && e.props.aggressive === true);
				if (!beasts.length) return null;
				return {
					deltas: beasts.map(() => D.inc(q.actor, "hp", -1)),
					facts: beasts.map((b) => ({ text: "夜色里，野狗窜出来在你小腿上咬了一口！", entities: [b.id, q.actor] })),
				};
			},
		},
		{
			id: "body.fatigue",
			run: (q) => ({
				deltas: q.world.entities.filter((e) => e.props.actor === true && e.props.down !== true).map((p) => D.inc(p.id, "fatigue", 2)),
			}),
		},
		{
			id: "body.hunger",
			run: (q) => ({
				deltas: q.world.entities.filter((e) => e.props.actor === true && e.props.down !== true && num(e.props.satiety) > 0).map((p) => D.inc(p.id, "satiety", -6)),
			}),
		},
		{
			id: "body.starve",
			run: (q) => ({
				deltas: q.world.entities.filter((e) => e.props.actor === true && e.props.down !== true && num(e.props.satiety) <= 0).flatMap((p) => [D.set(p.id, "satiety", 0), D.inc(p.id, "hp", -4)]),
			}),
		},
		{
			id: "body.exhaust",
			run: (q) => ({
				deltas: q.world.entities.filter((e) => e.props.actor === true && e.props.down !== true && num(e.props.fatigue) >= 100).flatMap((p) => [D.set(p.id, "down", true), D.set(p.id, "fatigue", 0)]),
			}),
		},
		{
			id: "body.collapse",
			run: (q) => ({
				deltas: q.world.entities.filter((e) => e.props.actor === true && e.props.down !== true && num(e.props.hp) <= 0).flatMap((p) => [D.set(p.id, "down", true), D.set(p.id, "hp", 0)]),
			}),
		},
		{
			id: "field.grow",
			run: (q) => {
				if (q.time % 4 !== 0) return null;
				return { deltas: q.world.entities.filter((e) => e.props.wheat === true && num(e.props.grain) < 10).map((w) => D.inc(w.id, "grain", 1)) };
			},
		},
	] satisfies SystemRule[],
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
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	...reachFor(),
	// 可持握语义由游戏声明（core 不假定属性名）：河畔村同样只有 grabbable 的东西可被拿起。
	holdable: (world, _actor, id) => entity(world, id)?.props.grabbable === true,
	summarize: summarizeVillage,
	digest: digestVillage,
	hint: `世界法则（模拟层强制执行）：
1. 每个时刻（tick）：疲劳 +2；饱腹 > 0 时饱腹 -6；饱腹耗尽后体力每刻 -4；疲劳满 100 昏厥；体力见底昏迷。歇息可恢复，昏迷时歇息可醒来。
2. 入夜（时刻 % 4 == 3）时：老店主与老农歇业，买卖谷米一律被拒；野狗有 1/4 概率偷袭（骰子判定，确定性）。
3. 浆果可采集（成熟时）可进食；米可买卖：买入 10 铜币（店主信任 >= 2 后 8 铜币）、卖出 5 铜币；侦察掷骰子运气 >= 3 可得 2 铜币。
4. 与村民交谈提升对方对你的信任（关系边），信任到顶（>= 5）后对方没了新鲜话；各自物价有折扣。
5. 谷物经济：从老农处买谷物（价格 = 13 - 麦田存粮，存粮越少越贵，每 4 个时段麦田补 1 单位）；吃谷物补饱腹与体力。
6. 枯井修缮是顺序过程：清理 →（手持木料）修葺 → 封底，不得跳步；封底后井里有约 10 桶清水，可汲水（draw）再饮用（drink）恢复疲劳。
7. 铜币总量守恒；结构性属性（体力/钱币/位置等）只能由世界法则变更。`,
};
