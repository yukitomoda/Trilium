import assert from "node:assert/strict";
import { test } from "node:test";

import type { SavedJob } from "./batch-jobs";
import type { Memory, Unit } from "./memory";
import { statusMarkdown, translationStatus } from "./status";

const conditions = { model: "model", promptHash: "prompt", glossaryHash: "glossary" };
const unit = (id: string): Unit => ({ id, kind: "p", source: "English", sourceHash: id,
    context: "Guide", contextHash: "context", active: true, status: "pending" });
function job(id: string, units: Unit[], phase: SavedJob["phase"]): SavedJob {
    return { schemaVersion: 1, id, name: `batches/${id}`, phase, conditions,
        createdAt: `2026-11-${id === "old" ? "14" : "15"}T00:00:00Z`, requests: [ {
            key: id, pageId: "guide", units: units.map((u) => ({ ...u })),
            ...(phase === "complete" || phase === "failed" ? { error: "Some translation units failed validation",
                unitErrors: Object.fromEntries(units.map((u) => [ u.id, "Translation changed protected placeholders" ])) } : {})
        } ] };
}
function page(units: Unit[]) {
    const memory: Memory = { schemaVersion: 1, pageId: "guide", sourceFile: "guide.md",
        sourceRevision: "rev", units, requests: [] };
    return { title: "Guide | <script>![x](url)", memory };
}

void test("status deduplicates retries and separates unresolved failure from waiting and success", () => {
    const units = [ "done", "failed", "waiting", "unknown", "available", "new" ].map(unit);
    units[0].translation = "訳文";
    units[0].status = "needs-review";
    const old = job("old", units.slice(0, 5), "complete");
    const retry = job("retry", [ units[2] ], "pending");
    const unknown = job("unknown", [ units[3] ], "uncertain");
    const cached = job("cached", [ units[4] ], "complete");
    cached.requests[0].result = { translations: { available: "保存済み" } };
    const incompatible = job("different", [ units[5] ], "failed");
    incompatible.conditions = { ...conditions, promptHash: "outdated" };
    const status = translationStatus([ page(units) ], [ old, retry, unknown, cached, incompatible ], conditions);
    assert.deepEqual(status.totals, { total: 6, translated: 1, needsReview: 1,
        available: 1, pending: 1, uncertain: 1, failed: 1, untracked: 1 });
    assert.equal(status.failedUnits[0].unitId, "failed");
    assert.equal(Object.values(status.reasons)[0], 1);
    assert.equal(status.pages[0].failed, 1);
    const markdown = statusMarkdown(status, [ "old" ]);
    assert.match(markdown, /今回確認したバッチ/);
    assert.match(markdown, /失敗して未翻訳 \| 1/);
    assert.match(markdown, /保護マーカー/);
    assert.ok(!markdown.includes("<script>"));
    assert.ok(!markdown.includes("![x]"));
    assert.ok(markdown.includes("&#124;"));
});

void test("status excludes inactive and changed units, and shows request-level failure precisely", () => {
    const units = [ unit("a"), unit("b"), unit("c") ];
    units[2].active = false;
    const failed = job("failed", units, "failed");
    failed.requests[0].result = { translations: { a: "正常" } };
    delete failed.requests[0].unitErrors;
    const status = translationStatus([ page(units) ], [ failed ], conditions);
    assert.equal(status.totals.total, 2);
    assert.equal(status.totals.available, 1);
    assert.equal(status.totals.failed, 1);
    assert.equal(status.batches[0].succeeded, 1);
    assert.equal(status.batches[0].failed, 2);
    assert.match(statusMarkdown(status), /今回の取得件数ではありません/);
    units[1].contextHash = "changed";
    assert.equal(translationStatus([ page(units) ], [ failed ], conditions).totals.failed, 0);
    const submitting = job("submitting", [ units[0] ], "submitting");
    delete submitting.name;
    assert.equal(translationStatus([ page(units) ], [ submitting ], conditions).totals.uncertain, 1);
});
