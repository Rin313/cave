import { defineVerb, grant, type GameDef } from "../core/sim.ts";

/** 工具合成的时间通道：摇出的刻同样过裁决边界与审查。 */
const DEV_WAIT = "dev.wait";

export function withDevWait(def: GameDef): GameDef {
	if (def.verbs[DEV_WAIT]) throw new Error(`动词 ${DEV_WAIT} 已由游戏声明——仪器动词与游戏动词的冲突必须显性拒绝，不可静默覆盖`);
	return {
		...def,
		verbs: {
			...def.verbs,
			[DEV_WAIT]: defineVerb({
				label: "流逝",
				description: "研究摇钟：推进 n 刻（工具层合成的内部动词，映射层不可见；场景 tick 脱糖经裸 apply 消费）。",
				internal: true,
				params: { n: { type: "number", optional: true, description: "刻数，缺省 1" } },
				cost: 0,
				rules: [{
					id: "wait",
					judge: (_q, p) => grant([], "时间流逝。", undefined, Math.max(0, Math.floor(Number(p.n ?? 1)))),
				}],
			}),
		},
	};
}

export function devWait(n: number): { verb: string; params: { n: number } } {
	return { verb: DEV_WAIT, params: { n } };
}
