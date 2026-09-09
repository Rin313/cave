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
import { CHECKPOINT_RECORD_TYPE, TURN_RECORD_TYPE, projectWindow, pruneContext, resume, verbatim, type RecentEntry } from "./context.ts";
import { deepFreeze, errorText } from "./util.ts";
import { ProtocolViolation, Simulation, entity, refParamsOf, spineLines, viewCard, type Action, type ChronicleEntry, type GameDef, type ParamSpec, type Step } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const CONTRACT = {
	once: "act allows exactly one adjudication window per turn; once a proposal enters adjudication, no further act calls are accepted this turn",
	retry: "a call rejected by static form checks does not occupy the window; fix the reported violations and resubmit",
	form: "The proposal failed the static form checks and never entered adjudication: fix the violations below and resubmit",
	commit: "if you can form a legal proposal (the verb carries the intent, referential params take ids of visible entities), submit actions; submit as usual even if you expect the world to deny it — whether the intent is reasonable is adjudicated by world laws, not by you",
	empty: "if you cannot form a legal proposal, submit empty actions (an empty proposal is a refusal; write no rationale); do not force verbs that cannot carry the intent or unrelated entities",
	follow: "after act returns the world's adjudication results, write the turn as literary prose for the player based on them",
} as const;

const ACT_LATCH_MSG = `The action window is closed: ${CONTRACT.once}. Ignore this call and continue writing prose from what the turn already contains.`;

const STATE_HEADER = "[State view] (the slice of the world visible to you; what is not in it cannot be referred to):";

export interface ActOutcome {
	steps: Step[];
	narration: string;
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

/** mapping 相位文本丢弃，narration 相位文本留作回合叙述（不入账）；settled/current 的归属镜像 pi 的事件语义。 */
interface RunState {
	phase: "mapping" | "narration";
	visibleBefore: Set<string>;
	intent?: string | undefined;
	settled: string;
	current: string;
	steps: Step[];
	warnings: string[];
	usage: TokenUsage[];
}

/** 装载与定稿共享的档案态：records 是近况窗口源，lastSeq 是定稿序位，dead 非空即引擎毒化。 */
interface Archive {
	records: ChronicleEntry[];
	lastSeq: number;
	dead: string | null;
}

export class Engine {
	readonly sim: Simulation;
	private session: SessionHandle;
	private readonly recent: RecentEntry[];
	/** 共享档案态：定稿写点（act 工具尾）与近况窗口的共同源；records 只保留窗口内记录。 */
	private readonly archive: Archive;
	/** 装载期诊断：损坏纪要截断、档案链断、检查点弃置的显形出口。 */
	readonly loadWarnings: readonly string[];
	private readonly run: RunState;
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		sim: Simulation,
		session: SessionHandle,
		archive: Archive,
		recent: RecentEntry[],
		run: RunState,
		loadWarnings: string[],
	) {
		this.sim = sim;
		this.session = session;
		this.archive = archive;
		this.recent = recent;
		this.run = run;
		this.loadWarnings = loadWarnings;
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

	/** 装载即对账（resume），档案单侧：引擎自日志组装世界，不经第二档案侧。 */
	static async create(def: GameDef, options: EngineOptions): Promise<Engine> {
		if (def.recentWindow === undefined) throw new Error("GameDef.recentWindow 必填：近况窗口是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (!Number.isInteger(def.recentWindow) || def.recentWindow < 0) throw new Error(`GameDef.recentWindow 须为非负整数（回合记录数），得到 ${String(def.recentWindow)}`);

		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const resumed = resume(def, sessionManager.getEntries());
		const archive: Archive = { records: resumed.records, lastSeq: resumed.lastSeq, dead: null };
		// 检查点自愈：日志缺检查点或落后于证据时补写（缓存写，失败仅告警）
		if (resumed.checkpointSeq === null || resumed.checkpointSeq < resumed.lastSeq) {
			try {
				sessionManager.appendCustomEntry(CHECKPOINT_RECORD_TYPE, { seq: resumed.lastSeq, world: resumed.sim.snapshot() });
			} catch (e) {
				resumed.warnings.push(`检查点补写失败（缓存迟到）：${errorText(e)}`);
			}
		}

		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const modelDef = modelRuntime.getModel(options.provider, options.model);
		if (!modelDef) throw new Error(`模型 ${options.provider}/${options.model} 不可用`);

		const thinkingLevel = options.thinkingLevel ?? "high";
		// 初值 mapping：运行前的杂散文本被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", visibleBefore: new Set(), settled: "", current: "", steps: [], warnings: [], usage: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 重试请求的历史已含已裁决动作及其结果，模型据此续行而非重复提案
			retry: { enabled: true, maxRetries: 2 },
		});
		const recent: RecentEntry[] = [];
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

		const customTools = [buildActTool(def, resumed.sim, run, archive, sessionManager)];

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: thinkingLevel as never,
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: ["act"],
			customTools,
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(resumed.sim, session, archive, recent, run, resumed.warnings);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	private beginRun(phase: "mapping" | "narration", intent?: string): void {
		const r = this.run;
		r.phase = phase;
		r.visibleBefore = phase === "mapping" ? this.sim.visible() : new Set();
		r.intent = intent;
		r.settled = "";
		r.current = "";
		r.warnings = [];
		r.usage = [];
		r.steps = [];
	}

	async act(action: { intent: string }): Promise<ActOutcome> {
		this.assertLive();
		this.beginRun("mapping", action.intent);
		const state = this.sim.digest();
		try {
			await this.session.prompt(buildTurnPrompt(state, action.intent));
		} catch (e) {
			// 窗口未占用 ⇒ 回合未发生，世界与档案均未动，原样上抛；已占用 ⇒ 账目已在工具尾定稿，表达中断只降级呈现
			if (this.run.phase === "mapping") throw e;
			this.run.warnings.push(`表达中断（回合已定稿，呈现回落）：${errorText(e)}`);
		}

		let narration: string;
		if (this.run.phase === "mapping") {
			// 未调 act 的文本未经裁决，回落确定性摘要
			this.run.warnings.push("模型未调用 act 工具，本回合无裁决");
			narration = this.fallbackSummary([]);
		} else {
			narration = this.settleNarration(this.run.steps);
		}
		this.updateRecent();
		return {
			steps: this.run.steps,
			narration,
			warnings: this.run.warnings,
			usage: this.run.usage,
		};
	}

	/** 毒化后的引擎拒绝一切回合与呈现：世界领先于档案时，进程内任何走向都不安全，裁决权移交装载对账。 */
	private assertLive(): void {
		if (this.archive.dead !== null) throw new Error(`引擎已毒化（${this.archive.dead}）：须重启进程由日志对账`);
	}

	/** 近况只在回合边界重投影：回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		this.recent.length = 0;
		this.recent.push(...projectWindow(this.sim, this.archive.records));
	}

	async narrate(instruction: string, steps: Step[] = []): Promise<NarrationOutcome> {
		this.assertLive();
		this.beginRun("narration");
		await this.session.prompt(buildNarratePrompt(this.sim, steps, instruction));
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.run.usage };
	}

	private settleNarration(steps: Step[]): string {
		const text = this.run.settled + this.run.current;
		if (text.trim() === "") {
			this.run.warnings.push("散文为空。");
			return this.fallbackSummary(steps);
		}
		return text;
	}

	private fallbackSummary(steps: Step[]): string {
		const text = this.sim.summarize(steps);
		this.run.warnings.push(...this.sim.warnings.splice(0));
		return text;
	}

	dispose(): void {
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
	return `${STATE_HEADER}\n${state}\n\nPlayer intent: ${verbatim(intent)}\n\nParse the intent and call the act tool to submit an action proposal (${CONTRACT.empty}); ${CONTRACT.follow}.`;
}

function buildSystemPrompt(def: GameDef): string {
	const verbs = Object.entries(def.verbs).filter(([, v]) => !v.internal)
		.map(([name, v]) => {
			const refs = refParamsOf(v);
			return `- ${name} "${v.label}": ${v.description}${refs.length ? ` (reference params: ${refs.join("/")} — must be ids of visible entities)` : ""}`;
		})
		.join("\n");
	const protocol = `Parse the player's operational intent into action proposals and submit them via the act tool (${CONTRACT.once}; ${CONTRACT.retry}). ${CONTRACT.commit}; ${CONTRACT.empty}. ${CONTRACT.follow}.
Rendering calls (opening scenes, scene descriptions after time passes) have no action window: such prompts are headed "[Rendering service]"; do not call act, write the prose text directly.
World notes: entities lists every currently visible entity; relations lists the visible relation edges (from/to are entity ids, type is the relation name). id is the unique identifier, name is the display name. extra, when present, is game-derived scene texture.
Available verbs (enforced by the simulation layer):
${verbs}

Expression discipline:
- Narration may only follow the adjudication results returned by act (attempts, changes, law facts, newly visible entities) and the entities and properties in the world state.
- Objects, people, phenomena, and consequences absent from the state and the adjudication must not appear — consequences are produced by world laws, not invented by you; transcribing and rendering existing content (wording, perspective, atmosphere, literary devices) is entirely free, as long as it does not contradict the state.
- Always refer to entities by name; never expose entity ids, property names, tool calls, or the decision process.
- For a denied attempt, write only the attempt itself and the world's denial reason; never write consequences that did not happen.`;
	return def.voice ? `${def.voice}\n\n${protocol}` : protocol;
}

function formatTurnEvents(sim: Simulation, steps: Step[], refused: boolean, intent: string | undefined, revealed: string[]): string[] {
	const lines = spineLines(sim, steps);
	if (refused) lines.unshift(`The player's intent ${verbatim(intent ?? "")} was not parsed into an executable action; the world gives no response.`);
	if (revealed.length) {
		const w = deepFreeze(sim.snapshot());
		const perceiveProp = sim.def.propPerception?.(w, sim.player);
		lines.push("Newly visible this turn:");
		for (const id of revealed) {
			const e = entity(w, id);
			if (e) lines.push(`  ${JSON.stringify(viewCard(sim.def, e, perceiveProp))}`);
		}
	}
	return lines;
}

function buildNarratePrompt(sim: Simulation, steps: Step[], instruction: string): string {
	const lines = ["[Rendering service] This call has no action window; do not call act; write the prose text directly.", "", STATE_HEADER, sim.digest(), "", ...formatTurnEvents(sim, steps, false, undefined, [])];
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

/** 定稿：窗口关闭即落条目（回合的内容于裁决完成时已完备，叙述不在定义内）；检查点随后追加（缓存，写失败仅告警可迟到）。回合条目写点失败原样抛出，由调用方毒化。 */
function finalizeTurn(sim: Simulation, sessionManager: SessionManager, run: RunState, archive: Archive): void {
	const record: ChronicleEntry = { seq: archive.lastSeq + 1, time: sim.world.time, intent: run.intent ?? "", steps: deepFreeze(run.steps) };
	sessionManager.appendCustomEntry(TURN_RECORD_TYPE, record);
	archive.records.push(record);
	archive.lastSeq = record.seq;
	// 近况窗口：内存档案只保留窗口内记录，全量由会话文件承载
	const excess = archive.records.length - sim.def.recentWindow;
	if (excess > 0) archive.records.splice(0, excess);
	try {
		sessionManager.appendCustomEntry(CHECKPOINT_RECORD_TYPE, { seq: record.seq, world: sim.snapshot() });
	} catch (e) {
		run.warnings.push(`检查点追加失败（缓存迟到，装载对账治愈）：${errorText(e)}`);
	}
}

/** pi 的工具参数校验对无 kind 标记的 schema 走 JSON Schema 通道 */
type JsonSchema = {
	type?: string;
	const?: string;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
	anyOf?: JsonSchema[];
	items?: JsonSchema;
};

/** 宿主面由 params 声明构造发射：构造式派生，无对既有 schema 图的变换。 */
function hostParametersSchema(def: GameDef): JsonSchema {
	const publicVerbs = Object.entries(def.verbs).filter(([, v]) => !v.internal);
	const paramSchema = (spec: ParamSpec): JsonSchema => ({ type: spec.type, ...(spec.description !== undefined && { description: spec.description }) });
	return {
		anyOf: publicVerbs.map(([name, v]) => {
			const entries = Object.entries(v.params);
			const required = entries.filter(([, s]) => !s.optional).map(([p]) => p);
			return {
				type: "object",
				required: ["verb", "params"],
				properties: {
					verb: { type: "string", const: name },
					params: {
						type: "object",
						...(required.length > 0 && { required }),
						properties: Object.fromEntries(entries.map(([p, s]) => [p, paramSchema(s)])),
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			};
		}),
	};
}

function buildActTool(def: GameDef, sim: Simulation, run: RunState, archive: Archive, sessionManager: SessionManager) {
	const publicVerbs = Object.entries(def.verbs).filter(([, v]) => !v.internal);
	const advertised = new Set(publicVerbs.map(([name]) => name));
	return defineTool({
		name: "act",
		label: "World proposal",
		description: `Propose actions to the world (${publicVerbs.map(([n]) => n).join("/")}). ${CONTRACT.commit}; ${CONTRACT.empty}. ${CONTRACT.once}; ${CONTRACT.retry}; world laws adjudicate the actions in order and return the results.`,
		parameters: {
			type: "object",
			properties: {
				actions: { type: "array", items: hostParametersSchema(def), description: "Ordered action proposals to execute; omit this field when no legal proposal can be formed" },
			},
		},
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			if (run.phase !== "mapping") {
				return { content: [{ type: "text", text: ACT_LATCH_MSG }], details: {} };
			}
			const proposed = (params.actions ?? []) as Action[];
			// 形态校验先于窗口占用；act 通道的动词全集是广告面——内核检查裁决面全集，internal 动词由直连 apply 合法使用
			try {
				for (const a of proposed) {
					if (!advertised.has(a.verb)) {
						throw new ProtocolViolation("action.unknown", `verb:${a.verb} (available verbs: ${[...advertised].join(", ")})`);
					}
				}
				sim.validateBatch(proposed);
			} catch (e) {
				if (!(e instanceof ProtocolViolation)) throw e;
				return { content: [{ type: "text", text: `${CONTRACT.form}\n${e.message}` }], details: {} };
			}
			run.phase = "narration";
			const steps: Step[] = [];
			let crashed: string | null = null;
			try {
				applyBatch(sim, proposed, steps);
			} catch (e) {
				// 形态违约已在窗口前拦截，此处只剩投影与内核缺陷：apply 边界重抛代谢为可审计回合——已裁决步照常入账，其余不得虚构
				crashed = errorText(e);
				run.warnings.push(`裁决执行抛错（世界停在最后成功提交）：${crashed}`);
			}
			run.steps = steps;
			// 定稿先于一切呈现：窗口关闭即落条目；写点失败即毒化（世界领先于档案，进程内无安全走向）
			try {
				finalizeTurn(sim, sessionManager, run, archive);
			} catch (e) {
				archive.dead = `turn record persistence failed: ${errorText(e)}`;
				run.warnings.push(archive.dead);
			}
			let text: string;
			try {
				// 投影失灵时不重入 visible()：新见段缺席
				const revealed = crashed ? [] : [...sim.visible()].filter((id) => !run.visibleBefore.has(id));
				text = formatTurnEvents(sim, steps, proposed.length === 0, run.intent, revealed).join("\n");
				if (crashed) text += `\nInternal defect: the above are the consequences that occurred before the interruption; the interrupted proposal was rolled back in full; do not invent the rest.`;
				if (archive.dead) text += `\nInternal defect: ${archive.dead}`;
			} catch (e) {
				// 呈现缺陷不得丢弃已定稿的账目：回落确定性摘要
				run.warnings.push(`结果投影抛错：${errorText(e)}`);
				try {
					text = sim.summarize(steps);
					run.warnings.push(...sim.warnings.splice(0));
				} catch (e2) {
					text = def.messages.noResponse;
					run.warnings.push(`摘要回落失败：${errorText(e2)}`);
				}
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
