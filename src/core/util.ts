import type { GameDef, World } from "./sim.ts";

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

/** 引用清点原语（生长与收缩对称）：按注册表 type:"id" 枚举指向该实体的 (entity, prop)，
 *  覆盖标量引用与引用数组（与 integrity 硬墙的管辖面一致——墙拦下的悬空，这里必须找得到）。
 *  语义无关的机械清点——despawn 前的悬空引用盘点（容器级 despawn 先迁散子女同理）；
 *  清理策略（置空/转移/级联生灭）是游戏语义，由规则决定；关系边由 despawn 自动级联，不在此列。 */
export function refsTo(def: GameDef, world: World, id: string): { entity: string; prop: string }[] {
	const idProps = Object.entries(def.props ?? {}).filter(([, p]) => p.type === "id").map(([k]) => k);
	const out: { entity: string; prop: string }[] = [];
	for (const e of world.entities) {
		if (e.id === id) continue;
		for (const p of idProps) {
			const v = e.props[p];
			if (v === id || (Array.isArray(v) && v.includes(id))) out.push({ entity: e.id, prop: p });
		}
	}
	return out;
}

/** 确定性骰子：hashStr(`${world.time}#${key}`) 派生的 [1, sides] 整数。
 *  随机必须是 World 的纯函数（apply/存档恢复一致），
 *  key 需在同 tick 内唯一（含实体 id 或自持计数器）。 */
export function roll(world: World, key: string, sides: number): number {
	const h = hashStr(`${world.time}#${key}`);
	return 1 + Math.floor(h * Math.max(1, Math.floor(sides)));
}
