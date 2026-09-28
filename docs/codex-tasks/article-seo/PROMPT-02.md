あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/article-seo/` にあります。まず `README.md` を読み、次に `02-target-query.md` を実装してください。`01-page-structure.md` は実装済みです（このブランチに入っています）。`03-*.md` はこの回では実装しません。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/article-seo-p2` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。
- 指示書の R 番号を実装順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。外部 API は呼べないので、LLM を使う関数は必ず `callLLM` を引数で受け取り、テストは偽の関数で行ってください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- 隔離内では子プロセスで `node` を起動するテストが EPERM で落ちることがあります。その場合はその旨を最終報告に書いてください。

## 厳守

- `content/posts/*.md` を触らない（既存記事の slug も）。
- 税務の記述をプロンプトに新しく足さない（配置・長さ・型の指示だけ）。`CONDITIONAL_RULES`・数値の階層・年分・出典の引用ルール・免責文・CTA を変えない。
- トピックプール側の `slug` を変えない。記事の URL になる `slug` と `topic_id` を分ける。
- 既存の選定フィルタを弱めない。新ゲートは追加のみ。
- 手動承認の流れを変えない。
- `STATIC_RULES` は prompt caching の対象なので、指示書に書いた差し替え箇所以外の文字を変えない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-target-query.js
node scripts/lib/__tests__/test-seo-lint.js
node scripts/lib/__tests__/test-word-count-by-intent.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-selector.js
node scripts/lib/__tests__/test-conditional-rules.js
node scripts/generate-draft.js --dry-run
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R9 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. `STATIC_RULES` の差し替え前後の文言（SEO ルールの節とタイトルの節）
3. 生成フローの変更点を順番に（選定 → 検索語の確定 → 取り下げ → 生成 → 点検 → 再生成 → frontmatter）
4. frontmatter に増えた項目と、`slug` / `topic_id` の関係
5. 【要判断】【要確認】として残した点
6. 毛利さん向けの確認方法（次の日次生成で見る場所を 3 つまで）
