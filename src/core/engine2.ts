import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Simulation } from "./sim2.ts";
import type { GameDef, Op, PropValue, StepResult } from "./sim2.ts";

export interface Engine2Options {
	modelRuntime?: ModelRuntime;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sim?: Simulation;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

export interface ActOutcome {
	kind: "applied" | "rejected" | "refused";
	results: StepResult[];
}

export type Engine2Event =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; opCount: number }
	| { type: "tool_result"; results: StepResult[] };

function toolResultText(content: readonly { text?: string }[]): string | undefined {
	const first = content[0];
	return first && typeof first.text === "string" ? first.text : undefined;
}

function parseResults(text: string): StepResult[] | null {
	try {
		const v = JSON.parse(text) as StepResult[];
		if (Array.isArray(v)) return v;
	} catch {
		/* 非 JSON，忽略 */
	}
	return null;
}

function coerceValue(v: unknown): PropValue {
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null") return null;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) return v;
	return String(v);
}

interface OpParams {
	op: string;
	source?: string;
	target?: string;
	entity?: string;
	dest?: string;
	prop?: string;
	value?: unknown;
}

function toOp(p: OpParams): Op {
	if (p.op === "apply") return { kind: "apply", source: p.source ?? "", target: p.target ?? "" };
	if (p.op === "move") return { kind: "move", entity: p.entity ?? "", dest: p.dest ?? "" };
	return { kind: "set", entity: p.entity ?? "", prop: p.prop ?? "", value: coerceValue(p.value) };
}

function opIds(p: OpParams): string[] {
	if (p.op === "apply") return [p.source ?? "", p.target ?? ""];
	if (p.op === "move") return [p.entity ?? "", p.dest ?? ""];
	return [p.entity ?? ""];
}

export class Engine2 {
	readonly sim: Simulation;
	private session: SessionHandle;
	private phase: { inAct: boolean };
	private outcome: ActOutcome = { kind: "refused", results: [] };
	private listeners = new Set<(event: Engine2Event) => void>();

	private constructor(sim: Simulation, session: SessionHandle, phase: { inAct: boolean }) {
		this.sim = sim;
		this.session = session;
		this.phase = phase;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						this.emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
					}
					break;
				case "tool_execution_start":
					if (event.toolName === ACT_TOOL) {
						const args = event.args as { ops?: unknown[] };
						this.emit({ type: "tool_call", opCount: args.ops?.length ?? 0 });
					}
					break;
				case "turn_end":
					if (!this.phase.inAct) break;
					for (const tr of event.toolResults) {
						if (tr.toolName !== ACT_TOOL) continue;
						const text = toolResultText(tr.content);
						if (!text) continue;
						const results = parseResults(text);
						if (!results) continue;
						this.outcome = { kind: results.some((r) => r.ok) ? "applied" : "rejected", results };
						this.emit({ type: "tool_result", results });
					}
					break;
			}
		});
	}

	subscribe(listener: (event: Engine2Event) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: Engine2Event): void {
		for (const l of this.listeners) l(event);
	}

	static async create(def: GameDef, options: Engine2Options = {}): Promise<Engine2> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const provider = options.provider ?? "opencode-go";
		const model = options.model ?? "deepseek-v4-flash";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const phase: { inAct: boolean } = { inAct: false };
		const actTool = buildActTool(sim, phase);
		const systemPrompt = buildSystemPrompt(def);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const loader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => systemPrompt,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (options.thinkingLevel as never) ?? "high",
			resourceLoader: loader,
			settingsManager,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			tools: [ACT_TOOL],
			customTools: [actTool],
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine2(sim, session, phase);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [] };
		this.phase.inAct = true;
		const selectionLine = action.selection
			? `玩家选中了文本片段：「${action.selection}」`
			: `玩家未选中任何文本`;
		const state = this.sim.serialize();
		const turn = `${state}\n\n${selectionLine}\n玩家意图：「${action.intent}」`;
		try {
			await this.session.prompt(turn);
		} finally {
			this.phase.inAct = false;
		}
		return this.outcome;
	}

	async render(instruction: string): Promise<void> {
		const state = this.sim.serialize();
		await this.session.prompt(`${state}\n\n${instruction}`);
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	return `你是文字游戏引擎。每个回合你会收到 [当前状态]（JSON，唯一真相源）和玩家的操作文本。

状态说明：entities 是当前所有可见实体。实体属性常见的有：material（材质）、lit（发光的火）、burning（失控燃烧）、open（开启）、openable（可开启）、flammable（可燃）、grabbable（可拿起）、lightable（可点燃）、attachedTo（固定在）、wedgeable（可楔入门缝）、jammed（被卡住）、wedgedBy（被什么卡住）、in（所在/所持，无 in 表示在当前场景）。

${hint}
你的工作：
1. 把玩家的操作解析成一个或多个操作提案，调用 act 工具：
   - apply(source, target)：用 source 作用于 target（点火、撬门、吹气等）
   - move(entity, dest)：拿起（dest=玩家）、放下（dest=场景）、放入（dest=打开的容器）
   - set(entity, prop, value)：请求改变某实体的某属性，世界法则会裁决是否允许
   实体 id 只能取自已可见实体的 id。
2. 工具按顺序执行每个操作并返回结果与新状态。ok=true 表示世界接受并改变了状态；ok=false 表示拒绝，reason 说明世界法则为什么不允许。
3. 若玩家的操作无法解析成任何合理提案、或语境荒谬，不要调用工具，直接写文学性反应。
4. 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象；一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。被拒绝的操作，把法则理由融入叙述，让玩家感受到世界的规则。`;
}

function buildActTool(sim: Simulation, phase: { inAct: boolean }) {
	const opSchema = Type.Object({
		op: Type.Union([Type.Literal("apply"), Type.Literal("move"), Type.Literal("set")]),
		source: Type.Optional(Type.String({ description: "apply：施动实体 id" })),
		target: Type.Optional(Type.String({ description: "apply：受动实体 id" })),
		entity: Type.Optional(Type.String({ description: "move/set：目标实体 id" })),
		dest: Type.Optional(Type.String({ description: "move：目标位置（玩家 id / 容器 id / 场景 id）" })),
		prop: Type.Optional(Type.String({ description: "set：属性名" })),
		value: Type.Optional(Type.Any({ description: "set：属性值（布尔/数字/字符串/null）" })),
	});
	return defineTool({
		name: ACT_TOOL,
		label: "世界提案",
		description:
			"向世界提出一个或多个操作（apply/move/set）。实体 id 必须取自已可见实体的 id；世界法则会按顺序裁决每个操作。",
		parameters: Type.Object({
			ops: Type.Array(opSchema, { description: "按顺序执行的操作提案列表" }),
		}),
		execute: async (_toolCallId, params: { ops?: OpParams[] }) => {
			if (!phase.inAct) {
				const refused: StepResult = {
					ok: false,
					reason: "当前不在行动阶段，无法执行操作。",
					changes: [],
					op: { kind: "set", entity: "", prop: "", value: null },
				};
				return { content: [{ type: "text", text: JSON.stringify([refused]) }], details: {} };
			}
			const vis = sim.visibleIds;
			const results: StepResult[] = [];
			for (const p of params.ops ?? []) {
				const op = toOp(p);
				const invalid = opIds(p).filter((id) => id && !vis.has(id));
				if (invalid.length) {
					results.push({ ok: false, reason: `实体 ${invalid.join("、")} 不可见或不存在。`, changes: [], op });
					break;
				}
				results.push(sim.apply(op));
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify(results) },
					{ type: "text", text: `执行后的新状态（JSON，唯一真相源）：\n${sim.serialize()}` },
				],
				details: {},
			};
		},
	});
}
