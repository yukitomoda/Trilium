import type { SavedJob } from "./batch-jobs";
import type { Conditions, Memory, Unit } from "./memory";

export interface StatusPage { title: string; memory: Memory }
const keyFor = (pageId: string, unit: Unit | SavedJob["requests"][number]["units"][number]) =>
    JSON.stringify([ pageId, unit.id, unit.sourceHash, unit.contextHash ]);
const sameConditions = (left: Conditions, right: Conditions) => left.model === right.model
    && left.promptHash === right.promptHash && left.glossaryHash === right.glossaryHash;

function reasonLabel(reason: string) {
    if (reason === "Translation changed protected placeholders") return "保護マーカーの変更・欠落・順序不一致";
    if (reason === "Invalid structured translation slots") return "構造化出力のテキスト枠の不足・形式不正";
    if (reason === "Empty or invalid translation") return "空または文字列でない訳文";
    if (/^Gemini Batch API HTTP \d{3}$/.test(reason)) return reason;
    if (reason.includes("JSON")) return "返答JSONの形式不正";
    if (reason.includes("JOB_STATE_EXPIRED")) return "バッチの期限切れ";
    if (reason.includes("JOB_STATE_CANCELLED")) return "バッチのキャンセル";
    if (reason.includes("JOB_STATE_FAILED")) return "Gemini側のバッチ処理失敗";
    return "API・返答形式・ジョブのエラー（台帳を参照）";
}

export function translationStatus(pages: StatusPage[], jobs: SavedJob[], conditions: Conditions) {
    const relevant = jobs.filter((job) => sameConditions(job.conditions, conditions))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const available = new Set<string>();
    const pending = new Set<string>();
    const uncertain = new Set<string>();
    const errors = new Map<string, string>();
    const batches = relevant.map((job) => {
        let succeeded = 0;
        let failed = 0;
        let waiting = 0;
        let unknown = 0;
        for (const request of job.requests) for (const unit of request.units) {
            const key = keyFor(request.pageId, unit);
            if (typeof request.result?.translations[unit.id] === "string") {
                available.add(key); succeeded++;
            } else if ((job.phase === "pending" || (job.phase === "submitting" && job.name))) {
                pending.add(key); waiting++;
            } else if ([ "uncertain", "submitting" ].includes(job.phase)) {
                uncertain.add(key); unknown++;
            } else {
                errors.set(key, reasonLabel(request.unitErrors?.[unit.id] ?? request.error ?? job.error ?? ""));
                failed++;
            }
        }
        return { id: job.id, name: job.name ?? job.id, createdAt: job.createdAt,
            phase: job.phase, format: [ ...new Set(job.requests.map((request) => request.format
                ? "固定テキスト枠" : "従来のマーカー形式")) ].join(" / "),
            succeeded, failed, pending: waiting, uncertain: unknown };
    });
    const totals = { total: 0, translated: 0, needsReview: 0, available: 0,
        pending: 0, uncertain: 0, failed: 0, untracked: 0 };
    const reasons: Record<string, number> = {};
    const failedUnits: { pageId: string; unitId: string; reason: string }[] = [];
    const pageStats = pages.map(({ title, memory }) => {
        const counts = { total: 0, translated: 0, pending: 0, failed: 0, uncertain: 0 };
        for (const unit of memory.units.filter((unit) => unit.active)) {
            counts.total++; totals.total++;
            const key = keyFor(memory.pageId, unit);
            if (unit.translation) {
                counts.translated++; totals.translated++;
                if (unit.status === "needs-review" || unit.status === "failed") totals.needsReview++;
            } else if (available.has(key)) totals.available++;
            else if (pending.has(key)) { counts.pending++; totals.pending++; }
            else if (uncertain.has(key)) { counts.uncertain++; totals.uncertain++; }
            else if (errors.has(key) || unit.status === "failed") {
                counts.failed++; totals.failed++;
                const reason = errors.get(key) ?? reasonLabel(unit.error ?? "");
                reasons[reason] = (reasons[reason] ?? 0) + 1;
                failedUnits.push({ pageId: memory.pageId, unitId: unit.id, reason });
            } else totals.untracked++;
        }
        return { pageId: memory.pageId, title, ...counts };
    });
    return { totals, reasons, batches, pages: pageStats, failedUnits };
}

const cell = (value: string) => value.replace(/&/g, "&amp;")
    .replace(/[<>|[\]`*\\]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/[\r\n]/g, " ");

export function statusMarkdown(status: ReturnType<typeof translationStatus>, observedJobs: string[] = []) {
    const { totals } = status;
    const rows = [
        [ "保存済み翻訳単位の総数", totals.total ], [ "翻訳JSONへ反映済み", totals.translated ],
        [ "うち要確認の既存訳", totals.needsReview ], [ "正常結果を取得済み・未反映", totals.available ],
        [ "処理中", totals.pending ], [ "送信結果が不明（再送しないでください）", totals.uncertain ],
        [ "失敗して未翻訳", totals.failed ], [ "未翻訳（対応する台帳なし）", totals.untracked ]
    ];
    const lines = [ "## 翻訳の状況", "", "件数はページ数ではなく、段落・見出しなどの翻訳単位数です。保存済みの翻訳JSONと台帳に基づき集計しています。", "",
        "| 状態 | 部分数 |", "|---|---:|", ...rows.map(([ label, count ]) => `| ${label} | ${count} |`), "",
        "全体集計では再試行の重複を除き、翻訳済みの部分や再試行中の部分を失敗数へ重ねて数えません。", "" ];
    if (totals.failed) {
        lines.push("### 未解決の失敗理由", "", "| 理由 | 部分数 |", "|---|---:|",
            ...Object.entries(status.reasons).sort((a, b) => b[1] - a[1]).map(([ reason, count ]) => `| ${cell(reason)} | ${count} |`), "",
            "### 失敗が残っているページ", "", "| ページ | 失敗 | 翻訳反映済み | 総数 |", "|---|---:|---:|---:|");
        const failedPages = status.pages.filter((page) => page.failed).sort((a, b) => b.failed - a.failed);
        for (const page of failedPages.slice(0, 100)) {
            lines.push(`| ${cell(page.title)} | ${page.failed} | ${page.translated} | ${page.total} |`);
        }
        if (failedPages.length > 100) lines.push(`\nほか ${failedPages.length - 100} ページ。全件はstatus.jsonを参照してください。`);
        lines.push("", "正常な訳文はPRとして保存できます。まずそのPRを確認してください。失敗部分を再生成する場合は、新規翻訳を手動実行してください。", "");
    }
    const selected = observedJobs.length
        ? status.batches.filter((batch) => observedJobs.includes(batch.id)) : status.batches.slice(-10);
    lines.push(observedJobs.length ? "### 今回確認したバッチ" : "### 最近のバッチ（今回の取得件数ではありません）", "",
        "成功は各バッチに保存された正常な部分数です。過去の取得結果を含み、バッチ間の再試行は重複するため、この表の件数を合計しないでください。日時はUTCです。", "",
        "| バッチ | 作成日時 | 状態 | 形式 | 成功 | 失敗 | 処理中 | 不明 |", "|---|---|---|---|---:|---:|---:|---:|");
    for (const batch of selected) {
        const phase = { complete: batch.failed ? "回収済み（一部失敗）" : "回収済み",
            pending: "処理中", submitting: "送信準備・確認中", uncertain: "送信結果不明",
            failed: "ジョブ失敗" }[batch.phase];
        lines.push(`| ${cell(batch.name)} | ${cell(batch.createdAt)} | ${phase} | ${batch.format} | ${batch.succeeded} | ${batch.failed} | ${batch.pending} | ${batch.uncertain} |`);
    }
    lines.push("", "詳細な単位IDとページ別件数は、実行のArtifactsにあるtranslation-memory内のstatus.jsonを参照してください。", "");
    return lines.join("\n");
}
