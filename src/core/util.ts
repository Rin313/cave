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
 *  games 层经此实现 validateText 钩子——算法通用，词表/标点/否定词由游戏注入（core 不感知语言）。 */
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
