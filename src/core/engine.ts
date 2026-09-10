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
import { CHECKPOINT_RECORD_TYPE, TURN_RECORD_TYPE, projectWindow, pruneContext, resume, verbatim } from "./context.ts";
import { deepFreeze, errorText } from "./util.ts";
import { Simulation, entity, spineLines, viewCard, type Action, type ChronicleEntry, type GameDef, type ParamSpec, type Commit, type PromptKit, type RecentEntry, type VerbDef } from "./sim.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider: string;
	model: string;
	thinkingLevel?: string;
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

/** mapping 相位文本丢弃，narration 相位文本留作回合叙述（不入账）；settled/current 的归属镜像 pi 的事件语义。 */
interface RunState {
	phase: "mapping" | "narration";
	visibleBefore: Set<string>;
	utterance?: string | undefined;
	settled: string;
	current: string;
	steps: Commit[];
	warnings: string[];
	usage: TokenUsage[];
}

/** 装载与定稿共享的档案态：records 是近况窗口源，lastSeq 是定稿序位 */
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

	/** 装载即对账（resume），档案单侧：引擎自日志组装世界。 */
	static async create(def: GameDef, options: EngineOptions): Promise<Engine> {
		if (def.recentWindow === undefined) throw new Error("GameDef.recentWindow 必填：近况窗口是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (typeof def.prompt?.system !== "string" || def.prompt.system.trim() === "") throw new Error("GameDef.prompt.system 必填：表达纪律与回合协议的告知面");
		if (!Number.isInteger(def.recentWindow) || def.recentWindow < 0) throw new Error(`GameDef.recentWindow 须为非负整数（回合记录数），得到 ${String(def.recentWindow)}`);

		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const resumed = resume(def, sessionManager.getEntries());
		const archive: Archive = { records: resumed.records, lastSeq: resumed.lastSeq, dead: null };

		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const modelDef = modelRuntime.getModel(options.provider, options.model);
		if (!modelDef) throw new Error(`模型 ${options.provider}/${options.model} 不可用`);

		const thinkingLevel = options.thinkingLevel ?? "high";
		// 初值 mapping：运行前的杂散文本被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", visibleBefore: new Set(), settled: "", current: "", steps: [], warnings: [], usage: [] };
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

	/** 已定稿回合数；档案链截断后等于存活回合数。 */
	get turn(): number {
		return this.archive.lastSeq;
	}

	private beginRun(phase: "mapping" | "narration", utterance?: string): void {
		const r = this.run;
		r.phase = phase;
		r.visibleBefore = phase === "mapping" ? this.sim.visible() : new Set();
		r.utterance = utterance;
		r.settled = "";
		r.current = "";
		r.warnings = [];
		r.usage = [];
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
			usage: this.run.usage,
		};
	}

	private assertLive(): void {
		if (this.archive.dead !== null) throw new Error(`引擎已毒化（${this.archive.dead}）：须重启进程由日志对账`);
	}

	/** 近况只在回合边界重投影：回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		this.recent.length = 0;
		this.recent.push(...projectWindow(this.sim, this.archive.records));
	}

	async narrate(instruction: string, steps: Commit[] = []): Promise<NarrationOutcome> {
		this.assertLive();
		this.beginRun("narration");
		const kit: PromptKit & { view: string; events: string[]; instruction: string } = { view: this.sim.digest(), events: spineLines(this.sim, steps), instruction, recent: this.recent };
		await this.session.prompt(this.sim.def.prompt?.narrate?.(kit) ?? kit.instruction);
		return { narration: this.settleNarration(steps), warnings: this.run.warnings, usage: this.run.usage };
	}

	private settleNarration(steps: Commit[]): string {
		const text = this.run.settled + this.run.current;
		if (text.trim() === "") {
			this.run.warnings.push("散文为空。");
			return this.fallbackSummary(steps);
		}
		return text;
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

function formatTurnEvents(sim: Simulation, steps: Commit[], revealed: string[], vis: ReadonlySet<string>): string[] {
	const lines = spineLines(sim, steps);
	if (revealed.length) {
		const w = deepFreeze(sim.snapshot());
		const perceiveProp = sim.def.propPerception?.(w, sim.player);
		for (const id of revealed) {
			const e = entity(w, id);
			if (e) lines.push(JSON.stringify(viewCard(sim.def, e, vis, perceiveProp)));
		}
	}
	return lines;
}

function skeletonSummary(sim: Simulation, steps: Commit[]): { text: string; warning?: string } {
	try {
		const lines = spineLines(sim, steps);
		return { text: lines.length ? lines.join("\n") : sim.def.messages.noResponse };
	} catch (e) {
		return { text: sim.def.messages.noResponse, warning: `骨架渲染失败：${errorText(e)}` };
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
	const record: ChronicleEntry = { seq: archive.lastSeq + 1, time: sim.world.time, utterance: run.utterance ?? "", steps: deepFreeze(run.steps) };
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

/** 宿主面 schema 走 JSON Schema 通道；domain 即值域（参数面无 any），ref 的 JSON 型是 string。 */
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
function hostParametersSchema(publicVerbs: [string, VerbDef][]): JsonSchema {
	const paramSchema = (spec: ParamSpec): JsonSchema => ({ type: spec.domain === "ref" ? "string" : spec.domain, ...(spec.description !== undefined && { description: spec.description }) });
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
	const publicVerbs = Object.entries(def.verbs).filter(([, v]) => !v.private);
	return defineTool({
		name: "act",
		label: "act",
		description: `Propose actions to the world (${publicVerbs.map(([n]) => n).join("/")}); the tool result is the world's response. Actions are adjudicated in order, each on the world state left by the previous one; referential params take ids of visible entities; an empty actions array is a refusal.`,
		parameters: {
			type: "object",
			properties: {
				actions: { type: "array", items: hostParametersSchema(publicVerbs) },
			},
		},
		execute: async (_toolCallId, params: { actions?: unknown[] }) => {
			if (run.phase !== "mapping") {
				// 占用后的再次调用：空白结果加 terminate，防模型无界空转
				return { content: [{ type: "text", text: " " }], details: {}, terminate: true };
			}
			const proposed = (params.actions ?? []) as Action[];
			// 形态校验完全托付宿主面（execute 前整批拦截）
			run.phase = "narration";
			const steps: Commit[] = [];
			let crashed: string | null = null;
			try {
				applyBatch(sim, proposed, steps);
			} catch (e) {
				// 形态违约已在窗口前拦截，此处只剩投影与内核缺陷：apply 边界重抛代谢为可审计回合——已裁决步照常入账
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
			let text: string;
			try {
				// 投影失灵时不重入 visible()：新见段缺席
				const vis = crashed ? new Set<string>() : sim.visible();
				const revealed = crashed ? [] : [...vis].filter((id) => !run.visibleBefore.has(id));
				const lines = formatTurnEvents(sim, steps, revealed, vis);
				if (crashed) lines.push(def.messages.noResponse);
				text = lines.join("\n");
				if (text === "") text = def.messages.noResponse;
			} catch (e) {
				// 呈现缺陷不得丢弃已定稿的账目：回落确定性摘要
				run.warnings.push(`结果投影抛错：${errorText(e)}`);
				const fallback = skeletonSummary(sim, steps);
				if (fallback.warning) run.warnings.push(fallback.warning);
				text = fallback.text;
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
