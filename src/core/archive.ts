import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Simulation, deepFreeze, denialReasonText, isCommit, lawOf, type ChronicleEntry, type Commit, type GameDef } from "./sim.ts";

export interface LoadedArchive {
	sim: Simulation;
	records: ChronicleEntry[];
	lastSeq: number;
	warnings: string[];
}

/** 回合记录档案：单一追加日志，条目只有回合；装载即重放（不重裁决、不掷骰）。截断以重写落地，旧全文移存 `<path>.orphan`。 */
export interface ArchiveStore {
	load(def: GameDef): LoadedArchive;
	append(record: ChronicleEntry): void;
}

/** 档案行：形状损坏计为 broken（装载与工具共用同一判据）。 */
export type ArchiveLine = { kind: "record"; record: ChronicleEntry } | { kind: "broken" };

/** 单行解析：空行即 null（不计入）。 */
export function parseRecordLine(raw: string): ArchiveLine | null {
	const line = raw.trim();
	if (line === "") return null;
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		return { kind: "broken" };
	}
	const r = v !== null && typeof v === "object" ? (v as { seq?: unknown; time?: unknown; utterance?: unknown; steps?: unknown }) : {};
	if (Number.isInteger(r.seq) && (r.seq as number) >= 1 && typeof r.time === "number" && typeof r.utterance === "string" && Array.isArray(r.steps) && r.steps.every(isCommit)) {
		return { kind: "record", record: deepFreeze({ seq: r.seq as number, time: r.time as number, utterance: r.utterance as string, steps: r.steps as Commit[] }) };
	}
	return { kind: "broken" };
}

export function parseRecordLines(text: string): ArchiveLine[] {
	const out: ArchiveLine[] = [];
	for (const raw of text.split("\n")) {
		const parsed = parseRecordLine(raw);
		if (parsed !== null) out.push(parsed);
	}
	return out;
}

/** 档案全读：缺席即 null；坏行计数与记录一并返回，装载与诊断共用同一读法。 */
export function readRecords(path: string): { records: ChronicleEntry[]; broken: number } | null {
	if (!existsSync(path)) return null;
	const records: ChronicleEntry[] = [];
	let broken = 0;
	for (const line of parseRecordLines(readFileSync(path, "utf8"))) {
		if (line.kind === "broken") broken += 1;
		else records.push(line.record);
	}
	return { records, broken };
}

function writeRecords(path: string, records: readonly ChronicleEntry[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
	renameSync(tmp, path);
}

/** 截断只改内存；续写前才重写档案（装载保持只读）。旧全文原样移存 `.orphan`，不再进入装载。 */
export function openArchive(path: string): ArchiveStore {
	let expected = 1;
	let repair: ChronicleEntry[] | null = null;
	return {
		load(def) {
			const warnings: string[] = [];
			const read = readRecords(path) ?? { records: [], broken: 0 };
			if (read.broken) warnings.push(`回合条目 ${read.broken} 条形状损坏`);
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
			repair = truncated ? records : null;
			expected = lastSeq + 1;
			if (truncated) warnings.push(`档案截断：续写从 seq${lastSeq} 另起（旧尾部不再进入装载）`);
			const denied = sim.admit();
			if (denied) throw new Error(`装载拒绝：当前世界违反 ${lawOf(denied.point)}（${denialReasonText(denied)}）`);
			return { sim, records, lastSeq, warnings };
		},
		append(record) {
			if (record.seq !== expected) throw new Error(`档案追加序位不接续：期望 seq${expected}，得到 seq${record.seq}`);
			if (repair) {
				if (existsSync(path)) copyFileSync(path, `${path}.orphan`);
				writeRecords(path, repair);
				repair = null;
			}
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
			expected = record.seq + 1;
		},
	};
}
