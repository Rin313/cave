import { ipcMain, type Event, type WebContents, type WebContentsDidStartNavigationEventParams } from "electron";
import { join } from "node:path";
import { ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { AgentSpec } from "../core/engine.ts";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type LoginType = Parameters<ModelRuntime["login"]>[1];
type Prompt = Parameters<Interaction["prompt"]>[0];

interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
	label?: string;
	oauthInUse?: boolean;
	apiKey?: { label: string; login: boolean };
	oauth?: { label: string; subscription: boolean };
}

export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

interface ModelRef {
	ref: string;
	provider: string;
	id: string;
	name: string;
	thinkingLevels: readonly ThinkingLevel[];
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

/** 与 pi-ai getSupportedThinkingLevels 同义（SDK 根不导出，pi-ai 非直接依赖）：非推理模型仅 off；null 隐藏；xhigh/max 须显式开启。 */
export function supportedThinkingLevels(model: AgentSpec["model"]): readonly ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level === "xhigh" || level === "max" ? mapped !== undefined : true;
	});
}

export const modelRef = (model: AgentSpec["model"]): string => `${model.provider}/${model.id}`;

export interface ModelFace {
	provider: string;
	id: string;
	ref: string;
	/** 生效档位：该模型显式档 ?? 全局缺省；两者皆无即缺席。 */
	level?: ThinkingLevel;
	thinkingLevels: readonly ThinkingLevel[];
}

/** 剥掉不可克隆的 signal；其余形状由 SDK 类型分配式派生 */
type StripSignal<T> = T extends unknown ? Omit<T, "signal"> : never;
type PromptPayload = StripSignal<Prompt>;

/** 登录流：同时至多一条（一次交互只有一个用户） */
interface Flow {
	sender: WebContents;
	abort: AbortController;
	pending: { resolve(value: string): void; reject(error: Error): void } | null;
	onDestroyed: () => void;
	onNavigate: (details: Event<WebContentsDidStartNavigationEventParams>) => void;
}

function promptPayload(prompt: Prompt): PromptPayload {
	const { signal, ...rest } = prompt;
	return rest;
}

export function openModelRuntime(root: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
	});
}

function providerInfo(runtime: ModelRuntime): ProviderInfo[] {
	return runtime.getProviders().map((provider) => {
		const status = runtime.getProviderAuthStatus(provider.id);
		const apiKey = provider.auth.apiKey;
		const oauth = provider.auth.oauth;
		return {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			...(status.source !== undefined && { source: status.source }),
			...(status.label !== undefined && { label: status.label }),
			...(runtime.isUsingOAuth(provider.id) && { oauthInUse: true }),
			...(apiKey !== undefined && { apiKey: { label: apiKey.name, login: apiKey.login !== undefined } }),
			...(oauth !== undefined && { oauth: { label: oauth.loginLabel ?? oauth.name, subscription: oauth.isSubscription === true } }),
		};
	});
}

/** 非空字符串 provider（IPC 边界）。 */
function providerIn(value: unknown, cmd: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`${cmd} 需要 provider`);
	return value;
}

/** 登录协议：prompt/notice 只发往发起窗口；reply 只认同一窗口的当前流，迟到即弃；文档导航或窗口销毁即取消。 */
export function installModel(load: () => Promise<ModelRuntime>): void {
	let flow: Flow | null = null;

	/** 关闭即摘监听并中止；被替换后的迟到关闭是空操作。 */
	const closeFlow = (target: Flow | null = flow): void => {
		if (target === null || flow !== target) return;
		flow = null;
		target.sender.removeListener("destroyed", target.onDestroyed);
		target.sender.removeListener("did-start-navigation", target.onNavigate);
		target.abort.abort();
	};

	ipcMain.handle("config:providers", async (): Promise<ProviderInfo[]> => providerInfo(await load()));

	ipcMain.handle("config:models", async (): Promise<ModelRef[]> => {
		const runtime = await load();
		return (await runtime.getAvailable()).map((m) => ({ ref: modelRef(m), provider: m.provider, id: m.id, name: m.name, thinkingLevels: supportedThinkingLevels(m) }));
	});

	ipcMain.handle("config:login", async (event, req: { provider?: unknown; type?: unknown }) => {
		const provider = providerIn(req?.provider, "login");
		const type: LoginType | null = req?.type === "api_key" || req?.type === "oauth" ? req.type : null;
		if (type === null) throw new Error("login 需要 type（api_key|oauth）");
		closeFlow(); // 校验通过才抢占旧流
		const sender = event.sender;
		const abort = new AbortController();
		const f: Flow = {
			sender,
			abort,
			pending: null,
			onDestroyed: () => closeFlow(f),
			onNavigate: (details) => {
				if (details.isMainFrame && !details.isSameDocument) closeFlow(f);
			},
		};
		flow = f;
		sender.once("destroyed", f.onDestroyed);
		sender.on("did-start-navigation", f.onNavigate);
		try {
			await (await load()).login(provider, type, {
				signal: abort.signal,
				notify: (notice) => {
					if (flow === f && !sender.isDestroyed()) sender.send("config:notice", { notice });
				},
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						if (abort.signal.aborted) {
							reject(new Error("登录已取消"));
							return;
						}
						// 单槽待答：SDK 串行提示，重叠即契约破坏，显式拒绝而非静默顶掉
						if (f.pending !== null) {
							reject(new Error("登录流程已有待答提示"));
							return;
						}
						const signal = prompt.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, prompt.signal]);
						let settled = false;
						const finish = (done: () => void): void => {
							if (settled) return;
							settled = true;
							f.pending = null;
							signal.removeEventListener("abort", onAbort);
							done();
						};
						const onAbort = (): void => finish(() => reject(new Error("登录已取消")));
						f.pending = {
							resolve: (value) => finish(() => resolve(value)),
							reject: (error) => finish(() => reject(error)),
						};
						signal.addEventListener("abort", onAbort, { once: true });
						try {
							sender.send("config:prompt", { prompt: promptPayload(prompt) });
						} catch {
							onAbort();
						}
					}),
			});
		} finally {
			closeFlow(f); // 被替换时是空操作
		}
	});

	ipcMain.handle("config:reply", (event, req: { value?: unknown; error?: unknown }) => {
		const f = flow;
		if (f === null || f.sender !== event.sender) return; // 流已落定或非本窗：迟到应答，丢弃
		const pending = f.pending;
		if (pending === null) return; // 问题已被 SDK 放弃：迟到应答无害
		if (typeof req?.error === "string") {
			pending.reject(new Error(req.error));
			return;
		}
		if (typeof req?.value === "string") {
			pending.resolve(req.value);
			return;
		}
		pending.reject(new Error("config:reply 需要 value 或 error"));
	});

	ipcMain.handle("config:logout", async (_event, req: { provider?: unknown }) => {
		await (await load()).logout(providerIn(req?.provider, "logout"));
	});
}
