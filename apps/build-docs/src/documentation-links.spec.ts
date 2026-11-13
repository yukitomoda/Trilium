import assert from "node:assert/strict";
import { test } from "node:test";

import { localizeDocumentationLink } from "./documentation-links";

const pages = new Map([
    [ "/user-guide", "/user-guide/" ],
    [ "/user-guide/quick-start", "/user-guide/quick-start.html" ]
]);

void test("official links resolve locally and retain query parameters and headings", () => {
    for (const prefix of [ "https://docs.triliumnotes.org", "http://docs.triliumnotes.org", "" ]) {
        for (const suffix of [ "", "/", ".html", "/index.html" ]) {
            assert.equal(localizeDocumentationLink(
                `${prefix}/user-guide/quick-start${suffix}?mode=read#choose-the-setup`, pages
            ), "/user-guide/quick-start.html?mode=read#choose-the-setup");
        }
    }
    assert.equal(localizeDocumentationLink("//docs.triliumnotes.org/user-guide/", pages),
        "/user-guide/");
});

void test("untranslated pages keep their official destination", () => {
    assert.equal(localizeDocumentationLink("/user-guide/setup#docker", pages),
        "https://docs.triliumnotes.org/user-guide/setup#docker");
});

void test("external websites, fragments, and Markdown paths are handled separately", () => {
    for (const href of [
        "https://example.org/user-guide/quick-start", "//example.org/user-guide/quick-start",
        "https://docs.triliumnotes.org.example.org/user-guide/quick-start",
        "#choose-the-setup", "Quick%20Start.md", "mailto:user@example.org"
    ]) assert.equal(localizeDocumentationLink(href, pages), null);
});
