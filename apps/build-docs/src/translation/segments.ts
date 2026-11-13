import { createHash } from "node:crypto";

import { type Element, type Node, Window } from "happy-dom";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const marker = /__TRILIUM_PH_\d+__/g;
const blocks = new Set([
    "DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE",
    "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "ASIDE", "BLOCKQUOTE", "SECTION",
    "ARTICLE", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "DL", "DT", "DD"
]);
const protectedTags = new Set([ "PRE", "CODE", "SCRIPT", "STYLE", "SVG", "IMG", "MATH" ]);
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export interface Segment {
    id: string;
    kind: string;
    source: string;
    sourceHash: string;
    context: string;
    contextHash: string;
}

export function validateTranslation(source: string, translation: string) {
    if (typeof translation !== "string" || !translation.trim()) {
        throw new Error("Empty or invalid translation");
    }
    const expected = source.match(marker) ?? [];
    const actual = translation.match(marker) ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error("Translation changed protected placeholders");
    }
}

/** Extracts prose runs; model output can never introduce HTML or alter protected markup. */
export function extractPage(html: string, title: string) {
    const window = new Window();
    const doc = window.document;
    doc.write(html);
    const body = doc.querySelector("#translation-body");
    if (!body) throw new Error("Missing translation body; rebuild the English snapshot");
    const segments: Segment[] = [];
    const setters = new Map<string, (translation: string) => void>();
    const counts = new Map<string, number>();
    const headings: string[] = [];
    let translatedTitle = title;

    function add(source: string, kind: string, setter: (text: string) => void) {
        if (!source.replace(marker, "").trim()) return;
        const sourceHash = hash(`${kind  }\n${  source}`);
        const count = counts.get(sourceHash) ?? 0;
        counts.set(sourceHash, count + 1);
        const id = `u_${sourceHash.slice(0, 24)}_${count}`;
        const context = [ title, ...headings ].filter(Boolean).join(" > ");
        segments.push({ id, kind, source, sourceHash, context, contextHash: hash(context) });
        setters.set(id, setter);
    }
    add(title, "title", (value) => { translatedTitle = value; });

    function isProtected(node: Node): boolean {
        if (node.nodeType !== 1) return false;
        const element = node as Element;
        return protectedTags.has(element.tagName) || element.classList.contains("toc-anchor")
            || element.classList.contains("math-tex") || element.classList.contains("mermaid");
    }

    function translateRun(nodes: Node[], kind: string) {
        if (!nodes.length) return;
        const slots: string[] = [];
        const slot = (value: string) => {
            slots.push(value);
            return `__TRILIUM_PH_${slots.length - 1}__`;
        };
        function encode(node: Node): string {
            if (node.nodeType === 3) {
                if ((node.textContent ?? "").match(marker)) {
                    throw new Error("Reserved placeholder in source");
                }
                return node.textContent ?? "";
            }
            if (node.nodeType !== 1) return slot("");
            const element = node as Element;
            if (isProtected(node) || !node.childNodes.length) return slot(element.outerHTML);
            const opening = element.outerHTML.slice(0, element.outerHTML.indexOf(">") + 1);
            return slot(opening) + Array.from(node.childNodes).map(encode).join("")
                + slot(`</${element.tagName.toLowerCase()}>`);
        }
        const source = nodes.map(encode).join("");
        add(source, kind, (translation) => {
            validateTranslation(source, translation);
            const template = doc.createElement("template");
            template.innerHTML = escape(translation).replace(marker, (token) => {
                const index = Number(token.match(/\d+/)![0]);
                return slots[index];
            });
            nodes[0].parentNode!.insertBefore(template.content, nodes[0]);
            for (const node of nodes) node.parentNode!.removeChild(node);
        });
    }

    function visit(parent: Element) {
        let run: Node[] = [];
        for (const child of Array.from(parent.childNodes)) {
            const element = child.nodeType === 1 ? child as Element : undefined;
            if (element && (blocks.has(element.tagName)
                || [ "PRE", "SCRIPT", "STYLE" ].includes(element.tagName))) {
                translateRun(run, parent.tagName.toLowerCase());
                run = [];
                if (element && !isProtected(element)) {
                    if (/^H[1-6]$/.test(element.tagName)) {
                        const level = Number(element.tagName[1]);
                        headings.length = level - 1;
                        headings[level - 1] = element.textContent;
                    }
                    visit(element);
                }
            } else run.push(child);
        }
        translateRun(run, parent.tagName.toLowerCase());
    }
    visit(body);
    Array.from(body.querySelectorAll("img[alt]")).forEach((image, index) => {
        const alt = image.getAttribute("alt")!;
        add(alt, "image-alt", (value) => {
            body.querySelectorAll("img[alt]")[index].setAttribute("alt", value);
        });
    });
    return {
        segments,
        apply(translations: ReadonlyMap<string, string>) {
            for (const segment of segments) {
                const value = translations.get(segment.id);
                if (value !== undefined) {
                    validateTranslation(segment.source, value);
                    setters.get(segment.id)!(value);
                }
            }
            return { html: doc.documentElement.outerHTML, title: translatedTitle };
        },
        close: () => window.happyDOM.close()
    };
}
