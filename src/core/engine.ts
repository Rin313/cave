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
import { CHECKPOINT_RECORD_TYPE, TURN_RECORD_TYPE, recentEntries, pruneContext, resume, verbatim } from "./context.ts";
import { Simulation, catalog, deepFreeze, errorText, speak, spineLines, verbFace, type Action, type ChronicleEntry, type Commit, type GameDef, type PromptKit, type RecentEntry, type Speech, type VerbFace } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface ActOutcome {
	steps: Commit[];
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

/** mapping 相位文本丢弃，narration 相位文本留作回合叙述（不入账），结算时从消息账本重读。 */
interface RunState {
	phase: "mapping" | "narration";
	utterance?: string | undefined;
	messageStart: number;
	entryStart: number;
	steps: Commit[];
	warnings: string[];
}

/** 装载与定稿共享的档案态：records 是全部存活回合（近况选择与投影的源），lastSeq 是定稿序位 */
interface Archive {
	records: ChronicleEntry[];
	lastSeq: number;
	dead: string | null;
}

export class Engine {
	readonly sim: Simulation;
	private session: SessionHandle;
	private readonly recent: RecentEntry[];
	/** 定稿写点（act 工具尾）与近况选择的共同源；保留全部存活回合记录。 */
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
						this.emit({ type: "narration_delta", delta: event.assistantMessageEvent.delta });
					}
					break;
				case "auto_retry_start":
					if (this.run.phase === "narration") this.emit({ type: "narration_reset" });
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

	/** 装载即对账（resume），档案单侧：引擎自日志组装世界。 */
	static async create(def: GameDef, options: EngineOptions): Promise<Engine> {
		if (def.recent === undefined && def.recentWindow === undefined) throw new Error("GameDef.recent / recentWindow 至少必填其一：近况是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (def.recentWindow !== undefined && (!Number.isInteger(def.recentWindow) || def.recentWindow < 0)) throw new Error(`GameDef.recentWindow 须为非负整数（回合记录数），得到 ${String(def.recentWindow)}`);
		if (typeof def.prompt?.system !== "string" || def.prompt.system.trim() === "") throw new Error("GameDef.prompt.system 必填：表达纪律与回合协议的告知面");

		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const resumed = resume(def, sessionManager.getBranch());
		const archive: Archive = { records: resumed.records, lastSeq: resumed.lastSeq, dead: null };

		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const modelDef = modelRuntime.getModel(options.provider, options.model);
		if (!modelDef) throw new Error(`模型 ${options.provider}/${options.model} 不可用`);

		const thinkingLevel = options.thinkingLevel ?? "high";
		// 初值 mapping：运行前的杂散文本被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", messageStart: 0, entryStart: 0, steps: [], warnings: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 重试请求的历史已含已裁决动作及其结果，模型据此续行
			retry: { enabled: true, maxRetries: 2 },
		});
		const recent: RecentEntry[] = [];
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager,
			systemPrompt: def.prompt.system,
			extensionFactories: [buildContextExtension(def, () => recent)],
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
			thinkingLevel,
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

	/** 已定稿回合数；档案链截断后等于存活回合数。 */
	get turn(): number {
		return this.archive.lastSeq;
	}

	private beginRun(phase: "mapping" | "narration", utterance?: string): void {
		const r = this.run;
		r.phase = phase;
		r.utterance = utterance;
		r.messageStart = this.session.messages.length;
		r.entryStart = this.session.sessionManager.getEntries().length;
		r.warnings = [];
		r.steps = [];
	}

	async act(action: { utterance: string }): Promise<ActOutcome> {
		this.assertLive();
		this.beginRun("mapping", action.utterance);
		const kit: PromptKit & { view: string; utterance: string } = { view: this.sim.digest(), utterance: verbatim(action.utterance), recent: this.recent };
		try {
			await this.session.prompt(this.sim.def.prompt?.turn?.(kit) ?? kit.utterance);
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
			usage: this.collectUsage(),
		};
	}

	private assertLive(): void {
		if (this.archive.dead !== null) throw new Error(`引擎状态已不可信（${this.archive.dead}）：须重启进程由日志对账`);
	}

	/** 近况只在回合边界重投影：回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		try {
			const next = recentEntries(this.sim, this.archive.records, this.run.warnings);
			this.recent.length = 0;
			this.recent.push(...next);
		} catch (e) {
			// 呈现缺陷不得丢弃已定稿的账目：保留上一版近况并显形
			this.run.warnings.push(`近况投影抛错（保留上一版）：${errorText(e)}`);
		}
	}

	async narrate(instruction: string, steps: Commit[] = []): Promise<NarrationOutcome> {
		this.assertLive();
		this.beginRun("narration");
		const kit: PromptKit & { view: string; events: string[]; instruction: string } = { view: this.sim.digest(), events: spineLines(this.sim, steps, this.sim.snapshot()), instruction, recent: this.recent };
		await this.session.prompt(this.sim.def.prompt?.narrate?.(kit) ?? kit.instruction);
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.collectUsage() };
	}

	private settleNarration(steps: Commit[]): string {
		const text = this.narrationText();
		if (text.trim() === "") {
			this.run.warnings.push("散文为空。");
			return this.fallbackSummary(steps);
		}
		return text;
	}

	/** 叙述 = 本回合消息账本中首个 act 结果之后的 assistant 正文；narrate 无 act，取本回合全部正文。 */
	private narrationText(): string {
		const messages = this.session.messages.slice(this.run.messageStart);
		const firstAct = messages.findIndex((m) => m.role === "toolResult" && m.toolName === "act");
		let text = "";
		for (const m of messages.slice(firstAct + 1)) {
			if (m.role !== "assistant" || m.stopReason === "error") continue;
			for (const c of m.content) if (c.type === "text") text += c.text;
		}
		return text;
	}

	/** 用量按档案新增条目重读；被重试作废的尝试已计费且已入档，仍计入。 */
	private collectUsage(): TokenUsage[] {
		const out: TokenUsage[] = [];
		for (const e of this.session.sessionManager.getEntries().slice(this.run.entryStart)) {
			if (e.type !== "message") continue;
			const m = e.message;
			if (m.role !== "assistant") continue;
			const u = m.usage;
			if (u) out.push({ input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 });
		}
		return out;
	}

	private fallbackSummary(steps: Commit[]): string {
		const { text, warning } = skeletonSummary(this.sim, steps);
		if (warning) this.run.warnings.push(warning);
		return text;
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildContextExtension(def: GameDef, recent: () => RecentEntry[]): InlineExtension {
	return {
		name: "context",
		factory: (pi) => {
			pi.on("context", async (event) => {
				const pruned = pruneContext(event.messages);
				const kit: PromptKit = { recent: recent() };
				return { messages: def.prompt?.context?.(pruned, kit) ?? pruned };
			});
		},
	};
}

function skeletonSummary(sim: Simulation, steps: Commit[]): { text: string; warning?: string } {
	try {
		const lines = spineLines(sim, steps, sim.snapshot());
		return { text: lines.length ? lines.join("\n") : speak(sim.def, { kind: "noProposal" }) };
	} catch (e) {
		return { text: interruptedText(sim.def), warning: `骨架渲染失败：${errorText(e)}` };
	}
}

/** 投影失灵的最终兜底：say 自身失败时直取 noResponse。 */
function interruptedText(def: GameDef): string {
	try {
		return speak(def, { kind: "interrupted", phase: "project" });
	} catch {
		return def.messages.noResponse;
	}
}

/** 逐动作落钟：后一动作在后一世界态上裁决，已裁决步实时入 sink。形态预检在窗口占用前完成（通道次序）。 */
function applyBatch(sim: Simulation, actions: readonly Action[], sink: Commit[]): void {
	for (const a of actions) {
		const res = sim.apply(a);
		sink.push(res.step, ...res.elapsed);
	}
}

/** 定稿：窗口关闭即落条目（回合的内容于裁决完成时已完备，叙述不在定义内）；检查点随后追加（缓存，写失败仅告警可迟到） */
function finalizeTurn(sim: Simulation, sessionManager: SessionManager, run: RunState, archive: Archive): void {
	const record: ChronicleEntry = deepFreeze({ seq: archive.lastSeq + 1, time: sim.world.time, utterance: run.utterance ?? "", steps: run.steps });
	sessionManager.appendCustomEntry(TURN_RECORD_TYPE, record);
	archive.records.push(record);
	archive.lastSeq = record.seq;
	try {
		sessionManager.appendCustomEntry(CHECKPOINT_RECORD_TYPE, { seq: record.seq, world: sim.snapshot() });
	} catch (e) {
		run.warnings.push(`检查点追加失败（缓存可迟到，由装载对账补上）：${errorText(e)}`);
	}
}

/** 接口模式走 JSON Schema 通道；ref 的 JSON 型是 string。 */
type JsonSchema = {
	type?: string;
	const?: string;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
	anyOf?: JsonSchema[];
	items?: JsonSchema;
	minItems?: number;
};

/** 接口模式由派生面构造发射：与广告同源，无对既有 schema 图的变换。 */
function hostParametersSchema(face: readonly VerbFace[]): JsonSchema {
	const scalarSchema = (p: VerbFace["params"][number]): JsonSchema => ({
		type: p.type === "ref" ? "string" : p.type,
		...(p.description !== undefined && { description: p.description }),
	});
	const paramSchema = (p: VerbFace["params"][number]): JsonSchema => p.many
		? { type: "array", items: scalarSchema(p), minItems: 1, ...(p.description !== undefined && { description: p.description }) }
		: scalarSchema(p);
	return {
		anyOf: face.map((v) => {
			const required = v.params.filter((p) => !p.optional).map((p) => p.name);
			return {
				type: "object",
				required: ["verb", "params"],
				properties: {
					verb: { type: "string", const: v.id },
					params: {
						type: "object",
						...(required.length > 0 && { required }),
						properties: Object.fromEntries(v.params.map((p) => [p.name, paramSchema(p)])),
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			};
		}),
	};
}

/** act 工具描述缺省：协议约束 + 派生动词目录；作者经 prompt.tool 从 base 委托或覆盖。 */
function baseToolDescription(def: GameDef): string {
	return `Propose actions to the world; the tool result is the world's response. Actions are adjudicated in order, each on the world state left by the previous one; one call opens this turn's adjudication window; an empty actions array is a refusal.\nAvailable verbs:\n${catalog(def.verbs)}`;
}

function buildActTool(def: GameDef, sim: Simulation, run: RunState, archive: Archive, sessionManager: SessionManager) {
	const base = baseToolDescription(def);
	const description = def.prompt.tool?.(base) ?? base;
	if (typeof description !== "string" || description.trim() === "") throw new Error("prompt.tool 须返回非空字符串（act 工具描述）");
	return defineTool({
		name: "act",
		label: "act",
		description,
		parameters: {
			type: "object",
			properties: {
				actions: { type: "array", items: hostParametersSchema(verbFace(def.verbs)) },
			},
		},
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			if (run.phase !== "mapping") {
				// 占用后的再次调用：空白结果加 terminate，防模型无界空转
				return { content: [{ type: "text", text: " " }], details: {}, terminate: true };
			}
			const proposed = (params.actions ?? []) as Action[];
			// 形态校验完全托付接口模式（execute 前整批拦截）
			run.phase = "narration";
			const steps: Commit[] = [];
			let crashed: string | null = null;
			try {
				applyBatch(sim, proposed, steps);
			} catch (e) {
				// 形态违约已在窗口前拦截，此处只剩投影与内核缺陷：apply 边界重抛，已裁决步照常入账
				crashed = errorText(e);
				run.warnings.push(`裁决执行抛错（世界停在最后成功提交）：${crashed}`);
			}
			run.steps = steps;
			// 定稿先于一切呈现：窗口关闭即落条目
			try {
				finalizeTurn(sim, sessionManager, run, archive);
			} catch (e) {
				archive.dead = `定稿落盘失败：${errorText(e)}`;
				run.warnings.push(archive.dead);
			}
			// 事件行与新增呈现分相投影：任一相失灵只降级该相，账目已在定稿
			let lines: string[];
			let projected = false;
			try {
				lines = spineLines(sim, steps, sim.snapshot());
				projected = true;
			} catch (e) {
				run.warnings.push(`事件投影抛错：${errorText(e)}`);
				lines = [interruptedText(def)];
			}
			if (!crashed && projected) {
				try {
					for (const item of sim.reveals(steps)) lines.push(JSON.stringify(item));
				} catch (e) {
					run.warnings.push(`新见段投影抛错：${errorText(e)}`);
				}
			}
			// say 失灵直取 noResponse：呈现缺陷不得丢弃已定稿的账目
			const say = (speech: Speech): string => {
				try {
					return speak(def, speech);
				} catch (e) {
					run.warnings.push(`引擎文本抛错：${errorText(e)}`);
					return def.messages.noResponse;
				}
			};
			if (crashed) lines.push(say({ kind: "interrupted", phase: "adjudicate" }));
			let text = lines.join("\n");
			if (text === "") text = say({ kind: "noProposal" });
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
