import type { Delta, Denial, Fact, PropValue } from "./sim.ts";
import type { Effect, Expr, ExprCtx, Law, Pred } from "./expr.ts";
import { evalExpr, evaluateLaw, matchPred } from "./expr.ts";

/** 开放通道提案：前置事实 + 期望后果。世界经开放法则（Law.open）反向解析后授予——
 *  后果由法则产出（级联/不变式/痕迹照常生效），AI 的期望只作匹配目标，不直接写入。 */
export interface Proof {
	/** 前置事实：逐条对当前世界求值，全部成立才进入解析（可选，如材质/可达/持有断言）。 */
	claims: Pred[];
	/** 期望后果：世界会反查 open 法则，能由某法则的后果覆盖它才授予。 */
	desired: Delta[];
	/** 世界腔陈述（风味，授予时作为 reason 的缺省）。 */
	reason?: string;
}

export interface ResolveResult {
	granted: boolean;
	deltas?: Delta[];
	reason?: string;
	denial?: Denial;
	facts?: Fact[];
	involved?: string[];
	lawId?: string;
}

export interface VerifyOpts {
	/** 内部属性集（internalPropsOf(def)），proof 不得改动内部属性。 */
	internalProps: Set<string>;
}

const MAX_DESIRED = 8;

/** 收集谓词/表达式中出现的实体 id（归因与 involved 用）。 */
function collectEntityIds(ctx: ExprCtx, node: Pred | Expr, out: Set<string>): void {
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

/** delta 的目标实体 id（rel 变更为 from 端点）。 */
function deltaTarget(d: Delta): string {
	switch (d.op) {
		case "relSet":
		case "relInc":
		case "relDel":
			return d.from;
		case "spawn":
			return d.id ?? "";
		case "destroy":
		case "set":
		case "inc":
		case "push":
		case "del":
			return d.entity;
	}
}

function fmtExpr(ctx: ExprCtx, e: Expr): string {
	if (e.k === "prop") {
		const id = String(evalExpr(ctx, e.e) ?? "");
		return `${ctx.name(id)}的${ctx.propLabel(e.p) ?? e.p}`;
	}
	if (e.k === "lit") {
		if (typeof e.v === "string" && ctx.entityIds.includes(e.v)) return ctx.name(e.v);
		return String(e.v);
	}
	if (e.k === "var") return ctx.name(String(ctx.env[e.name] ?? ""));
	return "…";
}

function fmtValue(ctx: ExprCtx, v: unknown): string {
	if (typeof v === "string" && ctx.entityIds.includes(v)) return ctx.name(v);
	return String(v);
}

/** 渲染不成立的断言为可读诊断（用实体名 + 属性世界化标签，审计与拒绝文案共用）。 */
function describeClaim(ctx: ExprCtx, p: Pred): string {
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

/** 绑定表达式：var → 绑定值；lit → 值必须相等；其他形态 P1 不支持反向绑定（返回 false）。 */
function bindExpr(x: Expr, v: PropValue | undefined, bind: Record<string, PropValue>): boolean {
	if (x.k === "var") {
		if (v !== undefined) bind[x.name] = v;
		return true;
	}
	if (x.k === "lit") return v !== undefined && x.v === v;
	return false;
}

/** 效果模板 × 期望后果的形状匹配：op/prop/type 静态字段一致，且实体/值表达式可解出绑定。 */
function effectBindings(ef: Effect, d: Delta): Record<string, PropValue> | null {
	const bind: Record<string, PropValue> = {};
	if (ef.op === "set" || ef.op === "inc" || ef.op === "push" || ef.op === "del") {
		if (d.op !== ef.op) return null;
		if (ef.op !== "del" && (d as { prop: string }).prop !== ef.p) return null;
		if (!bindExpr(ef.e, (d as { entity: string }).entity, bind)) return null;
		if (ef.op === "set" || ef.op === "push") {
			if (!bindExpr((ef as { v: Expr }).v, (d as { value: PropValue }).value, bind)) return null;
		} else if (ef.op === "inc") {
			if (!bindExpr((ef as { by: Expr }).by, (d as { by: number }).by, bind)) return null;
		}
		return bind;
	}
	if (ef.op === "relSet" || ef.op === "relInc" || ef.op === "relDel") {
		if (d.op !== ef.op) return null;
		if ((d as { type: string }).type !== ef.type) return null;
		if (!bindExpr(ef.from, (d as { from: string }).from, bind)) return null;
		if (!bindExpr(ef.to, (d as { to: string }).to, bind)) return null;
		if (ef.op === "relSet") {
			if (!bindExpr((ef as { v: Expr }).v, (d as { value: PropValue }).value, bind)) return null;
		} else if (ef.op === "relInc") {
			if (!bindExpr((ef as { by: Expr }).by, (d as { by: number }).by, bind)) return null;
		}
		return bind;
	}
	// spawn / destroy / if：不能作为期望后果匹配
	return null;
}

/** 由期望后果推导出法则效果模板可解的变量绑定候选；无法则效果能产出该期望则返回空。 */
function deriveEnv(desired: Delta[], law: Law): Record<string, PropValue>[] {
	let envs: Record<string, PropValue>[] = [{}];
	for (const d of desired) {
		const next: Record<string, PropValue>[] = [];
		let hit = false;
		for (const ef of law.each ?? []) {
			const b = effectBindings(ef, d);
			if (!b) continue;
			hit = true;
			for (const env of envs) {
				let merged = { ...env };
				let ok = true;
				for (const [k, v] of Object.entries(b)) {
					if (k in merged && merged[k] !== v) {
						ok = false;
						break;
					}
					merged[k] = v;
				}
				if (ok) next.push(merged);
			}
		}
		if (!hit) return [];
		envs = next;
		if (!envs.length) return [];
	}
	return envs;
}

function sameDelta(a: Delta, b: Delta): boolean {
	switch (a.op) {
		case "set":
			return b.op === "set" && a.entity === b.entity && a.prop === b.prop && a.value === b.value;
		case "inc":
			return b.op === "inc" && a.entity === b.entity && a.prop === b.prop && a.by === b.by;
		case "push":
			return b.op === "push" && a.entity === b.entity && a.prop === b.prop && a.value === b.value;
		case "del":
			return b.op === "del" && a.entity === b.entity && a.prop === b.prop;
		case "relSet":
			return b.op === "relSet" && a.from === b.from && a.to === b.to && a.type === b.type && a.value === b.value;
		case "relInc":
			return b.op === "relInc" && a.from === b.from && a.to === b.to && a.type === b.type && a.by === b.by;
		case "relDel":
			return b.op === "relDel" && a.from === b.from && a.to === b.to && a.type === b.type;
		case "spawn":
		case "destroy":
			return false;
	}
}

/** 期望后果是否全部被法则产出的后果覆盖（法则可产出额外后果——那正是重量）。 */
function covers(produced: Delta[], desired: Delta[]): boolean {
	return desired.every((d) => produced.some((p) => sameDelta(p, d)));
}

function involvedFrom(deltas: Delta[], facts: Fact[] | undefined, claims: Pred[], ctx: ExprCtx): string[] {
	const s = new Set<string>();
	for (const d of deltas) {
		const t = deltaTarget(d);
		if (t) s.add(t);
		if ("to" in d) s.add((d as { to: string }).to);
	}
	for (const f of facts ?? []) for (const e of f.entities) s.add(e);
	for (const c of claims) collectEntityIds(ctx, c, s);
	return [...s];
}

/** 开放通道裁决：前置事实全部为真 + 安全约束 + 在 open 法则中反查「能产出期望后果」。
 *  命中 → 用该法则的完整后果提交（级联/不变式/痕迹由模拟层负责）；未命中 → granted:false（由调用方落 denyAll）。 */
export function resolveUnscripted(ctx: ExprCtx, laws: Law[], proof: Proof, opts: VerifyOpts): ResolveResult {
	const { claims = [], desired = [] } = proof;
	if (!desired.length) return { granted: false, denial: { law: "proof.fail", debug: "没有期望后果（desired 为空）。" } };
	if (desired.length > MAX_DESIRED) return { granted: false, denial: { law: "proof.fail", debug: `期望后果过多（超过 ${MAX_DESIRED} 条）。` } };
	for (const d of desired) {
		if (d.op === "spawn" || d.op === "destroy") {
			return { granted: false, denial: { law: "proof.fail", debug: "实体的产生与销毁须经法则，不能经此通道。" } };
		}
		const id = deltaTarget(d);
		// 失败诊断不进玩家文案（Denial.debug 是审计用；proof.fail 模板须自行决定是否复用）——这里一律不泄漏原始 id / 内部属性名。
		if (!ctx.entityIds.includes(id)) return { granted: false, denial: { law: "proof.fail", debug: "所指实体不存在。" } };
		if (!ctx.visibleIds.includes(id)) return { granted: false, denial: { law: "proof.fail", debug: `「${ctx.name(id)}」不在可见范围。` } };
		if ((d.op === "set" || d.op === "inc" || d.op === "push" || d.op === "del") && opts.internalProps.has(d.prop)) {
			return { granted: false, denial: { law: "proof.fail", debug: "内部属性不能经此通道改动。" } };
		}
	}
	for (const p of claims) {
		if (!matchPred(ctx, p)) return { granted: false, denial: { law: "proof.fail", debug: `断言不成立：${describeClaim(ctx, p)}` } };
	}
	for (const law of laws) {
		const envs = deriveEnv(desired, law);
		if (!envs.length) continue;
		for (const env of envs) {
			const res = evaluateLaw({ ...ctx, env: { ...ctx.env, ...env } }, law);
			if (res.granted && covers(res.deltas ?? [], desired)) {
				return {
					granted: true,
					deltas: res.deltas,
					reason: res.reason ?? proof.reason,
					facts: res.facts,
					involved: involvedFrom(res.deltas ?? [], res.facts, claims, ctx),
					lawId: law.id,
				};
			}
		}
	}
	return { granted: false };
}
