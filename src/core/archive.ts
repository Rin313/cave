import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deepFreeze, isCommit, type ChronicleEntry, type Commit } from "./sim.ts";

export interface ArchiveSnapshot {
	records: ChronicleEntry[];
	broken: number;
	incomplete: boolean;
}

/** 回合档案：单一追加日志，每回合一行（回合与表达同条目）。`read` 是纯读；`keep` 声明装载存活前缀（截断与半行的修复延迟到首次 `append`：旧全文原样移存 `<path>.orphan`）。 */
export interface ArchiveStore {
	read(): ArchiveSnapshot;
	keep(records: readonly ChronicleEntry[]): void;
	append(record: ChronicleEntry): void;
}

/** 档案行：回合（含可选表达）或坏行。 */
type ArchiveLine =
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

/** 档案全读：缺席即空档案（新运行）；坏行只计数，末尾无换行即不完整。 */
function readRecords(path: string): ArchiveSnapshot {
	if (!existsSync(path)) return { records: [], broken: 0, incomplete: false };
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

/** 装载保持只读：`read` 取快照，`keep` 记存活前缀；截断与半行只在续写前重写落地（旧全文原样移存 `.orphan`，不再进入装载）。 */
export function openArchive(path: string): ArchiveStore {
	let parsed: ArchiveSnapshot | null = null;
	let repair: readonly ChronicleEntry[] | null = null;
	const appendLine = (value: unknown): void => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
	};
	return {
		read() {
			parsed = readRecords(path);
			return parsed;
		},
		keep(records) {
			if (parsed === null) throw new Error("keep 须在 read 之后调用");
			const snapshot = parsed;
			const intact = records.length === snapshot.records.length && records.every((r, i) => r === snapshot.records[i]);
			repair = intact && !snapshot.incomplete ? null : [...records];
		},
		append(record) {
			if (repair !== null) {
				if (existsSync(path)) copyFileSync(path, `${path}.orphan`);
				writeRecords(path, repair);
				repair = null;
			}
			appendLine(record);
		},
	};
}
