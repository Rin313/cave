import type { Change, GameDef, PropDef, PropValue, Q, Simulation, VerbDef, Verdict, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, fallback, grant, internalPropsOf } from "../core/sim.ts";
import { denyUnreachable, inTreeVisible, reachFor } from "./space.ts";
import { Type } from "typebox";

/**
 * 开放世界（流沙荒原）：约束化重量（卫语句式规则）示例。
 *  - 预设动词覆盖物理/生存动作：travel（路径移动）、move（拿起/放下/放入）、open（开合）、use（点燃）、harvest（采集）、fill/drink（水囊与渴感）。
 *  - 环境响应走声明式动词：mark（刻记号 marked）、examine（勘察 examined）——按 reach 授予的通用规则。
 *  - 结构性属性（位置/材质/明火/燃烧/钱币）由规则/系统变更，凭任意通道都改不了（提交硬墙 + 不变式）。
 *  - 验证目标：AI 无法凭一句话凭空改材质、传送不可达物体、创造/销毁实体、击杀生物——开放世界的自由度
 *    由 动词表 + 规则 + 不变式硬墙 给出。
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

const num = (v: unknown): number => Number(v ?? 0);

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
	return JSON.stringify({ time: sim.world.time, relations: rels, entities: items });
}

/** 移动授予理由：拿起 / 放到（当前场景）/ 放进（打开的容器）。 */
const moveReason = (q: Q, id: string, dest: string): string => {
	if (dest === q.actor) return `你拿起了${q.name(id)}。`;
	return q.entity(dest)?.props.space === true ? `你把${q.name(id)}放在${q.name(dest)}。` : `你把${q.name(id)}放进了${q.name(dest)}。`;
};

const travelVerb = defineVerb({
	label: "跋涉",
	description: "沿荒原小径前往相邻的地点（dest 是当前所在地的相邻场景 id）。",
	schema: Type.Object({ dest: Type.String({ description: "相邻地点的实体 id（见路径关系）" }) }),
	entityParams: ["dest"],
	candidates: (sim) => {
		const cur = sim.world.entities.find((e) => e.id === sim.actor)?.props["in"] as string | null;
		const paths = (sim.world.relations ?? []).filter((r) => r.from === cur && r.type === "path").map((r) => r.to);
		return { dest: paths };
	},
	rules: [{
		id: "travel.walk",
		judge: (q, p) => {
			const cur = String(q.entity(q.actor)?.props.in ?? "");
			const d = q.entity(p.dest);
			if (!d) return deny("travel.dest", { object: p.dest, reason: `${q.name(p.dest)}？这里没有这个地方。` });
			if (d.props.space !== true) return deny("denyAll.travel", { subject: cur, object: p.dest, reason: `你无法前往${q.name(p.dest)}。`, fallback: true });
			if (cur === p.dest) return deny("travel.stay", { object: p.dest, reason: "你已经在目的地了。" });
			if (q.rel(cur, p.dest, "path") === null) return deny("travel.noway", { subject: cur, object: p.dest, reason: `从这里（${q.name(cur)}）没有路径通往${q.name(p.dest)}。` });
			return grant([D.set(q.actor, "in", p.dest)], `你沿荒径走向${q.name(p.dest)}。`);
		},
	}],
});

const moveVerb = defineVerb({
	label: "拾取与放置",
	description: "拿起/放下/放入：把可达的可持握物品移到目标位置（玩家手中 / 当前地点 / 打开的容器）。",
	schema: Type.Object({
		entity: Type.String({ description: "要移动的物品 id（必须可持握且可达）" }),
		dest: Type.String({ description: "目标 id（你 / 当前地点 / 打开的容器）" }),
	}),
	entityParams: ["entity", "dest"],
	candidates: (sim) => ({ dest: [...sim.visible(), sim.actor] }),
	rules: [{
		id: "move.open",
		judge: (q, p) => {
			if (!q.canReach(p.entity)) return denyUnreachable(q, p.entity);
			const t = q.entity(p.entity);
			if (t?.props.grabbable !== true) return deny("move.grabbable", { subject: p.entity, reason: `你搬不动${q.name(p.entity)}。` });
			const d = q.entity(p.dest);
			if (!d) return deny("move.dest", { subject: p.entity, object: p.dest, reason: `${q.name(p.dest)}？这里没有这个东西。` });
			const blocked = (): Verdict => deny("denyAll.move", { subject: p.entity, object: p.dest, reason: `你无法把${q.name(p.entity)}放到${q.name(p.dest)}。`, fallback: true });
			if (p.entity === p.dest) return blocked();
			if (p.dest === q.actor) {
				if (t.props.in === q.actor) return deny("move.held", { subject: p.entity, reason: `${q.name(p.entity)}已经在你的手中。` });
				return grant([D.set(p.entity, "in", p.dest)], moveReason(q, p.entity, p.dest));
			}
			const cur = String(q.entity(q.actor)?.props.in ?? "");
			const intoOpen = d.props.openable === true && d.props.open === true;
			if (!(d.id === cur && d.props.space === true) && !intoOpen) return blocked();
			return grant([D.set(p.entity, "in", p.dest)], moveReason(q, p.entity, p.dest));
		},
	}],
});

/** 容器开合：openable 实体的 open 开关（true 开 / false 关）。 */
const openVerb = defineVerb({
	label: "开合",
	description: "打开或关闭一个可开启物（entity 用 open:true / false）。",
	schema: Type.Object({
		entity: Type.String({ description: "目标实体 id" }),
		open: Type.Boolean({ description: "true 打开 / false 关闭" }),
	}),
	entityParams: ["entity"],
	candidates: () => ({ open: [true, false] }),
	rules: [{
		id: "open.toggle",
		judge: (q, p) => {
			if (!q.canReach(p.entity)) return deny("denyAll.open", { subject: p.entity, reason: `${q.name(p.entity)}没有变化。`, fallback: true });
			const t = q.entity(p.entity);
			if (t?.props.openable !== true) return deny("open.notopenable", { subject: p.entity, reason: `${q.name(p.entity)}打不开。` });
			if (t.props.open !== true) return grant([D.set(p.entity, "open", true)], `你打开了${q.name(p.entity)}。`);
			return grant([D.set(p.entity, "open", false)], `你合上了${q.name(p.entity)}。`);
		},
	}],
});

/** 点燃：source 有明火（lit）→ target 可燃（flammable）则燃烧。 */
const useVerb = defineVerb({
	label: "作用",
	description: "用一件东西作用于另一件东西（点燃：source 必须有明火，target 必须可燃）。施动的东西必须拿得动且够得着。",
	schema: Type.Object({
		source: Type.String({ description: "施动实体 id（必须可持握且可达）" }),
		target: Type.String({ description: "受动实体 id" }),
	}),
	entityParams: ["source", "target"],
	instrumentParams: ["source"],
	rules: [{
		id: "use.ignite",
		judge: (q, p) => {
			if (q.entity(p.source)?.props.lit !== true) return deny("ignite.nolight", { subject: p.source, object: p.target, reason: `${q.name(p.source)}没有火。` });
			if (!q.canReach(p.target)) return denyUnreachable(q, p.target);
			const t = q.entity(p.target);
			if (t?.props.flammable !== true) return deny("ignite.notflammable", { subject: p.source, object: p.target, reason: `${q.name(p.target)}烧不起来。` });
			if (t.props.burning === true) return deny("ignite.burning", { subject: p.source, object: p.target, reason: `${q.name(p.target)}已经在燃烧。` });
			return grant([D.set(p.target, "burning", true), D.set(p.target, "lit", true)], `${q.name(p.target)}燃起来了。`);
		},
	}],
});

/** 采集浆果：成熟（ripe）且可达的浆果丛 → 得 1 颗浆果。 */
const harvestVerb = defineVerb({
	label: "采集",
	description: "从成熟的可达浆果丛采下一颗浆果（bush 是浆果丛实体 id）。",
	schema: Type.Object({ bush: Type.String({ description: "浆果丛实体 id（必须成熟且可达）" }) }),
	entityParams: ["bush"],
	candidates: (sim) => ({ bush: sim.world.entities.filter((e) => e.props.ripe === true).map((e) => e.id) }),
	rules: [{
		id: "harvest.berries",
		judge: (q, p) => {
			if (q.entity(p.bush)?.props.ripe !== true) return deny("harvest.unripe", { subject: p.bush, reason: `${q.name(p.bush)}还没有成熟。` });
			if (!q.canReach(p.bush)) return deny("denyAll.harvest", { subject: p.bush, reason: `${q.name(p.bush)}无法被采集。`, fallback: true });
			return grant([D.inc(q.actor, "berries", 1), D.set(p.bush, "ripe", false)], "你采下了一颗浆果。");
		},
	}],
});

/** 舀水（泉眼）：随身水囊容量 2，装满了不能再舀。 */
const fillVerb = defineVerb({
	label: "舀水",
	description: "在泉眼处把随身水囊装满一袋清水（水囊容量 2）。",
	schema: Type.Object({}),
	rules: [{
		id: "fill.water",
		judge: (q) => {
			if (!q.canReach("spring")) return deny("denyAll.fill", { subject: "spring", reason: "这里没有水可舀。", fallback: true });
			if (num(q.entity(q.actor)?.props.water) >= 2) return deny("fill.full", { subject: "spring", reason: "你的水囊已经满了，装不下更多。" });
			return grant([D.inc(q.actor, "water", 1)], "你俯身舀起一袋清水。");
		},
	}],
});

/** 饮水：在泉眼直接喝（渴感归零）；或喝随身水（消耗 1 份水，渴感归零）。 */
const drinkVerb = defineVerb({
	label: "饮水",
	description: "在泉眼直接喝（渴感归零）；或喝随身带着的水（消耗 1 份，渴感归零）。",
	schema: Type.Object({}),
	rules: [
		{ id: "drink.spring", judge: (q) => (q.canReach("spring") ? grant([D.set(q.actor, "thirst", 0)], "你俯身喝了口清泉，渴意尽消。") : null) },
		{ id: "drink.carry", judge: (q) => (num(q.entity(q.actor)?.props.water) < 1 ? null : grant([D.inc(q.actor, "water", -1), D.set(q.actor, "thirst", 0)], "你喝了口随身带着的水，精神一振。")) },
		fallback("denyAll.drink", () => "你口干舌燥，却找不到水喝。"),
	],
});

/** 环境响应动词的候选域：可见实体 - 玩家 - 场景（mark/examine 共用）。 */
const envTargetCandidates = (sim: Simulation): Record<string, string[]> => ({
	entity: [...sim.visible()].filter((id) => id !== sim.actor && sim.world.entities.find((e) => e.id === id)?.props.space !== true),
});

const markVerb = defineVerb({
	label: "刻记号",
	description: "在可达的实体上刻下一道记号（marked）。刻过的不能再刻。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	candidates: envTargetCandidates,
	rules: [{
		id: "mark.carve",
		judge: (q, p) => {
			if (!q.canReach(p.entity)) return denyUnreachable(q, p.entity);
			if (q.entity(p.entity)?.props.marked === true) return deny("mark.done", { subject: p.entity, reason: `${q.name(p.entity)}上已经刻过记号了。` });
			return grant([D.set(p.entity, "marked", true)], `你在${q.name(p.entity)}上刻下了一道记号。`);
		},
	}],
});

const examineVerb = defineVerb({
	label: "勘察",
	description: "仔细查看一个可达的实体（examined），记下它的细节。",
	schema: Type.Object({ entity: Type.String({ description: "目标实体 id" }) }),
	entityParams: ["entity"],
	candidates: envTargetCandidates,
	rules: [{
		id: "examine.look",
		judge: (q, p) => {
			if (!q.canReach(p.entity)) return denyUnreachable(q, p.entity);
			return grant([D.set(p.entity, "examined", true)], `你仔细勘察了${q.name(p.entity)}。`);
		},
	}],
});

export const waste: GameDef = {
	id: "waste",
	title: "流沙荒原（开放世界）",
	playerId: "player",
	messages: {
		noResponse: "世界没有以这种方式回应。",
		invisibleEntity: (names) => (names.length ? `你看不到${names.join("、")}在哪里。` : "这里没有那样的东西。"),
		instrumentUnholdable: (name) => `${name}太沉重，你拿不动它来施力。`,
		instrumentUnreachable: (name) => `${name}在你够不到的地方，没法拿来使。`,
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
	turnTicks: 1,
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
	systems: [
		{
			id: "burn.tick",
			run: (q) => ({ deltas: q.world.entities.filter((e) => e.props.burning === true).map((b) => D.inc(b.id, "burnTicks", 1)) }),
		},
		{
			id: "burn.ash",
			run: (q) => {
				const done = q.world.entities.filter((e) => e.props.burning === true && e.props.lasting !== true && num(e.props.burnTicks) >= 3);
				if (!done.length) return null;
				return {
					deltas: done.flatMap((b) => [D.set(b.id, "burning", false), D.set(b.id, "lit", false), D.set(b.id, "material", "ash"), D.set(b.id, "flammable", false)]),
					facts: done.map((b) => ({ text: `${q.name(b.id)}烧成了灰烬。`, entities: [b.id] })),
				};
			},
		},
		{
			id: "grow.tick",
			run: (q) => ({ deltas: q.world.entities.filter((e) => e.props.ripe === false).map((b) => D.inc(b.id, "regrowTicks", 1)) }),
		},
		{
			id: "grow.ripe",
			run: (q) => {
				const ready = q.world.entities.filter((e) => num(e.props.regrowTicks) >= 5);
				if (!ready.length) return null;
				return { deltas: ready.flatMap((b) => [D.set(b.id, "ripe", true), D.set(b.id, "regrowTicks", 0)]) };
			},
		},
		{
			id: "thirst.rise",
			run: (q) => ({ deltas: [D.inc(q.actor, "thirst", 3)] }),
		},
		{
			id: "thirst.hurt",
			run: (q) => (num(q.entity(q.actor)?.props.thirst) < 100 ? null : { deltas: [D.inc(q.actor, "hp", -5)], facts: [{ text: "干渴灼烧着你的喉咙，你感到头昏眼花。", entities: [q.actor] }] }),
		},
		{
			id: "beast.night",
			run: (q) => {
				if (q.time % 4 !== 3) return null;
				const here = q.world.entities.filter((e) => e.props.alive === true && e.props.aggressive === true && e.props.in === q.entity(q.actor)?.props.in);
				if (!here.length) return null;
				return {
					deltas: here.map(() => D.inc(q.actor, "hp", -2)),
					facts: here.map((b) => ({ text: `夜色里，${q.name(b.id)}扑上来在你身上留下了一道伤口。`, entities: [b.id, q.actor] })),
				};
			},
		},
	],
	props: WASTE_PROPS,
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	...reachFor(),
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
