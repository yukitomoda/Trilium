# 日本語翻訳の保存と更新

原文は `docs/` に保ち、翻訳の正本は `translations/ja/<ページID>.json` に保存します。
このディレクトリは Git 管理対象です。生成された HTML だけを編集しないでください。

初期対象は User Guide、Quick Start、FAQ、Note Types の4ページです。
対象とモデルは `apps/build-docs/translation-preview/config.json` で設定します。
モデルの初期値は `gemini-3.5-flash-lite` です。
Google公式の `@google/genai` SDKから Gemini API を呼び出します。
SDKの `enterprise` と `vertexai` を明示的に `false` にしているため、
Enterprise Agent Platform 用の環境変数があっても接続先を切り替えません。
SDKの利用方法は [公式ドキュメント](https://ai.google.dev/gemini-api/docs/libraries) を参照してください。

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

# 選択済みページの未翻訳・失敗部分を翻訳。
mise exec -- pnpm docs:ja:translate

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
翻訳はリクエストごとに最大16単位・原文約10,000文字をまとめて逐次実行します。
1単位が上限を超える場合、その単位だけを送ります。
`--limit` は実行全体の翻訳単位数の上限です。金額やトークン数の上限ではありません。

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
- `translatedAt`：翻訳した日時。

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

成功したバッチごとにJSONを一時ファイル経由で保存します。
途中の失敗後は、同じコマンドを実行すると未完了部分から再開します。
複数の翻訳コマンドを同時には実行しないでください。

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

APIテストにはモック応答を使います。実際の翻訳品質とモデルへのアクセス可否は、
APIキーを設定した実翻訳で確認する必要があります。

## GitHub Pagesへの公開

公開用CI/CDと初回設定は [DEPLOYMENT.md](../DEPLOYMENT.md) を参照してください。

GitHub Actionsでの翻訳は **Translate documentation** を手動実行します。
必要な `GEMINI_API_KEY` 変数、PR作成権限、入力項目、途中結果の再開方法も上記公開手順に記載しています。
