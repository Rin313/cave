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
import { Simulation, TICK_VERB, messagesFor, type Action, type Change, type GameDef, type PropValue, type StepResult } from "./sim.ts";

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
	| { type: "validation"; round: number; error: string; attempt: string };

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

export class Engine {
	readonly sim: Simulation;
	private readonly def: GameDef;
	private session: SessionHandle;
	private readonly modelRuntime: ModelRuntime;
	private readonly modelDef: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
	private readonly thinkingLevel: string;
	private readonly settingsManager: SettingsManager;
	private readonly gate: ActGate;
	private buf: string[] = [];
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
	) {
		this.def = def;
		this.sim = sim;
		this.session = session;
		this.modelRuntime = modelRuntime;
		this.modelDef = modelDef;
		this.thinkingLevel = thinkingLevel;
		this.settingsManager = settingsManager;
		this.gate = gate;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						if (!this.gate.active) this.buf.push(event.assistantMessageEvent.delta);
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
		const model = options.model ?? "deepseek-v4-flash";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const thinkingLevel = (options.thinkingLevel as never) ?? "high";
		const gate: ActGate = { active: false };
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

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (thinkingLevel as never),
			resourceLoader: loader,
			settingsManager,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			tools: [ACT_TOOL],
			customTools: [buildActTool(def, sim, gate)],
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(def, sim, session, modelRuntime, modelDef, thinkingLevel, settingsManager, gate);
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
		const selectionLine = action.selection
			? `玩家选中了文本片段：「${action.selection}」`
			: `玩家未选中任何文本`;
		const focusName = this.sim.focus ? (this.sim.world.entities.find((e) => e.id === this.sim.focus)?.name ?? null) : null;
		try {
			await this.session.prompt(buildMappingPrompt(state, selectionLine, action.intent, affordances, focusName));
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
		const involved = this.involvedEntities(results, this.outcome.refusal, revealed);
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, stateAfter, results, this.outcome.refusal, undefined, this.def.internalProps, pending, action.intent, revealed),
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
			buildExpressionPrompt(this.sim, state, results, undefined, instruction, this.def.internalProps, pending),
			changes,
			this.involvedEntities(results, undefined, []),
		);
		this.emit({ type: "text_delta", delta: narration });
	}

	/** 从表达输出中提取首行的结构化事实声明（[facts: ...]），返回声明与散文体。 */
	private parseDeclaration(text: string): { facts: string[]; body: string } | null {
		const m = text.match(/^\s*\[facts:\s*([^\]]*)\]\s*\n?/);
		if (!m) return null;
		const facts = m[1].split(/[；;]/).map((s) => s.trim()).filter(Boolean);
		return { facts, body: text.slice(m[0].length).trim() };
	}

	/** 本回合涉及集（结构推导）：actor + 规则声明 involved + 法则 facts 实体 + 动作实体参数 + 拒绝主体 + 本回合新可见实体。声明校验的合法提及来源。 */
	private involvedEntities(results: StepResult[], refusal: { label: string; reason?: string } | undefined, revealed: string[]): Set<string> {
		const vis = this.sim.visible();
		const involved = new Set<string>([this.sim.actor]);
		for (const r of results) {
			for (const v of Object.values(r.action.params)) {
				if (typeof v === "string" && vis.has(v)) involved.add(v);
			}
			for (const id of r.involved ?? []) involved.add(id);
			for (const f of r.facts ?? []) {
				for (const id of f.entities) involved.add(id);
			}
			if (r.denial?.subject) involved.add(r.denial.subject);
			if (r.denial?.object) involved.add(r.denial.object);
		}
		for (const id of revealed) involved.add(id);
		return involved;
	}

	/** 声明校验：新事实必须可追溯——声明实体 ⊆ 涉及集 ∪ 变更/即将发生实体，且可见。 */
	private validateDeclaration(decl: { facts: string[]; body: string }, changes: Change[], pending: Change[], involved: Set<string>): string | null {
		if (!decl.body.trim()) return "散文为空。";
		if (!decl.facts.length) return null;
		const vis = this.sim.visible();
		const touched = new Set<string>(involved);
		const relTo = (prop: string): string | null => /^rel:([^@]+)@(.+)$/.exec(prop)?.[1] ?? null;
		for (const c of [...changes, ...pending]) {
			touched.add(c.entity);
			const relT = relTo(c.prop);
			if (relT && this.sim.world.entities.some((e) => e.id === relT)) touched.add(relT);
			if (typeof c.from === "string") touched.add(c.from);
			if (typeof c.to === "string") touched.add(c.to);
		}
		for (const f of decl.facts) {
			for (const e of this.sim.world.entities) {
				if (!vis.has(e.id)) continue;
				if (f.includes(e.id) || f.includes(e.name)) {
					if (!touched.has(e.id)) {
						return `声明「${f}」提及了实体「${e.name}」，但本回合并未涉及该实体——新事实只能来自本回合变更/法则事实/即将发生/本回合涉及实体。`;
					}
				}
			}
			const leaked = this.leakageCheck(f);
			if (leaked) return `声明「${f}」中：${leaked}`;
		}
		return null;
	}

	private async expressionPass(prompt: string, changes: Change[], involved: Set<string>): Promise<string> {
		const internal = new Set(this.def.internalProps ?? []);
		const visible = changes.filter((c) => !internal.has(c.prop));
		const pending = this.sim.dryTick(1).flatMap((r) => r.changes);
		const run = async (p: string): Promise<{ text: string; err: string | null }> => {
			this.buf = [];
			try {
				await this.session.prompt(p);
			} catch (err) {
				return { text: "", err: String(err) };
			}
			const text = this.buf.join("");
			const decl = this.parseDeclaration(text);
			if (!decl) return { text, err: "缺少首行 [facts: ...] 结构化声明。" };
			const declErr = this.validateDeclaration(decl, visible, pending, involved);
			if (declErr) return { text, err: declErr };
			const bodyErr = this.validateNarration(decl.body, visible, pending);
			if (bodyErr) return { text: decl.body, err: bodyErr };
			return { text: decl.body, err: null };
		};

		const first = await run(prompt);
		if (!first.err) return first.text;
		this.emit({ type: "validation", round: 1, error: first.err, attempt: first.text });
		const retry = await run(
			`刚才的描述未通过校验：${first.err}。请重写。必须遵守：首行输出 [facts: 新事实...]（只能来自本回合变更、法则事实、即将发生或本回合新见，无则留空）；只描述状态中真实存在的事物；不要发明不存在的现象或后果。`,
		);
		if (!retry.err) return retry.text;
		this.emit({ type: "validation", round: 2, error: retry.err, attempt: retry.text });
		return this.summarize(visible);
	}

	private summarize(changes: Change[]): string {
		if (this.def.summarize) return this.def.summarize({ world: this.sim.world, changes, actor: this.sim.actor });
		return this.sim.serialize();
	}

	private validateNarration(text: string, changes: Change[], pending: Change[]): string | null {
		if (!text.trim()) return "叙述为空。";
		const leaked = this.leakageCheck(text);
		if (leaked) return leaked;
		const hook = this.def.validateText;
		if (hook) {
			const err = hook({ text, world: this.sim.world, changes, actor: this.sim.actor, pending });
			if (err) return err;
		}
		return null;
	}

	/** 通用泄漏检查：只禁止与语言无关的实现工件，无需任何游戏专有知识与语言设定。
	 *   - 结构化形态：JSON 键值对、声明头 [facts: 复现——任何语言下都是实现痕迹。
	 *   - 「实现形状」的标识符：实体 id / 属性名中非纯小写单词者（含大写/数字/下划线等，如 wooden_chest、wedgedBy、burnTicks），
	 *     在任何语言都不是自然词；纯小写自然词（chest / open）与散文同词，不作禁止。
	 *   - 语言相关词汇约束是游戏的事：经 GameDef.forbiddenTerms / validateText 声明，引擎不感知语言。
	 *  词边界策略：含非 ASCII 的术语用 includes（\b 对中文无效）；纯 ASCII 用词边界（避免命中英文子串）。 */
	private leakageCheck(text: string): string | null {
		if (/"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*(?=["{[]|true|false|null|-?\d)/.test(text)) {
			return "出现了工具调用或状态格式（JSON 键）。";
		}
		if (text.includes("[facts:")) return "正文中出现了声明头 [facts: ...]。";
		const isImplShape = (s: string) => !/^[a-z]+$/.test(s);
		const forbidden = new Set<string>();
		for (const e of this.sim.world.entities) {
			if (isImplShape(e.id) && !e.name.toLowerCase().includes(e.id.toLowerCase())) forbidden.add(e.id);
			for (const k of Object.keys(e.props)) if (isImplShape(k)) forbidden.add(k);
		}
		for (const t of this.def.forbiddenTerms ?? []) forbidden.add(t);
		for (const t of forbidden) {
			const hit = /[^\x00-\x7F]/.test(t) ? text.includes(t) : new RegExp(`\\b${t}\\b`).test(text);
			if (hit) return `出现了实体 id 或实现术语：「${t}」。`;
		}
		return null;
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildMappingPrompt(state: string, selectionLine: string, intent: string, affordances: string[] = [], focusName: string | null = null): string {
	const aff = affordances.length
		? `[动作空间] 世界法则当前会授予这些动作（也可提出动作空间之外的动作，世界将逐一裁决，可能被拒绝）：\n${affordances.map((a) => `- ${a}`).join("\n")}\n\n`
		: "";
	const focusLine = focusName
		? `[焦点] ${focusName} 是本回合的显著实体（最近被操作/新出现/被拒绝的对象）。若玩家未指定实体，指代「它/那个」优先考虑它；但以玩家显式提到的实体为准。\n\n`
		: "";
	return `[当前状态]（JSON，唯一真相源）：\n${state}\n\n${aff}${focusLine}${selectionLine}\n玩家意图：「${intent}」\n\n你的任务：把玩家的操作意图解析为动作提案，并调用 act 工具。规则：
1. 能解析出合理动作 → 调用 act，提交 actions 列表。每个动作是 { verb, params }，动词与参数定义见系统提示中的动词表；实体参数只能取自已可见实体的 id。
2. 无法解析、实体不存在、或语境荒谬 → 调用 act，提交空的 actions，并用 refusal 字段给出 { label }。
3. 禁止在本阶段输出任何散文或解释文字。`;
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	const verbs = Object.entries(def.verbs)
		.map(([name, v]) => `- ${name}「${v.label}」：${v.description}${v.entityParams?.length ? `（实体参数：${v.entityParams.join("/")}，只能取可见实体 id）` : ""}`)
		.join("\n");
	return `你是文字游戏引擎。每个回合分两个阶段：

阶段一（解析，调用 act 工具）：把玩家的操作意图解析为动作提案并调用 act 工具。能解析 → 提交 actions 列表（{ verb, params }）；无法解析、实体不存在或语境荒谬 → 提交空的 actions 与结构化 refusal（仅 label，不写理由）。此阶段禁止输出散文。

阶段二（描写）：基于世界给出的当前状态与本回合变更，把场景写成面向玩家的文学散文。此阶段禁止调用工具。

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
	if (v === null) return "无";
	if (typeof v === "string") {
		const hit = sim.world.entities.find((e) => e.id === v);
		if (hit) return hit.name;
	}
	return String(v);
}

/** 变更的世界腔描述：rel 变更（prop 编码 `rel:<type>@<to>`）格式化为「from 对 to 的 type」，其余保持 entity.prop。 */
function fmtChange(sim: Simulation, c: Change): string {
	const m = /^rel:([^@]+)@(.+)$/.exec(c.prop);
	if (m) {
		const [type, to] = [m[1], m[2]];
		return `${fmtValue(sim, c.entity)} 对 ${fmtValue(sim, to)} 的${type} ${fmtValue(sim, c.from)} → ${fmtValue(sim, c.to)}`;
	}
	return `${c.entity}.${c.prop} ${fmtValue(sim, c.from)} → ${fmtValue(sim, c.to)}`;
}

function buildExpressionPrompt(
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
	const lines: string[] = [`[当前状态]（JSON，唯一真相源）：`, state, ""];
	if (sim.focus) {
		const e = sim.world.entities.find((x) => x.id === sim.focus);
		if (e) lines.push(`[焦点] ${e.name} 是本回合的显著实体（最近被操作/新出现/被拒绝的对象）。叙述可围绕它展开，也可如实描写场景中其他可见实体；不得因此虚构该实体的任何状态。`, "");
	}
	if (results.length) {
		lines.push("本回合尝试：");
		for (const r of results) {
			const visible = r.changes.filter((c) => !internal.has(c.prop));
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
	lines.push(
		"",
		`${directive} 要求：`,
		"0. 首行输出结构化声明：[facts: 新事实；另一条新事实]——新事实只能来自上面的「本回合尝试」「法则事实」「即将发生」「本回合新见」四处，不得提及这四处之外的实体；没有新事实则写 [facts:]。",
		"1. 声明之后空行，再输出面向玩家的散文。",
		"2. 只描述状态中真实存在的事物与变化；声明之外不得再发明新事实。",
		"3. 玩家「尝试」过但被拒绝的操作，只描述这次尝试本身，不得声称其产生了后果（实体位置/属性未变）。",
		"4. 不要发明不存在的物体、人物、现象或后果。",
		"5. 一律使用实体的名称（name），不得出现实体 id、属性名、工具调用或任何实现术语。",
		"6. 输出纯散文，不要调用任何工具。",
		"7. 「即将发生」区列出的变更，只可叙述为尚未发生的征兆或预兆（用「将」「就要」等表述表明尚未发生），不得写成已发生的事实。",
	);
	return lines.join("\n");
}

function buildActTool(def: GameDef, sim: Simulation, gate: ActGate) {
	const actionSchema = Type.Union(
		Object.entries(def.verbs).map(([name, v]) =>
			Type.Object(
				{
					verb: Type.Literal(name),
					params: (v.schema as never),
				},
				{ additionalProperties: false },
			),
		),
	);
	/** 每个动词的参数校验器（strict：schema 未声明的参数一律打回）。SDK 不校验工具参数，需引擎自检。 */
	const verbValidators = new Map<string, ReturnType<typeof Compile>>();
	for (const [name, v] of Object.entries(def.verbs)) {
		const props = (v.schema as { properties?: Record<string, unknown> }).properties ?? {};
		verbValidators.set(name, Compile(Type.Object(props, { additionalProperties: false })));
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
			const vis = sim.visible();
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
				const invalid = (verb.entityParams ?? []).filter((p) => {
					const id = action.params[p];
					return typeof id === "string" && id.length > 0 && !vis.has(id);
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
					{ type: "text", text: `执行后的新状态（JSON，唯一真相源）：\n${sim.digest()}` },
				],
				details: {},
			};
		},
	});
}
