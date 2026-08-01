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
import { Type } from "typebox";
import { Simulation } from "./sim.ts";
import type { Change, GameDef, Op, PropValue, StepResult } from "./sim.ts";

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
	kind: "applied" | "rejected" | "refused";
	results: StepResult[];
	refusal?: { label: string; reason: string };
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; opCount: number }
	| { type: "tool_result"; results: StepResult[] }
	| { type: "validation"; round: number; error: string; attempt: string };

interface ToolResponse {
	results?: StepResult[];
	refusal?: { label: string; reason: string };
}

interface Phase {
	inAct: boolean;
	inRender: boolean;
}

function toolResultText(content: readonly { text?: string }[]): string | undefined {
	const first = content[0];
	return first && typeof first.text === "string" ? first.text : undefined;
}

function parseToolResponse(text: string): ToolResponse | null {
	try {
		const v = JSON.parse(text) as unknown;
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.results)) return { results: o.results as StepResult[] };
			if (o.refusal && typeof o.refusal === "object") {
				const r = o.refusal as Record<string, unknown>;
				return { refusal: { label: String(r.label ?? "refused"), reason: String(r.reason ?? "") } };
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
	return String(v);
}

interface OpParams {
	op: string;
	source?: string;
	target?: string;
	entity?: string;
	dest?: string;
	prop?: string;
	value?: unknown;
}

function toOp(p: OpParams): Op {
	if (p.op === "apply") return { kind: "apply", source: p.source ?? "", target: p.target ?? "" };
	if (p.op === "move") return { kind: "move", entity: p.entity ?? "", dest: p.dest ?? "" };
	return { kind: "set", entity: p.entity ?? "", prop: p.prop ?? "", value: coerceValue(p.value) };
}

function opIds(p: OpParams): string[] {
	if (p.op === "apply") return [p.source ?? "", p.target ?? ""];
	if (p.op === "move") return [p.entity ?? "", p.dest ?? ""];
	return [p.entity ?? ""];
}

function buildMappingPrompt(state: string, selectionLine: string, intent: string): string {
	return `[当前状态]（JSON，唯一真相源）：\n${state}\n\n${selectionLine}\n玩家意图：「${intent}」\n\n你的任务：把玩家的操作意图解析为操作提案，并调用 act 工具。规则：
1. 能解析出合理操作 → 调用 act，提交 ops 列表（apply/move/set），实体 id 只能取自已可见实体的 id。
2. 无法解析、实体不存在、或语境荒谬 → 调用 act，提交空的 ops，并用 refusal 字段给出 { label, reason }，reason 必须是符合世界观的解释，不得使用实现术语。
3. 禁止在本阶段输出任何散文或解释文字。`;
}

function describeOp(sim: Simulation, op: StepResult["op"]): string {
	const name = (id: string) => sim.world.entities.find((e) => e.id === id)?.name ?? id;
	if (op.kind === "apply") return `用${name(op.source)}作用于${name(op.target)}`;
	if (op.kind === "move") return `把${name(op.entity)}放到${name(op.dest)}`;
	if (op.kind === "set") return `改变${name(op.entity)}的${op.prop}`;
	return "时间流逝";
}

function buildExpressionPrompt(
	sim: Simulation,
	state: string,
	results: StepResult[],
	refusal: { label: string; reason: string } | undefined,
	directive = "请以文学笔触描写当前场景（面向玩家）。",
): string {
	const lines: string[] = [`[当前状态]（JSON，唯一真相源）：`, state, ""];
	if (results.length) {
		lines.push("本回合变更：");
		for (const r of results) {
			const changes = r.changes.length
				? `  ${r.changes.map((c) => `${c.entity}.${c.prop} ${c.from} → ${c.to}`).join("；")}`
				: "";
			const verdict = r.ok ? r.reason : `${r.reason}（被拒绝）`;
			lines.push(`- 尝试「${describeOp(sim, r.op)}」→ ${verdict}${changes}`);
		}
	} else if (refusal) {
		lines.push(`世界拒绝了你的操作。${refusal.reason ? `理由：「${refusal.reason}」` : ""}`);
	} else {
		lines.push("没有任何改变。");
	}
	lines.push(
		"",
		`${directive} 要求：`,
		"1. 只描述状态中真实存在的事物与变化；新事实只能来自上面的「本回合变更」。",
		"2. 玩家「尝试」过但被拒绝的操作，只描述这次尝试本身，不得声称其产生了后果（实体位置/属性未变）。",
		"3. 不要发明不存在的物体、人物、现象或后果。",
		"4. 一律使用实体的名称（name），不得出现实体 id、属性名、工具调用或任何实现术语。",
		"5. 输出纯散文，不要调用任何工具。",
	);
	return lines.join("\n");
}

const MATERIAL_LABELS: Record<string, string> = {
	copper: "铜", bone: "骨", wood: "木", iron: "铁", stone: "石", wax: "蜡", steel: "钢", ash: "灰烬",
};

const PROP_LABELS: Record<string, string> = {
	burning: "燃烧状态", lit: "明火", open: "开合", material: "材质", in: "位置",
	attachedTo: "固定", jammed: "卡住", wedgedBy: "楔住", flammable: "可燃性",
};

const SKIP_CHANGE_PROPS = new Set(["burnTicks"]);

function renderSummary(sim: Simulation, changes: Change[]): string {
	const lines: string[] = [];
	const player = sim.world.entities.find((e) => e.id === sim.actor);
	const loc = player?.props["in"] as string | null;
	const place = sim.world.entities.find((e) => e.id === loc)?.name ?? "原地";
	lines.push(`你站在${place}。`);
	for (const id of sim.visibleIds) {
		if (id === sim.actor) continue;
		const e = sim.world.entities.find((x) => x.id === id);
		if (!e) continue;
		if (e.props.space === true) continue;
		const bits: string[] = [];
		if (e.props.lit === true) bits.push("燃着");
		if (e.props.burning === true) bits.push("正在燃烧");
		if (e.props.open === true) bits.push("开着");
		else if (e.props.openable === true) bits.push("关着");
		if (e.props.attachedTo != null) bits.push("固定在别处");
		if (e.props.material === "ash") bits.push("已成灰烬");
		else if (typeof e.props.material === "string") bits.push(`${MATERIAL_LABELS[e.props.material] ?? e.props.material}质`);
		const container = e.props["in"] as string | null;
		if (container && container !== sim.actor) {
			const parent = sim.world.entities.find((x) => x.id === container);
			if (parent) bits.push(`在${parent.name}里`);
		}
		lines.push(`- ${e.name}${bits.length ? `（${bits.join("，")}）` : ""}`);
	}
	for (const ch of changes) {
		if (SKIP_CHANGE_PROPS.has(ch.prop)) continue;
		const e = sim.world.entities.find((x) => x.id === ch.entity);
		const label = PROP_LABELS[ch.prop] ?? ch.prop;
		const fmt = (v: PropValue): string => {
			if (v === null) return "无";
			if (v === true) return "有";
			if (v === false) return "无";
			if (typeof v === "string") {
				const hit = sim.world.entities.find((x) => x.id === v);
				if (hit) return hit.name;
				return MATERIAL_LABELS[v] ?? v;
			}
			return String(v);
		};
		lines.push(`变更：${e?.name ?? ch.entity}的${label} ${fmt(ch.from)} → ${fmt(ch.to)}`);
	}
	return lines.join("\n");
}

export class Engine {
	readonly sim: Simulation;
	private session: SessionHandle;
	private phase: Phase;
	private buf: string[] = [];
	private outcome: ActOutcome = { kind: "refused", results: [] };
	private listeners = new Set<(event: EngineEvent) => void>();

	private constructor(sim: Simulation, session: SessionHandle, phase: Phase) {
		this.sim = sim;
		this.session = session;
		this.phase = phase;
		session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						if (this.phase.inRender) this.buf.push(event.assistantMessageEvent.delta);
					}
					break;
				case "tool_execution_start":
					if (event.toolName === ACT_TOOL) {
						const args = event.args as { ops?: unknown[] };
						this.emit({ type: "tool_call", opCount: args.ops?.length ?? 0 });
					}
					break;
				case "turn_end":
					if (!this.phase.inAct) break;
					let anyResult = false;
					for (const tr of event.toolResults) {
						if (tr.toolName !== ACT_TOOL) continue;
						const text = toolResultText(tr.content);
						if (!text) continue;
						const resp = parseToolResponse(text);
						if (!resp) continue;
						if (resp.refusal) {
							this.outcome.kind = "refused";
							this.outcome.refusal = resp.refusal;
							this.emit({ type: "tool_result", results: [] });
							anyResult = true;
							continue;
						}
						const results = resp.results ?? [];
						if (results.length) anyResult = true;
						this.outcome.results.push(...results);
						this.emit({ type: "tool_result", results });
					}
					if (anyResult && this.outcome.results.length) {
						this.outcome.kind = this.outcome.results.some((r) => r.ok) ? "applied" : "rejected";
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

	static async create(def: GameDef, options: EngineOptions = {}): Promise<Engine> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		const provider = options.provider ?? "opencode-go";
		const model = options.model ?? "deepseek-v4-flash";
		const modelDef = modelRuntime.getModel(provider, model);
		if (!modelDef) throw new Error(`模型 ${provider}/${model} 不可用`);

		const sim = options.sim ?? new Simulation(def);
		const phase: Phase = { inAct: false, inRender: false };
		const actTool = buildActTool(sim, phase);
		const systemPrompt = buildSystemPrompt(def);
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
			getSystemPrompt: () => systemPrompt,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const sessionOptions: CreateAgentSessionOptions = {
			model: modelDef,
			modelRuntime,
			thinkingLevel: (options.thinkingLevel as never) ?? "high",
			resourceLoader: loader,
			settingsManager,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			tools: [ACT_TOOL],
			customTools: [actTool],
		};

		const { session } = await createAgentSession(sessionOptions);
		return new Engine(sim, session, phase);
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	async act(action: { intent: string; selection?: string }): Promise<ActOutcome> {
		this.outcome = { kind: "refused", results: [] };
		this.phase.inAct = true;
		const state = this.sim.serialize();
		const selectionLine = action.selection
			? `玩家选中了文本片段：「${action.selection}」`
			: `玩家未选中任何文本`;
		try {
			await this.session.prompt(buildMappingPrompt(state, selectionLine, action.intent));
		} finally {
			this.phase.inAct = false;
		}

		if (this.outcome.kind === "refused" && !this.outcome.refusal) {
			this.outcome.refusal = { label: "unparsed", reason: "世界没有回应这个操作。" };
		}

		const results = this.outcome.results;
		const changes = results.flatMap((r) => r.changes);
		const stateAfter = this.sim.serialize();
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, stateAfter, results, this.outcome.refusal),
			changes,
		);
		this.emit({ type: "text_delta", delta: narration });
		return this.outcome;
	}

	async render(instruction: string, changes: Change[] = []): Promise<void> {
		const state = this.sim.serialize();
		const results: StepResult[] = changes.length
			? [{ ok: true, reason: "时间流逝，世界发生了变化。", changes, op: { kind: "tick", n: this.sim.world.time } }]
			: [];
		const narration = await this.expressionPass(
			buildExpressionPrompt(this.sim, state, results, undefined, instruction),
			changes,
		);
		this.emit({ type: "text_delta", delta: narration });
	}

	private async expressionPass(prompt: string, changes: Change[]): Promise<string> {
		const run = async (p: string): Promise<{ text: string; err: string | null }> => {
			this.phase.inRender = true;
			this.buf = [];
			try {
				await this.session.prompt(p);
			} finally {
				this.phase.inRender = false;
			}
			const text = this.buf.join("");
			return { text, err: this.validateNarration(text, changes) };
		};

		const first = await run(prompt);
		if (!first.err) return first.text;
		this.emit({ type: "validation", round: 1, error: first.err, attempt: first.text });
		const retry = await run(
			`刚才的描述存在虚构内容：${first.err}。请重写。必须严格遵守约束：只描述状态中真实存在的事物；新事实只能来自本回合变更；不要发明不存在的现象或后果。`,
		);
		if (!retry.err) return retry.text;
		this.emit({ type: "validation", round: 2, error: retry.err, attempt: retry.text });
		return renderSummary(this.sim, changes);
	}

	private validateNarration(text: string, changes: Change[]): string | null {
		if (!text.trim()) return "叙述为空。";
		const leaked = this.leakageCheck(text);
		if (leaked) return leaked;
		const hook = this.sim.def.validateText;
		if (hook) {
			const err = hook({ text, world: this.sim.world, changes, actor: this.sim.actor });
			if (err) return err;
		}
		return null;
	}

	private leakageCheck(text: string): string | null {
		const forbidden = new Set<string>([
			...this.sim.visibleIds,
			"attachedTo", "wedgedBy", "openable", "grabbable", "lightable", "wedgeable",
			"flammable", "material", "burning", "jammed", "container", "isDoor", "burnTicks",
			"apply", "move", "set", "ops", "refusal", "label", "entities", "props",
		]);
		for (const t of forbidden) {
			if (new RegExp(`\\b${t}\\b`).test(text)) {
				return `出现了实体 id 或实现术语：「${t}」。`;
			}
		}
		return null;
	}

	dispose(): void {
		this.session.dispose();
	}
}

function buildSystemPrompt(def: GameDef): string {
	const hint = def.hint ? `${def.hint}\n` : "";
	return `你是文字游戏引擎。每个回合分两个阶段：

阶段一（解析，调用 act 工具）：把玩家的操作意图解析为操作提案并调用 act 工具。能解析 → 提交 ops 列表（apply/move/set）；无法解析、实体不存在或语境荒谬 → 提交空的 ops 与结构化 refusal（label + 符合世界观的 reason）。此阶段禁止输出散文。

阶段二（描写）：基于世界给出的当前状态与本回合变更，把场景写成面向玩家的文学散文。此阶段禁止调用工具。

状态说明：entities 是当前所有可见实体。实体属性常见的有：material（材质）、lit（发光的火）、burning（失控燃烧）、open（开启）、openable（可开启）、flammable（可燃）、grabbable（可拿起）、lightable（可点燃）、attachedTo（固定在）、wedgeable（可楔入门缝）、jammed（被卡住）、wedgedBy（被什么卡住）、in（所在/所持，无 in 表示在当前场景）。

${hint}
描写阶段硬约束：
- 叙述只能引用状态中真实存在的实体和属性，禁止发明不存在的物体、人物、现象或后果。
- 一律使用实体的名称（name），不得写出实体 id、属性名、工具调用或决策过程。
- 被拒绝的操作，把世界给出的法则理由融入叙述，让玩家感受到世界的规则。`;
}

function buildActTool(sim: Simulation, phase: Phase) {
	const opSchema = Type.Object({
		op: Type.Union([Type.Literal("apply"), Type.Literal("move"), Type.Literal("set")]),
		source: Type.Optional(Type.String({ description: "apply：施动实体 id" })),
		target: Type.Optional(Type.String({ description: "apply：受动实体 id" })),
		entity: Type.Optional(Type.String({ description: "move/set：目标实体 id" })),
		dest: Type.Optional(Type.String({ description: "move：目标位置（玩家 id / 容器 id / 场景 id）" })),
		prop: Type.Optional(Type.String({ description: "set：属性名" })),
		value: Type.Optional(Type.Any({ description: "set：属性值（布尔/数字/字符串/null）" })),
	});
	return defineTool({
		name: ACT_TOOL,
		label: "世界提案",
		description:
			"向世界提出操作（apply/move/set）或结构化拒绝。能解析操作 → 提交 ops；无法解析 → 提交空 ops 与 refusal。实体 id 必须取自已可见实体的 id；世界法则会按顺序裁决每个操作。",
		parameters: Type.Object({
			ops: Type.Optional(
				Type.Array(opSchema, { description: "按顺序执行的操作提案列表；无法解析时应省略" }),
			),
			refusal: Type.Optional(
				Type.Object(
					{
						label: Type.String({ description: "拒绝标签，如 unparsed / absurd" }),
						reason: Type.String({ description: "符合世界观的拒绝理由，不得使用实现术语" }),
					},
					{ description: "无法解析或语境荒谬时的结构化拒绝" },
				),
			),
		}),
		execute: async (_toolCallId, params: { ops?: OpParams[]; refusal?: { label: string; reason: string } }) => {
			if (!phase.inAct) {
				const refused: StepResult = {
					ok: false,
					reason: "当前不在行动阶段，无法执行操作。",
					changes: [],
					op: { kind: "set", entity: "", prop: "", value: null },
				};
				return { content: [{ type: "text", text: JSON.stringify({ results: [refused] }) }], details: {} };
			}
			if (params.refusal && !(params.ops?.length)) {
				return { content: [{ type: "text", text: JSON.stringify({ refusal: params.refusal }) }], details: {} };
			}
			const vis = sim.visibleIds;
			const results: StepResult[] = [];
			for (const p of params.ops ?? []) {
				const op = toOp(p);
				const invalid = opIds(p).filter((id) => id && !vis.has(id));
				if (invalid.length) {
					results.push({ ok: false, reason: `实体 ${invalid.join("、")} 不可见或不存在。`, changes: [], op });
					break;
				}
				results.push(sim.apply(op));
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify({ results }) },
					{ type: "text", text: `执行后的新状态（JSON，唯一真相源）：\n${sim.serialize()}` },
				],
				details: {},
			};
		},
	});
}
