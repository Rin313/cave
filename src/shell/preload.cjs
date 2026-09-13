// window.shell 为不可配置全局属性：界面脚本顶层不得再声明同名 const/let shell（SyntaxError），须置于 IIFE 内或改名。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
	games: () => ipcRenderer.invoke("games"),
	runs: (game) => ipcRenderer.invoke("runs", { game }),
	records: (game, run) => ipcRenderer.invoke("records", { game, run }),
	sessions: () => ipcRenderer.invoke("sessions"),
	def: (game) => ipcRenderer.invoke("def", { game }),
	meta: (game) => ipcRenderer.invoke("meta", { game }),
	open: (game, run) => ipcRenderer.invoke("open", { game, run }),
	close: (game, run) => ipcRenderer.invoke("close", { game, run }),
	act: (game, run, utterance) => ipcRenderer.invoke("act", { game, run, utterance }),
	narrate: (game, run, instruction) => ipcRenderer.invoke("narrate", { game, run, instruction }),
	state: (game, run) => ipcRenderer.invoke("state", { game, run }),
	uis: (game) => ipcRenderer.invoke("uis", { game }),
	use: (ref) => ipcRenderer.invoke("use", { ref }),
	settings: () => ipcRenderer.invoke("settings"),
	env: () => ipcRenderer.invoke("env"),
	setSettings: (patch) => ipcRenderer.invoke("settings:set", { patch }),
	openSettings: () => ipcRenderer.invoke("settings:open"),
	models: () => ipcRenderer.invoke("models"),
	auth: {
		providers: () => ipcRenderer.invoke("auth:providers"),
		login: (provider, type) => ipcRenderer.invoke("auth:login", { provider, type }),
		answer: (flow, value) => ipcRenderer.invoke("auth:answer", { flow, value }),
		cancel: (flow) => ipcRenderer.invoke("auth:cancel", { flow }),
		logout: (provider) => ipcRenderer.invoke("auth:logout", { provider }),
		onPrompt: (listener) => {
			const handler = (_event, payload) => listener(payload);
			ipcRenderer.on("auth:prompt", handler);
			return () => ipcRenderer.removeListener("auth:prompt", handler);
		},
		onNotice: (listener) => {
			const handler = (_event, payload) => listener(payload);
			ipcRenderer.on("auth:notify", handler);
			return () => ipcRenderer.removeListener("auth:notify", handler);
		},
	},
	onEvent: (listener) => {
		const handler = (_event, payload) => listener(payload);
		ipcRenderer.on("event", handler);
		return () => ipcRenderer.removeListener("event", handler);
	},
});
