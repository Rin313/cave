// 会话文件保存全量审计：档案是单一追加日志——回合条目（证据，每回合恰一）+ 检查点条目（缓存）。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { Simulation, clone, deepFreeze, denialReasonText, errorText, isCommit, lawOf, rewind, spineLines, type ChronicleEntry, type GameDef, type Commit, type RecentEntry, type World } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

export const TURN_RECORD_TYPE = "turn";
export const CHECKPOINT_RECORD_TYPE = "checkpoint";

interface CheckpointEntry {
	seq: number;
	world: World;
}

interface EntryLike {
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

/** 授予行的 law 缺省即守卫 id；law 引入前的记录缺此字段，装载时按缺省补全——可回算载荷同坐标断言之律。 */
function completeLaw(s: unknown): Commit {
	const c = s as { ok: boolean; rule: string; law?: string };
	return c.ok && c.law === undefined ? { ...(s as Extract<Commit, { ok: true }>), law: c.rule } : (s as Commit);
}

interface RawCheckpoint {
	seq?: unknown;
	world?: unknown;
}

export interface LogEntries {
	records: ChronicleEntry[];
	checkpoint?: CheckpointEntry;
}

/** 信封粗筛；最终完好判据是装载对账与试投影。 */
function loadLog(entries: readonly EntryLike[], warnings: string[]): LogEntries {
	const out: LogEntries = { records: [] };
	let broken = 0;
	for (const e of entries) {
		if (e.type !== "custom") continue;
		if (e.customType === TURN_RECORD_TYPE) {
			const d = e.data as RawTurn | undefined;
			if (d && typeof d.seq === "number" && Number.isInteger(d.seq) && d.seq >= 1 && typeof d.time === "number" && typeof d.utterance === "string" && Array.isArray(d.steps) && d.steps.every(isCommit)) {
				out.records.push(deepFreeze({ seq: d.seq, time: d.time, utterance: d.utterance, steps: d.steps.map(completeLaw) }));
			} else broken++;
			continue;
		}
		if (e.customType === CHECKPOINT_RECORD_TYPE) {
			const d = e.data as RawCheckpoint | undefined;
			if (d && typeof d.seq === "number" && Number.isInteger(d.seq) && d.seq >= 0 && d.world !== null && typeof d.world === "object") {
				out.checkpoint = { seq: d.seq, world: d.world as World };
			}
		}
	}
	if (broken) warnings.push(`回合条目 ${broken} 条形状损坏（含无 seq 或旧步形状的条目）`);
	return out;
}

export interface Resumed {
	sim: Simulation;
	/** 全部存活回合记录（已过完好判据）；近况由 def.recent 从此选择。 */
	records: ChronicleEntry[];
	lastSeq: number;
	warnings: string[];
}

/** 装载即对账：锚（开局/检查点）只验结构与 integrity，其后记录走 𝒞 重放（不重裁决、不掷骰，逐变更 prev 校验），终态跑一次 admit；链断则世界与近况同界截断，检查点领先于证据即拒绝装载。纪要完好按消费判据（试投影辖全量，作者选择可消费任意记录），坏点使其截断至其后完好子后缀。 */
export function resume(def: GameDef, entries: readonly EntryLike[]): Resumed {
	const warnings: string[] = [];
	const log = loadLog(entries, warnings);
	let checkpoint = log.checkpoint;
	let sim: Simulation;
	if (checkpoint) {
		try {
			sim = new Simulation(def, checkpoint.world);
		} catch (e) {
			warnings.push(`检查点损坏（${errorText(e)}）：弃置，自变体开局全量重放`);
			checkpoint = undefined;
			sim = new Simulation(def);
		}
	} else {
		sim = new Simulation(def);
	}
	const boundary = checkpoint?.seq ?? 0;
	const maxSeq = log.records.reduce((n, r) => Math.max(n, r.seq), 0);
	if (checkpoint && checkpoint.seq > maxSeq) {
		throw new Error(`档案对账失败：检查点声称已含 seq≤${checkpoint.seq} 的回合，日志证据至 seq${maxSeq}——丢失可检，拒绝装载`);
	}
	const records: ChronicleEntry[] = [];
	let lastSeq = boundary;
	let expected = boundary + 1;
	let broken = false;
	for (const r of log.records) {
		if (r.seq <= boundary) {
			// 检查点已含其后果：不重放世界，但序位演进必须补上
			sim.seedAttempts(r);
			records.push(r);
			continue;
		}
		if (broken) continue;
		if (r.seq !== expected) {
			warnings.push(`档案链断于 seq${expected}（得到 seq${r.seq}）：世界与近况同界截断`);
			broken = true;
			continue;
		}
		const reason = sim.replayRecord(r);
		if (reason) {
			warnings.push(`档案链断（${reason}）：世界与近况同界截断`);
			broken = true;
			continue;
		}
		records.push(r);
		lastSeq = r.seq;
		expected = r.seq + 1;
	}
	// 装载终点：终态对当下法则的零变更审查——历史不重审，当前世界必过 admit
	const finallyDenied = sim.admit();
	if (finallyDenied) throw new Error(`装载拒绝：当前世界违反 ${lawOf(finallyDenied.point)}（${denialReasonText(finallyDenied)}）`);
	// 纪要完好按消费判据：近况选择可消费任意记录，故试投影辖全量；序位检查只辖覆盖段（重放段的连续性由对账强制）；坏点使记录截断至其后完好子后缀；纪要只喂投影与审计，门不读纪要
	let cut = -1;
	const after = afterWorlds(sim, records);
	records.forEach((r, i) => {
		const prev = records[i - 1];
		const gap = prev !== undefined && prev.seq <= boundary && r.seq !== prev.seq + 1 ? `序位断裂 ${prev.seq}→${r.seq}` : null;
		let reason = gap;
		if (!reason) {
			try {
				spineLines(sim, r.steps, after[i]!);
			} catch (e) {
				reason = `投影失败：${errorText(e)}`;
			}
		}
		if (!reason) return;
		cut = Math.max(cut, gap ? i - 1 : i);
		warnings.push(`纪要 seq${r.seq}「${r.utterance.slice(0, 24)}」${reason}`);
	});
	if (cut >= 0) {
		warnings.push(`近况截断：弃前 ${cut + 1}/${records.length} 条`);
		records.splice(0, cut + 1);
	}
	return { sim, records, lastSeq, warnings };
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

/** 投影所选记录：自账本末世界逆推全账本至最早入选者，只取入选记录的提交边界；言默与 act 结果同判据。 */
function projectRecent(sim: Simulation, records: readonly ChronicleEntry[], selected: readonly ChronicleEntry[]): RecentEntry[] {
	const wanted = new Set(selected.map((r) => r.seq));
	const after = new Map<number, World>();
	let need = wanted.size;
	let w = sim.snapshot();
	for (let i = records.length - 1; i >= 0 && need > 0; i--) {
		const r = records[i]!;
		if (wanted.has(r.seq)) {
			after.set(r.seq, w);
			need--;
			if (need === 0) break;
		}
		w = clone(w);
		rewind(w, r.steps);
	}
	return selected.map((r) => ({ time: r.time, utterance: verbatim(r.utterance), moves: spineLines(sim, r.steps, after.get(r.seq)!) }));
}

/** 近况：选择（作者）× 投影（引擎）；AI 的跨回合记忆只经此一条路。 */
export function recentEntries(sim: Simulation, records: readonly ChronicleEntry[], warnings: string[]): RecentEntry[] {
	return projectRecent(sim, records, selectRecent(sim.def, records, warnings));
}

/** 各记录之后的世界：记录连续且末记录即当前世界，从账本末世界逐条逆推。 */
function afterWorlds(sim: Simulation, records: readonly ChronicleEntry[]): World[] {
	let w = sim.snapshot();
	const out: World[] = new Array(records.length);
	for (let i = records.length - 1; i >= 0; i--) {
		out[i] = w;
		w = clone(w);
		rewind(w, records[i]!.steps);
	}
	return out;
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
