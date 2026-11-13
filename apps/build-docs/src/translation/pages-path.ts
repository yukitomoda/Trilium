import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Document, type DocumentFragment, Window } from "happy-dom";

export function normalizeBasePath(value = "") {
    const path = value.replace(/\/+$/, "");
    if (!path) return "";
    if (!path.startsWith("/") || /[?#"'<>\\\s]|\/\/|(^|\/)\.\.?($|\/)/.test(path)) {
        throw new Error("DOCS_BASE_PATH must be a root-relative path such as /my-repository");
    }
    return path;
}

export function prefixRootUrl(value: string, basePath: string) {
    return value.startsWith("/") && !value.startsWith("//") ? basePath + value : value;
}

/** Runs after translation so deployment paths never change translation-memory IDs. */
export async function applyPagesBasePath(directory: string, basePath: string) {
    if (!basePath) return;
    const window = new Window();
    function rewrite(root: Document | DocumentFragment) {
        for (const element of root.querySelectorAll("[href], [src], [poster], [action]")) {
            for (const name of [ "href", "src", "poster", "action" ]) {
                const value = element.getAttribute(name);
                if (value !== null) element.setAttribute(name, prefixRootUrl(value, basePath));
            }
        }
        for (const meta of root.querySelectorAll("meta[http-equiv]")) {
            if (meta.getAttribute("http-equiv")?.toLowerCase() !== "refresh") continue;
            const value = meta.getAttribute("content") ?? "";
            meta.setAttribute("content", value.replace(
                /^(\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*)\/(?!\/)/i, `$1${basePath}/`
            ));
        }
        for (const template of root.querySelectorAll("template")) rewrite(template.content);
    }
    async function visit(path: string) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            const file = join(path, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.name.endsWith(".html")) {
                const document = new window.DOMParser().parseFromString(
                    await readFile(file, "utf8"), "text/html"
                );
                rewrite(document);
                await writeFile(file, `<!DOCTYPE html>\n${  document.documentElement.outerHTML}`);
            }
        }
    }
    try { await visit(directory); } finally { await window.happyDOM.close(); }
}
