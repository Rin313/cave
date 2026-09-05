// LLM 上下文裁剪：每次调用只见「近况投影 + 当前运行后缀」，会话文件仍保存全量审计。
// 持久化事实是地籍条目（意志条目：intent + steps；无意志条目：steps——custom 条目不参与 LLM 上下文）；
// 近况为用时重算的投影，永不持久化，进程重启由条目重建。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { shownDepartedNames, spineLines, type Simulation, type Step } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

export interface ChronicleEntry {
	time: number;
	steps: Step[];
	/** 意志原话（逐字）；缺席 = 无意志条目。 */
	intent?: string;
}

/** 近况窗口条目：ChronicleEntry 的投影缓存（内存态，永不持久化）。无意志条目无 intent。 */
export interface RecentEntry {
	time: number;
	intent?: string;
	moves: string[];
}

export const MEMORY_RECORD_TYPE = "cave.turn";

interface EntryLike {
	type: string;
	customType?: unknown;
	data?: unknown;
}

/** 会话条目的原始形状 */
interface RawEntry {
	kind?: unknown;
	time?: unknown;
	intent?: unknown;
	steps?: unknown;
}

/** 从会话 custom 条目读地籍条目；形状不符的条目跳过（换型/损坏容错）。条目的判据是 intent 在场性。 */
export function loadRecords(entries: readonly EntryLike[]): ChronicleEntry[] {
	const out: ChronicleEntry[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== MEMORY_RECORD_TYPE) continue;
		const d = e.data as RawEntry | undefined;
		if (!d || typeof d.time !== "number" || !Array.isArray(d.steps)) continue;
		if (d.intent !== undefined && typeof d.intent !== "string") continue;
		out.push({ time: d.time, steps: d.steps as Step[], ...(typeof d.intent === "string" && { intent: d.intent }) });
	}
	return out;
}

/** 近况投影：每条目以当前世界渲染其 steps（compact 骨架行，变更由状态视图承载）。
 *  名字解析随世界现值（改名连续）；离场者以窗口级离场底表兜底——含无意志条目的离场。 */
export function projectWindow(sim: Simulation, records: readonly ChronicleEntry[]): RecentEntry[] {
	const departed = shownDepartedNames(records.flatMap((r) => r.steps));
	return records.map((r) => ({
		time: r.time,
		...(r.intent !== undefined && { intent: r.intent }),
		moves: spineLines(sim, r.steps, { compact: true, departed }),
	}));
}

export function renderRecent(recent: readonly RecentEntry[]): string {
	if (!recent.length) return "";
	const lines = recent.map((m) => {
		if (m.intent === undefined) return `- t${m.time} ${m.moves.join("；")}`;
		const moves = m.moves.length ? m.moves.join("；") : "未解析";
		return `- t${m.time} 「${m.intent}」→ ${moves}`;
	});
	return ["[近况] 最近几步的世界结果（供指代与续接）：", ...lines].join("\n");
}

/** 裁剪：只保留最后一条 user 消息起的当前运行后缀（toolCall/toolResult 配对完整），近况并入该消息头部。
 *  块内容消息回落纯后缀保留。每次调用独立生效，不改会话持久化。 */
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
