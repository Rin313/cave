import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import { Engine } from "../core/engine.ts";
import type { GameConfig } from "../core/types.ts";
import { listGameIds, loadGame } from "../games/index.ts";

if (process.platform === "win32") {
	try {
		execSync("chcp 65001", { stdio: "ignore" });
	} catch {
		/* noop */
	}
}

type Binding =
	| { kind: "intent"; intent: string }
	| { kind: "render"; instruction: string };

const DEFAULT_BINDINGS: Record<string, Binding> = {
	t: { kind: "intent", intent: "take" },
	d: { kind: "intent", intent: "detach" },
	o: { kind: "intent", intent: "open" },
	f: { kind: "intent", intent: "light" },
	m: { kind: "intent", intent: "move" },
	c: { kind: "intent", intent: "combine" },
	l: { kind: "render", instruction: "请用文学笔触重新描写当前场景。" },
	i: { kind: "render", instruction: "描述你随身携带的所有物品。" },
};

function argValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function pickGame(): Promise<GameConfig> {
	const id = argValue("--game") ?? process.env.CAVE_GAME;
	if (id) return loadGame(id);
	const ids = await listGameIds();
	if (ids.length === 1) return loadGame(ids[0]);
	throw new Error(`未指定游戏（--game <id> 或 CAVE_GAME）。可用游戏: ${ids.join(", ")}`);
}

const config = await pickGame();
const bindings: Record<string, Binding> = { ...DEFAULT_BINDINGS };

const engine = await Engine.create(config, {
	provider: process.env.CAVE_PROVIDER,
	model: process.env.CAVE_MODEL,
	thinkingLevel: process.env.CAVE_THINKING,
});

engine.subscribe((event) => {
	if (event.type === "text_delta") process.stdout.write(event.delta);
});

const rl = createInterface({ input, output });

const pipedInput: string[] = [];
if (!input.isTTY) {
	for await (const line of rl) pipedInput.push(line.trim());
	rl.close();
}

async function ask(prompt: string): Promise<string> {
	if (input.isTTY) {
		return (await rl.question(prompt)).trim();
	}
	return pipedInput.shift() ?? "quit";
}

let selection: string | undefined;

function printKeymap(): void {
	console.log("快捷键绑定（bind <键> intent|render <...> 可重绑）：");
	for (const [key, b] of Object.entries(bindings)) {
		const target = b.kind === "intent" ? `意图 ${b.intent}` : `渲染：${b.instruction}`;
		console.log(`  ${key} → ${target}`);
	}
}

function printUsage(): void {
	console.log(`\
交互模式：
  模式1  选中任意文本 → 按快捷键   select <文本片段> 后按快捷键（如 t/d/o/f/m/c）
  模式2  直接按快捷键（无选中）     l（环顾）/ i（随身物品）
命令：
  select <文本>     选中任意文本片段（任意长，含关键实体即可）
  bind <键> intent <意图标签>   重绑为意图操作
  bind <键> render <指令>       重绑为纯文本渲染
  !sel  查看当前选中   !keys  查看绑定   !help  帮助
  !state  查看状态机   !entities  查看可见实体
  quit    退出`);
}

console.log(`\n=== ${config.title} ===`);
await engine.render("请用文学笔触描写当前场景。");
console.log("\n");
printUsage();
console.log("");

while (true) {
	const line = await ask("> ");
	const cmd = line.trim();
	if (cmd === "quit" || cmd === "exit") break;
	if (cmd === "!state") {
		console.log(engine.sim.serialize());
		continue;
	}
	if (cmd === "!entities") {
		console.log(engine.sim.visibleEntityIds().join(", "));
		continue;
	}
	if (cmd === "!sel") {
		console.log(selection ? `已选中：「${selection}」` : "(无选中)");
		continue;
	}
	if (cmd === "!keys") {
		printKeymap();
		continue;
	}
	if (cmd === "!help") {
		printUsage();
		continue;
	}
	if (cmd.startsWith("select ")) {
		selection = cmd.slice("select ".length);
		console.log(`已选中：「${selection}」`);
		continue;
	}
	if (cmd.startsWith("bind ")) {
		const rest = cmd.slice("bind ".length).trim();
		const key = rest.split(/\s+/)[0];
		const target = rest.slice(key.length).trim();
		if (target.startsWith("intent ")) {
			bindings[key] = { kind: "intent", intent: target.slice("intent ".length).trim() };
			console.log(`已绑定 ${key} → 意图 ${bindings[key].intent}`);
		} else if (target.startsWith("render ")) {
			bindings[key] = { kind: "render", instruction: target.slice("render ".length).trim() };
			console.log(`已绑定 ${key} → 渲染指令`);
		} else {
			console.log("用法: bind <键> intent <意图标签> | bind <键> render <指令>");
		}
		continue;
	}
	const binding = bindings[cmd];
	if (!binding) {
		console.log(`未知快捷键/命令：${cmd}（!keys 查看绑定，!help 帮助）`);
		continue;
	}
	if (binding.kind === "intent") {
		if (!selection && (engine.sim.intent(binding.intent)?.arity ?? 0) !== 0) {
			console.log("提示：未选中文本。模式1请先 select <文本>；未选中的话这次操作很可能被拒绝。");
		}
		await engine.act({ intent: binding.intent, selection });
	} else {
		await engine.render(binding.instruction);
	}
	console.log("\n");
}

rl.close();
engine.dispose();
