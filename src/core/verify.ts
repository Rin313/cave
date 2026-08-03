import type { Delta, PropValue } from "./sim.ts";
import type { Expr, ExprCtx, Pred } from "./expr.ts";
import { evalExpr, matchPred } from "./expr.ts";

/** 软通道（fallback:"soft"）的提案：前置事实 + 期望后果。世界以约束校验（存在/可见/可达 + 访问级 + 类型 + 不变式）
 *  授予，不再做精确模板匹配——后果由 AI 提出、由世界按约束裁决。claims 只是"前置事实必须为真"的防谎。 */
export interface Proof {
	/** 前置事实：逐条对当前世界求值，全部成立才进入解析（可选，如材质/可达/持有断言）。 */
	claims: Pred[];
	/** 期望后果：经软通道写入 access:"soft" 的属性，结构性属性（law/readonly）一律被拒。 */
	desired: Delta[];
	/** 世界腔陈述（风味，授予时作为 reason 的缺省）。 */
	reason?: string;
}

/** 收集谓词/表达式中出现的实体 id（归因与 involved 用）。 */
export function collectEntityIds(ctx: ExprCtx, node: Pred | Expr, out: Set<string>): void {
	if (!("k" in node)) return;
	switch (node.k) {
		case "lit":
			if (typeof node.v === "string" && ctx.entityIds.includes(node.v)) out.add(node.v);
			break;
		case "var":
			if (ctx.entityIds.includes(node.name)) out.add(node.name);
			break;
		case "prop":
			collectEntityIds(ctx, node.e, out);
			break;
		case "sum":
		case "max":
		case "min":
			for (const x of node.xs) collectEntityIds(ctx, x, out);
			break;
		case "binop":
			collectEntityIds(ctx, node.a, out);
			collectEntityIds(ctx, node.b, out);
			break;
		case "roll":
			collectEntityIds(ctx, node.key, out);
			collectEntityIds(ctx, node.sides, out);
			break;
		case "reachReason":
			collectEntityIds(ctx, node.e, out);
			break;
		case "if":
			collectEntityIds(ctx, node.c, out);
			collectEntityIds(ctx, node.t, out);
			collectEntityIds(ctx, node.f, out);
			break;
		case "cmp":
			collectEntityIds(ctx, node.a, out);
			collectEntityIds(ctx, node.b, out);
			break;
		case "in":
			collectEntityIds(ctx, node.a, out);
			break;
		case "has":
		case "reach":
		case "exists":
			collectEntityIds(ctx, node.e, out);
			break;
		case "rel":
			collectEntityIds(ctx, node.from, out);
			collectEntityIds(ctx, node.to, out);
			if (node.b) collectEntityIds(ctx, node.b, out);
			break;
		case "and":
		case "or":
			for (const x of node.xs) collectEntityIds(ctx, x, out);
			break;
		case "not":
			collectEntityIds(ctx, node.p, out);
			break;
	}
}

const OP_WORDS: Record<string, string> = { eq: "等于", neq: "不等于", gte: "不小于", gt: "大于", lt: "小于", lte: "不大于" };

function fmtExpr(ctx: ExprCtx, e: Expr): string {
	if (e.k === "prop") {
		const id = String(evalExpr(ctx, e.e) ?? "");
		return `${ctx.name(id)}的${ctx.propLabel(e.p) ?? e.p}`;
	}
	if (e.k === "lit") {
		if (typeof e.v === "string" && ctx.entityIds.includes(e.v)) return ctx.name(e.v);
		return String(e.v);
	}
	if (e.k === "var") return ctx.name(String(evalExpr(ctx, e) ?? ""));
	if (e.k === "binop") return `(${fmtExpr(ctx, e.a)} ${e.op} ${fmtExpr(ctx, e.b)})`;
	if (e.k === "time") return "此刻";
	if (e.k === "roll") return `骰子(${fmtExpr(ctx, e.key)}, ${fmtExpr(ctx, e.sides)}面)`;
	return "…";
}

function fmtValue(ctx: ExprCtx, v: unknown): string {
	if (typeof v === "string" && ctx.entityIds.includes(v)) return ctx.name(v);
	return String(v);
}

/** 渲染不成立的断言为可读诊断（用实体名 + 属性世界化标签，审计与拒绝文案共用）。 */
export function describeClaim(ctx: ExprCtx, p: Pred): string {
	if (p.k === "and") {
		const inner = p.xs.find((x) => !matchPred(ctx, x));
		return inner ? describeClaim(ctx, inner) : "组合条件不成立";
	}
	if (p.k === "cmp") return `「${fmtExpr(ctx, p.a)} ${OP_WORDS[p.op] ?? p.op} ${fmtExpr(ctx, p.b)}」不成立（当前为 ${fmtValue(ctx, evalExpr(ctx, p.a))}）`;
	if (p.k === "reach") return `「够得到${fmtExpr(ctx, p.e)}」不成立`;
	if (p.k === "rel") return `「${p.type}关系」不成立`;
	if (p.k === "has") return `「${fmtExpr(ctx, p.e)} 具有 ${p.p}」不成立`;
	if (p.k === "in") return `「${fmtExpr(ctx, p.a)} 属于 [${p.set.map((s) => String(s)).join(", ")}]」不成立`;
	if (p.k === "or") return "多组条件均不成立";
	if (p.k === "not") return "否定条件不成立";
	return "条件不成立";
}
