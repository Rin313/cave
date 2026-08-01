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
import { Simulation } from "./sim.ts";
import type { ActOutcome, ActionResult, EngineEvent, GameConfig } from "./types.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sim?: Simulation;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const INTENT_TOOL = "apply_intent";

function toolResultText(content: readonly { text?: string }[]): string | undefined {
	const first = content[0];
	return first && typeof first.text === "string" ? first.text : undefined;
}

function parseActionResult(text: string): ActionResult | null {
	try {
		const v = JSON.parse(text) as Partial<ActionResult>;
		if (v && typeof v.ok === "boolean" && typeof v.intent === "string" && Array.isArray(v.entityIds)) {
			return v as ActionResult;
		}
	} catch {
		/* 非 JSON，忽略 */
	}
	return null;
}

export class Engine {
	readonly sim: Simulation;
	readonly systemPrompt: string;
	lastTurn: { state: string; prompt: string } | null = null;
	private session: SessionHandle;
	private listeners = new Set<(event: EngineEvent) => void>();
	private outcome: ActOutcome = { kind: "refused" };
	private phase: { inAct: boolean };

	private constructor(sim: Simulation, session: SessionHandle, systemPrompt: string, phase: { inAct: boolean }) {
		this.sim = sim;
		this.session = session;
		this.systemPrompt = systemPrompt;
		this.phase = phase;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						this.emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
					}
					break;
				case "tool_execution_start":
					if (event.toolName === INTENT_TOOL) {
						const args = event.args as { intent?: string; entity_ids?: string[] };
						this.emit({ type: "tool_call", intent: args.intent ?? "", entityIds: args.entity_ids ?? [] });
					}
					break;
				case "turn_end":
					if (!this.phase.inAct) break;
					for (const tr of event.toolResults) {
						if (tr.toolName !== INTENT_TOOL) continue;
						const text = toolResultText(tr.content);
						if (!text) continue;
						const result = parseActionResult(text);
						if (!result) continue;
						this.outcome = { kind: result.ok ? "applied" : "rejected", intent: result.intent, result };
						this.emit({ type: "tool_result", result });
					}
					break;
			}
		});
	}

	static async create(config: GameConfig, options: EngineOptions = {}): Promise<Engine> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const provider = options.provider ?? "opencode-go";
		const model = options.model ?? "deepseek-v4-flash";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(config);
		const phase: { inAct: boolean } = { inAct: false };
		const intentTool = buildIntentTool(sim, phase);
		const systemPrompt = buildSystemPrompt(config);
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
			tools: [INTENT_TOOL],
			customTools: [intentTool],
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(sim, session, systemPrompt, phase);
	}

	subscribe(listener: (event: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	private emit(event: EngineEvent): void {
		for (const l of this.listeners) l(event);
	}

	async render(instruction: string): Promise<void> {
		const state = this.sim.serialize();
		const turn = `${state}\n\n${instruction}`;
		this.lastTurn = { state, prompt: turn };
		await this.session.prompt(turn);
		this.emit({ type: "turn_end" });
	}

	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused" };
		this.phase.inAct = true;
		const selectionLine = action.selection
			? `玩家选中了文本片段：「${action.selection}」`
			: `玩家未选中任何文本`;
		const state = this.sim.serialize();
		const turn = `${state}\n\n${selectionLine}\n玩家意图：「${action.intent}」`;
		this.lastTurn = { state, prompt: turn };
		try {
			await this.session.prompt(turn);
		} finally {
			this.phase.inAct = false;
		}
		this.emit({ type: "turn_end" });
		return this.outcome;
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildSystemPrompt(config: GameConfig): string {
	const intents = config.intents.map((i) => `- ${i.label}: ${i.description}`).join("\n");
	return `你是文字游戏引擎。每个回合你会收到 [当前状态]（JSON，唯一真相源）和玩家的操作文本。

1. 若操作匹配意图表中的某个意图，调用 apply_intent：intent 必须是意图表中的一个标签，entity_ids 只能从当前状态可见实体中选择。
2. 工具返回执行结果与执行后的新状态（JSON，唯一真相源）。ok=true 表示状态已改变，你基于新状态叙述操作的结果；ok=false 表示操作不成立，你写一段文学性反应。
3. 若操作无法匹配意图表中任何一个意图、解析不出实体、或语境荒谬，不要调用工具，直接写文学性反应。
4. 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象；不得提及意图表标签、实体ID、状态字段或工具调用。

意图表：
${intents}`;
}

function buildIntentTool(sim: Simulation, phase: { inAct: boolean }) {
	const intents = sim.config.intents;
	return defineTool({
		name: INTENT_TOOL,
		label: "施放意图",
		description: "执行玩家的操作意图：intent 命中意图表，entity_ids 只能从当前状态可见实体中选择。",
		parameters: Type.Object({
			intent: Type.Union(intents.map((i) => Type.Literal(i.label))),
			entity_ids: Type.Array(Type.String({ description: "实体ID，只能从当前状态可见实体中选择" })),
		}),
		execute: async (_toolCallId, params) => {
			if (!phase.inAct) {
				const refused: ActionResult = { ok: false, message: "当前不在行动阶段，无法执行操作。", intent: params.intent, entityIds: params.entity_ids };
				return { content: [{ type: "text", text: JSON.stringify(refused) }], details: {} };
			}
			const result: ActionResult = sim.applyIntent(params.intent, params.entity_ids);
			return {
				content: [
					{ type: "text", text: JSON.stringify(result) },
					{ type: "text", text: `执行后的新状态（JSON，唯一真相源）：\n${sim.serialize()}` },
				],
				details: {},
			};
		},
	});
}
