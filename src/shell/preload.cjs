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

let current = null;

on("config:notice")((payload) => current?.onNotice?.(payload.notice));

on("config:prompt")(({ prompt }) => {
	void (async () => {
		const me = current;
		if (me === null) return;
		const reply = (payload) => invoke("config:reply", payload).catch(() => undefined);
		if (typeof me.onPrompt !== "function") {
			await reply({ error: "login 未提供 onPrompt" });
			return;
		}
		let value;
		try {
			value = await me.onPrompt(prompt);
			if (typeof value !== "string") throw new Error("login 的 onPrompt 须返回字符串");
		} catch (e) {
			if (current !== me) return;
			await reply({ error: e instanceof Error ? e.message : String(e) });
			return;
		}
		if (current !== me) return;
		await reply({ value });
	})();
});

function login(provider, type, handlers) {
	const { onPrompt, onNotice } = handlers ?? {};
	const me = { onPrompt, onNotice };
	current = me;
	return invoke("config:login", { provider, type }).finally(() => {
		if (current === me) current = null;
	});
}

contextBridge.exposeInMainWorld("shell", {
	runs: (game) => invoke("runs", { game }),
	records: (game, run) => invoke("records", { game, run }),
	open: async (game, run) => session(game, run, await invoke("open", { game, run })),
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
