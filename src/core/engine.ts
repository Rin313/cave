import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { Simulation, TICK_VERB, internalPropsOf, messagesFor, propLabelOf, stylisticPropsOf, type Action, type Change, type GameDef, type PropValue, type StepResult } from "./sim.ts";
import { validateFactIds, type DeclCtx, type StructuredFact } from "./declare.ts";

export interface EngineOptions {
	modelRuntime?: ModelRuntime;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sim?: Simulation;
	sessionManager?: SessionManager;
}

type SessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

const ACT_TOOL = "act";

export interface ActOutcome {
	kind: "applied" | "rejected" | "refused" | "partial";
	results: StepResult[];
	refusal?: { label: string; reason?: string };
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; actionCount: number; actions?: unknown[] }
	| { type: "tool_result"; results: StepResult[] }
	| { type: "validation"; round: number; error: string; attempt: string }
	| { type: "raw_attempt"; round: number; text: string; error: string | null };

interface ToolResponse {
	results?: StepResult[];
	refusal?: { label: string; reason?: string };
}

interface Refusal {
	label: string;
}

function toolResultTextFrom(tr: { content: readonly unknown[] }): string | undefined {
	const first = tr.content[0];
	if (first && typeof first === "object" && first !== null && "text" in first && typeof (first as { text: unknown }).text === "string") {
		return (first as { text: string }).text;
	}
	return undefined;
}

function parseToolResponse(text: string): ToolResponse | null {
	try {
		const v = JSON.parse(text) as unknown;
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.results)) return { results: o.results as StepResult[] };
			if (o.refusal && typeof o.refusal === "object") {
				const r = o.refusal as Record<string, unknown>;
				return { refusal: { label: String(r.label ?? "refused"), reason: r.reason != null ? String(r.reason) : undefined } };
			}
		}
		if (Array.isArray(v)) return { results: v as StepResult[] };
	} catch {
		/* 非 JSON，忽略 */
	}
	return null;
}

function coerceValue(v: unknown): PropValue {
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null") return null;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) return v;
	if (Array.isArray(v)) return v.map(coerceValue);
	if (typeof v === "object") {
		return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, coerceValue(val)]));
	}
	return String(v);
}

/** 行动阶段门闩：act 工具只能在 act() 期间执行，防止表达 pass 中模型误调工具变异世界。 */
interface ActGate {
	active: boolean;
}

/** declare 工具共享状态：表达 pass 期间注入校验上下文，工具执行时回写最后一次校验结果（undefined = 未调用）。 */
interface DeclToolState {
	ctx: DeclCtx | null;
	last: { ok: boolean; error?: string } | undefined;
}

export class Engine {
	readonly sim: Simulation;
	private readonly def: GameDef;
	private session: SessionHandle;
	private readonly modelRuntime: ModelRuntime;
	private readonly modelDef: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
	private readonly thinkingLevel: string;
	private readonly settingsManager: SettingsManager;
	private readonly gate: ActGate;
	private readonly declState: DeclToolState;
	private readonly textBuf: { arr: string[] };
	private outcome: ActOutcome = { kind: "refused", results: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(
		def: GameDef,
		sim: Simulation,
		session: SessionHandle,
		modelRuntime: ModelRuntime,
		modelDef: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
		thinkingLevel: string,
		settingsManager: SettingsManager,
		gate: ActGate,
		declState: DeclToolState,
		textBuf: { arr: string[] },
	) {
		this.def = def;
		this.sim = sim;
		this.session = session;
		this.modelRuntime = modelRuntime;
		this.modelDef = modelDef;
		this.thinkingLevel = thinkingLevel;
		this.settingsManager = settingsManager;
		this.gate = gate;
		this.declState = declState;
		this.textBuf = textBuf;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						if (!this.gate.active) this.textBuf.arr.push(event.assistantMessageEvent.delta);
					}
					break;
				case "tool_execution_start":
					if (event.toolName === ACT_TOOL) {
						const args = event.args as { actions?: unknown[] };
						this.emit({ type: "tool_call", actionCount: args.actions?.length ?? 0, actions: args.actions });
					}
					break;
				case "turn_end":
					if (!this.gate.active) break;
					let anyApplied = false;
					let anyRejected = false;
					for (const tr of event.toolResults) {
						if (tr.toolName !== ACT_TOOL) continue;
						const text = toolResultTextFrom(tr);
						if (!text) continue;
						const resp = parseToolResponse(text);
						if (!resp) continue;
						if (resp.refusal) {
							this.outcome.kind = "refused";
							this.outcome.refusal = resp.refusal;
							this.emit({ type: "tool_result", results: [] });
							continue;
						}
						const results = resp.results ?? [];
						this.outcome.results.push(...results);
						this.emit({ type: "tool_result", results });
						for (const r of results) {
							if (r.ok) anyApplied = true;
							else anyRejected = true;
						}
					}
					if (anyApplied && anyRejected) this.outcome.kind = "partial";
					else if (anyApplied) this.outcome.kind = "applied";
					else if (anyRejected) this.outcome.kind = "rejected";
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

	static async create(def: GameDef, options: EngineOptions = {}): Promise<Engine> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const provider = options.provider ?? "opencode-go";
		const model = options.model ?? "ox-alpha-free";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const thinkingLevel = (options.thinkingLevel as never) ?? "high";
		const gate: ActGate = { active: false };
		const textBuf: { arr: string[] } = { arr: [] };
		const declState: DeclToolState = { ctx: null, last: undefined };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const loader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => buildSystemPrompt(def),
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const customTools = [buildActTool(def, sim, gate), buildDeclareTool(declState, gate, textBuf)];

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (thinkingLevel as never),
			resourceLoader: loader,
			settingsManager,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			tools: [ACT_TOOL, "declare"],
			customTools,
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(def, sim, session, modelRuntime, modelDef, thinkingLevel, settingsManager, gate, declState, textBuf);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [] };
		this.gate.active = true;
		const state = this.sim.digest();
		const affordances = this.sim.affordances();
		const visibleBefore = this.sim.visible();
		const focusName = this.sim.focus ? (this.sim.world.entities.find((e) => e.id === this.sim.focus)?.name ?? null) : null;
		try {
			await this.session.prompt(buildMappingPrompt(state, action.intent, action.selection, affordances, focusName));
		} finally {
			this.gate.active = false;
		}

		if (this.outcome.kind === "refused" && !this.outcome.refusal) {
			this.outcome.refusal = { label: "unparsed" };
		}

		const results = this.outcome.results;
		const changes = results.flatMap((r) => r.changes);
		const stateAfter = this.sim.digest();
		const pending = this.sim.dryTick(1).flatMap((r) => r.changes);
		const visibleAfter = this.sim.visible();
		const revealed = [...visibleAfter].filter((id) => !visibleBefore.has(id));
		const involved = this.involvedEntities(results, revealed);
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, stateAfter, results, this.outcome.refusal, undefined, [...internalPropsOf(this.def)], pending, action.intent, revealed),
			changes,
			involved,
		);
		this.emit({ type: "text_delta", delta: narration });
		return this.outcome;
	}

	async render(instruction: string, changes: Change[] = []): Promise<void> {
		const state = this.sim.digest();
		const results: StepResult[] = changes.length
			? [{ ok: true, reason: messagesFor(this.def).timeChanged, changes, action: { verb: TICK_VERB, params: { n: this.sim.world.time } } }]
			: [];
		const pending = this.sim.dryTick(1).flatMap((r) => r.changes);
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, state, results, undefined, instruction, [...internalPropsOf(this.def)], pending, undefined, []),
			changes,
			this.involvedEntities(results, []),
		);
		this.emit({ type: "text_delta", delta: narration });
	}

	/** 本回合声明校验的合法实体集（结构推导）：
	 *   actor + 法则 facts 实体 + 本回合新可见实体 + 变更/即将发生实体（declare.ts 的 touchedFrom 从 changes/pending 补齐）
	 *   + **授予动作的实体参数与 involved**。
	 *   **被拒动作的参数实体不进入**——被拒动作未改变任何状态，其参数（如「把朽木放进关着的陶罐」的陶罐）只应出现在散文里，
	 *   否则 `[pot]: 陶罐燃起来` 这类状态矛盾声明会因 pot 是动作参数而漏网。授予动作的参数确已参与状态变更（如 use 的施动工具 torch）。 */
	private involvedEntities(results: StepResult[], revealed: string[]): Set<string> {
		const vis = this.sim.visible();
		const involved = new Set<string>([this.sim.actor]);
		for (const r of results) {
			for (const f of r.facts ?? []) {
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

	/** 装配声明校验上下文（core/declare.ts 的 DeclCtx）：把 sim 状态与游戏视角收窄。 */
	private declCtx(changes: Change[], pending: Change[], involved: Set<string>): DeclCtx {
		return {
			world: this.sim.world,
			visible: this.sim.visible(),
			involved,
			changes,
			pending,
		};
	}

	private async expressionPass(prompt: string, changes: Change[], involved: Set<string>): Promise<string> {
		const internal = internalPropsOf(this.def);
		const visible = changes.filter((c) => !internal.has(c.prop) && !c.prop.startsWith("#"));
		// 声明校验的涉及集保留 #spawn/#destroy 变更（本回合新生的实体须可被 facts 提及），仅剔除内部属性变更。
		const touchedChanges = changes.filter((c) => !internal.has(c.prop));
		const pending = this.sim.dryTick(1).flatMap((r) => r.changes);
		const ctx = this.declCtx(touchedChanges, pending, involved);
		return this.expressionPassRun(prompt, ctx, visible);
	}

	/** 表达层（declare 工具模式）：新事实经 declare 工具结构化提交并逐条校验，模型回合内自我纠正；散文为纯文本，无首行格式。 */
	private async expressionPassRun(prompt: string, ctx: DeclCtx, visible: Change[]): Promise<string> {
		this.declState.ctx = ctx;
		this.declState.last = undefined;
		try {
			const first = await this.runToolAttempt(prompt, 1);
			if (!first.err) return first.text;
			this.emit({ type: "validation", round: 1, error: first.err, attempt: first.text });
			this.declState.last = undefined;
			const retry = await this.runToolAttempt(
				`刚才的描述未通过校验：${first.err}。请重写。若有新事实，必须先用 declare 工具提交并通过校验（按返回的错误修正实体 id）；然后输出散文正文。无新事实则直接写散文，无需任何首行标记。只描述状态中真实存在的事物，不要发明不存在的现象或后果。`,
				2,
			);
			if (!retry.err) return retry.text;
			this.emit({ type: "validation", round: 2, error: retry.err, attempt: retry.text });
			return this.summarize(visible);
		} finally {
			this.declState.ctx = null;
		}
	}

	private async runToolAttempt(p: string, round: number): Promise<{ text: string; err: string | null }> {
		this.textBuf.arr.length = 0;
		try {
			await this.session.prompt(p);
		} catch (err) {
			return { text: "", err: String(err) };
		}
		const text = this.textBuf.arr.join("");
		const last = this.declState.last;
		let err: string | null = null;
		if (text.trim() === "") err = "散文为空。";
		else if (last && !last.ok) err = last.error ?? "事实声明未通过校验。";
		this.emit({ type: "raw_attempt", round, text, error: err });
		return { text, err };
	}

	private summarize(changes: Change[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, changes, actor: this.sim.actor });
		return this.sim.serialize();
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildMappingPrompt(state: string, intent: string, selection: string | undefined, affordances: string[] = [], focusName: string | null = null): string {
	const aff = affordances.length
		? `[动作空间] 世界法则当前会授予这些动作（也可提出动作空间之外的动作，世界将逐一裁决，可能被拒绝）：\n${affordances.map((a) => `- ${a}`).join("\n")}\n\n`
		: "";
	const focusLine = focusName
		? `[焦点] ${focusName} 是本回合的显著实体（最近被操作/新出现/被拒绝的对象）。若玩家未指定实体，指代「它/那个」优先考虑它；但以玩家显式提到的实体为准。\n\n`
		: "";
	const intentLine = selection
		? `玩家意图：「${intent}」（玩家选中的场景文字：「${selection}」）`
		: `玩家意图：「${intent}」`;
	return `[当前状态]（唯一真相源）：\n${state}\n\n${aff}${focusLine}${intentLine}\n\n你的任务：把玩家的操作意图解析为动作提案，并调用 act 工具。规则：
1. 能解析出合理动作 → 调用 act，提交 actions 列表。每个动作是 { verb, params }，动词与参数定义见系统提示中的动词表；实体参数只能取自已可见实体的 id。
2. 无法解析、实体不存在、或语境荒谬 → 调用 act，提交空的 actions，并用 refusal 字段给出 { label }。
3. 禁止在本阶段输出任何散文或解释文字。
4. 调用 act 提交后本阶段立即结束：不要继续调用 declare 工具，也不要输出任何文字；描写阶段由引擎在动作裁决后另行发起，届时才可用 declare。`;
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	const verbs = Object.entries(def.verbs)
		.map(([name, v]) => `- ${name}「${v.label}」：${v.description}${v.entityParams?.length ? `（实体参数：${v.entityParams.join("/")}，只能取可见实体 id）` : ""}`)
		.join("\n");
	return `你是文字游戏引擎。每个回合分两个阶段：

阶段一（解析，调用 act 工具）：把玩家的操作意图解析为动作提案并调用 act 工具。能解析 → 提交 actions 列表（{ verb, params }）；无法解析、实体不存在或语境荒谬 → 提交空的 actions 与结构化 refusal（仅 label，不写理由）。此阶段禁止输出散文。

阶段二（描写）：基于世界给出的当前状态与本回合变更，把场景写成面向玩家的文学散文。此阶段禁止调用 act 工具；若有本回合的新事实需声明，先用 declare 工具提交（可选，可多次调用，无新事实则直接写散文），然后输出散文正文。

世界说明：entities 是当前所有可见实体。id 是唯一标识，name 是展示名；实体属性由当前游戏的法则网络定义，见下方提示。

可用动词（模拟层强制执行）：
${verbs}

${hint}
描写阶段硬约束：
- 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象或后果。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的操作，把世界给出的法则理由融入叙述，让玩家感受到世界的规则。`;
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
 *  普通变更 `<name>.<label>: <from> → <to>`；rel 变更 `<from>.<type>.<to>: <from值> → <to值>`。
 *  name/label/type 均为游戏声明的世界语；缺 label 时回退原 prop 名。 */
export function fmtChange(sim: Simulation, c: Change): string {
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

export function buildExpressionPrompt(
	sim: Simulation,
	state: string,
	results: StepResult[],
	refusal: { label: string; reason?: string } | undefined,
	directive = "请以文学笔触描写当前场景（面向玩家）。",
	internalProps: readonly string[] = [],
	pending: Change[] = [],
	intent?: string,
	revealed: string[] = [],
): string {
	const internal = new Set(internalProps);
	const lines: string[] = [`[当前状态]（唯一真相源）：`, state, ""];
	const stylistic = stylisticPropsOf(sim.def);
	if (stylistic.size) {
		const list = [...stylistic].map((p) => `${p}（${propLabelOf(sim.def, p) ?? p}）`).join("、");
		lines.push(`[可润饰属性] ${list}：描述这些属性时允许合理的文学润饰（如「刻痕斑驳」），但不得虚构其他状态、属性或后果。`, "");
	}
	if (sim.focus) {
		const e = sim.world.entities.find((x) => x.id === sim.focus);
		if (e) lines.push(`[焦点] ${e.name} 是本回合的显著实体（最近被操作/新出现/被拒绝的对象）。叙述可围绕它展开，也可如实描写场景中其他可见实体；不得因此虚构该实体的任何状态。`, "");
	}
	if (results.length) {
		lines.push("本回合尝试：");
		for (const r of results) {
			const visible = r.changes.filter((c) => !internal.has(c.prop) && !c.prop.startsWith("#"));
			const changes = visible.length
				? `  ${visible.map((c) => fmtChange(sim, c)).join("；")}`
				: "";
			const verdict = r.ok ? r.reason : `${r.reason}（被拒绝）`;
			const facts = r.facts?.length ? `  法则事实：${r.facts.map((f) => f.text).join("；")}` : "";
			const involved = r.involved?.length ? `  涉及：${r.involved.map((id) => fmtValue(sim, id)).join("、")}` : "";
			lines.push(`- 尝试「${sim.describeAction(r.action)}」→ ${verdict}${changes}${facts}${involved}`);
		}
	} else if (refusal) {
		lines.push(`玩家的意图「${intent ?? ""}」未被解析为可执行的操作，世界没有回应。`);
	} else {
		lines.push("没有任何改变。");
	}
	const pendingVisible = pending.filter((c) => !internal.has(c.prop) && !c.prop.startsWith("#"));
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
	lines.push(
		"",
		`${directive} 格式：`,
		"1. 若本回合有新事实需声明：先调用 declare 工具提交（每条事实给出涉及的可见实体 id 与陈述；id 只能取「本回合尝试/法则事实/即将发生/本回合新见」涉及的实体）。无新事实则无需声明。",
		"2. 声明通过后，直接输出面向玩家的散文正文（纯文本，无需任何首行标记）。",
		"3. 用实体名称叙述，不出现 id、属性名、工具调用或实现术语；只叙述状态中真实存在的事物与变更。",
		"4. 被拒绝的尝试只写尝试本身；「即将发生」区只写征兆（用「将」「就要」），不得写成已发生。",
	);
	return lines.join("\n");
}

/** declare 工具：表达层新事实的结构化声明通道。取代 [facts:] 首行格式约定 + 正则解析——
 *  事实以结构化参数提交，逐条校验并即时反馈（模型回合内自我纠正），散文正文即纯文本，无需剥首行。
 *  校验核心复用 core/declare.ts 的 touched 集推导。散文缓冲在每次调用时清空：正文 = 最后一次 declare 之后输出的文本。 */
function buildDeclareTool(state: DeclToolState, gate: ActGate, textBuf: { arr: string[] }) {
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
			if (gate.active) {
				return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "declare 仅用于描写阶段。" }) }], details: {} };
			}
			if (!state.ctx) {
				return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "当前不在描写阶段。" }) }], details: {} };
			}
			textBuf.arr.length = 0;
			const facts: StructuredFact[] = [];
			for (const raw of Array.isArray(params?.facts) ? params.facts : []) {
				const f = (raw ?? {}) as Record<string, unknown>;
				const entities = Array.isArray(f.entities) ? f.entities.map(String).filter(Boolean) : [];
				const statement = typeof f.statement === "string" ? f.statement : String(f.statement ?? "");
				facts.push({ entities, statement });
			}
			const errors = validateFactIds(facts, state.ctx);
			state.last = errors === null ? { ok: true } : { ok: false, error: errors.join("；") };
			return { content: [{ type: "text", text: JSON.stringify(errors === null ? { ok: true } : { ok: false, errors }) }], details: {} };
		},
	});
}

function buildActTool(def: GameDef, sim: Simulation, gate: ActGate) {
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
	/** 每个动词的参数校验器（strict：schema 未声明的参数一律打回）。SDK 不校验工具参数，需引擎自检。 */
	const verbValidators = new Map<string, ReturnType<typeof Compile>>();
	for (const [name, v] of Object.entries(def.verbs)) {
		verbValidators.set(name, Compile(Type.Object(v.schema.properties, { additionalProperties: false })));
	}
	return defineTool({
		name: ACT_TOOL,
		label: "世界提案",
		description: `向世界提出动作（${Object.keys(def.verbs).join("/")}）或结构化拒绝。能解析操作 → 提交 actions；无法解析 → 提交空 actions 与 refusal（仅 label）。实体参数必须取自已可见实体的 id；世界法则会按顺序裁决每个动作。`,
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
			if (!gate.active) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								results: [{
									ok: false,
									reason: messagesFor(def).notInActionPhase,
									changes: [],
									action: { verb: "refused", params: {} },
									deniedBy: "rule" as const,
								}],
							}),
						},
					],
					details: {},
				};
			}
			const run = (raw: unknown): StepResult => {
				const a = raw as { verb?: string; params?: Record<string, unknown> };
				const action: Action = {
					verb: a.verb ?? "",
					params: Object.fromEntries(Object.entries(a.params ?? {}).map(([k, v]) => [k, coerceValue(v)])),
				};
				const verb = def.verbs[action.verb];
				if (!verb) {
					return { ok: false, reason: messagesFor(def).unknownVerb(action.verb), changes: [], action, deniedBy: "rule" };
				}
				const validator = verbValidators.get(action.verb)!;
				if (!validator.Check(action.params)) {
					const known = Object.keys((verb.schema as { properties?: Record<string, unknown> }).properties ?? {}).join("/");
					return { ok: false, reason: messagesFor(def).invalidParams(verb.label, known), changes: [], action, deniedBy: "rule" };
				}
				// 可见性须按当前状态逐动作计算：同一工具调用内的多动作（如先 travel 到新地点再移动实体）
				// 不能沿用调用起始时的快照，否则后续动作会对旧位置做可见性裁决。
				const curVis = sim.visible();
				const invalid = (verb.entityParams ?? []).filter((p) => {
					const id = action.params[p];
					return typeof id === "string" && id.length > 0 && !curVis.has(id);
				});
				if (invalid.length) {
					return { ok: false, reason: messagesFor(def).invisibleEntity(invalid), changes: [], action, deniedBy: "rule" };
				}
				return sim.apply(action);
			};
			if (params.refusal && !(params.actions?.length)) {
				return { content: [{ type: "text", text: JSON.stringify({ refusal: { label: params.refusal.label } }) }], details: {} };
			}
			const results: StepResult[] = [];
			for (const raw of params.actions ?? []) {
				results.push(run(raw));
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify({ results }) },
					{ type: "text", text: `执行后的新状态（唯一真相源）：\n${sim.digest()}` },
				],
				details: {},
			};
		},
	});
}
