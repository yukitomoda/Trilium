import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadJobs } from "./batch-jobs";
import { loadMemory } from "./memory";
import { type Snapshot, translationSettings } from "./site";
import { statusMarkdown, translationStatus } from "./status";

async function main() {
    const root = resolve(__dirname, "../../../..");
    const generated = join(root, ".generated/translation-preview");
    const reports = join(root, ".generated/translation-status");
    const config = JSON.parse(await readFile(join(root, "apps/build-docs/translation-preview/config.json"), "utf8"));
    const snapshot: Snapshot = JSON.parse(await readFile(join(generated, "pages.json"), "utf8"));
    const pages = [];
    let missing = 0;
    for (const page of snapshot.pages) {
        const memory = await loadMemory(join(root, `i18n/translations/ja/${page.pageId}.json`));
        if (memory) pages.push({ title: memory.units.find((unit) => unit.active
            && unit.kind === "title" && unit.translation)?.translation ?? page.title, memory });
        else missing++;
    }
    const jobs = await loadJobs(join(root, "i18n/batches"));
    const { conditions } = await translationSettings(root, config.model);
    const status = translationStatus(pages, jobs, conditions);
    let observedJobs: string[] = [];
    try {
        const run = JSON.parse(await readFile(join(generated, "last-run.json"), "utf8"));
        observedJobs = Array.isArray(run.observedJobs)
            ? run.observedJobs.filter((id: unknown) => typeof id === "string") : [];
    } catch (error) {
        // An interrupted write of optional run metadata must not hide durable journal counts.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const markdown = statusMarkdown(status, observedJobs)
        + (process.env.TRANSLATION_OUTCOME === "failure"
            ? "\n翻訳ステップはエラーで終了しました。上記は保存できた範囲の集計です。API接続・設定などのエラーは翻訳ステップのログも確認してください。正常な訳文のPRが作られる場合があります。\n" : "")
        + (missing ? `\n注意：${missing} ページは翻訳JSONがまだなく、上記の部分数に含まれません。\n` : "");
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, "status.json"), JSON.stringify({
        generatedAt: new Date().toISOString(), model: config.model, missingPages: missing,
        observedJobs, ...status
    }, null, 2));
    await writeFile(join(reports, "status.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
