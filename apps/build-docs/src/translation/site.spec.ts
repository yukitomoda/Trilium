import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Window } from "happy-dom";

import { pendingUnits, reconcile, saveMemory } from "./memory";
import { extractPage } from "./segments";
import { applySavedTranslations, searchText, type Snapshot, translationSettings } from "./site";

void test("saved Japanese memory updates pages, navigation, TOC and search offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-site-"));
    const window = new Window();
    try {
        await mkdir(join(root, "i18n/prompts"), { recursive: true });
        await mkdir(join(root, "site/user-guide"), { recursive: true });
        await writeFile(join(root, "i18n/prompts/translate-ja.txt"), "translate");
        await writeFile(join(root, "i18n/glossary.ja.json"), "{}");
        const makeHtml = (title: string) => `<!doctype html><html lang="ja"><head>
        <title>${title}</title><meta charset="utf-8"></head><body><div id="content">
        <aside class="translation-notice"><p><strong>Preview</strong></p><p>Preview notice</p>
        <p id="translation-status">Identity</p></aside><h1 id="title">${title}</h1>
        <template id="translation-original"><h2 id="setup">Setup</h2><p>Read this.</p></template>
        <div id="translation-body"><h2 id="setup">Setup</h2><p>Read this.</p></div>
        <a href="quick-start.html"><span>Quick Start</span></a>
        <ul id="toc"><li><a href="#setup">Setup</a></li></ul></div></body></html>`;
        const snapshot: Snapshot = {
            schemaVersion: 1, revision: "revision", metadataHash: "metadata",
            selectionHash: "selection", pages: [
                { pageId: "guide", sourceFile: "guide.md", sourceHash: "source",
                    title: "Guide", path: "/user-guide", html: makeHtml("Guide") },
                { pageId: "quick", sourceFile: "quick.md", sourceHash: "source",
                    title: "Quick Start", path: "/user-guide/quick-start",
                    html: makeHtml("Quick Start") },
                { pageId: "spaced", sourceFile: "spaced.md", sourceHash: "source",
                    title: "Guide", path: "/user-guide/With%20spaces", html: makeHtml("Guide") }
            ]
        };
        const { conditions } = await translationSettings(root, "gemini-3.5-flash-lite");
        for (const page of snapshot.pages) {
            const document = extractPage(page.html, page.title);
            const memory = reconcile(undefined, document.segments, {
                pageId: page.pageId, sourceFile: page.sourceFile, sourceRevision: snapshot.revision
            }, conditions);
            for (const unit of memory.units) {
                unit.translation = unit.source.replace("Guide", "ガイド")
                    .replace("Quick Start", "クイックスタート").replace("Setup", "設定")
                    .replace("Read this.", "こちらを読んでください。");
                unit.status = "translated";
                unit.conditions = conditions;
            }
            assert.equal(pendingUnits(memory).length, 0);
            await saveMemory(join(root, `i18n/translations/ja/${page.pageId}.json`), memory);
            await document.close();
        }
        await writeFile(join(root, "site/user-guide/search-index.json"), JSON.stringify([
            { id: "user-guide.html", title: "Guide", content: "English", path: "Guide" },
            { id: "quick-start.html", title: "Quick Start", content: "English",
                path: "Guide / Quick Start" },
            { id: "With spaces.html", title: "Guide", content: "English", path: "Guide" }
        ]));
        await applySavedTranslations(root, join(root, "site"), snapshot, conditions.model);
        const html = await readFile(join(root, "site/user-guide/index.html"), "utf8");
        window.document.write(html);
        const doc = window.document;
        assert.equal(doc.querySelector("#title")!.textContent, "ガイド");
        assert.equal(doc.querySelector("#translation-body h2")!.id, "setup");
        assert.equal(doc.querySelector("#translation-body h2")!.textContent, "設定");
        assert.equal(doc.querySelector("#translation-body")!.getAttribute("lang"), "ja");
        assert.equal(doc.querySelector("#toc a")!.textContent, "設定");
        assert.equal(doc.querySelector("a[href='quick-start.html']")!.textContent,
            "クイックスタート");
        assert.match(doc.querySelector("#translation-original")!.innerHTML, /Read this/);
        assert.match(doc.querySelector("title")!.textContent, /ガイド/);
        const search = JSON.parse(await readFile(join(root,
            "site/user-guide/search-index.json"), "utf8"));
        assert.equal(search[0].title, "ガイド");
        assert.equal(search[1].title, "クイックスタート");
        assert.equal(search[1].path, "ガイド / クイックスタート");
        assert.equal(search[2].title, "ガイド");
        assert.match(search[2].content, /こちらを読んでください/);
        assert.match(await readFile(join(root, "site/user-guide/With spaces.html"), "utf8"),
            /こちらを読んでください/);
        assert.match(search[0].content, /こちらを読んでください/);
        assert.ok(!search[0].content.includes("Read this"));
    } finally {
        await window.happyDOM.close();
        await rm(root, { recursive: true, force: true });
    }
});

void test("search text preserves inline words and block boundaries without CSS layout", async () => {
    const window = new Window();
    try {
        window.document.body.innerHTML = `<p>Read <strong>this</strong>.</p><p>Next line.</p>
            <pre>code\nexample</pre><script>do not index</script>
            <template>hidden original</template>`;
        assert.equal(searchText(window.document.body), "Read this. Next line. code example");
    } finally { await window.happyDOM.close(); }
});
