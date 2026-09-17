// window.shell 为不可配置全局属性：界面脚本顶层不得再声明同名 const/let shell（SyntaxError），须置于 IIFE 内或改名。
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) =>
	ipcRenderer.invoke(channel, ...args).catch((cause) => {
		const wrapped = String(cause?.message ?? cause);
		const prefix = `Error invoking remote method '${channel}': `;
		const message = wrapped.startsWith(prefix) ? wrapped.slice(prefix.length) : wrapped;
		throw new Error(message.replace(/^[A-Za-z]*Error: /, ""));
	});

const on = (channel) => (listener) => {
	const handler = (_event, payload) => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("shell", {
	games: () => invoke("games"),
	runs: (game) => invoke("runs", { game }),
	records: (game, run) => invoke("records", { game, run }),
	sessions: () => invoke("sessions"),
	open: (game, run) => invoke("open", { game, run }),
	close: (game, run) => invoke("close", { game, run }),
	act: (game, run, utterance) => invoke("act", { game, run, utterance }),
	narrate: (game, run, instruction) => invoke("narrate", { game, run, instruction }),
	state: (game, run) => invoke("state", { game, run }),
	uis: () => invoke("uis"),
	navigate: (game) => invoke("navigate", { game }),
	home: () => invoke("home"),
	settings: () => invoke("settings"),
	env: () => invoke("env"),
	reveal: (dir) => invoke("reveal", { dir }),
	setSettings: (patch) => invoke("settings:set", { patch }),
	openLauncher: () => invoke("launcher:open"),
	models: () => invoke("models"),
	currentModel: () => invoke("model:current"),
	auth: {
		providers: () => invoke("auth:providers"),
		login: (provider, type) => invoke("auth:login", { provider, type }),
		answer: (value) => invoke("auth:answer", { value }),
		cancel: () => invoke("auth:cancel"),
		logout: (provider) => invoke("auth:logout", { provider }),
		onPrompt: on("auth:prompt"),
		onNotice: on("auth:notify"),
	},
	onEvent: on("event"),
});
