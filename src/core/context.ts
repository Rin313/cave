// 上下文裁剪策略（core 单一来源）：LLM 每次调用只见「近况记录 + 当前运行后缀」，会话文件仍保存全量审计。
// 近况经 custom 条目持久化在会话文件内（custom 不参与 LLM 上下文），进程重启后由此重建窗口。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type CtxMessages = ContextEvent["messages"];

/** 单回合动作记录（世界腔，无 id）：映射层的指代/续接锚点。空 moves 即意图未落地（空提案或未调 act），渲染为「未解析」。 */
export interface MemoryTurn {
	time: number;
	intent: string;
	moves: string[];
}

export const MEMORY_CUSTOM_TYPE = "cave.memory";

interface EntryLike {
	type: string;
	customType?: unknown;
	data?: unknown;
}

/** 从会话 custom 条目重建近期窗口（最近 limit 回合；limit 非正即空窗——未声明记忆语义的诚实零）。 */
export function loadMemory(entries: readonly EntryLike[], limit: number): MemoryTurn[] {
	const out: MemoryTurn[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== MEMORY_CUSTOM_TYPE) continue;
		const d = e.data as Partial<MemoryTurn> | undefined;
		if (!d || typeof d.intent !== "string") continue;
		out.push({
			time: Number(d.time ?? 0),
			intent: String(d.intent),
			moves: Array.isArray(d.moves) ? d.moves.map(String) : [],
		});
	}
	return limit > 0 ? out.slice(-limit) : [];
}

/** 近况渲染：符号连接 + 游戏自产的世界腔理由，core 不新增自然语句。 */
export function renderMemory(memory: readonly MemoryTurn[]): string {
	if (!memory.length) return "";
	const lines = memory.map((m) => {
		const moves = m.moves.length ? m.moves.join("；") : "未解析";
		return `- t${m.time} 「${m.intent}」→ ${moves}`;
	});
	return ["[近况] 最近几步的世界结果（供指代与续接）：", ...lines].join("\n");
}

/** 裁剪：只保留最后一条 user 消息起的当前运行后缀（toolCall/toolResult 配对天然完整），近况并入该消息头部。
 *  引擎 prompt 均为字符串内容；块内容消息回落纯后缀保留。每次调用独立生效，不改会话持久化。 */
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
