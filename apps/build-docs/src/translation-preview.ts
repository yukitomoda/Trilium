/** API-free documentation build using the production Trilium share exporter. */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { renderToHtml } from "@triliumnext/commons/src/lib/markdown_renderer.js";
import { Window } from "happy-dom";
import sanitize from "sanitize-filename";

import type { NoteMeta, NoteMetaFile } from "../../../packages/trilium-core/src/meta";
import { documentationPageKey, localizeDocumentationLink } from "./documentation-links";
import { applyPagesBasePath, normalizeBasePath } from "./translation/pages-path";
import { hash } from "./translation/segments";
import { applySavedTranslations, type Snapshot } from "./translation/site";

async function main() {
    const here = resolve(__dirname, "../translation-preview");
    const root = resolve(here, "../../..");
    const generated = join(root, ".generated/translation-preview");
    const output = join(root, "site-ja");
    const basePath = normalizeBasePath(process.env.DOCS_BASE_PATH);
    const config = JSON.parse(await readFile(join(here, "config.json"), "utf8"));
    const mode = process.argv.includes("--identity") ? "identity" : config.mode;
    if (![ "identity", "translation" ].includes(mode)) throw new Error("Invalid build mode");
    const source = resolve(root, config.sourceDirectory);
    const meta: NoteMetaFile = JSON.parse(await readFile(join(source, "!!!meta.json"), "utf8"));
    if (config.pageIds !== "all" && (!Array.isArray(config.pageIds)
        || !config.pageIds.length || !config.pageIds.every((id: unknown) => typeof id === "string"))) {
        throw new Error('pageIds must be "all" or a non-empty array of page IDs');
    }
    const selected = new Set<string>(config.pageIds === "all" ? [] : config.pageIds);
    const records = new Map<string, { note: NoteMeta; directory: string; url: string }>();
    const sourcePaths = new Map<string, string>();

    function index(notes: NoteMeta[], directory: string, parentUrl: string) {
        for (const note of notes) {
            if (!note.noteId) throw new Error("Page without noteId");
            const alias = note.attributes?.find((a) => a.name === "shareAlias")?.value
                ?? sanitize(note.title ?? note.noteId);
            const url = `${parentUrl}/${encodeURIComponent(alias)}`;
            // Prefer the original location over a clone's placeholder document.
            if (!records.has(note.noteId) || (records.get(note.noteId)!.note.isClone && !note.isClone)) {
                records.set(note.noteId, { note, directory, url });
            }
            if (note.dataFileName) {
                sourcePaths.set(resolve(source, directory, note.dataFileName), note.noteId);
            }
            if (note.dirFileName) {
                sourcePaths.set(resolve(source, directory, note.dirFileName), note.noteId);
            }
            index(note.children ?? [], join(directory, note.dirFileName ?? ""), url);
        }
    }
    index(meta.files, "", "");
    if (config.pageIds === "all") for (const id of records.keys()) selected.add(id);
    for (const id of selected) {
        const record = records.get(id);
        if (!record) throw new Error(`Unknown page ID: ${id}`);
        // Keep ancestors, so nested selections retain the official URL hierarchy.
        for (const ancestor of record.note.notePath ?? []) selected.add(ancestor);
    }
    const localPages = new Map<string, string>();
    for (const id of selected) {
        const record = records.get(id)!;
        const path = record.url === "/user-guide" ? "/user-guide/" : `${record.url}.html`;
        localPages.set(documentationPageKey(record.url),
            `https://translation-preview.invalid${path}`);
    }
    const revision = execFileSync("git", [ "rev-parse", "HEAD" ], {
        cwd: root, encoding: "utf8"
    }).trim();
    await rm(generated, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
    await mkdir(generated, { recursive: true });
    await mkdir(output, { recursive: true });
    const pages: { noteId: string; title: string; path: string; sourceUrl: string;
        sourceFile: string; revision: string; mode: string }[] = [];

    async function prepare(notes: NoteMeta[], directory: string): Promise<NoteMeta[]> {
        const result: NoteMeta[] = [];
        for (const original of notes) {
            // Clone files contain pointers rather than prose. Links resolve to the original;
            // importing clone placeholders can create the note before its labels are applied.
            if (original.isClone || !original.noteId || !selected.has(original.noteId)) continue;
            const record = records.get(original.noteId)!;
            const note = structuredClone(original);
            note.children = await prepare(
                original.children ?? [], join(directory, original.dirFileName ?? "")
            );
            note.attributes = (note.attributes ?? []).filter((a) => a.type === "label");
            note.attributes.push(
                {
                    type: "label", name: "translationSourceUrl",
                    value: `https://docs.triliumnotes.org${record.url}`
                },
                { type: "label", name: "translationRevision", value: revision },
                { type: "label", name: "translationPreview", value: "identity" },
                { type: "label", name: "language", value: "en" }
            );
            if (original.dataFileName) {
                const file = join(source, directory, original.dataFileName);
                const markdown = await readFile(file, "utf8");
                const window = new Window();
                // The normal Trilium HTML importer sanitizes this generated intermediate input.
                window.document.body.innerHTML = renderToHtml(markdown, original.title ?? "", {
                    sanitize: (html) => html
                });
                for (const anchor of window.document.querySelectorAll("a[href]")) {
                    const href = anchor.getAttribute("href")!;
                    if (href.startsWith("#root/")) {
                        const id = href.split("/").at(-1)!;
                        const target = records.get(id === "_help" ? meta.files[0].noteId! : id);
                        const local = target && localPages.get(documentationPageKey(target.url));
                        anchor.classList.remove("reference-link");
                        if (local) anchor.setAttribute("href", local);
                        else anchor.removeAttribute("href");
                        continue;
                    }
                    const localized = localizeDocumentationLink(href, localPages);
                    if (localized !== null) {
                        anchor.classList.remove("reference-link");
                        anchor.setAttribute("href", localized);
                        continue;
                    }
                    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
                    const parsed = new URL(href, "https://source.invalid/");
                    const path = href.split(/[?#]/, 1)[0];
                    const targetPath = resolve(dirname(file), decodeURIComponent(path));
                    const targetId = sourcePaths.get(targetPath);
                    if (!targetId) throw new Error(`Unresolved page link in ${file}: ${href}`);
                    const target = records.get(targetId)!;
                    anchor.classList.remove("reference-link");
                    const localPath = target.url === "/user-guide"
                        ? "/user-guide/" : `${target.url}.html`;
                    const targetUrl = selected.has(targetId)
                        ? `https://translation-preview.invalid${localPath}`
                        : `https://docs.triliumnotes.org${target.url}`;
                    anchor.setAttribute("href", targetUrl + parsed.search + parsed.hash);
                }
                note.dataFileName = original.dataFileName.replace(/\.md$/, ".html");
                note.format = "html";
                note.mime = "text/html";
                await mkdir(join(generated, "input", directory), { recursive: true });
                await writeFile(
                    join(generated, "input", directory, note.dataFileName),
                    window.document.body.innerHTML
                );
                await window.happyDOM.close();
                if (!pages.some((page) => page.noteId === note.noteId)) pages.push({
                    noteId: original.noteId, title: note.title ?? "", path: record.url,
                    sourceUrl: `https://docs.triliumnotes.org${record.url}`,
                    sourceFile: relative(root, file), revision, mode
                });
            }
            if (!original.dataFileName) {
                pages.push({ noteId: original.noteId, title: note.title ?? "", path: record.url,
                    sourceUrl: `https://docs.triliumnotes.org${record.url}`,
                    sourceFile: relative(root, join(source, "!!!meta.json")), revision, mode });
            }
            for (const attachment of original.attachments ?? []) {
                await mkdir(join(generated, "input", directory), { recursive: true });
                await cp(
                    join(source, directory, attachment.dataFileName),
                    join(generated, "input", directory, attachment.dataFileName)
                );
            }
            result.push(note);
        }
        return result;
    }
    meta.files = await prepare(meta.files, "");
    await writeFile(join(generated, "input/!!!meta.json"), JSON.stringify(meta, null, 2));
    const buildConfig = {
        baseUrl: process.env.DOCS_BASE_URL || "http://localhost:9001",
        locale: "ja",
        noteMappings: [
            { rootNoteId: meta.files[0].noteId, path: "input", format: "html" },
            {
                rootNoteId: meta.files[0].noteId,
                path: relative(generated, join(output, "user-guide")),
                format: "share", exportOnly: true
            }
        ]
    };
    await writeFile(join(generated, "build.yaml"), JSON.stringify(buildConfig, null, 2));
    // The exporter's relative resource paths expect apps/build-docs as the working directory.
    process.chdir(join(root, "apps/build-docs"));
    const { buildDocsFromConfig } = await import("./build-docs");
    await buildDocsFromConfig(
        join(generated, "build.yaml"),
        process.argv.includes("--skip-client-build") ? undefined : root
    );
    // Root-relative links are interpreted as note paths during import. Use an absolute
    // placeholder during import/export, then resolve it only in the static output.
    async function resolveLocalLinks(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await resolveLocalLinks(path);
            else if (/\.(html|json)$/.test(entry.name)) {
                const html = await readFile(path, "utf8");
                await writeFile(path, html.replaceAll("https://translation-preview.invalid", ""));
            }
        }
    }
    await resolveLocalLinks(output);
    await cp(join(here, "assets"), output, { recursive: true });
    await cp(
        join(root, "apps/website/src/assets/favicon.ico"),
        join(output, "user-guide/favicon.ico")
    );
    await writeFile(join(output, "manifest.json"), JSON.stringify({
        model: config.model, mode, revision, basePath, pages
    }, null, 2));
    await cp(join(output, "404.html"), join(output, "user-guide/404.html"));
    const snapshot: Snapshot = {
        schemaVersion: 1, revision,
        selectionHash: hash(JSON.stringify([ config.sourceDirectory, config.pageIds ])),
        metadataHash: hash(await readFile(join(source, "!!!meta.json"), "utf8")), pages: []
    };
    for (const page of pages) {
        const path = page.path === "/user-guide"
            ? "user-guide/index.html" : `${page.path.slice(1)  }.html`;
        snapshot.pages.push({ pageId: page.noteId, title: page.title, path: page.path,
            sourceFile: page.sourceFile,
            sourceHash: hash(await readFile(join(root, page.sourceFile), "utf8")),
            html: await readFile(join(output, decodeURIComponent(path)), "utf8") });
    }
    await writeFile(join(generated, "pages.json"), JSON.stringify(snapshot, null, 2));
    if (mode === "translation") await applySavedTranslations(root, output, snapshot, config.model);
    await applyPagesBasePath(output, basePath);
    await writeFile(join(output, ".nojekyll"), "");
    console.log(`Preview built: ${pages.length} pages → ${output} (${mode} mode, no API calls)`);
    // The Trilium importer leaves background timers running.
    process.exit(0);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
