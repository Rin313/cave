export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v as T);
	}
	return value;
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function hashStr(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** 同地址恒同值；地址是决策事件的账本位置，不由玩家输入决定；sides 违约即抛，由 *.crash 通道代谢。 */
export function roll(addr: string, key: string, sides: number): number {
	if (!Number.isInteger(sides) || sides < 1) throw new Error(`roll: sides 须为 ≥1 的整数，得到 ${String(sides)}`);
	const h = hashStr(JSON.stringify([addr, key]));
	return 1 + Math.floor(h * sides);
}
