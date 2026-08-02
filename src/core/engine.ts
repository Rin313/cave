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
import { Simulation, type Action, type Change, type GameDef, type PropValue, type StepResult } from "./sim.ts";

export interface EngineOptions {
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
	kind: "applied" | "rejected" | "refused" | "partial";
	results: StepResult[];
	refusal?: { label: string; reason: string };
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; actionCount: number }
	| { type: "tool_result"; results: StepResult[] }
	| { type: "validation"; round: number; error: string; attempt: string };

interface ToolResponse {
	results?: StepResult[];
	refusal?: { label: string; reason: string };
}

function toolResultTextFrom(tr: { content: readonly unknown[] }): string | undefined {
	const first = tr.content[0];
	if (first && typeof first === "object" && first !== null && "text" in first && typeof (first as { text: unknown }).text === "string") {
		return (first as { text: string }).text;
	}
	return undefined;
}

function parseToolResponse(text: string): ToolResponse | null {
	try {
		const v = JSON.parse(text) as unknown;
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.results)) return { results: o.results as StepResult[] };
			if (o.refusal && typeof o.refusal === "object") {
				const r = o.refusal as Record<string, unknown>;
				return { refusal: { label: String(r.label ?? "refused"), reason: String(r.reason ?? "") } };
			}
		}
		if (Array.isArray(v)) return { results: v as StepResult[] };
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
	if (Array.isArray(v)) return v.map(coerceValue);
	if (typeof v === "object") {
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, coerceValue(val)]));
	}
	return String(v);
}

/** 引擎保留词：表达文本中出现即判定为泄漏。 */
const ENGINE_RESERVED_TERMS = new Set([
	"act", "actions", "params", "verb", "refusal", "label", "reason", "entities", "props",
	"results", "ok", "changes", "granted", "denyReason", "facts", "kind", "tags",
]);

/** 行动阶段门闩：act 工具只能在 act() 期间执行，防止表达 pass 中模型误调工具变异世界。 */
interface ActGate {
	active: boolean;
}

export class Engine {
	readonly sim: Simulation;
	private readonly def: GameDef;
	private session: SessionHandle;
	private readonly modelRuntime: ModelRuntime;
	private readonly modelDef: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
	private readonly thinkingLevel: string;
	private readonly settingsManager: SettingsManager;
	private readonly gate: ActGate;
	private buf: string[] = [];
	private outcome: ActOutcome = { kind: "refused", results: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		def: GameDef,
		sim: Simulation,
		session: SessionHandle,
		modelRuntime: ModelRuntime,
		modelDef: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
		thinkingLevel: string,
		settingsManager: SettingsManager,
		gate: ActGate,
	) {
		this.def = def;
		this.sim = sim;
		this.session = session;
		this.modelRuntime = modelRuntime;
		this.modelDef = modelDef;
		this.thinkingLevel = thinkingLevel;
		this.settingsManager = settingsManager;
		this.gate = gate;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						if (!this.gate.active) this.buf.push(event.assistantMessageEvent.delta);
					}
					break;
				case "tool_execution_start":
					if (event.toolName === ACT_TOOL) {
						const args = event.args as { actions?: unknown[] };
						this.emit({ type: "tool_call", actionCount: args.actions?.length ?? 0 });
					}
					break;
				case "turn_end":
					if (!this.gate.active) break;
					let anyApplied = false;
					let anyRejected = false;
					for (const tr of event.toolResults) {
						if (tr.toolName !== ACT_TOOL) continue;
						const text = toolResultTextFrom(tr);
						if (!text) continue;
						const resp = parseToolResponse(text);
						if (!resp) continue;
						if (resp.refusal) {
							this.outcome.kind = "refused";
							this.outcome.refusal = resp.refusal;
							this.emit({ type: "tool_result", results: [] });
							continue;
						}
						const results = resp.results ?? [];
						this.outcome.results.push(...results);
						this.emit({ type: "tool_result", results });
						for (const r of results) {
							if (r.ok) anyApplied = true;
							else anyRejected = true;
						}
					}
					if (anyApplied && anyRejected) this.outcome.kind = "partial";
					else if (anyApplied) this.outcome.kind = "applied";
					else if (anyRejected) this.outcome.kind = "rejected";
					break;
			}
		});
	}

	subscribe(listener: (event: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: EngineEvent): void {
		for (const l of this.listeners) l(event);
	}

	static async create(def: GameDef, options: EngineOptions = {}): Promise<Engine> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const provider = options.provider ?? "opencode-go";
		const model = options.model ?? "deepseek-v4-flash";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const thinkingLevel = (options.thinkingLevel as never) ?? "high";
		const gate: ActGate = { active: false };
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
			getSystemPrompt: () => buildSystemPrompt(def),
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (thinkingLevel as never),
			resourceLoader: loader,
			settingsManager,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			tools: [ACT_TOOL],
			customTools: [buildActTool(def, sim, gate)],
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(def, sim, session, modelRuntime, modelDef, thinkingLevel, settingsManager, gate);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [] };
		this.gate.active = true;
		const state = this.sim.serialize();
		const selectionLine = action.selection
			? `玩家选中了文本片段：「${action.selection}」`
			: `玩家未选中任何文本`;
		try {
			await this.session.prompt(buildMappingPrompt(state, selectionLine, action.intent));
		} finally {
			this.gate.active = false;
		}

		if (this.outcome.kind === "refused" && !this.outcome.refusal) {
			this.outcome.refusal = { label: "unparsed", reason: "世界没有回应这个操作。" };
		}

		const results = this.outcome.results;
		const changes = results.flatMap((r) => r.changes);
		const stateAfter = this.sim.serialize();
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, stateAfter, results, this.outcome.refusal, undefined, this.def.internalProps),
			changes,
		);
		this.emit({ type: "text_delta", delta: narration });
		return this.outcome;
	}

	async render(instruction: string, changes: Change[] = []): Promise<void> {
		const state = this.sim.serialize();
		const results: StepResult[] = changes.length
			? [{ ok: true, reason: "时间流逝，世界发生了变化。", changes, action: { verb: "tick", params: { n: this.sim.world.time } } }]
			: [];
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, state, results, undefined, instruction, this.def.internalProps),
			changes,
		);
		this.emit({ type: "text_delta", delta: narration });
	}

	private async expressionPass(prompt: string, changes: Change[]): Promise<string> {
		const internal = new Set(this.def.internalProps ?? []);
		const visible = changes.filter((c) => !internal.has(c.prop));
		const run = async (p: string): Promise<{ text: string; err: string | null }> => {
			this.buf = [];
			try {
				await this.session.prompt(p);
			} catch (err) {
				return { text: "", err: String(err) };
			}
			const text = this.buf.join("");
			return { text, err: this.validateNarration(text, visible) };
		};

		const first = await run(prompt);
		if (!first.err) return first.text;
		this.emit({ type: "validation", round: 1, error: first.err, attempt: first.text });
		const retry = await run(
			`刚才的描述存在虚构内容：${first.err}。请重写。必须严格遵守约束：只描述状态中真实存在的事物；新事实只能来自本回合变更；不要发明不存在的现象或后果。`,
		);
		if (!retry.err) return retry.text;
		this.emit({ type: "validation", round: 2, error: retry.err, attempt: retry.text });
		return this.summarize(visible);
	}

	private summarize(changes: Change[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, changes, actor: this.sim.actor });
		return this.sim.serialize();
	}

	private validateNarration(text: string, changes: Change[]): string | null {
		if (!text.trim()) return "叙述为空。";
		const leaked = this.leakageCheck(text);
		if (leaked) return leaked;
		const hook = this.def.validateText;
		if (hook) {
			const err = hook({ text, world: this.sim.world, changes, actor: this.sim.actor });
			if (err) return err;
		}
		return null;
	}

	/** 通用泄漏检查：由世界状态派生禁止词表，无需任何游戏专有知识。 */
	private leakageCheck(text: string): string | null {
		const forbidden = new Set<string>(ENGINE_RESERVED_TERMS);
		for (const e of this.sim.world.entities) {
			forbidden.add(e.id);
			for (const k of Object.keys(e.props)) forbidden.add(k);
		}
		for (const t of forbidden) {
			if (new RegExp(`\\b${t}\\b`).test(text)) {
				return `出现了实体 id 或实现术语：「${t}」。`;
			}
		}
		return null;
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildMappingPrompt(state: string, selectionLine: string, intent: string): string {
	return `[当前状态]（JSON，唯一真相源）：\n${state}\n\n${selectionLine}\n玩家意图：「${intent}」\n\n你的任务：把玩家的操作意图解析为动作提案，并调用 act 工具。规则：
1. 能解析出合理动作 → 调用 act，提交 actions 列表。每个动作是 { verb, params }，动词与参数定义见系统提示中的动词表；实体参数只能取自已可见实体的 id。
2. 无法解析、实体不存在、或语境荒谬 → 调用 act，提交空的 actions，并用 refusal 字段给出 { label, reason }，reason 必须是符合世界观的解释，不得使用实现术语。
3. 禁止在本阶段输出任何散文或解释文字。`;
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	const verbs = Object.entries(def.verbs)
		.map(([name, v]) => `- ${name}「${v.label}」：${v.description}${v.entityParams?.length ? `（实体参数：${v.entityParams.join("/")}，只能取可见实体 id）` : ""}`)
		.join("\n");
	return `你是文字游戏引擎。每个回合分两个阶段：

阶段一（解析，调用 act 工具）：把玩家的操作意图解析为动作提案并调用 act 工具。能解析 → 提交 actions 列表（{ verb, params }）；无法解析、实体不存在或语境荒谬 → 提交空的 actions 与结构化 refusal（label + 符合世界观的 reason）。此阶段禁止输出散文。

阶段二（描写）：基于世界给出的当前状态与本回合变更，把场景写成面向玩家的文学散文。此阶段禁止调用工具。

世界说明：entities 是当前所有可见实体。id 是唯一标识，name 是展示名；实体属性由当前游戏的法则网络定义，见下方提示。

可用动词（模拟层强制执行）：
${verbs}

${hint}
描写阶段硬约束：
- 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象或后果。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的操作，把世界给出的法则理由融入叙述，让玩家感受到世界的规则。`;
}

function describeAction(sim: Simulation, action: Action): string {
	const verb = sim.def.verbs[action.verb];
	const name = (v: PropValue): string => {
		if (typeof v === "string") {
			const hit = sim.world.entities.find((e) => e.id === v);
			if (hit) return hit.name;
		}
		return String(v);
	};
	if (action.verb === "tick") return "时间流逝";
	if (!verb) return `「${action.verb}」`;
	const entityParams = new Set(verb.entityParams ?? []);
	const parts = Object.entries(action.params).map(([k, v]) => {
		if (k === "prop") return sim.def.propLabels?.[String(v)] ?? String(v);
		if (entityParams.has(k)) return name(v);
		if (typeof v === "string") return name(v);
		return String(v);
	});
	return parts.length ? `${verb.label} ${parts.join("，")}` : verb.label;
}

function fmtValue(sim: Simulation, v: PropValue): string {
	if (v === null) return "无";
	if (typeof v === "string") {
		const hit = sim.world.entities.find((e) => e.id === v);
		if (hit) return hit.name;
	}
	return String(v);
}

function buildExpressionPrompt(
	sim: Simulation,
	state: string,
	results: StepResult[],
	refusal: { label: string; reason: string } | undefined,
	directive = "请以文学笔触描写当前场景（面向玩家）。",
	internalProps: readonly string[] = [],
): string {
	const internal = new Set(internalProps);
	const lines: string[] = [`[当前状态]（JSON，唯一真相源）：`, state, ""];
	if (results.length) {
		lines.push("本回合尝试：");
		for (const r of results) {
			const visible = r.changes.filter((c) => !internal.has(c.prop));
			const changes = visible.length
				? `  ${visible.map((c) => `${c.entity}.${c.prop} ${fmtValue(sim, c.from)} → ${fmtValue(sim, c.to)}`).join("；")}`
				: "";
			const verdict = r.ok ? r.reason : `${r.reason}（被拒绝）`;
			const facts = r.facts?.length ? `  法则事实：${r.facts.join("；")}` : "";
			lines.push(`- 尝试「${describeAction(sim, r.action)}」→ ${verdict}${changes}${facts}`);
		}
	} else if (refusal) {
		lines.push(`世界拒绝了你的操作。${refusal.reason ? `理由：「${refusal.reason}」` : ""}`);
	} else {
		lines.push("没有任何改变。");
	}
	lines.push(
		"",
		`${directive} 要求：`,
		"1. 只描述状态中真实存在的事物与变化；新事实只能来自上面的「本回合尝试」或「法则事实」。",
		"2. 玩家「尝试」过但被拒绝的操作，只描述这次尝试本身，不得声称其产生了后果（实体位置/属性未变）。",
		"3. 不要发明不存在的物体、人物、现象或后果。",
		"4. 一律使用实体的名称（name），不得出现实体 id、属性名、工具调用或任何实现术语。",
		"5. 输出纯散文，不要调用任何工具。",
	);
	return lines.join("\n");
}

function buildActTool(def: GameDef, sim: Simulation, gate: ActGate) {
	const actionSchema = Type.Union(
		Object.entries(def.verbs).map(([name, v]) =>
			Type.Object(
				{
					verb: Type.Literal(name),
					params: (v.schema as never),
				},
				{ additionalProperties: false },
			),
		),
	);
	return defineTool({
		name: ACT_TOOL,
		label: "世界提案",
		description: `向世界提出动作（${Object.keys(def.verbs).join("/")}）或结构化拒绝。能解析操作 → 提交 actions；无法解析 → 提交空 actions 与 refusal。实体参数必须取自已可见实体的 id；世界法则会按顺序裁决每个动作。`,
		parameters: Type.Object({
			actions: Type.Optional(
				Type.Array(actionSchema, { description: "按顺序执行的动作提案列表；无法解析时应省略" }),
			),
			refusal: Type.Optional(
				Type.Object(
					{
						label: Type.String({ description: "拒绝标签，如 unparsed / absurd" }),
						reason: Type.String({ description: "符合世界观的拒绝理由，不得使用实现术语" }),
					},
					{ description: "无法解析或语境荒谬时的结构化拒绝" },
				),
			),
		}),
		execute: async (_toolCallId, params: { actions?: unknown[]; refusal?: { label: string; reason: string } }) => {
			if (!gate.active) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								results: [{
									ok: false,
									reason: "当前不在行动阶段，无法执行操作。",
									changes: [],
									action: { verb: "refused", params: {} },
									deniedBy: "rule" as const,
								}],
							}),
						},
					],
					details: {},
				};
			}
			if (params.refusal && !(params.actions?.length)) {
				return { content: [{ type: "text", text: JSON.stringify({ refusal: params.refusal }) }], details: {} };
			}
			const vis = sim.visible();
			const results: StepResult[] = [];
			for (const raw of params.actions ?? []) {
				const a = raw as { verb?: string; params?: Record<string, unknown> };
				const action: Action = {
					verb: a.verb ?? "",
					params: Object.fromEntries(Object.entries(a.params ?? {}).map(([k, v]) => [k, coerceValue(v)])),
				};
				const verb = def.verbs[action.verb];
				if (!verb) {
					results.push({ ok: false, reason: `世界不认识「${action.verb}」这种操作。`, changes: [], action, deniedBy: "rule" });
					break;
				}
				const invalid = (verb.entityParams ?? []).filter((p) => {
					const id = action.params[p];
					return typeof id === "string" && id.length > 0 && !vis.has(id);
				});
				if (invalid.length) {
					results.push({ ok: false, reason: `实体 ${invalid.join("、")} 不可见或不存在。`, changes: [], action, deniedBy: "rule" });
					break;
				}
				results.push(sim.apply(action));
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify({ results }) },
					{ type: "text", text: `执行后的新状态（JSON，唯一真相源）：\n${sim.serialize()}` },
				],
				details: {},
			};
		},
	});
}
