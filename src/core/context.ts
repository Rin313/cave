// LLM 上下文裁剪：每次调用只见「近况投影 + 当前运行后缀」，会话文件仍保存全量审计。
// 持久化事实是地籍条目（意志回合：intent + steps；仪器时间：steps、无意志——custom 条目不参与 LLM 上下文）；
// 近况为用时重算的投影，永不持久化，进程重启由条目重建。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { shownDepartedNames, spineLines, type Simulation, type Step } from "./sim.ts";

export type CtxMessages = ContextEvent["messages"];

/** 地籍条目（写点：回合定稿与一切非回合后果源的定稿）。名字闭合要求窗口内被引用名字的失效事件
 *  与被引用行同在地籍——凡绕过 act 进入世界的后果（当前实例：仪器时间；协议变体表上的实时流同型）
 *  必须经 elapsed 条目入地籍，只落审计的流逝会让近况旧名失解（离场名只存在于变更记录）。 */
export type ChronicleEntry =
	| { kind: "turn"; time: number; intent: string; steps: Step[] }
	| { kind: "elapsed"; time: number; steps: Step[] };

/** 近况窗口条目：ChronicleEntry 的投影缓存（内存态，永不持久化）。elapsed 条目无 intent。 */
export interface MemoryTurn {
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

/** 从会话 custom 条目读地籍条目；形状不符的条目跳过（换型/损坏容错）；缺 kind 的旧条目（有 intent）按意志回合容错。 */
export function loadRecords(entries: readonly EntryLike[]): ChronicleEntry[] {
	const out: ChronicleEntry[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== MEMORY_RECORD_TYPE) continue;
		const d = e.data as RawEntry | undefined;
		if (!d || typeof d.time !== "number" || !Array.isArray(d.steps)) continue;
		if (d.kind === "elapsed") {
			out.push({ kind: "elapsed", time: d.time, steps: d.steps as Step[] });
			continue;
		}
		if (typeof d.intent !== "string") continue;
		out.push({ kind: "turn", time: d.time, intent: d.intent, steps: d.steps as Step[] });
	}
	return out;
}

/** 近况投影：每条目以当前世界渲染其 steps（compact 骨架行，变更由状态视图承载）。
 *  名字解析随世界现值（改名连续）；离场者以窗口级离场底表兜底——含仪器时间条目的公开离场。 */
export function projectWindow(sim: Simulation, records: readonly ChronicleEntry[]): MemoryTurn[] {
	const departed = shownDepartedNames(records.flatMap((r) => r.steps));
	return records.map((r) => ({
		time: r.time,
		...(r.kind === "turn" && { intent: r.intent }),
		moves: spineLines(sim, r.steps, { compact: true, departed }),
	}));
}

export function renderMemory(memory: readonly MemoryTurn[]): string {
	if (!memory.length) return "";
	const lines = memory.map((m) => {
		if (m.intent === undefined) return `- t${m.time} ${m.moves.join("；")}`;
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
