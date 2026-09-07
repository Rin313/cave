// 每次调用只见「近况投影 + 当前运行后缀」；会话文件保存全量审计。
// 持久化事实是回合记录（intent + steps）；近况为用时重算的投影，永不持久化，进程重启由记录重建。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { shownDepartedNames, spineLines, type Simulation, type Step } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

export interface ChronicleEntry {
	time: number;
	steps: Step[];
	/** 玩家原话，逐字入账。 */
	intent: string;
}

/** 内存态投影缓存，永不持久化。 */
export interface RecentEntry {
	time: number;
	intent: string;
	moves: string[];
}

export const MEMORY_RECORD_TYPE = "cave.turn";

interface EntryLike {
	type: string;
	customType?: unknown;
	data?: unknown;
}

interface RawEntry {
	kind?: unknown;
	time?: unknown;
	intent?: unknown;
	steps?: unknown;
}

/** 从会话 custom 条目读回合记录；形状不符的条目跳过（损坏容错）。 */
export function loadRecords(entries: readonly EntryLike[]): ChronicleEntry[] {
	const out: ChronicleEntry[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== MEMORY_RECORD_TYPE) continue;
		const d = e.data as RawEntry | undefined;
		if (!d || typeof d.time !== "number" || typeof d.intent !== "string" || !Array.isArray(d.steps)) continue;
		out.push({ time: d.time, intent: d.intent, steps: d.steps as Step[] });
	}
	return out;
}

/** 名字解析随世界现值（改名连续）；离场名以窗口级名表兜底。 */
export function projectWindow(sim: Simulation, records: readonly ChronicleEntry[]): RecentEntry[] {
	const departed = shownDepartedNames(records.flatMap((r) => r.steps));
	return records.map((r) => ({ time: r.time, intent: r.intent, moves: spineLines(sim, r.steps, { compact: true, departed }) }));
}

/** 玩家文本进机械投影的唯一合法形态：JSON 串编码——内容逐字、结构惰性。stringify 不转义的行分隔符（U+2028/9）手动补转义。 */
export function verbatim(s: string): string {
	return JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

function renderRecent(recent: readonly RecentEntry[]): string {
	if (!recent.length) return "";
	const lines = recent.map((m) => `- t${m.time} ${verbatim(m.intent)} → ${m.moves.length ? m.moves.join("；") : "未解析"}`);
	return ["[近况] 最近几步的世界结果（供指代与续接）：", ...lines].join("\n");
}

/** 只保留最后一条 user 消息起的后缀，近况并入其头部；不改会话持久化。 */
export function pruneContext(messages: CtxMessages, recent: readonly RecentEntry[]): CtxMessages {
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			last = i;
			break;
		}
	}
	if (last < 0) return messages;
	const suffix = [...messages.slice(last)];
	const head = renderRecent(recent);
	const first = suffix[0] as (CtxMessages[number] & { content?: unknown }) | undefined;
	if (!head || !first || typeof first.content !== "string") return suffix;
	first.content = `${head}\n\n${first.content}`;
	return suffix;
}
