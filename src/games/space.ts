import type { World } from "../core/sim.ts";
import { entity } from "../core/sim.ts";

/** 容器包含树语义：可达性 = 共享围合场景或目标在锚点子树内；关容器沿链拦截。 */

const REACH_MSGS = {
	reachMissing: "这里没有这个东西。",
	reachCycle: "位置存在循环引用。",
	reachNotHere: "它不在这里。",
	reachClosed: (name: string) => `${name}是关着的。`,
};

export interface SpaceOpts {
	msgs?: Partial<typeof REACH_MSGS>;
	vesselProp?: string;
}

/** 链顶；null = 未安置（链上无场景）。 */
function chainTop(
	world: World,
	from: string,
	anchor: string,
	msgs: typeof REACH_MSGS,
): { ok: true; top: string | null } | { ok: false; reason: string } {
	const start = entity(world, from);
	if (!start) return { ok: false, reason: msgs.reachNotHere };
	if (start.props.space === true) return { ok: true, top: from };
	let cur = (start.props["in"] as string | undefined) ?? null;
	const seen = new Set<string>([from]);
	while (cur != null) {
		if (seen.has(cur)) return { ok: false, reason: msgs.reachCycle };
		if (cur === anchor) return { ok: true, top: anchor };
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return { ok: false, reason: msgs.reachNotHere };
		if (parent.props.space === true) return { ok: true, top: cur };
		if (parent.props.openable === true && parent.props.open !== true) {
			return { ok: false, reason: msgs.reachClosed(parent.name) };
		}
		cur = (parent.props["in"] as string | undefined) ?? null;
	}
	return { ok: true, top: null };
}

/** 两链同为 null（未安置）视为同处：持握于未安置锚点的目标可达。 */
export function inTreeReach(world: World, player: string, id: string, opts: SpaceOpts = {}): { ok: boolean; reason: string } {
	const msgs = { ...REACH_MSGS, ...opts.msgs };
	if (!entity(world, id)) return { ok: false, reason: msgs.reachMissing };
	const target = chainTop(world, id, player, msgs);
	if (!target.ok) return { ok: false, reason: target.reason };
	// 贴身必达：目标在锚点子树内（被持握/居于其中），锚点自身链的围合无关紧要
	if (target.top === player) return { ok: true, reason: "" };
	const home = chainTop(world, player, player, msgs);
	if (!home.ok) return { ok: false, reason: home.reason };
	return home.top === target.top ? { ok: true, reason: "" } : { ok: false, reason: msgs.reachNotHere };
}

export function enclosingSpace(world: World, id: string): string | null {
	const start = entity(world, id);
	if (!start) return null;
	if (start.props.space === true) return id;
	let cur = (start.props["in"] as string | undefined) ?? null;
	const seen = new Set<string>([id]);
	while (cur != null && !seen.has(cur)) {
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return null;
		if (parent.props.space === true) return cur;
		cur = (parent.props["in"] as string | undefined) ?? null;
	}
	return null;
}

/** 附身 = 对锚 in 的迁移；宿主 despawn 前须先迁出（id 引用契约强制）。 */
export function hostOf(world: World, anchor: string, opts: SpaceOpts = {}): string {
	const key = opts.vesselProp ?? "vessel";
	let cur: string | null = anchor;
	const seen = new Set<string>();
	while (cur != null && !seen.has(cur)) {
		seen.add(cur);
		const e = entity(world, cur);
		if (!e) break;
		if (e.props[key] === true) return cur;
		cur = (e.props["in"] as string | undefined) ?? null;
	}
	return anchor;
}

export function inTreeVisible(world: World, player: string, opts: SpaceOpts = {}): Set<string> {
	const vis = new Set<string>([player]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (inTreeReach(world, player, e.id, opts).ok) vis.add(e.id);
	}
	return vis;
}

