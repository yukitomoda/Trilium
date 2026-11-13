# GitHub Pages への公開

このプロジェクトのCI/CDは、公開用の `.github/workflows/pages.yml` と
手動翻訳用の `.github/workflows/translate.yml` で構成しています。
Trilium本体のリリース、Docker、デスクトップ、モバイル、Cloudflare向けの旧ワークフローと
専用ローカルActionsは削除しました。依存関係の自動更新設定は維持しています。

## 初回設定

1. この翻訳プロジェクト用のGitHubリポジトリに変更をpushします。
2. リポジトリの **Settings → Pages → Build and deployment → Source** で
   **GitHub Actions** を選びます。
3. デフォルトブランチへpushするか、Actionsの
   **Build and deploy translated documentation → Run workflow** を実行します。
4. 完了後、`github-pages` 環境とワークフローのデプロイステップに公開URLが表示されます。

Pages公開を利用できるリポジトリ・プランであることが前提です。
`github-pages` 環境に承認やブランチ制限を設定している場合は、そのルールが適用されます。

GitHub公式手順:
[公開元の設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、
[カスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

公開先リポジトリは `yukitomoda/Trilium` です。
このワークスペースのプレビューURLはGitHub Pagesの公開URLとは別です。

## CI/CDの処理

- PR：翻訳処理のテスト、静的サイト生成、生成物・リンク検証、Pages artifactの作成。
- デフォルトブランチへのpush：上記の検証後、GitHub Pagesへデプロイ。
- 手動実行：デフォルトブランチなら検証後にデプロイ。それ以外はビルド・検証のみ。
- デフォルトブランチ以外へのpush：実行対象外。

GitHub標準の `GITHUB_TOKEN` とOIDCを使用します。追加のデプロイトークンは不要です。
デプロイジョブだけに `pages: write` と `id-token: write` を付与しています。
公式Actionsは検証したリリースのコミットSHAに固定しています。

ビルドには既存の共有テーマが必要なため、Triliumのクライアントのアセットも生成しますが、
本体のリリースや配布物の公開は行いません。

## GitHub Actionsで翻訳を実行する

### 必要な設定

1. [Settings → Secrets and variables → Actions → Variables](https://github.com/yukitomoda/Trilium/settings/variables/actions)
   で **New repository variable** を選び、名前を **`GEMINI_API_KEY`**、値をGemini APIキーにします。
   同名のActions Secretにも対応し、両方設定されている場合はSecretを優先します。
2. [Settings → Actions → General](https://github.com/yukitomoda/Trilium/settings/actions) の
   **Workflow permissions → Allow GitHub Actions to create and approve pull requests** を有効にします。
   ワークフロー自身に必要な `contents: write` と `pull-requests: write` を指定しているため、
   リポジトリ全体の既定権限をwriteへ広げる必要はありません。
3. Pagesは前述のとおり **Source: GitHub Actions** にします。

APIキーは翻訳ステップにだけ渡し、ログではマスクします。生成HTMLや翻訳JSONへ保存しません。
認証とPR保存は標準の `GITHUB_TOKEN` を使用し、追加のPATは不要です。
モデルは設定ファイルの `gemini-3.5-flash-lite` を使います。

### 実行方法

[Actions](https://github.com/yukitomoda/Trilium/actions) で **Translate documentation → Run workflow** を開きます。
デフォルトブランチを選択し、以下を入力します。

| 入力 | 内容 |
|---|---|
| `page_id` | 空欄なら設定された全ページ。例：Quick Start は `s3YCWHBfmYuM` |
| `limit` | 実行全体の翻訳単位数上限。初期値20。正の整数を指定 |
| `refresh` | 要確認になった機械訳も再翻訳する場合だけ有効化 |

初回は `page_id=s3YCWHBfmYuM`、`limit=10`、`refresh=false` がおすすめです。
`limit` は金額・トークン数の上限ではありません。API利用料はこの翻訳ワークフローで発生します。

ワークフローは原文をビルドして計画を表示し、差分翻訳後に再ビルド・リンク検証を行い、
翻訳JSONを `translations/run-...` ブランチへ保存してPRを作成します。
PRを確認してマージすると、Pages公開ワークフローが動きます。自動マージは行いません。

GitHubの仕様により、Actionsが作成したPRのCIに **Approve workflows to run** が必要になる場合があります。
翻訳ワークフロー内でもテスト・更新後のビルド・リンク検証を行っています。
[公式説明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

### 失敗時と再開

翻訳ステップは最大30分です。APIエラーや翻訳の失敗があっても、完成済みバッチのJSONを
**Artifacts → translation-memory-...** に30日間保存します。
変更があれば途中結果もPRへ保存し、ワークフロー自体は失敗として報告します。
PR作成権限などに問題がある場合も、成果物からJSONを取得できます。

途中結果のPRを先にマージしてから再実行すると、その結果を再利用して未完了部分から続行します。
マージ前に同じ範囲をもう一度実行すると、未マージの訳は読み込まれないため再翻訳されます。

## 翻訳と公開は別処理

Pages公開ワークフローは保存済みJSONだけを読み、APIキーを参照せず、AI翻訳を行いません。
ローカルで翻訳JSONを更新してpushする従来の操作も利用できます。

原文、翻訳メモリ、プロンプト、用語集、ビルド設定をGit管理してください。
公開物の `site-ja/` と中間生成物の `.generated/` はコミットしません。
現在の対象は設定された4ページです。未翻訳部分は英語で表示されます。

翻訳設定と人手修正は [i18n/README.md](i18n/README.md) を参照してください。

## 公開パス

Pagesの設定から公開URLとベースパスを取得します。
`https://owner.github.io/repository/`、`https://owner.github.io/`、カスタムドメインに対応します。
PRではリポジトリ名からパスを求めて検証します。

ベースパスは翻訳JSONの読み込み・原文スナップショット作成後に付けるため、
公開先の変更だけで原文ハッシュや翻訳単位IDが変わることはありません。
本文リンク、原文表示用テンプレート内のリンク、追加CSS・JS、トップの転送先も対象です。

ローカルでPages形式の生成物を確認する場合:

```sh
DOCS_BASE_PATH=/my-repository mise exec -- pnpm docs:ja:build
DOCS_BASE_PATH=/my-repository mise exec -- pnpm docs:ja:validate
```

この出力は `/my-repository/` にマウントして配信してください。
通常のワークスペースプレビューへ戻すには、ベースパスなしで再ビルドします。

```sh
mise exec -- pnpm docs:ja:build --skip-client-build
mise exec -- pnpm docs:ja:validate
```

`docs:ja:validate` はHTML・同梱原文のローカルURLとファイルの存在、非公式表示、
Pages artifactに使用できる通常ファイルであることを確認します。
