import { ipcMain, type WebContents } from "electron";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type LoginType = Parameters<ModelRuntime["login"]>[1];
type Prompt = Parameters<Interaction["prompt"]>[0];

/** 配置协议：只转发 SDK 的目录与交互，不自产文案；配置面是内容。 */
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

interface Flow {
	sender: WebContents;
	abort: AbortController;
	answer: ((value: string) => void) | null;
	onDestroyed: () => void;
}

function promptPayload(prompt: Prompt): PromptPayload {
	const { signal, ...rest } = prompt;
	return rest;
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

/** 登录流程的应答通道：prompt/notice 只发往发起窗口，answer/cancel 只接受同一窗口；窗口销毁即取消。 */
export function installModel(load: () => Promise<ModelRuntime>): void {
	/** 登录流按窗口单槽（键即 sender.id）：新登录、导航、窗口销毁都以 close 抢占旧流。 */
	const flows = new Map<number, Flow>();
	/** 登录流依附窗口的当前文档：主帧导航（重载/换页）后旧文档不再应答提示，流须一并关闭。 */
	const watched = new WeakSet<WebContents>();

	const close = (id: number): void => {
		const flow = flows.get(id);
		if (!flow) return;
		flows.delete(id);
		flow.sender.removeListener("destroyed", flow.onDestroyed);
		flow.abort.abort();
	};

	const watchNavigations = (sender: WebContents): void => {
		if (watched.has(sender)) return;
		watched.add(sender);
		sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
			if (isMainFrame && !inPlace) close(sender.id);
		});
	};

	const flowOf = (sender: WebContents, id: unknown): Flow => {
		if (typeof id !== "number" || !Number.isInteger(id) || id !== sender.id) throw new Error("未知登录流程");
		const flow = flows.get(id);
		if (flow === undefined) throw new Error("未知登录流程");
		return flow;
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
		const id = sender.id;
		close(id);
		watchNavigations(sender);
		const flow: Flow = { sender, abort: new AbortController(), answer: null, onDestroyed: () => close(id) };
		sender.once("destroyed", flow.onDestroyed);
		flows.set(id, flow);
		try {
			await (await load()).login(provider, type, {
				signal: flow.abort.signal,
				notify: (notice) => {
					if (!sender.isDestroyed()) sender.send("auth:notify", { flow: id, notice });
				},
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						if (flow.abort.signal.aborted) {
							reject(new Error("登录已取消"));
							return;
						}
						// 单槽待答：SDK 串行提示，重叠即契约破坏，显式拒绝而非静默顶掉
						if (flow.answer !== null) {
							reject(new Error("登录流程已有待答提示"));
							return;
						}
						let settled = false;
						const finish = (done: () => void): void => {
							if (settled) return;
							settled = true;
							if (flow.answer === answer) flow.answer = null;
							flow.abort.signal.removeEventListener("abort", onAbort);
							prompt.signal?.removeEventListener("abort", onAbort);
							done();
						};
						const answer = (value: string): void => finish(() => resolve(value));
						const onAbort = (): void => finish(() => reject(new Error("登录已取消")));
						flow.answer = answer;
						flow.abort.signal.addEventListener("abort", onAbort, { once: true });
						prompt.signal?.addEventListener("abort", onAbort, { once: true });
						try {
							sender.send("auth:prompt", { flow: id, prompt: promptPayload(prompt) });
						} catch {
							onAbort();
						}
					}),
			});
		} finally {
			if (flows.get(id) === flow) close(id);
		}
	});

	ipcMain.handle("auth:answer", (event, req: { flow?: unknown; value?: unknown }) => {
		const flow = flowOf(event.sender, req?.flow);
		if (typeof req?.value !== "string") throw new Error("answer 需要字符串 value");
		if (flow.answer === null) throw new Error("该登录流程没有待答提示");
		flow.answer(req.value);
	});

	ipcMain.handle("auth:cancel", (event, req: { flow?: unknown }) => {
		const flow = flowOf(event.sender, req?.flow);
		close(flow.sender.id);
	});

	ipcMain.handle("auth:logout", async (_event, req: { provider?: unknown }) => {
		const provider = typeof req?.provider === "string" && req.provider !== "" ? req.provider : null;
		if (provider === null) throw new Error("logout 需要 provider");
		await (await load()).logout(provider);
	});
}
