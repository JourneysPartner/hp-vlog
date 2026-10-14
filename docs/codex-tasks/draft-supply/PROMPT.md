あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/draft-supply/` にあります。まず `README.md` を読み、次に `01-withdrawn-and-retry.md`・`02-draft-ran-check.md`・`03-title-refresh-test.md` を実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/draft-supply` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取り（log・show）は使えます（03 の基準作りで使う）。
- 03 は最初に基準コミット `700de4ab` で旧ハッシュが一致することを確かめてから進めてください。
- 指示書の R 番号を順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。LLM 呼び出しと GitHub 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- この環境では子プロセスで node を起動するテスト（build を呼ぶもの）が EPERM で落ちることがあります。その場合は落ちたテスト名だけ報告してください。別の担当が環境の外で再実行します。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、01 で `daily-draft.yml` を変えるためコミット前は必ず落ちます。直さないでください。

## 厳守

- `content/posts/*.md` を触らない。
- 既存の選定フィルタ・閾値・優先度、AI 重複判定と生成後の重複判定の中身、記事生成・重複判定・LLM 選別のプロンプト文言を変えない。新しい除外は追加のみ。
- `--force-slug` と 2 本モードの既存の動き、`regenerate-draft.yml`・`publish-scheduled.yml`・差し戻し再生成の経路を変えない。
- ワークフローは追加と、指示書に書いた差し替えだけ。既存ステップの順番・条件・文言を変えない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-draft-schedule.js
node scripts/lib/__tests__/test-title-refresh.js
node scripts/lib/__tests__/test-selector.js
node scripts/lib/__tests__/test-denylist.js
node scripts/lib/__tests__/test-ai-dedup.js
node scripts/lib/__tests__/test-pending-drafts-dedup.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
node scripts/lib/__tests__/test-demand-driven-selection.js
node scripts/lib/__tests__/test-topic-identity-dedup.js
node scripts/lib/__tests__/test-crawl-queue-cadence.js
node scripts/lib/__tests__/test-netlify-ignore.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-draft-branch-hygiene.js
git status --short
git diff --stat
```

`npm run build` が書き換えた追跡対象のファイルがあれば、確認後に元に戻してください（このブランチには含めない）。

## 最終報告（そのまま PR 本文になります。日本語で）

1. 01 の R1〜R5、02 の R1〜R3、03 の R1〜R3 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 01 のテスト 8（実データ）: `filter-withdrawn` が外した件数と topic_id、代わりに選ばれた topic_id
3. 02: 2026-10-04〜10-09 の各点検時刻で計算した「直近の生成予定」と判定
4. 03: 基準コミット `700de4ab` で旧ハッシュが一致したか。1 本ごとの基準ハッシュをどう計算したか
5. 上の「完了時に実行するもの」の結果（EPERM で落ちたものは名前だけ）
6. 【要判断】【要確認】として残した点
7. 毛利さん向けの確認方法（次の月・水・金の生成と翌朝の点検で見る場所を 3 つまで）
