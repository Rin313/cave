import { ipcMain, type WebContents } from "electron";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type LoginType = Parameters<ModelRuntime["login"]>[1];
type Prompt = Parameters<Interaction["prompt"]>[0];
type Notice = Parameters<Interaction["notify"]>[0];

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

type PromptPayload =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };

type NoticePayload =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };

interface Flow {
	sender: WebContents;
	abort: AbortController;
	answer: ((value: string) => void) | null;
	onDestroyed: () => void;
}

function promptPayload(prompt: Prompt): PromptPayload {
	if (prompt.type === "select") {
		return {
			type: "select",
			message: prompt.message,
			options: prompt.options.map((o) => ({ id: o.id, label: o.label, ...(o.description !== undefined && { description: o.description }) })),
		};
	}
	return { type: prompt.type, message: prompt.message, ...(prompt.placeholder !== undefined && { placeholder: prompt.placeholder }) };
}

function noticePayload(notice: Notice): NoticePayload {
	switch (notice.type) {
		case "info":
			return {
				type: "info",
				message: notice.message,
				...(notice.links !== undefined && { links: notice.links.map((l) => ({ url: l.url, ...(l.label !== undefined && { label: l.label }) })) }),
			};
		case "auth_url":
			return { type: "auth_url", url: notice.url, ...(notice.instructions !== undefined && { instructions: notice.instructions }) };
		case "device_code":
			return {
				type: "device_code",
				userCode: notice.userCode,
				verificationUri: notice.verificationUri,
				...(notice.intervalSeconds !== undefined && { intervalSeconds: notice.intervalSeconds }),
				...(notice.expiresInSeconds !== undefined && { expiresInSeconds: notice.expiresInSeconds }),
			};
		case "progress":
			return { type: "progress", message: notice.message };
	}
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
export function installAuth(load: () => Promise<ModelRuntime>): void {
	const flows = new Map<number, Flow>();
	let next = 1;

	const close = (id: number): void => {
		const flow = flows.get(id);
		if (!flow) return;
		flows.delete(id);
		flow.sender.removeListener("destroyed", flow.onDestroyed);
		flow.abort.abort();
	};

	const flowOf = (sender: WebContents, id: unknown): [number, Flow] => {
		if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("未知登录流程");
		const flow = flows.get(id);
		if (flow === undefined || flow.sender !== sender) throw new Error("未知登录流程");
		return [id, flow];
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
		const id = next++;
		const sender = event.sender;
		const flow: Flow = { sender, abort: new AbortController(), answer: null, onDestroyed: () => close(id) };
		sender.once("destroyed", flow.onDestroyed);
		flows.set(id, flow);
		try {
			await (await load()).login(provider, type, {
				signal: flow.abort.signal,
				notify: (notice) => {
					if (!sender.isDestroyed()) sender.send("auth:notify", { flow: id, notice: noticePayload(notice) });
				},
				prompt: (prompt) =>
					new Promise<string>((resolve, reject) => {
						if (flow.abort.signal.aborted) {
							reject(new Error("登录已取消"));
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
			return { provider, type };
		} finally {
			close(id);
		}
	});

	ipcMain.handle("auth:answer", (event, req: { flow?: unknown; value?: unknown }) => {
		const [, flow] = flowOf(event.sender, req?.flow);
		if (typeof req?.value !== "string") throw new Error("answer 需要字符串 value");
		if (flow.answer === null) throw new Error("该登录流程没有待答提示");
		flow.answer(req.value);
	});

	ipcMain.handle("auth:cancel", (event, req: { flow?: unknown }) => {
		const [id] = flowOf(event.sender, req?.flow);
		close(id);
	});

	ipcMain.handle("auth:logout", async (_event, req: { provider?: unknown }) => {
		const provider = typeof req?.provider === "string" && req.provider !== "" ? req.provider : null;
		if (provider === null) throw new Error("logout 需要 provider");
		await (await load()).logout(provider);
	});
}
