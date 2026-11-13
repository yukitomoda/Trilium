# 日本語ドキュメントサイト

公式の Trilium 共有テーマ・静的エクスポートを使います。
翻訳結果は `i18n/translations/ja/<ページID>.json` で Git 管理し、APIなしで再ビルドできます。
翻訳の設定・保存形式・差分更新・人手修正は [i18n/README.md](../../../i18n/README.md) を参照してください。

```sh
mise exec -- pnpm docs:ja:build
mise exec -- pnpm docs:ja:preview
```

http://localhost:9001/ を開きます。公開用ファイルは `site-ja/` です。
ビルド時に `site-ja/` と `.generated/translation-preview/` を作り直します。
`docs/`、翻訳JSON、通常の `site/` は書き換えません。ビルド中にAPIは呼びません。
クライアントのアセットを変更していなければ、`--skip-client-build` で再利用できます。

対象は `config.json` の `pageIds` で指定し、祖先ページも含めて生成します。
翻訳モードでは保存済みの訳を使い、未翻訳は英語のまま件数を表示します。
以前の表示確認用モードは `docs:ja:build --identity` で利用できます。

全ページに非公式表示と公式原文リンクを表示します。原文切り替えは同梱データを使用します。
本文リンクは、対象ページならサイト内、対象外なら公式サイトへ向けます。
公式URL・Markdownの相対リンクともに、クエリと見出しアンカーを保持します。

## ブラウザ検証

プレビューサーバーを起動した状態で実行します。

```sh
mise exec -- pnpm exec playwright install chromium
# OSライブラリが不足する環境では playwright install-deps chromium も必要です。
mise exec -- pnpm docs:ja:check
```

案内、原文切り替え、公式リンク、画像、ローカルリンク、検索、モバイルの横はみ出しを確認します。
`PREVIEW_URL` 環境変数で検証先を変更できます。
