あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/weekly-signal-fixes/` にあります。まず `README.md` を読み、次に `01-freshness-source-change.md` と `02-gsc-candidate-rules.md` を実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/weekly-signal-accuracy` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取り（log・show）は使えます（01 の R4 で使う）。
- 指示書の R 番号を順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。国税庁へのアクセスと LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- この環境では子プロセスで node を起動するテスト（build を呼ぶもの）が EPERM で落ちることがあります。その場合は落ちたテスト名だけ報告してください。別の担当が環境の外で再実行します。

## 厳守

- `content/posts/*.md` を触らない。
- 週次レポートの節の順番と既存の文言を変えない（指示書にある文言の追加のみ）。
- 鮮度の他の信号と重みを変えない。
- LLM 選別プロンプト・記事生成プロンプトの文言を変えない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/backfill-nta-content-changed.js --dry-run
node scripts/backfill-nta-content-changed.js
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-nta-content-change.js
node scripts/lib/__tests__/test-nta-index-builder.js
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-gsc-topics.js
node scripts/lib/__tests__/test-query-placement.js
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/build-freshness-candidates.js
node scripts/report-search-console.js
git status --short
git diff --stat
```

`build-freshness-candidates.js` と `report-search-console.js` が書き換えた `data/freshness/` と `data/search-console/report.md` は、確認後に `git checkout -- data/freshness data/search-console/report.md` で元に戻してください（週次の実行で作り直すため、このブランチには含めない）。

## 最終報告（そのまま PR 本文になります。日本語で）

1. 01 の R1〜R4、02 の R1〜R5 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 補正スクリプトの結果: `first_fetched_at` を入れた件数、`content_changed_at` が付いた項目の一覧（id・種類・日付・kind）
3. 実データでの更新候補の上位 10 件（理由つき）。「2026-06-21 に更新」を理由にした候補が 0 件か
4. 実データ（20260928）での GSC 由来候補の抽出結果（LLM 選別前）と、`README.md` の表との一致
5. 週次レポートの「伸ばしやすい語」で所在・推奨が同義語で変わった行
6. 【要判断】【要確認】として残した点
7. 毛利さん向けの確認方法（次の月曜の週次 PR で見る場所を 3 つまで）
