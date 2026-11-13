import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { hash, type Segment, validateTranslation } from "./segments";

export interface Conditions {
    model: string;
    promptHash: string;
    glossaryHash: string;
}
export interface Unit extends Segment {
    translation?: string;
    status: "pending" | "translated" | "reviewed" | "needs-review" | "failed";
    manual?: boolean;
    active: boolean;
    conditions?: Conditions;
    translatedAt?: string;
    error?: string;
}
export interface Memory {
    schemaVersion: 1;
    pageId: string;
    sourceFile: string;
    sourceRevision: string;
    units: Unit[];
    requests: { at: string; model: string; modelVersion?: string; usage?: unknown }[];
}

export async function loadMemory(path: string): Promise<Memory | undefined> {
    try {
        const memory = JSON.parse(await readFile(path, "utf8"));
        if (memory.schemaVersion !== 1 || !Array.isArray(memory.units)
            || !Array.isArray(memory.requests)) throw new Error(`Invalid memory: ${path}`);
        const ids = new Set<string>();
        for (const unit of memory.units) {
            if (typeof unit.id !== "string" || typeof unit.source !== "string"
                || typeof unit.kind !== "string" || typeof unit.active !== "boolean"
                || unit.sourceHash !== hash(`${unit.kind}\n${unit.source}`)
                || ![ "pending", "translated", "reviewed", "needs-review", "failed" ]
                    .includes(unit.status)) throw new Error(`Invalid translation unit: ${path}`);
            if (ids.has(unit.id)) throw new Error(`Duplicate translation ID: ${unit.id}`);
            ids.add(unit.id);
            if (unit.translation !== undefined) validateTranslation(unit.source, unit.translation);
        }
        return memory;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function saveMemory(path: string, memory: Memory) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(memory, null, 2)  }\n`);
    await rename(temporary, path);
}

export function reconcile(
    previous: Memory | undefined, segments: Segment[],
    info: Pick<Memory, "pageId" | "sourceFile" | "sourceRevision">, conditions: Conditions
): Memory {
    if (previous && previous.pageId !== info.pageId) throw new Error("Memory page ID mismatch");
    const units = new Map((previous?.units ?? []).map((unit) => [ unit.id, {
        ...unit, active: false
    } ]));
    for (const segment of segments) {
        const old = units.get(segment.id);
        const unit: Unit = old?.sourceHash === segment.sourceHash
            ? { ...old, ...segment, active: true }
            : { ...segment, status: "pending", active: true };
        if (old?.status === "reviewed") unit.manual = true;
        if (unit.translation && (old?.contextHash !== segment.contextHash
            || unit.conditions?.model !== conditions.model
            || unit.conditions?.promptHash !== conditions.promptHash
            || unit.conditions?.glossaryHash !== conditions.glossaryHash)) {
            unit.status = "needs-review";
        }
        units.set(unit.id, unit);
    }
    return { schemaVersion: 1, ...info,
        units: [ ...units.values() ].filter((unit) => unit.active
            || unit.translation !== undefined),
        requests: previous?.requests ?? [] };
}

export function pendingUnits(memory: Memory, refresh = false) {
    return memory.units.filter((unit) => unit.active && !unit.manual
        && unit.status !== "reviewed" && (!unit.translation || (refresh
            && [ "needs-review", "failed" ].includes(unit.status))));
}

export function usableTranslations(memory: Memory) {
    return new Map(memory.units.filter((unit) => unit.active && unit.translation !== undefined)
        .map((unit) => [ unit.id, unit.translation! ]));
}
