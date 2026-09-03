import type { GameDef, PropDef, Q } from "../core/sim.ts";
import { D, defineVerb, deny, grant } from "../core/sim.ts";
import { Type } from "typebox";

/** 可说性墙测试夹具（tools 层自有，不进 games 注册表；scenarios/walltest.json 引用）：
 *  规则/系统经 Q 活引用直改账本（蓄意 bug），墙必须在裁决出口拦截——裁决整体作废、世界回滚到 S0；
 *  干净动词与干净刻步证明墙无误伤。 */

const PROPS: Record<string, PropDef> = {
	hp: { type: "number", label: "生命" },
	touched: { type: "number", label: "触及" },
};

/** 蓄意 bug：经 Q 活引用直改账本（墙的靶子）。 */
function leakHp(q: Q): void {
	const me = q.entity(q.player);
	if (me) me.props.hp = (typeof me.props.hp === "number" ? me.props.hp : 0) - 1;
}

export const walltest: GameDef = {
	id: "walltest",
	title: "可说性墙夹具",
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
			description: "干净动作：touched +1（对照：墙不得误伤）。",
			schema: Type.Object({}),
			rules: [{ id: "touch.ok", judge: (q) => grant([D.inc(q.player, "touched", 1)], "你触到了世界。") }],
		}),
		poke: defineVerb({
			label: "戳",
			description: "残差动词：规则活改 hp 后授予（授予整体作废）。",
			schema: Type.Object({}),
			rules: [{
				id: "poke.leak",
				judge: (q) => {
					leakHp(q);
					return grant([D.inc(q.player, "touched", 1)], "你戳了一下。");
				},
			}],
		}),
		hex: defineVerb({
			label: "诅咒",
			description: "残差动词：规则活改 hp 后拒绝（拒绝被掩为 bug 信号，活改回滚）。",
			schema: Type.Object({}),
			rules: [{
				id: "hex.leak",
				judge: (q) => {
					leakHp(q);
					return deny("hex.miss", { reason: "诅咒落空了。" });
				},
			}],
		}),
	},
	world: {
		time: 0,
		entities: [{ id: "player", name: "你", props: { hp: 10, touched: 0 } }],
	},
	systems: [
		{
			// 残差系统：活改 hp 后空产出——deltas 为空而世界已变，同为残差
			id: "leak.tick",
			run: (q) => {
				leakHp(q);
				return null;
			},
		},
	],
	props: PROPS,
};
