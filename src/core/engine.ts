import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_CUSTOM_TYPE, MEMORY_LIMIT, loadMemory, pruneContext, type MemoryTurn } from "./context.ts";
import { Simulation, internalPropsOf, messagesFor, propLabelOf, stylisticPropsOf, type Action, type Change, type GameDef, type PropValue, type StepResult } from "./sim.ts";
import { coerceValue } from "./util.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
	sim?: Simulation;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

export interface ActOutcome {
	kind: "applied" | "rejected" | "refused" | "partial";
	results: StepResult[];
	/** 本回合时间流逝产出（各动作授予刻数的 systems 产出；时间律：无裁决即无流逝），不计入 kind。 */
	elapsed: StepResult[];
	refusal?: { label: string; reason?: string };
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; actionCount: number; actions?: unknown[] }
	| { type: "tool_result"; results: StepResult[] }
	| { type: "elapsed"; results: StepResult[] }
	| { type: "validation"; round: number; error: string; attempt: string }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number };

/** act 工具 execute 向 Engine 直通回写裁决结果（不经事件流嗅探或工具结果解析往返）。 */
interface TurnChannel {
	onAdjudication: ((patch: { results?: StepResult[]; refusal?: { label: string }; elapsed?: StepResult[] }) => void) | null;
}

/** 单回合通道状态：变异窗口门闩 + 散文缓冲。
 *  Engine.act() 开启门闩并复位其余字段；act 工具首次执行即翻转（本回合唯一裁决）。
 *  散文缓冲只在门闩翻转后（裁决已发生）收集——叙述只能跟随裁决，正文 = 裁决之后的文本。 */
interface TurnState {
	gateOpen: boolean;
	acted: boolean;
	visibleBefore: Set<string>;
	intent?: string;
	textBuf: string[];
}

export class Engine {
	readonly sim: Simulation;
	private readonly def: GameDef;
	private session: SessionHandle;
	private readonly sessionManager: SessionManager;
	private readonly memory: MemoryTurn[];
	private readonly turn: TurnState;
	private readonly channel: TurnChannel;
	private outcome: ActOutcome = { kind: "refused", results: [], elapsed: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		def: GameDef,
		sim: Simulation,
		session: SessionHandle,
		sessionManager: SessionManager,
		memory: MemoryTurn[],
		turn: TurnState,
		channel: TurnChannel,
	) {
		this.def = def;
		this.sim = sim;
		this.session = session;
		this.sessionManager = sessionManager;
		this.memory = memory;
		this.turn = turn;
		this.channel = channel;
		channel.onAdjudication = (patch) => {
			if (patch.results) {
				this.outcome.results.push(...patch.results);
				this.emit({ type: "tool_result", results: patch.results });
				// kind 从累计结果重算
				const anyApplied = this.outcome.results.some((r) => r.ok);
				const anyRejected = this.outcome.results.some((r) => !r.ok);
				if (anyApplied && anyRejected) this.outcome.kind = "partial";
				else if (anyApplied) this.outcome.kind = "applied";
				else if (anyRejected) this.outcome.kind = "rejected";
				else this.outcome.kind = "refused";
			}
			if (patch.refusal) {
				this.emit({ type: "tool_result", results: [] });
				// 拒绝只在尚无已裁决动作时成立：动作一旦入账后果已发生，迟到的 refusal 不覆盖裁决
				if (this.outcome.results.length === 0) {
					this.outcome.kind = "refused";
					this.outcome.refusal = patch.refusal;
				}
			}
			if (patch.elapsed?.length) {
				this.outcome.elapsed = patch.elapsed;
				this.emit({ type: "elapsed", results: patch.elapsed });
			}
		};
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					// 散文缓冲只在裁决后（门闩已翻转；渲染回合恒为关）收集：叙述只能跟随裁决
					if (event.assistantMessageEvent.type === "text_delta" && !this.turn.gateOpen) {
						this.turn.textBuf.push(event.assistantMessageEvent.delta);
					}
					break;
				case "tool_execution_start":
					if (event.toolName === ACT_TOOL) {
						const args = event.args as { actions?: unknown[] };
						this.emit({ type: "tool_call", actionCount: args.actions?.length ?? 0, actions: args.actions });
					}
					break;
				case "agent_end":
					for (const m of event.messages ?? []) {
						const u = (m as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
						if (m.role === "assistant" && u) this.emit({ type: "usage", input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 });
					}
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

	static async create(def: GameDef, options: EngineOptions): Promise<Engine> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const modelDef = modelRuntime.getModel(options.provider, options.model);
		if (!modelDef) throw new Error(`模型 ${options.provider}/${options.model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const thinkingLevel = (options.thinkingLevel as never) ?? "high";
		const turn: TurnState = { gateOpen: false, acted: false, visibleBefore: new Set(), textBuf: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 自动重试只针对传输类可重试错误；重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const memory = loadMemory(sessionManager.getEntries());
		// no* 全关宿主资源发现（cwd 的 AGENTS.md/扩展/技能不得泄入游戏 prompt）；extensionFactories 只挂上下文策略
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager,
			systemPrompt: buildSystemPrompt(def),
			extensionFactories: [buildContextExtension(() => memory)],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const channel: TurnChannel = { onAdjudication: null };
		const customTools = [buildActTool(def, sim, turn, channel)];

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (thinkingLevel as never),
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: [ACT_TOOL],
			customTools,
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(def, sim, session, sessionManager, memory, turn, channel);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	/** 开启新回合通道（复位收进方法，避免调用点的属性收窄干扰后续类型分析）。 */
	private openTurn(intent: string): void {
		this.turn.gateOpen = true;
		this.turn.acted = false;
		this.turn.textBuf.length = 0;
		this.turn.visibleBefore = this.sim.visible();
		this.turn.intent = intent;
	}

	/** 单 pass 回合：一次会话运行内 act（一次性提交，门闩封闭变异窗口）→ 工具结果承载世界回应 → declare（可选）→ 散文。 */
	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [], elapsed: [] };
		this.openTurn(action.intent);
		const state = this.sim.digest();
		try {
			await this.session.prompt(buildTurnPrompt(state, action.intent, action.selection));
		} finally {
			this.turn.gateOpen = false;
		}

		let narration: string;
		if (!this.turn.acted) {
			// 模型未调 act：其文本未经裁决、不可作为叙述，回落确定性摘要（近况记为未解析）。
			// 时间律：无裁决即无流逝——本回合世界静止，这是定义，不是缺陷。
			this.outcome.refusal = { label: "unparsed" };
			this.emit({ type: "validation", round: 1, error: "模型未调用 act 工具，本回合无裁决", attempt: this.turn.textBuf.join("").trim() });
			narration = this.summarize([]);
		} else {
			// 摘要兜底原料 = 本回合全部可见变更（玩家动作 + 时间流逝）
			narration = this.settleNarration([...this.outcome.results, ...this.outcome.elapsed].flatMap((r) => narratableChanges(this.def, r.changes)));
		}
		this.recordTurn(action.intent, this.outcome.elapsed);
		this.emit({ type: "text_delta", delta: narration });
		return this.outcome;
	}

	/** 回合落账：近况窗口推进并持久化为会话 custom 条目（不入 LLM 上下文，重启后由 loadMemory 重建）。 */
	private recordTurn(intent: string, elapsed: StepResult[]): void {
		const o = this.outcome;
		const elapsedMoves = elapsed.map((r) => `⏱ ${(r.facts ?? []).map((f) => f.text).join("；") || this.sim.describeAction(r.action)}`);
		this.memory.push({
			time: this.sim.world.time,
			intent: intent.slice(0, 80),
			kind: o.kind,
			moves: [...o.results.map((r) => `${r.ok ? "✓" : "✗"} ${this.sim.describeAction(r.action)}：${r.reason}`), ...elapsedMoves],
			refusal: o.refusal?.label,
		});
		if (this.memory.length > MEMORY_LIMIT) this.memory.splice(0, this.memory.length - MEMORY_LIMIT);
		try {
			this.sessionManager.appendCustomEntry(MEMORY_CUSTOM_TYPE, this.memory[this.memory.length - 1]);
		} catch {
			// 持久化失败不阻断回合：内存窗口仍有效
		}
	}

	/** 独立渲染（无动作裁决的叙述回合，如开场/等待后的场景描写）：elapsed 为本回合时间流逝的 systems 产出（含 facts）。 */
	async render(instruction: string, elapsed: StepResult[] = []): Promise<void> {
		const visibleChanges = elapsed.flatMap((r) => narratableChanges(this.def, r.changes));
		const pending = this.sim.dryTick(1).flatMap((r) => r.changes);
		this.turn.textBuf.length = 0;
		try {
			await this.session.prompt(buildRenderPrompt(this.sim, elapsed, instruction, pending));
		} finally {
			this.turn.gateOpen = false;
		}
		this.emit({ type: "text_delta", delta: this.settleNarration(visibleChanges) });
	}

	/** 叙述收尾：正文为空 → 确定性摘要兜底（强接地，无幻觉面）。 */
	private settleNarration(summaryChanges: Change[]): string {
		const text = this.turn.textBuf.join("");
		if (text.trim() === "") {
			this.emit({ type: "validation", round: 1, error: "散文为空。", attempt: text });
			return this.summarize(summaryChanges);
		}
		return text;
	}

	private summarize(changes: Change[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, changes, player: this.sim.player });
		return this.sim.serialize();
	}

	dispose(): void {
		this.channel.onAdjudication = null;
		this.session.dispose();
	}
}

/** 上下文策略扩展：每次 LLM 调用前把消息裁剪为「近况 + 当前运行后缀」（core/context.ts），会话文件不受影响。 */
function buildContextExtension(memory: () => readonly MemoryTurn[]): InlineExtension {
	return {
		name: "cave-context",
		factory: (pi) => {
			pi.on("context", async (event) => ({ messages: pruneContext(event.messages, memory()) }));
		},
	};
}

function buildTurnPrompt(state: string, intent: string, selection: string | undefined): string {
	const intentLine = selection
		? `玩家意图：「${intent}」（玩家选中的场景文字：「${selection}」）`
		: `玩家意图：「${intent}」`;
	return `[当前状态]（唯一真相源）：\n${state}\n\n${intentLine}\n\n解析意图并调用 act 工具提交动作提案（或结构化拒绝）；世界裁决后基于返回的结果描写本回合。`;
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	const verbs = Object.entries(def.verbs)
		.map(([name, v]) => `- ${name}「${v.label}」：${v.description}${v.entityParams?.length ? `（实体参数：${v.entityParams.join("/")}，只能取可见实体 id）` : ""}`)
		.join("\n");
	const stylistic = stylisticPropsOf(def);
	const stylisticLine = stylistic.size
		? `\n可润饰属性：${[...stylistic].map((p) => `${p}（${propLabelOf(def, p) ?? p}）`).join("、")}——描述这些属性时允许合理的文学润饰（如「刻痕斑驳」）。`
		: "";
	return `你是文字游戏引擎。把玩家的操作意图解析为动作提案，调用 act 工具提交（本回合只能调用一次）：能解析 → 提交 actions 列表（{ verb, params }）；无法解析、实体不存在或语境荒谬 → 提交空 actions 与结构化 refusal（仅 label，不写理由）。act 返回世界裁决结果后，基于它把本回合写成面向玩家的文学散文。

部分回合没有行动窗口（渲染回合，如开场或纯时间流逝）：回合 prompt 顶部会标注「渲染回合」，此时不要调用 act，直接输出散文正文。

世界说明：entities 是当前所有可见实体。id 是唯一标识，name 是展示名；实体属性由当前游戏的法则网络定义，见下方提示。

可用动词（模拟层强制执行）：
${verbs}
${stylisticLine}

${hint}
描写硬约束：
- 叙述只能跟随 act 返回的裁决结果（尝试、变更、法则事实、新见）与世界状态中的实体和属性，禁止发明不存在的物体、人物、现象或后果——后果由世界法则产生，不由你创造。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的操作，把世界给出的法则理由融入叙述，让玩家感受到世界的规则；被拒绝的尝试只写尝试本身，不写其后果。
- 「即将发生」只写征兆（用「将」「就要」），不得写成已发生。`;
}

function fmtValue(sim: Simulation, v: PropValue): string {
	if (v === null) return "null";
	if (typeof v === "string") {
		const hit = sim.world.entities.find((e) => e.id === v);
		if (hit) return hit.name;
	}
	return String(v);
}

/** 变更的语言无关线性化（数据渲染，core 不内嵌语言词，只做符号连接，按 Change.kind 分派）：
 *  普通变更 `<name>.<label>: <prev> → <next>`；rel 变更 `<from>.<type>.<to>: <prev> → <next>`；生灭 `+ name` / `- name`。
 *  name/label/type 均为游戏声明的世界语；缺 label 时回退原 prop 名。 */
export function fmtChange(sim: Simulation, c: Change): string {
	if (c.kind === "spawn") return `+ ${c.name}`;
	if (c.kind === "despawn") return `- ${c.name}`;
	if (c.kind === "rel") return `${fmtValue(sim, c.from)}.${c.type}.${fmtValue(sim, c.to)}: ${fmtValue(sim, c.prev)} → ${fmtValue(sim, c.next)}`;
	const e = sim.world.entities.find((x) => x.id === c.entity);
	const name = e?.name ?? c.entity;
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	return `${name}.${label}: ${fmtValue(sim, c.prev)} → ${fmtValue(sim, c.next)}`;
}

/** 表达可见变更：internal 属性不进表达输入（公理一逃生舱）。只有 prop 变更携带 prop，rel/生灭恒可见。 */
function narratableChanges(def: GameDef, changes: Change[]): Change[] {
	const internal = internalPropsOf(def);
	return changes.filter((c) => !(c.kind === "prop" && internal.has(c.prop)));
}

/** 回合事件的世界腔策展（act 工具结果与独立渲染共用）：
 *  尝试行（协议性拒绝过滤——引擎↔模型通道流量不是世界事件）、时间流逝、即将发生、新见。core 只做符号连接。
 *  时间流逝（动作授予刻数的 systems 产出）不是玩家的尝试，是世界自己的因果；
 *  段头用游戏的时间语（messages.timePassed），fact-only 氛围事实与不变式拦截同样进段。 */
function formatTurnEvents(sim: Simulation, results: StepResult[], refusal: { label: string } | undefined, intent: string | undefined, pending: Change[], revealed: string[], elapsed: StepResult[] = []): string[] {
	const lines: string[] = [];
	const elapsedEvents = elapsed.filter((r) => !r.ok || narratableChanges(sim.def, r.changes).length || r.facts?.length);
	if (refusal) {
		lines.push(`玩家的意图「${intent ?? ""}」未被解析为可执行的操作，世界没有回应。`);
	}
	const narratable = results.filter((r) => r.deniedBy !== "protocol");
	if (narratable.length) {
		lines.push("本回合尝试：");
		for (const r of narratable) {
			const visible = narratableChanges(sim.def, r.changes);
			const changes = visible.length ? `  ${visible.map((c) => fmtChange(sim, c)).join("；")}` : "";
			const verdict = r.ok ? r.reason : `${r.reason}（被拒绝）`;
			const facts = r.facts?.length ? `  法则事实：${r.facts.map((f) => f.text).join("；")}` : "";
			const involved = r.involved?.length ? `  涉及：${r.involved.map((id) => fmtValue(sim, id)).join("、")}` : "";
			lines.push(`- 尝试「${sim.describeAction(r.action)}」→ ${verdict}${changes}${facts}${involved}`);
		}
	} else if (!refusal && !elapsedEvents.length) {
		lines.push("没有任何改变。");
	}
	if (elapsedEvents.length) {
		lines.push(`${messagesFor(sim.def).timePassed}：`);
		for (const r of elapsedEvents) {
			const bits = [narratableChanges(sim.def, r.changes).map((c) => fmtChange(sim, c)).join("；"), ...(r.facts ?? []).map((f) => f.text)].filter(Boolean);
			const body = bits.length ? bits.join("。") : (r.reason ?? messagesFor(sim.def).defaultReason);
			lines.push(`- ${r.ok ? body : `${body}（被拒绝）`}`);
		}
	}
	const pendingVisible = narratableChanges(sim.def, pending);
	if (pendingVisible.length) {
		lines.push("即将发生（下一时刻）：");
		for (const c of pendingVisible) {
			lines.push(`  ${fmtChange(sim, c)}`);
		}
	}
	const revealedVisible = revealed.filter((id) => sim.world.entities.some((e) => e.id === id));
	if (revealedVisible.length) {
		lines.push("本回合新见：");
		for (const id of revealedVisible) {
			lines.push(`  ${fmtValue(sim, id)}`);
		}
	}
	return lines;
}

/** act 工具结果：本回合世界回应的世界腔策展——散文的唯一事件源（叙述只能跟随这里的内容）。 */
function buildResultView(sim: Simulation, results: StepResult[], refusal: { label: string } | undefined, intent: string | undefined, pending: Change[], revealed: string[], elapsed: StepResult[]): string {
	const lines = formatTurnEvents(sim, results, refusal, intent, pending, revealed, elapsed);
	return lines.join("\n");
}

/** 独立渲染 prompt（无动作裁决的叙述回合，如开场/等待后的场景描写）。 */
function buildRenderPrompt(sim: Simulation, elapsed: StepResult[], instruction: string, pending: Change[]): string {
	const lines = ["[回合相位] 渲染回合：没有行动窗口，本回合不可调用 act 工具。", "", `[当前状态]（唯一真相源）：`, sim.digest(), "", ...formatTurnEvents(sim, [], undefined, undefined, pending, [], elapsed)];
	lines.push("", `${instruction} 直接输出散文正文。`);
	return lines.join("\n");
}

/** act 工具：本回合唯一的动作提交口（one-shot 门闩）。
 *  execute 内完成：裁决（单一瓶颈 adjudicateRaw 口径）→ 回合时间流逝 → 世界腔策展作为工具结果返回。 */
function buildActTool(def: GameDef, sim: Simulation, turn: TurnState, channel: TurnChannel) {
	const actionSchema = Type.Union(
		Object.entries(def.verbs).map(([name, v]) =>
			Type.Object(
				{
					verb: Type.Literal(name),
					params: v.schema,
				},
				{ additionalProperties: false },
			),
		),
	);
	return defineTool({
		name: ACT_TOOL,
		label: "世界提案",
		description: `向世界提出动作（${Object.keys(def.verbs).join("/")}）或结构化拒绝。能解析操作 → 提交 actions；无法解析 → 提交空 actions 与 refusal（仅 label）。本回合只能调用一次；实体参数必须取自已可见实体的 id；世界法则会按顺序裁决每个动作并返回结果。`,
		parameters: Type.Object({
			actions: Type.Optional(
				Type.Array(actionSchema, { description: "按顺序执行的动作提案列表；无法解析时应省略" }),
			),
			refusal: Type.Optional(
				Type.Object(
					{
						label: Type.String({ description: "拒绝标签，如 unparsed / absurd" }),
					},
					{ description: "无法解析或语境荒谬时的结构化拒绝；理由由世界法则给出，模型不撰写" },
				),
			),
		}),
		execute: async (_toolCallId, params: { actions?: unknown[]; refusal?: { label: string } }) => {
			if (!turn.gateOpen) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: messagesFor(def).notInActionPhase }) }],
					details: {},
				};
			}
			// one-shot：首个 act 执行即本回合唯一裁决，此后世界只接受叙述
			turn.gateOpen = false;
			turn.acted = true;
			const hasActions = !!params.actions?.length;
			const refusal = hasActions ? undefined : params.refusal ? { label: params.refusal.label } : { label: "unparsed" };
			const results: StepResult[] = [];
			const elapsed: StepResult[] = [];
			if (hasActions) {
				for (const raw of params.actions!) {
					const a = raw as { verb?: string; params?: Record<string, unknown> };
					// 动词/schema/可见性校验收敛在 sim.apply 的单一裁决瓶颈，与场景/CLI/probe 同一口径。
					const action: Action = {
						verb: a.verb ?? "",
						params: Object.fromEntries(Object.entries(a.params ?? {}).map(([k, v]) => [k, coerceValue(v)])),
					};
					const r = sim.apply(action);
					results.push(r);
					// 时间律：世界时间只经裁决边界流逝，刻数由裁决授予——按动作交织推进，
					// 后续动作与 systems 都在后一世界态上裁决/运行（世界能在行为之间反应）。
					if (r.ticks > 0) elapsed.push(...sim.tick(r.ticks));
				}
			}
			channel.onAdjudication?.({ results: hasActions ? results : undefined, refusal, elapsed });
			// 以世界腔策展作为工具结果：散文的唯一事件源（叙述只能跟随这里的内容）
			const revealed = [...sim.visible()].filter((id) => !turn.visibleBefore.has(id));
			const pending = sim.dryTick(1).flatMap((r) => r.changes);
			return {
				content: [{ type: "text", text: buildResultView(sim, results, refusal, turn.intent, pending, revealed, elapsed) }],
				details: {},
			};
		},
	});
}
