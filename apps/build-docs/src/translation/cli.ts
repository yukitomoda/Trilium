import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadJobs, replayResults, reservedUnits, runBatchTranslation } from "./batch-jobs";
import { createBatchService } from "./gemini";
import { loadMemory, pendingUnits, reconcile, saveMemory } from "./memory";
import { extractPage, hash } from "./segments";
import { type Snapshot, translationSettings } from "./site";

async function main() {
    const root = resolve(__dirname, "../../../..");
    const args = process.argv.slice(2);
    const command = args[0];
    if (![ "plan", "extract", "translate", "collect" ].includes(command)) {
        throw new Error("Usage: cli.ts plan|extract|translate|collect "
            + "[--page NOTE_ID] [--limit UNITS] [--refresh] [--recheck-completed]");
    }
    for (let index = 1; index < args.length; index++) {
        if ([ "--page", "--limit" ].includes(args[index])) index++;
        else if (![ "--refresh", "--recheck-completed" ].includes(args[index])) throw new Error(`Unknown option: ${args[index]}`);
    }
    const flag = (name: string) => {
        const index = args.indexOf(name);
        if (index < 0) return undefined;
        if (!args[index + 1] || args[index + 1].startsWith("--")) {
            throw new Error(`Missing value for ${name}`);
        }
        return args[index + 1];
    };
    const recheckCompleted = args.includes("--recheck-completed");
    if (recheckCompleted && command !== "collect") {
        throw new Error("--recheck-completed requires collect mode; no new batches are submitted");
    }
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
    const pages = snapshot.pages;
    if (pageId && !pages.some((page) => page.pageId === pageId)) {
        throw new Error("No matching page in the current build");
    }
    const settings = await translationSettings(root, config.model);
    const planned = [];
    const directory = join(root, "i18n/batches");
    const jobs = await loadJobs(directory);
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
        planned.push({ path, memory, title: page.title });
    }
    replayResults(planned, jobs, settings.conditions);
    const reserved = reservedUnits(jobs, settings.conditions);
    let remaining = command === "collect" ? 0 : limit;
    let total = 0;
    for (const page of planned) {
        const pending = pendingUnits(page.memory, args.includes("--refresh"));
        const available = pending.filter((unit) => !reserved.has(
            `${page.memory.pageId}:${unit.id}:${unit.contextHash}`));
        const selected = !pageId || page.memory.pageId === pageId
            ? Math.min(remaining, available.length) : 0;
        remaining -= selected;
        total += selected;
        console.log(`${page.title}: ${pending.length} pending, `
            + `${pending.length - available.length} in Batch API, ${selected} selected`);
    }
    console.log(`${total} units to submit; model=${config.model}; `
        + `${jobs.filter((job) => job.phase === "pending").length} unfinished jobs`);
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
    if (!apiKey && (total > 0 || jobs.some((job) => job.name && (job.phase === "pending" || recheckCompleted)))) {
        throw new Error("Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment or .env.local");
    }
    const service = () => createBatchService({ apiKey: apiKey ?? "", model: config.model,
        prompt: settings.prompt, glossary: settings.glossary });
    const result = await runBatchTranslation(planned, {
        directory, conditions: settings.conditions,
        service: { create: (...args) => service().create(...args),
            get: (...args) => service().get(...args) },
        submit: command === "translate", recheckCompleted, limit, pageId, refresh: args.includes("--refresh"),
        checkpoint: process.env.BATCH_STATE_CHECKPOINT === "1" ? async () => {
            execFileSync("bash", [ join(root,
                "apps/build-docs/translation-preview/batch-state.sh"), "save" ], {
                cwd: root, stdio: "inherit"
            });
        } : undefined
    });
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `received_requests=${result.received}\n`
            + `pending_jobs=${result.pending}\nsubmitted_units=${result.submitted}\n`);
    }
    console.log(`Batch API: ${result.submitted} units submitted; ${result.pending} jobs pending.`);
    console.log("Run docs:ja:collect later, then docs:ja:build --skip-client-build.");
    if (result.failed) throw new Error("Some batch requests failed; valid results were saved");
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
