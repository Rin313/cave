export type Primitive = string | number | boolean;

export interface EntityConfig {
	id: string;
	name: string;
	attrs: Record<string, Primitive>;
	location: string;
}

export type EntityRef = "self" | "a" | "b" | string;

export type Condition =
	| { op: "visible"; entity: EntityRef }
	| { op: "has"; entity: EntityRef; attr: string }
	| { op: "lacks"; entity: EntityRef; attr: string }
	| { op: "equals"; entity: EntityRef; attr: string; value: Primitive }
	| { op: "not_equals"; entity: EntityRef; attr: string; value: Primitive }
	| { op: "located"; entity: EntityRef; at: string }
	| { op: "not_located"; entity: EntityRef; at: string }
	| { op: "container"; entity: EntityRef }
	| { op: "exists_with"; attr: string; value: Primitive; exclude?: EntityRef }
	| { op: "all"; conditions: Condition[] }
	| { op: "any"; conditions: Condition[] };

export type Effect =
	| { op: "move"; entity: EntityRef; to: string }
	| { op: "set"; entity: EntityRef; attr: string; value: Primitive }
	| { op: "unset"; entity: EntityRef; attr: string }
	| { op: "if"; conditions: Condition[]; then: Effect[] };

export interface IntentDef {
	label: string;
	description: string;
	arity: number;
	conditions: Condition[];
	effects: Effect[];
	messages: { ok: string; fail: string };
}

export interface GameConfig {
	id: string;
	title: string;
	roomId: string;
	playerId: string;
	entities: EntityConfig[];
	intents: IntentDef[];
}

export interface Entity {
	id: string;
	name: string;
	attrs: Record<string, Primitive>;
	location: string;
}

export interface GameState {
	configId: string;
	roomId: string;
	player: string;
	entities: Entity[];
}

export interface ActionResult {
	ok: boolean;
	message: string;
	intent: string;
	entityIds: string[];
}

export type ActKind = "applied" | "rejected" | "refused";

export interface ActOutcome {
	kind: ActKind;
	intent?: string;
	result?: ActionResult;
}

export type EngineEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_call"; intent: string; entityIds: string[] }
	| { type: "tool_result"; result: ActionResult }
	| { type: "turn_end" };
