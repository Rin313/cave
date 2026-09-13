// window.cave 为不可配置全局属性：界面脚本顶层不得再声明同名 const/let cave（SyntaxError），须置于 IIFE 内或改名。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cave", {
	games: () => ipcRenderer.invoke("cave:games"),
	runs: (game) => (game === undefined ? ipcRenderer.invoke("cave:runs") : ipcRenderer.invoke("cave:runs", { game })),
	records: (game, run) => ipcRenderer.invoke("cave:records", { game, run }),
	sessions: () => ipcRenderer.invoke("cave:sessions"),
	def: (game) => ipcRenderer.invoke("cave:def", { game }),
	meta: (game) => ipcRenderer.invoke("cave:meta", { game }),
	open: (game, run) => ipcRenderer.invoke("cave:open", { game, run }),
	close: (game, run) => ipcRenderer.invoke("cave:close", { game, run }),
	act: (game, run, utterance) => ipcRenderer.invoke("cave:act", { game, run, utterance }),
	narrate: (game, run, instruction) => ipcRenderer.invoke("cave:narrate", { game, run, instruction }),
	state: (game, run) => ipcRenderer.invoke("cave:state", { game, run }),
	uis: (game) => (game === undefined ? ipcRenderer.invoke("cave:uis") : ipcRenderer.invoke("cave:uis", { game })),
	use: (name) => ipcRenderer.invoke("cave:use", { name }),
	settings: () => ipcRenderer.invoke("cave:settings"),
	env: () => ipcRenderer.invoke("cave:env"),
	setSettings: (patch) => ipcRenderer.invoke("cave:settings:set", { patch }),
	openSettings: () => ipcRenderer.invoke("cave:settings:open"),
	models: () => ipcRenderer.invoke("cave:models"),
	auth: {
		providers: () => ipcRenderer.invoke("cave:auth:providers"),
		login: (provider, type) => ipcRenderer.invoke("cave:auth:login", { provider, type }),
		answer: (flow, value) => ipcRenderer.invoke("cave:auth:answer", { flow, value }),
		cancel: (flow) => ipcRenderer.invoke("cave:auth:cancel", { flow }),
		logout: (provider) => ipcRenderer.invoke("cave:auth:logout", { provider }),
		onPrompt: (listener) => {
			const handler = (_event, payload) => listener(payload);
			ipcRenderer.on("cave:auth:prompt", handler);
			return () => ipcRenderer.removeListener("cave:auth:prompt", handler);
		},
		onNotice: (listener) => {
			const handler = (_event, payload) => listener(payload);
			ipcRenderer.on("cave:auth:notify", handler);
			return () => ipcRenderer.removeListener("cave:auth:notify", handler);
		},
	},
	onEvent: (listener) => {
		const handler = (_event, payload) => listener(payload);
		ipcRenderer.on("cave:event", handler);
		return () => ipcRenderer.removeListener("cave:event", handler);
	},
});
