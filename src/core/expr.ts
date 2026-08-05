import type { Delta, Denial, Fact, PropValue } from "./sim.ts";

/** 值表达式：字面量 / 变量绑定 / 实体属性 / 算术 / 条件 / 确定性骰子。纯函数，可在法则与断言核验间共享。
 *  var 解析回退：env 无绑定且名字命中实体 id 时视为字面量 id（常量实体可直接 E.p("flour","in")，无需 E.prop(E.lit(...))）。 */
export type Expr =
	| { k: "lit"; v: PropValue }
	| { k: "var"; name: string }
	| { k: "prop"; e: Expr; p: string }
	| { k: "sum"; xs: Expr[] }
	| { k: "max"; xs: Expr[] }
	| { k: "min"; xs: Expr[] }
	| { k: "binop"; op: BinOp; a: Expr; b: Expr }
	| { k: "if"; c: Pred; t: Expr; f: Expr }
	| { k: "reachReason"; e: Expr }
	| { k: "time" }
	| { k: "roll"; key: Expr; sides: Expr };

/** 二元算术：数值表达式（era 数值表：价格、伤害、成长公式）。/ 与 % 除零返回 null。 */
export type BinOp = "+" | "-" | "*" | "/" | "%";

/** 谓词：可机械核验的条件。法则 when/denies 与断言核验共用同一求值器。 */
export type Pred =
	| { k: "cmp"; a: Expr; op: "eq" | "neq" | "gte" | "gt" | "lt" | "lte"; b: Expr }
	| { k: "in"; a: Expr; set: PropValue[] }
	| { k: "has"; e: Expr; p: string }
	| { k: "exists"; e: Expr }
	| { k: "reach"; e: Expr }
	| { k: "rel"; from: Expr; to: Expr; type: string; op?: "eq" | "neq" | "gte" | "gt" | "lt" | "lte"; b?: Expr }
	| { k: "and"; xs: Pred[] }
	| { k: "or"; xs: Pred[] }
	| { k: "not"; p: Pred };

/** 求值上下文：世界访问全部注入，expr 层不直接触碰 World（零运行时依赖 sim）。 */
export interface ExprCtx {
	actor: string;
	/** 变量绑定（动作参数 / 量词）。 */
	env: Record<string, PropValue>;
	/** 实体属性读取（含点路径；缺省 null）。 */
	prop: (id: string, path: string) => PropValue;
	/** 属性存在判定（键存在，值可为 null）。 */
	hasProp: (id: string, path: string) => boolean;
	/** 可达性判定（游戏容器放行等选项由调用方注入）。 */
	reach: (id: string) => boolean;
	/** 关系值读取（from→to 的 type，无则 null）。 */
	rel: (from: string, to: string, type: string) => PropValue;
	/** 可达性拒绝理由（不可达时返回具体原因，可达返回 null）。 */
	reachReason: (id: string) => string | null;
	/** 实体展示名。 */
	name: (id: string) => string;
	/** 属性世界化标签（诊断/拒绝文案用；无则 undefined）。 */
	propLabel: (prop: string) => string | undefined;
	/** 全部实体 id 列表（over 枚举用）。 */
	entityIds: string[];
	/** 可见实体 id 列表（over 枚举用）。 */
	visibleIds: string[];
	/** 确定性骰子：从 World 派生（hashStr(`${world.time}#${key}`)），纯函数——check/apply/dryTick 一致。
	 *  key 需在同 tick 内唯一（含实体 id 或自持计数器，如 `dog.bite#${id}`）。 */
	roll: (key: string, sides: number) => number;
	/** 当前时刻（world.time）：时段调度（夜/日）读取。 */
	time: number;
}

/** 效果模板：法则 each 部分。e/from/to 求值为实体 id，v/by 求值为值。 */
export type Effect =
	| { op: "set"; e: Expr; p: string; v: Expr }
	| { op: "inc"; e: Expr; p: string; by: Expr }
	| { op: "push"; e: Expr; p: string; v: Expr }
	| { op: "del"; e: Expr; p: string }
	| { op: "relSet"; from: Expr; to: Expr; type: string; v: Expr }
	| { op: "relInc"; from: Expr; to: Expr; type: string; by: Expr }
	| { op: "relDel"; from: Expr; to: Expr; type: string }
	| { op: "spawn"; kind: string; name: Expr; props?: Record<string, Expr>; id?: Expr }
	| { op: "destroy"; e: Expr }
	| { op: "if"; c: Pred[]; then: Effect[] };

/** 世界腔拒绝文案的输入：已解析的实体 id / 属性名。
 *  不含 reason——text 只在 reason Expr 缺席或为空时被调用，args 里的 reason 恒为 undefined。 */
export interface DenialArgs {
	subject?: string;
	object?: string;
	prop?: string;
}

/** 结构化拒绝定义：subject/object/prop 求值为实体 id/属性名，世界腔文案由 text 内联渲染（取代 GameDef.denialTemplates）。 */
export interface DenialDef {
	law: string;
	subject?: Expr;
	object?: Expr;
	prop?: Expr;
	reason?: Expr;
	/** 世界腔拒绝文案（内联，取代 GameDef.denialTemplates 并行映射）：args 为解析后的 id/属性名，ctx 提供 name/propLabel。
	 *  与 reason Expr 同时给出时 reason 优先（与旧 renderDenial 的优先级一致）；缺省回落到 GameDef.messages.noResponse。 */
	text?: (args: DenialArgs, ctx: ExprCtx) => string;
}

/** 量词：tick 系统按此枚举候选实体（动作法则无需 over，参数即绑定）。 */
export interface Over {
	var: string;
	source: "entities" | "visible";
	/** 候选过滤（可引用此前已绑定的变量，作剪枝用）。 */
	where?: Pred[];
}

/** 法则：条件 + 后果 + 拒绝。when 全部成立 → 提交 each；reject 先行（前置拒绝）；否则按序匹配 denies。 */
export interface Law {
	id: string;
	over?: Over[];
	/** 前置拒绝：成立即拒绝（不参与授予），用于可达性/可持握等公共前提。 */
	reject?: { when: Pred[]; denial: DenialDef };
	when?: Pred[];
	each?: Effect[];
	denies?: { when: Pred[]; denial: DenialDef }[];
	/** 世界腔授予陈述（风味，缺省用 GameDef.messages.defaultReason）。 */
	reason?: (ctx: ExprCtx) => string | undefined;
	/** 世界腔事实（风味；进表达层合法新事实词汇；ctx.env 为当前绑定）。 */
	facts?: (ctx: ExprCtx) => Fact[];
}

export interface LawResult {
	granted: boolean;
	deltas?: Delta[];
	reason?: string;
	involved?: string[];
	denial?: Denial;
	facts?: Fact[];
}

function num(v: PropValue): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : NaN;
}

export function evalExpr(ctx: ExprCtx, e: Expr): PropValue {
	switch (e.k) {
		case "lit":
			return e.v;
		case "var": {
			const v = ctx.env[e.name];
			if (v !== undefined) return v;
			return ctx.entityIds.includes(e.name) ? e.name : null;
		}
		case "prop": {
			const id = String(evalExpr(ctx, e.e) ?? "");
			return ctx.prop(id, e.p);
		}
		case "sum":
			return e.xs.reduce((acc, x) => acc + num(evalExpr(ctx, x)), 0);
		case "max": {
			let m = -Infinity;
			for (const x of e.xs) {
				const n = num(evalExpr(ctx, x));
				if (n > m) m = n;
			}
			return m === -Infinity ? null : m;
		}
		case "min": {
			let m = Infinity;
			for (const x of e.xs) {
				const n = num(evalExpr(ctx, x));
				if (n < m) m = n;
			}
			return m === Infinity ? null : m;
		}
		case "binop": {
			const a = num(evalExpr(ctx, e.a));
			const b = num(evalExpr(ctx, e.b));
			if (Number.isNaN(a) || Number.isNaN(b)) return null;
			switch (e.op) {
				case "+": return a + b;
				case "-": return a - b;
				case "*": return a * b;
				case "/": return b === 0 ? null : a / b;
				case "%": return b === 0 ? null : a % b;
			}
			return null;
		}
		case "if":
			return matchPred(ctx, e.c) ? evalExpr(ctx, e.t) : evalExpr(ctx, e.f);
		case "reachReason": {
			const id = String(evalExpr(ctx, e.e) ?? "");
			return ctx.reachReason(id) ?? "";
		}
		case "time":
			return ctx.time;
		case "roll": {
			const key = String(evalExpr(ctx, e.key) ?? "");
			const sides = Math.max(1, Math.floor(num(evalExpr(ctx, e.sides)) || 1));
			return ctx.roll(key, sides);
		}
	}
}

export function matchPred(ctx: ExprCtx, p: Pred): boolean {
	switch (p.k) {
		case "cmp": {
			const a = evalExpr(ctx, p.a);
			const b = evalExpr(ctx, p.b);
			if (p.op === "eq") return a === b;
			if (p.op === "neq") return a !== b;
			const x = num(a);
			const y = num(b);
			if (Number.isNaN(x) || Number.isNaN(y)) return false;
			if (p.op === "gte") return x >= y;
			if (p.op === "gt") return x > y;
			if (p.op === "lt") return x < y;
			if (p.op === "lte") return x <= y;
			return false;
		}
		case "in": {
			const a = evalExpr(ctx, p.a);
			return p.set.some((v) => v === a);
		}
		case "has": {
			const id = String(evalExpr(ctx, p.e) ?? "");
			return ctx.hasProp(id, p.p);
		}
		case "exists": {
			const id = String(evalExpr(ctx, p.e) ?? "");
			return ctx.entityIds.includes(id);
		}
		case "reach": {
			const id = String(evalExpr(ctx, p.e) ?? "");
			return ctx.reach(id);
		}
		case "rel": {
			const from = String(evalExpr(ctx, p.from) ?? "");
			const to = String(evalExpr(ctx, p.to) ?? "");
			const b = p.b ? evalExpr(ctx, p.b) : null;
			const v = ctx.rel(from, to, p.type);
			if (!p.op) return v !== null;
			if (p.op === "eq") return v === b;
			if (p.op === "neq") return v !== b;
			// 排序比较：缺失的边按 0 参与（与 cmp 对缺失数值属性的行为一致，Number(null)===0）。
			// 否则「信任 < 3」在信任边不存在时求值为 false，作者的自然表达会静默落到 denyAll 兜底。
			const x = num(v ?? 0);
			const y = num(b);
			if (Number.isNaN(x) || Number.isNaN(y)) return false;
			if (p.op === "gte") return x >= y;
			if (p.op === "gt") return x > y;
			if (p.op === "lt") return x < y;
			if (p.op === "lte") return x <= y;
			return false;
		}
		case "and":
			return p.xs.every((x) => matchPred(ctx, x));
		case "or":
			return p.xs.some((x) => matchPred(ctx, x));
		case "not":
			return !matchPred(ctx, p.p);
	}
}

function str(ctx: ExprCtx, e: Expr): string {
	return String(evalExpr(ctx, e) ?? "");
}

export function evalEffect(ctx: ExprCtx, ef: Effect): Delta[] {
	switch (ef.op) {
		case "set":
			return [{ op: "set", entity: str(ctx, ef.e), prop: ef.p, value: evalExpr(ctx, ef.v) }];
		case "inc":
			return [{ op: "inc", entity: str(ctx, ef.e), prop: ef.p, by: Number(evalExpr(ctx, ef.by) ?? 0) }];
		case "push":
			return [{ op: "push", entity: str(ctx, ef.e), prop: ef.p, value: evalExpr(ctx, ef.v) }];
		case "del":
			return [{ op: "del", entity: str(ctx, ef.e), prop: ef.p }];
		case "relSet":
			return [{ op: "relSet", from: str(ctx, ef.from), to: str(ctx, ef.to), type: ef.type, value: (evalExpr(ctx, ef.v) ?? "") as string | number | boolean }];
		case "relInc":
			return [{ op: "relInc", from: str(ctx, ef.from), to: str(ctx, ef.to), type: ef.type, by: Number(evalExpr(ctx, ef.by) ?? 0) }];
		case "relDel":
			return [{ op: "relDel", from: str(ctx, ef.from), to: str(ctx, ef.to), type: ef.type }];
		case "spawn": {
			const props: Record<string, PropValue> = {};
			for (const [k, v] of Object.entries(ef.props ?? {})) props[k] = evalExpr(ctx, v);
			return ef.id
				? [{ op: "spawn", id: str(ctx, ef.id), kind: ef.kind, name: str(ctx, ef.name), props }]
				: [{ op: "spawn", kind: ef.kind, name: str(ctx, ef.name), props }];
		}
		case "destroy":
			return [{ op: "destroy", entity: str(ctx, ef.e) }];
		case "if":
			return ef.c.every((p) => matchPred(ctx, p)) ? ef.then.flatMap((x) => evalEffect(ctx, x)) : [];
	}
}

function collectInvolved(deltas: Delta[], facts: Fact[] = []): string[] {
	const s = new Set<string>();
	for (const d of deltas) {
		if ("entity" in d) s.add((d as { entity: string }).entity);
		if ("from" in d) s.add((d as { from: string }).from);
		if ("to" in d) s.add((d as { to: string }).to);
		if (d.op === "spawn" && d.id) s.add(d.id);
	}
	for (const f of facts) for (const e of f.entities) s.add(e);
	return [...s];
}

/** 单次匹配求值：when 全成立则产出后果与风味事实。 */
function evalMatch(ctx: ExprCtx, law: Law): { deltas: Delta[]; facts: Fact[]; reason?: string } | null {
	if (!(law.when ?? []).every((p) => matchPred(ctx, p))) return null;
	return {
		deltas: (law.each ?? []).flatMap((ef) => evalEffect(ctx, ef)),
		facts: law.facts ? law.facts(ctx) : [],
		reason: law.reason ? law.reason(ctx) : undefined,
	};
}

/** 量词枚举：按 over 顺序绑定变量，对每个绑定调用 cb（返回 true 停止）。
 *  over 变量若已在 env 中绑定（软通道反查给出的目标），直接用既有绑定并过 where 过滤，
 *  不满足则该绑定作废——否则第一匹配者会抢走期望目标。 */
function forEachBinding(ctx: ExprCtx, over: Over[], cb: (env: Record<string, PropValue>) => boolean): boolean {
	const gen = (idx: number, env: Record<string, PropValue>): boolean => {
		if (idx === over.length) return cb(env);
		const o = over[idx]!;
		const pre = env[o.var];
		if (pre !== undefined) {
			if ((o.where ?? []).every((p) => matchPred({ ...ctx, env }, p))) return gen(idx + 1, env);
			return false;
		}
		const ids = o.source === "visible" ? ctx.visibleIds : ctx.entityIds;
		for (const id of ids) {
			const env2 = { ...env, [o.var]: id };
			if ((o.where ?? []).every((p) => matchPred({ ...ctx, env: env2 }, p))) {
				if (gen(idx + 1, env2)) return true;
			}
		}
		return false;
	};
	return gen(0, ctx.env);
}

interface Match {
	deltas: Delta[];
	facts: Fact[];
	reason?: string;
}

/** 法则求值：动作裁决（collect=false）与 tick 系统（collect=true）共用的单一解释器。
 *  - 动作模式：reject 先行 → 量词枚举首个授予即裁决 → 否则检查 denies（denies 同样按 over 绑定求值，
 *    修复「纯拒绝法则 / 混合法则的 denies 引用量词变量永不绑定」的陷阱）→ 兜底 granted:false。
 *  - 系统模式：量词枚举聚合全部匹配；无匹配即 granted:false；reject/denies 不参与（与旧 evaluateSystem 一致）。 */
export function evaluateLaw(ctx: ExprCtx, law: Law, collect = false): LawResult {
	const mkDenial = (d: DenialDef, c: ExprCtx): Denial => {
		const s = (x: Expr | undefined): string | undefined => {
			if (!x) return undefined;
			const v = String(evalExpr(c, x) ?? "");
			return v === "" ? undefined : v;
		};
		const subject = s(d.subject);
		const object = s(d.object);
		const prop = s(d.prop);
		const reason = s(d.reason);
		return { law: d.law, subject, object, prop, reason: reason ?? (d.text ? d.text({ subject, object, prop }, c) : undefined) };
	};
	if (!collect && law.reject && (law.reject.when ?? []).every((p) => matchPred(ctx, p))) {
		return { granted: false, denial: mkDenial(law.reject.denial, ctx) };
	}
	const hasGrant = (law.when ?? []).length > 0 || (law.each ?? []).length > 0;
	// hasGrant 只决定是否进入授予求值；纯拒绝法则（只有 denies）仍须检查 denies，否则其世界性理由被吞。
	const matches: Match[] = [];
	if (hasGrant) {
		const over = law.over ?? [];
		if (over.length === 0) {
			const m = evalMatch(ctx, law);
			if (m) matches.push(m);
		} else {
			forEachBinding(ctx, over, (env) => {
				const m = evalMatch({ ...ctx, env }, law);
				if (m) {
					matches.push(m);
					return !collect;
				}
				return false;
			});
		}
	}
	if (collect) {
		if (!matches.length) return { granted: false };
		const deltas = matches.flatMap((m) => m.deltas);
		const facts = matches.flatMap((m) => m.facts);
		// 无 facts 时取各匹配（绑定 env 已注入）产出的 reason，避免用基座 ctx 解析出 "undefined"。
		const reasons = matches.map((m) => m.reason).filter((x): x is string => typeof x === "string");
		const reason = facts.length
			? facts.map((f) => f.text).join(" ")
			: (reasons.length ? reasons.join(" ") : undefined);
		return { granted: true, deltas, facts: facts.length ? facts : undefined, reason, involved: collectInvolved(deltas, facts) };
	}
	const m0 = matches[0];
	if (m0) {
		return {
			granted: true,
			deltas: m0.deltas,
			facts: m0.facts.length ? m0.facts : undefined,
			reason: m0.reason,
			involved: collectInvolved(m0.deltas, m0.facts),
		};
	}
	// 拒绝检查：无 over 用基座 env；有 over 按每个绑定检查（denies 可引用量词变量，如「w 正楔住 entity」）。
	// mkDenial 用触发绑定的 env 解析 subject/object——否则 over 变量的实体 id 会因基座 env 缺绑定而落空。
	const checkDenies = (c: ExprCtx): Denial | undefined => {
		for (const d of law.denies ?? []) {
			if ((d.when ?? []).every((p) => matchPred(c, p))) return mkDenial(d.denial, c);
		}
		return undefined;
	};
	const over = law.over ?? [];
	if (over.length === 0) {
		const dn = checkDenies(ctx);
		if (dn) return { granted: false, denial: dn };
	} else {
		let found: Denial | undefined;
		forEachBinding(ctx, over, (env) => {
			const dn = checkDenies({ ...ctx, env });
			if (dn) {
				found = dn;
				return true;
			}
			return false;
		});
		if (found) return { granted: false, denial: found };
	}
	return { granted: false };
}

/** 表达式构造器（游戏侧作者语法糖，与手写 Expr/Pred 等价）。
 *  p(name, p) 的 name 可以是动作参数名（env 绑定）或常量实体 id（var 回退），两者等价。 */
export const E = {
	v: (name: string): Expr => ({ k: "var", name }),
	lit: (v: PropValue): Expr => ({ k: "lit", v }),
	prop: (e: Expr, p: string): Expr => ({ k: "prop", e, p }),
	p: (name: string, p: string): Expr => ({ k: "prop", e: { k: "var", name }, p }),
	pp: (name: string, p1: string, p2: string): Expr => ({ k: "prop", e: { k: "prop", e: { k: "var", name }, p: p1 }, p: p2 }),
	binop: (op: BinOp, a: Expr, b: Expr): Expr => ({ k: "binop", op, a, b }),
	add: (a: Expr, b: Expr): Expr => ({ k: "binop", op: "+", a, b }),
	sub: (a: Expr, b: Expr): Expr => ({ k: "binop", op: "-", a, b }),
	mul: (a: Expr, b: Expr): Expr => ({ k: "binop", op: "*", a, b }),
	div: (a: Expr, b: Expr): Expr => ({ k: "binop", op: "/", a, b }),
	mod: (a: Expr, b: Expr): Expr => ({ k: "binop", op: "%", a, b }),
	roll: (key: Expr, sides: Expr): Expr => ({ k: "roll", key, sides }),
	time: (): Expr => ({ k: "time" }),
};

export const P = {
	eq: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "eq", b }),
	neq: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "neq", b }),
	gte: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "gte", b }),
	gt: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "gt", b }),
	lt: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "lt", b }),
	lte: (a: Expr, b: Expr): Pred => ({ k: "cmp", a, op: "lte", b }),
	has: (e: Expr, p: string): Pred => ({ k: "has", e, p }),
	exists: (e: Expr): Pred => ({ k: "exists", e }),
	reach: (e: Expr): Pred => ({ k: "reach", e }),
	and: (xs: Pred[]): Pred => ({ k: "and", xs }),
	or: (xs: Pred[]): Pred => ({ k: "or", xs }),
	not: (p: Pred): Pred => ({ k: "not", p }),
};
