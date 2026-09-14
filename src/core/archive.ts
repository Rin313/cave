import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Simulation, deepFreeze, denialReasonText, isCommit, lawOf, type ChronicleEntry, type Commit, type GameDef } from "./sim.ts";

export interface LoadedArchive {
	sim: Simulation;
	records: ChronicleEntry[];
	/** 回合的表达，seq 即回合；缺席即该回合无表达。 */
	narrations: ReadonlyMap<number, string>;
	lastSeq: number;
	warnings: string[];
}

/** 回合档案：单一追加日志，条目是回合与其表达；装载即重放（不重裁决、不掷骰），表达不进重放。截断以重写落地为存活回合（表达随旧全文移存 `<path>.orphan`）。 */
export interface ArchiveStore {
	load(def: GameDef): LoadedArchive;
	append(record: ChronicleEntry): void;
	/** 表达是可有可无的追加写：不在回合之后或落盘失败即弃，由调用点降级。 */
	appendExpression(seq: number, narration: string): void;
}

/** 档案行：回合（证据）、表达（紧随其回合、可有可无）或坏行。 */
export type ArchiveLine =
	| { kind: "record"; record: ChronicleEntry }
	| { kind: "narration"; seq: number; narration: string }
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
	const seq = r.seq;
	if (!Number.isInteger(seq) || (seq as number) < 1) return { kind: "broken" };
	if (typeof r.time === "number" && typeof r.utterance === "string" && Array.isArray(r.steps) && r.steps.every(isCommit)) {
		return { kind: "record", record: deepFreeze({ seq: seq as number, time: r.time, utterance: r.utterance as string, steps: r.steps as Commit[] }) };
	}
	if (typeof r.narration === "string" && r.narration !== "") return { kind: "narration", seq: seq as number, narration: r.narration };
	return { kind: "broken" };
}

/** 档案全读：缺席即 null；坏行、末尾半行与回合一并返回，装载与诊断共用同一读法。 */
export function readRecords(path: string): { records: ChronicleEntry[]; narrations: { seq: number; narration: string }[]; broken: number; incomplete: boolean } | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const records: ChronicleEntry[] = [];
	const narrations: { seq: number; narration: string }[] = [];
	let broken = 0;
	for (const raw of text.split("\n")) {
		const line = parseArchiveLine(raw);
		if (line === null) continue;
		if (line.kind === "record") records.push(line.record);
		else if (line.kind === "narration") narrations.push({ seq: line.seq, narration: line.narration });
		else broken += 1;
	}
	return { records, narrations, broken, incomplete: text !== "" && !text.endsWith("\n") };
}

function writeRecords(path: string, records: readonly ChronicleEntry[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
	renameSync(tmp, path);
}

/** 截断与半行只改内存；续写前才重写档案（装载保持只读）。旧全文原样移存 `.orphan`，不再进入装载。 */
export function openArchive(path: string): ArchiveStore {
	let expected = 1;
	let repair: ChronicleEntry[] | null = null;
	const appendLine = (value: unknown): void => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
	};
	return {
		load(def) {
			const warnings: string[] = [];
			const read = readRecords(path) ?? { records: [], narrations: [], broken: 0, incomplete: false };
			if (read.broken) warnings.push(`档案条目 ${read.broken} 条形状损坏`);
			if (read.incomplete) warnings.push("档案末尾不完整（无换行）：截断至最后完整条目");
			const sim = new Simulation(def);
			const records: ChronicleEntry[] = [];
			let lastSeq = 0;
			let truncated = false;
			for (const record of read.records) {
				if (truncated) continue;
				if (record.seq !== lastSeq + 1) {
					warnings.push(`档案链断于 seq${lastSeq + 1}（得到 seq${record.seq}）：世界与近况同界截断`);
					truncated = true;
					continue;
				}
				const reason = sim.replayRecord(record);
				if (reason) {
					warnings.push(`档案链断（${reason}）：世界与近况同界截断`);
					truncated = true;
					continue;
				}
				records.push(record);
				lastSeq = record.seq;
			}
			const narrations = new Map<number, string>();
			for (const n of read.narrations) if (n.seq <= lastSeq) narrations.set(n.seq, n.narration);
			repair = truncated || read.incomplete ? records : null;
			expected = lastSeq + 1;
			if (truncated) warnings.push(`档案截断：续写从 seq${lastSeq} 另起（旧尾部不再进入装载）`);
			const denied = sim.admit();
			if (denied) throw new Error(`装载拒绝：当前世界违反 ${lawOf(denied.point)}（${denialReasonText(denied)}）`);
			return { sim, records, narrations, lastSeq, warnings };
		},
		append(record) {
			if (record.seq !== expected) throw new Error(`档案追加序位不接续：期望 seq${expected}，得到 seq${record.seq}`);
			if (repair) {
				if (existsSync(path)) copyFileSync(path, `${path}.orphan`);
				writeRecords(path, repair);
				repair = null;
			}
			appendLine(record);
			expected = record.seq + 1;
		},
		appendExpression(seq, narration) {
			if (repair) throw new Error("档案待重写：表达不落盘");
			if (seq !== expected - 1) throw new Error(`表达须紧随其回合：期望 seq${expected - 1}，得到 seq${seq}`);
			try {
				appendLine({ seq, narration });
			} catch (e) {
				// 半行即弃，但先收尾，防与下一条回合拼行
				try { appendFileSync(path, "\n", "utf8"); } catch {}
				throw e;
			}
		},
	};
}
