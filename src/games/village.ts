import type { Change, GameDef, PropDef, Q, Simulation, SystemRule, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, fallback, grant, internalPropsOf } from "../core/sim.ts";
import { sumProp } from "../core/util.ts";
import { denyUnreachable, inTreeVisible, reachFor } from "./space.ts";
import { Type } from "typebox";

/**
 * era/DoL 极研究探针：河畔村。
 * 用现有 core 原语构造最小"强一致数值系统"：
 * 多尺度时间调度、三数值互锁、经济守恒、NPC 关系、顺序过程（阶段链）。
 * 法则纪律（承重墙）：规则代码零实体 id 字面量——交易对象/卖家/出资人/货源全部由实体属性声明
 * （price/resale/vendor/patron/yields/phase/bounty…），携带同组属性的任何新实体即被既有法则自动接纳；
 * 「规则读取数据中的 id」合法，「规则写死 id」即越墙。
 */

const VILLAGE_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "位置" },
	actor: { type: "boolean", internal: true },
	space: { type: "boolean", label: "场景" },
	// space 构件（space.ts）的契约属性：使用该构件的游戏应注册，词汇 lint 据此把关
	openable: { type: "boolean", label: "可开" },
	open: { type: "boolean", label: "已开" },
	grabbable: { type: "boolean", label: "可持握" },
	alive: { type: "boolean", label: "存活" },
	hp: { type: "number", label: "体力" },
	fatigue: { type: "number", label: "疲劳" },
	satiety: { type: "number", label: "饱腹" },
	down: { type: "boolean", label: "状态" },
	coins: { type: "number", label: "铜币" },
	berries: { type: "number", label: "浆果" },
	grain: { type: "number", label: "谷物" },
	water: { type: "number", label: "清水" },
	ripe: { type: "boolean", label: "成熟" },
	price: { type: "number", label: "价钱" },
	resale: { type: "number", label: "回收价" },
	vendor: { type: "id", label: "卖家" },
	closesNight: { type: "boolean", label: "夜歇" },
	dealTrust: { type: "number", label: "折价交情" },
	dealCut: { type: "number", label: "折价" },
	priceBase: { type: "number", label: "基价" },
	yields: { type: "string", label: "出产" },
	phase: { type: "number", label: "阶段" },
	patron: { type: "id", label: "出资人" },
	bounty: { type: "number", label: "赏钱" },
	capacity: { type: "number", label: "容量" },
	supply: { type: "boolean", label: "出水量" },
	aggressive: { type: "boolean", label: "攻击性" },
};

const PROP_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(VILLAGE_PROPS).filter(([, p]) => p.label).map(([k, p]) => [k, p.label!]),
);

function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

const num = (v: unknown): number => Number(v ?? 0);
/** 可选数值属性的安全读取：仅认有限 number，缺省/非数返回 null（区别于 0——「属性不存在」不可冒充数值）。 */
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isNight = (q: Q): boolean => q.time % 4 === 3;
/** NPC 对玩家的信任（缺边按 0 显式参与比较）。 */
const trust = (q: Q, from: string): number => q.relNum(from, q.actor, "信任", 0);
/** 卖家忠诚折价：vendor 以 dealTrust/dealCut 声明「信任达标即减价」——关系边 → 经济耦合的通用形态。 */
const loyalCut = (q: Q, vendorId: string): number => {
	const v = q.entity(vendorId);
	if (!v || v.props.dealTrust === undefined) return 0;
	return trust(q, vendorId) >= num(v.props.dealTrust) ? num(v.props.dealCut) : 0;
};

function summarizeChange(world: World, c: Change): string {
	if (c.op === "spawn") return `出现了：${c.name ?? c.entity}。`;
	if (c.op === "despawn") return `消失了：${c.name ?? c.entity}。`;
	const rel = /^rel:([^@]+)@(.+)$/.exec(c.prop);
	const label = rel ? `${PROP_LABELS[rel[1]!] ?? rel[1]}（对${name(world, rel[2]!)}）` : (PROP_LABELS[c.prop] ?? c.prop);
	return `变更：${name(world, c.entity)}的${label} ${String(c.from)} → ${String(c.to)}。`;
}

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
	return ["你站在河畔村。"].concat(bits, changes.map((c) => summarizeChange(world, c))).join("\n");
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
		invisibleEntity: (names) => (names.length ? `你看不到${names.join("、")}在哪里。` : "这里没有那样的东西。"),
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
			description: "与村民攀谈：对方对自己的信任 +1；信任 >= 5 后无话可说。",
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
			description: "向货品的卖家（vendor）购买：独件货品（有 price）整件到手；出产型货物（有 yields）从存量中买一份。价格随存量浮动，卖家信任达标（dealTrust）再减价（dealCut）；挂着夜歇的卖家入夜打烊。",
			schema: Type.Object({ goods: Type.String({ description: "货品实体 id" }) }),
			entityParams: ["goods"],
			candidates: (sim) => ({ goods: sim.world.entities.filter((e) => e.props.price != null || e.props.priceBase != null).map((e) => e.id) }),
			rules: [
				{
					id: "buy.goods",
					judge: (q, p) => {
						const g = q.entity(p.goods);
						const vendorId = typeof g?.props.vendor === "string" ? g.props.vendor : "";
						const vendor = vendorId ? q.entity(vendorId) : null;
						const pb = fin(g?.props.priceBase);
						const pr = fin(g?.props.price);
						if (!g || !vendor || vendor.props.alive === false || (pb === null && pr === null)) return deny("buy.notgoods", { subject: p.goods, reason: `${q.name(p.goods)}不是待售的货品。`, fallback: true });
						if (isNight(q) && vendor.props.closesNight === true) return deny("buy.closed", { subject: vendorId, reason: `夜色已深，${q.name(vendorId)}已经打烊歇息了。` });
						const yields = typeof g.props.yields === "string" ? g.props.yields : null;
						const stock = yields ? num(g.props[yields]) : 0;
						if (yields && stock < 1) return deny("buy.emptystock", { subject: p.goods, reason: `${q.name(p.goods)}已经卖光了。` });
						if (!yields && g.props.in === q.actor) return deny("buy.held", { subject: p.goods, reason: `${q.name(p.goods)}已经在你手里了。` });
						const price = Math.max(1, (pb ?? pr!) - (yields ? stock : 0) - loyalCut(q, vendorId));
						if (num(q.entity(q.actor)?.props.coins) < price) return deny("buy.broke", { subject: vendorId, reason: "你的钱不够。" });
						if (!q.canReach(p.goods)) return denyUnreachable(q, p.goods);
						return yields
							? grant([D.inc(p.goods, yields, -1), D.inc(q.actor, yields, 1), D.inc(vendorId, "coins", price), D.inc(q.actor, "coins", -price)], `你花${price}铜币从${q.name(vendorId)}手里买了一份${q.name(p.goods)}的出产。`)
							: grant([D.set(p.goods, "in", q.actor), D.inc(vendorId, "coins", price), D.inc(q.actor, "coins", -price)], `你花${price}铜币向${q.name(vendorId)}买下了${q.name(p.goods)}。`);
					},
				},
			],
		}),
		sell: defineVerb({
			label: "出售",
			description: "把手里带回收价（resale）的货品卖回给它的卖家（vendor）；挂着夜歇的卖家入夜歇业。",
			schema: Type.Object({ goods: Type.String({ description: "手中货品 id" }) }),
			entityParams: ["goods"],
			candidates: (sim) => ({ goods: sim.world.entities.filter((e) => e.props.in === sim.actor && e.props.resale != null).map((e) => e.id) }),
			rules: [
				{
					id: "sell.goods",
					judge: (q, p) => {
						const g = q.entity(p.goods);
						if (!g || g.props.in !== q.actor || !(num(g.props.resale) > 0)) return null;
						const vendorId = typeof g.props.vendor === "string" ? g.props.vendor : "";
						const vendor = vendorId ? q.entity(vendorId) : null;
						const dest = typeof vendor?.props.in === "string" ? vendor.props.in : null;
						if (!vendor || !dest || vendor.props.alive === false) return deny("sell.novendor", { subject: p.goods, reason: "眼下没人收这货。" });
						if (isNight(q) && vendor.props.closesNight === true) return deny("sell.closed", { subject: vendorId, reason: `夜色已深，${q.name(vendorId)}已经歇下了。` });
						const price = num(g.props.resale);
						return grant([D.set(p.goods, "in", dest), D.inc(q.actor, "coins", price), D.inc(vendorId, "coins", -price)], `你把${q.name(p.goods)}卖回给了${q.name(vendorId)}。`);
					},
				},
				fallback("denyAll.sell", () => "你手里没有可出卖的货品。"),
			],
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
			description: "从出水的水源（supply）打上一桶水；水源的存水有限。",
			schema: Type.Object({ source: Type.String({ description: "水源实体 id" }) }),
			entityParams: ["source"],
			candidates: (sim) => ({ source: sim.world.entities.filter((e) => e.props.supply === true).map((e) => e.id) }),
			rules: [
				{
					id: "draw.water",
					judge: (q, p) => {
						if (!q.canReach(p.source)) return denyUnreachable(q, p.source);
						const w = q.entity(p.source);
						if (!w || w.props.supply !== true) return deny("draw.dry", { subject: p.source, reason: `${q.name(p.source)}还是枯的，打不出水。`, fallback: true });
						if (num(w.props.water) < 1) return deny("draw.empty", { subject: p.source, reason: `${q.name(p.source)}的存水已经见底了。` });
						return grant([D.inc(p.source, "water", -1), D.inc(q.actor, "water", 1)], `你从${q.name(p.source)}提上一桶清水。`);
					},
				},
			],
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
		repair: defineVerb({
			label: "修葺",
			description: "对带阶段（phase）的损毁结构推进一步：清理 →（手持木料类东西）加固 → 封底完工领赏（bounty 由 patron 支付，出水 capacity 份）。",
			schema: Type.Object({ structure: Type.String({ description: "损毁结构 id" }) }),
			entityParams: ["structure"],
			candidates: (sim) => ({ structure: sim.world.entities.filter((e) => typeof e.props.phase === "number").map((e) => e.id) }),
			rules: [
				{
					id: "repair.step",
					judge: (q, p) => {
						const s = q.entity(p.structure);
						const ph = fin(s?.props.phase);
						if (!s || ph === null) return deny("repair.nostructure", { subject: p.structure, reason: `${q.name(p.structure)}不需要修葺。`, fallback: true });
						if (ph === 0) return grant([D.inc(p.structure, "phase", 1)], `你清理了${q.name(p.structure)}里的淤泥。`);
						if (ph === 1) {
							const material = q.world.entities.find((e) => e.props.in === q.actor && e.tags.includes("wood"));
							if (!material) return deny("repair.nomaterial", { subject: p.structure, reason: `你得先把木料拿到手，才修得了${q.name(p.structure)}。` });
							return grant([D.inc(p.structure, "phase", 1)], `你用${material.name}加固了${q.name(p.structure)}。`);
						}
						if (ph === 2) {
							const patronId = typeof s.props.patron === "string" ? s.props.patron : "";
							if (!patronId || !q.entity(patronId)) return deny("repair.nopatron", { subject: p.structure, reason: `${q.name(p.structure)}修好了，却没有人来验收。` });
							const bounty = Math.max(0, num(s.props.bounty));
							return grant(
								[D.inc(p.structure, "phase", 1), D.set(p.structure, "supply", true), D.set(p.structure, "water", num(s.props.capacity)), D.inc(q.actor, "coins", bounty), D.inc(patronId, "coins", -bounty)],
								`你为${q.name(p.structure)}封好了底，清泉涌出！${q.name(patronId)}赏了你${bounty}枚铜币。`,
							);
						}
						return deny("repair.done", { subject: p.structure, reason: `${q.name(p.structure)}不需要再修了。` });
					},
				},
			],
		}),
		subdue: defineVerb({
			label: "驱逐",
			description: "在不太疲惫时赶走有攻击性的野兽，代价是被咬一口（骰子伤害，随时刻变化）。",
			schema: Type.Object({ dog: Type.String({ description: "野兽 id" }) }),
			entityParams: ["dog"],
			candidates: (sim) => ({ dog: sim.world.entities.filter((e) => e.props.aggressive === true).map((e) => e.id) }),
			rules: [{
				id: "dog.chase",
				// 骰子键含实体 id：同刻键必须唯一，多兽各自独立判定
				judge: (q, p) => {
					if (!q.canReach(p.dog)) return deny("denyAll.subdue", { subject: p.dog, reason: `你没能赶走${q.name(p.dog)}。`, fallback: true });
					if (q.entity(p.dog)?.props.alive !== true) return deny("dog.gone", { subject: p.dog, reason: `${q.name(p.dog)}已经被赶跑了，不在这里了。` });
					if (num(q.entity(q.actor)?.props.fatigue) >= 40) return deny("dog.tired", { subject: p.dog, reason: `你太疲惫了，挥不动手，${q.name(p.dog)}只是远远地龇牙。` });
					const bite = -(2 + q.roll(`dog.bite#${p.dog}`, 3));
					return grant([D.set(p.dog, "alive", false), D.inc(q.actor, "hp", bite)], `你抄起家伙赶跑了${q.name(p.dog)}，被它咬了一口。`);
				},
			}],
		}),
		scout: defineVerb({
			label: "侦察",
			description: "四处翻找脚下这片地方的犄角旮旯：骰子运气 >= 3 时捡到 2 枚铜币（散落的铜币有限，守恒）。",
			schema: Type.Object({}),
			rules: [{
				id: "scout.luck",
				judge: (q) => {
					const cur = q.entity(q.actor)?.props["in"];
					const spot = typeof cur === "string" ? q.entity(cur) : null;
					if (!spot) return deny("denyAll.scout", { reason: "这里没什么可翻找的。", fallback: true });
					if (q.roll("find.coin", 4) < 3) return deny("scout.unlucky", { reason: "你翻找了一圈，一无所获。" });
					if (num(spot.props.coins) < 2) return deny("scout.picked", { subject: spot.id, reason: "能捡的都被人捡干净了。" });
					return grant([D.inc(spot.id, "coins", -2), D.inc(q.actor, "coins", 2)], "你四处翻了翻，在墙角捡到了两枚铜币。");
				},
			}],
		}),
	},
	// 回合级时间驱动：每回合动作后推进一刻——疲劳/饥饿/夜袭/打烊/麦田等 per-tick 法则才能在游玩中成立
	turnTicks: 1,
	world: {
		time: 0,
		entities: [
			{ id: "village", name: "河畔村", kind: "space", tags: ["room"], props: { space: true, coins: 4 } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "village", hp: 50, fatigue: 0, satiety: 60, coins: 40, berries: 2, grain: 0, water: 0, down: false } },
			{ id: "merchant", name: "老店主", kind: "npc", tags: ["villager"], props: { in: "village", alive: true, coins: 80, closesNight: true, dealTrust: 2, dealCut: 2 } },
			{ id: "farmer", name: "老农", kind: "npc", tags: ["villager"], props: { in: "village", alive: true, coins: 60, closesNight: true, dealTrust: 2, dealCut: 2 } },
			{ id: "flour", name: "一袋米", kind: "item", tags: ["goods"], props: { in: "village", grabbable: true, price: 10, resale: 5, vendor: "merchant" } },
			{ id: "timber", name: "木料", kind: "item", tags: ["wood"], props: { in: "village", grabbable: true } },
			{ id: "bush", name: "浆果丛", kind: "plant", tags: [], props: { in: "village", ripe: true } },
			{ id: "well", name: "枯井", kind: "structure", tags: ["quest"], props: { in: "village", phase: 0, supply: false, water: 0, patron: "merchant", bounty: 10, capacity: 10 } },
			{ id: "wheatfield", name: "麦田", kind: "plant", tags: ["farm"], props: { in: "village", grain: 10, priceBase: 13, yields: "grain", vendor: "farmer" } },
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
			// roll 在条件层只掷一次；每只野兽各扣 1 体力。
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
			// 泛化到一切声明了 yields 的田：产出键控于属性，不再依赖内部标记
			run: (q) => {
				if (q.time % 4 !== 0) return null;
				return {
					deltas: q.world.entities
						.filter((e) => typeof e.props.yields === "string" && num(e.props[e.props.yields]) < 10)
						.map((w) => D.inc(w.id, String(w.props.yields), 1)),
				};
			},
		},
	] satisfies SystemRule[],
	props: VILLAGE_PROPS,
	invariants: [
		{
			id: "coins.conserved",
			// era/DoL 守恒模式：铜币总量 == 种子值（含村里散落的铜币），任何提交凭空铸币/灭币都被回滚；
			// 种子读 genesis（实际起点世界）而非 def.world——存档恢复/变体开局时两者不同
			check: (world, ctx) => {
				const seed = sumProp(ctx.genesis, "coins");
				const now = sumProp(world, "coins");
				return now === seed ? null : `铜币总量 ${now} ≠ 种子值 ${seed}，经济被打破。`;
			},
		},
		{
			id: "coins.provenance",
			// 过渡不变式（DESIGN §3.3）：守恒防总量漂移，本条防错误再分配——coins 的每次变更必须
			// 来自合法经济规则的 src（C10 反例：把玩家的铜币改判给浆果丛，总量守恒而再分配非法）。
			// 新增移动铜币的规则时须同步扩展此白名单——铜币流向由此显式化。
			check: (_world, ctx) => {
				const allowed = new Set(["rule:buy.goods", "rule:sell.goods", "rule:scout.luck", "rule:repair.step"]);
				const bad = ctx.changes.filter((c) => c.prop === "coins" && !allowed.has(c.src ?? ""));
				return bad.length ? "铜币的来路对不上账。" : null;
			},
		},
	],
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	...reachFor(),
	// 可持握语义由游戏声明（core 不假定属性名）：河畔村只有 grabbable 的东西可被拿起。
	holdable: (world, _actor, id) => entity(world, id)?.props.grabbable === true,
	summarize: summarizeVillage,
	digest: digestVillage,
	hint: `世界法则（模拟层强制执行）：
1. 每个时刻（tick）：疲劳 +2；饱腹 > 0 时饱腹 -6；饱腹耗尽后体力每刻 -4；疲劳满 100 昏厥；体力见底昏迷。歇息可恢复，昏迷时歇息可醒来。
2. 入夜（时刻 % 4 == 3）：挂着「夜歇」的摊子歇业，买卖一律被拒；野狗有 1/4 概率偷袭（骰子判定，确定性）。
3. 买卖各有其主：每样货品由它的卖家出卖——米从老店主处 10 铜币买入、5 铜币卖回；谷物向老农买，价随麦田存量浮动（存粮越少越贵）。卖家信任 >= 2 时一律减 2 铜币。
4. 与村民交谈提升对方对你的信任（关系边），信任到顶（>= 5）后对方没了新鲜话。
5. 浆果可采集（成熟时）可进食；吃浆果/谷物、饮水各有效果；麦田每 4 个时段补 1 单位谷物。
6. 枯井按阶段修葺：清理 →（手持木料）加固 → 封底，不得跳步；封底后井里有约 10 桶清水，可汲水（draw）饮用（drink）恢复疲劳；完工赏金 10 铜币由老店主支付。
7. 侦察掷骰子运气 >= 3 可在脚下这片地方捡到 2 枚铜币；散落的铜币有限。
8. 铜币总量守恒（含村里散落的）；结构性属性（体力/钱币/位置等）只能由世界法则变更。`,
};
