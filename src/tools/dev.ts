import { Type } from "typebox";
import { defineVerb, grant, type GameDef } from "../core/sim.ts";

/** 研究动词：工具合成的时间通道。core 无裸钟（时间律无豁免条款）——仪器时间同样是
 *  规则授予的刻数，过同一裁决边界与硬墙。意志是研究者本人：一个在世界外、只带这一个动词的 actor。
 *  动词不出现在映射层（Engine 以原始 def 生成 act schema 与系统提示），只由工具直接 apply；
 *  仪器动作不进近况、不计回合。 */
export const DEV_WAIT = "dev.wait";

/** 给 def 组合上研究动词（不改原 def）：Simulation 以包裹后的 def 构造，Engine 仍以原始 def 构造。 */
export function withDevWait(def: GameDef): GameDef {
	return {
		...def,
		verbs: {
			...def.verbs,
			[DEV_WAIT]: defineVerb({
				label: "流逝",
				description: "研究摇钟：无意志推进 n 刻（工具层合成，映射层不可见）。",
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
