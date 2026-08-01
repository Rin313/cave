import type { Delta, GameDef, LawCtx, OpLaw, TickLaw } from "../core/sim2.ts";
import { accessible, entity, prop } from "../core/sim2.ts";

function n(c: LawCtx, id: string): string {
	return entity(c.world, id)?.name ?? id;
}

const HARD_MATERIALS = ["copper", "stone", "iron", "steel"];

const wedge: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "move") return { granted: false };
	const x = op.entity;
	const d = op.dest;
	if (prop(c.world, x, "wedgeable") !== true) return { granted: false };
	const de = entity(c.world, d);
	if (!de || de.props.isDoor !== true) return { granted: false };
	const acc = accessible(c.world, x, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	if (de.props.jammed === true) return { granted: false, denyReason: `${n(c, d)}的门缝里已经塞着东西了。` };
	return {
		granted: true,
		changes: [
			{ entity: d, prop: "jammed", to: true },
			{ entity: d, prop: "wedgedBy", to: x },
		],
		reason: `你把${n(c, x)}塞进了${n(c, d)}的门缝，门被卡住了。`,
	};
};

const moveLaw: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "move") return { granted: false };
	const x = op.entity;
	const d = op.dest;
	const acc = accessible(c.world, x, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	if (prop(c.world, x, "grabbable") !== true) {
		return { granted: false, denyReason: `你搬不动${n(c, x)}。` };
	}
	const prevIn = prop(c.world, x, "in") as string | null;
	if (d === c.actor) {
		if (prevIn === c.actor) return { granted: true, reason: `${n(c, x)}已经在你的手中。` };
		if (prop(c.world, x, "attachedTo") != null) {
			return { granted: false, denyReason: `${n(c, x)}被固定在别处，先解下来。` };
		}
	} else {
		const de = entity(c.world, d);
		if (!de) return { granted: false, denyReason: `${n(c, d)}？这里没有这个东西。` };
		if (de.props.space !== true && de.props.open !== true) {
			if (de.props.openable === true) return { granted: false, denyReason: `${n(c, d)}是关着的，放不进去。` };
			return { granted: false, denyReason: `${n(c, d)}放不下东西。` };
		}
	}
	const changes: Delta[] = [{ entity: x, prop: "in", to: d }];
	const wedgedIn = c.world.entities.find((w) => w.props.wedgedBy === x);
	if (wedgedIn) {
		changes.push({ entity: wedgedIn.id, prop: "jammed", to: null });
		changes.push({ entity: wedgedIn.id, prop: "wedgedBy", to: null });
	}
	const verb = d === c.actor ? "拿起了" : entity(c.world, d)?.props.space === true ? "放到了" : "放进了";
	return { granted: true, changes, reason: `你${verb}${n(c, x)}。` };
};

const detach: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "set") return { granted: false };
	if (op.prop !== "attachedTo" || op.value !== null) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "attachedTo") == null) return { granted: false, denyReason: `它没有被固定住。` };
	const acc = accessible(c.world, x, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	return {
		granted: true,
		changes: [
			{ entity: x, prop: "attachedTo", to: null },
			{ entity: x, prop: "in", to: c.actor },
		],
		reason: `你解下了${n(c, x)}，它落入了你的手中。`,
	};
};

const open: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "set" || op.prop !== "open" || op.value !== true) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "openable") !== true) return { granted: false, denyReason: `${n(c, x)}打不开。` };
	if (prop(c.world, x, "open") === true) return { granted: false, denyReason: `它已经开了。` };
	if (prop(c.world, x, "jammed") === true) return { granted: false, denyReason: `${n(c, x)}被东西卡住了，打不开。` };
	return { granted: true, changes: [{ entity: x, prop: "open", to: true }], reason: `你打开了${n(c, x)}。` };
};

const close: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "set" || op.prop !== "open" || op.value !== false) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "openable") !== true) return { granted: false };
	if (prop(c.world, x, "open") !== true) return { granted: false, denyReason: `它已经关着。` };
	return { granted: true, changes: [{ entity: x, prop: "open", to: false }], reason: `你关上了${n(c, x)}。` };
};

const pry: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "apply") return { granted: false };
	const s = op.source;
	const t = op.target;
	if (prop(c.world, t, "openable") !== true) return { granted: false };
	if (prop(c.world, t, "open") === true) return { granted: false };
	if (prop(c.world, s, "lit") === true) return { granted: false };
	if (!HARD_MATERIALS.includes(String(prop(c.world, s, "material")))) return { granted: false };
	return {
		granted: false,
		denyReason: `你用${n(c, s)}撬了撬${n(c, t)}的门缝，但${n(c, s)}太软，${n(c, t)}纹丝不动。`,
	};
};

const ignite: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "apply") return { granted: false };
	const s = op.source;
	const t = op.target;
	if (prop(c.world, s, "lit") !== true) return { granted: false, denyReason: `${n(c, s)}没有火。` };
	const acc = accessible(c.world, t, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	if (prop(c.world, t, "flammable") !== true) return { granted: false, denyReason: `${n(c, t)}烧不起来。` };
	if (prop(c.world, t, "lightable") === true && prop(c.world, t, "lit") !== true) {
		return { granted: true, changes: [{ entity: t, prop: "lit", to: true }], reason: `你点燃了${n(c, t)}。` };
	}
	if (prop(c.world, t, "burning") !== true) {
		return {
			granted: true,
			changes: [
				{ entity: t, prop: "burning", to: true },
				{ entity: t, prop: "lit", to: true },
			],
			reason: `${n(c, t)}燃起来了！`,
		};
	}
	return { granted: false, denyReason: `${n(c, t)}已经在燃烧。` };
};

const extinguish: OpLaw = (c) => {
	const op = c.op;
	if (op?.kind !== "set" || op.prop !== "lit" || op.value !== false) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "lit") !== true) return { granted: false, denyReason: `它没有在燃烧。` };
	if (prop(c.world, x, "burning") === true) return { granted: false, denyReason: `火已经烧起来了，吹不灭。` };
	return { granted: true, changes: [{ entity: x, prop: "lit", to: false }], reason: `你吹灭了${n(c, x)}。` };
};

const denyAll: OpLaw = (c) => {
	const op = c.op;
	if (!op) return { granted: false };
	if (op.kind === "apply") {
		return { granted: false, denyReason: `你把${n(c, op.source)}凑向${n(c, op.target)}，但什么也没有发生。` };
	}
	if (op.kind === "move") {
		return { granted: false, denyReason: `你无法把${n(c, op.entity)}放到${n(c, op.dest)}。` };
	}
	return { granted: false, denyReason: `这世界不这样运转——${n(c, op.entity)}的${op.prop}无法被改变。` };
};

const spread: TickLaw = (c) => {
	const changes: Delta[] = [];
	const reasons: string[] = [];
	for (const b of c.world.entities) {
		if (b.props.burning !== true) continue;
		const targets = c.world.entities.filter((t) => {
			if (t.id === b.id) return false;
			if (t.props.flammable !== true) return false;
			if (t.props.burning === true) return false;
			if (t.props.lit === true) return false;
			const sameLoc = t.props["in"] === b.props["in"];
			const inside = t.props["in"] === b.id;
			return sameLoc || inside;
		});
		for (const t of targets) {
			changes.push({ entity: t.id, prop: "burning", to: true });
			changes.push({ entity: t.id, prop: "lit", to: true });
			reasons.push(`${b.name}的火焰蔓延到了${t.name}！`);
		}
	}
	if (!changes.length) return { granted: false };
	return { granted: true, changes, reason: reasons.join(" ") };
};

const burnout: TickLaw = (c) => {
	const changes: Delta[] = [];
	const reasons: string[] = [];
	for (const b of c.world.entities) {
		if (b.props.burning !== true) continue;
		const t = (b.props.burnTicks as number | null ?? 0) + 1;
		changes.push({ entity: b.id, prop: "burnTicks", to: t });
		if (t >= 3) {
			changes.push({ entity: b.id, prop: "burning", to: false });
			changes.push({ entity: b.id, prop: "lit", to: false });
			changes.push({ entity: b.id, prop: "material", to: "ash" });
			changes.push({ entity: b.id, prop: "flammable", to: false });
			reasons.push(`${b.name}烧成了灰烬。`);
		}
	}
	if (!changes.length) return { granted: false };
	return { granted: true, changes, reason: reasons.join(" ") };
};

export const caveSim2: GameDef = {
	id: "cave",
	title: "地窖（法则引擎）",
	playerId: "player",
	world: {
		time: 0,
		entities: [
			{ id: "cave", name: "地窖", props: { space: true } },
			{ id: "player", name: "你", props: { actor: true, in: "cave" } },
			{ id: "ring", name: "铜戒", props: { in: "skeleton", attachedTo: "skeleton", material: "copper", grabbable: true } },
			{ id: "skeleton", name: "骷髅", props: { in: "cave", material: "bone" } },
			{ id: "torch", name: "火把", props: { in: "cave", material: "wood", flammable: true, lit: true, grabbable: true } },
			{ id: "candle", name: "蜡烛", props: { in: "chest", material: "wax", flammable: true, grabbable: true, wedgeable: true, lightable: true, lit: false } },
			{ id: "chest", name: "木箱", props: { in: "cave", material: "wood", flammable: true, openable: true, open: false, container: true } },
			{ id: "door", name: "石门", props: { in: "cave", material: "stone", openable: true, open: false, isDoor: true } },
		],
	},
	opLaws: [wedge, moveLaw, detach, open, close, pry, ignite, extinguish, denyAll],
	tickLaws: [spread, burnout],
	hint: `世界法则（模拟层强制执行）：
1. 火源（lit=true）作用于可燃物（flammable=true）：可点燃蜡烛（lightable=true，点燃后 lit=true），或让普通可燃物燃烧（burning=true）；燃烧会随时间蔓延到同处或容器内的可燃物，并最终烧成灰烬（material=ash）。
2. 可开启物（openable=true）可被打开/关闭；被卡住（jammed=true）时打不开。
3. 物品可被拿起（move 到玩家）、放下（move 到场景）、放入（move 到打开的容器）、解下（把 attachedTo 设为 null）。
4. 硬物（金属/石材）可用于撬可开启物，撬动与否由双方材质决定。`,
};

export default caveSim2;
