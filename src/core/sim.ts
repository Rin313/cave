import type { ActionResult, Condition, Effect, Entity, EntityRef, GameConfig, GameState, IntentDef, Primitive } from "./types.ts";

export class Simulation {
	readonly config: GameConfig;
	state: GameState;

	constructor(config: GameConfig) {
		this.config = config;
		this.state = {
			configId: config.id,
			roomId: config.roomId,
			player: config.playerId,
			entities: config.entities.map((e) => ({ ...e, attrs: { ...e.attrs } })),
		};
	}

	reset(): void {
		this.state = {
			configId: this.config.id,
			roomId: this.config.roomId,
			player: this.config.playerId,
			entities: this.config.entities.map((e) => ({ ...e, attrs: { ...e.attrs } })),
		};
	}

	entity(id: string): Entity | undefined {
		return this.state.entities.find((e) => e.id === id);
	}

	intent(label: string): IntentDef | undefined {
		return this.config.intents.find((i) => i.label === label);
	}

	isVisible(id: string): boolean {
		const e = this.entity(id);
		if (!e) return false;
		if (e.location === this.state.roomId || e.location === this.state.player) return true;
		const host = this.entity(e.location);
		if (!host || !this.isVisible(host.id)) return false;
		if ("open" in host.attrs) return host.attrs.open === true;
		return true;
	}

	visibleEntityIds(): string[] {
		return this.state.entities.filter((e) => this.isVisible(e.id)).map((e) => e.id);
	}

	private resolveRef(ref: EntityRef, ids: string[]): Entity | undefined {
		if (ref === "self" || ref === "a") return this.entity(ids[0]);
		if (ref === "b") return this.entity(ids[1]);
		return this.entity(ref);
	}

	canHold(id: string): boolean {
		if (id === this.state.roomId || id === this.state.player) return true;
		const e = this.entity(id);
		return !!e && e.attrs.open === true;
	}

	evaluateCondition(cond: Condition, ids: string[]): boolean {
		switch (cond.op) {
			case "visible":
				return !!this.resolveRef(cond.entity, ids) && this.isVisible(this.resolveRef(cond.entity, ids)!.id);
			case "has": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && cond.attr in e.attrs;
			}
			case "lacks": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && !(cond.attr in e.attrs);
			}
			case "equals": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && e.attrs[cond.attr] === cond.value;
			}
			case "not_equals": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && e.attrs[cond.attr] !== cond.value;
			}
			case "located": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && e.location === cond.at;
			}
			case "not_located": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && e.location !== cond.at;
			}
			case "container": {
				const e = this.resolveRef(cond.entity, ids);
				return !!e && this.canHold(e.id);
			}
			case "exists_with":
				return this.state.entities.some((e) => {
					if (cond.exclude) {
						const ex = this.resolveRef(cond.exclude, ids);
						if (ex && e.id === ex.id) return false;
					}
					return e.attrs[cond.attr] === cond.value;
				});
			case "all":
				return cond.conditions.every((c) => this.evaluateCondition(c, ids));
			case "any":
				return cond.conditions.some((c) => this.evaluateCondition(c, ids));
		}
	}

	applyEffects(effects: Effect[], ids: string[]): boolean {
		let mutated = false;
		for (const fx of effects) {
			switch (fx.op) {
				case "move": {
					const e = this.resolveRef(fx.entity, ids);
					if (e) {
						const target = this.resolveRef(fx.to, ids);
						const dest = target?.id ?? fx.to;
						if (dest !== e.location && this.canHold(dest)) {
							e.location = dest;
							mutated = true;
						}
					}
					break;
				}
				case "set": {
					const e = this.resolveRef(fx.entity, ids);
					if (e && e.attrs[fx.attr] !== fx.value) {
						e.attrs[fx.attr] = fx.value;
						mutated = true;
					}
					break;
				}
				case "unset": {
					const e = this.resolveRef(fx.entity, ids);
					if (e && fx.attr in e.attrs) {
						delete e.attrs[fx.attr];
						mutated = true;
					}
					break;
				}
				case "if":
					if (fx.conditions.every((c) => this.evaluateCondition(c, ids))) {
						if (this.applyEffects(fx.then, ids)) mutated = true;
					}
					break;
			}
		}
		return mutated;
	}

	renderMessage(template: string, ids: string[]): string {
		const names = ids.map((id) => this.entity(id)?.name ?? id);
		return template
			.replace(/\{self\}/g, names[0] ?? "")
			.replace(/\{a\}/g, names[0] ?? "")
			.replace(/\{b\}/g, names[1] ?? "");
	}

	applyIntent(label: string, ids: string[]): ActionResult {
		const intent = this.intent(label);
		if (!intent) return { ok: false, message: `意图 ${label} 不在意图表中。`, intent: label, entityIds: ids };
		if (ids.length !== intent.arity) {
			return { ok: false, message: `实体数量不符：${label} 需要 ${intent.arity} 个。`, intent: intent.label, entityIds: ids };
		}
		if (new Set(ids).size !== ids.length) {
			return { ok: false, message: `实体重复：${label} 不能对同一个实体重复指定。`, intent: intent.label, entityIds: ids };
		}
		for (const id of ids) {
			if (!this.isVisible(id)) {
				return { ok: false, message: `实体 ${id} 不可见。`, intent: intent.label, entityIds: ids };
			}
		}
		const ok = intent.conditions.every((c) => this.evaluateCondition(c, ids));
		if (!ok) {
			return { ok: false, message: this.renderMessage(intent.messages.fail, ids), intent: intent.label, entityIds: ids };
		}
		const mutated = this.applyEffects(intent.effects, ids);
		if (!mutated) {
			return { ok: false, message: this.renderMessage(intent.messages.fail, ids), intent: intent.label, entityIds: ids };
		}
		const result: ActionResult = { ok: true, message: this.renderMessage(intent.messages.ok, ids), intent: intent.label, entityIds: ids };
		return result;
	}

	snapshot(): GameState {
		return JSON.parse(JSON.stringify(this.state)) as GameState;
	}

	static fromState(config: GameConfig, state: GameState): Simulation {
		const sim = new Simulation(config);
		sim.state = JSON.parse(JSON.stringify(state)) as GameState;
		return sim;
	}

	serialize(): string {
		const visible = this.state.entities.filter((e) => this.isVisible(e.id));
		return JSON.stringify(
			{
				room: this.state.roomId,
				player: this.state.player,
				entities: visible.map((e) => ({
					id: e.id,
					name: e.name,
					attrs: e.attrs,
					location: e.location,
				})),
			},
			null,
			2,
		);
	}
}
