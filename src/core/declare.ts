// 表达层声明契约（core 单一来源）：把模型首行 [facts: ...] 的声明与散文体拆分，并按结构化契约校验。
// 唯一契约 structured：事实必须带实体 id 前缀（id: / id1,id2: / [id1,id2]:），按实体 id 精确集合校验，
// 无名字回退（prose 契约的名字子串匹配已移除，实证见 ARCHITECTURE §5-10 与实验记录）。
// 声明头的解析、校验与涉及集（touched）推导在此共享，engine 不重复实现。
import type { Change, World } from "./sim.ts";

export interface Decl {
	facts: string[];
	body: string;
}

/** 拆分首行 [facts: ...] 声明与散文体；无声明头返回 null。
 *  事实内容允许内嵌方括号（结构化契约的 [id1,id2]: 多实体写法），故括号组内不截断，仅以声明头的收尾 ] 为界。 */
export function parseDeclaration(text: string): Decl | null {
	const m = text.match(/^\s*\[facts:\s*((?:[^\[\]]|\[[^\]]*\])*)\]\s*\n?/);
	if (!m) return null;
	const facts = (m[1] ?? "").split(/[；;]/).map((s) => s.trim()).filter(Boolean);
	return { facts, body: text.slice(m[0].length).trim() };
}

export interface DeclCtx {
	world: World;
	visible: Set<string>;
	involved: Set<string>;
	changes: Change[];
	pending: Change[];
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

/** 名字子串最长命中归属与 prose 契约（validateDeclA / validateDeclAInv）已移除：
 *  名字子串 + 近邻窗口对"新事实归属"结构性失效（ARCHITECTURE §5-10），structured 契约以显式 id 集合校验取代。 */

export interface FactIds {
	ids: string[];
	rest: string;
}

/** 解析结构化事实前缀：`id: 陈述`、`id1,id2: 陈述` 或带括号 `[id1,id2]: 陈述`。id 假定为 ASCII 实体 id。
 *  接受裸逗号分隔（模型自然输出的 `merchant,player:` 形态）与括号形态，二者等价——归一化而非强推括号格式；
 *  仍拒绝无 id 前缀的事实（strict 语义不变：无 id 即拒，无名字回退）。 */
export function parseFactIds(fact: string): FactIds | null {
	const idsOf = (s: string): string[] | null => {
		const ids = s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
		return ids.length ? ids : null;
	};
	const multi = /^\[([^\]]+)\]\s*[:：]\s*(.+)$/.exec(fact);
	if (multi) {
		const ids = idsOf(multi[1]!);
		if (ids) return { ids, rest: multi[2]!.trim() };
	}
	const bare = /^([A-Za-z_][A-Za-z0-9_,，\s-]*)\s*[:：]\s*(.+)$/.exec(fact);
	if (bare) {
		const ids = idsOf(bare[1]!);
		if (ids) return { ids, rest: bare[2]!.trim() };
	}
	return null;
}

/** 结构化契约（唯一契约）：按实体 id 精确集合校验——每条事实必须带实体 id 前缀（`id: 陈述` / `id1,id2: 陈述` / `[id1,id2]: 陈述`），
 *  id 必须可见且属本回合涉及集（touched：actor + 法则 facts + 新见 + 变更/即将发生 + 授予动作参数，被拒动作参数排除）；无名字回退。 */
export function validateDecl(decl: Decl, ctx: DeclCtx): string | null {
	if (!decl.body.trim()) return "散文为空。";
	if (!decl.facts.length) return null;
	const touched = touchedFrom(ctx);
	for (const f of decl.facts) {
		const parsed = parseFactIds(f);
		if (parsed) {
			for (const id of parsed.ids) {
				const e = ctx.world.entities.find((x) => x.id === id);
				if (!e || !ctx.visible.has(id)) return `声明「${f}」提及了不存在的实体「${id}」。`;
				if (!touched.has(id)) return `声明「${f}」提及了未涉及的实体「${e.name}」。`;
			}
			continue;
		}
		return `声明「${f}」缺少实体 id 声明（应写作 实体id: 陈述 或 id1,id2: 陈述 或 [id1,id2]: 陈述）。`;
	}
	return null;
}
