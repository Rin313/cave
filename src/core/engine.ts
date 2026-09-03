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
import { MEMORY_CUSTOM_TYPE, loadMemory, pruneContext, type MemoryTurn } from "./context.ts";
import { Simulation, entity, messagesFor, spineLines, viewCard, type Action, type ActionStep, type GameDef, type PropValue, type Step, type TickStep } from "./sim.ts";

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
	results: ActionStep[];
	/** 本回合时间流逝产出（动作授予刻数逐刻运行 systems 的刻步；时间律：无裁决即无流逝）。 */
	elapsed: TickStep[];
	/** 回合定稿权威全文（累积散文或确定性摘要兜底）。 */
	narration: string;
	/** act 工具实际收到的动作提案（审计记录）。 */
	proposals: { verb: string; params: unknown }[];
	/** 过程报警（未调 act / 散文为空等叙述兜底）。 */
	warnings: TurnWarning[];
	/** 单次 LLM 调用用量，按调用序。 */
	usage: TokenUsage[];
}

/** 场景呈现（narrate）的返回：无意志、无 act 通道。 */
export interface NarrationOutcome {
	narration: string;
	warnings: TurnWarning[];
	usage: TokenUsage[];
}

export interface TurnWarning {
	round: number;
	error: string;
	attempt: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 流式叙述通道（渲染层推送骨干）：仅承载实时生成，权威数据走返回值——
 *  narration_delta 实时正文（相位门控：仅裁决后的生成，thinking 与映射期文本不入通道），
 *  narration_reset 在重试丢弃在途生成时清零（与 pi「移除失败消息再重生成」镜像）。 */
export type EngineEvent =
	| { type: "narration_delta"; delta: string }
	| { type: "narration_reset" };

/** act 工具 execute 向 Engine 直通回写裁决结果（不经事件流嗅探或工具结果解析往返）。 */
interface TurnChannel {
	onAdjudication: ((patch: { results?: ActionStep[]; elapsed?: TickStep[] }) => void) | null;
}

/** 单次 session.prompt 的运行状态：相位机 + 收集器（按生成代记账，镜像 pi 的重试语义）。相位只有两态——
 *  mapping：行动窗口开放、text 丢弃（映射期）；narration：裁决已过或呈现服务、text 入叙述账本。
 *  current 是在途生成的正文：message_end 正常终结即并入 settled */
interface RunState {
	phase: "mapping" | "narration";
	acted: boolean;
	visibleBefore: Set<string>;
	intent?: string;
	settled: string;
	current: string;
	proposals: { verb: string; params: unknown }[];
	warnings: TurnWarning[];
	usage: TokenUsage[];
}

export class Engine {
	readonly sim: Simulation;
	private readonly def: GameDef;
	private session: SessionHandle;
	private readonly sessionManager: SessionManager;
	private readonly memory: MemoryTurn[];
	private readonly run: RunState;
	private readonly channel: TurnChannel;
	/** 本回合裁决累积（act 工具经 channel 直通回写）。 */
	private outcome: { results: ActionStep[]; elapsed: TickStep[] } = { results: [], elapsed: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		def: GameDef,
		sim: Simulation,
		session: SessionHandle,
		sessionManager: SessionManager,
		memory: MemoryTurn[],
		run: RunState,
		channel: TurnChannel,
	) {
		this.def = def;
		this.sim = sim;
		this.session = session;
		this.sessionManager = sessionManager;
		this.memory = memory;
		this.run = run;
		this.channel = channel;
		channel.onAdjudication = (patch) => {
			if (patch.results) this.outcome.results.push(...patch.results);
			if (patch.elapsed?.length) this.outcome.elapsed = patch.elapsed;
		};
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					// 实时叙述只转译叙述相位的正文（映射期与 thinking 不入通道）
					if (event.assistantMessageEvent.type === "text_delta" && this.run.phase === "narration") {
						const delta = event.assistantMessageEvent.delta;
						this.run.current += delta;
						this.emit({ type: "narration_delta", delta });
					}
					break;
				case "message_end":
					// 生成代入账：正常终结（stop/length/toolUse/aborted）并入 settled；
					// error 暂扣在 current——pi 将视重试与否移除（重生成）或保留（预算耗尽），分别由下方与定稿裁决
					if (event.message.role === "assistant" && this.run.phase === "narration" && event.message.stopReason !== "error") {
						this.run.settled += this.run.current;
						this.run.current = "";
					}
					break;
				case "auto_retry_start":
					// pi 移除失败消息并重生成：在途文本作废，叙述块清零（残段不得混入定稿叙述）
					if (this.run.phase === "narration") {
						this.run.current = "";
						this.emit({ type: "narration_reset" });
					}
					break;
				case "agent_end":
					for (const m of event.messages ?? []) {
						const u = (m as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
						if (m.role === "assistant" && u) this.run.usage.push({ input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 });
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
		// 初值 mapping 是失效安全：首个运行前的杂散事件文本会被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", acted: false, visibleBefore: new Set(), settled: "", current: "", proposals: [], warnings: [], usage: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 自动重试只针对传输类可重试错误；重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		const memoryLimit = def.memoryLimit ?? 0;
		if (!Number.isInteger(memoryLimit) || memoryLimit < 0) throw new Error(`GameDef.memoryLimit 须为非负整数，得到 ${String(def.memoryLimit)}`);
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const memory = loadMemory(sessionManager.getEntries(), memoryLimit);
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
		const customTools = [buildActTool(def, sim, run, channel)];

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
		return new Engine(def, sim, session, sessionManager, memory, run, channel);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	/** 运行起步（复位收进一处，避免调用点的属性收窄干扰后续类型分析） */
	private beginRun(phase: "mapping" | "narration", intent?: string): void {
		const r = this.run;
		r.phase = phase;
		r.acted = false;
		r.visibleBefore = phase === "mapping" ? this.sim.visible() : new Set();
		r.intent = intent;
		r.settled = "";
		r.current = "";
		r.proposals = [];
		r.warnings = [];
		r.usage = [];
	}

	/** 回合编排：act 一次性提交（门闩封闭变异窗口）→ 工具结果承载世界回应 → 散文；三段现置于同一次 session.prompt 是部署形态，协议钉通道纪律、不钉调用拓扑。 */
	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { results: [], elapsed: [] };
		this.beginRun("mapping", action.intent);
		const state = this.sim.digest();
		await this.session.prompt(buildTurnPrompt(state, action.intent, action.selection));

		let narration: string;
		if (!this.run.acted) {
			// 模型未调 act：其文本未经裁决、不可作为叙述，回落确定性摘要（近况记为未解析）。
			// 时间律：无裁决即无流逝——本回合世界静止，这是定义，不是缺陷。
			this.run.warnings.push({ round: 1, error: "模型未调用 act 工具，本回合无裁决", attempt: "" });
			narration = this.summarize([]);
		} else {
			// 摘要兜底原料 = 本回合全部事件（玩家动作 + 时间流逝）
			narration = this.settleNarration([...this.outcome.results, ...this.outcome.elapsed]);
		}
		this.recordTurn(action.intent, this.outcome.elapsed);
		return {
			results: this.outcome.results,
			elapsed: this.outcome.elapsed,
			narration,
			proposals: this.run.proposals,
			warnings: this.run.warnings,
			usage: this.run.usage,
		};
	}

	/** 回合落账：近况窗口推进并持久化为会话 custom 条目（不入 LLM 上下文，重启后由 loadMemory 重建）。
	 *  近况 = 回合骨架的 compact 投影（裁决行保留 verdict/理由/事实；变更由状态视图承载）。 */
	private recordTurn(intent: string, elapsed: TickStep[]): void {
		const turn: MemoryTurn = {
			time: this.sim.world.time,
			intent,
			moves: spineLines(this.sim, [...this.outcome.results, ...this.outcome.elapsed], { compact: true }),
		};
		this.memory.push(turn);
		const limit = this.def.memoryLimit ?? 0;
		if (this.memory.length > limit) this.memory.splice(0, this.memory.length - limit);
		try {
			this.sessionManager.appendCustomEntry(MEMORY_CUSTOM_TYPE, turn);
		} catch {
			// 持久化失败不阻断回合：内存窗口仍有效
		}
	}

	/** 场景呈现服务（表达层的场景模式；与 summarize/digest 同类的呈现设施）：
	 *  无意志、无 act 通道、无时间流逝——不写近况、不触门闩：运行直接进入 narration 相位，
	 *  从不写 mapping，行动窗口结构性不存在；越权 act 调用被相位谓词机械拦截。 */
	async narrate(instruction: string, elapsed: TickStep[] = []): Promise<NarrationOutcome> {
		this.beginRun("narration");
		await this.session.prompt(buildNarratePrompt(this.sim, elapsed, instruction));
		return { narration: this.settleNarration(elapsed), warnings: this.run.warnings, usage: this.run.usage };
	}

	/** 叙述收尾：正文为空 → 确定性摘要兜底（强接地）。current 若有暂扣文本（error 生成被 pi 保留），定稿时入账。 */
	private settleNarration(steps: Step[]): string {
		const text = this.run.settled + this.run.current;
		if (text.trim() === "") {
			this.run.warnings.push({ round: 1, error: "散文为空。", attempt: text });
			return this.summarize(steps);
		}
		return text;
	}

	/** 回退摘要：游戏覆写优先（自有声音），缺省 = 回合骨架投影（空步回落 noResponse）。 */
	private summarize(steps: Step[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, player: this.sim.player, steps });
		const lines = spineLines(this.sim, steps);
		return lines.length ? lines.join("\n") : messagesFor(this.def).noResponse;
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
	return `[当前状态]（唯一真相源）：\n${state}\n\n${intentLine}\n\n解析意图并调用 act 工具提交动作提案（构造不出合法提案则提交空提案）；世界裁决后基于返回的结果描写本回合。`;
}

/** 系统提示 = 表达契约（def.voice，世界语言，core 原样注入）+ 协议块（core 生成）。
 *  协议块是引擎机械的说明书（门闩/拒绝契约/保真与指称纪律）；人格与 craft 属世界语言。 */
function buildSystemPrompt(def: GameDef): string {
	const verbs = Object.entries(def.verbs)
		.map(([name, v]) => `- ${name}「${v.label}」：${v.description}${v.entityParams?.length ? `（实体参数：${v.entityParams.join("/")}，只能取可见实体 id）` : ""}`)
		.join("\n");
	const protocol = `把玩家的操作意图解析为动作提案，调用 act 工具提交（本回合只能调用一次）。提交与否只看能否构造出合法提案，不看意图是否合理：动词表中有承载该意图的动词、且实体参数都能取自可见实体 → 构造并提交 actions 列表（{ verb, params }），交由世界法则裁决，预计被世界拒绝也照常提交（拒绝与法则理由由世界给出）；没有动词承载该意图、或意图指称的实体不在可见实体中 → 提交空 actions（空提案即拒绝，不写任何理由），不要硬套承载不了意图的动词或不相干的实体。act 返回世界裁决结果后，基于它把本回合写成面向玩家的文学散文。
呈现调用（开场、时间流逝后的场景描写）没有行动窗口：prompt 顶部标注「呈现服务」，此时不要调用 act，直接输出散文正文。
世界说明：entities 是当前所有可见实体。id 是唯一标识，name 是展示名。extra（存在时）是游戏派生的场景纹理。
可用动词（模拟层强制执行）：
${verbs}

表达纪律：
- 叙述只能跟随 act 返回的裁决结果（尝试、变更、法则事实、新见）与世界状态中的实体和属性。
- 状态与裁决中不存在的物体、人物、现象、后果不得出现——后果由世界法则产生，不由你创造；对已有内容的转写与渲染（措辞、视角、氛围、文学手法）一律自由，只须不与状态矛盾。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的尝试只写尝试本身与世界的拒绝理由，不写未发生的后果。`;
	return def.voice ? `${def.voice}\n\n${protocol}` : protocol;
}

/** 回合事件的世界腔策展（act 工具结果与呈现服务共用）：骨架行 + 协议锚。
 *  骨架行由 spineLines 承担（符号结构 ✓/✗/⏱ + 世界腔原子，internal 恒滤）。
 *  新见段是状态视图装配线的回合内增量：本回合新进入参照域的实体（规则/系统生灭、移动揭晓）
 *  以状态视图同形的实体卡承载——纹理与 id 在裁决当回合即可说、可指名，不欠下一回合的 digest。 */
function formatTurnEvents(sim: Simulation, results: ActionStep[], refused: boolean, intent: string | undefined, revealed: string[], elapsed: TickStep[] = []): string[] {
	const lines = spineLines(sim, [...results, ...elapsed]);
	if (refused) lines.unshift(`玩家的意图「${intent ?? ""}」未被解析为可执行的操作，世界没有回应。`);
	if (revealed.length) {
		lines.push("本回合新见：");
		for (const id of revealed) {
			const e = entity(sim.world, id);
			if (e) lines.push(`  ${JSON.stringify(viewCard(sim.def, e))}`);
		}
	}
	return lines;
}

/** act 工具结果：本回合世界回应的世界腔策展 */
function buildResultView(sim: Simulation, results: ActionStep[], refused: boolean, intent: string | undefined, revealed: string[], elapsed: TickStep[]): string {
	const lines = formatTurnEvents(sim, results, refused, intent, revealed, elapsed);
	return lines.join("\n");
}

function buildNarratePrompt(sim: Simulation, elapsed: TickStep[], instruction: string): string {
	const lines = ["[呈现服务] 本次调用没有行动窗口，不调用 act，直接输出散文正文。", "", `[当前状态]（唯一真相源）：`, sim.digest(), "", ...formatTurnEvents(sim, [], false, undefined, [], elapsed)];
	lines.push("", instruction);
	return lines.join("\n");
}

/** act 工具：本回合唯一的动作提交口（one-shot 门闩）。
 *  execute 内完成：逐动作 apply（裁决→提交→按授予逐刻落钟——时间律的执行在裁决边界内）→ 世界腔策展作为工具结果返回。 */
function buildActTool(def: GameDef, sim: Simulation, run: RunState, channel: TurnChannel) {
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
		description: `向世界提出动作（${Object.keys(def.verbs).join("/")}）。能构造出合法动作（动词承载意图、实体参数取自已可见实体的 id）→ 提交 actions，预计被拒也照常提交；构造不出 → 省略 actions（空提案即拒绝，不写任何理由）。本回合只能调用一次；世界法则会按顺序裁决每个动作并返回结果。`,
		parameters: Type.Object({
			actions: Type.Optional(
				Type.Array(actionSchema, { description: "按顺序执行的动作提案列表；构造不出合法提案时省略本字段" }),
			),
		}),
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			// one-shot 门闩 = 相位谓词：act 仅在 mapping 相位受理（呈现运行与已裁决回合同样在此被拦）
			if (run.phase !== "mapping") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: messagesFor(def).notInActionPhase }) }],
					details: {},
				};
			}
			// act 执行即裁决边界：一次性完成 mapping→narration 转移，此后世界只接受叙述
			run.phase = "narration";
			run.acted = true;
			run.proposals = (params.actions ?? []) as { verb: string; params: unknown }[];
			const hasActions = !!params.actions?.length;
			const results: ActionStep[] = [];
			const elapsed: TickStep[] = [];
			if (hasActions) {
				for (const raw of params.actions!) {
					// 静态形态已在工具边界由 pi 校验（Convert + 严格 Check：错误回模型、可重试、门闩未耗）；
					// 内核的同型检查是前置条件——此处若抛 ProtocolViolation 即 pi/sim 校验偏斜（引擎 bug），pi 的 execute catch 兑为 error result
					const a = raw as { verb: string; params: Record<string, PropValue> };
					// 时间律的执行点在 core：apply 裁决 → 提交 → 按授予刻数逐刻落钟——
					// 后续动作与 systems 都在后一世界态上裁决/运行（世界能在行为之间反应）。
					const res = sim.apply({ verb: a.verb, params: a.params } satisfies Action);
					results.push(res.step);
					elapsed.push(...res.elapsed);
				}
			}
			if (hasActions) channel.onAdjudication?.({ results, elapsed });
			// 以世界腔策展作为工具结果：散文的唯一事件源（叙述只能跟随这里的内容）
			const revealed = [...sim.visible()].filter((id) => !run.visibleBefore.has(id));
			return {
				content: [{ type: "text", text: buildResultView(sim, results, !hasActions, run.intent, revealed, elapsed) }],
				details: {},
			};
		},
	});
}
