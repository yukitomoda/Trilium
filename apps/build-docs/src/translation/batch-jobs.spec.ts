import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FinishReason, GenerateContentResponse, JobState } from "@google/genai";

import { loadJobs, runBatchTranslation, type TranslationPage } from "./batch-jobs";
import { type BatchRequest, type BatchService,createBatchService } from "./gemini";
import { loadMemory, reconcile } from "./memory";
import { extractPage } from "./segments";

const conditions = { model: "gemini-3.5-flash-lite", promptHash: "p", glossaryHash: "g" };
async function page(root: string, id: string): Promise<TranslationPage> {
    const document = extractPage(`<html><body><div id="translation-body">
        <p>Hello ${id}</p></div></body></html>`, `Guide ${id}`);
    try {
        return { path: join(root, `${id}.json`), memory: reconcile(undefined, document.segments,
            { pageId: id, sourceFile: `${id}.md`, sourceRevision: "revision" }, conditions) };
    } finally { await document.close(); }
}
function response(request: BatchRequest) {
    const result = new GenerateContentResponse();
    result.candidates = [ { finishReason: FinishReason.STOP, content: { parts: [ {
        text: JSON.stringify({ requestKey: request.key, translations: request.units.map((unit) => ({
            id: unit.id, translation: unit.source.replace("Hello", "こんにちは")
        })) })
    } ] } } ];
    result.usageMetadata = { totalTokenCount: 10 };
    result.modelVersion = "actual-model";
    return result;
}

void test("Batch jobs survive restarts and collect reordered results", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-batch-"));
    try {
        const pages = [ await page(root, "one"), await page(root, "two") ];
        let creates = 0;
        let checkpoints = 0;
        let gets = 0;
        let finished = false;
        let requests: BatchRequest[] = [];
        const service: BatchService = {
            async create(input) {
                assert.equal(checkpoints, 1, "Checkpoint must precede submission");
                creates++;
                requests = input;
                return { name: "batches/job", state: JobState.JOB_STATE_PENDING };
            },
            async get(name) {
                assert.equal(name, "batches/job");
                gets++;
                return { name, state: finished
                    ? JobState.JOB_STATE_SUCCEEDED : JobState.JOB_STATE_RUNNING,
                ...(finished ? { dest: { inlinedResponses: [ ...requests ].reverse()
                    .map((request) => ({
                        response: response(request)
                    })) } } : {}) };
            }
        };
        const options = { directory: join(root, "jobs"), conditions, service,
            submit: true, limit: 100, refresh: false,
            checkpoint: async () => { checkpoints++; } };
        assert.equal((await runBatchTranslation(pages, options)).submitted, 4);
        assert.equal((await loadJobs(options.directory))[0].name, "batches/job");
        assert.equal((await runBatchTranslation(pages, options)).submitted, 0);
        assert.equal(creates, 1);
        finished = true;
        const protectedUnit = pages[0].memory.units.find((unit) => unit.kind === "title")!;
        protectedUnit.translation = "人手修正";
        protectedUnit.status = "reviewed";
        const result = await runBatchTranslation(pages, { ...options, submit: false });
        assert.equal(result.pending, 0);
        assert.equal(protectedUnit.translation, "人手修正");
        assert.equal((await loadMemory(pages[1].path))!.units.find((unit) => unit.kind === "p")!
            .translation, "こんにちは two");
        const count = pages[1].memory.requests.length;
        await runBatchTranslation(pages, { ...options, submit: false });
        assert.equal(pages[1].memory.requests.length, count);
        assert.equal(gets, 2);
        assert.equal(creates, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("uncertain batch creation is not retried on another invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-uncertain-"));
    try {
        let creates = 0;
        const options = { directory: join(root, "jobs"), conditions,
            submit: true, limit: 20, refresh: false,
            service: { async create() { creates++; throw new Error("Network outcome unknown"); },
                async get() { throw new Error("No job name"); } } };
        const pages = [ await page(root, "one") ];
        await assert.rejects(() => runBatchTranslation(pages, options), /unknown/);
        await assert.rejects(() => runBatchTranslation(pages, options), /submission uncertain/);
        assert.equal(creates, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("partial failure preserves valid translations and rejects stale contexts", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-partial-"));
    try {
        const pages = [ await page(root, "one"), await page(root, "two") ];
        let requests: BatchRequest[] = [];
        const options = { directory: join(root, "jobs"), conditions,
            submit: true, limit: 20, refresh: false,
            service: { async create(input: BatchRequest[]) {
                requests = input;
                return { name: "batches/job", state: JobState.JOB_STATE_PENDING };
            }, async get() {
                return { name: "batches/job", state: JobState.JOB_STATE_SUCCEEDED,
                    dest: { inlinedResponses: [
                        { response: response(requests[0]) },
                        { metadata: { key: requests[1].key }, error: { code: 400 } }
                    ] } };
            } } };
        await runBatchTranslation(pages, options);
        pages[0].memory.units[0].contextHash = "changed-while-running";
        const result = await runBatchTranslation(pages, { ...options, submit: false });
        assert.equal(result.failed, true);
        assert.equal(pages[0].memory.units[0].translation, undefined);
        assert.equal(pages[0].memory.units[1].translation, "こんにちは one");
        assert.ok(pages[1].memory.units.every((unit) => !unit.translation));
        const repeated = await runBatchTranslation(pages, { ...options, submit: false });
        assert.equal(repeated.failed, false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("SDK uses batch endpoints and never retries create", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-sdk-batch-"));
    const old = process.env.GOOGLE_GENAI_USE_ENTERPRISE;
    process.env.GOOGLE_GENAI_USE_ENTERPRISE = "true";
    try {
        const memory = (await page(root, "one")).memory;
        const request = { key: "request-one", pageId: "one", units: memory.units };
        let calls = 0;
        const service = createBatchService({ apiKey: "secret", ...conditions,
            prompt: "Translate", glossary: {}, fetch: async (url, init) => {
                calls++;
                assert.equal(new URL(String(url)).hostname, "generativelanguage.googleapis.com");
                assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "secret");
                if (init?.method === "POST") {
                    assert.ok(String(url).endsWith(":batchGenerateContent"));
                    const body = JSON.parse(init.body as string);
                    const wire = body.batch.inputConfig.requests.requests[0];
                    assert.equal(wire.metadata.key, "request-one");
                    assert.equal(wire.request.generationConfig.responseMimeType,
                        "application/json");
                    assert.equal(wire.request.generationConfig.responseJsonSchema
                        .properties.requestKey.enum[0], "request-one");
                    return Response.json({ name: "batches/job",
                        metadata: { state: "BATCH_STATE_PENDING" } });
                }
                return Response.json({ name: "batches/job", metadata: {
                    state: "BATCH_STATE_SUCCEEDED", output: { inlinedResponses: {
                        inlinedResponses: [ { response: response(request) } ]
                    } }
                } });
            } });
        assert.equal((await service.create([ request ], "display")).name, "batches/job");
        assert.equal((await service.get("batches/job")).dest!.inlinedResponses!.length, 1);
        assert.equal(calls, 2);
        let failures = 0;
        const failing = createBatchService({ apiKey: "secret", ...conditions,
            prompt: "Translate", glossary: {}, fetch: async () => {
                failures++;
                return Response.json({ error: { message: "secret", code: 429 } }, { status: 429 });
            } });
        await assert.rejects(() => failing.create([ request ], "display"),
            (error: Error) => error.message.includes("429") && !error.message.includes("secret"));
        assert.equal(failures, 1);
    } finally {
        if (old === undefined) delete process.env.GOOGLE_GENAI_USE_ENTERPRISE;
        else process.env.GOOGLE_GENAI_USE_ENTERPRISE = old;
        await rm(root, { recursive: true, force: true });
    }
});

void test("completed invalid results can be diagnosed and re-fetched without submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-recheck-"));
    try {
        const pages = [ await page(root, "one") ];
        let requests: BatchRequest[] = [];
        let creates = 0;
        let gets = 0;
        let valid = false;
        const options = { directory: join(root, "jobs"), conditions,
            submit: true, limit: 20, refresh: false,
            service: { async create(input: BatchRequest[]) {
                creates++;
                requests = input;
                return { name: "batches/existing", state: JobState.JOB_STATE_PENDING };
            }, async get() {
                gets++;
                const result = response(requests[0]);
                if (!valid) result.candidates![0].content!.parts![0].text = "invalid JSON";
                return { name: "batches/existing", state: JobState.JOB_STATE_SUCCEEDED,
                    dest: { inlinedResponses: [ { metadata: { key: requests[0].key },
                        response: result } ] } };
            } } };
        await runBatchTranslation(pages, options);
        const collection = { ...options, submit: false };
        assert.equal((await runBatchTranslation(pages, collection)).failed, true);
        let saved = (await loadJobs(options.directory))[0];
        assert.equal(saved.diagnostics![0].reason, "Invalid batch response JSON");
        assert.equal(saved.diagnostics![0].requestKey, requests[0].key);
        assert.equal(saved.phase, "complete");
        await runBatchTranslation(pages, collection);
        assert.equal(gets, 1, "Normal collection leaves completed jobs alone");
        valid = true;
        const recovered = await runBatchTranslation(pages,
            { ...collection, recheckCompleted: true });
        assert.equal(recovered.failed, false);
        assert.equal(recovered.received, 1);
        saved = (await loadJobs(options.directory))[0];
        assert.equal(saved.error, undefined);
        assert.equal(saved.requests[0].error, undefined);
        assert.deepEqual(saved.diagnostics, []);
        assert.equal(pages[0].memory.units[1].translation, "こんにちは one");
        assert.equal(creates, 1, "Recovery must never submit a replacement batch");
        assert.equal(gets, 2);
        await assert.rejects(() => runBatchTranslation(pages,
            { ...options, recheckCompleted: true }), /requires collect mode/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
