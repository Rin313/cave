// 研究辅助：跑一个 loop act 并打印精简结果（toolCalls 的动词/proof、kind、拒绝理由、表达校验、叙述）。
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const intent = args[0] ?? "";
const run = args[1] ?? "ember1";

const r = spawnSync("node", ["src/tools/loop.ts", "act", intent, "--run", run, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const out = JSON.parse(String(r.stdout));

console.log(`INTENT: ${out.intent}`);
console.log(`KIND: ${out.kind}  REFUSAL: ${out.refusal?.label ?? "-"}`);
for (const tc of out.toolCalls ?? []) {
	const actions = (tc.actions ?? []).map((a: { verb?: string; params?: unknown; proof?: unknown }) => {
		const head: { verb?: string; params?: unknown; proof?: unknown } = { verb: a.verb, params: a.params };
		if (a.proof) head.proof = (a.proof as { desired?: unknown; claims?: unknown }).desired;
		return head;
	});
	console.log(`  CALL(${tc.actionCount}): ${JSON.stringify(actions)}`);
}
for (const res of out.results ?? []) {
	console.log(`  RESULT: ok=${res.ok} reason="${res.reason}" src=${res.src} deniedBy=${res.deniedBy}`);
}
if (out.validations?.length) console.log(`  VALIDATIONS: ${JSON.stringify(out.validations)}`);
console.log(`NARRATION: ${out.narration ?? ""}\n`);
