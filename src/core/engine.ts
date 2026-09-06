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
import { MEMORY_RECORD_TYPE, loadRecords, projectWindow, pruneContext, verbatim, type ChronicleEntry, type RecentEntry } from "./context.ts";
import { deepFreeze } from "./util.ts";
import { Simulation, entity, refParamsOf, spineLines, viewCard, type Action, type GameDef, type Step } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

/** 映射契约单源：系统协议块、act 工具描述、回合提示与门闩文案四方消费同一措辞，不得分叉。 */
const CONTRACT = {
	once: "act 每回合只能在裁决前调用一次",
	commit: "能构造出合法提案（动词承载意图、指称参数都取自可见实体的 id）就提交 actions，预计被世界拒绝也照常提交——意图是否合理由世界法则裁决，不由你判断",
	empty: "构造不出合法提案就提交空 actions（空提案即拒绝，不写任何理由），不要硬套承载不了意图的动词或不相干的实体",
	follow: "act 返回世界裁决结果后，基于它把本回合写成面向玩家的文学散文",
} as const;

/** act 门闩拒绝文案：协议拦截而非世界拒绝，不带世界腔；收件人是模型（通道语言，不进玩家视野）。 */
const ACT_LATCH_MSG = `行动窗口已关闭：${CONTRACT.once}。请忽略本次调用，基于回合内已有内容继续输出散文。`;

/** 状态头协议锚：digest 是世界真相，act 裁决结果在回合内携带其更新。 */
const STATE_HEADER = "[当前状态]（世界真相）：";

export interface ActOutcome {
	/** 本回合事件流：动作步与刻步按构造交错，消费方不得重排。 */
	steps: Step[];
	/** 回合散文：模型生成，为空时回落确定性摘要。 */
	narration: string;
	/** act 工具实际收到的动作提案（审计记录）。 */
	proposals: { verb: string; params: unknown }[];
	/** 过程报警 */
	warnings: string[];
	usage: TokenUsage[];
}

/** 场景呈现（narrate）的返回：无提案通道、无 act 通道。 */
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

/** 流式叙述通道：只承载叙述相位的实时正文（thinking 与映射期文本不入通道），权威全文走返回值；
 *  narration_reset 在重试作废在途生成时发出（镜像 pi 的重试语义）。 */
export type EngineEvent =
	| { type: "narration_delta"; delta: string }
	| { type: "narration_reset" };

/** act 工具 execute 向 Engine 直通回写事件流 */
interface TurnChannel {
	onAdjudication: ((patch: { steps?: Step[] }) => void) | null;
}

/** 单次 session.prompt 的运行状态。两相：mapping（行动窗口开放，text 丢弃）与 narration（text 入账）。
 *  settled 为已终结生成的累计正文，current 为在途生成（终结/重试的归属镜像 pi 的事件语义）。 */
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
	private readonly recent: RecentEntry[];
	/** 持久化的地籍条目（回合定稿），窗口裁剪至 recentWindow；近况投影见 context.ts。 */
	private readonly records: ChronicleEntry[];
	private readonly run: RunState;
	private readonly channel: TurnChannel;
	/** 本回合事件流（act 工具经 channel 直通回写，按构造交错）。 */
	private outcome: { steps: Step[] } = { steps: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		sim: Simulation,
		session: SessionHandle,
		sessionManager: SessionManager,
		recent: RecentEntry[],
		records: ChronicleEntry[],
		run: RunState,
		channel: TurnChannel,
	) {
		this.sim = sim;
		this.session = session;
		this.sessionManager = sessionManager;
		this.recent = recent;
		this.records = records;
		this.run = run;
		this.channel = channel;
		channel.onAdjudication = (patch) => {
			if (patch.steps) this.outcome.steps = patch.steps;
		};
		this.updateRecent();
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta" && this.run.phase === "narration") {
						const delta = event.assistantMessageEvent.delta;
						this.run.current += delta;
						this.emit({ type: "narration_delta", delta });
					}
					break;
				case "message_end":
					// 生成代入账：正常终结并入 settled；error 暂扣在 current（pi 视重试移除或保留，由 auto_retry_start 与定稿裁决）
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

		const thinkingLevel = options.thinkingLevel ?? "high";
		// 初值 mapping 是失效安全：首个运行前的杂散事件文本会被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", acted: false, visibleBefore: new Set(), settled: "", current: "", proposals: [], warnings: [], usage: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 自动重试只针对传输类可重试错误；重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		if (def.recentWindow === undefined) throw new Error("GameDef.recentWindow 必填：近况窗口是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (!Number.isInteger(def.recentWindow) || def.recentWindow < 0) throw new Error(`GameDef.recentWindow 须为非负整数（地籍条目数），得到 ${String(def.recentWindow)}`);
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const records = loadRecords(sessionManager.getEntries());
		const recent: RecentEntry[] = [];
		// no* 全关宿主资源发现（cwd 的 AGENTS.md/扩展/技能不得泄入游戏 prompt）；extensionFactories 只挂上下文策略
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager,
			systemPrompt: buildSystemPrompt(def),
			extensionFactories: [buildContextExtension(() => recent)],
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
			thinkingLevel: thinkingLevel as never,
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: [ACT_TOOL],
			customTools,
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(sim, session, sessionManager, recent, records, run, channel);
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

	/** 回合定稿（写点唯一）：条目入地籍（会话 custom 条目，不入上下文），随后更新近况窗口。 */
	private recordTurn(intent: string, steps: Step[]): void {
		const record: ChronicleEntry = { time: this.sim.world.time, intent, steps };
		this.records.push(record);
		try {
			this.sessionManager.appendCustomEntry(MEMORY_RECORD_TYPE, record);
		} catch {
			// 持久化失败不阻断回合：内存窗口仍有效
		}
		this.updateRecent();
	}

	/** 近况窗口更新：裁剪至 recentWindow（地籍条目数）后整体重投影。
	 *  投影只在窗口更新点（create/recordTurn）发生——同回合的映射与续行调用共享同一近况头，
	 *  回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		const limit = this.sim.def.recentWindow;
		if (this.records.length > limit) this.records.splice(0, this.records.length - limit);
		this.recent.length = 0;
		this.recent.push(...projectWindow(this.sim, this.records));
	}

	/** 场景呈现：无提案通道、无行动窗口——不写近况、不触门闩；运行直接进入 narration 相位，越权 act 调用被相位谓词拦截。 */
	async narrate(instruction: string, steps: Step[] = []): Promise<NarrationOutcome> {
		this.beginRun("narration");
		await this.session.prompt(buildNarratePrompt(this.sim, steps, instruction));
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.run.usage };
	}

	/** 叙述收尾：正文为空 → 取确定性摘要。current 若有暂扣文本（error 生成被 pi 保留），定稿时入账。 */
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

/** 上下文策略扩展：每次调用前把消息裁剪为「近况 + 当前运行后缀」（core/context.ts），会话文件不受影响。 */
function buildContextExtension(recent: () => readonly RecentEntry[]): InlineExtension {
	return {
		name: "cave-context",
		factory: (pi) => {
			pi.on("context", async (event) => ({ messages: pruneContext(event.messages, recent()) }));
		},
	};
}

function buildTurnPrompt(state: string, intent: string, selection: string | undefined): string {
	const intentLine = selection
		? `玩家意图：${verbatim(intent)}（玩家选中的场景文字：${verbatim(selection)}）`
		: `玩家意图：${verbatim(intent)}`;
	return `${STATE_HEADER}\n${state}\n\n${intentLine}\n\n解析意图并调用 act 工具提交动作提案（${CONTRACT.empty}）；${CONTRACT.follow}。`;
}

/** 系统提示 = def.voice（原样注入）+ 协议块（core 生成：one-shot 门闩、拒绝契约、表达纪律）。 */
function buildSystemPrompt(def: GameDef): string {
	// internal 动词不进系统提示：不可提案的动词在工具边界同样被拒
	const verbs = Object.entries(def.verbs).filter(([, v]) => !v.internal)
		.map(([name, v]) => {
			const refs = refParamsOf(v);
			return `- ${name}「${v.label}」：${v.description}${refs.length ? `（指称参数：${refs.join("/")}——只能取可见实体 id）` : ""}`;
		})
		.join("\n");
	const protocol = `把玩家的操作意图解析为动作提案，调用 act 工具提交（${CONTRACT.once}）。${CONTRACT.commit}；${CONTRACT.empty}。${CONTRACT.follow}。
呈现调用（开场、时间流逝后的场景描写）没有行动窗口：prompt 顶部标注「呈现服务」，此时不要调用 act，直接输出散文正文。
世界说明：entities 是当前所有可见实体，relations 是可见的关系边（from/to 为实体 id，type 为关系名）。id 是唯一标识，name 是展示名。extra（存在时）是游戏派生的场景纹理。
可用动词（模拟层强制执行）：
${verbs}

表达纪律：
- 叙述只能跟随 act 返回的裁决结果（尝试、变更、法则事实、新见）与世界状态中的实体和属性。
- 状态与裁决中不存在的物体、人物、现象、后果不得出现——后果由世界法则产生，不由你创造；对已有内容的转写与渲染（措辞、视角、氛围、文学手法）一律自由，只须不与状态矛盾。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的尝试只写尝试本身与世界的拒绝理由，不写未发生的后果。`;
	return def.voice ? `${def.voice}\n\n${protocol}` : protocol;
}

/** act 工具结果与呈现服务共用的事件策展：spineLines 骨架行 + 未解析行 + 新见段（本回合新进可见集的实体卡）。 */
function formatTurnEvents(sim: Simulation, steps: Step[], refused: boolean, intent: string | undefined, revealed: string[]): string[] {
	const lines = spineLines(sim, steps);
	if (refused) lines.unshift(`玩家的意图 ${verbatim(intent ?? "")} 未被解析为可执行的操作，世界没有回应。`);
	if (revealed.length) {
		// 新见卡与状态视图同一装配线：投影钩子收冻结读态（快照克隆，冻结不落活账本）
		const w = deepFreeze(sim.snapshot());
		const perceiveProp = sim.def.propPerception?.(w, sim.player);
		lines.push("本回合新见：");
		for (const id of revealed) {
			const e = entity(w, id);
			if (e) lines.push(`  ${JSON.stringify(viewCard(sim.def, e, perceiveProp))}`);
		}
	}
	return lines;
}

function buildNarratePrompt(sim: Simulation, steps: Step[], instruction: string): string {
	const lines = ["[呈现服务] 本次调用没有行动窗口，不调用 act，直接输出散文正文。", "", STATE_HEADER, sim.digest(), "", ...formatTurnEvents(sim, steps, false, undefined, [])];
	lines.push("", instruction);
	return lines.join("\n");
}

/** act 的提案批次内核：静态形态批次预检在首个裁决前抛出
 *  （否则已裁决动作失去记录），逐动作落钟——后一动作在后一世界态上裁决。
 *  已裁决步实时入 sink：投影/内核缺陷中途抛出时，先于中断动作的步已在册。 */
function applyBatch(sim: Simulation, actions: readonly Action[], sink: Step[]): void {
	if (!actions.length) return;
	sim.validateBatch(actions);
	for (const a of actions) {
		const res = sim.apply(a);
		sink.push(res.step, ...res.elapsed);
	}
}

/** act 工具：映射回合唯一的动作提交口（one-shot 门闩）。execute 经提案批次内核 apply，事件策展作为工具结果返回。 */
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
		description: `向世界提出动作（${publicVerbs.map(([n]) => n).join("/")}）。${CONTRACT.commit}；${CONTRACT.empty}。${CONTRACT.once}；世界法则按顺序裁决每个动作并返回结果。`,
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
			const steps: Step[] = [];
			let crashed: string | null = null;
			try {
				applyBatch(sim, proposed, steps);
			} catch (e) {
				// core 契约：投影/内核缺陷在 apply 边界原子回滚后原样重抛。此处代谢为可审计的回合：
				// 已裁决步照常入账（世界停在最后成功提交），中断点之后的后果不得被叙述虚构
				crashed = e instanceof Error ? e.message : String(e);
				run.warnings.push(`裁决执行抛错（世界停在最后成功提交）：${crashed}`);
			}
			if (steps.length) channel.onAdjudication?.({ steps });
			// 投影已失灵时不重入 visible()（同款缺陷只会再抛一次）：新见段缺席，警告已记
			const revealed = crashed ? [] : [...sim.visible()].filter((id) => !run.visibleBefore.has(id));
			const text = formatTurnEvents(sim, steps, proposed.length === 0, run.intent, revealed).join("\n");
			return {
				content: [{ type: "text", text: crashed ? `${text}\n内部缺陷：以上是中断前已发生的后果；中断的提案已整体回滚，其余不得虚构。` : text }],
				details: {},
			};
		},
	});
}
