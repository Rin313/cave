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
import { MEMORY_RECORD_TYPE, loadRecords, projectWindow, pruneContext, type MemoryTurn, type TurnRecord } from "./context.ts";
import { Simulation, entity, spineLines, viewCard, type Action, type GameDef, type Step } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

/** act 门闩拒绝（通道语言，core 自持）：门闩是裁决边界外的协议拦截——世界没有产生拒绝，
 *  文案不得带世界腔（防止模型把幻影世界事件叙述进散文）；收件人是模型，不进玩家视野。 */
const ACT_LATCH_MSG = "行动窗口已关闭：act 每回合只能在裁决前调用一次。请忽略本次调用，基于回合内已有内容继续输出散文。";

export interface ActOutcome {
	/** 本回合事件流：动作步与其授予刻步按构造交错——回合内时序的唯一权威记录（渲染/地籍/近况共享，不得重排）。 */
	steps: Step[];
	/** 回合散文：模型生成，为空时回落确定性摘要。 */
	narration: string;
	/** act 工具实际收到的动作提案（审计记录）。 */
	proposals: { verb: string; params: unknown }[];
	/** 过程报警（未调 act / 散文为空等叙述兜底） */
	warnings: string[];
	/** 单次 LLM 调用用量，按调用序。 */
	usage: TokenUsage[];
}

/** 场景呈现（narrate）的返回：无意志、无 act 通道。 */
export interface NarrationOutcome {
	narration: string;
	warnings: string[];
	usage: TokenUsage[];
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 流式叙述通道：只承载叙述相位的实时正文（thinking 与映射期文本不入通道），权威全文走返回值。
 *  narration_reset 在重试丢弃在途生成时发出（镜像 pi 的失败消息移除再重生成）。 */
export type EngineEvent =
	| { type: "narration_delta"; delta: string }
	| { type: "narration_reset" };

/** act 工具 execute 向 Engine 直通回写事件流 */
interface TurnChannel {
	onAdjudication: ((patch: { steps?: Step[] }) => void) | null;
}

/** 单次 session.prompt 的运行状态。两相：mapping（行动窗口开放，text 丢弃）、narration（裁决已过或呈现服务，
 *  text 入账）。current 为在途生成正文，message_end 正常终结并入 settled（按生成代记账，镜像 pi 的重试语义）。 */
interface RunState {
	phase: "mapping" | "narration";
	acted: boolean;
	visibleBefore: Set<string>;
	intent?: string | undefined;
	settled: string;
	current: string;
	proposals: { verb: string; params: unknown }[];
	warnings: string[];
	usage: TokenUsage[];
}

export class Engine {
	readonly sim: Simulation;
	private session: SessionHandle;
	private readonly sessionManager: SessionManager;
	private readonly memory: MemoryTurn[];
	/** 持久化的回合条目（intent + steps 原样），窗口裁剪至 memoryLimit；近况投影见 context.ts。 */
	private readonly records: TurnRecord[];
	private readonly run: RunState;
	private readonly channel: TurnChannel;
	/** 本回合事件流（act 工具经 channel 直通回写，按构造交错）。 */
	private outcome: { steps: Step[] } = { steps: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		sim: Simulation,
		session: SessionHandle,
		sessionManager: SessionManager,
		memory: MemoryTurn[],
		records: TurnRecord[],
		run: RunState,
		channel: TurnChannel,
	) {
		this.sim = sim;
		this.session = session;
		this.sessionManager = sessionManager;
		this.memory = memory;
		this.records = records;
		this.updateMemory();
		this.run = run;
		this.channel = channel;
		channel.onAdjudication = (patch) => {
			if (patch.steps) this.outcome.steps = patch.steps;
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

	/** def 一律取 sim.def：广告面（act schema 与系统提示）是同一动词表滤除 internal 的投影。 */
	static async create(sim: Simulation, options: EngineOptions): Promise<Engine> {
		const def = sim.def;
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const modelDef = modelRuntime.getModel(options.provider, options.model);
		if (!modelDef) throw new Error(`模型 ${options.provider}/${options.model} 不可用`);

		const thinkingLevel = (options.thinkingLevel as never) ?? "high";
		// 初值 mapping 是失效安全：首个运行前的杂散事件文本会被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", acted: false, visibleBefore: new Set(), settled: "", current: "", proposals: [], warnings: [], usage: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 自动重试只针对传输类可重试错误；重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		if (def.memoryLimit === undefined) throw new Error("GameDef.memoryLimit 必填：近况窗口是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (!Number.isInteger(def.memoryLimit) || def.memoryLimit < 0) throw new Error(`GameDef.memoryLimit 须为非负整数，得到 ${String(def.memoryLimit)}`);
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const records = loadRecords(sessionManager.getEntries());
		const memory: MemoryTurn[] = [];
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
		return new Engine(sim, session, sessionManager, memory, records, run, channel);
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

	/** 回合：一次 session.prompt 内先 act 一次性提交（one-shot 门闩），世界回应经工具结果返回，其后输出散文。 */
	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { steps: [] };
		this.beginRun("mapping", action.intent);
		const state = this.sim.digest();
		await this.session.prompt(buildTurnPrompt(state, action.intent, action.selection));

		let narration: string;
		if (!this.run.acted) {
			// 模型未调 act：其文本未经裁决、不可作为叙述，回落确定性摘要（本回合世界静止）
			this.run.warnings.push("模型未调用 act 工具，本回合无裁决");
			narration = this.sim.summarize([]);
		} else {
			narration = this.settleNarration(this.outcome.steps);
		}
		this.recordTurn(action.intent, this.outcome.steps);
		return {
			steps: this.outcome.steps,
			narration,
			proposals: this.run.proposals,
			warnings: this.run.warnings,
			usage: this.run.usage,
		};
	}

	/** 回合定稿：条目持久化为会话 custom 条目（不入 LLM 上下文），随后更新近况窗口。
	 *  投影缓存永不持久化——重启由 loadRecords + projectWindow 重建。 */
	private recordTurn(intent: string, steps: Step[]): void {
		const record: TurnRecord = { time: this.sim.world.time, intent, steps };
		this.records.push(record);
		try {
			this.sessionManager.appendCustomEntry(MEMORY_RECORD_TYPE, record);
		} catch {
			// 持久化失败不阻断回合：内存窗口仍有效
		}
		this.updateMemory();
	}

	/** 近况窗口更新：裁剪至 memoryLimit 后整体重投影。投影点只在窗口更新时（create/recordTurn），不在每次
	 *  LLM 调用时——同回合的映射与续行调用共享同一近况头，回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateMemory(): void {
		const limit = this.sim.def.memoryLimit;
		if (this.records.length > limit) this.records.splice(0, this.records.length - limit);
		this.memory.length = 0;
		this.memory.push(...projectWindow(this.sim, this.records));
	}

	/** 场景呈现：无意志、无行动窗口——不写近况、不触门闩；运行直接进入 narration 相位，越权 act 调用被相位谓词拦截。 */
	async narrate(instruction: string, steps: Step[] = []): Promise<NarrationOutcome> {
		this.beginRun("narration");
		await this.session.prompt(buildNarratePrompt(this.sim, steps, instruction));
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.run.usage };
	}

	/** 叙述收尾：正文为空 → 确定性摘要兜底。current 若有暂扣文本（error 生成被 pi 保留），定稿时入账。 */
	private settleNarration(steps: Step[]): string {
		const text = this.run.settled + this.run.current;
		if (text.trim() === "") {
			this.run.warnings.push("散文为空。");
			return this.sim.summarize(steps);
		}
		return text;
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

/** 系统提示 = def.voice（原样注入）+ 协议块（core 生成：one-shot 门闩、拒绝契约、表达纪律）。 */
function buildSystemPrompt(def: GameDef): string {
	// internal 动词不进系统提示：不可提案的动词在工具边界同样被拒
	const verbs = Object.entries(def.verbs).filter(([, v]) => !v.internal)
		.map(([name, v]) => {
			const refs = v.entityParams ?? [];
			return `- ${name}「${v.label}」：${v.description}${refs.length ? `（实体参数：${refs.join("/")}——只能取可见实体 id）` : ""}`;
		})
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

/** act 工具结果与呈现服务共用的事件策展：spineLines 骨架行（internal 恒滤）+ 未解析行 + 新见段。
 *  新见段 = 本回合新进可见集的实体，以状态视图同形的实体卡（含 id）承载——当回合即可指名，不欠下一回合的 digest。 */
function formatTurnEvents(sim: Simulation, steps: Step[], refused: boolean, intent: string | undefined, revealed: string[]): string[] {
	const lines = spineLines(sim, steps);
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

function buildResultView(sim: Simulation, steps: Step[], refused: boolean, intent: string | undefined, revealed: string[]): string {
	return formatTurnEvents(sim, steps, refused, intent, revealed).join("\n");
}

function buildNarratePrompt(sim: Simulation, steps: Step[], instruction: string): string {
	const lines = ["[呈现服务] 本次调用没有行动窗口，不调用 act，直接输出散文正文。", "", `[当前状态]（唯一真相源）：`, sim.digest(), "", ...formatTurnEvents(sim, steps, false, undefined, [])];
	lines.push("", instruction);
	return lines.join("\n");
}

/** act 工具：本回合唯一的动作提交口（one-shot 门闩）。execute 内逐动作 apply（裁决→提交→按授予落钟），
 *  事件策展作为工具结果返回——它是散文的唯一事件源。 */
function buildActTool(def: GameDef, sim: Simulation, run: RunState, channel: TurnChannel) {
	// internal 动词不进 act schema：越权提案由 pi 校验拒绝（错误回模型、门闩未耗）
	const publicVerbs = Object.entries(def.verbs).filter(([, v]) => !v.internal);
	const actionSchema = Type.Union(
		publicVerbs.map(([name, v]) =>
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
		description: `向世界提出动作（${publicVerbs.map(([n]) => n).join("/")}）。能构造出合法动作（动词承载意图、实体参数取自已可见实体的 id）→ 提交 actions，预计被拒也照常提交；构造不出 → 省略 actions（空提案即拒绝，不写任何理由）。本回合只能调用一次；世界法则会按顺序裁决每个动作并返回结果。`,
		parameters: Type.Object({
			actions: Type.Optional(
				Type.Array(actionSchema, { description: "按顺序执行的动作提案列表；构造不出合法提案时省略本字段" }),
			),
		}),
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			// one-shot 门闩：act 仅在 mapping 相位受理（呈现运行与已裁决回合同样被拦）
			if (run.phase !== "mapping") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: ACT_LATCH_MSG }) }],
					details: {},
				};
			}
			// 执行即裁决边界：转入 narration 相位，此后文本入叙述
			run.phase = "narration";
			run.acted = true;
			const proposed = (params.actions ?? []) as Action[];
			run.proposals = [...proposed];
			// 事件流按构造交错（动作步 + 其授予刻步）
			const steps: Step[] = [];
			if (proposed.length) {
				// 静态形态已由 pi 校验；内核同型检查（validateBatch）是批次入口的前置条件——
				// 违约在首个裁决前原子抛出（pi/sim 校验偏斜即引擎 bug）
				sim.validateBatch(proposed);
				for (const a of proposed) {
					// 逐动作落钟：后续动作与 systems 都在后一世界态上裁决/运行（世界能在行为之间反应）
					const res = sim.apply(a);
					steps.push(res.step, ...res.elapsed);
				}
			}
			if (proposed.length) channel.onAdjudication?.({ steps });
			const revealed = [...sim.visible()].filter((id) => !run.visibleBefore.has(id));
			return {
				content: [{ type: "text", text: buildResultView(sim, steps, proposed.length === 0, run.intent, revealed) }],
				details: {},
			};
		},
	});
}
