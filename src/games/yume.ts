import type { GameDef, PropDef, Q, Step, ViewValue, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, grant, relVal } from "../core/sim.ts";
import { reachLaw } from "./space.ts";
import { Type } from "typebox";

/**
 * 梦核极研究探针：梦日记（Yume Nikki 式）。
 * 极少法则 + 极高自由：四个动词、零领域不变式、两个纯氛围系统
 * authored 形态的实证场：互动按实体逐个书写（卫语句子句 + 兜底），效果（effect）不主动起作用、只是被带着而世界因此不同；
 * 实体可生灭（spawn/despawn）、拓扑可生长（relSet 建径）、持有物改写互动结果。
 * 验证目标：core 原语能否承载「发现即玩法」的世界，而不需要任何新机制。
 */

const YUME_PROPS: Record<string, PropDef> = {
	"in": { type: "id", label: "所在" },
	kind: { type: "string", label: "类别" },
	tags: { type: "tags", label: "标记" },
	space: { type: "boolean", label: "地点" },
	awake: { type: "boolean", label: "清醒" },
	ended: { type: "boolean", internal: true },
	ending: { type: "boolean", label: "终局" },
	dark: { type: "boolean", label: "昏暗" },
	takable: { type: "boolean", label: "可拾取" },
	vended: { type: "boolean", internal: true },
	desc: { type: "string", label: "样子" },
	// space 构件（space.ts）的契约属性：使用该构件的游戏应注册
	openable: { type: "boolean", label: "可开" },
	open: { type: "boolean", label: "已开" },
};

const num = (v: unknown): number => Number(v ?? 0);

/** 效果清单：收齐四枚是唯一的隐藏完成度（世界自己知道，从不告诉玩家）。 */
const EFFECTS = ["knife_effect", "lamp_effect", "cat_effect", "bike_effect"] as const;

const hasEffect = (q: Q, id: string): boolean => entity(q.world, id)?.props.in === q.player;
const hasAllEffects = (q: Q): boolean => EFFECTS.every((e) => hasEffect(q, e));
const hereOf = (q: Q): string => String(entity(q.world, q.player)?.props["in"] ?? "");
/** 法则世界腔的指称解析：id → 展示名（裁决读态上的在世名字）。 */
const nameOf = (q: Q, id: string): string => entity(q.world, id)?.name ?? id;

function summarizeYume(input: { world: World; player: string; steps: Step[] }): string {
	const { world, player, steps } = input;
	const me = entity(world, player);
	const cur = me?.props["in"] as string | null;
	const lines = [`你在${entity(world, cur ?? "")?.name ?? "一片空白"}。`];
	const around = world.entities.filter((e) => e.id !== player && e.props.space !== true && e.props["in"] === cur);
	if (around.length) lines.push(`附近有：${around.map((e) => e.name).join("、")}。`);
	const carried = world.entities.filter((e) => e.id !== player && e.props["in"] === player);
	if (carried.length) lines.push(`带着：${carried.map((e) => e.name).join("、")}。`);
	for (const c of steps.flatMap((s) => s.changes)) {
		if (c.kind === "spawn") lines.push(`出现了：${c.name}。`);
		else if (c.kind === "despawn") lines.push(`消失了：${c.name}。`);
		else if (c.kind === "rename") lines.push(`改名：${c.prev} → ${c.next}。`);
	}
	// 被拒尝试的理由与法则事实（低语）同样是世界的回应
	for (const s of steps) {
		if (s.kind === "action" && !s.ok) lines.push(s.reason);
		if (s.facts?.length) lines.push(...s.facts.map((f) => f.text));
	}
	return lines.join("\n");
}

/** 状态视图派生纹理：清醒态、所在、出口、随身效果清单（视图载荷 ViewValue——呈现投影形态自由；
 *  无 id 承诺的呈现面；实体索引由 core 装配并保证 ≡ 可见性门）。 */
function digestExtraYume(world: World, player: string): Record<string, ViewValue> {
	const me = entity(world, player);
	const cur = me?.props["in"] as string | null;
	return {
		awake: me?.props.awake !== false,
		here: cur ? (entity(world, cur)?.name ?? cur) : null,
		exits: (world.relations ?? [])
			.filter((r) => r.type === "path" && r.from === cur)
			.map((r) => ({ id: r.to, name: entity(world, r.to)?.name ?? r.to })),
		carried: world.entities.filter((e) => e.props.kind === "effect" && e.props["in"] === player).map((e) => e.name),
	};
}

/** 睡去／醒来：房间的床垫通向梦；梦里再睡则回到房间。 */
const sleepVerb = defineVerb({
	label: "睡去／醒来",
	description: "在房间里睡去坠入梦境；在梦里再睡一次则醒来回到房间。",
	schema: Type.Object({}),
	rules: [
		{
			id: "sleep.dream",
			judge: (q) => {
				if (entity(q.world, q.player)?.props.awake === false) return null;
				if (hereOf(q) !== "room") return deny("sleep.place", { reason: "这里是梦。想回去的话，得在梦里再睡一次。" });
				return grant([D.set(q.player, "awake", false), D.set(q.player, "in", "nexus")], "你闭上眼。黑暗涌上来，退去时，你已经站在门厅里。");
			},
		},
		{
			id: "sleep.wake",
			judge: (q) => grant([D.set(q.player, "awake", true), D.set(q.player, "in", "room")], "你掐了一下自己。天花板、床垫、雪花屏的电视——你回到了房间里。", undefined, 1),
		},
	],
});

/** 移动：沿路径在相邻地点间走（一刻）。暗处需要光（灯效果）。
 *  dest 是域外可指的引用参数：地点的名字来自出口列表与旅行史，不随视野蒸发——
 *  雾外地点的提案照常入裁决，存在性与可达性由法则层给出世界性回答。 */
const goVerb = defineVerb({
	label: "移动",
	description: "沿路前往相邻的地点（dest 是地点实体 id，见出口列表）。走动推进梦的时刻。",
	schema: Type.Object({ dest: Type.String({ description: "目的地实体 id" }) }),
	cost: 1,
	entityParams: ["dest"],
	beyondField: ["dest"],
	rules: [
		{
			id: "go.dark",
			judge: (q, p) => {
				const d = entity(q.world, p.dest);
				if (d?.props.space !== true || relVal(q.world, hereOf(q), p.dest, "path") === null) return null;
				if (d.props.dark === true && !hasEffect(q, "lamp_effect")) return deny("go.dark", { reason: `${nameOf(q, p.dest)}里黑得化不开。你摸到门框，退了回来。` });
				return null;
			},
		},
		{
			id: "go.walk",
			judge: (q, p) => {
				const d = entity(q.world, p.dest);
				if (!d || d.props.space !== true) return deny("go.noplace", { reason: `${nameOf(q, p.dest)}？这里没有这个地方。` });
				if (relVal(q.world, hereOf(q), p.dest, "path") === null) return deny("go.noway", { reason: `从这里没有路通往${nameOf(q, p.dest)}。` });
				return grant([D.set(q.player, "in", p.dest)], `你走进了${nameOf(q, p.dest)}。`);
			},
		},
	],
});

/** 拾取：把眼前 takable 的东西收起。效果不是工具，收下即改变世界的回应方式。 */
const takeVerb = defineVerb({
	label: "拾取",
	description: "把眼前可以拿起来的东西收好（takable）。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	rules: [
		reachLaw("entity"),
		{
			id: "take.it",
			judge: (q, p) => {
				const t = entity(q.world, p.entity);
				if (t?.props.takable !== true) return deny("take.heavy", { reason: `${nameOf(q, p.entity)}带不走。` });
				if (t.props["in"] === q.player) return deny("take.held", { reason: `${nameOf(q, p.entity)}已经收好了。` });
				return grant([D.set(p.entity, "in", q.player)], t.props.kind === "effect"
					? `你收下了${nameOf(q, p.entity)}。说不清为什么，世界的质地变了一点。`
					: `你把${nameOf(q, p.entity)}收好了。`);
			},
		},
	],
});

/**
 * 互动：authored 形态的主动词。每条子句是一个被书写过的存在；
 * 结果取决于「它是什么」与「你带着什么」。兜底：世界沉默。
 */
const interactVerb = defineVerb({
	label: "互动",
	description: "触碰、注视或摆弄一个眼前的存在。结果取决于它是什么、以及你带着什么。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	rules: [
		{ id: "int.futon", judge: (_q, p) => (p.entity !== "futon" ? null : grant([], "床垫陷下去一个你的形状，好像一直在等你回来。")) },
		{
			id: "int.tv",
			judge: (q, p) => {
				if (p.entity !== "tv") return null;
				return num(q.time) % 3 === 0 ? grant([], "雪花屏忽然安静了一瞬。那一瞬比任何节目都长。") : grant([], "雪花屏沙沙地响。没有频道。");
			},
		},
		{
			id: "int.journal",
			judge: (q, p) => {
				if (p.entity !== "journal") return null;
				const n = EFFECTS.filter((e) => hasEffect(q, e)).length;
				return grant([], n === 0 ? "手帐上只有一行陌生的字迹：「去找。」" : `手帐上的字迹不是你的：「已收下 ${n} 样东西。」`);
			},
		},
		{
			id: "int.window",
			judge: (q, p) => {
				if (p.entity !== "window") return null;
				if (!hasAllEffects(q) || !entity(q.world, "shadow")) return grant([], "窗外是寻常的黄昏。晾着床单。");
				return grant([D.set(q.player, "ending", true)], "你隔着玻璃，拉住了那只手。手心很凉，回握的力气却很轻。");
			},
		},
		{ id: "int.door.warm", judge: (_q, p) => (p.entity !== "door_warm" ? null : grant([], "门把手是温的，像谁刚刚才松开。")) },
		{ id: "int.door.breath", judge: (_q, p) => (p.entity !== "door_breath" ? null : grant([], "门板在你掌心底下缓慢起伏。它在呼吸。")) },
		{ id: "int.door.cold", judge: (_q, p) => (p.entity !== "door_cold" ? null : grant([], "指尖冻得发麻。门缝里有风声，像很远的海。")) },
		{ id: "int.door.hum", judge: (_q, p) => (p.entity !== "door_hum" ? null : grant([], "门在嗡鸣。频率和你的牙一样。")) },
		{
			id: "int.bird",
			judge: (q, p) => {
				if (p.entity !== "bird") return null;
				if (!hasEffect(q, "knife_effect")) return grant([], "无脸鸟歪着头看你。它没有脸，但你确信自己在被注视。");
				return grant(
					[
						D.despawn("bird"),
						D.spawn({ id: "feather", name: "一根长羽", props: { kind: "item", "in": hereOf(q), takable: true, desc: "羽根是温的。" } }),
					],
					"刀落下去的时候没有血。原地只剩一根长羽。",
				);
			},
		},
		{
			id: "int.machine",
			judge: (q, p) => {
				if (p.entity !== "machine") return null;
				if (entity(q.world, "machine")?.props.vended === true) return grant([], "自贩机只剩嗡嗡声。按钮全都不亮了。");
				return grant([
					D.set("machine", "vended", true),
					D.spawn({ id: "can", name: "冰凉的罐子", props: { kind: "item", "in": "neon", takable: true, desc: "找不到任何标签。" } }),
				], "哐当。口渴的机器吐出一罐东西。");
			},
		},
		{
			id: "int.stonecat",
			judge: (q, p) => {
				if (p.entity !== "stone_cat") return null;
				if (entity(q.world, "hut")) return grant([], "石猫闭着眼。它身后那扇门开着一条缝。");
				return grant([
					D.spawn({ id: "hut", name: "石猫身后的小屋", props: { kind: "space", tags: [], space: true, desc: "从正面看只有一扇门的宽度。" } }),
					D.relSet("desert", "hut", "path", true),
					D.relSet("hut", "desert", "path", true),
					D.spawn({ id: "cat_effect", name: "猫效果", props: { kind: "effect", tags: [], "in": "hut", takable: true, desc: "抱起来的瞬间，整个世界的轮廓都软了一下。" } }),
				], "石猫睁开了眼。它身后多出了一扇门。");
			},
		},
		{
			id: "int.wheel",
			judge: (q, p) => {
				if (p.entity !== "wheel_man") return null;
				const dests = ["forest", "neon", "desert", "snow"];
				const dest = dests[q.roll("wheel.teleport", dests.length) - 1]!;
				return grant([D.set(q.player, "in", dest)], `独轮车人转了半圈。你再眨眼时，脚下已经是${nameOf(q, dest)}。`);
			},
		},
		{ id: "int.snowman", judge: (_q, p) => (p.entity !== "snowman" ? null : grant([], "雪人的两张脸都在笑。你又数了一遍，还是两张。")) },
		{ id: "int.lake", judge: (_q, p) => (p.entity !== "lake" ? null : grant([], "冰层很厚。厚冰下面，有什么东西慢慢地游了过去。")) },
		{
			id: "interact.fallback",
			judge: (q) => {
				const t = entity(q.world, String(q.params.entity));
				return deny("interact.fallback", { reason: t ? `${nameOf(q, t.id)}没有任何反应。` : "那里已经什么都没有了。" });
			},
		},
	],
});

export const yume: GameDef = {
	id: "yume",
	title: "梦日记（极少法则，极高自由）",
	playerId: "player",
	memoryLimit: 6,
	messages: {
		noResponse: "什么也没有发生。",
		invisibleEntity: "你的视野里没有那样的东西。",
		defaultReason: "……",
		notInActionPhase: "梦境此刻不接受操作。",
		timePassed: "梦里的时间悄悄流走",
	},
	voice: `你是梦的记录者，不是解说员。用安静、精确、略带错位的语言写梦：短句、感官细节，不解释梦的逻辑。称呼玩家为「你」。
状态是梦的事实，织进画面，不要罗列属性：desc 是你看见的样子，awake 说明身在梦外还是梦中，carried 是身上的效果——效果不是工具，收下它们，世界的质地就变了一点。
拒绝的理由来自世界，让它落在触感与画面里，而不是解释里。梦不向玩家保证任何事，也不要替它保证。`,
	verbs: {
		sleep: sleepVerb,
		go: goVerb,
		interact: interactVerb,
		take: takeVerb,
	},
	// 时间律：梦的时刻只随走动（go 一刻）与醒来（sleep.wake 授一刻）推进；静止的梦命运冻结，低语伴随行走
	world: {
		time: 0,
		entities: [
			{ id: "room", name: "玩家的房间", props: { kind: "space", tags: ["home"], space: true, desc: "午后的光线里浮着灰尘。房间很小，小得很安全。" } },
			{ id: "futon", name: "床垫", props: { kind: "structure", tags: [], "in": "room", desc: "摊在地上，被面洗得发白。" } },
			{ id: "tv", name: "电视机", props: { kind: "structure", tags: [], "in": "room", desc: "老式的显像管电视，屏幕上全是雪花。" } },
			{ id: "window", name: "阳台窗", props: { kind: "structure", tags: [], "in": "room", desc: "玻璃外是天台和栏杆，天永远是黄昏。" } },
			{ id: "journal", name: "手帐", props: { kind: "item", tags: [], "in": "room", desc: "锁扣开着。纸页边缘卷起来了。" } },
			{ id: "nexus", name: "梦之门厅", props: { kind: "space", tags: ["hub"], space: true, desc: "四壁全是门。数不清有多少扇，亮着的永远只有几扇。" } },
			{ id: "door_warm", name: "发热的门", props: { kind: "structure", tags: [], "in": "nexus", desc: "木纹里透出暖意。" } },
			{ id: "door_breath", name: "起伏的门", props: { kind: "structure", tags: [], "in": "nexus", desc: "门板像胸口一样起伏。" } },
			{ id: "door_cold", name: "结霜的门", props: { kind: "structure", tags: [], "in": "nexus", desc: "门缝凝着细小的冰晶。" } },
			{ id: "door_hum", name: "嗡鸣的门", props: { kind: "structure", tags: [], "in": "nexus", desc: "贴上去能感到低频的震动。" } },
			{ id: "wheel_man", name: "独轮车人", props: { kind: "creature", tags: [], "in": "nexus", desc: "骑着一辆独轮车原地转圈，始终没有回头。" } },
			{ id: "forest", name: "枯森森林", props: { kind: "space", tags: [], space: true, desc: "树都是灰色的。叶子摩擦的声音太响了，响得不像风。" } },
			{ id: "deep", name: "密林深处", props: { kind: "space", tags: [], space: true, desc: "树冠在头顶合拢成屋顶。光到这里就旧了。" } },
			{ id: "bird", name: "无脸鸟", props: { kind: "creature", tags: [], "in": "forest", desc: "它站在一根横枝上，头转过来的时候没有脸。" } },
			{ id: "knife_effect", name: "刀效果", props: { kind: "effect", tags: [], "in": "deep", takable: true, desc: "半插在树皮里。握柄比看上去更冷。" } },
			{ id: "neon", name: "霓虹巷", props: { kind: "space", tags: [], space: true, desc: "招牌全都亮着，没有一个字你认识。" } },
			{ id: "machine", name: "自贩机", props: { kind: "structure", tags: [], "in": "neon", desc: "灯箱亮得过火。里面的饮料全部反着排。" } },
			{ id: "alley", name: "死巷", props: { kind: "space", tags: [], space: true, dark: true, desc: "巷子深处没有光。声音走到一半就停了。" } },
			{ id: "bike_effect", name: "自行车效果", props: { kind: "effect", tags: [], "in": "alley", takable: true, desc: "靠在墙上的自行车。跨上去的话，大概哪里都能去。" } },
			{ id: "desert", name: "沙之海", props: { kind: "space", tags: [], space: true, desc: "沙子一直延伸到天空中间。分不清哪边是地平线。" } },
			{ id: "lamp_effect", name: "灯效果", props: { kind: "effect", tags: [], "in": "desert", takable: true, desc: "半埋在沙里。拧亮的话，是一盏很旧的提灯。" } },
			{ id: "stone_cat", name: "石猫", props: { kind: "structure", tags: [], "in": "desert", desc: "蹲坐的石猫。眼睛的位置只有两个浅坑。" } },
			{ id: "snow", name: "雪原", props: { kind: "space", tags: [], space: true, desc: "雪停了。安静得耳朵发胀。" } },
			{ id: "snowman", name: "双脸雪人", props: { kind: "structure", tags: [], "in": "snow", desc: "一个雪堆，前后各有一张脸。" } },
			{ id: "lake", name: "冻湖", props: { kind: "structure", tags: [], "in": "snow", desc: "整片湖冻成了哑光的镜子。" } },
			{ id: "player", name: "你", props: { kind: "actor", tags: [], "in": "room", awake: true } },
		],
		relations: [
			{ from: "nexus", to: "forest", type: "path", value: true },
			{ from: "forest", to: "nexus", type: "path", value: true },
			{ from: "nexus", to: "neon", type: "path", value: true },
			{ from: "neon", to: "nexus", type: "path", value: true },
			{ from: "nexus", to: "desert", type: "path", value: true },
			{ from: "desert", to: "nexus", type: "path", value: true },
			{ from: "nexus", to: "snow", type: "path", value: true },
			{ from: "snow", to: "nexus", type: "path", value: true },
			{ from: "forest", to: "deep", type: "path", value: true },
			{ from: "deep", to: "forest", type: "path", value: true },
			{ from: "neon", to: "alley", type: "path", value: true },
			{ from: "alley", to: "neon", type: "path", value: true },
		],
	},
	systems: [
		// 纯氛围系统：世界之言——低语没有机制含义，只许被转述
		{
			id: "dream.air",
			run: (q) => {
				if (entity(q.world, q.player)?.props.awake !== false) return null;
				if (q.roll("dream.air", 7) !== 1) return null;
				const whispers = [
					"很远的地方有一扇门开了，又关上。",
					"水滴声。找不到来源。",
					"有什么东西在你身后站了一会儿，又走了。",
				];
				return { deltas: [], facts: [{ text: whispers[num(q.time) % whispers.length]! }] };
			},
		},
		{
			// 终局观测：收齐四枚效果后醒来待在房间，阳台上的人影出现（spawn）。世界从不解释条件。
			id: "ending.watch",
			run: (q) => {
				const me = entity(q.world, q.player);
				if (me?.props.awake !== true || me.props.ended === true || hereOf(q) !== "room") return null;
				if (!hasAllEffects(q)) return null;
				return {
					deltas: [
						D.set(q.player, "ended", true),
						D.spawn({ id: "shadow", name: "阳台上的人影", props: { kind: "figure", tags: [], "in": "room", desc: "隔着玻璃看不清脸。它抬起了一只手。" } }),
					],
					facts: [{ text: "阳台的玻璃上映出一个影子。它不在屋里——它在玻璃的那一面。" }],
				};
			},
		},
	],
	props: YUME_PROPS,
	// 边感知：path 边是世界拓扑的实现细节（出口经 digestExtra 以地点名呈现），不进模型视图——
	// 石猫建路的 relSet 变更行随之沉默（小屋 spawn 卡与法则理由承载揭示）；法则层照常读全真相（Q.rel 不过投影）
	edgePerception: () => (r) => r.type !== "path",
	grounding: (world, player) => {
		// 视野 = 自己 + 所在地 + 同地存在 + 随身携带（in 指向自己）+ 相邻地点（路径另一端）；其余世界藏在雾里。
		const cur = entity(world, player)?.props["in"] as string | null;
		const out = new Set<string>([player]);
		if (cur) out.add(cur);
		for (const e of world.entities) {
			if (e.props["in"] === cur || e.props["in"] === player) out.add(e.id);
			if (e.props.space === true) {
				for (const r of world.relations ?? []) {
					if (r.type === "path" && r.from === cur && r.to === e.id) {
						out.add(e.id);
						break;
					}
				}
			}
		}
		return [...out];
	},
	summarize: summarizeYume,
	digestExtra: digestExtraYume,
};
