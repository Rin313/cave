import type { World } from "./sim.ts";

/** 确定性字符串哈希：任意字符串 → [0,1) 均匀分布值。纯函数、无状态。
 *  games 层用它从世界状态派生自有随机语义（如 hashStr(`${world.time}#${luck}#${salt}`)），
 *  引擎不提供状态化 rng——随机必须是 World 的纯函数，保证 check/apply/dryTick/存档天然一致。 */
export function hashStr(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** 数值属性跨实体求和（缺失/非数字按 0）。era/DoL 类资源经济的守恒不变式用（如 sumProp(world,"coins")）。
 *  聚合不感知游戏机制——守恒模式：游戏声明「聚合值 == 种子值」的不变式，AI 通道与系统 bug 都无法凭空铸币/灭币。 */
export function sumProp(world: World, prop: string): number {
	let total = 0;
	for (const e of world.entities) {
		const v = e.props[prop];
		if (typeof v === "number" && Number.isFinite(v)) total += v;
	}
	return total;
}

/** 确定性骰子：hashStr(`${world.time}#${key}`) 派生的 [1, sides] 整数。
 *  随机必须是 World 的纯函数（check/apply/dryTick/存档天然一致）——era 类判定/掉落据此派生，
 *  key 需在同 tick 内唯一（含实体 id 或自持计数器，如 roll(world, `drop#${id}`, 6)）。 */
export function roll(world: World, key: string, sides: number): number {
	const h = hashStr(`${world.time}#${key}`);
	return 1 + Math.floor(h * Math.max(1, Math.floor(sides)));
}
