import type { Core } from "../../src/core/games.ts";
import type { Delta, Entity, FieldView, GameDef, Q, SlotDef, Text, ViewValue, World } from "../../src/core/sim.ts";
import { space } from "./space.ts";

/** 心神（玩家）的 id；视角以它为锚。 */
const SOUL = "player";

const PROPS: Record<string, SlotDef> = {
	name: { type: "string" },
	kind: { type: "string", label: "类别" },
	in: { type: "ref", strong: true, label: "持者" },
	space: { type: "boolean", label: "场景" },
	vessel: { type: "boolean", label: "容魂" },
	mask: { type: "boolean", label: "面具" },
	trueName: { type: "string" },
	seal: { type: "boolean", label: "火漆" },
	content: { type: "string", label: "信文" },
	sender: { type: "ref", strong: true, label: "寄信人" },
	recipient: { type: "ref", strong: true, label: "收信人" },
	introduced: { type: "boolean" },
};

const des = (e: Entity): string => (typeof e.props.name === "string" && e.props.name !== "" ? e.props.name : e.id);

const SYSTEM = `你以白描与留白写这一夜：宅邸的灯、火盆、火漆与低语。短句，重感官，克制；不解释人物的内心，让断口与沉默自己说话。称呼玩家为「你」。

Parse the player's operational intent into action proposals and submit them via the act tool. act allows exactly one adjudication window per turn; once a proposal enters adjudication, no further act calls are accepted this turn. A call rejected by static form checks does not occupy the window; fix the reported violations and resubmit. If you can form a legal proposal (the verb carries the intent, referential params take ids of visible or known entities), submit actions; submit as usual even if you expect the world to deny it — whether the intent is reasonable is adjudicated by world laws, not by you. If you cannot form a legal proposal, submit empty actions (an empty proposal is a refusal; write no rationale); do not force verbs that cannot carry the intent or unrelated entities. After act returns the world's adjudication results, write the turn as literary prose for the player based on them.
Rendering calls (opening scenes, scene descriptions after time passes) have no action window: such prompts are headed "[Rendering service]"; do not call act, write the prose text directly. A prompt may open with recent world results (player utterances and the world's skeletal responses) for reference and continuation.
World notes: the world state is the slice visible to you; what is not in it cannot be referred to. entities lists every visible entity (props is a list of named values); relations lists the visible relation edges (from/to are entity ids, name is the relation name); known, when present, lists entities you know of but cannot see (id and name) — referential params may take their ids. id is the unique identifier, name is the display name. extra, when present, is game-derived scene texture. The act tool lists the available verbs with their parameters and costs; reference params must take ids of visible or known entities.

Expression discipline:
- Narration may only follow the adjudication results returned by act (attempts, changes, law replies and statements, newly visible entities) and the entities and properties in the world state.
- Objects, people, phenomena, and consequences absent from the state and the adjudication must not appear — consequences are produced by world laws, not invented by you; transcribing and rendering existing content (wording, perspective, atmosphere, literary devices) is entirely free, as long as it does not contradict the state.
- Always refer to entities by name; never expose entity ids, property names, tool calls, or the decision process.
- For a denied attempt, write only the attempt itself and the world's denial reason; never write consequences that did not happen.`;

export default (core: Core): GameDef => {
	const { D, defineVerb, deny, entity, grant, param, relVal } = core;
	const { enclosingSpace, hostOf, inTreeVisible } = space(core);

	const nameOf = (world: World, id: string): string => {
		const e = entity(world, id);
		return e ? des(e) : id;
	};

	const letterOf = (world: World, id: string): Entity | null => {
		const e = entity(world, id);
		return e && e.props.kind === "letter" ? e : null;
	};

	/** 动词的默认主语：心神居所链上最近的器皿。 */
	const body = (q: Q): string => hostOf(q.world, SOUL);

	/** 强引用反查：谁在某属性里指向 id（掷火的世界腔拒绝要指认系者）。 */
	const tiedTo = (q: Q, id: string): string | null => {
		for (const e of q.world.entities) {
			for (const [k, d] of Object.entries(PROPS)) {
				if (d.type !== "ref") continue;
				const v = e.props[k];
				if (v === id || (Array.isArray(v) && v.includes(id))) return e.id;
			}
		}
		return null;
	};

	/** 可见域：心神所居之处的围合；心神自身不在视野里（魂不可自见）。 */
	const visible = (world: World): Set<string> => {
		const vis = inTreeVisible(world, hostOf(world, SOUL));
		vis.delete(SOUL);
		return vis;
	};

	/** view 增补：把无名边聚成人话（信任 ≥2 打成「过从甚密」，指向心神的猜疑打成「对你的疑心」）。 */
	const extraOf = (world: World, field: FieldView): Record<string, ViewValue> => {
		const name = (id: string): string => field.name({ cell: "vertex", id });
		const affinity: string[] = [];
		const pairs = new Set<string>();
		for (const r of world.relations) {
			if (r.type !== "信任" || Number(r.value ?? 0) < 2) continue;
			const key = [r.from, r.to].sort().join("|");
			if (pairs.has(key)) continue;
			pairs.add(key);
			affinity.push(`${name(r.from)}与${name(r.to)}过从甚密`);
		}
		const suspicion = world.relations
			.filter((r) => r.type === "猜疑" && r.to === hostOf(world, SOUL) && Number(r.value ?? 0) >= 1)
			.map((r) => name(r.from));
		const out: Record<string, ViewValue> = {};
		if (affinity.length) out["交际"] = affinity;
		if (suspicion.length) out["对你的疑心"] = suspicion;
		return out;
	};

	return {
		recentWindow: 6,
		messages: {
			noResponse: "无人应答。",
			invisibleEntity: "眼前没有那样的东西。",
			timePassed: "光阴虚度",
		},
		verbs: {
			take: defineVerb({
				label: "拿取",
				description: "把书案上的一封或多封信拿到手里。",
				params: { entities: param("ref", { many: true, description: "信件 id，一封或多封" }) },
				cost: 0,
				rules: [{
					id: "desk",
					judge: (q) => {
						for (const id of q.params.entities) {
							const t = letterOf(q.world, id);
							if (!t) return deny("take.notletter", "那不是能拿的信。");
							if (t.props.in !== "desk") return deny("take.notondesk", "那封信不在书案上。");
						}
						const names = q.params.entities.map((id) => nameOf(q.world, id)).join("、");
						return grant(q.params.entities.map((id) => D.set(id, "in", body(q))), { reply: `你把${names}拿到了手里。` });
					},
				}],
			}),
			read: defineVerb({
				label: "拆读",
				description: "细读手里的一封信：拆封会留下断口，信文自此为你所知。",
				params: { entity: param("ref", { description: "信件 id" }) },
				cost: 0,
				rules: [{
					id: "held",
					judge: (q) => {
						const t = letterOf(q.world, q.params.entity);
						if (!t) return deny("read.notletter", "那不是能读的信。");
						if (t.props.in !== body(q)) return deny("read.notheld", "你得先把信拿到手里。");
						const deltas: Delta[] = [];
						if (t.props.seal === true) deltas.push(D.set(q.params.entity, "seal", false));
						if (relVal(q.world, SOUL, q.params.entity, "知晓") === null) deltas.push(D.relSet(SOUL, q.params.entity, "知晓", true));
						if (!deltas.length) return grant([], { reply: `你把${nameOf(q.world, q.params.entity)}又读了一遍，字句没有变。` });
						return grant(deltas, { reply: `你展信细读：${String(t.props.content ?? "")}` });
					},
				}],
			}),
			forge: defineVerb({
				label: "誊写",
				description: "借着拆封的工夫重写手里这封信的信文（text 为新信文全文）——断口无法掩饰。",
				params: { entity: param("ref", { description: "信件 id" }), text: param("string", { description: "新信文全文" }) },
				cost: 0,
				rules: [{
					id: "held",
					judge: (q) => {
						const t = letterOf(q.world, q.params.entity);
						if (!t) return deny("forge.notletter", "那不是能改的信。");
						if (t.props.in !== body(q)) return deny("forge.notheld", "你得先把信拿到手里。");
						const text = q.params.text.trim();
						if (!text) return deny("forge.blank", "信文不能是空的。");
						return grant(
							[D.set(q.params.entity, "seal", false), D.set(q.params.entity, "content", text), D.relSet(SOUL, q.params.entity, "知晓", true)],
							{ reply: "你借着拆封的工夫，重新誊写了信文。" },
						);
					},
				}],
			}),
			leave: defineVerb({
				label: "放回",
				description: "把手里的一封信放回书案（信件将照常送抵收信人）。",
				params: { entity: param("ref", { description: "信件 id" }) },
				cost: 0,
				rules: [{
					id: "held",
					judge: (q) => {
						const t = letterOf(q.world, q.params.entity);
						if (!t) return deny("leave.notletter", "那不是信。");
						if (t.props.in !== body(q)) return deny("leave.notheld", "那封信不在你手里。");
						return grant([D.set(q.params.entity, "in", "desk")], { reply: `你把${nameOf(q.world, q.params.entity)}放回了书案。` });
					},
				}],
			}),
			talk: defineVerb({
				label: "攀谈",
				description: "与眼前的人说一句话（words 为要说的话）。",
				params: {
					target: param("ref", { description: "交谈对象 id" }),
					words: param("string", { description: "要说的话" }),
				},
				cost: 0,
				invisible: "眼前没有这个人。",
				rules: [{
					id: "person",
					judge: (q) => {
						const t = entity(q.world, q.params.target);
						if (!t || t.props.kind !== "person") return deny("talk.notperson", "那不是能交谈的人。");
						if (!q.params.words.trim()) return deny("talk.blank", "话不能是空的。");
						const deltas = t.props.introduced === true ? [] : [D.set(q.params.target, "introduced", true)];
						return grant(deltas, { reply: `你与${nameOf(q.world, q.params.target)}攀谈了一句。` });
					},
				}],
			}),
			unmask: defineVerb({
				label: "揭面",
				description: "揭下一位戴面具者的面具；真名会取代平日的称呼。",
				params: { target: param("ref", { description: "对方 id" }) },
				cost: 0,
				rules: [{
					id: "masked",
					judge: (q) => {
						const t = entity(q.world, q.params.target);
						if (!t || t.props.mask !== true) return deny("unmask.nomask", "那人没有戴面具。");
						const trueName = t.props.trueName;
						const reveal = typeof trueName === "string" && trueName !== "" ? trueName : null;
						return grant([...(reveal !== null ? [D.set(q.params.target, "name", reveal)] : []), D.set(q.params.target, "mask", false)], { reply: "你揭下了面具。" });
					},
				}],
			}),
			go: defineVerb({
				label: "走动",
				description: "沿廊走向另一个房间（dest 为地点 id）。走动耗一刻。",
				params: { dest: param("ref", { description: "目的地 id" }) },
				cost: 1,
				rules: [{
					id: "path",
					judge: (q) => {
						const d = entity(q.world, q.params.dest);
						if (!d || d.props.space !== true) return deny("go.noplace", "那里不是能去的地方。");
						const here = enclosingSpace(q.world, body(q));
						if (here === null) return deny("go.noway", "你无处可去。");
						if (here === q.params.dest) return deny("go.here", `你已经身在${nameOf(q.world, q.params.dest)}。`);
						if (relVal(q.world, here, q.params.dest, "path") === null) return deny("go.noway", `从这里没有路通往${nameOf(q.world, q.params.dest)}。`);
						return grant([D.set(body(q), "in", q.params.dest)], { reply: `你走向${nameOf(q.world, q.params.dest)}。` });
					},
				}],
			}),
			channel: defineVerb({
				label: "附身",
				description: "把神魂迁入一件能容魂的器皿（占据即居所的迁移）。",
				params: { entity: param("ref", { description: "器皿 id" }) },
				cost: 0,
				rules: [{
					id: "vessel",
					judge: (q) => {
						const t = entity(q.world, q.params.entity);
						if (!t || t.props.vessel !== true) return deny("channel.notvessel", "那不是能容魂的东西。");
						if (q.params.entity === body(q)) return deny("channel.self", "你已经居于其中。");
						return grant([D.set(SOUL, "in", q.params.entity)], { reply: `你的神魂没入${nameOf(q.world, q.params.entity)}。` });
					},
				}],
			}),
			burn: defineVerb({
				label: "掷火",
				description: "把一样或几样东西掷进火盆（被信或魂系着的东西，得先解开）。",
				params: { entities: param("ref", { many: true, description: "目标 id，一样或几样" }) },
				cost: 0,
				rules: [{
					id: "tied",
					judge: (q) => {
						for (const id of q.params.entities) {
							const ref = tiedTo(q, id);
							if (ref) return deny("burn.tied", `${nameOf(q.world, ref)}还系着${nameOf(q.world, id)}，解开了才烧得掉。`);
						}
						const names = q.params.entities.map((id) => nameOf(q.world, id)).join("、");
						return grant(q.params.entities.map((id) => D.despawn(id)), { reply: `你把${names}掷进了火盆。` });
					},
				}],
			}),
			divine: defineVerb({
				label: "占问",
				description: "把一枚铜钱掷进火盆，看这一问的吉凶。",
				params: {},
				cost: 0,
				rules: [{
					id: "lot",
					judge: (q) => grant([], { reply: `铜钱落进灰里：${q.roll("lot", 2) === 1 ? "吉" : "凶"}。` }),
				}],
			}),
			wait: defineVerb({
				label: "等候",
				description: "在廊下站着：说等多久（span 为刻数，1–12，缺省一刻）。",
				params: { span: param("number", { optional: true, description: "刻数（1–12），缺省一刻" }) },
				cost: 0,
				rules: [{
					id: "pass",
					judge: (q) => {
						const span = q.params.span ?? 1;
						if (!Number.isInteger(span)) return deny("wait.span", "时间以刻计，没有半刻。");
						if (span < 1) return deny("wait.span", "那不算等候。");
						if (span > 12) return deny("wait.span", "你等不了那么久。");
						return grant([], { reply: span >= 4 ? "你在廊下站了好一阵子。" : "你静静站了一会儿。", price: span });
					},
				}],
			}),
		},
		ticks: [
			{
				id: "post.deliver",
				rules: [{
					id: "deliver",
					judge: (q) => {
						if (q.world.time % 4 !== 0) return null;
						const deltas: Delta[] = [];
						const statements: Text[] = [];
						const suspicion = new Map<string, number>();
						for (const l of q.world.entities) {
							if (l.props.kind !== "letter" || l.props.in !== "desk") continue;
							const rid = String(l.props.recipient ?? "");
							if (!entity(q.world, rid)) continue;
							deltas.push(D.set(l.id, "in", rid), D.set(l.id, "seal", false));
							if (l.props.seal !== true) {
								suspicion.set(rid, (suspicion.get(rid) ?? 0) + 1);
								statements.push(`${nameOf(q.world, rid)}收了${nameOf(q.world, l.id)}。断口的火漆瞒不过人，${nameOf(q.world, rid)}的目光落在你身上。`);
							} else {
								statements.push(`${nameOf(q.world, rid)}收了${nameOf(q.world, l.id)}，拆封读毕。`);
							}
						}
						for (const [rid, n] of suspicion) {
							const prev = Number(relVal(q.world, rid, body(q), "猜疑") ?? 0);
							deltas.push(D.relSet(rid, body(q), "猜疑", prev + n));
						}
						return deltas.length ? grant(deltas, { statements }) : null;
					},
				}],
			},
			{
				id: "post.arrive",
				rules: [{
					id: "arrive",
					judge: (q) => {
						if (q.world.time % 4 !== 1 || entity(q.world, "letter_night")) return null;
						const delivered = q.world.entities.some((e) => e.props.kind === "letter" && e.props.recipient != null && e.props.in === e.props.recipient);
						if (!delivered) return null;
						return grant(
							[D.spawn({
								id: "letter_night",
								props: { name: "夜笺", kind: "letter", in: "desk", seal: true, sender: "guest", recipient: "steward", content: "老渠道走水，下月起改陆。引子照旧，勿复书。" },
							})],
							{ statements: ["又有一封夜笺送到，搁在书案上。"] },
						);
					},
				}],
			},
		],
		world: {
			time: 0,
			entities: [
				{ id: "player", props: { name: "心神", kind: "soul", in: "courier" } },
				{ id: "courier", props: { name: "信使", kind: "person", vessel: true, in: "parlor" } },
				{ id: "magistrate", props: { name: "太守", kind: "person", in: "parlor" } },
				{ id: "steward", props: { name: "管家", kind: "person", in: "parlor" } },
				{ id: "merchant", props: { name: "盐商", kind: "person", in: "parlor" } },
				{ id: "guest", props: { name: "灰衣人", kind: "person", mask: true, trueName: "沈青", in: "study" } },
				{ id: "mask", props: { name: "白瓷面具", kind: "thing", vessel: true, in: "parlor" } },
				{ id: "parlor", props: { name: "正厅", kind: "room", space: true } },
				{ id: "study", props: { name: "书房", kind: "room", space: true } },
				{ id: "court", props: { name: "庭院", kind: "room", space: true } },
				{ id: "desk", props: { name: "书案", kind: "desk", in: "parlor" } },
				{ id: "letter_salt", props: { name: "火漆信·盐引", kind: "letter", in: "desk", seal: true, sender: "merchant", recipient: "magistrate", content: "盐引批文已托江苏会馆代办，事成之后，岁贡三成分润。" } },
				{ id: "letter_grain", props: { name: "火漆信·粮价", kind: "letter", in: "desk", seal: true, sender: "magistrate", recipient: "merchant", content: "秋粮定价每石四百钱，勿为流言所动。" } },
			],
			relations: [
				{ from: "parlor", to: "study", type: "path", value: true },
				{ from: "study", to: "parlor", type: "path", value: true },
				{ from: "magistrate", to: "merchant", type: "信任", value: 2 },
				{ from: "magistrate", to: "steward", type: "信任", value: 3 },
				{ from: "merchant", to: "steward", type: "信任", value: 1 },
			],
		},
		props: PROPS,
		// 三条注册边都不是呈现名（label: null）：社交真相只经 view 增补与法则理由流动
		relTypes: {
			"信任": { type: "number", label: null },
			"猜疑": { type: "number", label: null },
			"知晓": { type: "boolean", label: null },
		},
		perspective: (world) => {
			const vis = visible(world);
			return {
				sees: (cell) => {
					if (cell.cell === "vertex") return vis.has(cell.id);
					if (cell.cell === "edge") return true;
					return cell.prop !== "content" || relVal(world, SOUL, cell.entity, "知晓") !== null;
				},
				refers: (e) => vis.has(e.id) || e.props.introduced === true,
			};
		},
		name: (world, base) => (cell) => {
			if (cell.cell !== "vertex") return base(cell);
			const e = entity(world, cell.id);
			return e ? des(e) : base(cell);
		},
		view: (world, base, field) => {
			const extra = extraOf(world, field);
			return Object.keys(extra).length ? { ...base, extra } : base;
		},
		prompt: { system: SYSTEM },
	};
};
