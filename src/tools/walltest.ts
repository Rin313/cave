import type { GameDef, PropDef, PropValue, Q } from "../core/sim.ts";
import { D, defineVerb, grant } from "../core/sim.ts";
import { Type } from "typebox";

/** 结构墙夹具：
 *  裁决侧代码（规则/系统）收到的 Q.world 是裁决时读态的深冻结副本；
 *  越权写钟（q.world.time）同样被拦。
 *  审查者（不变式）同权隔离：world 与 ctx.changes 是冻结读态/冻结记录，
 *  崩溃在提交边界兑为墙否决（invariant.crash：先回滚 S0 后拒绝）。
 *  良序游戏永不过墙边界，探测不到回归——本夹具是唯一断言墙契约的仪器。
 *  干净对照步的职责不止「无误伤」：若回归把冻结误施于活账本（readState 冻结 this.world 而非副本），
 *  提交会在冻结账本上抛错，越权步之后的干净动作/干净刻步即红——对照步区分「冻结副本」与「冻结活账本」。
 *  声明驱动的渲染/投影（字面值不冒充指称）在 tag 场景钉住。 */

const PROPS: Record<string, PropDef> = {
	hp: { type: "number", label: "生命" },
	touched: { type: "number", label: "触及" },
	vault: { type: "boolean", label: "封印" },
	sneak: { type: "number", label: "潜标" },
	armed: { type: "boolean", internal: true },
	// 指称解析契约的字面/引用对照：note 是字面字符串（与实体 id 碰撞也不得解析），ref 是声明引用
	note: { type: "string", label: "便签" },
	ref: { type: "id", label: "指向" },
};

/** 蓄意越权：经 Q 读态直改属性（冻结视图上写入即抛）。 */
function leakHp(q: Q): void {
	const me = q.entity(q.player);
	if (me) me.props.hp = (typeof me.props.hp === "number" ? me.props.hp : 0) - 1;
}

export const walltest: GameDef = {
	id: "walltest",
	title: "结构墙夹具",
	playerId: "player",
	memoryLimit: 0,
	messages: {
		noResponse: "世界没有回应。",
		defaultReason: "……",
		notInActionPhase: "不在行动阶段。",
		timePassed: "时间流逝",
	},
	verbs: {
		touch: defineVerb({
			label: "触及",
			description: "干净动作：touched +1（对照：冻结不得误伤）。",
			schema: Type.Object({}),
			rules: [{ id: "touch.ok", judge: (q) => grant([D.inc(q.player, "touched", 1)], "你触到了世界。") }],
		}),
		poke: defineVerb({
			label: "戳",
			description: "越权动词：规则直改 hp 后授予（冻结读态上写入即抛，授予不存在）。",
			schema: Type.Object({}),
			rules: [{
				id: "poke.leak",
				judge: (q) => {
					leakHp(q);
					return grant([D.inc(q.player, "touched", 1)], "你戳了一下。");
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
			rules: [{ id: "sneakpoke.grant", judge: (q) => grant([D.inc(q.player, "sneak", 1)], "你碰了潜标。") }],
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
				if (q.entity(q.player)?.props.armed !== true) return null;
				leakHp(q);
				return null;
			},
		},
		{
			// 蓄意被拦：系统产出设置封印 → vault.sealed 否决——被拦刻步（TickStep ok:false）的唯一合法来源，
			// walltest.json 的拦截行计时/静默刻聚合契约场景在此产生
			id: "vault.tick",
			run: (q) => ({ deltas: [D.set(q.player, "vault", true)] }),
		},
	],
	props: PROPS,
	invariants: [{
		// 墙契约的另一半：否决路径的原子回滚。回滚若把冻结引用留在账本上，此场景后的任何提交即抛——
		// 场景的干净对照步（回滚后 touch 照常）就是该回归的探针。
		id: "vault.sealed",
		check: (_world, ctx) => (ctx.changes.some((c) => c.kind === "prop" && c.prop === "vault") ? "封印纹丝不动。" : null),
	},
	{
		// 蓄意越权：审查者直改账本——审查者收冻结读态（与裁决侧同权），写入即抛；
		// 崩溃由提交边界兑为墙否决（invariant.crash），提交回滚——崩溃可说且不洗白。
		id: "sneaky",
		check: (world, ctx) => {
			if (!ctx.changes.some((c) => c.kind === "prop" && c.prop === "sneak")) return null;
			const me = world.entities.find((e) => e.id === ctx.def.playerId);
			if (me) me.props.hp = 999;
			return null;
		},
	},]
};
