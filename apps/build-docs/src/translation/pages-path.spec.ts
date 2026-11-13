import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyPagesBasePath, normalizeBasePath } from "./pages-path";

void test("Pages accepts both a repository path and a root domain", () => {
    assert.equal(normalizeBasePath("/my-docs/"), "/my-docs");
    assert.equal(normalizeBasePath("/"), "");
    assert.equal(normalizeBasePath(), "");
    for (const invalid of [ "https://example.org", "//other", "/../other", "/repo?x=y" ]) {
        assert.throws(() => normalizeBasePath(invalid));
    }
});

void test("Pages rewrites URLs and templates without editing prose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trilium-pages-"));
    try {
        await writeFile(join(directory, "index.html"), `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0; url=/user-guide/">
        <script src="/translation-preview.js"></script></head><body>
        <a href="/user-guide/quick-start.html?q=1#setup">Local</a>
        <a href="https://docs.triliumnotes.org/user-guide/">Official</a>
        <a href="//example.org/image">Other</a><a href="#setup">Heading</a>
        <img src="assets/image.png"><code>href="/example"</code>
        <template><a href="/user-guide/">English original</a></template></body></html>`);
        await applyPagesBasePath(directory, "/translated-docs");
        const html = await readFile(join(directory, "index.html"), "utf8");
        assert.match(html, /url=\/translated-docs\/user-guide\//);
        assert.match(html, /src="\/translated-docs\/translation-preview.js"/);
        assert.match(html, /href="\/translated-docs\/user-guide\/quick-start.html\?q=1#setup"/);
        assert.match(html, /href="https:\/\/docs.triliumnotes.org\/user-guide\/"/);
        assert.match(html, /href="\/\/example.org\/image"/);
        assert.match(html, /href="#setup"/);
        assert.match(html, /src="assets\/image.png"/);
        assert.match(html, /<code>href="\/example"<\/code>/);
        assert.match(html, /<template><a href="\/translated-docs\/user-guide\/"/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
