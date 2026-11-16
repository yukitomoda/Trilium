import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AboutVersion { revision: string; modifiedAt: string }
const repository = "https://github.com/yukitomoda/Trilium";


export async function writeAboutPage(root: string, output: string, version: AboutVersion) {
    if (!/^[a-f0-9]{40}$/.test(version.revision) || Number.isNaN(Date.parse(version.modifiedAt))) {
        throw new Error("Invalid source version for translation information page");
    }
    const date = new Date(version.modifiedAt).toISOString().slice(0, 10);
    await mkdir(join(output, "about"), { recursive: true });
    await mkdir(join(output, "licenses"), { recursive: true });
    await cp(join(root, "apps/build-docs/translation-preview/assets/about.css"), join(output, "about.css"));
    await cp(join(root, "LICENSE"), join(output, "licenses/AGPL-3.0.txt"));
    await cp(join(root, "packages/share-theme/LICENSE"), join(output, "licenses/share-theme-Apache-2.0.txt"));
    await writeFile(join(output, "about/index.html"), `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>この翻訳について — Trilium Notes 非公式日本語訳</title>
    <link rel="stylesheet" href="/about.css">
</head>
<body>
    <header><a href="/user-guide/">← ユーザーガイド</a><span>Trilium Notes 非公式日本語訳</span></header>
    <main>
        <p class="eyebrow">このサイトについて</p>
        <h1>この翻訳について</h1>
        <aside class="notice"><strong>非公式の日本語翻訳です</strong><p>このサイトはTrilium Notesの公式サイトではありません。翻訳には誤りや未翻訳の箇所が含まれる場合があります。内容は<a href="https://docs.triliumnotes.org/user-guide/">公式の英語ドキュメント</a>とあわせてご確認ください。</p></aside>
        <section aria-labelledby="changes"><h2 id="changes">翻訳と改変について</h2>
            <p>Trilium Notesの英語ドキュメントをもとに、生成AIを用いて日本語へ機械翻訳した改変版です。原文から変更していることを、ここに明示します。</p>
            <ul><li>本文・見出しなどの日本語訳を追加しています。</li><li>非公式翻訳の表示、原文へのリンク、英語原文の表示機能を追加しています。</li><li>ドキュメント内のリンクやサブページのプレビューを翻訳サイトに合わせて調整しています。</li></ul>
            <dl><dt>改変日（UTC）</dt><dd><time datetime="${date}">${date}</time></dd>
            <dt>ソースの版</dt><dd><a class="revision" href="${repository}/tree/${version.revision}">${version.revision}</a></dd></dl>
            <p class="muted">公開版の改変日は、ビルド対象コミットの更新日時に基づきます。</p>
        </section>
        <section aria-labelledby="license"><h2 id="license">ライセンスと著作権表示</h2>
            <p>本リポジトリは <strong>GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）</strong> の下で公開されています。日本語訳と翻訳サイトの改変部分も、このライセンスの下で提供します。</p>
            <p>原著の著作権表示：<br><span lang="en">Copyright 2017-2025 zadam, Elian Doran, and other contributors</span></p>
            <p><a href="/licenses/AGPL-3.0.txt">AGPL v3のライセンス正文（英語）</a> · <a href="${repository}/blob/${version.revision}/LICENSE">リポジトリのLICENSE</a></p>
            <p>静的サイトの共有テーマは <strong>Apache License 2.0</strong> です。<a href="/licenses/share-theme-Apache-2.0.txt">共有テーマのライセンス正文（英語）</a> · <a href="${repository}/blob/${version.revision}/packages/share-theme/LICENSE">リポジトリの共有テーマLICENSE</a>を参照してください。その他の依存ライブラリや第三者の素材には、それぞれのライセンスと著作権表示が適用されます。</p>
        </section>
        <section aria-labelledby="source"><h2 id="source">ソースコードと翻訳データ</h2>
            <p>翻訳処理、サイトの生成処理、保存済みの翻訳データはGitHubで公開しています。</p>
            <p><a href="${repository}">yukitomoda/Trilium — GitHubリポジトリ</a></p>
            <ul><li><a href="${repository}/tree/${version.revision}">この版のソースコード</a></li><li><a href="${repository}/tree/${version.revision}/i18n/translations/ja">保存済みの日本語翻訳データ</a></li><li><a href="${repository}/issues">翻訳の誤り・問題を報告する</a></li></ul>
        </section>
    </main>
    <footer><a href="/user-guide/">ユーザーガイド</a><a href="https://docs.triliumnotes.org">公式ドキュメント</a><span>Trilium Notes 非公式日本語訳</span></footer>
</body>
</html>\n`);
}
