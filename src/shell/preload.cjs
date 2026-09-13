const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cave", {
	games: () => ipcRenderer.invoke("cave:games"),
	open: (game, run) => ipcRenderer.invoke("cave:open", { game, run }),
	act: (utterance) => ipcRenderer.invoke("cave:act", { utterance }),
	narrate: (instruction) => ipcRenderer.invoke("cave:narrate", { instruction }),
	state: () => ipcRenderer.invoke("cave:state"),
	reset: (game, run) => ipcRenderer.invoke("cave:reset", { game, run }),
	uis: () => ipcRenderer.invoke("cave:uis"),
	use: (name) => ipcRenderer.invoke("cave:use", { name }),
	settings: () => ipcRenderer.invoke("cave:settings"),
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
