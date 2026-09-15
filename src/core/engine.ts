import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type InlineExtension,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { recentEntries, pruneContext } from "./context.ts";
import type { ArchiveStore } from "./archive.ts";
import { Simulation, catalog, deepFreeze, defaultNarratePrompt, defaultTurnPrompt, speak, spineLines, verbFace, type Action, type Card, type ChronicleEntry, type Commit, type GameDef, type Handle, type NarrateKit, type PromptKit, type RecentEntry, type Speech, type TurnKit, type VerbFace } from "./sim.ts";

export interface AgentSpec {
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	modelRuntime: ModelRuntime;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

export interface EngineOptions {
	agent: () => Promise<AgentSpec>;
	/** 宿主全局资源目录（资源发现全部关停，仅用于隔离 pi agent 的 ~/.pi/agent）。 */
	agentDir: string;
	sessionManager?: SessionManager;
	/** 回合记录档案；缺省只留进程内存。 */
	archive?: ArchiveStore;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface ActOutcome {
	steps: Commit[];
	/** 回合变更行与新增呈现：与工具结果同源，一次投影。 */
	lines: string[];
	reveals: (Card | Handle)[];
	narration: string;
	warnings: string[];
}

export interface NarrationOutcome {
	narration: string;
	warnings: string[];
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
	steps: Commit[];
	lines: string[];
	reveals: (Card | Handle)[];
	warnings: string[];
}

/** 装载与定稿共享的账本态：records 是全部存活回合（近况选择与投影的源，表达随记录） */
interface Ledger {
	records: ChronicleEntry[];
	dead: string | null;
}

export class Engine {
	readonly sim: Simulation;
	/** 会话按需建立：装载/浏览不需要模型，首次 act/narrate 才解析并建会话。 */
	private session: SessionHandle | null = null;
	private opening: Promise<SessionHandle> | null = null;
	private readonly options: EngineOptions;
	private readonly loader: DefaultResourceLoader;
	private readonly settingsManager: SettingsManager;
	private readonly sessionManager: SessionManager;
	private readonly customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
	private readonly recent: RecentEntry[];
	/** 定稿写点（表达落定）与近况选择的共同源；保留全部存活回合记录。 */
	private readonly ledger: Ledger;
	/** 装载期诊断：形状损坏条目、末尾不完整与记录不可应用的显形出口。 */
	readonly loadWarnings: readonly string[];
	private readonly run: RunState;
	private listeners = new Set<(event: EngineEvent) => void>();
	/** 单飞窗口：act/narrate 共享同一 run 槽，入口即占；dispose 同受此拒。 */
	private running: "act" | "narrate" | null = null;

	private constructor(
		sim: Simulation,
		options: EngineOptions,
		loader: DefaultResourceLoader,
		settingsManager: SettingsManager,
		sessionManager: SessionManager,
		customTools: NonNullable<CreateAgentSessionOptions["customTools"]>,
		ledger: Ledger,
		recent: RecentEntry[],
		run: RunState,
		loadWarnings: string[],
	) {
		this.sim = sim;
		this.options = options;
		this.loader = loader;
		this.settingsManager = settingsManager;
		this.sessionManager = sessionManager;
		this.customTools = customTools;
		this.ledger = ledger;
		this.recent = recent;
		this.run = run;
		this.loadWarnings = loadWarnings;
		this.updateRecent();
	}

	subscribe(listener: (event: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: EngineEvent): void {
		for (const l of this.listeners) l(event);
	}

	static async create(def: GameDef, options: EngineOptions): Promise<Engine> {
		if (def.recent === undefined && def.recentWindow === undefined) throw new Error("GameDef.recent / recentWindow 至少必填其一：近况是映射层的跨回合指代锚，长短由游戏的物化纪律决定");
		if (def.recentWindow !== undefined && (!Number.isInteger(def.recentWindow) || def.recentWindow < 0)) throw new Error(`GameDef.recentWindow 须为非负整数（回合记录数），得到 ${String(def.recentWindow)}`);
		if (typeof def.prompt?.system !== "string" || def.prompt.system.trim() === "") throw new Error("GameDef.prompt.system 必填：表达纪律与回合协议的告知面");

		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		const loaded = options.archive?.load(def);
		const ledger: Ledger = { records: loaded?.records ?? [], dead: null };
		const sim = loaded?.sim ?? new Simulation(def);
		const loadWarnings = loaded?.warnings ?? [];

		// 初值 mapping：运行前的杂散文本被丢弃而非泄漏为叙述
		const run: RunState = { phase: "mapping", messageStart: 0, steps: [], lines: [], reveals: [], warnings: [] };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			// 重试请求的历史已含已裁决动作及其结果，模型据此续行
			retry: { enabled: true, maxRetries: 2 },
		});
		const recent: RecentEntry[] = [];
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: options.agentDir,
			appendSystemPrompt: [],
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

		const customTools = [buildActTool(def, sim, run)];
		return new Engine(sim, options, loader, settingsManager, sessionManager, customTools, ledger, recent, run, loadWarnings);
	}

	/** 会话按需建立：并发首调共享同一次建立；解析失败原样上抛（配置出口在宿主），世界与档案均未动。 */
	private ensureSession(): Promise<SessionHandle> {
		if (this.session !== null) return Promise.resolve(this.session);
		this.opening ??= this.openSession().catch((e: unknown) => {
			this.opening = null;
			throw e;
		});
		return this.opening;
	}

	private async openSession(): Promise<SessionHandle> {
		const { model, modelRuntime, thinkingLevel } = await this.options.agent();
		const { session } = await createAgentSession({
			model,
			modelRuntime,
			...(thinkingLevel !== undefined && { thinkingLevel }),
			resourceLoader: this.loader,
			settingsManager: this.settingsManager,
			sessionManager: this.sessionManager,
			tools: ["act"],
			customTools: this.customTools,
		});
		this.session = session;
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
		return session;
	}

	get busy(): "act" | "narrate" | null {
		return this.running;
	}

	private beginRun(session: SessionHandle, phase: "mapping" | "narration", utterance?: string): void {
		const r = this.run;
		r.phase = phase;
		r.utterance = utterance;
		r.messageStart = session.messages.length;
		r.warnings = [];
		r.steps = [];
		r.lines = [];
		r.reveals = [];
	}

	/** 回合入口：先占后跑；已占用即拒（壳的并发调用与关闭路径同受此门）。 */
	private enter(kind: "act" | "narrate"): void {
		this.assertLive();
		if (this.running !== null) throw new Error(`回合进行中（${this.running}）：不能开始新回合`);
		this.running = kind;
	}

	async act(action: { utterance: string }): Promise<ActOutcome> {
		this.enter("act");
		try {
			const session = await this.ensureSession();
			this.beginRun(session, "mapping", action.utterance);
			const view = this.sim.view();
			const kit: TurnKit = { view, utterance: JSON.stringify(action.utterance), recent: this.recent };
			try {
				const prompt = this.sim.def.prompt;
				await session.prompt(promptText("prompt.turn", () => (prompt.turn === undefined ? defaultTurnPrompt(kit) : prompt.turn(kit, defaultTurnPrompt))));
			} catch (e) {
				// 窗口未占用 ⇒ 回合未发生，世界与档案均未动，原样上抛；已占用 ⇒ 裁决已完成，表达中断只降级呈现，回合仍将在表达落定时定稿
				if (this.run.phase === "mapping") throw e;
				this.run.warnings.push(`表达中断（呈现回落，回合照常定稿）：${String(e)}`);
			}

			let narration: string;
			if (this.run.phase === "mapping") {
				// 未调 act 的文本未经裁决，回落确定性摘要
				this.run.warnings.push("模型未调用 act 工具，本回合无裁决");
				narration = this.fallbackSummary([]);
			} else {
				try {
					narration = this.settleNarration(session, this.run.steps);
				} catch (e) {
					// 叙述读取是呈现，定稿不依赖它
					this.run.warnings.push(`叙述读取抛错（回落骨架）：${String(e)}`);
					narration = this.fallbackSummary(this.run.steps);
				}
				this.finalizeTurn(narration);
			}
			this.updateRecent();
			return {
				steps: this.run.steps,
				lines: this.run.lines,
				reveals: this.run.reveals,
				narration,
				warnings: this.run.warnings,
			};
		} finally {
			this.running = null;
		}
	}

	private assertLive(): void {
		if (this.ledger.dead !== null) throw new Error(`引擎状态已不可信（${this.ledger.dead}）：须重启进程由档案重建`);
	}

	/** 近况只在回合边界重投影：回合内 prompt 前缀字节稳定（provider 缓存依赖）。 */
	private updateRecent(): void {
		try {
			const next = recentEntries(this.sim, this.ledger.records, this.run.warnings);
			this.recent.length = 0;
			this.recent.push(...next);
		} catch (e) {
			// 呈现缺陷不得丢弃已定稿的账目：保留上一版近况并显形
			this.run.warnings.push(`近况投影抛错（保留上一版）：${String(e)}`);
		}
	}

	async narrate(instruction: string, steps: Commit[] = []): Promise<NarrationOutcome> {
		this.enter("narrate");
		try {
			const session = await this.ensureSession();
			this.beginRun(session, "narration");
			const view = this.sim.view();
			const kit: NarrateKit = { view, events: spineLines(this.sim, steps, this.sim.snapshot()), instruction, recent: this.recent };
			const prompt = this.sim.def.prompt;
			await session.prompt(promptText("prompt.narrate", () => (prompt.narrate === undefined ? defaultNarratePrompt(kit) : prompt.narrate(kit, defaultNarratePrompt))));
			return { narration: this.settleNarration(session, steps), warnings: this.run.warnings };
		} finally {
			this.running = null;
		}
	}

	private settleNarration(session: SessionHandle, steps: Commit[]): string {
		const text = this.narrationText(session);
		if (text.trim() === "") {
			this.run.warnings.push("散文为空。");
			return this.fallbackSummary(steps);
		}
		return text;
	}

	/** 叙述 = 本回合消息账本中首个 act 结果之后的 assistant 正文；narrate 无 act，取本回合全部正文。 */
	private narrationText(session: SessionHandle): string {
		const messages = session.messages.slice(this.run.messageStart);
		const firstAct = messages.findIndex((m) => m.role === "toolResult" && m.toolName === "act");
		let text = "";
		for (const m of messages.slice(firstAct + 1)) {
			if (m.role !== "assistant" || m.stopReason === "error") continue;
			for (const c of m.content) if (c.type === "text") text += c.text;
		}
		return text;
	}

	private fallbackSummary(steps: Commit[]): string {
		const { text, warning } = skeletonSummary(this.sim, steps);
		if (warning) this.run.warnings.push(warning);
		return text;
	}

	/** 定稿：窗口关闭后表达落定，回合与其表达一次追加；落盘失败即引擎不可信（重启后世界与档案停在上一回合，前缀档案无损）。 */
	private finalizeTurn(narration: string): void {
		const record: ChronicleEntry = deepFreeze({ time: this.sim.world.time, utterance: this.run.utterance ?? "", steps: this.run.steps, narration });
		try {
			this.options.archive?.append(record);
		} catch (e) {
			this.ledger.dead = `定稿落盘失败：${String(e)}`;
			this.run.warnings.push(this.ledger.dead);
			return;
		}
		this.ledger.records.push(record);
	}

	dispose(): void {
		if (this.running !== null) throw new Error(`回合进行中（${this.running}）：引擎不能关闭`);
		this.session?.dispose();
	}
}

/** 提示词解析：钩子经所属对象调用（保住 this），缺省实现 base 可委托；返回值须为非空字符串。 */
function promptText(name: string, render: () => string): string {
	const text = render();
	if (typeof text !== "string" || text.trim() === "") throw new Error(`${name} 须返回非空字符串`);
	return text;
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
		return { text: interruptedText(sim.def), warning: `骨架渲染失败：${String(e)}` };
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

function buildActTool(def: GameDef, sim: Simulation, run: RunState) {
	const base = `Propose actions to the world; the tool result is the world's response. Actions are adjudicated in order, each on the world state left by the previous one; one call opens this turn's adjudication window; an empty actions array is a refusal.\nAvailable verbs:\n${catalog(def.verbs)}`;
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
				crashed = String(e);
				run.warnings.push(`裁决执行抛错（世界停在最后成功提交）：${crashed}`);
			}
			run.steps = steps;
			// 事件行与新增呈现分相投影：任一相失灵只降级该相；结果即回合呈现，不重算
			let projected = false;
			try {
				run.lines = spineLines(sim, steps, sim.snapshot());
				projected = true;
			} catch (e) {
				run.warnings.push(`事件投影抛错：${String(e)}`);
				run.lines = [];
			}
			try {
				run.reveals = sim.reveals(steps);
			} catch (e) {
				run.warnings.push(`新见段投影抛错：${String(e)}`);
				run.reveals = [];
			}
			const lines = projected ? [...run.lines] : [interruptedText(def)];
			if (!crashed && projected) for (const item of run.reveals) lines.push(JSON.stringify(item));
			// say 失灵直取 noResponse：呈现缺陷不得丢弃已定稿的账目
			const say = (speech: Speech): string => {
				try {
					return speak(def, speech);
				} catch (e) {
					run.warnings.push(`引擎文本抛错：${String(e)}`);
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
