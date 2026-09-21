import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { deepFreeze, isChronicleEntry, type ChronicleEntry } from "./sim.ts";

/** 回合档案：单一追加日志，每回合一行（回合与表达同条目）。装载即全量校验：任一损坏（坏行、半行、形状不符）即抛，不跳过、不改写。 */
export interface ArchiveStore {
	readonly records: readonly ChronicleEntry[];
	append(record: ChronicleEntry): void;
}

/** 全量读取：空档案之外，文本须由换行收尾的合法记录行构成；任一偏差即抛，修复归人工。 */
function readRecords(path: string): ChronicleEntry[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	if (text === "") return [];
	if (!text.endsWith("\n")) throw new Error(`档案 ${path} 第 ${text.split("\n").length} 行未收尾（追加中断或文件损坏）`);
	const lines = text.split("\n");
	lines.pop();
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
