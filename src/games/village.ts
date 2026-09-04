import type { Entity, GameDef, PropDef, Q, SystemRule, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, grant, relVal } from "../core/sim.ts";
import { inTreeVisible } from "./space.ts";
import { Type } from "typebox";

/**
 * era/DoL 极研究探针：河畔村。
 * 用现有 core 原语构造最小"强一致数值系统"：
 * 多尺度时间调度、三数值互锁、经济守恒、NPC 关系、顺序过程（阶段链）。
 * 法则纪律（承重墙）：规则代码零实体 id 字面量——交易对象/卖家/出资人/货源全部由实体属性声明
 */

const VILLAGE_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "位置" },
	// 游戏词汇：身体需模拟的实体标记（供 systems 迭代），非 core 概念
	actor: { type: "boolean", internal: true },
	space: { type: "boolean", label: "场景" },
	kind: { type: "string", label: "类别" },
	tags: { type: "tags", label: "标记" },
	// space 构件（space.ts）的契约属性：使用该构件的游戏应注册
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

const num = (v: unknown): number => Number(v ?? 0);
/** 可选数值属性的安全读取：仅认有限 number，缺省/非数返回 null（区别于 0——「属性不存在」不可冒充数值）。 */
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** 守恒计账读数：全实体标量求和（缺失/非有限按 0）。游戏侧计账，锚定不变式 ctx.genesis 的种子。 */
const sumProp = (world: World, prop: string): number => {
	let total = 0;
	for (const e of world.entities) {
		const v = e.props[prop];
		if (typeof v === "number" && Number.isFinite(v)) total += v;
	}
	return total;
};
const isNight = (q: Q): boolean => q.time % 4 === 3;
/** 法则世界腔的指称解析：id → 展示名（裁决读态上的在世名字；参数已过可见性门，兜底仅防御）。 */
const nameOf = (q: Q, id: string): string => entity(q.world, id)?.name ?? id;
/** NPC 对玩家的信任：数值关系边，无边/非数按 0 显式参与比较——缺省与类型语义由拥有
 *  「信任」词汇的游戏命名，不经引擎强转（非数现值不可被静默改写为数值）。 */
const trust = (q: Q, from: string): number => fin(relVal(q.world, from, q.player, "信任")) ?? 0;
/** 卖家忠诚折价：vendor 以 dealTrust/dealCut 声明「信任达标即减价」——关系边 → 经济耦合的通用形态。 */
const loyalCut = (q: Q, vendorId: string): number => {
	const v = entity(q.world, vendorId);
	if (!v || v.props.dealTrust === undefined) return 0;
	return trust(q, vendorId) >= num(v.props.dealTrust) ? num(v.props.dealCut) : 0;
};
const holdable = (q: Q, id: string): boolean => entity(q.world, id)?.props.grabbable === true;
const tagsOf = (e: Entity | undefined): string[] => {
	const t = e?.props.tags;
	return Array.isArray(t) ? (t as string[]) : [];
};

export const village: GameDef = {
	id: "village",
	title: "河畔村（era/DoL 极探针）",
	playerId: "player",
	memoryLimit: 6,
	messages: {
		noResponse: "世界没有以这种方式回应。",
		invisibleEntity: "你看不到那样东西在哪里。",
		defaultReason: "……",
		notInActionPhase: "当前不在行动阶段，无法执行操作。",
		timePassed: "时间流逝",
	},
	verbs: {
		gather: defineVerb({
			label: "拾取",
			description: "把可达的可持握物品拿到手中（如木料、掉在地上的米）。",
			schema: Type.Object({ entity: Type.String({ description: "目标物品 id" }) }),
			cost: 1,
			entityParams: ["entity"],
			rules: [
				{
					id: "gather.take",
					judge: (q, p) => {
						const t = entity(q.world, p.entity);
						if (!t || !holdable(q, p.entity)) return deny("gather.grabbable", { reason: `${nameOf(q, p.entity)}搬不动。` });
						if (t.props.in === q.player) return null;
						return grant([D.set(p.entity, "in", q.player)], `你拾起了${nameOf(q, p.entity)}。`);
					},
				},
				{
					id: "gather.fallback",
					judge: (q) => deny("gather.fallback", { reason: `你拿不起${nameOf(q, String(q.params.entity))}。` }),
				},
			],
		}),
		eat: defineVerb({
			label: "进食",
			description: "吃一颗浆果：饱腹 +25、体力 +5，消耗 1 颗浆果。",
			schema: Type.Object({}),
			rules: [{
				id: "eat.berry",
				judge: (q) => {
					if (num(entity(q.world, q.player)?.props.berries) < 1) return deny("eat.none", { reason: "你翻遍了口袋，没有浆果可吃。" });
					return grant([D.inc(q.player, "berries", -1), D.inc(q.player, "satiety", 25), D.inc(q.player, "hp", 5)], "你吃下了一颗浆果，肚子舒服了些。");
				},
			}],
		}),
		rest: defineVerb({
			label: "歇息",
			description: "休息片刻（一刻）：疲劳归零、体力 +8、饱腹 -5；昏迷时休息可昏睡一夜（四刻）醒来恢复。",
			schema: Type.Object({}),
			rules: [{
				id: "rest.take",
				judge: (q) => {
					const a = entity(q.world, q.player)!;
					if (a.props.down === true) return grant([D.set(q.player, "down", false), D.set(q.player, "fatigue", 0), D.set(q.player, "hp", 30), D.set(q.player, "satiety", 10)], "你昏昏沉沉睡了一夜，醒来后重新站起。", undefined, 4);
					return grant([D.set(q.player, "fatigue", 0), D.inc(q.player, "hp", 8), D.inc(q.player, "satiety", -5)], "你歇了歇，缓过劲来。", undefined, 1);
				},
			}],
		}),
		wait: defineVerb({
			label: "等待",
			description: "原地待着让时间流逝：说等多久（span 为刻数，1–12，缺省一刻），世界就走过多少刻。",
			schema: Type.Object({ span: Type.Optional(Type.Number({ description: "等待的刻数（1–12），缺省一刻" })) }),
			rules: [{
				id: "wait.pass",
				// 时长经类型化参数由语言提案、由规则裁决（限制在 1–12）
				judge: (_q, p) => {
					const span = Math.min(12, Math.max(1, Math.floor(Number(p.span ?? 1))));
					return grant([], span >= 4 ? "你安静地待了好一阵子。" : "你静静地待了一会儿。", undefined, span);
				},
			}],
		}),
		talk: defineVerb({
			label: "交谈",
			description: "与村民攀谈：对方对自己的信任 +1；信任 >= 5 后无话可说。",
			schema: Type.Object({ target: Type.String({ description: "交谈对象 id" }) }),
			entityParams: ["target"],
			rules: [{
				id: "talk.nice",
				judge: (q, p) => {
					if (trust(q, p.target) >= 5) return deny("talk.bored", { reason: `${nameOf(q, p.target)}已经没什么新鲜话可说了。` });
					return grant([D.relInc(p.target, q.player, "信任", 1)], `你和${nameOf(q, p.target)}攀谈了一阵，关系亲近了些。`);
				},
			}],
		}),
		buy: defineVerb({
			label: "购买",
			description: "向货品的卖家（vendor）购买：独件货品（有 price）整件到手；出产型货物（有 yields）从存量中买一份。价格随存量浮动，卖家信任达标（dealTrust）再减价（dealCut）；挂着夜歇的卖家入夜打烊。",
			schema: Type.Object({ goods: Type.String({ description: "货品实体 id" }) }),
			entityParams: ["goods"],
			rules: [
				{
					id: "buy.goods",
					judge: (q, p) => {
						const g = entity(q.world, p.goods);
						const vendorId = typeof g?.props.vendor === "string" ? g.props.vendor : "";
						const vendor = vendorId ? entity(q.world, vendorId) : null;
						const pb = fin(g?.props.priceBase);
						const pr = fin(g?.props.price);
						if (!g || !vendor || vendor.props.alive === false || (pb === null && pr === null)) return deny("buy.notgoods", { reason: `${nameOf(q, p.goods)}不是待售的货品。` });
						if (isNight(q) && vendor.props.closesNight === true) return deny("buy.closed", { reason: `夜色已深，${nameOf(q, vendorId)}已经打烊歇息了。` });
						const yields = typeof g.props.yields === "string" ? g.props.yields : null;
						const stock = yields ? num(g.props[yields]) : 0;
						if (yields && stock < 1) return deny("buy.emptystock", { reason: `${nameOf(q, p.goods)}已经卖光了。` });
						if (!yields && g.props.in === q.player) return deny("buy.held", { reason: `${nameOf(q, p.goods)}已经在你手里了。` });
						const price = Math.max(1, (pb ?? pr!) - (yields ? stock : 0) - loyalCut(q, vendorId));
						if (num(entity(q.world, q.player)?.props.coins) < price) return deny("buy.broke", { reason: "你的钱不够。" });
						return yields
							? grant([D.inc(p.goods, yields, -1), D.inc(q.player, yields, 1), D.inc(vendorId, "coins", price), D.inc(q.player, "coins", -price)], `你花${price}铜币从${nameOf(q, vendorId)}手里买了一份${nameOf(q, p.goods)}的出产。`)
							: grant([D.set(p.goods, "in", q.player), D.inc(vendorId, "coins", price), D.inc(q.player, "coins", -price)], `你花${price}铜币向${nameOf(q, vendorId)}买下了${nameOf(q, p.goods)}。`);
					},
				},
			],
		}),
		sell: defineVerb({
			label: "出售",
			description: "把手里带回收价（resale）的货品卖回给它的卖家（vendor）；挂着夜歇的卖家入夜歇业。",
			schema: Type.Object({ goods: Type.String({ description: "手中货品 id" }) }),
			entityParams: ["goods"],
			rules: [
				{
					id: "sell.goods",
					judge: (q, p) => {
						const g = entity(q.world, p.goods);
						if (!g || g.props.in !== q.player || !(num(g.props.resale) > 0)) return null;
						const vendorId = typeof g.props.vendor === "string" ? g.props.vendor : "";
						const vendor = vendorId ? entity(q.world, vendorId) : null;
						const dest = typeof vendor?.props.in === "string" ? vendor.props.in : null;
						if (!vendor || !dest || vendor.props.alive === false) return deny("sell.novendor", { reason: "眼下没人收这货。" });
						if (isNight(q) && vendor.props.closesNight === true) return deny("sell.closed", { reason: `夜色已深，${nameOf(q, vendorId)}已经歇下了。` });
						const price = num(g.props.resale);
						return grant([D.set(p.goods, "in", dest), D.inc(q.player, "coins", price), D.inc(vendorId, "coins", -price)], `你把${nameOf(q, p.goods)}卖回给了${nameOf(q, vendorId)}。`);
					},
				},
				{ id: "sell.fallback", judge: () => deny("sell.fallback", { reason: "你手里没有可出卖的货品。" }) },
			],
		}),
		eatGrain: defineVerb({
			label: "吃谷物",
			description: "吃一捧谷物：饱腹 +30、体力 +6，消耗 1 份谷物。",
			schema: Type.Object({}),
			rules: [{
				id: "eatgrain.eat",
				judge: (q) => {
					if (num(entity(q.world, q.player)?.props.grain) < 1) return deny("eatgrain.none", { reason: "你翻遍口袋，没有谷物可吃。" });
					return grant([D.inc(q.player, "grain", -1), D.inc(q.player, "satiety", 30), D.inc(q.player, "hp", 6)], "你嚼了一把谷物，腹中稍安。");
				},
			}],
		}),
		draw: defineVerb({
			label: "汲水",
			description: "从出水的水源（supply）打上一桶水；水源的存水有限。",
			schema: Type.Object({ source: Type.String({ description: "水源实体 id" }) }),
			cost: 1,
			entityParams: ["source"],
			rules: [
				{
					id: "draw.water",
					judge: (q, p) => {
						const w = entity(q.world, p.source);
						if (!w || w.props.supply !== true) return deny("draw.dry", { reason: `${nameOf(q, p.source)}还是枯的，打不出水。` });
						if (num(w.props.water) < 1) return deny("draw.empty", { reason: `${nameOf(q, p.source)}的存水已经见底了。` });
						return grant([D.inc(p.source, "water", -1), D.inc(q.player, "water", 1)], `你从${nameOf(q, p.source)}提上一桶清水。`);
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
					if (num(entity(q.world, q.player)?.props.water) < 1) return deny("drink.none", { reason: "你没有水可喝。" });
					return grant([D.inc(q.player, "water", -1), D.inc(q.player, "fatigue", -20), D.inc(q.player, "hp", 3)], "你喝了几口清水，精神一振。");
				},
			}],
		}),
		harvest: defineVerb({
			label: "采集",
			description: "从成熟的浆果丛采下一颗浆果。",
			schema: Type.Object({ bush: Type.String({ description: "浆果丛 id" }) }),
			cost: 1,
			entityParams: ["bush"],
			rules: [
				{
					id: "harvest.bush",
					judge: (q, p) => {
						if (entity(q.world, p.bush)?.props.ripe !== true) return deny("harvest.unripe", { reason: `${nameOf(q, p.bush)}还没有成熟。` });
						return grant([D.inc(q.player, "berries", 1), D.set(p.bush, "ripe", false)], "你采下了一颗浆果。");
					},
				},
			],
		}),
		repair: defineVerb({
			label: "修葺",
			description: "对带阶段（phase）的损毁结构推进一步：清理 →（手持木料类东西）加固 → 封底完工领赏（bounty 由 patron 支付，出水 capacity 份）。每步一段工时。",
			schema: Type.Object({ structure: Type.String({ description: "损毁结构 id" }) }),
			cost: 1,
			entityParams: ["structure"],
			rules: [
				{
					id: "repair.step",
					judge: (q, p) => {
						const s = entity(q.world, p.structure);
						const ph = fin(s?.props.phase);
						if (!s || ph === null) return deny("repair.nostructure", { reason: `${nameOf(q, p.structure)}不需要修葺。` });
						if (ph === 0) return grant([D.inc(p.structure, "phase", 1)], `你清理了${nameOf(q, p.structure)}里的淤泥。`);
						if (ph === 1) {
							const material = q.world.entities.find((e) => e.props.in === q.player && tagsOf(e).includes("wood"));
							if (!material) return deny("repair.nomaterial", { reason: `你得先把木料拿到手，才修得了${nameOf(q, p.structure)}。` });
							return grant([D.inc(p.structure, "phase", 1)], `你用${material.name}加固了${nameOf(q, p.structure)}。`);
						}
						if (ph === 2) {
							const patronId = typeof s.props.patron === "string" ? s.props.patron : "";
							if (!patronId || !entity(q.world, patronId)) return deny("repair.nopatron", { reason: `${nameOf(q, p.structure)}修好了，却没有人来验收。` });
							const bounty = Math.max(0, num(s.props.bounty));
							return grant(
								[D.inc(p.structure, "phase", 1), D.set(p.structure, "supply", true), D.set(p.structure, "water", num(s.props.capacity)), D.inc(q.player, "coins", bounty), D.inc(patronId, "coins", -bounty)],
								`你为${nameOf(q, p.structure)}封好了底，清泉涌出！${nameOf(q, patronId)}赏了你${bounty}枚铜币。`,
							);
						}
						return deny("repair.done", { reason: `${nameOf(q, p.structure)}不需要再修了。` });
					},
				},
			],
		}),
		subdue: defineVerb({
			label: "驱逐",
			description: "在不太疲惫时赶走有攻击性的野兽，代价是被咬一口（骰子伤害，随时刻变化）。",
			schema: Type.Object({ dog: Type.String({ description: "野兽 id" }) }),
			cost: 1,
			entityParams: ["dog"],
			rules: [
				{
					id: "dog.chase",
					// 骰子键含实体 id：同刻键必须唯一，多兽各自独立判定
					judge: (q, p) => {
						// 施动前提是法则义务，不是探测域的声明：攻击性在此裁决，而非只写在枚举域里
						if (entity(q.world, p.dog)?.props.aggressive !== true) return deny("subdue.notbeast", { reason: `${nameOf(q, p.dog)}不是赶得跑的野兽。` });
						if (entity(q.world, p.dog)?.props.alive !== true) return deny("dog.gone", { reason: `${nameOf(q, p.dog)}已经被赶跑了，不在这里了。` });
						if (num(entity(q.world, q.player)?.props.fatigue) >= 40) return deny("dog.tired", { reason: `你太疲惫了，挥不动手，${nameOf(q, p.dog)}只是远远地龇牙。` });
						const bite = -(2 + q.roll(`dog.bite#${p.dog}`, 3));
						return grant([D.set(p.dog, "alive", false), D.inc(q.player, "hp", bite)], `你抄起家伙赶跑了${nameOf(q, p.dog)}，被它咬了一口。`);
					},
				},
			],
		}),
		scout: defineVerb({
			label: "侦察",
			description: "四处翻找脚下这片地方的犄角旮旯：骰子运气 >= 3 时捡到 2 枚铜币（散落的铜币有限，守恒）。",
			schema: Type.Object({}),
			cost: 1,
			rules: [{
				id: "scout.luck",
				judge: (q) => {
					const cur = entity(q.world, q.player)?.props["in"];
					const spot = typeof cur === "string" ? entity(q.world, cur) : null;
					if (!spot) return deny("scout.nospot", { reason: "这里没什么可翻找的。" });
					if (q.roll("find.coin", 4) < 3) return deny("scout.unlucky", { reason: "你翻找了一圈，一无所获。" });
					if (num(spot.props.coins) < 2) return deny("scout.picked", { reason: "能捡的都被人捡干净了。" });
					return grant([D.inc(spot.id, "coins", -2), D.inc(q.player, "coins", 2)], "你四处翻了翻，在墙角捡到了两枚铜币。");
				},
			}],
		}),
	},
	// 时间律：世界时间只经裁决边界流逝，刻数由裁决授予（VerbDef.cost / Verdict.ticks）——
	// 多数劳作一刻，吃喝攀谈瞬时，昏睡一夜四刻
	world: {
		time: 0,
		entities: [
			{ id: "village", name: "河畔村", props: { kind: "space", tags: ["room"], space: true, coins: 4 } },
			{ id: "player", name: "你", props: { kind: "actor", tags: [], actor: true, in: "village", hp: 50, fatigue: 0, satiety: 60, coins: 40, berries: 2, grain: 0, water: 0, down: false } },
			{ id: "merchant", name: "老店主", props: { kind: "npc", tags: ["villager"], in: "village", alive: true, coins: 80, closesNight: true, dealTrust: 2, dealCut: 2 } },
			{ id: "farmer", name: "老农", props: { kind: "npc", tags: ["villager"], in: "village", alive: true, coins: 60, closesNight: true, dealTrust: 2, dealCut: 2 } },
			{ id: "flour", name: "一袋米", props: { kind: "item", tags: ["goods"], in: "village", grabbable: true, price: 10, resale: 5, vendor: "merchant" } },
			{ id: "timber", name: "木料", props: { kind: "item", tags: ["wood"], in: "village", grabbable: true } },
			{ id: "bush", name: "浆果丛", props: { kind: "plant", tags: [], in: "village", ripe: true } },
			{ id: "well", name: "枯井", props: { kind: "structure", tags: ["quest"], in: "village", phase: 0, supply: false, water: 0, patron: "merchant", bounty: 10, capacity: 10 } },
			{ id: "wheatfield", name: "麦田", props: { kind: "plant", tags: ["farm"], in: "village", grain: 10, priceBase: 13, yields: "grain", vendor: "farmer" } },
			{ id: "dog", name: "野狗", props: { kind: "creature", tags: ["beast"], in: "village", alive: true, aggressive: true, hp: 10 } },
		],
		relations: [
			{ from: "merchant", to: "player", type: "信任", value: 0 },
			{ from: "farmer", to: "player", type: "信任", value: 0 },
		],
	},
	systems: [
		{
			id: "dog.forebode",
			// 征兆即世界事件：夜袭前一刻的 fact-only 氛围输出（迟滞阈值——有吠声未必有袭击）。
			// 「即将发生」不进协议通道（core 不编辑感知），先兆由世界供给：有出处、跨回合同一、与袭击同一出处纪律。
			run: (q) => {
				if (q.time % 4 !== 2) return null;
				const beasts = q.world.entities.filter((e) => e.props.alive === true && e.props.aggressive === true);
				if (!beasts.length) return null;
				return { deltas: [], facts: [{ text: "夜色渐浓，远处隐约传来野狗的低吠。" }] };
			},
		},
		{
			id: "dog.night",
			// roll 在条件层只掷一次；每只野兽各扣 1 体力。
			run: (q) => {
				if (q.time % 4 !== 3 || q.roll("dog.night", 4) !== 1) return null;
				if (entity(q.world, q.player)?.props.down === true) return null;
				const beasts = q.world.entities.filter((e) => e.props.alive === true && e.props.aggressive === true);
				if (!beasts.length) return null;
				return {
					deltas: beasts.map(() => D.inc(q.player, "hp", -1)),
					facts: [{ text: "夜色里，野狗窜出来在你小腿上咬了一口！" }],
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
			// 过渡不变式：守恒防总量漂移，本条防错误再分配——coins 的每次变更必须
			// 来自合法经济规则的 src。
			// 新增移动铜币的规则时须同步扩展此白名单——铜币流向由此显式化。
			check: (_world, ctx) => {
				const allowed = new Set(["rule:buy.goods", "rule:sell.goods", "rule:scout.luck", "rule:repair.step"]);
				const bad = ctx.changes.filter((c) => c.kind === "prop" && c.prop === "coins" && !allowed.has(c.src));
				return bad.length ? "铜币的来路对不上账。" : null;
			},
		},
	],
	// 触觉认识论：可指名即可及——容器不透明，闭合容器的内容物不在参照域。感知域 ≡ 可达域时
	// 施动前提由可见性门独任
	grounding: (world, player) => [...inTreeVisible(world, player)],
};
