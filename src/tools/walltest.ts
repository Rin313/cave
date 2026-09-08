import {
	D,
	defineVerb,
	deny,
	entity,
	grant,
	ref,
	type Denial,
	type Entity,
	type GameDef,
	type Invariant,
	type LedgerValue,
	type PropDef,
	type PropValue,
	type Q,
	type SystemRule,
	type VerbDef,
} from "../core/sim.ts";
import { withDevWait } from "./dev.ts";
import { printReports, runScenario, type ScenarioReport, type ScenarioStep } from "./sim.ts";

const num = (v: unknown): number => Number(v ?? 0);

function leakHp(q: Q): void {
	const me = entity(q.world, q.player);
	if (me) me.props.hp = (typeof me.props.hp === "number" ? me.props.hp : 0) - 1;
}

const playerEntity = (props: Record<string, LedgerValue> = {}): Entity => ({ id: "player", name: "你", props: { touched: 0, ...props } });
const thingEntity = (): Entity => ({ id: "thing", name: "那件东西", props: {} });

function makeDef(spec: {
	verbs: Record<string, VerbDef>;
	props?: Record<string, PropDef>;
	entities?: Entity[];
	systems?: SystemRule[];
	invariants?: Invariant[];
	grounding?: GameDef["grounding"];
	propPerception?: GameDef["propPerception"];
}): GameDef {
	return withDevWait({
		id: "walltest",
		title: "结构墙",
		playerId: "player",
		recentWindow: 0,
		messages: { noResponse: "世界没有回应。", defaultReason: "……", timePassed: "时间流逝" },
		verbs: spec.verbs,
		world: { time: 0, entities: spec.entities ?? [playerEntity()], relations: [] },
		props: { touched: { type: "number", label: "触及" }, ...spec.props },
		...(spec.systems && { systems: spec.systems }),
		...(spec.invariants && { invariants: spec.invariants }),
		...(spec.grounding && { grounding: spec.grounding }),
		...(spec.propPerception && { propPerception: spec.propPerception }),
	});
}

const touch = defineVerb({
	label: "触及",
	description: "干净动作：touched +1（冻结与回滚的对照步）。",
	params: {},
	rules: [{ id: "ok", judge: (q) => grant([D.set(q.player, "touched", num(entity(q.world, q.player)!.props.touched) + 1)], "你触到了世界。") }],
});

const poke = defineVerb({
	label: "戳",
	description: "规则直改 hp 后授予（冻结读态上写入即抛，授予不存在）。",
	params: {},
	rules: [{
		id: "leak",
		judge: (q) => {
			leakHp(q);
			const me = entity(q.world, q.player)!;
			return grant([D.set(q.player, "touched", num(me.props.touched) + 1)], "你戳了一下。");
		},
	}],
});

const clockpoke = defineVerb({
	label: "拨钟",
	description: "规则直改 q.world.time（钟的唯一写者是落钟循环）。",
	params: {},
	rules: [{ id: "leak", judge: (q) => { q.world.time += 1; return grant([], "钟被拨了。"); } }],
});

const trip = defineVerb({
	label: "触封印",
	description: "合法授予被守恒不变式否决（原子回滚后账本仍可提交）。",
	params: {},
	rules: [{ id: "grant", judge: (q) => grant([D.set(q.player, "vault", true)], "你碰了封印。") }],
});

const knock = defineVerb({
	label: "叩问",
	description: "尝试价一刻：可见性门与硬墙的拒绝同样耗尝试价。",
	params: { target: ref("目标实体 id") },
	cost: 1,
	rules: [{ id: "knock.vault", judge: (q) => grant([D.set(q.player, "vault", true)], "你叩了叩封印。") }],
});

const sneakpoke = defineVerb({
	label: "触潜标",
	description: "授予后触发审查者直改账本（冻结读态上写入即抛）。",
	params: {},
	rules: [{
		id: "grant",
		judge: (q) => {
			const me = entity(q.world, q.player)!;
			return grant([D.set(q.player, "sneak", num(me.props.sneak) + 1)], "你碰了潜标。");
		},
	}],
});

const smuggle = defineVerb({
	label: "夹带",
	description: "铸出对象形状的 delta——提交翼拒为非账本值，整提交回滚。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.set("player", "note", { a: 1 } as unknown as PropValue)], "你夹带了。") }],
});

const tag = defineVerb({
	label: "标记",
	description: "字面与引用同值写入：字面保持字面，id 型属性解析为展示名。",
	params: {},
	rules: [{ id: "ok", judge: () => grant([D.set("player", "note", "thing"), D.set("player", "ref", "thing")], "你写下了标记。") }],
});

const junkspawn = defineVerb({
	label: "夹带生灭",
	description: "spawn 带实体形状外的顶层键——形状封闭拒绝。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.spawn({ id: "junk", name: "杂物", props: {}, extra: 1 } as unknown as Entity)], "你夹带了。") }],
});

const nullspawn = defineVerb({
	label: "空壳生灭",
	description: "spawn 的属性含 null——账本值不含 null，提交翼拒绝。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.spawn({ id: "hollow", name: "空壳", props: { hp: null } } as unknown as Entity)], "你召唤了空壳。") }],
});

const clear = defineVerb({
	label: "抹除",
	description: "set null 即清（删键）——账本不存 null，缺席读为 null。",
	params: {},
	rules: [{ id: "ok", judge: () => grant([D.set("player", "note", null), D.set("player", "ref", null)], "你抹去了字迹。") }],
});

const blank = defineVerb({
	label: "置空引用",
	description: "id 引用写空串——无哨兵惯例，integrity 拒绝。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.set("player", "ref", "")], "你写下了一段空白。") }],
});

const edgearr = defineVerb({
	label: "数组边",
	description: "边值与属性值同一账本形状——标量数组合法入账。",
	params: {},
	rules: [{ id: "ok", judge: () => grant([D.relSet("player", "thing", "标记", ["甲"])], "你系了一条带标记的边。") }],
});

const mistype = defineVerb({
	label: "误型",
	description: "relSet 的关系类型为数字——type 是边身份的组成，执行翼拒绝。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.relSet("player", "thing", 123 as unknown as string, "甲")], "你系了一条无名边。") }],
});

const edgeobj = defineVerb({
	label: "对象边",
	description: "对象形状不是账本值——提交翼拒绝，整提交回滚。",
	params: {},
	rules: [{ id: "leak", judge: () => grant([D.relSet("player", "thing", "暗边", { a: 1 } as unknown as LedgerValue)], "你夹带了。") }],
});

const bond = defineVerb({
	label: "缔结",
	description: "与那件东西结一条带值的关系边（弱引用的建立）。",
	params: {},
	rules: [{ id: "ok", judge: () => grant([D.relSet("player", "thing", "标记", "甲")], "你与那件东西结下纽带。") }],
});

const sever = defineVerb({
	label: "断绝",
	description: "despawn 那件东西——级联删边逐条入账（despawn 记录在前，边消散紧随）。",
	params: {},
	rules: [{ id: "ok", judge: () => grant([D.despawn("thing")], "你斩断了那件东西。") }],
});

const stack = defineVerb({
	label: "叠写",
	description: "同一值地址的叠加增量按序覆盖——两个从冻结读态派生的 +1 只落一次。",
	params: {},
	rules: [{
		id: "ok",
		judge: (q) => {
			const me = entity(q.world, q.player)!;
			const v = num(me.props.touched) + 1;
			return grant([D.set(q.player, "touched", v), D.set(q.player, "touched", v)], "你叠了两次。");
		},
	}],
});

const boom = defineVerb({
	label: "崩坏",
	description: "规则中途抛出——门的全面性代谢为必要性否决（链终止，时价照耗）。",
	params: {},
	cost: 2,
	rules: [
		{ id: "first", judge: () => { throw new Error("法则在半空碎裂"); } },
		{ id: "fallback", judge: () => deny("boom.fallback", { reason: "兜底法则不应被触及——崩溃链即终止。" }) },
	],
});

const blindfold = defineVerb({
	label: "蒙眼",
	description: "授予 gaze=true——提交后感知快照崩溃，apply 原子回滚后重抛。",
	params: {},
	rules: [{ id: "grant", judge: () => grant([D.set("player", "gaze", true)], "你蒙上了眼。") }],
});

const beckon = defineVerb({
	label: "召唤",
	description: "对参照域内的实体召唤（干净授予）；域外 id 由可见性门拒绝。",
	params: { target: ref("目标实体 id") },
	rules: [{ id: "ok", judge: () => grant([], "你朝那东西招了招手。") }],
});

const rewrite = defineVerb({
	label: "改判",
	description: "法则改写裁决入参（q.params）——attempt 入界即冻结，越权写即抛。",
	params: {},
	rules: [{
		id: "tamper",
		judge: (q) => {
			(q.params as Record<string, unknown>).hack = true;
			return grant([], "参数被改写。");
		},
	}],
});

const leakSystem: SystemRule = { id: "leak.tick", run: (q) => { leakHp(q); return null; } };
const boomSystem: SystemRule = { id: "boom.tick", run: () => { throw new Error("系统在半空碎裂"); } };
const beatsSystem: SystemRule = {
	id: "beats.tick",
	run: (q) => ({ deltas: [D.set(q.player, "beats", num(entity(q.world, q.player)!.props.beats) + 1)] }),
};
const mechSystem: SystemRule = {
	id: "mech.tick",
	run: (q) => {
		const me = entity(q.world, q.player)!;
		return q.time % 2 === 1
			? { deltas: [D.set(q.player, "mechturn", Number(me.props.mechturn ?? 0) + 1)] }
			: { deltas: [D.set(q.player, "beats", num(me.props.beats) + 1)] };
	},
};
const vaultSystem: SystemRule = { id: "vault.tick", run: (q) => ({ deltas: [D.set(q.player, "vault", true)] }) };

const vaultSealed: Invariant = {
	id: "vault.sealed",
	check: (_world, ctx) => (ctx.changes.some((c) => c.kind === "prop" && c.prop === "vault") ? "封印纹丝不动。" : null),
};

const sneaky: Invariant = {
	id: "sneaky",
	check: (world, ctx) => {
		if (!ctx.changes.some((c) => c.kind === "prop" && c.prop === "sneak")) return null;
		const me = world.entities.find((e) => e.id === ctx.def.playerId);
		if (me) me.props.hp = 999;
		return null;
	},
};

function grudgeDef(): GameDef {
	let retained: Denial | undefined;
	return makeDef({
		verbs: {
			grudge: defineVerb({
				label: "记仇",
				description: "法则保留拒绝对象并于下次裁决改写它——步入账即冻结，越权写即抛。",
				params: {},
				rules: [{
					id: "hold",
					judge: () => {
						if (retained) {
							retained.reason = "被改写的记仇";
							return deny("grudge.rewrite", { reason: "不应到达。" });
						}
						retained = { law: "grudge.hold", reason: "初次记仇。" };
						return { ok: false, denial: retained };
					},
				}],
			}),
		},
	});
}

interface WallCase {
	name: string;
	def: GameDef;
	steps: ScenarioStep[];
}

const CASES: WallCase[] = [
	{
		name: "规则越权写在写入点即抛，门代谢为必要性否决——冻结不误伤干净裁决",
		def: makeDef({
			verbs: { touch, poke, clockpoke },
			props: { hp: { type: "number", label: "生命" } },
			entities: [playerEntity({ hp: 10 })],
		}),
		steps: [
			{ name: "干净动作：冻结不误伤", action: { verb: "touch", params: {} }, expect: { ok: true, reason: "触到", state: { "player.touched": 1, "player.hp": 10 } } },
			{ name: "规则越权写属性：冻结读态上写入即抛，崩溃代谢为 rule.crash（授予不存在）", action: { verb: "poke", params: {} }, expect: { ok: false, law: "rule.crash", reason: "世界没有回应", state: { "player.touched": 1, "player.hp": 10 } } },
			{ name: "规则越权拨钟：钟的唯一写者是落钟循环，按构造成立", action: { verb: "clockpoke", params: {} }, expect: { ok: false, law: "rule.crash", state: { "$world.time": 0 } } },
			{ name: "越权未遂后世界仍健康：干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 2, "player.hp": 10 } } },
		],
	},
	{
		name: "系统越权写同墙：system.crash 失败刻步，其余系统照跑、时刻照走",
		def: makeDef({
			verbs: { touch },
			props: { hp: { type: "number", label: "生命" }, beats: { type: "number", label: "摆动" } },
			entities: [playerEntity({ hp: 10 })],
			systems: [leakSystem, beatsSystem],
		}),
		steps: [
			{ name: "系统越权写属性：TypeError 兑为 system.crash 失败刻步，beats.tick 照跑", tick: 1, expect: { tickDenied: true, lines: ["⏱ （你.摆动: null → 1）", "⏱ ✗ 世界没有回应。"], state: { "player.hp": 10, "player.beats": 1, "$world.time": 1 } } },
		],
	},
	{
		name: "墙否决的原子回滚：回滚后账本仍可提交（冻结引用不得留在活账本）",
		def: makeDef({
			verbs: { touch, trip },
			props: { vault: { type: "boolean", label: "封印" } },
			invariants: [vaultSealed],
		}),
		steps: [
			{ name: "合法授予被领域不变式否决：整提交回滚，状态零漂移", action: { verb: "trip", params: {} }, expect: { ok: false, reason: "封印", state: { "player.vault": null, "player.touched": 0 } } },
			{ name: "回滚后的干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.vault": null } } },
		],
	},
	{
		name: "夹带形状值：类型层除名后的 as 通道由运行时复核拦截",
		def: makeDef({
			verbs: { touch, smuggle },
			props: { note: { type: "string", label: "便签" } },
		}),
		steps: [
			{ name: "对象形状值拒为非账本值，整提交回滚", action: { verb: "smuggle", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "player.note": null, "player.touched": 0 } } },
			{ name: "夹带被拒后账本仍健康（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.note": null } } },
		],
	},
	{
		name: "审查者同权隔离：不变式越权写在冻结读态上即抛——先回滚后拒绝",
		def: makeDef({
			verbs: { touch, sneakpoke },
			props: { sneak: { type: "number", label: "潜标" }, hp: { type: "number", label: "生命" } },
			entities: [playerEntity({ hp: 10 })],
			invariants: [sneaky],
		}),
		steps: [
			{ name: "审查者越权写账本：TypeError 在提交边界兑为 invariant.crash 否决，整提交回滚", action: { verb: "sneakpoke", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "player.sneak": null, "player.hp": 10 } } },
			{ name: "审查者崩溃后账本仍健康：干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.hp": 10 } } },
		],
	},
	{
		name: "法则代码失灵：rule.crash 链终止、时价照耗，被拦刻步独立成行",
		def: makeDef({
			verbs: { touch, boom },
			props: { vault: { type: "boolean", label: "封印" } },
			systems: [vaultSystem],
			invariants: [vaultSealed],
		}),
		steps: [
			{ name: "规则中途抛出：崩溃兑为 rule.crash 否决步（链终止——兜底法则不可达），时价照耗", action: { verb: "boom", params: {} }, expect: { ok: false, law: "rule.crash", reason: "世界没有回应", tickDenied: true, lines: ["✗ 崩坏：世界没有回应。", "⏱ ✗ 封印纹丝不动。", "⏱ ✗ 封印纹丝不动。"], state: { "player.touched": 0, "$world.time": 2 } } },
			{ name: "崩溃后世界仍健康：时价已耗，干净提交照常", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "$world.time": 2 } } },
		],
	},
	{
		name: "系统直接抛出：崩溃兑为 system.crash 失败刻步，其余系统不连坐",
		def: makeDef({
			verbs: { touch },
			props: { beats: { type: "number", label: "摆动" } },
			systems: [boomSystem, beatsSystem],
		}),
		steps: [
			{ name: "系统直接抛出：失败刻步，beats.tick 照跑，时刻照走", tick: 1, expect: { tickDenied: true, lines: ["⏱ （你.摆动: null → 1）", "⏱ ✗ 世界没有回应。"], state: { "$world.time": 1, "player.beats": 1 } } },
		],
	},
	{
		name: "拒绝恒价：可见性门与硬墙的拒绝同样落钟（尝试价照耗）",
		def: makeDef({
			verbs: { knock },
			props: { vault: { type: "boolean", label: "封印" } },
			entities: [playerEntity(), thingEntity()],
			invariants: [vaultSealed],
		}),
		steps: [
			{ name: "域外指称：可见性门拒绝，尝试价照耗（一刻，静默聚合）", action: { verb: "knock", params: { target: "nowhere" } }, expect: { ok: false, law: "action.invisible", reason: "世界没有回应", lines: ["✗ 叩问(nowhere)：世界没有回应。", "⏱ 时间流逝 ×1"], state: { "$world.time": 1 } } },
			{ name: "域内指称：法则授予封印，硬墙否决，尝试价照耗", action: { verb: "knock", params: { target: "thing" } }, expect: { ok: false, law: "invariant.vault.sealed", reason: "封印", lines: ["✗ 叩问(那件东西)：封印纹丝不动。", "⏱ 时间流逝 ×1"], state: { "$world.time": 2 } } },
		],
	},
	{
		name: "投影缺陷不产世界事件：感知崩溃在 apply 边界原子回滚后重抛",
		def: makeDef({
			verbs: { touch, blindfold },
			props: { gaze: { type: "boolean", internal: true } },
			grounding: (world) => {
				if (world.entities.some((e) => e.props.gaze === true)) throw new Error("感知在半空碎裂");
				return world.entities.map((e) => e.id);
			},
		}),
		steps: [
			{ name: "提交后感知快照崩溃：grant 已提交但步骤不可建——整 apply 回滚（gaze 不入账、时间不走）后响亮重抛", action: { verb: "blindfold", params: {} }, expect: { throws: "感知在半空碎裂", state: { "player.gaze": null, "player.touched": 0, "$world.time": 0 } } },
			{ name: "原子回滚后账本健康：干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.gaze": null } } },
		],
	},
	{
		name: "感知钩子的冻结契约：跨度两侧都收冻结读态——武装钩子在未冻结读态上写账本即被状态断言捕获",
		def: makeDef({
			verbs: { touch },
			props: { hp: { type: "number", label: "生命" } },
			entities: [playerEntity({ hp: 10 })],
			propPerception: () => (e) => {
				if (!Object.isFrozen(e)) e.props.hp = 999;
				return true;
			},
		}),
		steps: [
			{ name: "干净提交：本步自身的裁决读态与提交后采样已在冻结读态上运行——hp 零污染", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.hp": 10 } } },
			{ name: "干净提交照常：全程冻结（回归探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 2, "player.hp": 10 } } },
		],
	},
	{
		name: "账本形状：零边世界边表保持空表，零边授予不添形",
		def: makeDef({ verbs: { touch } }),
		steps: [
			{ name: "无关系世界的授予提交后，边表仍是空表（缺席不是边表的形态，空表即无边）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "$world.relations": [], "player.touched": 1 } } },
		],
	},
	{
		name: "刻账目闭合：有言刻成块，内务刻与无步刻同归静默——言默与消费面无关",
		def: makeDef({
			verbs: { touch },
			props: { mechturn: { type: "number", internal: true }, beats: { type: "number", label: "摆动" } },
			systems: [mechSystem],
		}),
		steps: [
			{ name: "两刻：奇刻仅内务变更（internal 滤为静默）、偶刻机械变更——有言成块，静默 ×1", tick: 2, expect: { ok: true, lines: ["⏱ （你.摆动: null → 1）", "⏱ 时间流逝 ×1"], state: { "player.beats": 1, "player.mechturn": 1 } } },
		],
	},
	{
		name: "指称解析按声明：字面字符串与实体 id 碰撞也不得解析，id 型属性解析为展示名",
		def: makeDef({
			verbs: { tag },
			props: { note: { type: "string", label: "便签" }, ref: { type: "id", label: "指向" } },
			entities: [playerEntity(), thingEntity()],
		}),
		steps: [
			{ name: "字面保持字面，引用解析为名字", action: { verb: "tag", params: {} }, expect: { ok: true, lines: ["✓ 标记：你写下了标记。（你.便签: null → thing；你.指向: null → 那件东西）"] } },
		],
	},
	{
		name: "缺席编码：null 是记号不是存储——set null 删键、幂等跳过、账本拒 null",
		def: makeDef({
			verbs: { tag, clear, touch, nullspawn },
			props: { note: { type: "string", label: "便签" }, ref: { type: "id", label: "指向" } },
			entities: [playerEntity(), thingEntity()],
		}),
		steps: [
			{ name: "写入字面与引用（前置）", action: { verb: "tag", params: {} }, expect: { ok: true } },
			{ name: "set null 即清：删键，读数为 null（缺席的记号），变更行与删边同符", action: { verb: "clear", params: {} }, expect: { ok: true, lines: ["✓ 抹除：你抹去了字迹。（你.便签: thing → null；你.指向: 那件东西 → null）"], state: { "player.note": null, "player.ref": null } } },
			{ name: "已缺席再清：幂等跳过（缺席即状态），无变更行", action: { verb: "clear", params: {} }, expect: { ok: true, lines: ["✓ 抹除：你抹去了字迹。"], state: { "player.note": null, "player.ref": null } } },
			{ name: "账本形状探针：清后的 props 键集不含已清属性——null 不入存储", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "$world.entities.0.props": { touched: 1 } } } },
			{ name: "spawn 属性含 null：提交翼拒绝（账本值不含 null，缺席是键不在场）", action: { verb: "nullspawn", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "$world.entities.2": null } } },
		],
	},
	{
		name: "形状封闭与边值契约：无哨兵引用、实体形状封闭、边值=账本值",
		def: makeDef({
			verbs: { touch, blank, junkspawn, edgearr, edgeobj },
			props: { ref: { type: "id", label: "指向" } },
			entities: [playerEntity(), thingEntity()],
		}),
		steps: [
			{ name: "id 引用写空串：无哨兵——integrity 拒绝，整提交回滚（「无引用」由缺席表达）", action: { verb: "blank", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "player.ref": null } } },
			{ name: "拒绝后的干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1, "player.ref": null } } },
			{ name: "spawn 带实体形状外的顶层键：形状封闭拒绝", action: { verb: "junkspawn", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "$world.entities.2": null } } },
			{ name: "边值=账本值：标量数组合法入账（与属性值同一形状契约）", action: { verb: "edgearr", params: {} }, expect: { ok: true, lines: ["✓ 数组边：你系了一条带标记的边。（你.标记.那件东西: null → 甲）"] } },
			{ name: "对象形状不是账本值：提交翼拒绝（宽读契约的边界）", action: { verb: "edgeobj", params: {} }, expect: { ok: false, reason: "世界没有回应" } },
		],
	},
	{
		name: "边身份契约：type 是边的身份组成——执行校验拒误型，integrity 对存储边同查",
		def: makeDef({
			verbs: { touch, mistype },
			entities: [playerEntity(), thingEntity()],
		}),
		steps: [
			{ name: "relSet 的 type 为数字：执行校验拒绝（身份退化不入账）", action: { verb: "mistype", params: {} }, expect: { ok: false, reason: "世界没有回应", state: { "$world.relations": [] } } },
			{ name: "拒绝后的干净提交照常（回滚探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "$world.relations": [] } } },
		],
	},
	{
		name: "级联删边入账：despawn 的机械后果逐条入账，变更流是后态的完整 diff",
		def: makeDef({
			verbs: { touch, bond, sever },
			entities: [playerEntity(), thingEntity()],
		}),
		steps: [
			{ name: "先结一条带值的边（弱引用的建立）", action: { verb: "bond", params: {} }, expect: { ok: true, lines: ["✓ 缔结：你与那件东西结下纽带。（你.标记.那件东西: null → 甲）"], state: { "$world.relations.0.value": "甲" } } },
			{ name: "despawn 级联删边：despawn 记录在前、边消散紧随（边表序），离场名经 despawn 记录兜底渲染", action: { verb: "sever", params: {} }, expect: { ok: true, lines: ["✓ 断绝：你斩断了那件东西。（- 那件东西；你.标记.那件东西: 甲 → null）"], state: { "$world.relations.0": null, "thing.id": null } } },
			{ name: "级联后账本健康：干净提交照常（探针步）", action: { verb: "touch", params: {} }, expect: { ok: true, state: { "player.touched": 1 } } },
		],
	},
	{
		name: "同址叠加：绝对写下没有读通道——从冻结读态重复派生的增量按序覆盖，只落一次",
		def: makeDef({ verbs: { stack } }),
		steps: [
			{ name: "两次 w⁻ 派生的 +1：终值 +1 而非 +2，同值后写幂等跳过（单变更行）", action: { verb: "stack", params: {} }, expect: { ok: true, lines: ["✓ 叠写：你叠了两次。（你.触及: 0 → 1）"], state: { "player.touched": 1 } } },
		],
	},
	{
		name: "参照域契约：门权威 = grounding ∩ 账本——谎报的 id 不可指名，在册实体不误伤",
		def: makeDef({
			verbs: { beckon },
			entities: [playerEntity(), thingEntity()],
			grounding: (world) => [...world.entities.map((e) => e.id), "ghost"],
		}),
		steps: [
			{ name: "干净对照：召唤在册实体（参照域内，法则授予）", action: { verb: "beckon", params: { target: "thing" } }, expect: { ok: true, reason: "招了招手" } },
			{ name: "幻影不可指名：门拒绝，与幻觉 id 同一文案（无存在性 oracle）；域外指称在尝试行原样回显", action: { verb: "beckon", params: { target: "ghost" } }, expect: { ok: false, law: "action.invisible", reason: "世界没有回应", lines: ["✗ 召唤(ghost)：世界没有回应。"] } },
			{ name: "谎报不误伤：在册实体照常可指名（干净对照步）", action: { verb: "beckon", params: { target: "thing" } }, expect: { ok: true } },
		],
	},
	{
		name: "静态形态违约错在裁决之外：内核收到即调用方违约，抛 ProtocolViolation（裁决与落钟不发生）",
		def: makeDef({ verbs: { touch } }),
		steps: [
			{ name: "未知动词：action.unknown 协议违约，世界为调用前原状", action: { verb: "no_such_verb", params: {} }, expect: { protocol: "action.unknown", state: { "$world.time": 0, "player.touched": 0 } } },
			{ name: "schema 违约：未知参数被形状封闭拒绝（action.schema），世界同样不动", action: { verb: "touch", params: { x: 1 } }, expect: { protocol: "action.schema", state: { "$world.time": 0, "player.touched": 0 } } },
		],
	},
	{
		name: "attempt 入界即冻结：法则改写裁决入参即抛——链内各法则与步记录所见同一不可变 attempt",
		def: makeDef({ verbs: { rewrite } }),
		steps: [
			{ name: "改写 q.params：TypeError 兑为 rule.crash（授予不存在，时价照耗，世界不动）", action: { verb: "rewrite", params: {} }, expect: { ok: false, law: "rule.crash", state: { "$world.time": 0 } } },
		],
	},
	{
		name: "步入账即冻结：法则保留的拒绝对象入账后改写即抛——记录是证据而非视图",
		def: grudgeDef(),
		steps: [
			{ name: "初次记仇：拒绝对象随步入账（本步返回即冻结）", action: { verb: "grudge", params: {} }, expect: { ok: false, law: "grudge.hold", reason: "初次记仇" } },
			{ name: "改写已入账的拒绝对象：TypeError 兑为 rule.crash，记录未被污染", action: { verb: "grudge", params: {} }, expect: { ok: false, law: "rule.crash" } },
		],
	},
];

function main(): void {
	const reports: ScenarioReport[] = CASES.map((c) => runScenario({ name: c.name, steps: c.steps }, c.def));
	printReports(reports);
	const passed = reports.reduce((a, r) => a + r.passed, 0);
	const total = reports.reduce((a, r) => a + r.total, 0);
	console.log(`\nWALLTEST: ${passed}/${total} PASS`);
	process.exit(passed === total ? 0 : 1);
}

main();
