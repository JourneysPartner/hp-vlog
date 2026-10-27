あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/article-seo/` にあります。まず `README.md` を読み、次に `03-gsc-loop.md` を実装してください。`01-page-structure.md` と `02-target-query.md` は実装済みです（このブランチに入っています）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/article-seo-p3` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。
- 指示書の R 番号を実装順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。外部 API は呼べないので、LLM 選別は偽の関数でテストしてください。実データは `data/search-console/20260925/` にあります（テストの fixture に使ってよい）。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。

## 厳守

- `content/posts/*.md` を触らない。
- 既存のレポートの節の順番と文言を変えない（列と節の追加のみ）。
- サジェスト側の選別プロンプトの文言を変えない。
- 鮮度設計の第 2 段階（部分再生成・更新日）は実装しない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-query-placement.js
node scripts/lib/__tests__/test-gsc-topics.js
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/report-search-console.js
node scripts/build-freshness-candidates.js
node scripts/generate-draft.js --dry-run
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R5 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 実データで出た「伸ばしやすい語」の所在・推奨の表（上位 10 行）と、`seo_growable` が付いた更新候補の一覧
3. GSC 由来の候補になる語の一覧（LLM 選別は呼べないので、選別前の抽出結果だけ）
4. ワークフローに足した手順
5. 【要判断】【要確認】として残した点
6. 毛利さん向けの確認方法（次の月曜の週次 PR で見る場所を 3 つまで）
