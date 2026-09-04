// LLM 上下文裁剪：每次调用只见「近况投影 + 当前运行后缀」，会话文件仍保存全量审计。
// 持久化事实是回合条目（intent + steps 原样，custom 条目不参与 LLM 上下文）；近况为用时重算的投影，
// 永不持久化，进程重启由条目重建。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { shownDepartedNames, spineLines, type Simulation, type Step } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

/** 持久化的回合条目（唯一写点：回合定稿）：玩家原话逐字 + 事件步原样。
 *  空 steps = 意图未落地（空提案或未调 act），投影渲染为「未解析」。 */
export interface TurnRecord {
	time: number;
	intent: string;
	steps: Step[];
}

/** 近况窗口条目：TurnRecord 的投影缓存（内存态，永不持久化）。 */
export interface MemoryTurn {
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

/** 从会话 custom 条目读回合条目；形状不符的条目跳过（换型/损坏容错）。 */
export function loadRecords(entries: readonly EntryLike[]): TurnRecord[] {
	const out: TurnRecord[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== MEMORY_RECORD_TYPE) continue;
		const d = e.data as Partial<TurnRecord> | undefined;
		if (!d || typeof d.intent !== "string" || typeof d.time !== "number" || !Array.isArray(d.steps)) continue;
		out.push({ time: d.time, intent: d.intent, steps: d.steps as Step[] });
	}
	return out;
}

/** 近况投影：每条目以当前世界渲染其 steps（compact 骨架行，变更由状态视图承载）。
 *  名字解析随世界现值（改名连续）；跨回合离场者以窗口级已公开离场者底表兜底。 */
export function projectWindow(sim: Simulation, records: readonly TurnRecord[]): MemoryTurn[] {
	const departed = shownDepartedNames(records.flatMap((r) => r.steps));
	return records.map((r) => ({ time: r.time, intent: r.intent, moves: spineLines(sim, r.steps, { compact: true, departed }) }));
}

export function renderMemory(memory: readonly MemoryTurn[]): string {
	if (!memory.length) return "";
	const lines = memory.map((m) => {
		const moves = m.moves.length ? m.moves.join("；") : "未解析";
		return `- t${m.time} 「${m.intent}」→ ${moves}`;
	});
	return ["[近况] 最近几步的世界结果（供指代与续接）：", ...lines].join("\n");
}

/** 裁剪：只保留最后一条 user 消息起的当前运行后缀（toolCall/toolResult 配对完整），近况并入该消息头部。
 *  块内容消息回落纯后缀保留。每次调用独立生效，不改会话持久化。 */
export function pruneContext(messages: CtxMessages, memory: readonly MemoryTurn[]): CtxMessages {
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			last = i;
			break;
		}
	}
	if (last < 0) return messages;
	const suffix = [...messages.slice(last)];
	const head = renderMemory(memory);
	const first = suffix[0] as (CtxMessages[number] & { content?: unknown }) | undefined;
	if (!head || !first || typeof first.content !== "string") return suffix;
	first.content = `${head}\n\n${first.content}`;
	return suffix;
}
