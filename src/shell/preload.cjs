const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cave", {
	games: () => ipcRenderer.invoke("cave:games"),
	open: (game, run) => ipcRenderer.invoke("cave:open", { game, run }),
	act: (utterance) => ipcRenderer.invoke("cave:act", { utterance }),
	narrate: (instruction) => ipcRenderer.invoke("cave:narrate", { instruction }),
	state: () => ipcRenderer.invoke("cave:state"),
	reset: (game, run) => ipcRenderer.invoke("cave:reset", { game, run }),
	onEvent: (listener) => {
		const handler = (_event, payload) => listener(payload);
		ipcRenderer.on("cave:event", handler);
		return () => ipcRenderer.removeListener("cave:event", handler);
	},
});
