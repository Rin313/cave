// 会话文件保存全量审计：档案是单一追加日志，条目只有回合（证据，每回合恰一）。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { Simulation, deepFreeze, denialReasonText, errorText, isCommit, lawOf, rewind, spineLines, type ChronicleEntry, type GameDef, type RecentEntry } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

export const TURN_RECORD_TYPE = "turn";

interface EntryLike {
	id?: string;
	type: string;
	customType?: unknown;
	data?: unknown;
}

interface RawTurn {
	seq?: unknown;
	time?: unknown;
	utterance?: unknown;
	steps?: unknown;
}

interface LoadedTurn {
	entry: EntryLike;
	record: ChronicleEntry;
}

/** 信封粗筛：只收形状完好的回合条目；最终完好判据是重放。 */
function loadRecords(entries: readonly EntryLike[], warnings: string[]): LoadedTurn[] {
	const out: LoadedTurn[] = [];
	let broken = 0;
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== TURN_RECORD_TYPE) continue;
		const d = e.data as RawTurn | undefined;
		if (d && typeof d.seq === "number" && Number.isInteger(d.seq) && d.seq >= 1 && typeof d.time === "number" && typeof d.utterance === "string" && Array.isArray(d.steps) && d.steps.every(isCommit)) {
			out.push({ entry: e, record: deepFreeze({ seq: d.seq, time: d.time, utterance: d.utterance, steps: d.steps }) });
		} else broken++;
	}
	if (broken) warnings.push(`回合条目 ${broken} 条形状损坏`);
	return out;
}

export interface Resumed {
	sim: Simulation;
	/** 存活回合记录（重放通过的连续前缀）；近况由 def.recent 从此选择。 */
	records: ChronicleEntry[];
	lastSeq: number;
	/** 存活前缀末条回合的会话条目 id（能定位时）；截断时引擎据此另起分支，使续写不再被旧尾部遮蔽。 */
	lastEntryId: string | null;
	/** 序位不接续或变更不可应用：装载已截断至完好前缀。 */
	truncated: boolean;
	warnings: string[];
}

/** 装载即重放：开局只验结构与 integrity，记录按序走 𝒞 重放（不重裁决、不掷骰，逐变更 prev 校验），终态跑一次 admit；序位不接续或变更不可应用即截断至断点前的完好前缀。 */
export function resume(def: GameDef, entries: readonly EntryLike[]): Resumed {
	const warnings: string[] = [];
	const sim = new Simulation(def);
	const records: ChronicleEntry[] = [];
	let lastSeq = 0;
	let expected = 1;
	let truncated = false;
	let lastEntryId: string | null = null;
	for (const { entry, record: r } of loadRecords(entries, warnings)) {
		if (truncated) continue;
		if (r.seq !== expected) {
			warnings.push(`档案链断于 seq${expected}（得到 seq${r.seq}）：世界与近况同界截断`);
			truncated = true;
			continue;
		}
		const reason = sim.replayRecord(r);
		if (reason) {
			warnings.push(`档案链断（${reason}）：世界与近况同界截断`);
			truncated = true;
			continue;
		}
		records.push(r);
		lastSeq = r.seq;
		lastEntryId = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
		expected = r.seq + 1;
	}
	// 装载终点：终态对当下法则的零变更审查——历史不重审，当前世界必过 admit
	const finallyDenied = sim.admit();
	if (finallyDenied) throw new Error(`装载拒绝：当前世界违反 ${lawOf(finallyDenied.point)}（${denialReasonText(finallyDenied)}）`);
	return { sim, records, lastSeq, lastEntryId, truncated, warnings };
}

/** 缺省近况选择：最后 recentWindow 条；recentWindow 缺席即全量（作者接管选择时的 base）。 */
function baseRecent(def: GameDef, records: readonly ChronicleEntry[]): readonly ChronicleEntry[] {
	const n = def.recentWindow;
	return n !== undefined ? records.slice(Math.max(0, records.length - n)) : records;
}

/** 近况选择：作者钩子收全账本记录与缺省选择；抛错或非账本序子序列回落 base 并告警。 */
function selectRecent(def: GameDef, records: readonly ChronicleEntry[], warnings: string[]): readonly ChronicleEntry[] {
	const base = baseRecent(def, records);
	if (def.recent === undefined) return base;
	let picked: readonly ChronicleEntry[];
	try {
		picked = def.recent(records, base);
	} catch (e) {
		warnings.push(`近况选择抛错（回落缺省窗口）：${errorText(e)}`);
		return base;
	}
	const index = new Map(records.map((r, i) => [r.seq, i]));
	let prev = -1;
	const ordered = Array.isArray(picked) && (picked as readonly unknown[]).every((r) => {
		const seq = r !== null && typeof r === "object" ? (r as { seq?: unknown }).seq : undefined;
		const at = typeof seq === "number" ? index.get(seq) : undefined;
		if (at === undefined || at <= prev) return false;
		prev = at;
		return true;
	});
	if (!ordered) {
		warnings.push("近况选择须为账本序的子序列（严格递增 seq 且取自传入记录）：回落缺省窗口");
		return base;
	}
	return picked;
}

/** 投影所选记录：自账本末世界逐条逆推至最早入选者（spineLines 不自改入参，故就地回退），只取入选记录的提交边界；言默与 act 结果同判据。 */
function projectRecent(sim: Simulation, records: readonly ChronicleEntry[], selected: readonly ChronicleEntry[]): RecentEntry[] {
	if (selected.length === 0) return [];
	const slot = new Map(selected.map((r, i) => [r.seq, i]));
	const moves: string[][] = new Array(selected.length);
	let need = selected.length;
	const w = sim.snapshot();
	for (let i = records.length - 1; i >= 0 && need > 0; i--) {
		const r = records[i]!;
		const at = slot.get(r.seq);
		if (at !== undefined) {
			moves[at] = spineLines(sim, r.steps, w);
			need--;
		}
		if (need > 0) rewind(w, r.steps);
	}
	return selected.map((r, i) => ({ time: r.time, utterance: verbatim(r.utterance), moves: moves[i]! }));
}

/** 近况：选择（作者）× 投影（引擎）；AI 的跨回合记忆只经此一条路。 */
export function recentEntries(sim: Simulation, records: readonly ChronicleEntry[], warnings: string[]): RecentEntry[] {
	return projectRecent(sim, records, selectRecent(sim.def, records, warnings));
}

export function verbatim(s: string): string {
	return JSON.stringify(s);
}

/** 只保留最后一条 user 消息起的后缀 */
export function pruneContext(messages: CtxMessages): CtxMessages {
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			last = i;
			break;
		}
	}
	if (last < 0) return messages;
	return messages.slice(last);
}
