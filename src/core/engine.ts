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
import { Simulation, TICK_VERB, internalPropsOf, messagesFor, propLabelOf, stylisticPropsOf, type Action, type Change, type GameDef, type PropValue, type StepResult } from "./sim.ts";
import { touchedIds, validateFactIds, type DeclCtx, type StructuredFact } from "./declare.ts";
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
	/** 本回合时间流逝产出（GameDef.turnTicks 驱动），独立于玩家动作裁决，不计入 kind。 */
	elapsed: StepResult[];
	refusal?: { label: string; reason?: string };
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; actionCount: number; actions?: unknown[] }
	| { type: "tool_result"; results: StepResult[] }
	| { type: "validation"; round: number; error: string; attempt: string }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number };

/** act 工具 execute 向 Engine 直通回写裁决结果（不经事件流嗅探或工具结果解析往返）。 */
interface TurnChannel {
	onAdjudication: ((patch: { results?: StepResult[]; refusal?: { label: string }; elapsed?: StepResult[] }) => void) | null;
}

/** 单回合通道状态：变异窗口门闩 + 声明契约上下文 + 散文缓冲。
 *  Engine.act() 开启门闩并复位其余字段；act 工具首次执行即翻转（本回合唯一裁决）并装配 decl；
 *  散文缓冲只在 decl 非 null（裁决后）收集，每次 declare 调用清空——正文 = 最后一次工具调用之后的文本。 */
interface TurnState {
	gateOpen: boolean;
	acted: boolean;
	visibleBefore: Set<string>;
	intent?: string;
	decl: DeclCtx | null;
	lastDecl: { ok: boolean; error?: string } | undefined;
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
			if (patch.elapsed) this.outcome.elapsed = patch.elapsed;
		};
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta" && this.turn.decl) {
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
		const turn: TurnState = { gateOpen: false, acted: false, visibleBefore: new Set(), decl: null, lastDecl: undefined, textBuf: [] };
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
		const customTools = [buildActTool(def, sim, turn, channel), buildDeclareTool(turn)];

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (thinkingLevel as never),
			resourceLoader: loader,
			settingsManager,
			sessionManager,
			tools: [ACT_TOOL, "declare"],
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
		this.turn.decl = null;
		this.turn.lastDecl = undefined;
		this.turn.textBuf.length = 0;
		this.turn.visibleBefore = this.sim.visible();
		this.turn.intent = intent;
	}

	/** 单 pass 回合：一次会话运行内 act（一次性提交，门闩封闭变异窗口）→ 工具结果承载世界回应 → declare（可选）→ 散文。 */
	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [], elapsed: [] };
		this.openTurn(action.intent);
		const state = this.sim.digest();
		// 动作空间接地可由游戏关闭（GameDef.affordances）：发现式世界不剧透菜单，试错即玩法
		const affordances = this.def.affordances === false ? [] : this.sim.affordances();
		const focusName = this.sim.focus ? (this.sim.world.entities.find((e) => e.id === this.sim.focus)?.name ?? null) : null;
		try {
			await this.session.prompt(buildTurnPrompt(state, action.intent, action.selection, affordances, focusName));
		} finally {
			this.turn.gateOpen = false;
		}

		let narration: string;
		if (!this.turn.acted) {
			// 模型未调 act：其文本未经裁决、不可作为叙述，回落确定性摘要（近况记为未解析）
			this.outcome.refusal = { label: "unparsed" };
			this.emit({ type: "validation", round: 1, error: "模型未调用 act 工具，本回合无裁决", attempt: this.turn.textBuf.join("").trim() });
			narration = this.summarize([]);
		} else {
			narration = this.settleNarration(this.turn.decl?.changes ?? []);
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

	async render(instruction: string, changes: Change[] = []): Promise<void> {
		const results: StepResult[] = changes.length
			? [{ ok: true, reason: messagesFor(this.def).timeChanged, changes, action: { verb: TICK_VERB, params: { n: this.sim.world.time } } }]
			: [];
		const visibleChanges = changes.filter((c) => !internalPropsOf(this.def).has(c.prop));
		this.turn.decl = declCtxOf(this.sim, results, []);
		this.turn.lastDecl = undefined;
		this.turn.textBuf.length = 0;
		try {
			await this.session.prompt(buildRenderPrompt(this.sim, this.turn.decl, results, instruction, this.turn.decl.pending));
		} finally {
			this.turn.decl = null;
		}
		this.emit({ type: "text_delta", delta: this.settleNarration(visibleChanges) });
	}

	/** 叙述收尾：正文为空或声明契约未通过 → 确定性摘要兜底（强接地，无幻觉面）。 */
	private settleNarration(summaryChanges: Change[]): string {
		const text = this.turn.textBuf.join("");
		const last = this.turn.lastDecl;
		const error = text.trim() === "" ? "散文为空。" : last && !last.ok ? (last.error ?? "事实声明未通过校验。") : null;
		if (error) {
			this.emit({ type: "validation", round: 1, error, attempt: text });
			return this.summarize(summaryChanges);
		}
		return text;
	}

	private summarize(changes: Change[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, changes, actor: this.sim.actor });
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

function buildTurnPrompt(state: string, intent: string, selection: string | undefined, affordances: string[] = [], focusName: string | null = null): string {
	const aff = affordances.length
		? `[动作空间] 世界法则当前会授予这些动作（也可提出动作空间之外的动作，世界将逐一裁决，可能被拒绝）：\n${affordances.map((a) => `- ${a}`).join("\n")}\n\n`
		: "";
	const focusLine = focusName
		? `[焦点] ${focusName} 是本回合的显著实体（最近被操作/新出现/被拒绝的对象）。解析指代（「它/那个」）与叙述展开可优先考虑它，但以玩家显式提到的实体为准。\n\n`
		: "";
	const intentLine = selection
		? `玩家意图：「${intent}」（玩家选中的场景文字：「${selection}」）`
		: `玩家意图：「${intent}」`;
	return `[当前状态]（唯一真相源）：\n${state}\n\n${aff}${focusLine}${intentLine}\n\n解析意图并调用 act 工具提交动作提案（或结构化拒绝）；世界裁决后基于返回的结果描写本回合。`;
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
	return `你是文字游戏引擎。每个回合依次两步：

第一步（行动）：把玩家的操作意图解析为动作提案并调用 act 工具（本回合只能调用一次）。能解析 → 提交 actions 列表（{ verb, params }）；无法解析、实体不存在或语境荒谬 → 提交空 actions 与结构化 refusal（仅 label，不写理由）。act 返回世界裁决结果后进入第二步。

第二步（描写）：基于 act 返回的裁决结果，把本回合写成面向玩家的文学散文。若有本回合的新事实需声明，先用 declare 工具提交（可选，可多次调用，以最后一次为准；无新事实则直接写散文），然后输出散文正文。

世界说明：entities 是当前所有可见实体。id 是唯一标识，name 是展示名；实体属性由当前游戏的法则网络定义，见下方提示。

可用动词（模拟层强制执行）：
${verbs}
${stylisticLine}

${hint}
描写硬约束：
- 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象或后果。
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

/** 变更的语言无关线性化（数据渲染，core 不内嵌语言词，只做符号连接）：
 *  普通变更 `<name>.<label>: <from> → <to>`；rel 变更 `<from>.<type>.<to>: <from值> → <to值>`；生灭 `+ name` / `- name`。
 *  name/label/type 均为游戏声明的世界语；缺 label 时回退原 prop 名。 */
export function fmtChange(sim: Simulation, c: Change): string {
	if (c.op === "spawn") return `+ ${c.name ?? fmtValue(sim, c.entity)}`;
	if (c.op === "despawn") return `- ${c.name ?? c.entity}`;
	const m = /^rel:([^@]+)@(.+)$/.exec(c.prop);
	if (m) {
		const [type, to] = [m[1]!, m[2]!];
		return `${fmtValue(sim, c.entity)}.${type}.${fmtValue(sim, to)}: ${fmtValue(sim, c.from)} → ${fmtValue(sim, c.to)}`;
	}
	const e = sim.world.entities.find((x) => x.id === c.entity);
	const name = e?.name ?? c.entity;
	const label = propLabelOf(sim.def, c.prop) ?? c.prop;
	return `${name}.${label}: ${fmtValue(sim, c.from)} → ${fmtValue(sim, c.to)}`;
}

/** 回合事件的世界腔策展（act 工具结果与独立渲染共用）：
 *  尝试行（协议性拒绝过滤——引擎↔模型通道流量不是世界事件）、即将发生、新见。core 只做符号连接。 */
function formatTurnEvents(sim: Simulation, results: StepResult[], refusal: { label: string } | undefined, intent: string | undefined, pending: Change[], revealed: string[]): string[] {
	const internal = internalPropsOf(sim.def);
	const lines: string[] = [];
	if (refusal) {
		lines.push(`玩家的意图「${intent ?? ""}」未被解析为可执行的操作，世界没有回应。`);
	}
	const narratable = results.filter((r) => r.deniedBy !== "protocol");
	if (narratable.length) {
		lines.push("本回合尝试：");
		for (const r of narratable) {
			if (r.action.verb === TICK_VERB) {
				// 时间流逝行：世界事件的变更/事实直陈，不是玩家的尝试
				const bits = [r.changes.filter((c) => !internal.has(c.prop)).map((c) => fmtChange(sim, c)).join("；"), ...(r.facts ?? []).map((f) => f.text)].filter(Boolean);
				lines.push(bits.length ? `- ${sim.describeAction(r.action)}：${bits.join("。")}` : `- ${sim.describeAction(r.action)}。`);
				continue;
			}
			const visible = r.changes.filter((c) => !internal.has(c.prop));
			const changes = visible.length ? `  ${visible.map((c) => fmtChange(sim, c)).join("；")}` : "";
			const verdict = r.ok ? r.reason : `${r.reason}（被拒绝）`;
			const facts = r.facts?.length ? `  法则事实：${r.facts.map((f) => f.text).join("；")}` : "";
			const involved = r.involved?.length ? `  涉及：${r.involved.map((id) => fmtValue(sim, id)).join("、")}` : "";
			lines.push(`- 尝试「${sim.describeAction(r.action)}」→ ${verdict}${changes}${facts}${involved}`);
		}
	} else if (!refusal) {
		lines.push("没有任何改变。");
	}
	const pendingVisible = pending.filter((c) => !internal.has(c.prop));
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

/** 声明契约允许实体的 id↔name 词汇表：模型据它把世界腔叙述锚回可声明的 id；
 *  消逝实体用 despawn 变更自带的展示名。 */
function declarableList(sim: Simulation, ctx: DeclCtx): string {
	const vanished = new Map(ctx.changes.filter((c) => c.op === "despawn").map((c) => [c.entity, c.name]));
	const items = touchedIds(ctx).map((id) => {
		const name = sim.world.entities.find((e) => e.id === id)?.name ?? vanished.get(id) ?? id;
		return `${id}（${name}）`;
	});
	return items.length ? `[可声明实体]（声明 facts 时 entities 用这里的 id）：${items.join("、")}` : "";
}

/** act 工具结果：本回合世界回应的世界腔策展——散文的唯一事件源（叙述只能跟随这里的内容）。 */
function buildResultView(sim: Simulation, ctx: DeclCtx, results: StepResult[], refusal: { label: string } | undefined, intent: string | undefined, pending: Change[], revealed: string[]): string {
	const lines = formatTurnEvents(sim, results, refusal, intent, pending, revealed);
	const decl = declarableList(sim, ctx);
	if (decl) lines.push("", decl);
	return lines.join("\n");
}

/** 独立渲染 prompt（无动作裁决的叙述回合，如开场/等待后的场景描写）。 */
function buildRenderPrompt(sim: Simulation, ctx: DeclCtx, results: StepResult[], instruction: string, pending: Change[]): string {
	const focus = sim.focus ? sim.world.entities.find((e) => e.id === sim.focus) : undefined;
	const focusLine = focus ? `[焦点] ${focus.name} 是显著实体，叙述可围绕它展开。\n\n` : "";
	const lines = [`[当前状态]（唯一真相源）：`, sim.digest(), "", focusLine, ...formatTurnEvents(sim, results, undefined, undefined, pending, [])];
	const decl = declarableList(sim, ctx);
	if (decl) lines.push("", decl);
	lines.push("", `${instruction} 新事实先用 declare 工具声明（可选），然后输出散文正文。`);
	return lines.join("\n");
}

/** 本回合声明校验的合法实体集（结构推导）：
 *   actor + 法则 facts 实体（utterance 世界之言除外——话语不授权状态断言）+ 本回合新可见实体
 *   + **授予动作的实体参数与 involved**。
 *   **被拒动作的参数实体不进入**——被拒动作未改变任何状态，其参数（如「把朽木放进关着的陶罐」的陶罐）只应出现在散文里，
 *   否则 `[pot]: 陶罐燃起来` 这类状态矛盾声明会因 pot 是动作参数而漏网。授予动作的参数确已参与状态变更（如 use 的施动工具 torch）。 */
function involvedEntities(sim: Simulation, results: StepResult[], revealed: string[]): Set<string> {
	const vis = sim.visible();
	const involved = new Set<string>([sim.actor]);
	for (const r of results) {
		for (const f of r.facts ?? []) {
			if (f.kind === "utterance") continue; // 世界之言只许转述，不进声明契约 touched
			for (const id of f.entities) involved.add(id);
		}
		if (!r.ok) continue;
		for (const v of Object.values(r.action.params)) {
			if (typeof v === "string" && vis.has(v)) involved.add(v);
		}
		for (const id of r.involved ?? []) involved.add(id);
	}
	for (const id of revealed) involved.add(id);
	return involved;
}

/** 装配声明校验上下文（core/declare.ts 的 DeclCtx）：裁决 + 时间流逝之后的世界，按游戏视角收窄。 */
function declCtxOf(sim: Simulation, results: StepResult[], revealed: string[]): DeclCtx {
	const internal = internalPropsOf(sim.def);
	const changes = results.flatMap((r) => r.changes);
	return {
		world: sim.world,
		visible: sim.visible(),
		involved: involvedEntities(sim, results, revealed),
		changes: changes.filter((c) => !internal.has(c.prop)),
		pending: sim.dryTick(1).flatMap((r) => r.changes),
		vanished: new Set(changes.filter((c) => c.op === "despawn").map((c) => c.entity)),
	};
}

/** declare 工具：新事实的结构化声明通道——事实以结构化参数提交，逐条校验并即时反馈（模型回合内自我纠正），散文正文即纯文本。
 *  校验核心复用 core/declare.ts 的 touched 集推导；上下文由 act 工具执行时装配（裁决 + 时间流逝之后）。 */
function buildDeclareTool(turn: TurnState) {
	return defineTool({
		name: "declare",
		label: "声明事实",
		description: "在描写前声明本回合的新事实（可选，可多次调用，以最后一次为准）。无新事实则无需调用。参数错误会返回逐条修正意见。",
		parameters: Type.Object({
			facts: Type.Array(
				Type.Object({
					entities: Type.Array(Type.String({ description: "涉及的实体 id（必须可见且本回合涉及）" })),
					statement: Type.String({ description: "世界腔陈述" }),
				}),
				{ description: "新事实列表" },
			),
		}),
		execute: async (_toolCallId, params: { facts?: unknown[] }) => {
			if (!turn.decl) {
				return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "世界尚未裁决本回合，需先调用 act 工具。" }) }], details: {} };
			}
			turn.textBuf.length = 0;
			const facts: StructuredFact[] = [];
			for (const raw of Array.isArray(params?.facts) ? params.facts : []) {
				const f = (raw ?? {}) as Record<string, unknown>;
				const entities = Array.isArray(f.entities) ? f.entities.map(String).filter(Boolean) : [];
				const statement = typeof f.statement === "string" ? f.statement : String(f.statement ?? "");
				facts.push({ entities, statement });
			}
			const errors = validateFactIds(facts, turn.decl);
			turn.lastDecl = errors === null ? { ok: true } : { ok: false, error: errors.join("；") };
			return { content: [{ type: "text", text: JSON.stringify(errors === null ? { ok: true } : { ok: false, errors }) }], details: {} };
		},
	});
}

/** act 工具：本回合唯一的动作提交口（one-shot 门闩）。
 *  execute 内完成：裁决（单一瓶颈 adjudicateRaw 口径）→ 回合时间流逝 → 装配声明契约上下文 → 世界腔策展作为工具结果返回。 */
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
			if (hasActions) {
				for (const raw of params.actions!) {
					const a = raw as { verb?: string; params?: Record<string, unknown> };
					// 动词/schema/可见性校验收敛在 sim.apply 的单一裁决瓶颈，与场景/CLI/probe 同一口径。
					const action: Action = {
						verb: a.verb ?? "",
						params: Object.fromEntries(Object.entries(a.params ?? {}).map(([k, v]) => [k, coerceValue(v)])),
					};
					results.push(sim.apply(action));
				}
			}
			// 回合时间流逝（turnTicks）：动作裁决后、描写前推进——无论动作成败世界都继续走
			const elapsed = (def.turnTicks ?? 0) > 0 ? sim.tick(def.turnTicks!) : [];
			channel.onAdjudication?.({ results: hasActions ? results : undefined, refusal, elapsed });
			// 装配声明契约上下文（裁决 + 时间流逝之后的世界），并以世界腔策展作为工具结果
			const revealed = [...sim.visible()].filter((id) => !turn.visibleBefore.has(id));
			turn.decl = declCtxOf(sim, [...results, ...elapsed], revealed);
			return {
				content: [{ type: "text", text: buildResultView(sim, turn.decl, results, refusal, turn.intent, turn.decl.pending, revealed) }],
				details: {},
			};
		},
	});
}
