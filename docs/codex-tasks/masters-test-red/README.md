# CI「Check Tax Simulator Masters」の常時の赤を直す

2026-10-08 の定期実行から、CI「Check Tax Simulator Masters」（`npm run masters:test`）は main でも全 PR でも赤のまま（#696〜#711 すべて）。原因は 2 本の試験が**実データの変化**で落ちていること。コードの不具合ではない。毛利さんの指示（2026-10-27）で直す。

## 背景と数字

`masters:test` の 68 本を 1 本ずつ流した結果（2026-10-27、main = 98a4cdd1）: **66 本は通り、落ちるのは次の 2 本だけ**。

### 問題 1: `test-check-master-freshness.js`「出典ハッシュの不一致が無い（実: 148 件）」

- 試験 6 は本物のマスターと本物の国税庁データ（`data/nta-sources/`）を突き合わせ、「マスターの `source_hash` と国税庁ページの `html_hash` が 1 件も食い違わない」ことを求めている。
- 2026-10-01 の国税庁データ月次更新で、タックスアンサーが「令和8年4月1日現在法令等」に改訂された。マスターが引くページ 30 枚（記録 148 件）のハッシュが変わり、試験が落ちた。
- この食い違いは「国税庁が出典を改訂した＝人がマスターを見直す合図」で、`scripts/check-master-freshness.js` の本来の仕事（PR へのコメント、毎月 8 日の Chatwork 通知）。同スクリプト自身も「要確認があっても異常終了はしない（通知して人が判断するため）」と書いている。**国税庁の改訂のたびにコードの試験が赤になる作りが誤り。**
- さらに、ワークフローは `masters:test` が落ちると後ろの「Check master freshness」と Chatwork 通知の段を飛ばす。**10/08 以降、出典改訂の月次通知は一度も届いていない。**
- 試験 6 がこの照合をしている本来の目的は、ファイル冒頭の `_extraction_source.html_hash` を別の出典のレコードに流用しない規則（2026-08-23 の修正）の確認。これは架空のマスターと出典で確かめられる。

### 問題 2: `test-gsc-topics.js`「20260928 の指示書掲載7語はインボイス レジだけが残る」

- 指示書 `docs/codex-tasks/weekly-signal-fixes/02-gsc-candidate-rules.md` の「テスト」は **`data/search-console/20260928/` の検索語**で確かめると定めている。ところが試験は `U.loadInputs()`（`latest.json` が指す最新週）を読んでいる。
- 最新週（20261025）には 7 語が 1 つも出てこないので、候補が 0 件になって落ちる（10/5 頃から）。
- `data/search-console/20260928/` を読めば、いまの記事でも期待どおり「インボイス レジ」（30.1 位・`newseg-retail_store-retail-invoice-guide`）だけが残る（Claude が確認済み）。
- 記事側（`content/posts`）も毎日変わる（題名の付け替え、鮮度の改稿）。所在（題名・h2・本文）が変わると、コードは正しくても試験が落ちる。指示書は「fixture として必要な部分を切り出してよい」としている。

### 同じ試験の、次に落ちる箇所

- `test-gsc-topics.js` の「今週の却下5件を既存メタデータを変えずに記録する」は `data/gsc-topics.json` の `updated_at === '2026-09-28T11:39:44.485Z'` を求めている。週次の取り込みで候補が 1 件でも増えると、`scripts/update-gsc-topics.js` が `updated_at` を書き換える（L235）。そのとき正しい動きのまま赤になる。

## 方針

- **コードの試験は、外のデータ（国税庁・サーチコンソール・記事）が変わっても結果が変わらないようにする。** 外のデータの変化は、鮮度チェックと週次 PR の仕組みで人に知らせる（既存のまま）。
- 試験を弱めない。実データで見ていた規則は、固定のデータで同じかそれ以上に確かめる。
- `masters:test` は最初の失敗で止めず、全部の試験を流してから落とす。1 本の赤が後ろの試験を隠さないようにする。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-run-all-tests.md` | `masters:test` を最後まで流す実行役 |
| 02 | `02-fixed-data-tests.md` | 鮮度の試験と GSC 候補の試験を固定データにする |

01 と 02 は独立。作業ブランチは 1 本（`fix/masters-test-red`）。

## 全段階共通の厳守事項

- 試験の対象のコード（`scripts/check-master-freshness.js`、`scripts/update-gsc-topics.js`、`scripts/lib/` の各モジュール）を変えない。直すのは試験と実行役だけ。
- マスター（`data/tax-simulator/masters/`）、国税庁データ（`data/nta-sources/`）、サーチコンソールのデータ（`data/search-console/`）、`data/gsc-topics.json`、`content/posts/*.md` を変えない。**148 件の `source_hash` を書き換えて試験を通すことは禁止**（令和8年度改正の見直しを人がする前に合図を消すことになる）。
- 既存の試験の項目を消さない。消すのは指示書が名指しした 2 か所だけで、どちらも代わりの確認を足す。
- `.github/workflows/` は、01 の R3 で `check-tax-simulator-masters.yml` の `paths` に 1 行足す以外は変えない。
- 鍵の形の文字列（長い 16 進や英数字の並び）をファイルに直書きしない。試験で使うハッシュは実行時に `crypto` で作る（Netlify の秘密情報検出でビルドが止まった前例がある）。
- ネットワークは使えない。

## 元に戻す方法

- 01: `package.json` の `masters:test` を `node a.js && node b.js && …` の形に戻し、`scripts/run-test-files.js` と試験を消す。
- 02: 2 本の試験ファイルと固定データを、このブランチの前の版に戻す。

## 受け入れ確認（Claude が行う）

- `npm run masters:test` が全部通る（68 本＋新しい試験）。
- わざと 1 本落とした状態で `masters:test` が最後まで流れ、失敗した試験の名前を最後にまとめて出し、終了コード 1 になる。
- `node scripts/check-master-freshness.js` を実データで流すと、出典の改訂 148 件が従来どおり報告される（試験から外しても合図が消えていない）。
- 架空データの試験で、「出典が変わった」「別の出典のハッシュを流用しない」の確認を外すと試験が落ちる（確認が空振りしていない）。
- 関連する試験: `test-simulator-dependencies.js`、`test-query-placement.js`、`test-search-console-ingest.js`、`test-workflow-run-injection.js`、`test-workflow-change-detection.js`、`masters:test` に登録を確かめる試験（`test-draft-branch-hygiene.js`・`test-page-structure.js`・`test-replaces.js`）。

## このブランチでやらないこと（別の作業）

令和8年度改正（C-1、`docs/tax-simulator/deferred-items.md`）。148 件の内訳は PR 本文に書く。マスターの値の見直しは毛利さんの判断と二者確認で行う。

## コードの入口

- 実行役: `package.json` の `masters:test`、`.github/workflows/check-tax-simulator-masters.yml`
- 鮮度: `scripts/check-master-freshness.js`（`check()`・`main()` の `--json`・`--as-of`、環境変数 `MASTERS_DIR`・`NTA_SOURCES_DIR`）、`scripts/lib/simulator-dependencies.js`（依存表の形）
- 架空のマスターで鮮度スクリプトを動かす前例: `scripts/lib/__tests__/test-simulator-dependencies.js` の「検証6」
- GSC 候補: `scripts/update-gsc-topics.js`（`extractGscCandidates`・`bestRankedPage`・`resolveMergedSlug`）、`scripts/lib/target-query.js`（`normalizeQuery`）、`scripts/lib/site-corpus.js`（`readAllPosts`）、`scripts/report-search-console.js`（`readPublishedPostContents`）
- 試験: `scripts/lib/__tests__/test-check-master-freshness.js`、`scripts/lib/__tests__/test-gsc-topics.js`
