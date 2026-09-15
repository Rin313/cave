import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Simulation, deepFreeze, denialReasonText, isCommit, lawOf, type ChronicleEntry, type Commit, type GameDef } from "./sim.ts";

export interface LoadedArchive {
	sim: Simulation;
	records: ChronicleEntry[];
	warnings: string[];
}

/** 回合档案：单一追加日志，每回合一行（回合与表达同条目）；回合在表达落定后一次追加，装载即重放（不重裁决、不掷骰），表达不进重放。崩溃或落盘失败只可能伤末尾半行（装载截断并在续写前重写修复），已落前缀不被触碰；截断以重写落地为存活回合前缀（表达随其回合保留，旧全文移存 `<path>.orphan`）。 */
export interface ArchiveStore {
	load(def: GameDef): LoadedArchive;
	append(record: ChronicleEntry): void;
}

/** 档案行：回合（含可选表达）或坏行。 */
export type ArchiveLine =
	| { kind: "record"; record: ChronicleEntry }
	| { kind: "broken" };

function parseArchiveLine(raw: string): ArchiveLine | null {
	const text = raw.trim();
	if (text === "") return null;
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return { kind: "broken" };
	}
	if (v === null || typeof v !== "object") return { kind: "broken" };
	const r = v as Record<string, unknown>;
	if (typeof r.time !== "number" || typeof r.utterance !== "string" || !Array.isArray(r.steps) || !r.steps.every(isCommit)) return { kind: "broken" };
	const narration = typeof r.narration === "string" && r.narration !== "" ? r.narration : undefined;
	return { kind: "record", record: deepFreeze({ time: r.time, utterance: r.utterance as string, steps: r.steps as Commit[], ...(narration !== undefined && { narration }) }) };
}

/** 档案全读：缺席即 null；坏行、末尾半行、回合（表达随记录）一并返回，装载与诊断共用同一读法。 */
export function readRecords(path: string): { records: ChronicleEntry[]; broken: number; incomplete: boolean } | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const records: ChronicleEntry[] = [];
	let broken = 0;
	for (const raw of text.split("\n")) {
		const line = parseArchiveLine(raw);
		if (line === null) continue;
		if (line.kind === "record") records.push(line.record);
		else broken += 1;
	}
	return { records, broken, incomplete: text !== "" && !text.endsWith("\n") };
}

/** 整档替换：临时文件 + rename，中途失败或崩溃不改原档。 */
function replaceFile(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, path);
}

function writeRecords(path: string, records: readonly ChronicleEntry[]): void {
	replaceFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** 截断与半行只改内存；续写前才重写档案（装载保持只读）。旧全文原样移存 `.orphan`，不再进入装载。 */
export function openArchive(path: string): ArchiveStore {
	let repair: ChronicleEntry[] | null = null;
	const appendLine = (value: unknown): void => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
	};
	return {
		load(def) {
			const warnings: string[] = [];
			const read = readRecords(path) ?? { records: [], broken: 0, incomplete: false };
			if (read.broken) warnings.push(`档案条目 ${read.broken} 条形状损坏`);
			if (read.incomplete) warnings.push("档案末尾不完整（无换行）：截断至最后完整条目");
			const sim = new Simulation(def);
			const records: ChronicleEntry[] = [];
			let truncated = false;
			for (let i = 0; i < read.records.length; i++) {
				const record = read.records[i]!;
				const reason = sim.replayRecord(record);
				if (reason) {
					warnings.push(`档案记录不可应用（第 ${i + 1} 条：${reason}）：世界与近况同界截断`);
					truncated = true;
					break;
				}
				records.push(record);
			}
			repair = truncated || read.incomplete ? records : null;
			if (truncated) warnings.push(`档案截断：续写自第 ${records.length + 1} 回合起（旧尾部不再进入装载）`);
			const denied = sim.admit();
			if (denied) throw new Error(`装载拒绝：当前世界违反 ${lawOf(denied.point)}（${denialReasonText(denied)}）`);
			return { sim, records, warnings };
		},
		append(record) {
			if (repair) {
				if (existsSync(path)) copyFileSync(path, `${path}.orphan`);
				writeRecords(path, repair);
				repair = null;
			}
			appendLine(record);
		},
	};
}
