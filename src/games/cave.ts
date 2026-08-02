import type { Action, Change, Delta, Denial, GameDef, PropValue, Rule, RuleCtx, RuleResult, Simulation, VerbDef, World } from "../core/sim.ts";
import { D, entity, inTreeReach, inTreeVisible, prop } from "../core/sim.ts";
import { Type } from "typebox";

/** 实体名解析：world 版（拒绝模板用）。 */
function name(w: World, id: string): string {
	return entity(w, id)?.name ?? id;
}

function n(c: RuleCtx, id: string): string {
	return name(c.world, id);
}

/** 动作参数读取：取字符串参数（缺省 ""）。 */
function param(a: Action | null, key: string): string {
	return String(a?.params?.[key] ?? "");
}

/** 可达性拒绝构造：实体不可达时返回结构化拒绝，散文由 GameDef.denialTemplates 渲染。 */
function denyUnreachable(c: RuleCtx, id: string): { granted: false; denial: Denial } | null {
	const acc = inTreeReach(c.world, c.actor, id);
	if (acc.ok) return null;
	return { granted: false, denial: { law: "reach", subject: id, reason: acc.reason } };
}

/** 系统规则结果装配：无变更则不授予；有变更则授予并附 involved/facts/reason。 */
function collectResult(changes: Delta[], involved: Set<string>, facts: { text: string; entities: string[] }[]): RuleResult {
	if (!changes.length) return { granted: false };
	return { granted: true, changes, involved: [...involved], facts, reason: facts.map((f) => f.text).join(" ") };
}

const MATERIAL_LABELS: Record<string, string> = {
	copper: "铜", bone: "骨", wood: "木", iron: "铁", stone: "石", wax: "蜡", steel: "钢", ash: "灰烬",
};

const PROP_LABELS: Record<string, string> = {
	burning: "燃烧状态", lit: "明火", open: "开合", material: "材质", in: "位置",
	attachedTo: "固定", jammed: "卡住", wedgedBy: "楔住", flammable: "可燃性",
};

function summarizeCave(input: { world: World; changes: Change[]; actor: string }): string {
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
	const internal = new Set(sim.def.internalProps ?? []);
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

function hardness(c: RuleCtx, id: string): number {
	const m = String(prop(c.world, id, "material") ?? "");
	return MATERIAL_HARDNESS[m] ?? 0;
}

const wedge: Rule = (c) => {
	const x = param(c.action, "entity");
	const d = param(c.action, "dest");
	if (prop(c.world, x, "wedgeable") !== true) return { granted: false };
	const de = entity(c.world, d);
	if (!de || de.props.isDoor !== true) return { granted: false };
	const un = denyUnreachable(c, x);
	if (un) return un;
	if (de.props.jammed === true) return { granted: false, denial: { law: "wedge.jammed", subject: x, object: d } };
	return {
		granted: true,
		involved: [x, d],
		changes: [
			D.set(d, "jammed", true),
			D.set(d, "wedgedBy", x),
		],
		reason: `你把${n(c, x)}塞进了${n(c, d)}的门缝，门被卡住了。`,
	};
};

const moveLaw: Rule = (c) => {
	const x = param(c.action, "entity");
	const d = param(c.action, "dest");
	const un = denyUnreachable(c, x);
	if (un) return un;
	if (prop(c.world, x, "grabbable") !== true) {
		return { granted: false, denial: { law: "move.grabbable", subject: x } };
	}
	const prevIn = prop(c.world, x, "in") as string | null;
	if (d === c.actor) {
		if (prevIn === c.actor) return { granted: true, involved: [x], reason: `${n(c, x)}已经在你的手中。` };
		if (prop(c.world, x, "attachedTo") != null) {
			return { granted: false, denial: { law: "move.attached", subject: x } };
		}
	} else {
		const de = entity(c.world, d);
		if (!de) return { granted: false, denial: { law: "move.dest", subject: x, object: d } };
		if (de.props.space !== true && de.props.open !== true) {
			if (de.props.openable === true) return { granted: false, denial: { law: "move.closed", subject: x, object: d } };
			return { granted: false, denial: { law: "move.capacity", subject: x, object: d } };
		}
	}
	const changes: Delta[] = [D.set(x, "in", d)];
	const wedgedIn = c.world.entities.find((w) => w.props.wedgedBy === x);
	if (wedgedIn) {
		changes.push(D.del(wedgedIn.id, "jammed"));
		changes.push(D.del(wedgedIn.id, "wedgedBy"));
	}
	const verb = d === c.actor ? "拿起了" : entity(c.world, d)?.props.space === true ? "放到了" : "放进了";
	return { granted: true, involved: wedgedIn ? [x, wedgedIn.id] : [x, d], changes, reason: `你${verb}${n(c, x)}。` };
};

const detach: Rule = (c) => {
	const x = param(c.action, "entity");
	const p = param(c.action, "prop");
	const v = c.action?.params?.value ?? null;
	if (p !== "attachedTo" || v !== null) return { granted: false };
	if (prop(c.world, x, "attachedTo") == null) return { granted: false, denial: { law: "detach.none", subject: x } };
	const un = denyUnreachable(c, x);
	if (un) return un;
	const holder = prop(c.world, x, "attachedTo") as string | null;
	return {
		granted: true,
		involved: holder ? [x, holder] : [x],
		changes: [
			D.set(x, "attachedTo", null),
			D.set(x, "in", c.actor),
			...((holder && holder !== c.actor ? [D.relSet(holder, c.actor, "记忆", true)] : []) as Delta[]),
		],
		reason: `你解下了${n(c, x)}，它落入了你的手中。`,
	};
};

const open: Rule = (c) => {
	const x = param(c.action, "entity");
	const p = param(c.action, "prop");
	const v = c.action?.params?.value ?? null;
	if (p !== "open" || v !== true) return { granted: false };
	if (prop(c.world, x, "openable") !== true) return { granted: false, denial: { law: "open.notopenable", subject: x } };
	if (prop(c.world, x, "open") === true) return { granted: false, denial: { law: "open.already", subject: x } };
	if (prop(c.world, x, "jammed") === true) return { granted: false, denial: { law: "open.jammed", subject: x } };
	return { granted: true, involved: [x], changes: [D.set(x, "open", true)], reason: `你打开了${n(c, x)}。` };
};

const close: Rule = (c) => {
	const x = param(c.action, "entity");
	const p = param(c.action, "prop");
	const v = c.action?.params?.value ?? null;
	if (p !== "open" || v !== false) return { granted: false };
	if (prop(c.world, x, "openable") !== true) return { granted: false };
	if (prop(c.world, x, "open") !== true) return { granted: false, denial: { law: "close.closed", subject: x } };
	return { granted: true, involved: [x], changes: [D.set(x, "open", false)], reason: `你关上了${n(c, x)}。` };
};

const pry: Rule = (c) => {
	const s = param(c.action, "source");
	const t = param(c.action, "target");
	if (prop(c.world, t, "openable") !== true) return { granted: false };
	if (prop(c.world, t, "open") === true) return { granted: false, denial: { law: "pry.open", subject: s, object: t } };
	if (prop(c.world, t, "jammed") === true) return { granted: false, denial: { law: "pry.jammed", subject: s, object: t } };
	if (prop(c.world, s, "lit") === true) return { granted: false };
	if (hardness(c, s) < HARD_MIN) {
		return { granted: false, denial: { law: "pry.soft", subject: s, object: t } };
	}
	if (hardness(c, s) <= hardness(c, t)) {
		return { granted: false, denial: { law: "pry.hardness", subject: s, object: t } };
	}
	const un = denyUnreachable(c, s);
	if (un) return un;
	return {
		granted: true,
		involved: [s, t],
		changes: [D.set(t, "open", true)],
		reason: `你用${n(c, s)}撬开了${n(c, t)}。`,
	};
};

const ignite: Rule = (c) => {
	const s = param(c.action, "source");
	const t = param(c.action, "target");
	if (prop(c.world, s, "lit") !== true) return { granted: false, denial: { law: "ignite.nolight", subject: s, object: t } };
	const un = denyUnreachable(c, t);
	if (un) return un;
	if (prop(c.world, t, "flammable") !== true) return { granted: false, denial: { law: "ignite.notflammable", subject: s, object: t } };
	if (prop(c.world, t, "lightable") === true && prop(c.world, t, "lit") !== true) {
		return { granted: true, involved: [s, t], changes: [D.set(t, "lit", true)], reason: `你点燃了${n(c, t)}。` };
	}
	if (prop(c.world, t, "burning") !== true) {
		return {
			granted: true,
			involved: [s, t],
			changes: [
				D.set(t, "burning", true),
				D.set(t, "lit", true),
			],
			reason: `${n(c, t)}燃起来了！`,
		};
	}
	return { granted: false, denial: { law: "ignite.burning", subject: s, object: t } };
};

const extinguish: Rule = (c) => {
	const x = param(c.action, "entity");
	const p = param(c.action, "prop");
	const v = c.action?.params?.value ?? null;
	if (p !== "lit" || v !== false) return { granted: false };
	if (prop(c.world, x, "lit") !== true) return { granted: false, denial: { law: "extinguish.unlit", subject: x } };
	if (prop(c.world, x, "burning") === true) return { granted: false, denial: { law: "extinguish.burning", subject: x } };
	return { granted: true, involved: [x], changes: [D.set(x, "lit", false)], reason: `你吹灭了${n(c, x)}。` };
};

const denyAll: Rule = (c) => {
	const verb = c.action?.verb ?? "";
	if (verb === "use") {
		return { granted: false, denial: { law: "denyAll.use", subject: param(c.action, "source"), object: param(c.action, "target") } };
	}
	if (verb === "move") {
		return { granted: false, denial: { law: "denyAll.move", subject: param(c.action, "entity"), object: param(c.action, "dest") } };
	}
	return { granted: false, denial: { law: "denyAll.set", subject: param(c.action, "entity"), prop: param(c.action, "prop") } };
};

const kindle: Rule = (c) => {
	const changes: Delta[] = [];
	const facts: { text: string; entities: string[] }[] = [];
	const involved = new Set<string>();
	for (const x of c.world.entities) {
		if (x.props.lit !== true) continue;
		if (x.props.burning === true) continue;
		if (x.props.lightable === true) continue;
		const hostId = x.props["in"] as string | null;
		if (!hostId) continue;
		const host = entity(c.world, hostId);
		if (!host || host.props.flammable !== true) continue;
		if (host.props.burning === true || host.props.lit === true) continue;
		changes.push(D.set(host.id, "burning", true));
		changes.push(D.set(host.id, "lit", true));
		involved.add(x.id);
		involved.add(host.id);
		facts.push({ text: `${x.name}的火焰点燃了${host.name}！`, entities: [x.id, host.id] });
	}
	return collectResult(changes, involved, facts);
};

const spread: Rule = (c) => {
	const changes: Delta[] = [];
	const facts: { text: string; entities: string[] }[] = [];
	const involved = new Set<string>();
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
			changes.push(D.set(t.id, "burning", true));
			changes.push(D.set(t.id, "lit", true));
			involved.add(b.id);
			involved.add(t.id);
			facts.push({ text: `${b.name}的火焰蔓延到了${t.name}！`, entities: [b.id, t.id] });
		}
	}
	return collectResult(changes, involved, facts);
};

const burnout: Rule = (c) => {
	const changes: Delta[] = [];
	const facts: { text: string; entities: string[] }[] = [];
	const involved = new Set<string>();
	for (const b of c.world.entities) {
		if (b.props.burning !== true) continue;
		const t = (b.props.burnTicks as number | null ?? 0) + 1;
		changes.push(D.set(b.id, "burnTicks", t));
		involved.add(b.id);
		if (t >= 3) {
			changes.push(D.set(b.id, "burning", false));
			changes.push(D.set(b.id, "lit", false));
			changes.push(D.set(b.id, "material", "ash"));
			changes.push(D.set(b.id, "flammable", false));
			facts.push({ text: `${b.name}烧成了灰烬。`, entities: [b.id] });
		}
	}
	return collectResult(changes, involved, facts);
};

const STRONG_FIRE_CLAIMS = ["焦烟", "冒烟", "火舌", "烧焦", "烧成灰烬"];
const WEAK_FIRE_CLAIMS = ["燃烧", "点燃", "燃起", "烧起来"];
const HAND_CLAIMS = ["手中", "手上", "掌心", "手里", "握"];
const NEGATIONS = ["未", "没", "无", "不", "别", "休", "尚未", "未曾", "不曾"];
/** 子句边界：名字与断言之间出现这些才算"不相邻"（跨主语误报拦截）。空白不算边界。 */
const PUNCT = /[，。；！？、—]/;

function negatedBefore(s: string, p: number): boolean {
	return NEGATIONS.some((n) => s.slice(Math.max(0, p - 3), p).includes(n));
}

const NEAR_WINDOW = 8;

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

/** 断言词命中扫描：在一个子句里逐词查找断言词，命中且近旁（NEAR_WINDOW 内、无标点隔断）有目标实体即报错。
 *  deAfter 提供断言词紧后接「的」时的实体匹配（如「燃烧的蜡烛」）：命中才报错，未命中则跳过该断言词（不落入近旁匹配，避免「燃烧的锈门」误伤）。 */
function scanClaims(
	s: string,
	claims: readonly string[],
	targets: readonly { name: string }[],
	error: (t: { name: string }) => string,
	deAfter?: (after: string) => { name: string } | null,
): string | null {
	for (const claim of claims) {
		let idx = 0;
		while ((idx = s.indexOf(claim, idx)) !== -1) {
			if (negatedBefore(s, idx)) {
				idx += claim.length;
				continue;
			}
			if (deAfter && s[idx + claim.length] === "的") {
				const after = s.slice(idx + claim.length + 1, idx + claim.length + 4);
				const hit = deAfter(after);
				if (hit) return error(hit);
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

export function validateCaveText(input: { text: string; world: World; changes: Change[]; actor: string; pending: Change[] }): string | null {
	const { text, world, actor, pending } = input;
	const aboutToBurn = new Set(pending.filter((c) => c.prop === "burning" && c.to === true).map((c) => c.entity));
	const isFire = (id: string) =>
		prop(world, id, "lit") === true || prop(world, id, "burning") === true || prop(world, id, "material") === "ash";
	const isHeld = (id: string) => prop(world, id, "in") === actor;
	// STRONG 断言（焦烟/烧成灰烬等）只对「当前已燃」成立，不受 pending 豁免——下一 tick 不可能烧成灰烬
	const nonFire = world.entities.filter((e) => e.id !== actor && e.props.space !== true && !isFire(e.id));
	// WEAK 断言（燃烧/点燃等）可覆盖「即将燃」的实体（合法预言）
	const nonFireWeak = world.entities.filter((e) => e.id !== actor && e.props.space !== true && !isFire(e.id) && !aboutToBurn.has(e.id));
	const nonHeld = world.entities.filter((e) => e.id !== actor && e.props.space !== true && e.props.grabbable === true && !isHeld(e.id));
	const fireError = (t: { name: string }) => `描述虚构了「${t.name}」的燃烧/点燃/烧焦，但当前状态并非如此。`;
	const handError = (t: { name: string }) => `描述虚构了「${t.name}」在你手中，但当前它不在你这里。`;

	for (const s of text.split(/[。！？!?；;]/)) {
		const strong = scanClaims(s, STRONG_FIRE_CLAIMS, nonFire, fireError);
		if (strong) return strong;
		const weak = scanClaims(s, WEAK_FIRE_CLAIMS, nonFireWeak, fireError, (after) => {
			return nonFireWeak.find((e) => after.startsWith(e.name)) ?? null;
		});
		if (weak) return weak;
		const hand = scanClaims(s, HAND_CLAIMS, nonHeld, handError);
		if (hand) return hand;
	}
	return null;
}

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
	rules: [wedge, moveLaw],
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
	rules: [pry, ignite],
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
	rules: [detach, open, close, extinguish],
};

export const cave: GameDef = {
	id: "cave",
	title: "地窖（法则引擎）",
	playerId: "player",
	verbs: {
		move: moveVerb,
		use: useVerb,
		set: setVerb,
	},
	world: {
		time: 0,
		entities: [
			{ id: "cave", name: "地窖", kind: "space", tags: ["room"], props: { space: true } },
			{ id: "player", name: "你", kind: "actor", tags: [], props: { actor: true, in: "cave" } },
			{ id: "ring", name: "铜戒", kind: "item", tags: ["metal"], props: { in: "skeleton", attachedTo: "skeleton", material: "copper", grabbable: true } },
			{ id: "skeleton", name: "骷髅", kind: "corpse", tags: [], props: { in: "cave", material: "bone" } },
			{ id: "torch", name: "火把", kind: "item", tags: ["flammable", "light"], props: { in: "cave", material: "wood", flammable: true, lit: true, grabbable: true } },
			{ id: "candle", name: "蜡烛", kind: "item", tags: ["flammable", "lightable", "wedgeable"], props: { in: "chest", material: "wax", flammable: true, grabbable: true, wedgeable: true, lightable: true, lit: false } },
			{ id: "chest", name: "木箱", kind: "container", tags: ["wood"], props: { in: "cave", material: "wood", flammable: true, openable: true, open: false, container: true } },
			{ id: "door", name: "石门", kind: "door", tags: ["stone"], props: { in: "cave", material: "stone", openable: true, open: false, isDoor: true } },
			{ id: "crowbar", name: "铁钎", kind: "item", tags: ["metal"], props: { in: "cave", material: "iron", grabbable: true } },
		],
	},
	systems: [
		{ id: "kindle", run: kindle },
		{ id: "spread", run: spread },
		{ id: "burnout", run: burnout },
	],
	denyAll,
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
		"denyAll.set": (d, w) => {
			const subj = name(w, d.subject ?? "");
			const label = PROP_LABELS[d.prop ?? ""];
			return label ? `你试着改变${subj}的${label}，但它没有任何变化。` : `你试着改变${subj}，但它没有任何变化。`;
		},
	},
	propLabels: PROP_LABELS,
	internalProps: ["actor", "burnTicks"],
	validateText: validateCaveText,
	summarize: summarizeCave,
	digest: digestCave,
	grounding: (world, actor) => [...inTreeVisible(world, actor)],
	hint: `世界法则（模拟层强制执行）：
1. 火源（lit=true）作用于可燃物（flammable=true）：可点燃蜡烛（lightable=true，点燃后 lit=true），或让普通可燃物燃烧（burning=true）；燃烧会随时间蔓延到同处或容器内的可燃物，并最终烧成灰烬（material=ash）。
2. 燃着的火（lit 且非蜡烛类）放进可燃容器，容器会被引燃（如把火把放进木箱）。
3. 可开启物（openable=true）可被打开/关闭；被卡住（jammed=true）时打不开。
4. 物品可被拿起（move 到玩家）、放下（move 到场景）、放入（move 到打开的容器）、解下（把 attachedTo 设为 null）。
5. 硬物（iron/steel 材质，如铁钎）可撬开比它软的可开启物（如木箱）；撬不动比它硬的（石门是 stone）。`,
};
