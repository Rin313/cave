// 机械回归：只断言内核契约（门/闭合/价/骰子/级联/重放/投影），不涉及任何具体游戏与行文模板。
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openArchive } from "../src/core/archive.ts";
import { D, ProtocolViolation, Simulation, audienceOf, deny, defineVerb, entity, grant, lawOf, param, renderDenial, spineLines } from "../src/core/sim.ts";
import type { Action, Commit, GameDef, SlotDef, Verdict, VerbDef, World } from "../src/core/sim.ts";

const world = (): World => ({
	time: 0,
	entities: [
		{ id: "a", props: { name: "甲", marks: ["b", "c"], flag: false } },
		{ id: "b", props: { name: "乙", linked: ["c"] } },
		{ id: "c", props: { name: "丙", marks: ["c"], secret: "藏" } },
		{ id: "x", props: { name: "隐" } },
	],
	relations: [
		{ from: "a", to: "b", type: "link", value: true },
		{ from: "a", to: "b", type: "trust", value: 1 },
		{ from: "a", to: "c", type: "weak", value: "c" },
	],
});

const props: Record<string, SlotDef> = {
	name: { type: "string", label: "名" },
	marks: { type: "ref", strong: false, many: true, label: "记" },
	linked: { type: "ref", strong: false, many: true, label: "联" },
	secret: { type: "string", label: null },
	holder: { type: "ref", strong: true, label: "持者" },
	flag: { type: "boolean", label: "旗" },
};

const relTypes: Record<string, SlotDef> = {
	link: { type: "boolean", label: "连" },
	trust: { type: "number", label: null },
	weak: { type: "ref", strong: false },
};

const verbs: Record<string, VerbDef> = {
	chainG: defineVerb({ label: "导", description: "守卫链授予", cost: 2, params: {}, rules: [
		{ id: "skip", judge: (): Verdict | null => null },
		{ id: "yes", judge: () => grant([], { reply: "可。" }) },
	] }),
	chainD: defineVerb({ label: "截", description: "守卫链拒绝", cost: 0, params: {}, rules: [
		{ id: "skip", judge: (): Verdict | null => null },
		{ id: "no", judge: () => deny("chain.no", "不。") },
		{ id: "yes", judge: () => grant([], { reply: "可。" }) },
	] }),
	chainL: defineVerb({ label: "法", description: "显式 law", cost: 0, params: {}, rules: [
		{ id: "law", judge: () => grant([], { law: "外部法", reply: "法。" }) },
	] }),
	quiet: defineVerb({ label: "默", description: "全弃权", cost: 0, params: {}, rules: [{ id: "skip", judge: () => null }] }),
	silent: defineVerb({ label: "哑", description: "缺 text 的否决", cost: 0, params: {}, rules: [{ id: "sh", judge: () => deny("silent.sh") }] }),
	poke: defineVerb({ label: "碰", description: "指称门", cost: 0, params: { target: param("ref") }, rules: [{ id: "ok", judge: () => grant([], { reply: "碰。" }) }] }),
	pokeMany: defineVerb({ label: "碰多", description: "many 指称", cost: 0, params: { targets: param("ref", { many: true }) }, rules: [{ id: "ok", judge: () => grant([], { reply: "碰。" }) }] }),
	write: defineVerb({ label: "写", description: "改名", cost: 0, params: { entity: param("ref"), text: param("string") }, rules: [
		{ id: "w", judge: (q) => grant([D.set(q.params.entity, "name", q.params.text)], { reply: "写。" }) },
	] }),
	twice: defineVerb({ label: "双写", description: "同址多写", cost: 0, params: {}, rules: [
		{ id: "t", judge: () => grant([D.set("a", "name", "一"), D.set("a", "name", "二")], { reply: "双。" }) },
	] }),
	hide: defineVerb({ label: "藏", description: "写无名格", cost: 0, params: {}, rules: [{ id: "h", judge: () => grant([D.set("a", "secret", "改")], { reply: "改。" }) }] }),
	unset: defineVerb({ label: "清", description: "删除属性", cost: 0, params: { entity: param("ref"), prop: param("string") }, rules: [
		{ id: "u", judge: (q) => grant([D.set(q.params.entity, q.params.prop, null)], { reply: "清。" }) },
	] }),
	dice: defineVerb({ label: "掷", description: "确定性骰", cost: 0, params: {}, rules: [{ id: "lot", judge: (q) => grant([], { reply: String(q.roll("lot", 2)) }) }] }),
	sleep: defineVerb({ label: "歇", description: "时价覆写", cost: 3, params: { n: param("number") }, rules: [
		{ id: "nap", judge: (q) => grant([], { reply: "歇。", price: q.params.n }) },
	] }),
	slow: defineVerb({ label: "迟", description: "否决覆写价", cost: 2, params: {}, rules: [{ id: "late", judge: () => deny("slow.late", "迟了。", 1) }] }),
	boom: defineVerb({ label: "炸", description: "规则抛错", cost: 0, params: {}, rules: [{ id: "boom", judge: () => { throw new Error("炸"); } }] }),
	kill: defineVerb({ label: "灭", description: "despawn", cost: 0, params: { entity: param("ref") }, rules: [
		{ id: "k", judge: (q) => grant([D.despawn(q.params.entity)], { reply: "灭。" }) },
	] }),
	vanish: defineVerb({ label: "消", description: "按字面 id despawn", cost: 0, params: { id: param("string") }, rules: [
		{ id: "v", judge: (q) => grant([D.despawn(q.params.id)], { reply: "消。" }) },
	] }),
	dup: defineVerb({ label: "重", description: "重复 spawn", cost: 0, params: {}, rules: [
		{ id: "d", judge: () => grant([D.spawn({ id: "a", props: {} })], { reply: "重。" }) },
	] }),
	tie: defineVerb({ label: "系", description: "立强引用", cost: 0, params: {}, rules: [
		{ id: "t", judge: () => grant([D.set("a", "holder", "c")], { reply: "系。" }) },
	] }),
	empty: defineVerb({ label: "空", description: "空序列载荷", cost: 0, params: {}, rules: [
		{ id: "e", judge: () => grant([D.set("a", "marks", [])], { reply: "空。" }) },
	] }),
	badEdge: defineVerb({ label: "错边", description: "注册边值违约", cost: 0, params: {}, rules: [
		{ id: "b", judge: () => grant([D.relSet("a", "b", "trust", "x")], { reply: "错。" }) },
	] }),
	openEdge: defineVerb({ label: "开口边", description: "未注册 token", cost: 0, params: {}, rules: [
		{ id: "o", judge: () => grant([D.relSet("a", "b", "misc", "x")], { reply: "开。" }) },
	] }),
	markHidden: defineVerb({ label: "记", description: "写隐藏指称", cost: 0, params: {}, rules: [
		{ id: "m", judge: () => grant([D.set("a", "marks", ["x"])], { reply: "记。" }) },
	] }),
};

const messages = { noResponse: "默。", invisibleEntity: "无此物。", timePassed: "光阴虚度" };

function mkDef(overrides: Partial<GameDef> = {}): GameDef {
	return {
		messages,
		props,
		relTypes,
		verbs,
		world: world(),
		prompt: { system: "测试" },
		name: (w, base) => (cell) => {
			if (cell.cell !== "vertex") return base(cell);
			const e = entity(w, cell.id);
			return e && typeof e.props.name === "string" ? e.props.name : base(cell);
		},
		...overrides,
	};
}

const violation = (code: "action.unknown" | "action.schema") => (e: unknown): boolean => e instanceof ProtocolViolation && e.code === code;

function play(def: GameDef, action: Action): { sim: Simulation; steps: Commit[] } {
	const sim = new Simulation(def);
	const res = sim.apply(action);
	return { sim, steps: [res.step, ...res.elapsed] };
}

test("守卫链：首个非 ⊥ 表态胜出；授予 law 缺省守卫 id，显式 law 覆盖", () => {
	{
		const { steps } = play(mkDef(), { verb: "chainG", params: {} });
		const step = steps[0]!;
		assert.equal(step.ok, true);
		if (!step.ok) return;
		assert.equal(step.rule, "yes");
		assert.equal(step.law, "yes");
		assert.equal(step.price, 2);
	}
	{
		const { steps } = play(mkDef(), { verb: "chainD", params: {} });
		const step = steps[0]!;
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.equal(step.rule, "no");
		assert.equal(lawOf(step.denial.point), "chain.no");
	}
	{
		const { steps } = play(mkDef(), { verb: "chainL", params: {} });
		const step = steps[0]!;
		assert.equal(step.ok && step.law, "外部法");
	}
});

test("闭合：全弃权 → closure，act 步仍入账，无守卫", () => {
	const { steps } = play(mkDef(), { verb: "quiet", params: {} });
	const step = steps[0]!;
	assert.equal(step.ok, false);
	if (step.ok) return;
	assert.equal(step.denial.point.kind, "closure");
	assert.equal(lawOf(step.denial.point), "action.unanswered");
	assert.equal(step.rule, undefined);
	assert.equal(step.trigger, "act");
});

test("指称门：不在可指称域即 gate，门文案回落词表，世界零扰动", () => {
	const def = mkDef({ perspective: () => ({ refers: (e) => e.id !== "c" }) });
	const sim = new Simulation(def);
	const { step } = sim.apply({ verb: "poke", params: { target: "c" } });
	assert.equal(step.ok, false);
	if (step.ok) return;
	assert.equal(step.denial.point.kind, "gate");
	assert.equal(lawOf(step.denial.point), "action.invisible");
	assert.equal(audienceOf(step.denial.point), "world");
	assert.equal(renderDenial(def, step.denial, "poke"), "无此物。");
	assert.deepEqual(sim.snapshot(), world());
});

test("世界腔文本：rule 否决缺 text 回落 noResponse，不泄漏 debug", () => {
	const def = mkDef();
	const { sim, steps } = play(def, { verb: "silent", params: {} });
	const step = steps[0]!;
	assert.equal(step.ok, false);
	if (step.ok) return;
	assert.equal(renderDenial(def, step.denial, "silent"), "默。");
	assert.deepEqual(sim.snapshot(), world());
});

test("引擎点：规则抛错 → engine 否决携 debug，整提交回滚且 act 仍入账", () => {
	const { sim, steps } = play(mkDef(), { verb: "boom", params: {} });
	const step = steps[0]!;
	assert.equal(step.ok, false);
	if (step.ok) return;
	assert.equal(step.denial.point.kind, "engine");
	assert.equal(audienceOf(step.denial.point), "engine");
	assert.ok((step.denial.text ?? "").includes("boom"));
	assert.deepEqual(sim.snapshot(), world());
});

test("非法表态：clock 携 reply / 携 price → engine 否决", () => {
	{
		const def = mkDef({ ticks: [{ id: "chatty", rules: [{ id: "c", judge: () => grant([], { reply: "不应有。" }) }] }] });
		const { steps } = play(def, { verb: "sleep", params: { n: 1 } });
		const tick = steps[1]!;
		assert.equal(tick.ok, false);
		if (tick.ok) return;
		assert.equal(tick.denial.point.kind, "engine");
		assert.ok((tick.denial.text ?? "").includes("不得答复"));
	}
	{
		const def = mkDef({ ticks: [{ id: "waiter", rules: [{ id: "w", judge: () => grant([], { price: 1 }) }] }] });
		const { steps } = play(def, { verb: "sleep", params: { n: 1 } });
		const tick = steps[1]!;
		assert.equal(tick.ok, false);
		if (tick.ok) return;
		assert.equal(tick.denial.point.kind, "engine");
		assert.ok((tick.denial.text ?? "").includes("不得延伸时间"));
		assert.equal(tick.price, 0);
	}
});

test("价：缺省 cost、授予/否决的 price 覆写同轴，泵按生效价推钟", () => {
	{
		const { sim, steps } = play(mkDef(), { verb: "chainG", params: {} });
		assert.equal(steps[0]!.price, 2);
		assert.equal(sim.world.time, 2);
	}
	{
		const { sim, steps } = play(mkDef(), { verb: "sleep", params: { n: 1 } });
		assert.equal(steps[0]!.price, 1);
		assert.equal(sim.world.time, 1);
	}
	{
		const { sim, steps } = play(mkDef(), { verb: "slow", params: {} });
		assert.equal(steps[0]!.price, 1);
		assert.equal(sim.world.time, 1);
	}
});

test("刻：同刻成块合并、前一条后果对后一条可见、静默刻聚合成 ×n", () => {
	const def = mkDef({ ticks: [
		{ id: "one", rules: [{ id: "1", judge: (q) => (q.world.time === 1 ? grant([D.set("a", "flag", true)], {}) : null) }] },
		{ id: "two", rules: [{ id: "2", judge: (q) => (q.world.time === 1 && entity(q.world, "a")?.props.flag === true ? grant([], { statements: ["见旗。"] }) : null) }] },
	] });
	const { sim, steps } = play(def, { verb: "sleep", params: { n: 2 } });
	assert.equal(steps.length, 3);
	assert.deepEqual(spineLines(sim, steps, sim.snapshot()), [
		"✓ 歇(2)：歇。",
		"⏱ (甲.旗: false → true)[见旗。]",
		"⏱ 光阴虚度 ×1",
	]);
	assert.equal(sim.world.time, 2);
});

test("刻：否决为失败刻，静默刻随之聚合", () => {
	const def = mkDef({ ticks: [{ id: "nay", rules: [{ id: "n", judge: (q) => (q.world.time % 2 === 0 ? deny("nay.refuse", "拒。") : null) }] }] });
	const { sim, steps } = play(def, { verb: "sleep", params: { n: 2 } });
	assert.deepEqual(spineLines(sim, steps, sim.snapshot()), [
		"✓ 歇(2)：歇。",
		"⏱ ✗ 拒。",
		"⏱ 光阴虚度 ×1",
	]);
});

test("骰子：地址由账本前缀决定——重启同值，重放后续接同值", () => {
	const def = mkDef();
	const reply = (step: Commit): string => (step.ok ? step.reply ?? "" : "");
	const a = new Simulation(def);
	const first = a.apply({ verb: "dice", params: {} }).step;
	const second = a.apply({ verb: "dice", params: {} }).step;
	const b = new Simulation(def);
	assert.equal(reply(b.apply({ verb: "dice", params: {} }).step), reply(first));
	const c = new Simulation(def);
	assert.equal(c.replayRecord({ seq: 1, time: 0, utterance: "", steps: [first] }), null);
	assert.equal(reply(c.apply({ verb: "dice", params: {} }).step), reply(second));
});

test("提交：后态已成立即跳过；同址多写后者覆盖；none 删除、缺席删除是空操作", () => {
	{
		const sim = new Simulation(mkDef());
		const one = sim.apply({ verb: "unset", params: { entity: "a", prop: "name" } }).step;
		assert.equal(one.ok && one.changes.length, 1);
		const two = sim.apply({ verb: "unset", params: { entity: "a", prop: "name" } }).step;
		assert.equal(two.ok && two.changes.length, 0);
		assert.equal(entity(sim.world, "a")?.props.name, undefined);
	}
	{
		const sim = new Simulation(mkDef());
		const step = sim.apply({ verb: "unset", params: { entity: "a", prop: "holder" } }).step;
		assert.equal(step.ok && step.changes.length, 0);
	}
	{
		const { sim, steps } = play(mkDef(), { verb: "twice", params: {} });
		const step = steps[0]!;
		assert.equal(step.ok && step.changes.length, 2);
		assert.equal(entity(sim.world, "a")?.props.name, "二");
	}
});

test("提交：重复 spawn 与缺世 despawn 是违约，拒绝而非覆盖", () => {
	const def = mkDef();
	{
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "dup", params: {} });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.equal(step.denial.point.kind, "engine");
		assert.ok((step.denial.text ?? "").includes("already exists"));
		assert.deepEqual(sim.snapshot(), world());
	}
	{
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "vanish", params: { id: "nope" } });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.ok((step.denial.text ?? "").includes("entity missing"));
		assert.deepEqual(sim.snapshot(), world());
	}
});

test("级联：despawn 删端点边、弱引用滤亡者、值空删格；强引用不受级联", () => {
	const { sim, steps } = play(mkDef(), { verb: "kill", params: { entity: "c" } });
	const step = steps[0]!;
	assert.equal(step.ok, true);
	if (!step.ok) return;
	assert.equal(entity(sim.world, "c"), undefined);
	const edge = step.changes.find((c) => c.cell === "edge" && c.type === "weak");
	assert.deepEqual(edge, { cell: "edge", from: "a", to: "c", type: "weak", prev: "c", next: null });
	assert.deepEqual(step.changes.find((c) => c.cell === "prop" && c.entity === "a" && c.prop === "marks"), {
		cell: "prop", entity: "a", prop: "marks", prev: ["b", "c"], next: ["b"],
	});
	assert.deepEqual(step.changes.find((c) => c.cell === "prop" && c.entity === "b" && c.prop === "linked"), {
		cell: "prop", entity: "b", prop: "linked", prev: ["c"], next: null,
	});
});

test("integrity：强引用悬空 → 整提交回滚", () => {
	const sim = new Simulation(mkDef());
	assert.equal(sim.apply({ verb: "tie", params: {} }).step.ok, true);
	const { step } = sim.apply({ verb: "kill", params: { entity: "c" } });
	assert.equal(step.ok, false);
	if (step.ok) return;
	assert.equal(step.denial.point.kind, "engine");
	assert.ok((step.denial.text ?? "").includes("missing entity"));
	assert.equal(entity(sim.world, "c")?.id, "c");
	assert.equal(entity(sim.world, "a")?.props.holder, "c");
});

test("槽契约：注册值域违约拒绝；未注册 token 为字面；空序列不是值", () => {
	const def = mkDef();
	{
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "badEdge", params: {} });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.ok((step.denial.text ?? "").includes("expects number"));
		assert.deepEqual(sim.snapshot(), world());
	}
	{
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "openEdge", params: {} });
		assert.equal(step.ok, true);
		assert.equal(sim.world.relations.find((r) => r.type === "misc")?.value, "x");
	}
	{
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "empty", params: {} });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.ok((step.denial.text ?? "").includes("not a non-empty value"));
	}
});

test("重放：逐变更应用并复位时间，不重裁决；prev 不符即断且回滚", () => {
	const def = mkDef();
	const source = new Simulation(def);
	const step = source.apply({ verb: "write", params: { entity: "a", text: "改" } }).step;
	const record = { seq: 1, time: 0, utterance: "u", steps: [step] };
	{
		const loaded = new Simulation(def);
		assert.equal(loaded.replayRecord(record), null);
		assert.equal(entity(loaded.world, "a")?.props.name, "改");
	}
	{
		const denied = new Simulation(def);
		const rec = { seq: 1, time: 1, utterance: "u", steps: [denied.apply({ verb: "slow", params: {} }).step] };
		const loaded = new Simulation(def);
		assert.equal(loaded.replayRecord(rec), null);
		assert.equal(loaded.world.time, 1);
		assert.deepEqual(loaded.snapshot().entities, world().entities);
	}
	{
		const dirty = new Simulation(def);
		dirty.apply({ verb: "write", params: { entity: "a", text: "乙" } });
		const reason = dirty.replayRecord(record);
		assert.ok((reason ?? "").includes("前值不符"));
		assert.equal(entity(dirty.world, "a")?.props.name, "乙");
	}
});

test("投影：尝试行取脸、改名派生、无名格不进变更行、H 闭合失败整行不渲染", () => {
	{
		const sim = new Simulation(mkDef());
		const { step } = sim.apply({ verb: "write", params: { entity: "a", text: "仲" } });
		assert.deepEqual(spineLines(sim, [step], sim.snapshot()), ["✓ 写(仲,仲)：写。(~ 甲 → 仲; 仲.名: 甲 → 仲)"]);
	}
	{
		const sim = new Simulation(mkDef());
		const { step } = sim.apply({ verb: "hide", params: {} });
		assert.deepEqual(spineLines(sim, [step], sim.snapshot()), ["✓ 藏：改。"]);
	}
	{
		const def = mkDef({ perspective: () => ({ sees: (cell) => !(cell.cell === "vertex" && cell.id === "x"), refers: (e) => e.id !== "x" }) });
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "markHidden", params: {} });
		assert.equal(step.ok && step.changes.length, 1);
		assert.deepEqual(spineLines(sim, [step], sim.snapshot()), ["✓ 记：记。"]);
	}
});

test("投影：view 基座——可见者出卡、可指称不可见者出句柄、关系过名字与 H 闭合", () => {
	const def = mkDef({ perspective: () => ({ sees: (cell) => !(cell.cell === "vertex" && cell.id === "x"), refers: () => true }) });
	const sim = new Simulation(def);
	interface CardFace { id: string; name: string; props: { name: string; value: unknown }[] }
	const view = sim.view() as unknown as { entities: CardFace[]; known?: { id: string; name: string }[]; relations: { from: string; to: string; name: string; value: unknown }[] };
	assert.deepEqual(view.entities.map((e) => e.id), ["a", "b", "c"]);
	assert.deepEqual(view.entities.find((e) => e.id === "a")?.props, [
		{ name: "名", value: "甲" },
		{ name: "记", value: ["b", "c"] },
		{ name: "旗", value: false },
	]);
	assert.deepEqual(view.entities.find((e) => e.id === "c")?.props, [
		{ name: "名", value: "丙" },
		{ name: "记", value: ["c"] },
	]);
	assert.deepEqual(view.known, [{ id: "x", name: "隐" }]);
	assert.deepEqual(view.relations, [
		{ from: "a", to: "b", name: "连", value: true },
		{ from: "a", to: "c", name: "weak", value: "c" },
	]);
});

test("审查：invariant 的两受众与文本；装载终点 admit 拒绝违约初始世界", () => {
	{
		const def = mkDef({ invariants: [{ id: "nul", check: (_w, ctx) => (ctx.proposal.kind === "rule" && ctx.changes.length > 0 ? { fault: "world", reply: "止。" } : null) }] });
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "write", params: { entity: "a", text: "改" } });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.equal(step.denial.point.kind, "invariant");
		assert.equal(lawOf(step.denial.point), "invariant.nul");
		assert.equal(renderDenial(def, step.denial, "write"), "止。");
		assert.deepEqual(sim.snapshot(), world());
	}
	{
		const def = mkDef({ invariants: [{ id: "bug", check: (_w, ctx) => (ctx.proposal.kind === "rule" ? { fault: "engine", debug: "崩" } : null) }] });
		const sim = new Simulation(def);
		const { step } = sim.apply({ verb: "chainG", params: {} });
		assert.equal(step.ok, false);
		if (step.ok) return;
		assert.equal(step.denial.point.kind, "invariant");
		assert.equal(audienceOf(step.denial.point), "engine");
		assert.equal(step.denial.text, "崩");
	}
	{
		const def = mkDef({ world: { ...world(), time: 1 }, invariants: [{ id: "time", check: (w) => (w.time > 0 ? { fault: "world", reply: "坏。" } : null) }] });
		assert.throws(() => new Simulation(def), /初始世界违反 invariant\.time/);
	}
});

test("协议：未知动词、schema 不符、空序列与标量代序列都抛调用方违约，世界零扰动", () => {
	const sim = new Simulation(mkDef());
	assert.throws(() => sim.apply({ verb: "nope", params: {} }), violation("action.unknown"));
	assert.throws(() => sim.apply({ verb: "poke", params: {} }), violation("action.schema"));
	assert.throws(() => sim.apply({ verb: "write", params: { entity: "a", text: 5 } }), violation("action.schema"));
	assert.throws(() => sim.apply({ verb: "pokeMany", params: { targets: [] } }), violation("action.schema"));
	assert.throws(() => sim.apply({ verb: "pokeMany", params: { targets: "a" } }), violation("action.schema"));
	assert.deepEqual(sim.snapshot(), world());
});

test("档案：链断与损坏行截断、旧文移存 orphan、续写从完好前缀接续", () => {
	const def = mkDef();
	const rec = { seq: 1, time: 0, utterance: "u", steps: [new Simulation(def).apply({ verb: "write", params: { entity: "a", text: "改" } }).step] };
	const dir = mkdtempSync(join(tmpdir(), "cave-test-"));
	const path = join(dir, "records.jsonl");
	writeFileSync(path, [JSON.stringify(rec), JSON.stringify({ ...rec, seq: 3 }), "{"].join("\n") + "\n");
	const store = openArchive(path);
	const loaded = store.load(def);
	assert.equal(loaded.lastSeq, 1);
	assert.equal(loaded.records.length, 1);
	assert.ok(loaded.warnings.some((w) => w.includes("形状损坏")));
	assert.ok(loaded.warnings.some((w) => w.includes("档案链断")));
	assert.equal(entity(loaded.sim.world, "a")?.props.name, "改");
	store.append({ seq: 2, time: 0, utterance: "", steps: [] });
	assert.ok(existsSync(`${path}.orphan`));
	assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
});
