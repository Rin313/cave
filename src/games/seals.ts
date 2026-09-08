import type { Delta, Fact, GameDef, PropDef, Q, ViewValue, World } from "../core/sim.ts";
import { D, defineVerb, deny, entity, free, grant, ref, relVal } from "../core/sim.ts";
import { enclosingSpace, hostOf, inTreeVisible } from "./space.ts";
import { Type } from "typebox";

const SEALS_PROPS: Record<string, PropDef> = {
	kind: { type: "string", label: "类别" },
	in: { type: "id", label: "持者" },
	space: { type: "boolean", label: "场景" },
	seal: { type: "boolean", label: "火漆" },
	sender: { type: "id", label: "寄信人" },
	recipient: { type: "id", label: "收信人" },
	// 展品：信文只对知晓者可感（属性感知槽）
	content: { type: "string", label: "信文" },
	// 展品：known 生命周期（对话获名，internal 不进视图、并入参照域）
	introduced: { type: "boolean", internal: true },
	// 展品：主体性（hostOf 键控、魂不可自见）
	vessel: { type: "boolean", internal: true },
	mask: { type: "boolean", label: "面具" },
	heard: { type: "string", label: "闻言" },
	// 展品：id 数组（强引用挡 despawn）
	manifest: { type: "id", label: "收发清单" },
};

const nameOf = (w: World, id: string): string => entity(w, id)?.name ?? id;

const isLetter = (q: Q, id: string) => {
	const t = entity(q.world, id);
	return t && t.props.kind === "letter" ? t : null;
};

/** 无主语动词的缺省主语：居所链最近宿主。 */
const host = (q: Q): string => hostOf(q.world, q.player);

const manifestOf = (q: Q): string[] => {
	const m = entity(q.world, "desk")?.props.manifest;
	return Array.isArray(m) ? [...m] as string[] : [];
};

/** 强引用宇宙单源于注册表声明（type:"id" 含数组值）；边是弱引用，随主消散。 */
const referenced = (q: Q, id: string): string | null => {
	for (const e of q.world.entities) {
		for (const [k, pd] of Object.entries(SEALS_PROPS)) {
			if (pd.type !== "id") continue;
			const v = e.props[k];
			if (v === id || (Array.isArray(v) && v.includes(id))) return e.id;
		}
	}
	return null;
};

/** 桶级披露：非账本的聚合纹理。 */
function extraOf(world: World, player: string): Record<string, ViewValue> {
	const name = (id: string): string => nameOf(world, id);
	const affinity: string[] = [];
	const seen = new Set<string>();
	for (const r of world.relations) {
		if (r.type !== "信任" || !(Number(r.value ?? 0) >= 2)) continue;
		const key = [r.from, r.to].sort().join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		affinity.push(`${name(r.from)}与${name(r.to)}过从甚密`);
	}
	const suspicion = world.relations
		.filter((r) => r.type === "猜疑" && r.to === hostOf(world, player) && Number(r.value ?? 0) >= 1)
		.map((r) => name(r.from));
	const out: Record<string, ViewValue> = {};
	if (affinity.length) out["交际"] = affinity;
	if (suspicion.length) out["对你的疑心"] = suspicion;
	return out;
}

export const seals: GameDef = {
	id: "seals",
	title: "封缄·宅邸夜（统一探针）",
	playerId: "player",
	recentWindow: 6,
	messages: {
		noResponse: "无人应答。",
		invisibleEntity: "眼前没有那样的东西。",
		defaultReason: "……",
		timePassed: "光阴虚度",
	},
	verbs: {
		take: defineVerb({
			label: "拿取",
			description: "把书案上的一封信拿到手里（持者是你的躯体，清单随之销账）。",
			schema: Type.Object({ entity: ref("信件 id") }),
			rules: [{
				id: "desk",
				judge: (q, p) => {
					const t = isLetter(q, p.entity);
					if (!t) return deny("take.notletter", { reason: "那不是能拿的信。" });
					if (t.props.in !== "desk") return deny("take.notondesk", { reason: "那封信不在书案上。" });
					return grant(
						[D.set(p.entity, "in", host(q)), D.set("desk", "manifest", (() => { const r = manifestOf(q).filter((x) => x !== p.entity); return r.length ? r : null; })())],
						`你把${nameOf(q.world, p.entity)}拿到了手里。`,
					);
				},
			}],
		}),
		read: defineVerb({
			label: "拆读",
			description: "细读手里的一封信：拆封会留下断口，信文自此为你所知。",
			schema: Type.Object({ entity: ref("信件 id") }),
			rules: [{
				id: "held",
				judge: (q, p) => {
					const t = isLetter(q, p.entity);
					if (!t) return deny("read.notletter", { reason: "那不是能读的信。" });
					if (t.props.in !== host(q)) return deny("read.notheld", { reason: "你得先把信拿到手里。" });
					const deltas: Delta[] = [];
					if (t.props.seal === true) deltas.push(D.set(p.entity, "seal", false));
					if (relVal(q.world, q.player, p.entity, "知晓") === null) deltas.push(D.relSet(q.player, p.entity, "知晓", true));
					if (!deltas.length) return grant([], `你把${nameOf(q.world, p.entity)}又读了一遍，字句没有变。`);
					return grant(deltas, `你展信细读：${String(t.props.content ?? "")}`);
				},
			}],
		}),
		forge: defineVerb({
			label: "誊写",
			description: "借着拆封的工夫重写手里这封信的信文（text 为新信文全文）——断口无法掩饰。",
			schema: Type.Object({
				entity: ref("信件 id"),
				text: free("新信文全文"),
			}),
			rules: [{
				id: "held",
				judge: (q, p) => {
					const t = isLetter(q, p.entity);
					if (!t) return deny("forge.notletter", { reason: "那不是能改的信。" });
					if (t.props.in !== host(q)) return deny("forge.notheld", { reason: "你得先把信拿到手里。" });
					const text = p.text.trim();
					if (!text) return deny("forge.blank", { reason: "信文不能是空的。" });
					return grant(
						[D.set(p.entity, "seal", false), D.set(p.entity, "content", text), D.relSet(q.player, p.entity, "知晓", true)],
						"你借着拆封的工夫，重新誊写了信文。",
					);
				},
			}],
		}),
		leave: defineVerb({
			label: "放回",
			description: "把手里的一封信放回书案（信件将照常送抵收信人）。",
			schema: Type.Object({ entity: ref("信件 id") }),
			rules: [{
				id: "held",
				judge: (q, p) => {
					const t = isLetter(q, p.entity);
					if (!t) return deny("leave.notletter", { reason: "那不是信。" });
					if (t.props.in !== host(q)) return deny("leave.notheld", { reason: "那封信不在你手里。" });
					return grant(
						[D.set(p.entity, "in", "desk"), D.set("desk", "manifest", [...manifestOf(q), p.entity])],
						`你把${nameOf(q.world, p.entity)}放回了书案。`,
					);
				},
			}],
		}),
		talk: defineVerb({
			label: "攀谈",
			description: "与眼前的人说一句话（words 为原话）——话语留在对方那里，成为世界里的惰性记录。",
			schema: Type.Object({
				target: ref("交谈对象 id"),
				words: free("要说的话"),
			}),
			rules: [{
				id: "person",
				judge: (q, p) => {
					const t = entity(q.world, p.target);
					if (!t || t.props.kind !== "person") return deny("talk.notperson", { reason: "那不是能交谈的人。" });
					const words = p.words.trim();
					if (!words) return deny("talk.blank", { reason: "话不能是空的。" });
					return grant(
						[D.set(p.target, "heard", words), ...(t.props.introduced !== true ? [D.set(p.target, "introduced", true)] : [])],
						`你与${nameOf(q.world, p.target)}攀谈了一句。`,
					);
				},
			}],
		}),
		unmask: defineVerb({
			label: "揭面",
			description: "揭下一位戴面具者的面具。",
			schema: Type.Object({ target: ref("对方 id") }),
			rules: [{
				id: "masked",
				judge: (q, p) => {
					const t = entity(q.world, p.target);
					if (!t || t.props.mask !== true) return deny("unmask.nomask", { reason: "那人没有戴面具。" });
					return grant([D.rename(p.target, "沈青"), D.set(p.target, "mask", false)], "你揭下了面具。");
				},
			}],
		}),
		go: defineVerb({
			label: "走动",
			description: "沿廊走向另一个房间（dest 为地点 id，见关系路径）。走动耗一刻。",
			schema: Type.Object({ dest: ref("目的地 id") }),
			cost: 1,
			rules: [{
				id: "path",
				judge: (q, p) => {
					const d = entity(q.world, p.dest);
					if (!d || d.props.space !== true) return deny("go.noplace", { reason: "那里不是能去的地方。" });
					const here = enclosingSpace(q.world, host(q));
					if (here === null) return deny("go.noway", { reason: "你无处可去。" });
					if (here === p.dest) return deny("go.here", { reason: `你已经身在${nameOf(q.world, p.dest)}。` });
					if (relVal(q.world, here, p.dest, "path") === null) return deny("go.noway", { reason: `从这里没有路通往${nameOf(q.world, p.dest)}。` });
					return grant([D.set(host(q), "in", p.dest)], `你走向${nameOf(q.world, p.dest)}。`);
				},
			}],
		}),
		channel: defineVerb({
			label: "附身",
			description: "把神魂迁入一件能容魂的器皿（占据＝居所的迁移，一条 delta 过门）。",
			schema: Type.Object({ entity: ref("器皿 id") }),
			rules: [{
				id: "vessel",
				judge: (q, p) => {
					const t = entity(q.world, p.entity);
					if (!t || t.props.vessel !== true) return deny("channel.notvessel", { reason: "那不是能容魂的东西。" });
					if (p.entity === host(q)) return deny("channel.self", { reason: "你已经居于其中。" });
					return grant([D.set(q.player, "in", p.entity)], `你的神魂没入${nameOf(q.world, p.entity)}。`);
				},
			}],
		}),
		burn: defineVerb({
			label: "掷火",
			description: "把一样东西掷进火盆（还系着它的东西得先解开：账上的、盛着的、挂在身上的）。",
			schema: Type.Object({ entity: ref("目标 id") }),
			rules: [{
				id: "tied",
				judge: (q, p) => {
					const t = entity(q.world, p.entity);
					if (!t) return deny("burn.gone", { reason: "那里已经什么都没有了。" });
					const ref = referenced(q, p.entity);
					if (ref) return deny("burn.tied", { reason: `${nameOf(q.world, ref)}还系着${nameOf(q.world, p.entity)}，解开了才烧得掉。` });
					return grant([D.despawn(p.entity)], `你把${nameOf(q.world, p.entity)}掷进了火盆。`);
				},
			}],
		}),
		divine: defineVerb({
			label: "占问",
			description: "把一枚铜钱掷进火盆，看这一问的吉凶。",
			schema: Type.Object({}),
			rules: [{
				id: "lot",
				judge: (q) => grant([], `铜钱落进灰里：${q.roll("lot", 2) === 1 ? "吉" : "凶"}。`),
			}],
		}),
		wait: defineVerb({
			label: "等候",
			description: "在廊下站着：说等多久（span 为刻数，1–12，缺省一刻）。",
			schema: Type.Object({ span: Type.Optional(Type.Number({ description: "刻数（1–12），缺省一刻" })) }),
			rules: [{
				id: "pass",
				judge: (_q, p) => {
					const span = p.span ?? 1;
					if (!Number.isInteger(span)) return deny("wait.span", { reason: "时间以刻计，没有半刻。" });
					if (span < 1) return deny("wait.span", { reason: "那不算等候。" });
					if (span > 12) return deny("wait.span", { reason: "你等不了那么久。" });
					return grant([], span >= 4 ? "你在廊下站了好一阵子。" : "你静静站了一会儿。", undefined, span);
				},
			}],
		}),
	},
	world: {
		time: 0,
		entities: [
			{ id: "player", name: "心神", props: { kind: "soul", in: "courier" } },
			{ id: "courier", name: "信使", props: { kind: "person", vessel: true, in: "parlor" } },
			{ id: "magistrate", name: "太守", props: { kind: "person", in: "parlor" } },
			{ id: "steward", name: "管家", props: { kind: "person", in: "parlor" } },
			{ id: "merchant", name: "盐商", props: { kind: "person", in: "parlor" } },
			{ id: "guest", name: "灰衣人", props: { kind: "person", mask: true, in: "study" } },
			{ id: "mask", name: "白瓷面具", props: { kind: "thing", vessel: true, in: "parlor" } },
			{ id: "parlor", name: "正厅", props: { kind: "room", space: true } },
			{ id: "study", name: "书房", props: { kind: "room", space: true } },
			{ id: "court", name: "庭院", props: { kind: "room", space: true } },
			{ id: "desk", name: "书案", props: { kind: "desk", manifest: ["letter_salt", "letter_grain"], in: "parlor" } },
			{ id: "letter_salt", name: "火漆信·盐引", props: { kind: "letter", in: "desk", seal: true, sender: "merchant", recipient: "magistrate", content: "盐引批文已托江苏会馆代办，事成之后，岁贡三成分润。" } },
			{ id: "letter_grain", name: "火漆信·粮价", props: { kind: "letter", in: "desk", seal: true, sender: "magistrate", recipient: "merchant", content: "秋粮定价每石四百钱，勿为流言所动。" } },
		],
		relations: [
			{ from: "parlor", to: "study", type: "path", value: true },
			{ from: "study", to: "parlor", type: "path", value: true },
			{ from: "magistrate", to: "merchant", type: "信任", value: 2 },
			{ from: "magistrate", to: "steward", type: "信任", value: 3 },
			{ from: "merchant", to: "steward", type: "信任", value: 1 },
		],
	},
	systems: [
		{
			id: "post.deliver",
			run: (q) => {
				if (q.time % 4 !== 0) return null;
				const manifest = manifestOf(q);
				if (!manifest.length) return null;
				const deltas: Delta[] = [];
				const facts: Fact[] = [];
				let rest = manifest;
				// 猜疑按收信人聚合为一次写：同址叠加增量按序覆盖
				const suspicion = new Map<string, number>();
				for (const id of manifest) {
					const l = entity(q.world, id);
					if (!l || l.props.in !== "desk") continue;
					const rid = String(l.props.recipient ?? "");
					const to = entity(q.world, rid);
					if (!to) continue;
					const tampered = l.props.seal !== true;
					deltas.push(D.set(id, "in", rid), D.set(id, "seal", false), D.relSet(rid, id, "知晓", true));
					rest = rest.filter((x) => x !== id);
					deltas.push(D.set("desk", "manifest", rest.length ? rest : null));
					if (tampered) {
						suspicion.set(rid, (suspicion.get(rid) ?? 0) + 1);
						facts.push(`${to.name}收了${nameOf(q.world, id)}。断口的火漆瞒不过人，${to.name}的目光落在你身上。`);
					} else {
						facts.push(`${to.name}收了${nameOf(q.world, id)}，拆封读毕。`);
					}
				}
				for (const [rid, n] of suspicion) {
					const prev = Number(relVal(q.world, rid, host(q), "猜疑") ?? 0);
					deltas.push(D.relSet(rid, host(q), "猜疑", prev + n));
				}
				return deltas.length ? { deltas, facts } : null;
			},
		},
		{
			id: "post.arrive",
			run: (q) => {
				if (q.time !== 5 || entity(q.world, "letter_night")) return null;
				return {
					deltas: [
						D.spawn({ id: "letter_night", name: "夜笺", props: { kind: "letter", in: "desk", seal: true, sender: "guest", recipient: "steward", content: "老渠道走水，下月起改陆。引子照旧，勿复书。" } }),
						D.set("desk", "manifest", [...manifestOf(q), "letter_night"]),
					],
					facts: ["又有一封夜笺送到，搁在书案上。"],
				};
			},
		},
		{
			id: "salon.gossip",
			run: (q) => {
				if (q.time % 4 !== 2) return null;
				let best: { from: string; to: string; v: number } | null = null;
				for (const r of q.world.relations) {
					if (r.type !== "信任" || r.from === q.player || r.to === q.player) continue;
					const v = Number(r.value ?? 0);
					if (!best || v > best.v) best = { from: r.from, to: r.to, v };
				}
				if (!best || best.v < 2) return null;
				return { deltas: [], facts: [`你瞥见${nameOf(q.world, best.from)}与${nameOf(q.world, best.to)}在廊下低语，谈了许久。`] };
			},
		},
		{
			id: "guest.drift",
			run: (q) => {
				const g = entity(q.world, "guest");
				if (!g) return null;
				if (q.time % 8 === 6 && g.props.in === "study") {
					return {
						deltas: [D.set("guest", "in", "parlor"), D.relSet("guest", "steward", "信任", Number(relVal(q.world, "guest", "steward", "信任") ?? 0) + 1)],
						facts: ["灰衣人踱进了正厅，与管家寒暄。"],
					};
				}
				if (q.time % 8 === 2 && g.props.in === "parlor") {
					return { deltas: [D.set("guest", "in", "study")], facts: [`${nameOf(q.world, "guest")}携着酒盏，踱回了书房。`] };
				}
				return null;
			},
		},
	],
	props: SEALS_PROPS,
	voice: `你以白描与留白写这一夜：宅邸的灯、火盆、火漆与低语。短句，重感官，克制；不解释人物的内心，让断口与沉默自己说话。称呼玩家为「你」。`,
	// 社会真相只经桶级披露与法则代笔流动（被测通道）
	edgePerception: () => (r) => r.type !== "信任" && r.type !== "猜疑" && r.type !== "知晓",
	// 信文只对知晓者可感（判据 = 知晓边）
	propPerception: (world, player) => (e, prop) => prop !== "content" || relVal(world, player, e.id, "知晓") !== null,
	// 视角锚 = hostOf；魂不可自见
	grounding: (world, player) => {
		const vis = inTreeVisible(world, hostOf(world, player));
		vis.delete(player);
		for (const e of world.entities) if (e.props.introduced === true) vis.add(e.id);
		return [...vis];
	},
	digestExtra: extraOf,
};
