import { validateTranslation } from "./segments";

export const TEXT_SLOT_FORMAT = "text-slots-v1" as const;
const token = /^__TRILIUM_PH_\d+__$/;
const split = (source: string) => source.split(/(__TRILIUM_PH_\d+__)/g);

/** The model sees prose only; protected tokens stay entirely on the client. */
export function textSlots(source: string) {
    return Object.fromEntries(split(source).flatMap((part, index) =>
        !token.test(part) ? [ [ `t${index}`, part.trim() ] ] : []));
}

export function slotContext(source: string) {
    return split(source).filter((part) => !token.test(part)).join("");
}

export function restoreTextSlots(source: string, value: unknown) {
    const expected = textSlots(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid structured translation slots");
    }
    const values = value as Record<string, unknown>;
    if (Object.keys(values).length !== Object.keys(expected).length
        || !Object.keys(expected).every((id) => Object.hasOwn(values, id)
            && typeof values[id] === "string"
            && !/__TRILIUM_PH_\d+__/i.test(values[id] as string))
        || !Object.values(values).some((text) => typeof text === "string" && text.trim())) {
        throw new Error("Invalid structured translation slots");
    }
    const restored = split(source).map((part, index) => {
        if (token.test(part)) return part;
        if (!part.trim()) return part + (values[`t${index}`] as string).trim();
        return part.match(/^\s*/)![0] + (values[`t${index}`] as string).trim()
            + part.match(/\s*$/)![0];
    }).join("");
    validateTranslation(source, restored);
    return restored;
}

/** Semantic instructions stay shared with legacy requests; the output protocol is versioned. */
export function textSlotPrompt(base: string) {
    const shared = base.split("\nReturn only JSON")[0]
        .replace(/^Tokens such as[^\n]*\n(?:in exactly[^\n]*\n)?/m, "");
    return `${shared}\nReturn JSON with requestKey and a translations OBJECT.
Each translations key is a unit ID; its value is an OBJECT mapping every supplied span ID to Japanese text.
Do not return a single string or an array for a unit. Copy all unit IDs, span IDs and requestKey exactly.
The source field gives the whole unit's prose for context. Translate the unit as a whole, distributing
Japanese grammar across its fixed spans. Keep labels, names and technical terms in their own spans.
Span IDs indicate source positions; protected content lies between adjacent spans. Empty source spans
are insertion points for Japanese particles or predicates, for example to put a verb after protected code.
You may move grammatical material and predicates to those insertion points, but never drop facts,
swap the meanings of labels, or omit a substantive term from the translation as a whole.
Translate prose only. Never emit HTML, Markdown, placeholders or span IDs inside text values.
Protected links, formatting and code will be restored by the application, not by you.`;
}
