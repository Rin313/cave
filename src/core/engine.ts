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
import { MEMORY_RECORD_TYPE, loadRecords, projectWindow, pruneContext, repairRecords, verbatim, type ChronicleEntry, type RecentEntry } from "./context.ts";
import { deepFreeze } from "./util.ts";
import { ProtocolViolation, Simulation, entity, refParamsOf, spineLines, viewCard, type Action, type GameDef, type Step } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

/** 映射契约单源：系统提示、工具描述、回合提示、门闩与形态反馈共享同一措辞。 */
const CONTRACT = {
	once: "act 每回合恰一个裁决窗口，提案进入裁决后本回合不再受理",
	retry: "被形态校验拒绝的调用不占窗口，按反馈修正后重新提交",
	form: "提案未通过形态校验，未进入裁决：按以下违约点修正后重新提交",
	commit: "能构造出合法提案（动词承载意图、指称参数都取自可见实体的 id）就提交 actions，预计被世界拒绝也照常提交——意图是否合理由世界法则裁决，不由你判断",
	empty: "构造不出合法提案就提交空 actions（空提案即拒绝，不写任何理由），不要硬套承载不了意图的动词或不相干的实体",
	follow: "act 返回世界裁决结果后，基于它把本回合写成面向玩家的文学散文",
} as const;

/** 协议拦截而非世界拒绝：通道语言，不进玩家视野。 */
const ACT_LATCH_MSG = `行动窗口已关闭：${CONTRACT.once}。请忽略本次调用，基于回合内已有内容继续输出散文。`;

const STATE_HEADER = "[状态视图]（你可见的世界截面；不在其中者，无从指称）：";

export interface ActOutcome {
	steps: Step[];
	narration: string;
	proposals: { verb: string; params: unknown }[];
	warnings: string[];
	usage: TokenUsage[];
}

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

/** 只承载叙述相位的实时正文；narration_reset 镜像 pi 的重试作废语义。 */
export type EngineEvent =
	| { type: "narration_delta"; delta: string }
	| { type: "narration_reset" };

interface TurnChannel {
	onAdjudication: ((patch: { steps?: Step[] }) => void) | null;
}

/** mapping 相位文本丢弃，narration 相位文本入账；settled/current 的归属镜像 pi 的事件语义。 */
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
	/** 回合定稿记录，窗口裁剪至 recentWindow。 */
	private readonly records: ChronicleEntry[];
	/** 装载期诊断：损坏纪要截断的显形出口，loop 打印。 */
	readonly loadWarnings: string[] = [];
	private readonly run: RunState;
	private readonly channel: TurnChannel;
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
		this.repairLoadedRecords();
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
					// error 生成暂扣在 current，由重试作废或定稿裁决
					if (event.message.role === "assistant" && this.run.phase === "narration" && event.message.stopReason !== "error") {
						this.run.settled += this.run.current;
						this.run.current = "";
					}
					break;
				case "auto_retry_start":
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
		// 初值 mapping：运行前的杂散文本被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", acted: false, visibleBefore: new Set(), settled: "", current: "", proposals: [], warnings: [], usage: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		if (def.recentWindow === undefined) throw new Error("GameDef.recentWindow 必填：近况窗口是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (!Number.isInteger(def.recentWindow) || def.recentWindow < 0) throw new Error(`GameDef.recentWindow 须为非负整数（回合记录数），得到 ${String(def.recentWindow)}`);
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const records = loadRecords(sessionManager.getEntries());
		const recent: RecentEntry[] = [];
		// 宿主资源发现全关：cwd 的 AGENTS.md/扩展/技能不得泄入游戏 prompt
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

	async act(action: { intent: string }): Promise<ActOutcome> {
		this.outcome = { steps: [] };
		this.beginRun("mapping", action.intent);
		const state = this.sim.digest();
		await this.session.prompt(buildTurnPrompt(state, action.intent));

		let narration: string;
		if (!this.run.acted) {
			// 未调 act 的文本未经裁决，回落确定性摘要
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

	/** 写点唯一：先落盘后消费——落盘失败即回合未定稿（act 抛错、state 不存），档案两侧同留上一回合。 */
	private recordTurn(intent: string, steps: Step[]): void {
		const record: ChronicleEntry = { time: this.sim.world.time, intent, steps };
		this.sessionManager.appendCustomEntry(MEMORY_RECORD_TYPE, record);
		this.records.push(record);
		this.updateRecent();
	}

	/** 装载修复：窗口裁剪后逐条试投影（完好判据是消费本身），损坏使近况截断至其后完好子后缀；后续写入的记录已经过消费，无需复检。 */
	private repairLoadedRecords(): void {
		const limit = this.sim.def.recentWindow;
		if (this.records.length > limit) this.records.splice(0, this.records.length - limit);
		repairRecords(this.sim, this.records, this.loadWarnings);
	}

	/** 近况只在回合边界重投影：回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		const limit = this.sim.def.recentWindow;
		if (this.records.length > limit) this.records.splice(0, this.records.length - limit);
		this.recent.length = 0;
		this.recent.push(...projectWindow(this.sim, this.records));
	}

	/** 场景呈现：无提案通道、不写近况、不触门闩。 */
	async narrate(instruction: string, steps: Step[] = []): Promise<NarrationOutcome> {
		this.beginRun("narration");
		await this.session.prompt(buildNarratePrompt(this.sim, steps, instruction));
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.run.usage };
	}

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

function buildContextExtension(recent: () => readonly RecentEntry[]): InlineExtension {
	return {
		name: "context",
		factory: (pi) => {
			pi.on("context", async (event) => ({ messages: pruneContext(event.messages, recent()) }));
		},
	};
}

function buildTurnPrompt(state: string, intent: string): string {
	return `${STATE_HEADER}\n${state}\n\n玩家意图：${verbatim(intent)}\n\n解析意图并调用 act 工具提交动作提案（${CONTRACT.empty}）；${CONTRACT.follow}。`;
}

function buildSystemPrompt(def: GameDef): string {
	const verbs = Object.entries(def.verbs).filter(([, v]) => !v.internal)
		.map(([name, v]) => {
			const refs = refParamsOf(v);
			return `- ${name}「${v.label}」：${v.description}${refs.length ? `（指称参数：${refs.join("/")}——只能取可见实体 id）` : ""}`;
		})
		.join("\n");
	const protocol = `把玩家的操作意图解析为动作提案，调用 act 工具提交（${CONTRACT.once}；${CONTRACT.retry}）。${CONTRACT.commit}；${CONTRACT.empty}。${CONTRACT.follow}。
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

function formatTurnEvents(sim: Simulation, steps: Step[], refused: boolean, intent: string | undefined, revealed: string[]): string[] {
	const lines = spineLines(sim, steps);
	if (refused) lines.unshift(`玩家的意图 ${verbatim(intent ?? "")} 未被解析为可执行的操作，世界没有回应。`);
	if (revealed.length) {
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

/** 逐动作落钟：后一动作在后一世界态上裁决，已裁决步实时入 sink。形态预检在窗口占用前完成（通道次序）。 */
function applyBatch(sim: Simulation, actions: readonly Action[], sink: Step[]): void {
	for (const a of actions) {
		const res = sim.apply(a);
		sink.push(res.step, ...res.elapsed);
	}
}

function buildActTool(def: GameDef, sim: Simulation, run: RunState, channel: TurnChannel) {
	const publicVerbs = Object.entries(def.verbs).filter(([, v]) => !v.internal);
	const advertised = new Set(publicVerbs.map(([name]) => name));
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
		description: `向世界提出动作（${publicVerbs.map(([n]) => n).join("/")}）。${CONTRACT.commit}；${CONTRACT.empty}。${CONTRACT.once}；${CONTRACT.retry}；世界法则按顺序裁决每个动作并返回结果。`,
		parameters: Type.Object({
			actions: Type.Optional(
				Type.Array(actionSchema, { description: "按顺序执行的动作提案列表；构造不出合法提案时省略本字段" }),
			),
		}),
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			if (run.phase !== "mapping") {
				return { content: [{ type: "text", text: ACT_LATCH_MSG }], details: {} };
			}
			const proposed = (params.actions ?? []) as Action[];
			// 形态校验先于窗口占用；act 通道的动词全集是广告面——内核检查裁决面全集，internal 动词由直连 apply 合法使用
			try {
				for (const a of proposed) {
					if (!advertised.has(a.verb)) {
						throw new ProtocolViolation("action.unknown", `verb:${a.verb}（可用动词：${[...advertised].join("、")}）`);
					}
				}
				sim.validateBatch(proposed);
			} catch (e) {
				if (!(e instanceof ProtocolViolation)) throw e;
				return { content: [{ type: "text", text: `${CONTRACT.form}\n${e.message}` }], details: {} };
			}
			run.phase = "narration";
			run.acted = true;
			run.proposals = [...proposed];
			const steps: Step[] = [];
			let crashed: string | null = null;
			try {
				applyBatch(sim, proposed, steps);
			} catch (e) {
				// 形态违约已在窗口前拦截，此处只剩投影与内核缺陷：apply 边界重抛代谢为可审计回合——已裁决步照常入账，其余不得虚构
				crashed = e instanceof Error ? e.message : String(e);
				run.warnings.push(`裁决执行抛错（世界停在最后成功提交）：${crashed}`);
			}
			if (steps.length) channel.onAdjudication?.({ steps });
			// 投影失灵时不重入 visible()：新见段缺席
			const revealed = crashed ? [] : [...sim.visible()].filter((id) => !run.visibleBefore.has(id));
			const text = formatTurnEvents(sim, steps, proposed.length === 0, run.intent, revealed).join("\n");
			return {
				content: [{ type: "text", text: crashed ? `${text}\n内部缺陷：以上是中断前已发生的后果；中断的提案已整体回滚，其余不得虚构。` : text }],
				details: {},
			};
		},
	});
}
