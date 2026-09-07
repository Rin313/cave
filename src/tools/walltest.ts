import type { Entity, GameDef, LedgerValue, PropDef, PropValue, Q } from "../core/sim.ts";
import { D, defineVerb, deny, entity, grant, ref } from "../core/sim.ts";
import { Type } from "typebox";

const num = (v: unknown): number => Number(v ?? 0);

/** 结构墙夹具：越权写在冻结读态上即抛，崩溃在提交边界兑为审查否决；干净对照步区分「冻结副本」与「冻结活账本」。 */

const PROPS: Record<string, PropDef> = {
	hp: { type: "number", label: "生命" },
	touched: { type: "number", label: "触及" },
	vault: { type: "boolean", label: "封印" },
	sneak: { type: "number", label: "潜标" },
	armed: { type: "boolean", internal: true },
	crash: { type: "boolean", internal: true },
	gaze: { type: "boolean", internal: true },
	phantom: { type: "boolean", internal: true },
	spy: { type: "boolean", internal: true },
	mech: { type: "boolean", internal: true },
	mute: { type: "boolean", internal: true },
	mechturn: { type: "number", internal: true },
	beats: { type: "number", label: "摆动" },
	// 字面/引用对照：note 字面（与 id 碰撞不解析）、ref 引用
	note: { type: "string", label: "便签" },
	ref: { type: "id", label: "指向" },
};

function leakHp(q: Q): void {
	const me = entity(q.world, q.player);
	if (me) me.props.hp = (typeof me.props.hp === "number" ? me.props.hp : 0) - 1;
}

export const walltest: GameDef = {
	id: "walltest",
	title: "结构墙夹具",
	playerId: "player",
	recentWindow: 0,
	messages: {
		noResponse: "世界没有回应。",
		defaultReason: "……",
		timePassed: "时间流逝",
	},
	verbs: {
		touch: defineVerb({
			label: "触及",
			description: "干净动作：touched +1（对照：冻结不得误伤）。",
			schema: Type.Object({}),
			rules: [{
				id: "ok",
				judge: (q) => {
					const me = entity(q.world, q.player)!;
					return grant([D.set(q.player, "touched", num(me.props.touched) + 1)], "你触到了世界。");
				},
			}],
		}),
		poke: defineVerb({
			label: "戳",
			description: "越权动词：规则直改 hp 后授予（冻结读态上写入即抛，授予不存在）。",
			schema: Type.Object({}),
			rules: [{
				id: "leak",
				judge: (q) => {
					leakHp(q);
					const me = entity(q.world, q.player)!;
					return grant([D.set(q.player, "touched", num(me.props.touched) + 1)], "你戳了一下。");
				},
			}],
		}),
		clockpoke: defineVerb({
			label: "拨钟",
			description: "越权动词：规则直改 q.world.time（冻结读态上写入即抛——钟的唯一写者是落钟循环）。",
			schema: Type.Object({}),
			rules: [{
				id: "leak",
				judge: (q) => {
					q.world.time += 1;
					return grant([], "钟被拨了。");
				},
			}],
		}),
		trip: defineVerb({
			label: "触封印",
			description: "合法授予但被领域不变式否决（墙否决路径：原子回滚后账本必须仍可提交）。",
			schema: Type.Object({}),
			rules: [{ id: "grant", judge: (q) => grant([D.set(q.player, "vault", true)], "你碰了封印。") }],
		}),
		knock: defineVerb({
			label: "叩问",
			description: "拒绝分支时价夹具：尝试价一刻——可见性门与硬墙的拒绝同样耗尝试价。",
			schema: Type.Object({ target: ref("目标实体 id") }),
			cost: 1,
			rules: [{ id: "knock.vault", judge: (q) => grant([D.set(q.player, "vault", true)], "你叩了叩封印。") }],
		}),
		sneakpoke: defineVerb({
			label: "触潜标",
			description: "越权动词：授予后触发审查者（sneaky 不变式）直改账本——冻结读态上写入即抛，崩溃在提交边界兑为墙否决。",
			schema: Type.Object({}),
			rules: [{
				id: "grant",
				judge: (q) => {
					const me = entity(q.world, q.player)!;
					return grant([D.set(q.player, "sneak", num(me.props.sneak) + 1)], "你碰了潜标。");
				},
			}],
		}),
		smuggle: defineVerb({
			label: "夹带",
			description: "越权动词：规则铸出对象形状的 delta——提交翼拒为非账本值（可单行线性化），整提交回滚。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: (q) => grant([D.set(q.player, "note", { a: 1 } as unknown as PropValue)], "你夹带了。") }],
		}),
		arm: defineVerb({
			label: "武装",
			description: "研究动词：武装 leak.tick 的刻步越权（未武装时该系统沉默，让被拦刻步有干净的刻可测）。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "armed", true)], "系统越权已武装。") }],
		}),
		tag: defineVerb({
			label: "标记",
			description: "字面与引用同值写入：字面字符串保持字面，id 型属性解析为展示名。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "note", "thing"), D.set(q.player, "ref", "thing")], "你写下了标记。") }],
		}),
		junkspawn: defineVerb({
			label: "夹带生灭",
			description: "spawn 带实体形状外的顶层键——形状封闭拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: () => grant([D.spawn({ id: "junk", name: "杂物", props: {}, extra: 1 } as unknown as Entity)], "你夹带了。") }],
		}),
		nullspawn: defineVerb({
			label: "空壳生灭",
			description: "墙契约：spawn 的属性含 null——账本值不含 null（缺席是键不在场），提交翼拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: () => grant([D.spawn({ id: "hollow", name: "空壳", props: { hp: null } } as unknown as Entity)], "你召唤了空壳。") }],
		}),
		clear: defineVerb({
			label: "抹除",
			description: "缺席契约：set null 即清（删键）——账本不存 null，缺席读为 null。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "note", null), D.set(q.player, "ref", null)], "你抹去了字迹。") }],
		}),
		blank: defineVerb({
			label: "置空引用",
			description: "墙契约：id 引用写空串——无哨兵惯例（「无引用」由缺席表达，清除写 null 即删键），integrity 拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: (q) => grant([D.set(q.player, "ref", "")], "你写下了一段空白。") }],
		}),
		edgearr: defineVerb({
			label: "数组边",
			description: "墙契约：边值与属性值同一账本形状——标量数组合法入账。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: () => grant([D.relSet("player", "thing", "标记", ["甲"])], "你系了一条带标记的边。") }],
		}),
		mistype: defineVerb({
			label: "误型",
			description: "墙契约：relSet 的关系类型为数字——type 是边身份的组成，非字符串 token 执行翼拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: () => grant([D.relSet("player", "thing", 123 as unknown as string, "甲")], "你系了一条无名边。") }],
		}),
		edgeobj: defineVerb({
			label: "对象边",
			description: "墙契约：对象形状不是账本值——提交翼拒绝，整提交回滚（边值与属性值同一账本形状）。",
			schema: Type.Object({}),
			rules: [{ id: "leak", judge: () => grant([D.relSet("player", "thing", "暗边", { a: 1 } as unknown as LedgerValue)], "你夹带了。") }],
		}),
		bond: defineVerb({
			label: "缔结",
			description: "级联场景前置：与那件东西结一条带值的关系边（弱引用的建立）。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: () => grant([D.relSet("player", "thing", "标记", "甲")], "你与那件东西结下纽带。") }],
		}),
		sever: defineVerb({
			label: "断绝",
			description: "墙契约：despawn 那件东西——级联删边逐条入账（despawn 记录在前，边消散紧随，边表序）。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: () => grant([D.despawn("thing")], "你斩断了那件东西。") }],
		}),
		stack: defineVerb({
			label: "叠写",
			description: "墙契约：同一值地址的叠加增量按序覆盖——两个从冻结读态派生的 +1 只落一次。",
			schema: Type.Object({}),
			rules: [{
				id: "ok",
				judge: (q) => {
					const me = entity(q.world, q.player)!;
					const v = num(me.props.touched) + 1;
					return grant([D.set(q.player, "touched", v), D.set(q.player, "touched", v)], "你叠了两次。");
				},
			}],
		}),
		boom: defineVerb({
			label: "崩坏",
			description: "法则失灵夹具：规则中途抛出——门的全面性代谢为必要性否决（rule.crash，链终止，时价照耗）。",
			schema: Type.Object({}),
			cost: 2,
			rules: [
				{ id: "first", judge: () => { throw new Error("法则在半空碎裂"); } },
				{ id: "fallback", judge: () => deny("boom.fallback", { reason: "兜底法则不应被触及——崩溃链即终止。" }) },
			],
		}),
		detonate: defineVerb({
			label: "引爆",
			description: "研究动词：武装 boom.tick 的系统失灵（未引爆时该系统沉默）。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "crash", true)], "系统失灵已布下。") }],
		}),
		blindfold: defineVerb({
			label: "蒙眼",
			description: "投影缺陷夹具：授予 gaze=true——提交后感知快照崩溃，apply 原子回滚后重抛。",
			schema: Type.Object({}),
			rules: [{ id: "grant", judge: (q) => grant([D.set(q.player, "gaze", true)], "你蒙上了眼。") }],
		}),
		beckon: defineVerb({
			label: "召唤",
			description: "参照域契约夹具：对参照域内的实体召唤（干净授予）；域外 id 由可见性门拒绝。",
			schema: Type.Object({ target: ref("目标实体 id") }),
			rules: [{ id: "ok", judge: () => grant([], "你朝那东西招了招手。") }],
		}),
		veil: defineVerb({
			label: "起雾",
			description: "研究动词：让感知谎报一个不存在的 id（参照域夹具开关）。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "phantom", true)], "雾里多出了一段空白。") }],
		}),
		spy: defineVerb({
			label: "窥伺",
			description: "研究动词：武装感知钩子越权（未武装时钩子沉默）——感知钩子在未冻结读态上写账本即静默污染，跨度两侧都必须冻结。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "spy", true)], "感知已被武装。") }],
		}),
		windup: defineVerb({
			label: "上弦",
			description: "研究动词：武装 mech.tick（纯机械刻）并静默 vault.tick——刻账目闭合的锁需要干净的刻。",
			schema: Type.Object({}),
			rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "mech", true), D.set(q.player, "mute", true)], "机械刻已上弦。") }],
		}),
	},
	world: {
		time: 0,
		entities: [
			{ id: "player", name: "你", props: { hp: 10, touched: 0 } },
			{ id: "thing", name: "那件东西", props: {} },
		],
		relations: [],
	},
	systems: [
		{
			// arm 武装后越权写；未武装时沉默，让被拦刻步有干净的刻可测
			id: "leak.tick",
			run: (q) => {
				if (entity(q.world, q.player)?.props.armed !== true) return null;
				leakHp(q);
				return null;
			},
		},
		{
			// detonate 引爆后抛出：system.crash 失败刻步，其余系统照跑
			id: "boom.tick",
			run: (q) => {
				if (entity(q.world, q.player)?.props.crash !== true) return null;
				throw new Error("系统在半空碎裂");
			},
		},
		{
			// 产出封印，被 vault.sealed 否决（被拦刻步场景）；mute 时沉默——给账目闭合锁让出干净的刻
			id: "vault.tick",
			run: (q) => (entity(q.world, q.player)?.props.mute === true ? null : { deltas: [D.set(q.player, "vault", true)] }),
		},
		{
			// windup 武装后产纯机械刻（delta 无事实）；未武装时沉默——刻账目闭合的锁点：有言刻不并入静默，内务刻同归静默
			id: "mech.tick",
			run: (q) => {
				const me = entity(q.world, q.player);
				if (me?.props.mech !== true) return null;
				if (q.time % 2 === 1) return { deltas: [D.set(q.player, "mechturn", Number(me.props.mechturn ?? 0) + 1)] };
				return { deltas: [D.set(q.player, "beats", num(me.props.beats) + 1)] };
			},
		},
	],
	/** gaze=true 时感知崩溃（apply 回滚后重抛）；phantom=true 时谎报 id（门权威 = grounding ∩ 账本）。 */
	grounding: (world) => {
		if (world.entities.some((e) => e.props.gaze === true)) throw new Error("感知在半空碎裂");
		const ids = world.entities.map((e) => e.id);
		if (world.entities.some((e) => e.props.phantom === true)) return [...ids, "ghost"];
		return ids;
	},
	// spy 武装后在未冻结读态上写账本：裁决读态与提交后采样两侧都必须冻结（场景锁以 hp 断言捕获）
	propPerception: (world) => {
		const armed = world.entities.some((e) => e.props.spy === true);
		return (e) => {
			if (armed && !Object.isFrozen(e)) e.props.hp = 999;
			return true;
		};
	},
	props: PROPS,
	invariants: [{
		// 否决路径的原子回滚探针：回滚若留冻结引用在账本，此后的提交即抛
		id: "vault.sealed",
		check: (_world, ctx) => (ctx.changes.some((c) => c.kind === "prop" && c.prop === "vault") ? "封印纹丝不动。" : null),
	},
	{
		// 审查者越权写：冻结读态上写入即抛，崩溃兑为 invariant.crash
		id: "sneaky",
		check: (world, ctx) => {
			if (!ctx.changes.some((c) => c.kind === "prop" && c.prop === "sneak")) return null;
			const me = world.entities.find((e) => e.id === ctx.def.playerId);
			if (me) me.props.hp = 999;
			return null;
		},
	},]
};
