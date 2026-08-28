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

/** 本回合涉及集 ∪ 变更/即将发生实体：rel 变更的完整边端点双向进集；
 *  prop 变更的字符串值（id 型属性引用，如 in 的旧值/新值）同进——边值等非引用值不是实体，不进。 */
function touchedFrom(ctx: DeclCtx): Set<string> {
	const touched = new Set<string>(ctx.involved);
	for (const c of [...ctx.changes, ...ctx.pending]) {
		if (c.kind === "rel") {
			touched.add(c.from);
			touched.add(c.to);
			continue;
		}
		touched.add(c.entity);
		if (c.kind === "prop") {
			if (typeof c.prev === "string") touched.add(c.prev);
			if (typeof c.next === "string") touched.add(c.next);
		}
	}
	return touched;
}

/** 本回合声明契约允许的实体 id 全集（touched 集推导，供表达侧展示可声明词汇表）。 */
export function touchedIds(ctx: DeclCtx): string[] {
	return [...touchedFrom(ctx)];
}

/** 结构化事实：declare 工具提交的形态（实体 id 列表 + 世界腔陈述）。 */
export interface StructuredFact {
	entities: string[];
	statement: string;
}

/** 声明契约核心校验：事实实体必须可见且属本回合涉及集
 *  （touched：player——体验者角色的缺省 + 法则 facts + 新见 + 变更/即将发生 + 授予动作参数
 *  + 被拒动作中被结构化亲证的实体（Denial.subject/object，仅可见者——被拒 ≠ 不亲证）；其余被拒参数排除——映射层的猜测未获亲证）；无名字回退。
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
