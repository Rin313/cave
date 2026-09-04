import { Type } from "typebox";
import { defineVerb, grant, type GameDef } from "../core/sim.ts";

/** 研究动词：工具合成的时间通道。core 无裸钟（时间律无豁免条款）——仪器时间同样是
 *  规则授予的刻数，过同一裁决边界与硬墙。意志是研究者本人：一个在世界外、只带这一个动词的 actor。
 *  internal：动词只存在于裁决面，映射层广告面（act schema 与系统提示）不收录，只由工具直接 apply；
 *  仪器动作不进近况、不计回合。 */
export const DEV_WAIT = "dev.wait";

/** 给 def 组合上研究动词（不改原 def）：internal 动词与游戏动词同表共存，Simulation 与 Engine 消费同一张表。 */
export function withDevWait(def: GameDef): GameDef {
	if (def.verbs[DEV_WAIT]) throw new Error(`动词 ${DEV_WAIT} 已由游戏声明——仪器动词与游戏动词的冲突必须显性拒绝，不可静默覆盖`);
	return {
		...def,
		verbs: {
			...def.verbs,
			[DEV_WAIT]: defineVerb({
				label: "流逝",
				description: "研究摇钟：无意志推进 n 刻（工具层合成的内部动词，映射层不可见）。",
				internal: true,
				schema: Type.Object({ n: Type.Optional(Type.Number({ description: "刻数，缺省 1" })) }),
				rules: [{
					id: "dev.wait",
					judge: (_q, p) => grant([], "时间流逝。", undefined, Math.max(0, Math.floor(Number(p.n ?? 1)))),
				}],
			}),
		},
	};
}

/** 研究摇钟动作。 */
export function devWait(n: number): { verb: string; params: { n: number } } {
	return { verb: DEV_WAIT, params: { n } };
}
