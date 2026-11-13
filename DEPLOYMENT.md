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

### 実行方法（非同期Batch API）

[Actions](https://github.com/yukitomoda/Trilium/actions) で **Translate documentation → Run workflow** を開きます。
デフォルトブランチを選択し、以下を入力します。

| 入力 | 内容 |
|---|---|
| `page_id` | 新規送信するページ。空欄なら全対象。Quick Start は `s3YCWHBfmYuM` |
| `limit` | 新規送信する翻訳単位数の上限。初期値20。正の整数 |
| `refresh` | 要確認になった機械訳も再送する場合だけ有効化 |
| `collect_only` | 有効なら既存ジョブの取得だけを行い、新規送信しない |

初回は `page_id=s3YCWHBfmYuM`、`limit=10`、他のチェックは無効で試せます。
通常の同期APIは使わず、Google公式SDKの `batches.create/get` を使います。
`limit` は金額・トークン数の上限ではありません。

送信時はジョブIDを **`translation-batch-state`** ブランチに保存して終了します。
このブランチは自動作成され、ジョブ台帳だけを保持します。削除しないでください。
デフォルトブランチへ状態保存用のコミットは追加しません。

**毎時23分の定期実行**で、処理中ジョブがある場合だけ完了を確認します。
定期実行で新規翻訳や失敗単位の再送はしません。GitHubの混雑などで実行が遅れることはあります。
早めに確認したい場合は `collect_only=true` で手動実行できます。
Batch APIは即時完了を前提としません。
[公式の非同期処理の説明](https://ai.google.dev/gemini-api/docs/batch-api)

完了した結果を原文・文脈・翻訳条件に照合して保存し、更新後のビルド・リンク検証を行って
翻訳JSONのPRを作成します。送信直後のジョブIDだけのPRは作成しません。
PRをマージするとPagesへ公開されます。人手修正は上書きせず、自動マージも行いません。
複数のジョブが別々に完了するとPRが複数になる場合があります。次の結果がそろう前にマージするか、
最新のPRに含まれる訳を確認して古いPRを整理してください。

GitHubの仕様により、Actionsが作成したPRのCIに **Approve workflows to run** が必要になる場合があります。
翻訳ワークフロー内でもテスト・更新後のビルド・リンク検証を行っています。
[公式説明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

### 失敗時と再開

ジョブ台帳を専用ブランチへ保存するため、ランナーが変わっても、完了PRをまだマージしていなくても
同じジョブと取得済み結果を再利用できます。原文をAPIへ二重送信しません。
API呼び出し失敗後も台帳と翻訳JSONを **Artifacts → translation-memory-...** に30日間保存します。

送信時の通信結果が不明なら、ジョブの重複を避けるため停止します。
その場合の復旧手順は [ジョブ台帳の説明](i18n/batches/README.md) を参照してください。
GitHubへの台帳保存に失敗した場合は、次の送信前に成果物から台帳を復旧してください。

APIキー・PR作成権限などを修正後、まず `collect_only=true` で再開します。
個別に失敗した翻訳単位を再送する場合だけ、新規翻訳を手動実行してください。

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
