import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { deepFreeze, isChronicleEntry, type ChronicleEntry } from "./sim.ts";

export interface ArchiveStore {
	/** open 时的全量快照；append 只写文件，不回填本数组。 */
	readonly records: readonly ChronicleEntry[];
	append(record: ChronicleEntry): void;
}

/** 空档案之外，文本须由换行收尾的合法记录行构成 */
export function readRecords(path: string): ChronicleEntry[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	if (text === "") return [];
	const lines = text.split("\n");
	const tail = lines.pop()!;
	if (tail !== "") throw new Error(`档案 ${path} 第 ${lines.length + 1} 行未收尾（追加中断或文件损坏）`);
	const records: ChronicleEntry[] = [];
	for (const [i, raw] of lines.entries()) {
		let v: unknown;
		try {
			v = JSON.parse(raw);
		} catch {
			throw new Error(`档案 ${path} 第 ${i + 1} 行不是合法 JSON`);
		}
		if (!isChronicleEntry(v)) throw new Error(`档案 ${path} 第 ${i + 1} 行不是回合记录`);
		records.push(deepFreeze(v));
	}
	return records;
}

export function openArchive(path: string): ArchiveStore {
	return {
		records: readRecords(path),
		append(record) {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		},
	};
}
