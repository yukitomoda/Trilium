import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Node, Window } from "happy-dom";

import { type Conditions,loadMemory, reconcile, usableTranslations } from "./memory";
import { extractPage, hash } from "./segments";

export interface PageSnapshot {
    pageId: string;
    sourceFile: string;
    sourceHash: string;
    title: string;
    path: string;
    html: string;
}
export interface Snapshot {
    schemaVersion: 1;
    revision: string;
    metadataHash: string;
    selectionHash: string;
    pages: PageSnapshot[];
}

export async function translationSettings(root: string, model: string) {
    const prompt = await readFile(join(root, "i18n/prompts/translate-ja.txt"), "utf8");
    const glossaryText = await readFile(join(root, "i18n/glossary.ja.json"), "utf8");
    const glossary: Record<string, string> = JSON.parse(glossaryText);
    const conditions: Conditions = {
        model, promptHash: hash(prompt), glossaryHash: hash(glossaryText)
    };
    return { prompt, glossary, conditions };
}

/** Search needs text and paragraph boundaries, without expensive CSS layout on every page. */
export function searchText(body: Node) {
    const parts: string[] = [];
    function visit(node: Node) {
        if ([ "SCRIPT", "STYLE", "TEMPLATE" ].includes(node.nodeName)) return;
        if (node.nodeType === 3) { parts.push(node.textContent ?? ""); return; }
        const block = /^(?:DIV|P|H[1-6]|UL|OL|LI|TABLE|TR|TD|TH|PRE|BLOCKQUOTE|BR|HR|SECTION|ASIDE|DL|DT|DD)$/
            .test(node.nodeName);
        if (block) parts.push(" ");
        for (const child of node.childNodes) visit(child);
        if (block) parts.push(" ");
    }
    visit(body);
    return parts.join("").replace(/\s+/g, " ").trim();
}

export async function applySavedTranslations(
    root: string, output: string, snapshot: Snapshot, model: string
) {
    const { conditions } = await translationSettings(root, model);
    const titles = new Map<string, { source: string; translated: string }>();
    const results: { path: string; html: string; content: string }[] = [];
    for (const page of snapshot.pages) {
        const document = extractPage(page.html, page.title);
        const memory = reconcile(await loadMemory(join(root,
            `i18n/translations/ja/${page.pageId}.json`)), document.segments, {
            pageId: page.pageId, sourceFile: page.sourceFile, sourceRevision: snapshot.revision
        }, conditions);
        const translations = usableTranslations(memory);
        const result = document.apply(translations);
        await document.close();
        titles.set(page.path, { source: page.title, translated: result.title });
        const window = new Window();
        window.document.write(result.html);
        const doc = window.document;
        const missing = memory.units.filter((unit) => unit.active && !unit.translation).length;
        const review = memory.units.filter((unit) => unit.active
            && [ "needs-review", "failed" ].includes(unit.status) && unit.translation).length;
        doc.querySelector("#title")!.textContent = result.title;
        doc.querySelector("title")!.textContent = `${result.title  } — Trilium Notes 非公式日本語訳`;
        const body = doc.querySelector("#translation-body")!;
        doc.querySelector("#content")!.setAttribute("lang", translations.size ? "ja" : "en");
        body.setAttribute("lang", translations.size ? "ja" : "en");
        body.setAttribute("data-translation-mode", "translation");
        body.setAttribute("data-translated-title", result.title);
        body.setAttribute("data-original-title", page.title);
        const status = doc.querySelector("#translation-status")!;
        status.textContent = missing
            ? `一部未翻訳です（残り ${missing} 箇所）。未翻訳部分は英語で表示しています。`
            : "生成AIによる非公式の日本語訳です。翻訳には誤りが含まれる場合があります。";
        if (review) status.textContent += ` 要確認の翻訳：${review} 箇所。`;
        status.setAttribute("data-translated-status", status.textContent);
        doc.querySelector(".translation-notice strong")!.textContent
            = "Trilium Notes 非公式日本語翻訳";
        doc.querySelectorAll(".translation-notice p")[1].textContent
            = "このサイトは公式サイトではありません。原文とあわせてご確認ください。";
        for (const anchor of doc.querySelectorAll("#toc a[href^='#'], .tree-toc a[href^='#']")) {
            const heading = doc.getElementById(decodeURIComponent(
                anchor.getAttribute("href")!.slice(1)));
            if (heading) anchor.textContent = heading.textContent;
        }
        // The English snapshot template is intentionally left untouched.
        results.push({ path: page.path, html: doc.documentElement.outerHTML,
            content: searchText(body) });
        await window.happyDOM.close();
        if (snapshot.pages.length > 50 && results.length % 50 === 0) {
            console.log(`Prepared translations: ${results.length}/${snapshot.pages.length} pages`);
        }
    }
    for (const result of results) {
        const window = new Window();
        window.document.write(result.html);
        const doc = window.document;
        for (const anchor of doc.querySelectorAll("a[href]")) {
            const href = anchor.getAttribute("href")!;
            if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
            const base = result.path === "/user-guide"
                ? `${result.path  }/` : `${result.path  }.html`;
            const url = new URL(href, `https://local.invalid${  base}`);
            const title = titles.get(url.pathname.replace(/\.html$/, "").replace(/\/$/, ""));
            if (!title) continue;
            const walker = doc.createTreeWalker(anchor, 4);
            let text;
            while ((text = walker.nextNode())) {
                if (text.textContent?.trim() === title.source) {
                    text.textContent = text.textContent.replace(title.source, title.translated);
                }
            }
        }
        const full = `<!DOCTYPE html>\n${  doc.documentElement.outerHTML}`;
        const path = result.path === "/user-guide"
            ? "user-guide/index.html" : `${result.path.slice(1)  }.html`;
        await writeFile(join(output, decodeURIComponent(path)), full);
        if (result.path === "/user-guide") {
            await writeFile(join(output, "user-guide/user-guide.html"), full);
        }
        await window.happyDOM.close();
    }
    // Index the translated content without including the English template.
    const indexPath = join(output, "user-guide/search-index.json");
    const search = JSON.parse(await readFile(indexPath, "utf8"));
    for (const entry of search) {
        const page = snapshot.pages.find((page) => page.pageId === entry.id
            || decodeURI(entry.id) === (page.path === "/user-guide" ? "user-guide.html"
                : `${decodeURI(page.path).replace(/^\/user-guide\/?/, "")  }.html`));
        if (!page) continue;
        entry.title = titles.get(page.path)!.translated;
        entry.content = results.find((result) => result.path === page.path)!.content;
        entry.path = entry.path.split(" / ").map((part: string) => {
            const title = [ ...titles.values() ].find((title) => title.source === part);
            return title?.translated ?? part;
        }).join(" / ");
    }
    await writeFile(indexPath, JSON.stringify(search, null, 2));
}
