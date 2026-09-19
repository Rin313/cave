// window.shell 为不可配置全局属性：界面脚本顶层不得再声明同名 const/let shell（SyntaxError），须置于 IIFE 内或改名。
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) =>
	ipcRenderer.invoke(channel, ...args).catch((cause) => {
		const message = String(cause?.message ?? cause).replace(/^(?:Error invoking remote method '[^']*': )?(?:[A-Za-z]*Error: )?/, "");
		throw new Error(message);
	});

const on = (channel) => (listener) => {
	const handler = (_event, payload) => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
};

/** 运行句柄：坐标绑定一次；事件按坐标过滤；load 是打开时的档案健康，创建后不变。 */
function session(game, run, load) {
	const at = (channel, payload = {}) => invoke(channel, { game, run, ...payload });
	return {
		load,
		state: () => at("state"),
		act: (utterance) => at("act", { utterance }),
		narrate: (instruction) => at("narrate", { instruction }),
		close: () => at("close"),
		events: (listener) => on("event")((payload) => {
			if (payload.game === game && payload.run === run) listener(payload.event);
		}),
	};
}

/** 登录流程：prompt 以「返回答案的 Promise」应答；同窗同时至多一条流，新登录即摘旧监听；prompt 处理失败即取消本次流，并以原因为拒绝。 */
let detach = null;
function login(provider, type, handlers) {
	const { onPrompt, onNotice } = handlers ?? {};
	detach?.();
	let failure = null;
	const offs = [
		on("config:notice")((payload) => onNotice?.(payload.notice)),
		on("config:prompt")(({ prompt }) => {
			void (async () => {
				try {
					if (typeof onPrompt !== "function") throw new Error("login 未提供 onPrompt");
					const value = await onPrompt(prompt);
					if (detach !== off) return;
					await invoke("config:answer", { value });
				} catch (e) {
					if (detach !== off) return;
					failure ??= e instanceof Error ? e : new Error(String(e));
					await invoke("config:cancel").catch(() => undefined);
				}
			})();
		}),
	];
	const off = () => { for (const f of offs) f(); };
	detach = off;
	return invoke("config:login", { provider, type })
		.catch((e) => { throw failure ?? e; })
		.finally(() => {
			if (detach === off) detach = null;
			off();
		});
}

contextBridge.exposeInMainWorld("shell", {
	runs: (game) => invoke("runs", { game }),
	records: (game, run) => invoke("records", { game, run }),
	open: async (game, run) => session(game, run, await invoke("open", { game, run })),
	home: () => invoke("home"),
	env: () => invoke("env"),
	reveal: async (dir) => {
		const failure = await invoke("reveal", { dir });
		if (failure !== "") throw new Error(failure);
	},
	config: {
		models: () => invoke("config:models"),
		current: () => invoke("config:current"),
		use: (provider, id, level) => invoke("config:use", level === undefined ? { provider, id } : { provider, id, level }),
		providers: () => invoke("config:providers"),
		login,
		logout: (provider) => invoke("config:logout", { provider }),
	},
});
