import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { translateBatch } from "./gemini";
import { loadMemory, pendingUnits, reconcile, saveMemory } from "./memory";
import { extractPage, hash } from "./segments";
import { type Snapshot, translationSettings } from "./site";

async function main() {
    const root = resolve(__dirname, "../../../..");
    const args = process.argv.slice(2);
    const command = args[0];
    if (![ "plan", "extract", "translate" ].includes(command)) {
        throw new Error("Usage: cli.ts plan|extract|translate "
            + "[--page NOTE_ID] [--limit UNITS] [--refresh]");
    }
    for (let index = 1; index < args.length; index++) {
        if ([ "--page", "--limit" ].includes(args[index])) index++;
        else if (args[index] !== "--refresh") throw new Error(`Unknown option: ${args[index]}`);
    }
    const flag = (name: string) => {
        const index = args.indexOf(name);
        if (index < 0) return undefined;
        if (!args[index + 1] || args[index + 1].startsWith("--")) {
            throw new Error(`Missing value for ${name}`);
        }
        return args[index + 1];
    };
    const pageId = flag("--page");
    const limit = flag("--limit") === undefined ? Infinity : Number(flag("--limit"));
    if (!(limit > 0) || (flag("--limit") !== undefined && !Number.isInteger(limit))) {
        throw new Error("--limit must be a positive integer");
    }
    const config = JSON.parse(await readFile(join(root,
        "apps/build-docs/translation-preview/config.json"), "utf8"));
    let snapshot: Snapshot;
    try {
        snapshot = JSON.parse(await readFile(join(root,
            ".generated/translation-preview/pages.json"), "utf8"));
    } catch {
        throw new Error("Run pnpm docs:ja:build first to prepare the current source snapshot");
    }
    if (snapshot.selectionHash !== hash(JSON.stringify([
        config.sourceDirectory, config.pageIds
    ]))) throw new Error("Selected pages changed; run pnpm docs:ja:build first");
    const metadata = await readFile(join(root, config.sourceDirectory, "!!!meta.json"), "utf8");
    if (snapshot.metadataHash !== hash(metadata)) {
        throw new Error("Source metadata changed; run pnpm docs:ja:build first");
    }
    const pages = snapshot.pages.filter((page) => !pageId || page.pageId === pageId);
    if (!pages.length) throw new Error("No matching page in the current build");
    const settings = await translationSettings(root, config.model);
    const planned = [];
    let remaining = limit;
    for (const page of pages) {
        if (hash(await readFile(join(root, page.sourceFile), "utf8")) !== page.sourceHash) {
            throw new Error(`Source changed: ${page.sourceFile}; run pnpm docs:ja:build first`);
        }
        const document = extractPage(page.html, page.title);
        const path = join(root, `i18n/translations/ja/${page.pageId}.json`);
        const memory = reconcile(await loadMemory(path), document.segments, {
            pageId: page.pageId, sourceFile: page.sourceFile, sourceRevision: snapshot.revision
        }, settings.conditions);
        await document.close();
        const pending = pendingUnits(memory, args.includes("--refresh"));
        const units = pending.slice(0, remaining);
        remaining -= units.length;
        const review = memory.units.filter((unit) => unit.active
            && unit.status === "needs-review").length;
        console.log(`${page.title}: ${pending.length} pending, ${review} need review, `
            + `${units.length} selected`);
        planned.push({ path, memory, units });
    }
    const total = planned.reduce((sum, page) => sum + page.units.length, 0);
    const chars = planned.flatMap((page) => page.units)
        .reduce((sum, unit) => sum + unit.source.length + unit.context.length, 0);
    console.log(`${total} units; ${chars} source/context characters; model=${config.model}`);
    if (command === "plan") return;
    if (command === "extract") {
        for (const page of planned) await saveMemory(page.path, page.memory);
        console.log("Source units saved; no API calls made.");
        return;
    }
    // Load optional local credentials only in the API command; never put them in public files.
    try { process.loadEnvFile(join(root, ".env.local")); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error("Could not load .env.local");
        }
    }
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (total && !apiKey) {
        throw new Error("Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment or .env.local");
    }
    for (const page of planned) {
        // Persist active/obsolete state even if there is nothing new to translate.
        await saveMemory(page.path, page.memory);
        // Small batches bound output size and preserve progress on later failures.
        for (let offset = 0; offset < page.units.length;) {
            const batch = [];
            let size = 0;
            while (offset < page.units.length && batch.length < 16) {
                const unit = page.units[offset];
                if (batch.length && size + unit.source.length > 10000) break;
                batch.push(unit);
                size += unit.source.length;
                offset++;
            }
            try {
                const result = await translateBatch(batch, {
                    apiKey: apiKey!, model: config.model, prompt: settings.prompt,
                    glossary: settings.glossary
                });
                const at = new Date().toISOString();
                for (const unit of batch) {
                    unit.translation = result.translations.get(unit.id)!;
                    unit.status = "translated";
                    unit.conditions = settings.conditions;
                    unit.translatedAt = at;
                    delete unit.error;
                }
                page.memory.requests.push({ at, model: config.model,
                    modelVersion: result.modelVersion, usage: result.usage });
                await saveMemory(page.path, page.memory);
                console.log(`Saved ${batch.length} units: ${page.memory.pageId}`);
            } catch (error) {
                for (const unit of batch) {
                    unit.status = "failed";
                    unit.error = error instanceof Error ? error.message : "Translation failed";
                }
                await saveMemory(page.path, page.memory);
                throw error;
            }
        }
    }
    console.log("Translation memory saved. "
        + "Run pnpm docs:ja:build --skip-client-build to update the site.");
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
