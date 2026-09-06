import type { World } from "./sim.ts";

/** 深冻结：裁决侧代码（规则/系统/投影钩子）收到的一切世界读态。*/
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v as T);
	}
	return value;
}

/** 确定性字符串哈希：任意字符串 → [0,1) */
export function hashStr(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** 确定性骰子 → [1, sides]：World 的纯函数，同地址恒同值（地址 = (t, key) 元组编码——分隔符拼接有碰撞面）。
 *  sides 形状违约即抛：Q.roll 只在裁决侧可达，由 *.crash 通道代谢为必要性否决。 */
export function roll(world: World, key: string, sides: number): number {
	if (!Number.isInteger(sides) || sides < 1) throw new Error(`roll: sides 须为 ≥1 的整数，得到 ${String(sides)}`);
	const h = hashStr(JSON.stringify([world.time, key]));
	return 1 + Math.floor(h * sides);
}
