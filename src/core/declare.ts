// 表达层声明契约核心（core 单一来源）：declare 工具提交的结构化新事实按实体 id 精确集合校验，
// 无名字回退。涉及集（touched）推导与校验在此共享，engine/工具不重复实现。
import type { Change, World } from "./sim.ts";

export interface DeclCtx {
	world: World;
	visible: Set<string>;
	involved: Set<string>;
	changes: Change[];
	pending: Change[];
	/** 本回合消逝的实体（despawn）：叙述其消失合法，豁免可见性检查。 */
	vanished?: Set<string>;
}

/** 本回合涉及集 ∪ 变更/即将发生实体（rel 变更按字符串编码解析对端，见 sim.ts 的 rel:type@to）。 */
function touchedFrom(ctx: DeclCtx): Set<string> {
	const touched = new Set<string>(ctx.involved);
	const relTo = (prop: string): string | null => /^rel:([^@]+)@(.+)$/.exec(prop)?.[1] ?? null;
	for (const c of [...ctx.changes, ...ctx.pending]) {
		touched.add(c.entity);
		const relT = relTo(c.prop);
		if (relT && ctx.world.entities.some((e) => e.id === relT)) touched.add(relT);
		if (typeof c.from === "string") touched.add(c.from);
		if (typeof c.to === "string") touched.add(c.to);
	}
	return touched;
}

/** 结构化事实：declare 工具提交的形态（实体 id 列表 + 世界腔陈述）。 */
export interface StructuredFact {
	entities: string[];
	statement: string;
}

/** 声明契约核心校验：事实实体必须可见且属本回合涉及集
 *  （touched：actor + 法则 facts + 新见 + 变更/即将发生 + 授予动作参数，被拒动作参数排除）；无名字回退。
 *  返回逐条错误列表（null = 通过）。 */
export function validateFactIds(facts: StructuredFact[], ctx: DeclCtx): string[] | null {
	if (!facts.length) return null;
	const touched = touchedFrom(ctx);
	const errors: string[] = [];
	for (const f of facts) {
		if (!f.entities.length) {
			errors.push(`声明「${f.statement}」缺少实体 id。`);
			continue;
		}
		for (const id of f.entities) {
			const e = ctx.world.entities.find((x) => x.id === id);
			if ((!e || !ctx.visible.has(id)) && !ctx.vanished?.has(id)) {
				errors.push(`声明「${f.statement}」提及了不存在的实体「${id}」。`);
				continue;
			}
			if (!touched.has(id)) errors.push(`声明「${f.statement}」提及了未涉及的实体「${e?.name ?? id}」。`);
		}
	}
	return errors.length ? errors : null;
}
