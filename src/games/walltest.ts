import type { Entity, GameDef, LedgerValue, PropDef, PropValue, Q } from "../core/sim.ts";
import { D, defineVerb, deny, entity, grant } from "../core/sim.ts";
import { Type } from "typebox";

const num = (v: unknown): number => Number(v ?? 0);

/** 结构墙夹具：裁决侧（规则/系统）与审查者（不变式）收冻结读态/冻结记录，越权写在冻结对象上即抛，
 *  崩溃在提交边界兑为墙否决。干净对照步区分「冻结副本」与「冻结活账本」：若回归把冻结误施于活账本
 *  （readState 冻结 this.world 而非副本），越权步之后的干净动作/刻步即红。 */

const PROPS: Record<string, PropDef> = {
	hp: { type: "number", label: "生命" },
	touched: { type: "number", label: "触及" },
	vault: { type: "boolean", label: "封印" },
	sneak: { type: "number", label: "潜标" },
	armed: { type: "boolean", internal: true },
	// 法则失灵与投影缺陷夹具的开关属性（内部 plumbing，同 armed）
	crash: { type: "boolean", internal: true },
	gaze: { type: "boolean", internal: true },
	phantom: { type: "boolean", internal: true },
	// 指称解析契约的字面/引用对照：note 是字面字符串（与实体 id 碰撞也不得解析），ref 是声明引用
	note: { type: "string", label: "便签" },
	ref: { type: "id", label: "指向" },
};

/** 蓄意越权：经 Q 读态直改属性（冻结视图上写入即抛）。 */
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
				id: "touch.ok",
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
				id: "poke.leak",
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
				id: "clockpoke.leak",
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
			rules: [{ id: "trip.grant", judge: (q) => grant([D.set(q.player, "vault", true)], "你碰了封印。") }],
		}),
		sneakpoke: defineVerb({
			label: "触潜标",
			description: "越权动词：授予后触发审查者（sneaky 不变式）直改账本——冻结读态上写入即抛，崩溃在提交边界兑为墙否决。",
			schema: Type.Object({}),
			rules: [{
				id: "sneakpoke.grant",
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
			rules: [{ id: "smuggle.leak", judge: (q) => grant([D.set(q.player, "note", { a: 1 } as unknown as PropValue)], "你夹带了。") }],
		}),
		arm: defineVerb({
			label: "武装",
			description: "研究动词：武装 leak.tick 的刻步越权（未武装时该系统沉默，让被拦刻步有干净的刻可测）。",
			schema: Type.Object({}),
			rules: [{ id: "arm.ok", judge: (q) => grant([D.set(q.player, "armed", true)], "系统越权已武装。") }],
		}),
		tag: defineVerb({
			label: "标记",
			description: "字面与引用同值写入：字面字符串保持字面，id 型属性解析为展示名。",
			schema: Type.Object({}),
			rules: [{ id: "tag.ok", judge: (q) => grant([D.set(q.player, "note", "thing"), D.set(q.player, "ref", "thing")], "你写下了标记。") }],
		}),
		junkspawn: defineVerb({
			label: "夹带生灭",
			description: "墙契约：spawn 带实体形状外的顶层键——形状封闭拒绝（公理一）。",
			schema: Type.Object({}),
			rules: [{ id: "junkspawn.leak", judge: () => grant([D.spawn({ id: "junk", name: "杂物", props: {}, extra: 1 } as unknown as Entity)], "你夹带了。") }],
		}),
		nullspawn: defineVerb({
			label: "空壳生灭",
			description: "墙契约：spawn 的属性含 null——账本值不含 null（缺席是键不在场），提交翼拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "nullspawn.leak", judge: () => grant([D.spawn({ id: "hollow", name: "空壳", props: { hp: null } } as unknown as Entity)], "你召唤了空壳。") }],
		}),
		clear: defineVerb({
			label: "抹除",
			description: "缺席契约：set null 即清（删键）——账本不存 null，缺席读为 null。",
			schema: Type.Object({}),
			rules: [{ id: "clear.ok", judge: (q) => grant([D.set(q.player, "note", null), D.set(q.player, "ref", null)], "你抹去了字迹。") }],
		}),
		blank: defineVerb({
			label: "置空引用",
			description: "墙契约：id 引用写空串——无哨兵惯例（「无引用」由缺席表达，清除写 null 即删键），integrity 拒绝。",
			schema: Type.Object({}),
			rules: [{ id: "blank.leak", judge: (q) => grant([D.set(q.player, "ref", "")], "你写下了一段空白。") }],
		}),
		edgearr: defineVerb({
			label: "数组边",
			description: "墙契约：边值与属性值同一账本形状——标量数组合法入账。",
			schema: Type.Object({}),
			rules: [{ id: "edgearr.ok", judge: () => grant([D.relSet("player", "thing", "标记", ["甲"])], "你系了一条带标记的边。") }],
		}),
		edgeobj: defineVerb({
			label: "对象边",
			description: "墙契约：对象形状不是账本值——提交翼拒绝，整提交回滚（边值与属性值同一账本形状）。",
			schema: Type.Object({}),
			rules: [{ id: "edgeobj.leak", judge: () => grant([D.relSet("player", "thing", "暗边", { a: 1 } as unknown as LedgerValue)], "你夹带了。") }],
		}),
		bond: defineVerb({
			label: "缔结",
			description: "级联场景前置：与那件东西结一条带值的关系边（弱引用的建立）。",
			schema: Type.Object({}),
			rules: [{ id: "bond.ok", judge: () => grant([D.relSet("player", "thing", "标记", "甲")], "你与那件东西结下纽带。") }],
		}),
		sever: defineVerb({
			label: "断绝",
			description: "墙契约：despawn 那件东西——级联删边逐条入账（despawn 记录在前，边消散紧随，边表序）。",
			schema: Type.Object({}),
			rules: [{ id: "sever.ok", judge: () => grant([D.despawn("thing")], "你斩断了那件东西。") }],
		}),
		boom: defineVerb({
			label: "崩坏",
			description: "法则失灵夹具：规则中途抛出——门的全面性代谢为必要性否决（rule.crash，链终止，时价照耗）。",
			schema: Type.Object({}),
			cost: 2,
			rules: [
				{ id: "boom.first", judge: () => { throw new Error("法则在半空碎裂"); } },
				{ id: "boom.fallback", judge: () => deny("boom.fallback", { reason: "兜底法则不应被触及——崩溃链即终止。" }) },
			],
		}),
		detonate: defineVerb({
			label: "引爆",
			description: "研究动词：武装 boom.tick 的系统失灵（未引爆时该系统沉默）。",
			schema: Type.Object({}),
			rules: [{ id: "detonate.ok", judge: (q) => grant([D.set(q.player, "crash", true)], "系统失灵已布下。") }],
		}),
		blindfold: defineVerb({
			label: "蒙眼",
			description: "投影缺陷夹具：授予 gaze=true——提交后感知快照崩溃，apply 原子回滚后重抛。",
			schema: Type.Object({}),
			rules: [{ id: "blindfold.grant", judge: (q) => grant([D.set(q.player, "gaze", true)], "你蒙上了眼。") }],
		}),
		beckon: defineVerb({
			label: "召唤",
			description: "参照域契约夹具：对参照域内的实体召唤（干净授予）；域外 id 由可见性门拒绝。",
			schema: Type.Object({ target: Type.String({ description: "目标实体 id" }) }),
			entityParams: ["target"],
			rules: [{ id: "beckon.ok", judge: () => grant([], "你朝那东西招了招手。") }],
		}),
		veil: defineVerb({
			label: "起雾",
			description: "研究动词：让感知谎报一个不存在的 id（参照域夹具开关）。",
			schema: Type.Object({}),
			rules: [{ id: "veil.ok", judge: (q) => grant([D.set(q.player, "phantom", true)], "雾里多出了一段空白。") }],
		}),
	},
	world: {
		time: 0,
		entities: [
			{ id: "player", name: "你", props: { hp: 10, touched: 0 } },
			{ id: "thing", name: "那件东西", props: {} },
		],
	},
	systems: [
		{
			// 蓄意越权：武装（arm）后系统直改 hp——冻结读态上写入即抛，产出不存在；
			// 未武装时沉默放行，同注册表的被拦刻步（vault.tick）才有干净的刻可测
			id: "leak.tick",
			run: (q) => {
				if (entity(q.world, q.player)?.props.armed !== true) return null;
				leakHp(q);
				return null;
			},
		},
		{
			// 蓄意失灵：引爆（detonate）后系统直接抛出——崩溃兑为失败刻步（system.crash），其余系统照跑，时刻照走
			id: "boom.tick",
			run: (q) => {
				if (entity(q.world, q.player)?.props.crash !== true) return null;
				throw new Error("系统在半空碎裂");
			},
		},
		{
			// 蓄意被拦：系统产出设置封印 → vault.sealed 否决（walltest.json 的被拦刻步场景由此产生）
			id: "vault.tick",
			run: (q) => ({ deltas: [D.set(q.player, "vault", true)] }),
		},
	],
	/** 投影缺陷夹具：gaze=true 时感知快照崩溃（apply 原子回滚后重抛）；phantom=true 时感知谎报不存在的 id
	 *  （门权威 = grounding ∩ 账本，谎报静默离场）。其余状态全见。 */
	grounding: (world) => {
		if (world.entities.some((e) => e.props.gaze === true)) throw new Error("感知在半空碎裂");
		const ids = world.entities.map((e) => e.id);
		if (world.entities.some((e) => e.props.phantom === true)) return [...ids, "ghost"];
		return ids;
	},
	props: PROPS,
	invariants: [{
		// 墙契约的另一半：否决路径的原子回滚。回滚若把冻结引用留在账本上，此场景后的任何提交即抛——
		// 场景的干净对照步（回滚后 touch 照常）就是该回归的探针。
		id: "vault.sealed",
		check: (_world, ctx) => (ctx.changes.some((c) => c.kind === "prop" && c.prop === "vault") ? "封印纹丝不动。" : null),
	},
	{
		// 蓄意越权：审查者直改账本——审查者收冻结读态（与裁决侧同权），写入即抛，崩溃兑为墙否决（invariant.crash）
		id: "sneaky",
		check: (world, ctx) => {
			if (!ctx.changes.some((c) => c.kind === "prop" && c.prop === "sneak")) return null;
			const me = world.entities.find((e) => e.id === ctx.def.playerId);
			if (me) me.props.hp = 999;
			return null;
		},
	},]
};
