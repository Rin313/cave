import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { Simulation, rewind, spineLines, type ChronicleEntry, type GameDef, type RecentEntry } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

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
		warnings.push(`近况选择抛错（回落缺省窗口）：${String(e)}`);
		return base;
	}
	const index = new Map(records.map((r, i) => [r, i]));
	let prev = -1;
	const ordered = Array.isArray(picked) && (picked as readonly unknown[]).every((r) => {
		const at = index.get(r as ChronicleEntry);
		if (at === undefined || at <= prev) return false;
		prev = at;
		return true;
	});
	if (!ordered) {
		warnings.push("近况选择须为传入记录的子序列（账本序）：回落缺省窗口");
		return base;
	}
	return picked;
}

/** 投影所选记录：自账本末世界逐条逆推至最早入选者（spineLines 不自改入参，故就地回退），只取入选记录的提交边界；言默与 act 结果同判据。 */
function projectRecent(sim: Simulation, records: readonly ChronicleEntry[], selected: readonly ChronicleEntry[]): RecentEntry[] {
	if (selected.length === 0) return [];
	const slot = new Map(selected.map((r, i) => [r, i]));
	const moves: string[][] = new Array(selected.length);
	let need = selected.length;
	const w = sim.snapshot();
	for (let i = records.length - 1; i >= 0 && need > 0; i--) {
		const r = records[i]!;
		const at = slot.get(r);
		if (at !== undefined) {
			moves[at] = spineLines(sim, r.steps, w);
			need--;
		}
		if (need > 0) rewind(w, r.steps);
	}
	return selected.map((r, i) => ({ time: r.time, utterance: JSON.stringify(r.utterance), moves: moves[i]! }));
}

/** 近况：选择（作者）× 投影（引擎） */
export function recentEntries(sim: Simulation, records: readonly ChronicleEntry[], warnings: string[]): RecentEntry[] {
	return projectRecent(sim, records, selectRecent(sim.def, records, warnings));
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
