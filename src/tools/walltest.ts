import type { GameDef, PropDef, Q } from "../core/sim.ts";
import { D, defineVerb, grant } from "../core/sim.ts";
import { Type } from "typebox";

/** 结构墙夹具（tools 层自有，不进 games 注册表；scenarios/walltest.json 引用）：
 *  裁决侧代码（规则/系统）收到的 Q.world 是裁决时读态的深冻结副本——越权写在写入点即抛
 *  TypeError（严格模式），活世界无从触及（规则从未持有可变引用，异步路径同样无门）；
 *  越权写钟（q.world.time）同样被拦——「钟的唯一写者是落钟循环」按构造成立。
 *  审查者（不变式）同权隔离：world 与 ctx.changes 是冻结读态/冻结记录——越权写同样即抛，
 *  崩溃在提交边界兑为墙否决（invariant.crash：先回滚 S0 后拒绝——崩溃可说，不洗白为世界性理由）。
 *  良序游戏（village/yume）永不过墙边界，探测不到回归——本夹具是唯一断言墙契约的仪器。
 *  干净对照步的职责不止「无误伤」：若回归把冻结误施于活账本（readState 冻结 this.world 而非副本），
 *  提交会在冻结账本上抛错，越权步之后的干净动作/干净刻步即红——对照步区分「冻结副本」与「冻结活账本」。
 *  异步路径不可测也无需测：无句柄可断言，由构造保证。 */

const PROPS: Record<string, PropDef> = {
	hp: { type: "number", label: "生命" },
	touched: { type: "number", label: "触及" },
	vault: { type: "boolean", label: "封印" },
	sneak: { type: "number", label: "潜标" },
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
	},
	world: {
		time: 0,
		entities: [{ id: "player", name: "你", props: { hp: 10, touched: 0 } }],
	},
	systems: [
		{
			// 蓄意越权：系统直改 hp 后空产出——冻结读态上写入即抛，产出不存在
			id: "leak.tick",
			run: (q) => {
				leakHp(q);
				return null;
			},
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
