/** 壳协议（window.cave）：preload.cjs 是运行时事实，此处是可复制的类型面（内容界面按此对接，不打包）。
 * 注意：window.cave 为不可配置全局属性，脚本顶层不得再声明同名 const/let cave（SyntaxError），须置于 IIFE 内或改名。 */
export interface CaveUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CaveRun {
	game: string;
	run: string;
	turn: number;
	time: number;
	view: unknown;
}

export interface CaveRecordFace {
	game: string;
	run: string;
	broken: number;
	records: unknown[];
}

export interface CaveRunFace {
	game: string;
	run: string;
	turn?: number;
	time?: number;
	mtime: number;
}

export interface CaveSessionFace {
	game: string;
	run: string;
	turn: number;
	time: number;
	busy: "act" | "narrate" | null;
}

export interface CaveParamFace {
	name: string;
	type: "string" | "number" | "boolean" | "ref";
	ref: boolean;
	many: boolean;
	optional: boolean;
	description?: string;
}

export interface CaveVerbFace {
	id: string;
	label: string;
	description: string;
	cost: number;
	params: CaveParamFace[];
}

export interface CaveSlotFace {
	key: string;
	type: "string" | "number" | "boolean" | "ref";
	many: boolean;
	strong?: boolean;
	label?: string | null;
}

export interface CaveDefFace {
	game: string;
	verbs: CaveVerbFace[];
	props: CaveSlotFace[];
	relTypes: CaveSlotFace[];
}

export interface CaveUiFace {
	name: string;
	game?: string[];
	error?: string;
}

export interface CaveActResult extends CaveRun {
	steps: unknown[];
	lines: string[];
	reveals: unknown[];
	narration: string;
	warnings: string[];
	usage: CaveUsage[];
}

export interface CaveNarration {
	narration: string;
	warnings: string[];
	usage: CaveUsage[];
}

export interface CaveModelRef {
	ref: string;
	provider: string;
	id: string;
	name: string;
	available: boolean;
}

export interface CaveProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
	label?: string;
	oauthInUse?: boolean;
	apiKey?: { label: string; login: boolean };
	oauth?: { label: string; subscription: boolean };
}

export type CavePrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };

export type CaveNotice =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };

export type CaveEngineEvent =
	| { type: "narration_delta"; delta: string }
	| { type: "narration_reset" };

export interface CaveBridge {
	games(): Promise<string[]>;
	runs(game?: string): Promise<CaveRunFace[]>;
	records(game: string, run: string): Promise<CaveRecordFace>;
	sessions(): Promise<CaveSessionFace[]>;
	def(game: string): Promise<CaveDefFace>;
	meta(game: string): Promise<{ game: string; meta: Record<string, unknown>; error?: string }>;
	open(game: string, run: string): Promise<CaveRun & { warnings: string[] }>;
	close(game: string, run: string): Promise<void>;
	act(game: string, run: string, utterance: string): Promise<CaveActResult>;
	narrate(game: string, run: string, instruction: string): Promise<CaveNarration>;
	state(game: string, run: string): Promise<CaveRun>;
	uis(game?: string): Promise<CaveUiFace[]>;
	use(name: string): Promise<void>;
	settings(): Promise<Record<string, unknown>>;
	strings(): Promise<{ locale: string; strings: Record<string, string>; configDir: string }>;
	setSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
	openSettings(): Promise<void>;
	models(): Promise<CaveModelRef[]>;
	auth: {
		providers(): Promise<CaveProviderInfo[]>;
		login(provider: string, type: "api_key" | "oauth"): Promise<{ provider: string; type: "api_key" | "oauth" }>;
		answer(flow: number, value: string): Promise<void>;
		cancel(flow: number): Promise<void>;
		logout(provider: string): Promise<void>;
		onPrompt(listener: (payload: { flow: number; prompt: CavePrompt }) => void): () => void;
		onNotice(listener: (payload: { flow: number; notice: CaveNotice }) => void): () => void;
	};
	onEvent(listener: (payload: { game: string; run: string; event: CaveEngineEvent }) => void): () => void;
}

declare global {
	interface Window {
		cave: CaveBridge;
	}
}
