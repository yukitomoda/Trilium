import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { FinishReason, GenerateContentResponse } from "@google/genai";

import { createBatchService, parseBatchResponse } from "./gemini";
import { extractPage, validateTranslation } from "./segments";
import { restoreTextSlots, slotContext, TEXT_SLOT_FORMAT, textSlotPrompt, textSlots } from "./text-slots";

void test("text slots reconstruct protected structure locally and reject malformed or injected values", () => {
    const source = "Enable __TRILIUM_PH_0__Network access__TRILIUM_PH_1__ in __TRILIUM_PH_2__.";
    const original = textSlots(source);
    assert.equal(restoreTextSlots(source, original), source);
    assert.equal(restoreTextSlots("Open __TRILIUM_PH_0__", { t0: "", t2: "を開きます。" }).trim(),
        "__TRILIUM_PH_0__を開きます。");
    const values = { t6: "。", t4: " を設定ファイルで有効にします：", t2: "ネットワークアクセス", t0: "次の設定：" };
    const result = restoreTextSlots(source, values);
    validateTranslation(source, result);
    assert.deepEqual(result.match(/__TRILIUM_PH_\d+__/g), source.match(/__TRILIUM_PH_\d+__/g));
    assert.ok(!slotContext(source).includes("__TRILIUM_PH_"));
    for (const invalid of [ "text", [], null, {}, { ...values, unexpected: "追加" },
        { ...values, t0: null }, { ...values, t0: "__TRILIUM_PH_99__" },
        Object.fromEntries(Object.keys(values).map((key) => [ key, "" ])) ]) {
        assert.throws(() => restoreTextSlots(source, invalid), /Invalid structured translation slots/);
    }
    assert.equal(restoreTextSlots(source, { ...values, t0: "" }).startsWith(" __TRILIUM_PH_0__"), true);
});

void test("SDK sends a fixed nested schema with no protected tokens and restored links/code stay intact", async () => {
    const root = resolve(__dirname, "../../../..");
    const prompt = await readFile(`${root}/i18n/prompts/translate-ja.txt`, "utf8");
    assert.ok(!textSlotPrompt(prompt).includes("__TRILIUM_PH_"));
    const document = extractPage(`<html><body><div id="translation-body"><p>Enable
        <a href="/settings">Network access</a> in <code>settings.json</code>.</p></div></body></html>`, "Guide");
    try {
        const unit = document.segments.find((unit) => unit.kind === "p")!;
        const request = { key: "slot-request", pageId: "one", units: [ unit ], format: TEXT_SLOT_FORMAT };
        let calls = 0;
        const service = createBatchService({ apiKey: "secret", model: "gemini-3.5-flash-lite", prompt,
            glossary: {}, fetch: async (_url, init) => {
                calls++;
                const wire = JSON.parse(init!.body as string).batch.inputConfig.requests.requests[0].request;
                assert.ok(!JSON.stringify(wire).includes("__TRILIUM_PH_"));
                const input = JSON.parse(wire.contents[0].parts[0].text);
                assert.deepEqual(input.units[0].spans, textSlots(unit.source));
                const schema = wire.generationConfig.responseSchema.properties.translations.properties[unit.id];
                assert.equal(schema.type, "OBJECT");
                assert.deepEqual(schema.required, Object.keys(textSlots(unit.source)));
                assert.ok(Object.values(schema.properties).every((value: unknown) =>
                    (value as { type: string }).type === "STRING"));
                return Response.json({ name: "batches/slots", metadata: { state: "BATCH_STATE_PENDING" } });
            } });
        await service.create([ request ], "test");
        assert.equal(calls, 1);
        const values = Object.fromEntries(Object.entries(textSlots(unit.source)).map(([ key, value ]) =>
            [ key, value.replace("Network access", "ネットワークアクセス").replace("Enable", "有効にする") ]));
        const response = new GenerateContentResponse();
        response.candidates = [ { finishReason: FinishReason.STOP, content: { parts: [ {
            text: JSON.stringify({ requestKey: request.key, translations: { [unit.id]: values } })
        } ] } } ];
        const result = parseBatchResponse(response, [ request ]);
        const output = document.apply(new Map(Object.entries(result.translations))).html;
        assert.match(output, /href="\/settings"/);
        assert.match(output, /<code>settings.json<\/code>/);
        assert.match(output, /ネットワークアクセス/);
        assert.deepEqual(result.unitErrors, {});
    } finally { await document.close(); }
});
