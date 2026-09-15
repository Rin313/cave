import { ipcMain, type Event, type WebContents, type WebContentsDidStartNavigationEventParams } from "electron";
import { join } from "node:path";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import type { AgentSpec } from "../core/engine.ts";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type LoginType = Parameters<ModelRuntime["login"]>[1];
type Prompt = Parameters<Interaction["prompt"]>[0];

/** 配置协议 */
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

interface ModelRef {
	ref: string;
	provider: string;
	id: string;
	name: string;
	available: boolean;
}

/** 线上载荷：剥掉不可克隆的 signal；其余形状由 SDK 类型分配式派生，不逐字段重抄（AuthPrompt 是 union，直接 Omit 会塌成公共键）。 */
type StripSignal<T> = T extends unknown ? Omit<T, "signal"> : never;
type PromptPayload = StripSignal<Prompt>;

/** 登录流：同时至多一条（一次交互只有一个用户）；发起文档导航或销毁即中止。 */
interface Flow {
	sender: WebContents;
	abort: AbortController;
	answer: ((value: string) => void) | null;
	onDestroyed: () => void;
	onNavigate: (details: Event<WebContentsDidStartNavigationEventParams>) => void;
}

function promptPayload(prompt: Prompt): PromptPayload {
	const { signal, ...rest } = prompt;
	return rest;
}

/** 凭据与模型表随用户级配置根自持：不读 pi agent 的 ~/.pi/agent，用户无需安装 pi agent 或 /login。 */
export function openModelRuntime(root: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
	});
}

/** SDK 的错误提示以 pi CLI 旗标收尾（--list-models/--provider）；本项目没有这些旗标，只保留原因。 */
function modelErrorReason(error: string | undefined): string {
	return (error ?? "未解析到模型").replace(/ Use --[\s\S]*$/, "");
}

type ModelResolution =
	| { ok: true; model: AgentSpec["model"]; thinkingLevel?: AgentSpec["thinkingLevel"]; warning?: string }
	| { ok: false; reason: string };

export function resolveModelRef(ref: string, modelRuntime: ModelRuntime): ModelResolution {
	const { model, thinkingLevel, warning, error } = resolveCliModel({ cliModel: ref, modelRuntime });
	if (!model || error) return { ok: false, reason: modelErrorReason(error) };
	return { ok: true, model, ...(thinkingLevel !== undefined && { thinkingLevel }), ...(warning !== undefined && { warning }) };
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

/** 登录流程的应答通道：prompt/notice 只发往发起窗口，answer/cancel 只接受同一窗口；发起文档导航或销毁即取消。 */
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

	ipcMain.handle("auth:providers", async (): Promise<ProviderInfo[]> => providerInfo(await load()));

	ipcMain.handle("models", async (): Promise<ModelRef[]> => {
		const runtime = await load();
		const available = new Set((await runtime.getAvailable()).map((m) => `${m.provider}/${m.id}`));
		return runtime.getModels().map((m) => {
			const ref = `${m.provider}/${m.id}`;
			return { ref, provider: m.provider, id: m.id, name: m.name, available: available.has(ref) };
		});
	});

	ipcMain.handle("auth:login", async (event, req: { provider?: unknown; type?: unknown }) => {
		const provider = typeof req?.provider === "string" && req.provider !== "" ? req.provider : null;
		const type: LoginType | null = req?.type === "api_key" || req?.type === "oauth" ? req.type : null;
		if (provider === null) throw new Error("login 需要 provider");
		if (type === null) throw new Error("login 需要 type（api_key|oauth）");
		const sender = event.sender;
		closeFlow(); // 新登录抢占旧流：最后一次点击胜出
		const abort = new AbortController();
		const f: Flow = {
			sender,
			abort,
			answer: null,
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
					if (flow === f && !sender.isDestroyed()) sender.send("auth:notify", { notice });
				},
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						if (abort.signal.aborted) {
							reject(new Error("登录已取消"));
							return;
						}
						// 单槽待答：SDK 串行提示，重叠即契约破坏，显式拒绝而非静默顶掉
						if (f.answer !== null) {
							reject(new Error("登录流程已有待答提示"));
							return;
						}
						let settled = false;
						const finish = (done: () => void): void => {
							if (settled) return;
							settled = true;
							f.answer = null;
							abort.signal.removeEventListener("abort", onAbort);
							prompt.signal?.removeEventListener("abort", onAbort);
							done();
						};
						const answer = (value: string): void => finish(() => resolve(value));
						const onAbort = (): void => finish(() => reject(new Error("登录已取消")));
						f.answer = answer;
						abort.signal.addEventListener("abort", onAbort, { once: true });
						prompt.signal?.addEventListener("abort", onAbort, { once: true });
						try {
							sender.send("auth:prompt", { prompt: promptPayload(prompt) });
						} catch {
							onAbort();
						}
					}),
			});
		} finally {
			closeFlow(f); // 被替换时是空操作
		}
	});

	ipcMain.handle("auth:answer", (event, req: { value?: unknown }) => {
		const f = flow;
		if (f === null || f.sender !== event.sender) throw new Error("没有进行中的登录流程");
		if (typeof req?.value !== "string") throw new Error("answer 需要字符串 value");
		if (f.answer === null) throw new Error("该登录流程没有待答提示");
		f.answer(req.value);
	});

	ipcMain.handle("auth:cancel", (event) => {
		const f = flow;
		if (f === null || f.sender !== event.sender) throw new Error("没有进行中的登录流程");
		closeFlow(f);
	});

	ipcMain.handle("auth:logout", async (_event, req: { provider?: unknown }) => {
		const provider = typeof req?.provider === "string" && req.provider !== "" ? req.provider : null;
		if (provider === null) throw new Error("logout 需要 provider");
		await (await load()).logout(provider);
	});
}
