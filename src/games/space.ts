import type { Entity, Rule, World } from "../core/sim.ts";
import { entity } from "../core/sim.ts";

/** 语义与理由文案内置于本构件，SpaceOpts.msgs 可逐项覆盖；
 *  关容器对实体的放行（楔住等）由游戏经 containerAccess 裁决。
 *  锚点拓扑：锚点（玩家/魂）可位于包含链任意深度——附身 = 地址的空间迁移（魂以 in 居于器皿），
 *  可达性 = 目标与锚点共享围合场景，或目标在锚点子树内（贴身必达）；关容器沿双链对称拦截。
 *  现宿主 = 链上最近器皿（hostOf，器皿布尔属性键控，缺省锚点自身）。 */

const REACH_MSGS = {
	reachMissing: "这里没有这个东西。",
	reachCycle: "位置存在循环引用。",
	reachNotHere: "它不在这里。",
	reachClosed: (name: string) => `${name}是关着的。`,
};

export interface SpaceOpts {
	/** 覆盖构件内置的可达性理由文案（逐项合并）。 */
	msgs?: Partial<typeof REACH_MSGS>;
	/** 关着的容器（openable 且未 open）是否对实体 id 放行。缺省一律拦截。
	 *  如"楔在门缝里的东西仍可够到"由游戏以容器属性裁决，构件不内嵌具体机制。 */
	containerAccess?: (world: World, container: Entity, id: string) => boolean;
	/** 器皿布尔属性的键名（hostOf 键控用；承重墙：禁止特判实体 id）。缺省 "vessel"。 */
	vesselProp?: string;
}

/** 链顶：from 沿 `in` 上溯的终止点——场景（space）即围合（场景自围合），锚点即同域（目标在锚点子树内），
 *  null = 链走完无场景（未安置）。关容器沿链拦截（containerAccess 豁免放行后继续上溯）；循环/断链失败。 */
function chainTop(
	world: World,
	from: string,
	anchor: string,
	msgs: typeof REACH_MSGS,
	opts: SpaceOpts,
): { ok: true; top: string | null } | { ok: false; reason: string } {
	const start = entity(world, from);
	if (!start) return { ok: false, reason: msgs.reachNotHere };
	if (start.props.space === true) return { ok: true, top: from };
	let cur = start.props["in"] as string | null;
	const seen = new Set<string>([from]);
	while (cur != null) {
		if (seen.has(cur)) return { ok: false, reason: msgs.reachCycle };
		if (cur === anchor) return { ok: true, top: anchor };
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return { ok: false, reason: msgs.reachNotHere };
		if (parent.props.space === true) return { ok: true, top: cur };
		if (parent.props.openable === true && parent.props.open !== true && !opts.containerAccess?.(world, parent, from)) {
			return { ok: false, reason: msgs.reachClosed(parent.name) };
		}
		cur = parent.props["in"] as string | null;
	}
	return { ok: true, top: null };
}

/** 容器包含树语义下的可达性（链上锚）：目标与锚点共享围合场景，或目标在锚点子树内。
 *  两链同为 null（未安置）视为同处——持握于未安置锚点的目标可达。 */
export function inTreeReach(world: World, player: string, id: string, opts: SpaceOpts = {}): { ok: boolean; reason: string } {
	const msgs = { ...REACH_MSGS, ...opts.msgs };
	if (!entity(world, id)) return { ok: false, reason: msgs.reachMissing };
	const target = chainTop(world, id, player, msgs, opts);
	if (!target.ok) return { ok: false, reason: target.reason };
	// 贴身必达：目标在锚点子树内（被持握/居于其中），锚点自身链的围合无关紧要
	if (target.top === player) return { ok: true, reason: "" };
	const home = chainTop(world, player, player, msgs, opts);
	if (!home.ok) return { ok: false, reason: home.reason };
	return home.top === target.top ? { ok: true, reason: "" } : { ok: false, reason: msgs.reachNotHere };
}

/** 锚点所在场景：链上最近的 space 实体（魂居狼身时 here=森林而非狼）；未安置返回 null。 */
export function enclosingSpace(world: World, id: string): string | null {
	const start = entity(world, id);
	if (!start) return null;
	if (start.props.space === true) return id;
	let cur = start.props["in"] as string | null;
	const seen = new Set<string>([id]);
	while (cur != null && !seen.has(cur)) {
		seen.add(cur);
		const parent = entity(world, cur);
		if (!parent) return null;
		if (parent.props.space === true) return cur;
		cur = parent.props["in"] as string | null;
	}
	return null;
}

/** 现宿主原语：锚点（意志的地址）在包含链上的最近器皿，缺省锚点自身（第一人称恒等退化）。
 *  附身 = 地址的空间迁移（D.set(地址, "in", 器皿)）——迁移必经 delta 入账：id 引用契约使器皿 despawn
 *  前的迁出成为强制（静默回退不存在）；单宿主由标量 id 类型契约结构强制。 */
export function hostOf(world: World, anchor: string, opts: SpaceOpts = {}): string {
	const key = opts.vesselProp ?? "vessel";
	let cur: string | null = anchor;
	const seen = new Set<string>();
	while (cur != null && !seen.has(cur)) {
		seen.add(cur);
		const e = entity(world, cur);
		if (!e) break;
		if (e.props[key] === true) return cur;
		cur = (e.props["in"] as string | null) ?? null;
	}
	return anchor;
}

/** 容器包含树语义下的可见性：锚点可达的全部实体 + 场景（space）实体。 */
export function inTreeVisible(world: World, player: string, opts: SpaceOpts = {}): Set<string> {
	const vis = new Set<string>([player]);
	for (const e of world.entities) {
		if (e.props.space === true) vis.add(e.id);
		if (inTreeReach(world, player, e.id, opts).ok) vis.add(e.id);
	}
	return vis;
}

/** 可达性法则（卫语句工厂）：可达则弃权（交后续规则），不可达即拒绝（law "reach"，理由为构件世界腔）。
 *  法则是一等值：subject 显式绑定动词 schema 里的目标参数名——接线是一行可见调用，接线位置即优先级，
 *  例外法则插在其前；同一概念一个 law id，probe 的法则×动词矩阵以 id 为行，id 碎片化即矩阵失真。 */
export const reachLaw = (subject: string, opts: SpaceOpts = {}): Rule => ({
	id: "reach",
	judge: (q) => {
		const r = inTreeReach(q.world, q.player, String(q.params[subject]), opts);
		return r.ok ? null : { ok: false, denial: { law: "reach", reason: r.reason || REACH_MSGS.reachNotHere } };
	},
});

