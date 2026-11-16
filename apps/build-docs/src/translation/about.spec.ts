import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { writeAboutPage } from "./about";
import { applyPagesBasePath } from "./pages-path";

void test("translation information preserves license texts and identifies the dated source version", async () => {
    const output = await mkdtemp(join(tmpdir(), "trilium-about-"));
    const root = resolve(__dirname, "../../../..");
    const revision = "a".repeat(40);
    try {
        await writeAboutPage(root, output, { revision, modifiedAt: "2026-11-16T01:00:00+09:00" });
        const html = await readFile(join(output, "about/index.html"), "utf8");
        assert.match(html, /非公式の日本語翻訳/);
        assert.match(html, /原文から変更/);
        assert.match(html, /datetime="2026-11-15"/);
        assert.match(html, /AGPL-3.0-or-later/);
        assert.match(html, /Apache License 2.0/);
        assert.ok(html.includes(`https://github.com/yukitomoda/Trilium/tree/${revision}`));
        assert.ok(!html.includes("未公開の変更"));
        for (const [ source, target ] of [ [ "LICENSE", "AGPL-3.0.txt" ],
            [ "packages/share-theme/LICENSE", "share-theme-Apache-2.0.txt" ] ]) {
            assert.equal(await readFile(join(output, "licenses", target), "utf8"),
                await readFile(join(root, source), "utf8"));
        }
        await applyPagesBasePath(output, "/Trilium");
        const prefixed = await readFile(join(output, "about/index.html"), "utf8");
        assert.match(prefixed, /href="\/Trilium\/licenses\/AGPL-3.0.txt"/);
        assert.match(prefixed, /href="\/Trilium\/user-guide\/"/);
        assert.match(prefixed, /href="\/Trilium\/about.css"/);
        await assert.rejects(() => writeAboutPage(root, output,
            { revision: "invalid", modifiedAt: "invalid" }), /Invalid source version/);
    } finally { await rm(output, { recursive: true, force: true }); }
});
