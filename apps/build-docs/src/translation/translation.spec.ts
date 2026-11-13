import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadMemory, pendingUnits, reconcile, saveMemory, usableTranslations } from "./memory";
import { extractPage } from "./segments";

const conditions = { model: "gemini-3.5-flash-lite", promptHash: "p1", glossaryHash: "g1" };
const info = { pageId: "page", sourceFile: "docs/page.md", sourceRevision: "revision" };
const html = (body: string) => `<!doctype html><html lang="ja"><head><title>Guide</title></head>
<body><template id="translation-original">English original</template>
<div id="translation-body">${body}</div></body></html>`;

void test("prose translation preserves HTML, URLs, code and original heading IDs", async () => {
    const document = extractPage(html('<h2 id="setup">Setup</h2><p>Read <a href="/guide?q=1#x">'
        + "this guide</a> and <code>npm run start</code>.</p><pre>const code = 1;</pre>"
        + '<p><img src="image.png" alt="A screenshot"></p>'), "Guide");
    try {
        const paragraph = document.segments.find((unit) => unit.kind === "p")!;
        assert.ok(paragraph.source.includes("__TRILIUM_PH_"));
        assert.ok(!paragraph.source.includes("npm run start"));
        assert.equal(document.segments.filter((unit) => unit.kind === "p").length, 1);
        const translations = new Map(document.segments.map((unit) => [ unit.id,
            unit.source.replace("Read ", "読む ").replace("this guide", "このガイド")
                .replace(" and ", " と ").replace("Setup", "設定")
                .replace("A screenshot", "スクリーンショット") ]));
        const result = document.apply(translations);
        assert.match(result.html, /id="setup">設定/);
        assert.match(result.html, /href="\/guide\?q=1#x">このガイド/);
        assert.match(result.html, /<code>npm run start<\/code>/);
        assert.match(result.html, /<pre>const code = 1;<\/pre>/);
        assert.match(result.html, /alt="スクリーンショット"/);
        assert.match(result.html, /<title>Guide<\/title>/);
        assert.match(result.html, /English original/);
    } finally { await document.close(); }
});

void test("untrusted model HTML is escaped and missing placeholders are rejected", async () => {
    const document = extractPage(html("<p>Hello <b>world</b></p>"), "Guide");
    try {
        const unit = document.segments.find((unit) => unit.kind === "p")!;
        assert.throws(() => document.apply(new Map([ [ unit.id, "tokens removed" ] ])),
            /placeholders/);
        const result = document.apply(new Map([ [ unit.id,
            unit.source.replace("Hello", "<script>alert(1)</script>") ] ]));
        assert.match(result.html, /&lt;script&gt;/);
        assert.ok(!result.html.includes("<script>alert(1)</script>"));
    } finally { await document.close(); }
});

void test("unchanged segments survive insertions, changes translate only new units", async () => {
    const before = extractPage(html(
        "<h2>Setup</h2><p>First paragraph</p><p>Second paragraph</p>"
    ), "Guide");
    const after = extractPage(html("<h2>Setup</h2><p>Inserted paragraph</p><p>First paragraph</p>"
        + "<p>Changed second paragraph</p>"), "Guide");
    try {
        const memory = reconcile(undefined, before.segments, info, conditions);
        for (const unit of memory.units) {
            unit.translation = unit.source;
            unit.status = "translated";
            unit.conditions = conditions;
        }
        const next = reconcile(memory, after.segments, info, conditions);
        assert.equal(pendingUnits(next).length, 2);
        assert.equal(usableTranslations(next).size, 3);
        assert.equal(next.units.filter((unit) => !unit.active).length, 1);
        assert.equal(memory.units.find((unit) => unit.source === "First paragraph")!.id,
            next.units.find((unit) => unit.source === "First paragraph")!.id);
    } finally { await before.close(); await after.close(); }
});

void test("reviewed translations remain protected after condition changes", async () => {
    const document = extractPage(html("<p>Hello</p>"), "Guide");
    try {
        const memory = reconcile(undefined, document.segments, info, conditions);
        for (const unit of memory.units) {
            unit.translation = "人手修正";
            unit.status = "reviewed";
            unit.conditions = conditions;
        }
        const changed = reconcile(memory, document.segments, info,
            { ...conditions, promptHash: "p2" });
        assert.equal(pendingUnits(changed, true).length, 0);
        assert.ok(changed.units.every((unit) => unit.translation === "人手修正"));
    } finally { await document.close(); }
});

void test("memory persists atomically and can resume after failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trilium-memory-"));
    const document = extractPage(html("<p>Hello</p>"), "Guide");
    try {
        const path = join(dir, "page.json");
        assert.equal(await loadMemory(path), undefined);
        const memory = reconcile(undefined, document.segments, info, conditions);
        memory.units[0].translation = "ガイド";
        memory.units[0].status = "translated";
        memory.units[0].conditions = conditions;
        memory.units[1].status = "failed";
        await saveMemory(path, memory);
        const loaded = reconcile(await loadMemory(path), document.segments, info, conditions);
        assert.equal(pendingUnits(loaded).length, 1);
        assert.equal(loaded.units[0].translation, "ガイド");
    } finally { await document.close(); await rm(dir, { recursive: true, force: true }); }
});
