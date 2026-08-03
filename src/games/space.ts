import type { Entity, Messages, World } from "../core/sim.ts";
import { entity } from "../core/sim.ts";

/** 容器包含树可达性的游戏侧构件：core 不内嵌任何空间模型，需要空间语义的游戏自选接入。
 *  语义与理由文案由 opts 注入；关容器对实体的放行（楔住等）由游戏经 containerAccess 裁决。
 *  附带的 GameDef.reach/reachReason 接线（reachFor）供游戏直接展开到 GameDef。 */

export interface SpaceOpts {
	/** 可达性理由文案（缺省为空——由游戏注入自有语言）。 */
	msgs?: Pick<Messages, "reachMissing" | "reachCycle" | "reachNotHere" | "reachClosed">;
	/** 关着的容器（openable 且未 open）是否对实体 id 放行。缺省一律拦截。
	 *  如"楔在门缝里的东西仍可够到"由游戏以容器属性裁决，构件不内嵌具体机制。 */
	containerAccess?: (world: World, container: Entity, id: string) => boolean;
}

/** 容器包含树语义（space / openable / open / in）的可达性。 */
export function inTreeReach(world: World, actor: string, id: string, opts: SpaceOpts = {}): { ok: boolean; reason: string } {
	const msgs = opts.msgs;
	const e = entity(world, id);
	if (!e) return { ok: false, reason: msgs?.reachMissing ?? "" };
	let cur = e.props["in"] as string | null;
	const seen = new Set<string>();
	while (cur != null && cur !== actor) {
		if (seen.has(cur)) return { ok: false, reason: msgs?.reachCycle ?? "" };
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return { ok: false, reason: msgs?.reachNotHere ?? "" };
		if (parent.props.space === true) {
			return parent.id === (entity(world, actor)?.props["in"] as string)
				? { ok: true, reason: "" }
				: { ok: false, reason: msgs?.reachNotHere ?? "" };
		}
		if (parent.props.openable === true && parent.props.open !== true) {
			if (opts.containerAccess?.(world, parent, id)) return { ok: true, reason: "" };
			return { ok: false, reason: msgs?.reachClosed?.(parent.name) ?? "" };
		}
		cur = parent.props["in"] as string | null;
	}
	return { ok: true, reason: "" };
}

/** 容器包含树语义下的可见性：玩家可达的全部实体 + 场景（space）实体。 */
export function inTreeVisible(world: World, actor: string, opts: SpaceOpts = {}): Set<string> {
	const vis = new Set<string>([actor]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (inTreeReach(world, actor, e.id, opts).ok) vis.add(e.id);
	}
	return vis;
}

/** 由 inTreeReach 派生的 GameDef.reach / reachReason 槽位（不可达时的世界腔理由）。 */
export function reachFor(opts: SpaceOpts): {
	reach: (world: World, actor: string, id: string) => boolean;
	reachReason: (world: World, actor: string, id: string) => string | null;
} {
	return {
		reach: (world, actor, id) => inTreeReach(world, actor, id, opts).ok,
		reachReason: (world, actor, id) => {
			const r = inTreeReach(world, actor, id, opts);
			return r.ok ? null : (r.reason || null);
		},
	};
}
