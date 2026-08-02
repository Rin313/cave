import type { Action, Change, Delta, Denial, GameDef, PropValue, Rule, RuleCtx, RuleResult, Simulation, VerbDef, World } from "../core/sim.ts";
import { D, entity, inTreeReach, inTreeVisible, messagesFor, prop } from "../core/sim.ts";
import { Type } from "typebox";

const MEDITATE_GAIN = 6;
const MEDITATE_COST = 15;
const SPAR_COST = 20;
const SPAR_WEAPON_BONUS = 8;
const SPAR_RNG = 5;
const STAMINA_MAX = 100;
const RECOVER_GAIN = 10;
const INJURED_HEAL_AT = 40;

function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

function n(c: RuleCtx, id: string): string {
	return name(c.world, id);
}

function param(a: Action | null, key: string): string {
	return String(a?.params?.[key] ?? "");
}

function num(w: World, id: string, p: string): number {
	return Number(prop(w, id, p) ?? 0);
}

function isNpc(w: World, id: string): boolean {
	return entity(w, id)?.kind === "npc";
}

function isNpcHere(c: RuleCtx, id: string): boolean {
	return isNpc(c.world, id) && inTreeReach(c.world, c.actor, id).ok;
}

/** 可达性拒绝构造：实体不可达时返回结构化拒绝，散文由 GameDef.denialTemplates 渲染。 */
function denyUnreachable(c: RuleCtx, id: string): { granted: false; denial: Denial } | null {
	const acc = inTreeReach(c.world, c.actor, id, messagesFor(c.def));
	if (acc.ok) return null;
	return { granted: false, denial: { law: "reach", subject: id, reason: acc.reason } };
}

const PROP_LABELS: Record<string, string> = {
	neili: "内力", stamina: "体力", sword: "剑法", injured: "伤势", in: "所在",
};

function summarizeWuxia(input: { world: World; changes: Change[]; actor: string }): string {
	const { world, changes, actor } = input;
	const lines: string[] = [];
	const player = entity(world, actor);
	const loc = player?.props["in"] as string | null;
	const place = entity(world, loc ?? "")?.name ?? "原地";
	lines.push(`你站在${place}。`);
	for (const id of inTreeVisible(world, actor)) {
		if (id === actor) continue;
		const e = entity(world, id);
		if (!e) continue;
		if (e.props.space === true) continue;
		const bits: string[] = [];
		if (e.kind === "npc") {
			bits.push(`内力${num(world, id, "neili")}`);
			bits.push(`剑法${num(world, id, "sword")}`);
		}
		if (e.props.weapon === true) bits.push("利刃");
		if (e.props.weapon !== true && e.props.grabbable === true) bits.push("小物");
		const holder = e.props["in"] as string | null;
		if (holder && holder !== actor) {
			const parent = entity(world, holder);
			if (parent) bits.push(`在${parent.name}那里`);
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
			return v;
		}
		return String(v);
	};
	for (const ch of changes) {
		const e = entity(world, ch.entity);
		const label = PROP_LABELS[ch.prop] ?? ch.prop;
		lines.push(`变更：${e?.name ?? ch.entity}的${label} ${fmt(ch.from)} → ${fmt(ch.to)}`);
	}
	return lines.join("\n");
}

/** 打坐：消耗体力，增长内力。体力不足拒绝。 */
const meditate: Rule = (c) => {
	const stam = num(c.world, c.actor, "stamina");
	if (stam < MEDITATE_COST) {
		return { granted: false, denial: { law: "meditate.tired", subject: c.actor } };
	}
	return {
		granted: true,
		involved: [c.actor],
		changes: [D.inc(c.actor, "neili", MEDITATE_GAIN), D.inc(c.actor, "stamina", -MEDITATE_COST)],
		reason: `你盘膝而坐，运功调息，内力充盈了几分。`,
	};
};

/** 切磋：与同处的人物比武。胜则剑法精进、对方「佩服」加深；败则损耗体力，体力过低受伤；受伤时无法切磋。 */
const spar: Rule = (c) => {
	const opp = param(c.action, "opponent");
	if (!isNpcHere(c, opp)) {
		return { granted: false, denial: { law: "spar.target", subject: c.actor, object: opp } };
	}
	if (prop(c.world, c.actor, "injured") === true) {
		return { granted: false, denial: { law: "spar.injured", subject: c.actor } };
	}
	const weaponBonus = c.world.entities.some((e) => e.props.weapon === true && prop(c.world, e.id, "in") === c.actor) ? SPAR_WEAPON_BONUS : 0;
	const myPower = num(c.world, c.actor, "sword") + num(c.world, c.actor, "neili") / 10 + weaponBonus + c.rng() * SPAR_RNG;
	const oppPower = num(c.world, opp, "sword") + num(c.world, opp, "neili") / 10 + c.rng() * SPAR_RNG;
	if (myPower >= oppPower) {
		return {
			granted: true,
			involved: [c.actor, opp],
			changes: [D.inc(opp, "stamina", -20), D.inc(c.actor, "sword", 1), D.relInc(opp, c.actor, "佩服", 1)],
			facts: [{ text: `${n(c, opp)}败于你的剑下。`, entities: [opp, c.actor] }],
			reason: `你与${n(c, opp)}切磋，技高一筹，胜了半招。`,
		};
	}
	const afterStam = num(c.world, c.actor, "stamina") - SPAR_COST;
	const changes: Delta[] = [D.inc(c.actor, "stamina", -SPAR_COST)];
	if (afterStam < 20) changes.push(D.set(c.actor, "injured", true));
	return {
		granted: true,
		involved: [c.actor, opp],
		changes,
		facts: [{ text: `你在切磋中落败，${afterStam < 20 ? "还受了些伤。" : "略感疲乏。"}`, entities: [c.actor] }],
		reason: `你与${n(c, opp)}切磋，不敌对手，败下阵来。`,
	};
};

/** 赶路：前往任何地点。 */
const travel: Rule = (c) => {
	const d = param(c.action, "dest");
	const de = entity(c.world, d);
	if (!de || de.props.space !== true) {
		return { granted: false, denial: { law: "travel.dest", subject: c.actor, object: d } };
	}
	if (prop(c.world, c.actor, "in") === d) {
		return { granted: true, involved: [d], reason: `你已经身在${de.name}。` };
	}
	return { granted: true, involved: [d], changes: [D.set(c.actor, "in", d)], reason: `你来到了${de.name}。` };
};

/** 拿取：拿起可持握且可达的物品。 */
const take: Rule = (c) => {
	const x = param(c.action, "entity");
	const un = denyUnreachable(c, x);
	if (un) return un;
	if (prop(c.world, x, "grabbable") !== true) {
		return { granted: false, denial: { law: "take.grabbable", subject: x } };
	}
	if (prop(c.world, x, "in") === c.actor) {
		return { granted: true, involved: [x], reason: `${n(c, x)}已经在你的手中。` };
	}
	return { granted: true, involved: [x], changes: [D.set(x, "in", c.actor)], reason: `你拿起了${n(c, x)}。` };
};

/** 赠予：把手中的物品赠给同处的人物，增进对方对你的信任。 */
const give: Rule = (c) => {
	const item = param(c.action, "item");
	const to = param(c.action, "to");
	if (prop(c.world, item, "in") !== c.actor) {
		return { granted: false, denial: { law: "give.notheld", subject: item } };
	}
	if (!isNpcHere(c, to)) {
		return { granted: false, denial: { law: "give.target", subject: item, object: to } };
	}
	return {
		granted: true,
		involved: [item, to],
		changes: [D.set(item, "in", to), D.relInc(to, c.actor, "信任", 1)],
		reason: `你把${n(c, item)}赠给了${n(c, to)}。`,
	};
};

/** 体力恢复（含伤势自愈）：每人每 tick 恢复体力，玩家体力恢复到一定程度后伤势痊愈。 */
const recover: Rule = (c) => {
	const changes: Delta[] = [];
	const involved = new Set<string>();
	for (const e of c.world.entities) {
		if (e.props.actor !== true && e.kind !== "npc") continue;
		const cur = Number(e.props.stamina ?? 0);
		if (cur >= STAMINA_MAX) continue;
		changes.push(D.inc(e.id, "stamina", RECOVER_GAIN));
		involved.add(e.id);
		if (e.id === c.actor && e.props.injured === true && cur + RECOVER_GAIN >= INJURED_HEAL_AT) {
			changes.push(D.set(e.id, "injured", false));
		}
	}
	if (!changes.length) return { granted: false };
	return { granted: true, changes, involved: [...involved], reason: "众人调息片刻，体力有所恢复。" };
};

const denyAll: Rule = (c) => {
	const verb = c.action?.verb ?? "";
	const laws: Record<string, Denial> = {
		travel: { law: "denyAll.travel", subject: c.actor, object: param(c.action, "dest") },
		take: { law: "denyAll.take", subject: param(c.action, "entity") },
		give: { law: "denyAll.give", subject: param(c.action, "item"), object: param(c.action, "to") },
		meditate: { law: "denyAll.meditate", subject: c.actor },
		spar: { law: "denyAll.spar", subject: c.actor, object: param(c.action, "opponent") },
	};
	return { granted: false, denial: laws[verb] ?? { law: "denyAll.generic" } };
};

const travelVerb: VerbDef = {
	label: "赶路",
	description: "前往门派中的某个地点（议事厅 / 练武场 / 藏经阁）。",
	schema: Type.Object({
		dest: Type.String({ description: "目的地 id（地点实体）" }),
	}),
	entityParams: ["dest"],
	candidates: (sim) => ({
		dest: sim.world.entities.filter((e) => e.props.space === true).map((e) => e.id),
	}),
	rules: [travel],
};

const takeVerb: VerbDef = {
	label: "拿取",
	description: "拿起一件可持握且够得着的物品。",
	schema: Type.Object({
		entity: Type.String({ description: "要拿起的物品 id" }),
	}),
	entityParams: ["entity"],
	candidates: (sim) => ({
		entity: sim.world.entities.filter((e) => e.props.grabbable === true && inTreeReach(sim.world, sim.actor, e.id).ok).map((e) => e.id),
	}),
	rules: [take],
};

const giveVerb: VerbDef = {
	label: "赠予",
	description: "把手中的物品赠给同处的人物（npc），增进对方对你的信任。",
	schema: Type.Object({
		item: Type.String({ description: "要赠送的物品 id（必须在手中）" }),
		to: Type.String({ description: "受赠的人物 id（npc）" }),
	}),
	entityParams: ["item", "to"],
	candidates: (sim) => ({
		item: sim.world.entities.filter((e) => prop(sim.world, e.id, "in") === sim.actor).map((e) => e.id),
		to: sim.world.entities.filter((e) => e.kind === "npc" && inTreeReach(sim.world, sim.actor, e.id).ok).map((e) => e.id),
	}),
	rules: [give],
};

const meditateVerb: VerbDef = {
	label: "打坐",
	description: "盘膝运功，消耗体力以增长内力。体力不足时无法打坐。",
	schema: Type.Object({}),
	rules: [meditate],
};

const sparVerb: VerbDef = {
	label: "切磋",
	description: "与同处的人物比武切磋：胜则剑法精进、对方对你「佩服」加深；败则损耗体力，体力过低会受伤。受伤时无法切磋。",
	schema: Type.Object({
		opponent: Type.String({ description: "切磋对象 id（npc，必须在同一地点）" }),
	}),
	entityParams: ["opponent"],
	candidates: (sim) => ({
		opponent: sim.world.entities.filter((e) => e.kind === "npc" && inTreeReach(sim.world, sim.actor, e.id).ok).map((e) => e.id),
	}),
	rules: [spar],
};

// —— 表达层语义断言钩子：受伤 / 手持断言 ——

const INJURY_CLAIMS = ["受伤", "负伤", "流血", "重伤", "挂彩"];
const HAND_CLAIMS = ["手中", "手上", "掌心", "手里", "握着", "握紧"];
const NEGATIONS = ["未", "没", "无", "不", "别", "休", "尚未", "未曾", "不曾"];
const PUNCT = /[，。；！？、—]/;
const NEAR_WINDOW = 8;

function negatedBefore(s: string, p: number): boolean {
	return NEGATIONS.some((x) => s.slice(Math.max(0, p - 3), p).includes(x));
}

function nearBefore(s: string, name: string, p: number): boolean {
	const from = Math.max(0, p - NEAR_WINDOW);
	const i = s.lastIndexOf(name, p - 1);
	if (i === -1 || i < from) return false;
	return !PUNCT.test(s.slice(i + name.length, p));
}

function nearAfter(s: string, name: string, p: number, claimLen: number): boolean {
	const to = Math.min(s.length, p + claimLen + NEAR_WINDOW);
	const i = s.indexOf(name, p + claimLen);
	if (i === -1 || i + name.length > to) return false;
	return !PUNCT.test(s.slice(p + claimLen, i));
}

function scanClaims(
	s: string,
	claims: readonly string[],
	targets: readonly { name: string }[],
	error: (t: { name: string }) => string,
): string | null {
	for (const claim of claims) {
		let idx = 0;
		while ((idx = s.indexOf(claim, idx)) !== -1) {
			if (negatedBefore(s, idx)) {
				idx += claim.length;
				continue;
			}
			const t = targets.find((e) => nearBefore(s, e.name, idx) || nearAfter(s, e.name, idx, claim.length));
			if (t) return error(t);
			idx += claim.length;
		}
	}
	return null;
}

export function validateWuxiaText(input: { text: string; world: World; changes: Change[]; actor: string; pending: Change[] }): string | null {
	const { text, world, actor } = input;
	const playerName = entity(world, actor)?.name ?? "你";
	const injured = prop(world, actor, "injured") === true;
	const held = (id: string) => prop(world, id, "in") === actor;
	const nonHeld = world.entities.filter((e) => e.id !== actor && e.props.space !== true && e.props.grabbable === true && !held(e.id));

	for (const s of text.split(/[。！？!?；;]/)) {
		const injury = scanClaims(s, INJURY_CLAIMS, injured ? [] : [{ name: playerName }], () => `描述虚构了「${playerName}」受伤/负伤，但当前状态并非如此。`);
		if (injury) return injury;
		const hand = scanClaims(s, HAND_CLAIMS, nonHeld, (t) => `描述虚构了「${t.name}」在你手中，但当前它不在你这里。`);
		if (hand) return hand;
	}
	return null;
}

export const wuxia: GameDef = {
	id: "wuxia",
	title: "青峰派（武侠）",
	playerId: "player",
	verbs: {
		travel: travelVerb,
		take: takeVerb,
		give: giveVerb,
		meditate: meditateVerb,
		spar: sparVerb,
	},
	world: {
		time: 0,
		entities: [
			{ id: "hall", name: "议事厅", kind: "place", tags: ["space"], props: { space: true } },
			{ id: "yard", name: "练武场", kind: "place", tags: ["space"], props: { space: true } },
			{ id: "library", name: "藏经阁", kind: "place", tags: ["space"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "yard", neili: 10, stamina: 80, sword: 4 } },
			{ id: "senior", name: "师兄", kind: "npc", tags: [], props: { in: "yard", neili: 15, stamina: 80, sword: 8 } },
			{ id: "master", name: "师父", kind: "npc", tags: [], props: { in: "yard", neili: 60, stamina: 100, sword: 45 } },
			{ id: "sword", name: "青锋剑", kind: "item", tags: ["weapon"], props: { in: "yard", grabbable: true, weapon: true } },
			{ id: "pill", name: "金创药", kind: "item", tags: [], props: { in: "player", grabbable: true } },
			{ id: "scroll", name: "心法残页", kind: "item", tags: [], props: { in: "library", grabbable: true } },
		],
	},
	systems: [
		{ id: "recover", run: recover },
	],
	denyAll,
	denialTemplates: {
		reach: (d, w) => d.reason ?? "它不在这里。",
		"meditate.tired": () => "你浑身乏力，实在打坐不下去了。",
		"spar.target": () => "这里没有可切磋的人。",
		"spar.injured": () => "你身上有伤，使不出力道。",
		"travel.dest": (d, w) => `${name(w, d.object ?? "")}？这不是个能去的地方。`,
		"take.grabbable": (d, w) => `${name(w, d.subject ?? "")}拿不起来。`,
		"give.notheld": (d, w) => `${name(w, d.subject ?? "")}不在你的手里。`,
		"give.target": (d, w) => `你无法把东西交给${name(w, d.object ?? "")}。`,
		"denyAll.travel": () => "你站在原地，没有动身。",
		"denyAll.take": (d, w) => `${name(w, d.subject ?? "")}纹丝不动。`,
		"denyAll.give": () => "你把东西递了出去，却没有人在意。",
		"denyAll.meditate": () => "你盘膝坐下，却什么也没有发生。",
		"denyAll.spar": () => "你没有和人切磋。",
	},
	propLabels: PROP_LABELS,
	internalProps: ["actor"],
	validateText: validateWuxiaText,
	summarize: summarizeWuxia,
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	hint: `世界法则（模拟层强制执行）：
1. 门派有三个地点：议事厅（hall）、练武场（yard）、藏经阁（library），用「赶路」前往；你的物品与同处的人都在你身边。
2. 可「拿取」可持握的物品；拿取后可「赠予」给同一地点的师门人物（师兄/师父），赠予会增进对方对你的「信任」。
3. 「打坐」消耗体力增长内力；体力不足时打坐不成。时间流逝会逐渐恢复体力。
4. 「切磋」与同一地点的人比武：胜则剑法精进、对方对你「佩服」加深；败则损耗体力，体力过低会受伤；身上有伤时无法切磋。手持利刃（青锋剑）切磋有加成。
5. 受伤后需要时间养伤，体力恢复到一定程度伤势自愈。`,
};
