import type { PropValue, Simulation } from "../core/sim.ts";

/** 探测域声明（作者对「法则具体覆盖面」的声明）：
 *  动词 → 参数 → 候选值解析。域内目标应越过 fallback 得到具体法则回答（落兜底标记即报缺口），
 *  域外落兜底属正常沉默。实体参数缺省域 = space 构件的 probeScope（可见 - 玩家 - 场景），逐参数覆盖在此声明。 */
export type ProbeSpec = Partial<Record<string, (sim: Simulation) => Record<string, PropValue[]>>>;
