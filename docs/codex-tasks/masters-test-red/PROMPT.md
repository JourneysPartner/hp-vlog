あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/masters-test-red/` にあります。まず `README.md` を読み、次に `01-run-all-tests.md` と `02-fixed-data-tests.md` を実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/masters-test-red` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取り（log・show・diff）は使えます。
- 指示書の R 番号を順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」と README の「全段階共通の厳守事項」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF・UTF-8（BOM なし）で書いてください。
- この環境では子プロセスで node を起動するテストが EPERM で落ちることがあります（01 の R4、02 の R2、`masters:test` 全体が該当しうる）。その場合は落ちたテスト名とエラーの 1 行目だけ報告してください。別の担当が環境の外で再実行します。EPERM を避けるために、子プロセスを使わない形へ試験の設計を変えないでください。

## 厳守

- 試験の対象のコード（`scripts/check-master-freshness.js`、`scripts/update-gsc-topics.js`、`scripts/lib/` の各モジュール）を変えない。
- マスター（`data/tax-simulator/masters/`）、`data/nta-sources/`、`data/search-console/`、`data/gsc-topics.json`、`content/posts/*.md` を変えない。`source_hash` を書き換えて試験を通すことは禁止。
- 既存の試験の項目は、指示書が名指しした 2 か所以外を消さない・緩めない。
- `.github/workflows/` は 01 の R3 の 1 行だけ。
- 鍵の形の文字列（長い 16 進や英数字の並び）をファイルに直書きしない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
node --check scripts/run-test-files.js
node scripts/lib/__tests__/test-run-test-files.js
node scripts/lib/__tests__/test-check-master-freshness.js
node scripts/lib/__tests__/test-gsc-topics.js
node scripts/lib/__tests__/test-simulator-dependencies.js
node scripts/lib/__tests__/test-query-placement.js
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/lib/__tests__/test-draft-branch-hygiene.js
node scripts/lib/__tests__/test-page-structure.js
node scripts/lib/__tests__/test-replaces.js
node scripts/lib/__tests__/test-workflow-change-detection.js
node scripts/lib/__tests__/test-workflow-run-injection.js
npm run masters:test
node scripts/check-master-freshness.js --as-of 2026-10-27
git status --short
git diff --stat
```

`check-master-freshness.js` の出力は全文でなく、「出典が更新されました（N 件）」の行と件数の要約だけでよい。

## 最終報告（日本語で）

1. 01 の R1〜R4、02 の R1〜R4 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. `package.json` の `masters:test` の一覧が、元の `&&` の並びと同じ 68 本・同じ順番で、最後に `test-run-test-files.js` が足されたことの確認方法と結果
3. 固定データ `gsc-candidates-20260928.json` の中身の要約（`queries` 7 行、`queryPages` の行数、`posts` と `postContents` の slug 一覧、ファイルの大きさ）
4. `check-master-freshness.js --as-of 2026-10-27` で報告された出典の改訂の件数
5. EPERM などで環境の中で確かめられなかった試験
6. 【要判断】【要確認】として残した点
