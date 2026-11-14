# 日本語翻訳の保存と更新

原文は `docs/` に保ち、翻訳の正本は `translations/ja/<ページID>.json` に保存します。
このディレクトリは Git 管理対象です。生成された HTML だけを編集しないでください。

対象は User Guide 全ページです。設定ファイルの `pageIds: "all"` により、
原文メタデータに追加されたページも対象になります。特定ページだけ試す場合は、
`pageIds` にページIDの配列を指定できます。
Developer Guide と Release Notes は今回の対象に含めません。
対象とモデルは `apps/build-docs/translation-preview/config.json` で設定します。
モデルの初期値は `gemini-3.5-flash-lite` です。
Google公式の `@google/genai` SDKから **Gemini Batch API** を呼び出します。
通常の同期 `models.generateContent` は使いません。送信は `batches.create`、取得は `batches.get` です。
SDKの `enterprise` と `vertexai` を明示的に `false` にしているため、
Enterprise Agent Platform 用の環境変数があっても接続先を切り替えません。
SDKの利用方法は [公式ドキュメント](https://ai.google.dev/gemini-api/docs/libraries)、
非同期処理は [Batch APIの説明](https://ai.google.dev/gemini-api/docs/batch-api) を参照してください。

## 操作

リポジトリのルートで実行します。

```sh
mise install
mise exec -- pnpm install --frozen-lockfile

# 原文のスナップショット作成＋保存済み翻訳から静的サイトを生成。API呼び出しなし。
mise exec -- pnpm docs:ja:build

# 翻訳対象の件数と文字数を確認。読み取りのみ。
mise exec -- pnpm docs:ja:plan

# 必要なら、APIを呼ばずに原文・未翻訳の単位をJSONへ保存。
mise exec -- pnpm docs:ja:extract

# 初回は一部だけ試すことも可能。
mise exec -- pnpm docs:ja:translate --page s3YCWHBfmYuM --limit 10

# 選択済みページの未翻訳・失敗部分を非同期Batch APIへ送信。
mise exec -- pnpm docs:ja:translate

# 時間をおいて完了結果を取得。処理中なら後で同じコマンドを再実行。
# このコマンドは新しいジョブを送信しません。
mise exec -- pnpm docs:ja:collect

# 保存したJSONからサイトを再生成。API呼び出しなし。
mise exec -- pnpm docs:ja:build --skip-client-build
mise exec -- pnpm docs:ja:preview
```

API キーは `GEMINI_API_KEY` または `GOOGLE_API_KEY` 環境変数に設定します。
翻訳コマンドだけは、ルートの `.env.local` からも読み込みます。
`.env.local` は `.gitignore` 対象です。チャットや Git にキーを貼り付けないでください。

```dotenv
GEMINI_API_KEY=your-key-here
```

キーがなくても、計画・原文抽出・保存済み訳からのビルド・テストは動きます。
1リクエストを最大16単位・原文約10,000文字に分割し、選択したリクエスト群を
1つのBatch APIジョブにまとめて非同期送信します。1単位が文字数上限を超える場合は単独で送ります。
現在はインライン入力を使用し、SDKへ渡す入力が19MBを超える場合は送信せず停止します。
`--limit` を減らして分割してください。金額やトークン数の上限ではありません。

`translate` は既存ジョブを確認した後、未送信の単位だけを新規送信して終了します。
`collect` は既存ジョブの取得だけを行います。長時間のポーリング待機は行いません。
Batch APIは非同期のため、送信直後には訳文がそろわないことがあります。
完了までの目標時間は公式資料では24時間です。

ジョブID・リクエストと原文の対応・結果を `i18n/batches/` に永続化します。
ローカルではこのディレクトリを残してください。CIでは専用ブランチに保存します。
[台帳の形式と送信状態の復旧](batches/README.md)も参照してください。

## JSONの内容

ページID、原稿ファイル、原文コミット、各翻訳単位、APIの使用トークン数を保存します。
単位ごとに以下を持ちます。

- `id`：種類と原文のハッシュから作る識別子。同じ段落の前に別の段落が増えても変わりません。
- `source` / `sourceHash`：原文と変更検出用ハッシュ。
- `context` / `contextHash`：ページタイトルと見出しの文脈。
- `translation`：日本語訳。
- `status`：`pending`、`translated`、`reviewed`、`needs-review`、`failed`。
- `active`：現在の原文で使われているか。削除・変更前の訳は非アクティブで残します。
- `conditions`：モデル、翻訳プロンプトと用語集のハッシュ。
- `translatedAt`：対応するバッチの作成日時。
- `requests[].batchJob` / `requestKey`：結果を取得したBatch APIジョブとリクエストの識別子。

本文中の HTML、URL、コード、数式などは `__TRILIUM_PH_0__` のようなトークンで保護します。
トークンは原文の構造から復元し、AIが新しいHTMLを埋め込むことはできません。
各トークンの数・順序が変わった応答、ID重複、応答欠落、不完全な応答は保存しません。

## 人手修正

`translation` を修正し、`manual: true` または `status: "reviewed"` を設定します。
`source`、ID、ハッシュと保護トークンは変更しません。保護トークンの削除も不可です。
人手修正した訳は `--refresh` を指定しても自動翻訳で上書きしません。

原文自体が変わった場合は新しい単位を翻訳し、以前の訳は履歴として残します。
本文が同じでも文脈が変わった場合、既存訳を `needs-review` として保持します。
用語集・プロンプト・モデルが変わった場合も同様に、一斉再翻訳はしません。
機械訳の要確認部分を再翻訳する場合だけ、対象を選んで実行します。

```sh
mise exec -- pnpm docs:ja:plan --refresh
mise exec -- pnpm docs:ja:translate --refresh --page s3YCWHBfmYuM
```

送信前に台帳へ意図を記録し、ジョブIDを取得したら即座に保存します。
処理中の同じ原文・文脈・翻訳条件は再送しません。ジョブ作成時の通信結果が不明な場合も、
自動リトライで二重ジョブを作ることはせず、台帳を残して停止します。
完了結果はキーで照合し、妥当なリクエストだけを翻訳JSONへ原子的に保存します。
原文や文脈が変わった結果は現在の訳文へ適用しません。
複数の翻訳コマンドをローカルで同時には実行しないでください。

## 原文更新と表示

原文や対象ページを更新したら、先に `docs:ja:build` を実行してスナップショットを更新します。
翻訳コマンドは原稿とメタデータのハッシュを検査し、古いスナップショットなら停止します。
未翻訳部分は英語で表示し、ページに未翻訳件数を表示します。
訳文がそろっている場合は、日本語本文・タイトル・ナビゲーション・目次・検索へ反映します。

英語原文はページに同梱されます。切り替え時にAIや公式サイトへ問い合わせません。
原文の見出しID・リンク先は翻訳時に保護し、日本語版でも同じアンカーを使用します。

## 検証

```sh
mise exec -- pnpm docs:ja:test
# プレビューサーバー起動中に実行。Chromiumの導入手順はアプリ側READMEを参照。
mise exec -- pnpm docs:ja:check
```

Batch APIテストにはSDK経由のモック応答を使います。実際の翻訳品質とモデルへのアクセス可否は、
APIキーを設定した実翻訳で確認する必要があります。

## GitHub Pagesへの公開

公開用CI/CDと初回設定は [DEPLOYMENT.md](../DEPLOYMENT.md) を参照してください。

GitHub Actionsでの翻訳は **Translate documentation** を手動実行します。
必要な `GEMINI_API_KEY` 変数、PR作成権限、入力項目、途中結果の再開方法も上記公開手順に記載しています。
