import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Window } from "happy-dom";

import { normalizeBasePath } from "./pages-path";

async function main() {
    const output = resolve(__dirname, "../../../../site-ja");
    const basePath = normalizeBasePath(process.env.DOCS_BASE_PATH);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.basePath, basePath);
    assert.ok(manifest.pages.length > 0, "Empty site");
    await stat(join(output, ".nojekyll"));
    const window = new Window();
    let count = 0;
    async function check(path: string) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            const file = join(path, entry.name);
            assert.ok(!entry.isSymbolicLink(), `Pages cannot publish symlinks: ${file}`);
            if (entry.isDirectory()) { await check(file); continue; }
            if (!entry.name.endsWith(".html")) continue;
            count++;
            const html = await readFile(file, "utf8");
            const document = new window.DOMParser().parseFromString(html, "text/html");
            assert.match(document.body.textContent, /非公式/, `Missing notice: ${file}`);
            const base = `https://local.invalid${basePath}/${relative(output, file)}`;
            const roots = [ document, ...Array.from(document.querySelectorAll("template"))
                .map((template) => template.content) ];
            for (const root of roots) {
                for (const element of root.querySelectorAll("[href], [src], [poster]")) {
                    for (const attribute of [ "href", "src", "poster" ]) {
                        const value = element.getAttribute(attribute);
                        if (!value || value.startsWith("#")) continue;
                        const url = new URL(value, base);
                        if (url.origin !== "https://local.invalid") continue;
                        assert.ok(url.pathname.startsWith(`${basePath}/`),
                            `URL escapes Pages path: ${value} in ${file}`);
                        const target = join(output,
                            decodeURIComponent(url.pathname.slice(basePath.length)));
                        const info = await stat(target).catch(() => undefined);
                        assert.ok(info, `Missing asset or page: ${value} in ${file}`);
                        if (info.isDirectory()) await stat(join(target, "index.html"));
                    }
                }
            }
        }
    }
    try {
        await check(output);
        assert.ok(count >= manifest.pages.length);
        console.log(`Validated ${count} HTML files and local URLs at ${basePath || "/"}`);
    } finally { await window.happyDOM.close(); }
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
