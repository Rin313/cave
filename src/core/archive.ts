import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { deepFreeze, isChronicleEntry, type ChronicleEntry } from "./sim.ts";

export interface ArchiveStore {
	readonly records: readonly ChronicleEntry[];
	append(record: ChronicleEntry): void;
}

export function readRecords(path: string): ChronicleEntry[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	if (lines.pop() !== "") throw new Error(`档案 ${path} 未以换行收尾（追加中断或文件损坏）`);
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
	const records = readRecords(path);
	return {
		records,
		append(record) {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
			records.push(record);
		},
	};
}
