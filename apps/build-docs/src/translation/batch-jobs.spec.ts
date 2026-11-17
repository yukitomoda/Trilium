import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FinishReason, GenerateContentResponse, JobState } from "@google/genai";

import { loadJobs, runBatchTranslation, saveJob, type TranslationPage } from "./batch-jobs";
import { type BatchRequest, type BatchService,createBatchService, parseBatchResponse, TranslationIdError } from "./gemini";
import { loadMemory, reconcile } from "./memory";
import { extractPage } from "./segments";
import { TEXT_SLOT_FORMAT, textSlots } from "./text-slots";

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
            id: unit.id, translation: request.format === TEXT_SLOT_FORMAT
                ? Object.fromEntries(Object.entries(textSlots(unit.source))
                    .map(([ id, text ]) => [ id, text.replace("Hello", "こんにちは") ]))
                : unit.source.replace("Hello", "こんにちは")
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

void test("Submit-only defers result collection even when creation returns a completed job", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-submit-only-"));
    try {
        const pages = [ await page(root, "one") ];
        let creates = 0;
        let gets = 0;
        let requests: BatchRequest[] = [];
        const completedBatch = () => ({ name: "batches/job", state: JobState.JOB_STATE_SUCCEEDED,
            dest: { inlinedResponses: requests.map((request) => ({ response: response(request) })) } });
        const service: BatchService = {
            async create(input) {
                creates++;
                requests = input;
                return completedBatch();
            },
            async get() {
                gets++;
                return completedBatch();
            }
        };
        const options = { directory: join(root, "jobs"), conditions, service,
            submit: true, submitOnly: true, limit: 20, refresh: false };
        assert.equal((await runBatchTranslation(pages, options)).pending, 1);
        assert.equal((await runBatchTranslation(pages, options)).submitted, 0);
        assert.equal(creates, 1);
        assert.equal(gets, 0);
        assert.equal(await loadMemory(pages[0].path), undefined);

        const collected = await runBatchTranslation(pages, { ...options, submit: false, submitOnly: false });
        assert.equal(collected.received, 1);
        assert.equal(collected.pending, 0);
        assert.equal(creates, 1);
        assert.equal(gets, 1);
        assert.equal((await loadMemory(pages[0].path))!.units.find((unit) => unit.kind === "p")!
            .translation, "こんにちは one");
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
                    assert.equal(wire.request.generationConfig.responseSchema
                        .properties.requestKey.enum[0], "request-one");
                    assert.deepEqual(wire.request.generationConfig.responseSchema
                        .properties.translations.required, request.units.map((unit) => unit.id));
                    const schema = wire.request.generationConfig.responseSchema
                        .properties.translations;
                    assert.equal(schema.type, "OBJECT");
                    assert.equal(wire.request.generationConfig.responseJsonSchema, undefined);
                    assert.deepEqual(wire.request.systemInstruction.parts, [ { text: "Translate" } ]);
                    const input = JSON.parse(wire.request.contents[0].parts[0].text);
                    assert.deepEqual(input.units.map((u: { id: string }) => u.id),
                        request.units.map((u) => u.id));
                    assert.deepEqual(Object.keys(schema.properties), request.units.map((u) => u.id));
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
        assert.equal(saved.rejectedResponses![0].text, "invalid JSON");
        assert.equal(saved.rejectedResponses![0].finishReason, "STOP");
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
        assert.deepEqual(saved.rejectedResponses, []);
        assert.equal(pages[0].memory.units[1].translation, "こんにちは one");
        assert.equal(creates, 1, "Recovery must never submit a replacement batch");
        assert.equal(gets, 2);
        await assert.rejects(() => runBatchTranslation(pages,
            { ...options, recheckCompleted: true }), /requires collect mode/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("translation ID diagnostics distinguish duplicates from unknown IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-id-diagnostics-"));
    try {
        const request = { key: "one", pageId: "one", units: (await page(root, "one")).memory.units };
        const data = response(request);
        const content = JSON.parse(data.candidates![0].content!.parts![0].text!);
        content.translations[1].id = content.translations[0].id;
        data.candidates![0].content!.parts![0].text = JSON.stringify(content);
        assert.throws(() => parseBatchResponse(data, [ request ]), (error: unknown) => {
            assert.ok(error instanceof TranslationIdError);
            assert.deepEqual(error.details.duplicatePositions, [ 1 ]);
            assert.deepEqual(error.details.unknownPositions, []);
            assert.deepEqual(error.details.missingIds, [ request.units[1].id ]);
            return true;
        });
        content.translations[1].id = "untrusted model text";
        data.candidates![0].content!.parts![0].text = JSON.stringify(content);
        assert.throws(() => parseBatchResponse(data, [ request ]), (error: unknown) => {
            assert.ok(error instanceof TranslationIdError);
            assert.deepEqual(error.details.unknownPositions, [ 1 ]);
            assert.deepEqual(error.details.duplicatePositions, []);
            assert.equal(error.details.receivedIds[1], null);
            assert.ok(!JSON.stringify(error.details).includes("untrusted model text"));
            return true;
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("keyed translations ignore order and reject unlabelled string arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-keyed-"));
    try {
        const request = { key: "one", pageId: "one", units: (await page(root, "one")).memory.units };
        const data = response(request);
        const keyed = Object.fromEntries([ ...request.units ].reverse()
            .map((unit) => [ unit.id, unit.source.replace("Hello", "こんにちは") ]));
        data.candidates![0].content!.parts![0].text = JSON.stringify({
            requestKey: request.key, translations: keyed });
        const parsed = parseBatchResponse(data, [ request ]);
        assert.equal(parsed.translations[request.units[1].id], "こんにちは one");
        data.candidates![0].content!.parts![0].text = JSON.stringify({
            requestKey: request.key, translations: Object.values(keyed) });
        assert.throws(() => parseBatchResponse(data, [ request ]), TranslationIdError);
        delete keyed[request.units[0].id];
        data.candidates![0].content!.parts![0].text = JSON.stringify({
            requestKey: request.key, translations: keyed });
        assert.throws(() => parseBatchResponse(data, [ request ]), /translation count/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("a broken unit does not discard valid siblings and only that unit is retried", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-partial-units-"));
    try {
        const pages = [ await page(root, "one") ];
        let requests: BatchRequest[] = [];
        let creates = 0;
        let gets = 0;
        const options = { directory: join(root, "jobs"), conditions,
            submit: true, limit: 20, refresh: false,
            service: { async create(input: BatchRequest[]) {
                creates++; requests = input;
                return { name: `batches/job-${creates}`, state: JobState.JOB_STATE_PENDING };
            }, async get() {
                gets++;
                const result = response(requests[0]);
                const payload = JSON.parse(result.candidates![0].content!.parts![0].text!);
                payload.translations[1].translation.t0 += "__TRILIUM_PH_99__";
                result.candidates![0].content!.parts![0].text = JSON.stringify(payload);
                return { name: "batches/job-1", state: JobState.JOB_STATE_SUCCEEDED,
                    dest: { inlinedResponses: [ { response: result } ] } };
            } } };
        await runBatchTranslation(pages, options);
        const collected = await runBatchTranslation(pages, { ...options, submit: false });
        assert.equal(collected.failed, true);
        assert.equal(collected.received, 1);
        assert.equal(pages[0].memory.units[0].translation, "Guide one");
        assert.equal(pages[0].memory.units[1].translation, undefined);
        const saved = (await loadJobs(options.directory))[0];
        assert.equal(Object.keys(saved.requests[0].result!.translations).length, 1);
        assert.equal(saved.requests[0].unitErrors![pages[0].memory.units[1].id],
            "Invalid structured translation slots");
        assert.equal(saved.rejectedResponses!.length, 1);
        const retry = await runBatchTranslation(pages, options);
        assert.equal(retry.submitted, 1);
        assert.deepEqual(requests[0].units.map((unit) => unit.id), [ pages[0].memory.units[1].id ]);
        assert.equal(creates, 2);
        assert.equal(gets, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("archived rejected output recovers valid units offline and preserves human edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-offline-recover-"));
    try {
        const pages = [ await page(root, "one") ];
        const request = { key: "old-request", pageId: "one", units: pages[0].memory.units };
        const result = response(request);
        const payload = JSON.parse(result.candidates![0].content!.parts![0].text!);
        payload.translations[0].translation += "__TRILIUM_PH_99__";
        const directory = join(root, "jobs");
        await saveJob(directory, { schemaVersion: 1, id: "archived", name: "batches/old",
            createdAt: "2026-11-14T00:00:00Z", conditions, phase: "complete",
            requests: [ { ...request, error: "Missing or invalid batch response" } ],
            rejectedResponses: [ { responseIndex: 0, finishReason: "STOP",
                text: JSON.stringify(payload) } ] });
        pages[0].memory.units[0].translation = "人手修正";
        pages[0].memory.units[0].status = "reviewed";
        const options = { directory, conditions, submit: false, limit: 20, refresh: false,
            service: { async create() { throw new Error("Must not submit"); },
                async get() { throw new Error("Must not fetch"); } } };
        const recovered = await runBatchTranslation(pages, options);
        assert.equal(recovered.received, 1);
        assert.equal(recovered.failed, true);
        assert.equal(pages[0].memory.units[1].translation, "こんにちは one");
        assert.equal(pages[0].memory.units[0].translation, "人手修正");
        const count = pages[0].memory.requests.length;
        const repeated = await runBatchTranslation(pages, options);
        assert.equal(repeated.received, 0);
        assert.equal(repeated.failed, false);
        assert.equal(pages[0].memory.requests.length, count);
        assert.equal(Object.keys((await loadJobs(directory))[0].requests[0].result!.translations).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("pending legacy batches collect without conversion or resubmission", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-legacy-pending-"));
    try {
        const pages = [ await page(root, "one") ];
        const request = { key: "legacy-request", pageId: "one", units: pages[0].memory.units };
        const directory = join(root, "jobs");
        await saveJob(directory, { schemaVersion: 1, id: "legacy", name: "batches/legacy",
            createdAt: "2026-11-14T00:00:00Z", conditions, phase: "pending", requests: [ request ] });
        const result = await runBatchTranslation(pages, { directory, conditions, submit: true,
            limit: 20, refresh: false, service: {
                async create() { throw new Error("Must not resubmit legacy units"); },
                async get() { return { name: "batches/legacy", state: JobState.JOB_STATE_SUCCEEDED,
                    dest: { inlinedResponses: [ { response: response(request) } ] } }; }
            } });
        assert.equal(result.submitted, 0);
        assert.equal(result.failed, false);
        assert.equal(pages[0].memory.units[1].translation, "こんにちは one");
    } finally { await rm(root, { recursive: true, force: true }); }
});

void test("new requests persist the text-slot protocol and bound schema complexity", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-slot-limit-"));
    const links = Array.from({ length: 30 }, (_, i) => ` before <a href="/p${i}">label${i}</a> after`).join("");
    const document = extractPage(`<html><body><div id="translation-body">${
        Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i}${links}</p>`).join("")
    }</div></body></html>`, "Guide");
    try {
        const memory = reconcile(undefined, document.segments,
            { pageId: "one", sourceFile: "one.md", sourceRevision: "rev" }, conditions);
        const directory = join(root, "jobs");
        await runBatchTranslation([ { path: join(root, "one.json"), memory } ], {
            directory, conditions, submit: true, limit: 20, refresh: false,
            service: { async create(requests) {
                assert.ok(requests.length > 1);
                assert.equal(requests.flatMap((r) => r.units).length, memory.units.length);
                for (const request of requests) {
                    assert.equal(request.format, TEXT_SLOT_FORMAT);
                    assert.ok(request.units.reduce((n, u) => n + Object.keys(textSlots(u.source)).length, 0) <= 96);
                }
                return { name: "batches/slots", state: JobState.JOB_STATE_PENDING };
            }, async get() { throw new Error("Not expected"); } }
        });
        assert.ok((await loadJobs(directory))[0].requests.every((r) => r.format === TEXT_SLOT_FORMAT));
    } finally {
        await document.close();
        await rm(root, { recursive: true, force: true });
    }
});
