// 表达层声明契约（core 单一来源）：把模型首行 [facts: ...] 的声明与散文体拆分、并按契约校验。
// 两种契约：
//   - prose（缺省）：事实为自然语言，名字子串 + 最长命中归属（validateDeclA）。
//   - structured：事实写作 [id1,id2]: 陈述，按实体 id 精确集合校验（validateDeclB strict），无名字回退。
// 泄漏检查与涉及集（touched）推导在此共享，engine 不重复实现。
import type { Change, PropDef, World } from "./sim.ts";

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

/** 泄漏检查依赖的窄化 def 视角（仅读 forbiddenTerms 与 props 注册表）。 */
export type NarrowDef = { forbiddenTerms?: string[]; props?: Record<string, PropDef> };

/** 通用泄漏检查：只禁止与语言无关的实现工件（JSON 形态 / 声明头复现 / 实现形状标识符）。 */
export function leakageCheck(text: string, world: World, def: NarrowDef): string | null {
	if (/"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*(?=["{[]|true|false|null|-?\d)/.test(text)) return "出现了工具调用或状态格式（JSON 键）。";
	if (text.includes("[facts:")) return "正文中出现了声明头 [facts: ...]。";
	const isImplShape = (s: string) => !/^[a-z]+$/.test(s);
	const forbidden = new Set<string>();
	for (const e of world.entities) {
		if (isImplShape(e.id) && !e.name.toLowerCase().includes(e.id.toLowerCase())) forbidden.add(e.id);
		for (const k of Object.keys(e.props)) if (isImplShape(k)) forbidden.add(k);
	}
	for (const t of def.forbiddenTerms ?? []) forbidden.add(t);
	for (const t of forbidden) {
		const hit = /[^\x00-\x7F]/.test(t) ? text.includes(t) : new RegExp(`\\b${t}\\b`).test(text);
		if (hit) return `出现了实体 id 或实现术语：「${t}」。`;
	}
	return null;
}

export interface DeclCtx {
	world: World;
	def: NarrowDef;
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

/** 名字子串最长命中归属：对一条事实找出最长的命中实体名（防止「伯爵」⊂「伯爵夫人」误判）。 */
export function matchLongest(fact: string, world: World, visible: Set<string>): { id: string; name: string } | null {
	let matched: { id: string; name: string } | null = null;
	for (const e of world.entities) {
		if (!visible.has(e.id)) continue;
		if (fact.includes(e.id) || fact.includes(e.name)) {
			if (!matched || e.name.length > matched.name.length) matched = { id: e.id, name: e.name };
		}
	}
	return matched;
}

/** prose 契约：名字子串校验（引擎默认路径）。 */
export function validateDeclA(decl: Decl, ctx: DeclCtx): string | null {
	if (!decl.body.trim()) return "散文为空。";
	if (!decl.facts.length) return null;
	const touched = touchedFrom(ctx);
	for (const f of decl.facts) {
		const matched = matchLongest(f, ctx.world, ctx.visible);
		if (matched && !touched.has(matched.id)) {
			return `声明「${f}」提及了实体「${matched.name}」，但本回合并未涉及该实体——新事实只能来自本回合变更/法则事实/即将发生/本回合涉及实体。`;
		}
		const leaked = leakageCheck(f, ctx.world, ctx.def);
		if (leaked) return `声明「${f}」中：${leaked}`;
	}
	return null;
}

/** prose 契约 + 不可见实体检查：在 A 之上对全部实体做最长命中，命中不可见实体即拒（堵静默放行洞）。 */
export function validateDeclAInv(decl: Decl, ctx: DeclCtx): string | null {
	if (!decl.body.trim()) return "散文为空。";
	if (!decl.facts.length) return null;
	const touched = touchedFrom(ctx);
	const allIds = new Set(ctx.world.entities.map((e) => e.id));
	for (const f of decl.facts) {
		const matched = matchLongest(f, ctx.world, allIds);
		if (matched) {
			if (!ctx.visible.has(matched.id)) return `声明「${f}」提及了不可见实体「${matched.name}」。`;
			if (!touched.has(matched.id)) {
				return `声明「${f}」提及了实体「${matched.name}」，但本回合并未涉及该实体——新事实只能来自本回合变更/法则事实/即将发生/本回合涉及实体。`;
			}
		}
		const leaked = leakageCheck(f, ctx.world, ctx.def);
		if (leaked) return `声明「${f}」中：${leaked}`;
	}
	return null;
}

export interface FactIds {
	ids: string[];
	rest: string;
}

/** 解析结构化事实前缀：`id: 陈述` 或 `[id1,id2]: 陈述`。id 假定为 ASCII 实体 id。 */
export function parseFactIds(fact: string): FactIds | null {
	const multi = /^\[([^\]]+)\]\s*[:：]\s*(.+)$/.exec(fact);
	if (multi) {
		const ids = multi[1]!.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
		if (ids.length) return { ids, rest: multi[2]!.trim() };
	}
	const single = /^([A-Za-z_][A-Za-z0-9_-]*)\s*[:：]\s*(.+)$/.exec(fact);
	if (single) return { ids: [single[1]!], rest: single[2]!.trim() };
	return null;
}

export type BMode = "strict" | "hybrid";

/** structured 契约：按实体 id 精确集合校验。strict=未带 id 前缀即拒；hybrid=回退名字匹配（研究用，未接线）。 */
export function validateDeclB(decl: Decl, ctx: DeclCtx, mode: BMode): string | null {
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
			const leaked = leakageCheck(parsed.rest, ctx.world, ctx.def);
			if (leaked) return `声明「${f}」中：${leaked}`;
			continue;
		}
		if (mode === "strict") return `声明「${f}」缺少实体 id 声明（应写作 实体id: 陈述 或 [id1,id2]: 陈述）。`;
		const matched = matchLongest(f, ctx.world, ctx.visible);
		if (matched && !touched.has(matched.id)) {
			return `声明「${f}」提及了实体「${matched.name}」，但本回合并未涉及该实体——新事实只能来自本回合变更/法则事实/即将发生/本回合涉及实体。`;
		}
		const leaked = leakageCheck(f, ctx.world, ctx.def);
		if (leaked) return `声明「${f}」中：${leaked}`;
	}
	return null;
}
