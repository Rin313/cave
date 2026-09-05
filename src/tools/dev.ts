import { Type } from "typebox";
import { defineVerb, grant, type GameDef } from "../core/sim.ts";

/** 研究动词：工具合成的时间通道。仪器摇出的刻同样是规则授予的，过同一裁决边界与硬墙 */
export const DEV_WAIT = "dev.wait";

export function withDevWait(def: GameDef): GameDef {
	if (def.verbs[DEV_WAIT]) throw new Error(`动词 ${DEV_WAIT} 已由游戏声明——仪器动词与游戏动词的冲突必须显性拒绝，不可静默覆盖`);
	return {
		...def,
		verbs: {
			...def.verbs,
			[DEV_WAIT]: defineVerb({
				label: "流逝",
				description: "研究摇钟：直达提案推进 n 刻（工具层合成的内部动词，映射层不可见）。",
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
