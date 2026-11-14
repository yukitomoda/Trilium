import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BatchJob } from "@google/genai";

import { type BatchRequest, type BatchService, parseBatchResponse, TranslationIdError } from "./gemini";
import { type Conditions, type Memory, pendingUnits, saveMemory } from "./memory";
import { hash, validateTranslation } from "./segments";

interface SavedRequest extends BatchRequest {
    result?: { translations: Record<string, string>; modelVersion?: string; usage?: unknown };
    error?: string;
}
export interface SavedJob {
    schemaVersion: 1;
    id: string;
    name?: string;
    state?: string;
    phase: "submitting" | "pending" | "complete" | "failed" | "uncertain";
    createdAt: string;
    conditions: Conditions;
    requests: SavedRequest[];
    error?: string;
    rejectedResponses?: { responseIndex: number; text: string; finishReason?: string }[];
    diagnostics?: { responseIndex: number; requestKey?: string; reason: string;
        idMismatch?: TranslationIdError["details"] }[];
}
export interface TranslationPage { path: string; memory: Memory }

export async function loadJobs(directory: string): Promise<SavedJob[]> {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
        const job = JSON.parse(await readFile(join(directory, name), "utf8"));
        if (job.schemaVersion !== 1 || !Array.isArray(job.requests)
            || job.id !== name.slice(0, -5) || !job.conditions) {
            throw new Error(`Invalid batch journal: ${name}`);
        }
        return job as SavedJob;
    }));
}
export async function saveJob(directory: string, job: SavedJob) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${job.id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)  }\n`);
    await rename(temporary, path);
}
const sameConditions = (left: Conditions, right: Conditions) => left.model === right.model
    && left.promptHash === right.promptHash && left.glossaryHash === right.glossaryHash;

/** Replay is idempotent, so cached results also survive a PR that has not been merged yet. */
export function replayResults(pages: TranslationPage[], jobs: SavedJob[], conditions: Conditions) {
    for (const job of jobs) {
        if (!sameConditions(job.conditions, conditions)) continue;
        for (const request of job.requests) {
            if (!request.result) continue;
            const page = pages.find((page) => page.memory.pageId === request.pageId);
            if (!page) continue;
            let applied = false;
            for (const saved of request.units) {
                const unit = page.memory.units.find((unit) => unit.id === saved.id);
                if (!unit?.active || unit.manual || unit.status === "reviewed"
                    || unit.sourceHash !== saved.sourceHash
                    || unit.contextHash !== saved.contextHash) {
                    continue;
                }
                const translation = request.result.translations[unit.id];
                validateTranslation(unit.source, translation);
                unit.translation = translation;
                unit.status = "translated";
                unit.conditions = job.conditions;
                unit.translatedAt = job.createdAt;
                delete unit.error;
                applied = true;
            }
            if (applied && !page.memory.requests.some((entry) => entry.batchJob === job.name
                && entry.requestKey === request.key)) {
                page.memory.requests.push({ at: job.createdAt, model: job.conditions.model,
                    batchJob: job.name, requestKey: request.key,
                    modelVersion: request.result.modelVersion, usage: request.result.usage });
            }
        }
    }
}

export function reservedUnits(jobs: SavedJob[], conditions: Conditions) {
    return new Set(jobs.filter((job) => [ "pending", "submitting", "uncertain" ].includes(job.phase)
        && sameConditions(job.conditions, conditions)).flatMap((job) => job.requests.flatMap(
        (request) => request.units.map((unit) => `${request.pageId}:${unit.id}:${unit.contextHash}`)
    )));
}

async function receive(directory: string, job: SavedJob, remote: BatchJob) {
    job.state = remote.state;
    if ([ "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED" ]
        .includes(remote.state ?? "")) {
        job.phase = "failed";
        job.error = `Batch ended: ${remote.state}`;
    } else if ([ "JOB_STATE_SUCCEEDED", "JOB_STATE_PARTIALLY_SUCCEEDED" ]
        .includes(remote.state ?? "")) {
        const responses = remote.dest?.inlinedResponses;
        if (!responses) {
            throw new Error("Batch result is not inline; keep journal for investigation");
        }
        delete job.error;
        job.diagnostics = [];
        job.rejectedResponses = [];
        for (const request of job.requests) delete request.error;
        const seen = new Set<string>();
        for (let index = 0; index < responses.length; index++) {
            const item = responses[index];
            if (item.error || !item.response) {
                const request = job.requests.find((request) => request.key === item.metadata?.key)
                    ?? job.requests[index];
                if (request) request.error = "Batch request failed or returned no response";
                continue;
            }
            try {
                // The response's requestKey, not array order, determines its destination.
                const result = parseBatchResponse(item.response, job.requests);
                if (seen.has(result.key)) throw new Error("Duplicate batch response key");
                seen.add(result.key);
                job.requests.find((request) => request.key === result.key)!.result = result;
            } catch (error) {
                // Preserve only generated documentation, never HTTP headers or SDK errors.
                const candidate = item.response.candidates?.[0];
                job.rejectedResponses.push({ responseIndex: index,
                    text: candidate?.content?.parts?.filter((part) => !part.thought)
                        .map((part) => part.text ?? "").join("") ?? "",
                    finishReason: candidate?.finishReason });
                // Only our fixed validation messages are persisted; never SDK/model text.
                const allowed = [ "Incomplete Gemini batch response", "Invalid batch response JSON",
                    "Unexpected batch request key or translation count",
                    "Unexpected or duplicate translation ID", "Empty or invalid translation",
                    "Translation changed protected placeholders", "Duplicate batch response key" ];
                const reason = error instanceof Error && allowed.includes(error.message)
                    ? error.message : "Malformed batch response structure";
                const requestKey = error instanceof TranslationIdError ? error.requestKey
                    : job.requests.find((request) => request.key === item.metadata?.key)?.key;
                const idMismatch = error instanceof TranslationIdError ? error.details : undefined;
                job.diagnostics.push({ responseIndex: index, requestKey, reason, idMismatch });
                console.error(`Batch ${job.name}, response ${index}: ${reason}`);
                if (idMismatch) console.error(JSON.stringify({ requestKey, ...idMismatch }));
                // Do not guess the destination of malformed/reordered responses.
                job.error = "Some batch responses were invalid; valid responses were retained";
            }
        }
        for (const request of job.requests) {
            if (!request.result && !request.error) {
                request.error = "Missing or invalid batch response";
            }
        }
        job.phase = "complete";
    } else job.phase = "pending";
    await saveJob(directory, job);
}

export async function runBatchTranslation(pages: TranslationPage[], options: {
    directory: string; conditions: Conditions; service: BatchService;
    submit: boolean; limit: number; pageId?: string; refresh: boolean;
    checkpoint?: () => Promise<void>;
    recheckCompleted?: boolean;
}) {
    if (options.recheckCompleted && options.submit) {
        throw new Error("Rechecking completed batches requires collect mode");
    }
    const jobs = await loadJobs(options.directory);
    const observed: SavedJob[] = [];
    for (const job of jobs) {
        if ((job.phase === "submitting" || job.phase === "uncertain") && !job.name) {
            throw new Error(`Batch submission uncertain: ${job.id}; recover the job name`);
        }
        const recheck = options.recheckCompleted && job.phase === "complete"
            && job.requests.some((request) => !request.result);
        if (([ "pending", "submitting", "uncertain" ].includes(job.phase) || recheck)
            && job.name) {
            await receive(options.directory, job, await options.service.get(job.name));
            observed.push(job);
            await options.checkpoint?.();
        }
    }
    replayResults(pages, jobs, options.conditions);
    const reserved = reservedUnits(jobs, options.conditions);
    const requests: SavedRequest[] = [];
    let remaining = options.limit;
    if (options.submit) for (const page of pages) {
        if (options.pageId && options.pageId !== page.memory.pageId) continue;
        const units = pendingUnits(page.memory, options.refresh).filter((unit) => !reserved.has(
            `${page.memory.pageId}:${unit.id}:${unit.contextHash}`)).slice(0, remaining);
        remaining -= units.length;
        for (let offset = 0; offset < units.length;) {
            const chunk = [];
            let size = 0;
            while (offset < units.length && chunk.length < 16) {
                const unit = units[offset];
                if (chunk.length && size + unit.source.length > 10000) break;
                chunk.push({ id: unit.id, kind: unit.kind, source: unit.source,
                    sourceHash: unit.sourceHash, context: unit.context,
                    contextHash: unit.contextHash });
                size += unit.source.length;
                offset++;
            }
            const key = `${page.memory.pageId}_${hash(JSON.stringify(chunk)).slice(0, 16)}`;
            requests.push({ key,
                pageId: page.memory.pageId, units: chunk });
        }
    }
    // Save collected results before another network operation can fail.
    for (const page of pages) await saveMemory(page.path, page.memory);
    if (requests.length) {
        const job: SavedJob = { schemaVersion: 1, id: randomUUID(), phase: "submitting",
            createdAt: new Date().toISOString(), conditions: options.conditions, requests };
        // A durable intent prevents silent retries if create's outcome is unknown.
        await saveJob(options.directory, job);
        await options.checkpoint?.();
        try {
            const remote = await options.service.create(requests, `trilium-ja-${job.id}`);
            if (!remote.name) throw new Error("Batch create returned no job name");
            job.name = remote.name;
            await receive(options.directory, job, remote);
            jobs.push(job);
            observed.push(job);
            await options.checkpoint?.();
        } catch (error) {
            const rejected = error instanceof Error
                && /HTTP 4\d\d$|Inline batch exceeds/.test(error.message)
                && !/HTTP (408|429)$/.test(error.message);
            job.phase = job.name ? "pending" : rejected ? "failed" : "uncertain";
            job.error = error instanceof Error ? error.message : "Batch submission failed";
            await saveJob(options.directory, job);
            throw error;
        }
        replayResults(pages, [ job ], options.conditions);
        for (const page of pages) await saveMemory(page.path, page.memory);
    }
    return { submitted: requests.reduce((sum, request) => sum + request.units.length, 0),
        pending: jobs.filter((job) => job.phase === "pending").length,
        received: observed.reduce((sum, job) => sum
            + job.requests.filter((request) => request.result).length, 0),
        failed: observed.some((job) => job.phase === "failed"
            || job.requests.some((r) => r.error)) };
}
