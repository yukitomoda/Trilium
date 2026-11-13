const officialOrigin = "https://docs.triliumnotes.org";

function normalizePagePath(path: string) {
    return decodeURI(path).replace(/\/index\.html$/, "").replace(/\.html$/, "")
        .replace(/\/+$/, "");
}

/** Resolves official URLs against pages actually included in the translated build. */
export function localizeDocumentationLink(href: string, localPages: ReadonlyMap<string, string>) {
    // Relative Markdown paths are handled separately, using the source file's directory.
    if (!/^(?:https?:\/\/|\/)/i.test(href)) return null;
    const url = new URL(href, officialOrigin);
    if (url.hostname !== "docs.triliumnotes.org" || ![ "https:", "http:" ].includes(url.protocol)) {
        return null;
    }
    const localPath = localPages.get(normalizePagePath(url.pathname));
    if (localPath) return localPath + url.search + url.hash;
    // Root-relative paths outside the selected pages must still point to the official site.
    return url.href;
}

export function documentationPageKey(path: string) {
    return normalizePagePath(path);
}
