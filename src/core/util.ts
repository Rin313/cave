import type { AssertionInput, AssertionRule, Entity, World } from "./sim.ts";

/** 确定性字符串哈希：任意字符串 → [0,1) 均匀分布值。纯函数、无状态。
 *  games 层用它从世界状态派生自有随机语义（如 hashStr(`${world.time}#${luck}#${salt}`)），
 *  引擎不提供状态化 rng——随机必须是 World 的纯函数，保证 check/apply/dryTick/存档天然一致。 */
export function hashStr(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** 数值属性跨实体求和（缺失/非数字按 0）。era/DoL 类资源经济的守恒不变式用（如 sumProp(world,"coins")）。
 *  聚合不感知游戏机制——守恒模式：游戏声明「聚合值 == 种子值」的不变式，AI 通道与系统 bug 都无法凭空铸币/灭币。 */
export function sumProp(world: World, prop: string): number {
	let total = 0;
	for (const e of world.entities) {
		const v = e.props[prop];
		if (typeof v === "number" && Number.isFinite(v)) total += v;
	}
	return total;
}

/** 确定性骰子：hashStr(`${world.time}#${key}`) 派生的 [1, sides] 整数。
 *  随机必须是 World 的纯函数（check/apply/dryTick/存档天然一致）——era 类判定/掉落据此派生，
 *  key 需在同 tick 内唯一（含实体 id 或自持计数器，如 roll(world, `drop#${id}`, 6)）。 */
export function roll(world: World, key: string, sides: number): number {
	const h = hashStr(`${world.time}#${key}`);
	return 1 + Math.floor(h * Math.max(1, Math.floor(sides)));
}

export interface ClaimTarget {
	name: string;
}

/** 文本断言扫描选项：算法在 core，语言相关参数（词表/标点/否定词）由游戏注入，core 不感知语言。 */
export interface ScanClaimsOptions {
	/** 断言词列表（如「燃烧」「手中」）。 */
	claims: readonly string[];
	/** 候选目标实体。 */
	targets: readonly ClaimTarget[];
	/** 命中时返回的校验错误文案。 */
	error: (t: ClaimTarget) => string;
	/** 否定词表：断言词前 NEAR 窗口内出现任一否定词即跳过该断言。 */
	negations: readonly string[];
	/** 子句边界标点：名称与断言之间出现这些才算「不相邻」（跨主语误报拦截）。 */
	punct: RegExp;
	/** 断言与实体名允许的最大间隔字符数。 */
	nearWindow?: number;
	/** 断言词紧后接「的」时的实体匹配（如「燃烧的蜡烛」）：命中才报错，未命中则跳过该断言词。 */
	deAfter?: (after: string) => ClaimTarget | null;
}

function negatedBefore(s: string, p: number, negations: readonly string[]): boolean {
	return negations.some((n) => s.slice(Math.max(0, p - 3), p).includes(n));
}

function nearBefore(s: string, name: string, p: number, punct: RegExp, nearWindow: number): boolean {
	const from = Math.max(0, p - nearWindow);
	const i = s.lastIndexOf(name, p - 1);
	if (i === -1 || i < from) return false;
	return !punct.test(s.slice(i + name.length, p));
}

function nearAfter(s: string, name: string, p: number, claimLen: number, punct: RegExp, nearWindow: number): boolean {
	const to = Math.min(s.length, p + claimLen + nearWindow);
	const i = s.indexOf(name, p + claimLen);
	if (i === -1 || i + name.length > to) return false;
	return !punct.test(s.slice(p + claimLen, i));
}

/** 文本断言扫描：在一个文本里逐词查找断言词，命中且近旁（nearWindow 内、无标点隔断）有目标实体即报错。
 *  算法通用，词表/标点/否定词由游戏注入（core 不感知语言）；core 的 checkAssertions 依此执行断言规则。 */
export function scanClaims(s: string, opts: ScanClaimsOptions): string | null {
	const nearWindow = opts.nearWindow ?? 8;
	for (const claim of opts.claims) {
		let idx = 0;
		while ((idx = s.indexOf(claim, idx)) !== -1) {
			if (negatedBefore(s, idx, opts.negations)) {
				idx += claim.length;
				continue;
			}
			if (opts.deAfter && s[idx + claim.length] === "的") {
				const after = s.slice(idx + claim.length + 1, idx + claim.length + 4);
				const hit = opts.deAfter(after);
				if (hit) return opts.error(hit);
				idx += claim.length;
				continue;
			}
			const t = opts.targets.find((e) => nearBefore(s, e.name, idx, opts.punct, nearWindow) || nearAfter(s, e.name, idx, claim.length, opts.punct, nearWindow));
			if (t) return opts.error(t);
			idx += claim.length;
		}
	}
	return null;
}

const DEFAULT_SENTENCE_PUNCT = /\n+/;

/** 通用断言校验（表达层）：对每条规则，用 scanClaims 检查散文是否断言了与物理状态相反的事实。
 *  weak 断言词豁免"即将发生"（pending 中该实体该属性将成立）——合法预言不误伤；strong 断言词不豁免。
 *  词表/否定词/标点均由游戏经 GameDef.assertionRules/negationWords/sentencePunct/assertionPunct 注入，core 不感知语言。
 *  断言词紧后接「的」时（如「燃烧的蜡烛」）按"该属性将成立的实体名"匹配，命中才报错。 */
export function checkAssertions(
	input: AssertionInput,
	rules: AssertionRule[],
	negations: readonly string[],
	sentencePunct: RegExp = DEFAULT_SENTENCE_PUNCT,
	assertionPunct: RegExp = sentencePunct,
): string | null {
	const { text, world, actor, pending } = input;
	const pendingTrue = (prop: string, id: string): boolean =>
		pending.some((c) => c.prop === prop && c.entity === id && (c.to === true || c.to === actor));
	for (const rule of rules) {
		const strongTargets = rule.targets(world, actor);
		const weakTargets = rule.exemptPending === false
			? strongTargets
			: strongTargets.filter((e) => !pendingTrue(rule.prop, e.id));
		const deAfter = (ts: readonly Entity[]) => (after: string): ClaimTarget | null =>
			ts.find((e) => after.startsWith(e.name)) ?? null;
		for (const s of text.split(sentencePunct)) {
			if (rule.strong?.length) {
				const hit = scanClaims(s, { claims: rule.strong, targets: strongTargets, error: (t) => rule.error(t as Entity), negations, punct: assertionPunct, deAfter: deAfter(strongTargets) });
				if (hit) return hit;
			}
			const hit = scanClaims(s, { claims: rule.weak, targets: weakTargets, error: (t) => rule.error(t as Entity), negations, punct: assertionPunct, deAfter: deAfter(weakTargets) });
			if (hit) return hit;
		}
	}
	return null;
}
