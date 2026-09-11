// 会话文件保存全量审计。
// 档案是单一追加日志：回合条目（证据，每回合恰一）+ 检查点条目（缓存）——任意前缀皆一致档案，世界状态是记录的派生值。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { Simulation, rewind, spineLines, type ChronicleEntry, type GameDef, type Commit, type RecentEntry, type World } from "./sim.ts";
import { errorText } from "./util.ts";

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

/** 信封粗筛：损坏条目在此离场（无 seq、缺来源判别子或旧步形状的条目同弃、显形）；最终完好判据是装载对账与试投影。 */
function isSource(v: unknown): boolean {
	if (v === null || typeof v !== "object") return false;
	switch ((v as { kind?: unknown }).kind) {
		case "rule": return typeof (v as { rule?: unknown }).rule === "string";
		case "gate": return typeof (v as { law?: unknown }).law === "string";
		default: return false;
	}
}

/** 否决形状：受众与理由；旧形状（kind/notes）在此离场。 */
function isDenial(v: unknown): boolean {
	if (v === null || typeof v !== "object") return false;
	const d = v as { law?: unknown; fault?: unknown; voice?: unknown; debug?: unknown; notes?: unknown; kind?: unknown };
	if (typeof d.law !== "string") return false;
	if (d.fault !== "world" && d.fault !== "engine") return false;
	if (d.voice !== undefined && typeof d.voice !== "string") return false;
	if (d.debug !== undefined && typeof d.debug !== "string") return false;
	return d.notes === undefined && d.kind === undefined;
}

/** 变更形状：投影与重放共用（信封粗筛，最终判据是装载对账与试投影）。顶点记录恰一侧为 ⊥（生/灭），不另存 id。 */
function isChange(v: unknown): boolean {
	if (v === null || typeof v !== "object") return false;
	const c = v as { cell?: unknown; entity?: unknown; prop?: unknown; from?: unknown; to?: unknown; type?: unknown; prev?: unknown; next?: unknown };
	switch (c.cell) {
		case "vertex": return "prev" in c && "next" in c && (c.prev === null) !== (c.next === null);
		case "prop": return typeof c.entity === "string" && typeof c.prop === "string" && "prev" in c && "next" in c;
		case "edge": return typeof c.from === "string" && typeof c.to === "string" && typeof c.type === "string" && "prev" in c && "next" in c;
		default: return false;
	}
}

function isCommit(s: unknown): boolean {
	if (s === null || typeof s !== "object") return false;
	const c = s as { at?: unknown; source?: unknown; price?: unknown; ok?: unknown; origin?: unknown; action?: unknown; changes?: unknown; voice?: unknown; facts?: unknown; denial?: unknown; notes?: unknown };
	if (typeof c.at !== "number" || !isSource(c.source) || typeof c.ok !== "boolean" || typeof c.price !== "number") return false;
	if (c.origin !== "will" && c.origin !== "clock" && c.origin !== "code") return false;
	if (!Array.isArray(c.changes) || !c.changes.every(isChange)) return false;
	const a = c.action as { verb?: unknown; params?: unknown } | null | undefined;
	if (a === null || typeof a !== "object" || typeof a.verb !== "string" || a.params === null || typeof a.params !== "object") return false;
	if (c.notes !== undefined) return false;
	if (c.ok === true) {
		if (c.voice !== undefined && typeof c.voice !== "string") return false;
		return c.facts === undefined || (Array.isArray(c.facts) && c.facts.every((f) => typeof f === "string"));
	}
	return isDenial(c.denial);
}

interface RawCheckpoint {
	seq?: unknown;
	world?: unknown;
}

export interface LogEntries {
	records: ChronicleEntry[];
	checkpoint?: CheckpointEntry;
}

/** 信封粗筛：损坏条目在此离场（无 seq 或旧步形状的条目同弃、显形）；最终完好判据是装载对账与试投影。 */
function loadLog(entries: readonly EntryLike[], warnings: string[]): LogEntries {
	const out: LogEntries = { records: [] };
	let broken = 0;
	for (const e of entries) {
		if (e.type !== "custom") continue;
		if (e.customType === TURN_RECORD_TYPE) {
			const d = e.data as RawTurn | undefined;
			if (d && typeof d.seq === "number" && Number.isInteger(d.seq) && d.seq >= 1 && typeof d.time === "number" && typeof d.utterance === "string" && Array.isArray(d.steps) && d.steps.every(isCommit)) {
				out.records.push({ seq: d.seq, time: d.time, utterance: d.utterance, steps: d.steps as Commit[] });
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
	/** 近况窗口内的回合记录（已过完好判据）。 */
	records: ChronicleEntry[];
	lastSeq: number;
	warnings: string[];
}

/** 装载即对账：检查点是主侧锚（缓存），其后记录走 𝒞 重放——不重裁决、不掷骰，逐变更 prev 校验；链断（序位断裂、prev 不符、审查失败）则世界与近况同界截断。检查点领先于证据即拒绝装载（丢失可检）。近况窗口裁剪后按消费判据修复纪要（试投影辖全窗口，序位检查只辖覆盖段——重放段的连续性由对账强制），截断而非剔除 */
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
	// 近况窗口：内存档案只保留窗口内记录，全量由会话文件承载
	const excess = records.length - def.recentWindow;
	if (excess > 0) records.splice(0, excess);
	// 纪要完好按消费判据：试投影辖全窗口，序位检查只辖覆盖段（重放段的连续性由对账强制）；坏点使近况截断至其后完好子后缀；纪要只喂投影与审计，门不读纪要
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

/** 近况与 act 结果同一变更行判据（刻账目闭合）；记录的提交边界由账本末世界逆推。 */
export function projectWindow(sim: Simulation, records: readonly ChronicleEntry[]): RecentEntry[] {
	const after = afterWorlds(sim, records);
	return records.map((r, i) => ({ time: r.time, utterance: verbatim(r.utterance), moves: spineLines(sim, r.steps, after[i]!) }));
}

/** 各记录之后的世界：记录连续且末记录即当前世界，从账本末世界逐条逆推。 */
function afterWorlds(sim: Simulation, records: readonly ChronicleEntry[]): World[] {
	let w = sim.snapshot();
	const out: World[] = new Array(records.length);
	for (let i = records.length - 1; i >= 0; i--) {
		out[i] = w;
		w = JSON.parse(JSON.stringify(w)) as World;
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
