import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

void test("CI checkpoints survive another runner without touching main or its index", async () => {
    const root = await mkdtemp(join(tmpdir(), "trilium-state-"));
    try {
        const work = join(root, "work");
        const runner = join(root, "runner");
        await mkdir(work);
        await mkdir(runner);
        const env = { ...process.env, RUNNER_TEMP: runner,
            GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
        const git = (...args: string[]) => execFileSync("git", args,
            { cwd: work, env, encoding: "utf8", stdio: [ "ignore", "pipe", "pipe" ] }).trim();
        git("init", "--bare", join(root, "origin.git"));
        git("init", "-b", "main");
        git("remote", "add", "origin", join(root, "origin.git"));
        await mkdir(join(work, "i18n/batches"), { recursive: true });
        await writeFile(join(work, "i18n/batches/README.md"), "Batch journals");
        await writeFile(join(work, ".gitignore"), "i18n/batches/*.json\n");
        await writeFile(join(work, "main-only.txt"), "Not part of the state branch");
        git("add", ".");
        git("commit", "-m", "initial");
        git("push", "origin", "main");
        const main = git("rev-parse", "HEAD");
        const script = resolve(__dirname, "../../translation-preview/batch-state.sh");
        const checkpoint = (mode: string) => execFileSync("bash", [ script, mode ],
            { cwd: work, env, encoding: "utf8", stdio: [ "ignore", "pipe", "pipe" ] });
        checkpoint("restore");
        const path = join(work, "i18n/batches/job.json");
        await writeFile(path, '{"name":"batches/123","phase":"pending"}\n');
        checkpoint("save");
        const remoteHead = () => git("ls-remote", "origin", "refs/heads/translation-batch-state")
            .split("\t")[0];
        const first = remoteHead();
        assert.equal(git("rev-parse", "HEAD"), main);
        assert.equal(git("diff", "--cached", "--name-only"), "");
        assert.ok(!git("ls-tree", "-r", "--name-only", first).includes("main-only.txt"));
        await unlink(path);
        checkpoint("restore");
        assert.match(await readFile(path, "utf8"), /batches\/123/);
        checkpoint("save");
        assert.equal(remoteHead(), first);
        await writeFile(path, '{"name":"batches/123","phase":"complete"}\n');
        checkpoint("save");
        const last = remoteHead();
        assert.notEqual(last, first);
        assert.equal(git("rev-parse", `${last}^`), first);
        assert.equal(git("rev-parse", "HEAD"), main);
    } finally { await rm(root, { recursive: true, force: true }); }
});
