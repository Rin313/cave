import type { Delta, GameDef, LawCtx, OpLaw, TickLaw } from "../core/sim2.ts";
import { accessible, entity, prop, requireOp } from "../core/sim2.ts";

function n(c: LawCtx, id: string): string {
	return entity(c.world, id)?.name ?? id;
}

const MATERIAL_HARDNESS: Record<string, number> = {
	wax: 0,
	copper: 1,
	bone: 2,
	wood: 3,
	iron: 4,
	stone: 5,
	steel: 6,
};

const HARD_MIN = 4;

function hardness(c: LawCtx, id: string): number {
	const m = String(prop(c.world, id, "material") ?? "");
	return MATERIAL_HARDNESS[m] ?? 0;
}

const wedge: OpLaw = (c) => {
	const op = requireOp(c, "move");
	if (!op) return { granted: false };
	const x = op.entity;
	const d = op.dest;
	if (prop(c.world, x, "wedgeable") !== true) return { granted: false };
	const de = entity(c.world, d);
	if (!de || de.props.isDoor !== true) return { granted: false };
	const acc = accessible(c.world, x, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	if (de.props.jammed === true) return { granted: false, denyReason: `${n(c, d)}的门缝里已经塞着东西了。` };
	// 简化：楔入物不改变其位置（仍留在持有者处），只记录 door.jammed/wedgedBy 两个状态位；
	// 移动楔入物到任意位置都会解卡（见 moveLaw 的 wedgedBy 清理）。
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
	const op = requireOp(c, "move");
	if (!op) return { granted: false };
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
	const op = requireOp(c, "set");
	if (!op) return { granted: false };
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
	const op = requireOp(c, "set");
	if (!op) return { granted: false };
	if (op.prop !== "open" || op.value !== true) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "openable") !== true) return { granted: false, denyReason: `${n(c, x)}打不开。` };
	if (prop(c.world, x, "open") === true) return { granted: false, denyReason: `它已经开了。` };
	if (prop(c.world, x, "jammed") === true) return { granted: false, denyReason: `${n(c, x)}被东西卡住了，打不开。` };
	return { granted: true, changes: [{ entity: x, prop: "open", to: true }], reason: `你打开了${n(c, x)}。` };
};

const close: OpLaw = (c) => {
	const op = requireOp(c, "set");
	if (!op) return { granted: false };
	if (op.prop !== "open" || op.value !== false) return { granted: false };
	const x = op.entity;
	if (prop(c.world, x, "openable") !== true) return { granted: false };
	if (prop(c.world, x, "open") !== true) return { granted: false, denyReason: `它已经关着。` };
	return { granted: true, changes: [{ entity: x, prop: "open", to: false }], reason: `你关上了${n(c, x)}。` };
};

const pry: OpLaw = (c) => {
	const op = requireOp(c, "apply");
	if (!op) return { granted: false };
	const s = op.source;
	const t = op.target;
	if (prop(c.world, t, "openable") !== true) return { granted: false };
	if (prop(c.world, t, "open") === true) return { granted: false, denyReason: `${n(c, t)}已经开着。` };
	if (prop(c.world, t, "jammed") === true) return { granted: false, denyReason: `${n(c, t)}被东西卡住，撬不开。` };
	if (prop(c.world, s, "lit") === true) return { granted: false };
	if (hardness(c, s) < HARD_MIN) {
		return { granted: false, denyReason: `${n(c, s)}太软，撬不动${n(c, t)}。` };
	}
	if (hardness(c, s) <= hardness(c, t)) {
		return { granted: false, denyReason: `${n(c, s)}的硬度不足以撬开${n(c, t)}。` };
	}
	const acc = accessible(c.world, s, c.actor);
	if (!acc.ok) return { granted: false, denyReason: acc.reason };
	return {
		granted: true,
		changes: [{ entity: t, prop: "open", to: true }],
		reason: `你用${n(c, s)}撬开了${n(c, t)}。`,
	};
};

const ignite: OpLaw = (c) => {
	const op = requireOp(c, "apply");
	if (!op) return { granted: false };
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
	const op = requireOp(c, "set");
	if (!op) return { granted: false };
	if (op.prop !== "lit" || op.value !== false) return { granted: false };
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

const kindle: TickLaw = (c) => {
	const changes: Delta[] = [];
	const reasons: string[] = [];
	for (const x of c.world.entities) {
		if (x.props.lit !== true) continue;
		if (x.props.burning === true) continue;
		if (x.props.lightable === true) continue;
		const hostId = x.props["in"] as string | null;
		if (!hostId) continue;
		const host = entity(c.world, hostId);
		if (!host || host.props.flammable !== true) continue;
		if (host.props.burning === true || host.props.lit === true) continue;
		changes.push({ entity: host.id, prop: "burning", to: true });
		changes.push({ entity: host.id, prop: "lit", to: true });
		reasons.push(`${x.name}的火焰点燃了${host.name}！`);
	}
	if (!changes.length) return { granted: false };
	return { granted: true, changes, reason: reasons.join(" ") };
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

const GENERIC_DENY_PATTERNS = ["你把", "你无法把", "这世界不这样运转"];

export function isGenericDeny(reason: string): boolean {
	return GENERIC_DENY_PATTERNS.some((p) => reason.startsWith(p));
}

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
			{ id: "crowbar", name: "铁钎", props: { in: "cave", material: "iron", grabbable: true } },
		],
	},
	opLaws: [wedge, moveLaw, detach, open, close, pry, ignite, extinguish, denyAll],
	tickLaws: [kindle, spread, burnout],
	hint: `世界法则（模拟层强制执行）：
1. 火源（lit=true）作用于可燃物（flammable=true）：可点燃蜡烛（lightable=true，点燃后 lit=true），或让普通可燃物燃烧（burning=true）；燃烧会随时间蔓延到同处或容器内的可燃物，并最终烧成灰烬（material=ash）。
2. 燃着的火（lit 且非蜡烛类）放进可燃容器，容器会被引燃（如把火把放进木箱）。
3. 可开启物（openable=true）可被打开/关闭；被卡住（jammed=true）时打不开。
4. 物品可被拿起（move 到玩家）、放下（move 到场景）、放入（move 到打开的容器）、解下（把 attachedTo 设为 null）。
5. 硬物（iron/steel 材质，如铁钎）可撬开比它软的可开启物（如木箱）；撬不动比它硬的（石门是 stone）。`,
};
