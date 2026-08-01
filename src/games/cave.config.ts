import type { GameConfig } from "../core/types.ts";

export const caveConfig: GameConfig = {
	id: "cave",
	title: "地窖",
	roomId: "cave",
	playerId: "player",
	entities: [
		{
			id: "ring",
			name: "铜戒",
			attrs: { grabbable: true, attachedTo: "skeleton", material: "copper" },
			location: "skeleton",
		},
		{
			id: "skeleton",
			name: "骷髅",
			attrs: {},
			location: "cave",
		},
		{
			id: "torch",
			name: "火把",
			attrs: { grabbable: true, lit: true },
			location: "cave",
		},
		{
			id: "candle",
			name: "蜡烛",
			attrs: { grabbable: true, lit: false, lightable: true },
			location: "chest",
		},
		{
			id: "chest",
			name: "木箱",
			attrs: { open: false, openable: true },
			location: "cave",
		},
		{
			id: "door",
			name: "石门",
			attrs: { open: false, openable: true },
			location: "cave",
		},
	],
	intents: [
		{
			label: "take",
			description: "拿起/捡起/取得一个可携带的实体",
			arity: 1,
			conditions: [
				{ op: "visible", entity: "self" },
				{ op: "equals", entity: "self", attr: "grabbable", value: true },
				{ op: "lacks", entity: "self", attr: "attachedTo" },
				{ op: "not_located", entity: "self", at: "player" },
			],
			effects: [{ op: "move", entity: "self", to: "player" }],
			messages: { ok: "你取下了{self}。", fail: "你无法拿起{self}。" },
		},
		{
			label: "open",
			description: "打开一个可开启的实体（门、箱子）",
			arity: 1,
			conditions: [
				{ op: "visible", entity: "self" },
				{ op: "equals", entity: "self", attr: "openable", value: true },
				{ op: "equals", entity: "self", attr: "open", value: false },
			],
			effects: [{ op: "set", entity: "self", attr: "open", value: true }],
			messages: { ok: "你打开了{self}。", fail: "打不开{self}。" },
		},
		{
			label: "light",
			description: "点燃一个可燃的实体（需要已点燃的火源在场）",
			arity: 1,
			conditions: [
				{ op: "visible", entity: "self" },
				{ op: "equals", entity: "self", attr: "lightable", value: true },
				{ op: "equals", entity: "self", attr: "lit", value: false },
				{ op: "exists_with", attr: "lit", value: true, exclude: "self" },
			],
			effects: [{ op: "set", entity: "self", attr: "lit", value: true }],
			messages: { ok: "你点燃了{self}。", fail: "没有火源，点不燃{self}。" },
		},
		{
			label: "move",
			description: "把可携带的实体移动到另一个实体或地点",
			arity: 2,
			conditions: [
				{ op: "visible", entity: "a" },
				{ op: "equals", entity: "a", attr: "grabbable", value: true },
				{ op: "visible", entity: "b" },
				{ op: "container", entity: "b" },
			],
			effects: [{ op: "move", entity: "a", to: "b" }],
			messages: { ok: "你把{a}放到了{b}那里。", fail: "无法把{a}移到{b}。" },
		},
		{
			label: "detach",
			description: "把实体从它所附着的物体上解下",
			arity: 1,
			conditions: [
				{ op: "visible", entity: "self" },
				{ op: "has", entity: "self", attr: "attachedTo" },
			],
			effects: [{ op: "unset", entity: "self", attr: "attachedTo" }, { op: "move", entity: "self", to: "player" }],
			messages: { ok: "你解下了{self}。", fail: "{self}没有被固定在任何东西上。" },
		},
		{
			label: "combine",
			description: "把两个实体组合在一起",
			arity: 2,
			conditions: [
				{
					op: "any",
					conditions: [
						{
							op: "all",
							conditions: [
								{ op: "equals", entity: "a", attr: "lightable", value: true },
								{ op: "equals", entity: "b", attr: "lit", value: true },
							],
						},
						{
							op: "all",
							conditions: [
								{ op: "equals", entity: "b", attr: "lightable", value: true },
								{ op: "equals", entity: "a", attr: "lit", value: true },
							],
						},
					],
				},
			],
			effects: [
				{
					op: "if",
					conditions: [
						{ op: "equals", entity: "a", attr: "lightable", value: true },
						{ op: "equals", entity: "b", attr: "lit", value: true },
					],
					then: [{ op: "set", entity: "a", attr: "lit", value: true }],
				},
				{
					op: "if",
					conditions: [
						{ op: "equals", entity: "b", attr: "lightable", value: true },
						{ op: "equals", entity: "a", attr: "lit", value: true },
					],
					then: [{ op: "set", entity: "b", attr: "lit", value: true }],
				},
			],
			messages: { ok: "你组合了{a}和{b}。", fail: "无法组合{a}和{b}。" },
		},
	],
};

export default caveConfig;


