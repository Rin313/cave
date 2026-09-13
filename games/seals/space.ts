import type { Core } from "../../src/core/games.ts";
import type { World } from "../../src/core/sim.ts";

/** 围合：三个查询都只读 in 链（本例中 in 指向持者或所在之地），语义由游戏自定。 */
export const space = (core: Core) => {
	const { entity } = core;

	/** in 链上的最近场景；无场景、断链或成环即 null。 */
	const enclosingSpace = (world: World, id: string): string | null => {
		let cur: string | null = id;
		const seen = new Set<string>();
		while (cur !== null) {
			if (seen.has(cur)) return null;
			seen.add(cur);
			const e = entity(world, cur);
			if (!e) return null;
			if (e.props.space === true) return cur;
			cur = typeof e.props.in === "string" ? e.props.in : null;
		}
		return null;
	};

	/** 缺省主语：从锚点沿 in 链遇到的第一个器皿；找不到即锚点自身。 */
	const hostOf = (world: World, anchor: string): string => {
		let cur = anchor;
		const seen = new Set<string>();
		while (!seen.has(cur)) {
			seen.add(cur);
			const e = entity(world, cur);
			if (!e) return anchor;
			if (e.props.vessel === true) return cur;
			const next = e.props.in;
			if (typeof next !== "string") return anchor;
			cur = next;
		}
		return anchor;
	};

	/** 可见域：全部场景 ＋ 与锚点同围合者（含锚点）。 */
	const inTreeVisible = (world: World, anchor: string): Set<string> => {
		const home = enclosingSpace(world, anchor);
		const vis = new Set<string>([anchor]);
		for (const e of world.entities) {
			if (e.props.space === true || enclosingSpace(world, e.id) === home) vis.add(e.id);
		}
		return vis;
	};

	return { enclosingSpace, hostOf, inTreeVisible };
};
