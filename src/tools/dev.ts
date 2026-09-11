import { defineVerb, grant, param, type GameDef } from "../core/sim.ts";

const DEV_WAIT = "dev.wait";

export function withDevWait(def: GameDef): GameDef {
	if (def.verbs[DEV_WAIT]) throw new Error(`动词 ${DEV_WAIT} 已由游戏声明——测试动词与游戏动词的冲突必须显性拒绝，不可静默覆盖`);
	return {
		...def,
		verbs: {
			...def.verbs,
			[DEV_WAIT]: defineVerb({
				label: "流逝",
				description: "测试摇钟：推进 n 刻（工具层合成；仅用于测试 def，以普通 will 动作消费）。",
				params: { n: param("number", { optional: true, description: "刻数，缺省 1" }) },
				cost: 0,
				rules: [{
					id: "wait",
					judge: (q) => grant([], { reply: "时间流逝。", ticks: Math.max(0, Math.floor(Number(q.params.n ?? 1))) }),
				}],
			}),
		},
	};
}

export function devWait(n: number): { verb: string; params: { n: number } } {
	return { verb: DEV_WAIT, params: { n } };
}
