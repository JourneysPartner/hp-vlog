# 02 鮮度の試験と GSC 候補の試験を固定データにする

背景は `README.md` の「問題 1」「問題 2」。

## A. `scripts/lib/__tests__/test-check-master-freshness.js`

### R1 試験 6 から「実データのハッシュ一致」を外す

- 試験 6 の `assert(f.hashMismatch.length === 0, '出典ハッシュの不一致が無い…')` を消す。
- 代わりに件数を参考として出す（落とさない）: `  - 参考: 実データの出典の改訂 N 件（試験の対象外。鮮度チェックが PR のコメントと Chatwork で知らせる）`
- 試験 6 の上の説明を書き直す。「国税庁が出典を改訂すると食い違いが出るのは正しい動き（人がマスターを見直す合図）なので、コードの試験では数えない。流用しない規則は試験 7 の架空データで確かめる」という趣旨。
- 試験 6 の他の 4 項目（台帳に無い出典・`source_hash` 未記録・出典ファイルの欠落・理由の無い blocked）は**そのまま残す**。これらはマスター自身の形の確認で、国税庁の改訂では変わらない。

### R2 試験 7: 架空のマスターと出典で、鮮度スクリプトを丸ごと動かす

一時フォルダ（`fs.mkdtempSync(path.join(os.tmpdir(), ...))`）に架空のマスターと国税庁データを作り、`scripts/check-master-freshness.js --as-of 2026-08-23 --json` を子プロセスで動かして、標準出力の JSON の `findings` を確かめる。前例は `test-simulator-dependencies.js` の「検証6」。後片付けは `finally`。

- 子プロセスの環境変数: `MASTERS_DIR`・`NTA_SOURCES_DIR` を一時フォルダに向ける。**`GITHUB_OUTPUT` は消す**（CI の中で動くと、スクリプトが CI の出力ファイルに書き込んでしまう）。
- ハッシュは `crypto.createHash('sha256').update('<名前>').digest('hex')` で実行時に作る。直書きしない。以下 `h('A-old')` のように書く。

架空データ:

- `simulator-dependencies.json`: 4 つのシミュレーター（`hojinnari`・`shohizei`・`sozoku`・`yakuin_hoshu`）がどれも `required: []`・`optional: []`。
- `sources/source-registry.json`: 出典 3 件。どれも `kind: 'taxanswer'`・`coverage_basis: 'none'`・`label`・`url`（`https://example.invalid/...`）を持つ。
  - `TA-A`: `category: 'sozoku'`・`taxanswer_id: '9001'`
  - `TA-B`: `category: 'sozoku'`・`taxanswer_id: '9002'`
  - `TA-C`: `category: 'shotoku'`・`taxanswer_id: '9003'`
- 国税庁データ `taxanswer/<category>/<id>.json`:
  - `sozoku/9001.json`: `html_hash: h('A-new')`・`law_version: '令和8年4月1日現在法令等'`
  - `sozoku/9002.json`: `html_hash: h('B-cur')`
  - `shotoku/9003.json`: `html_hash: h('C-new')`
- マスター `data/` の 2 ファイル（レコードはすべて `data_review_status: 'approved'`）:
  - `file-a.json`: `_extraction_source: { taxanswer_id: '9001', html_hash: h('A-old') }`
    - `INHERIT-CHANGED`: 出典 `TA-A`、`source_hash` 無し（冒頭の控えを使う → 出典が変わったので食い違い）
    - `FOREIGN-NO-HASH`: 出典 `TA-B`、`source_hash` 無し（冒頭は 9001 のものなので流用しない → 未記録）
    - `OWN-STALE`: 出典 `TA-C`、`source_hash: h('C-old')`（食い違い）
  - `file-b.json`: `_extraction_source: { taxanswer_id: '9002', html_hash: h('B-cur') }`
    - `INHERIT-CURRENT`: 出典 `TA-B`、`source_hash` 無し（冒頭の控えを使う → 一致）
    - `OWN-CURRENT`: 出典 `TA-A`、`source_hash: h('A-new')`（一致）
    - `OWN-OVERRIDES-HEADER`: 出典 `TA-B`、`source_hash: h('B-old')`（自分の控えが冒頭より優先 → 食い違い）

確かめること（実行 1: 上のまま）:

- `hashMismatch` の `record_id` がちょうど `INHERIT-CHANGED`・`OWN-OVERRIDES-HEADER`・`OWN-STALE` の 3 件（順不同、過不足なし）。
- `hashUntracked` の `record_id` がちょうど `FOREIGN-NO-HASH` の 1 件。
- `INHERIT-CHANGED` の項目: `recorded_hash` が `h('A-old')` の先頭 12 文字、`current_hash` が `h('A-new')` の先頭 12 文字、`law_version` が `'令和8年4月1日現在法令等'`。
- `sourceMissing`・`sourceUnknown` が 0 件。
- 終了コードが 0（出典の改訂があってもスクリプトは落ちない。通知して人が判断する設計）。

確かめること（実行 2: `shotoku/9003.json` を消してから）:

- 終了コードが 1。
- `sourceMissing` に `TA-C` が 1 件（ワークフローの「Fail if sources are unreachable」が拠り所にしている動き）。

## B. `scripts/lib/__tests__/test-gsc-topics.js`

### R3 「20260928 の指示書掲載7語」を固定データで確かめる

固定データ `docs/codex-tasks/weekly-signal-fixes/gsc-candidates-20260928.json`（新規。同じフォルダの `rejected-topics-20260928.json` の隣）を作る。中身:

- `_note`: 何の固定データか、どこから写したか、作り直さないこと（下の作り方を文章で）。
- `queries`: `data/search-console/20260928/queries.json` の `rows` から、7 語（`youtube 源泉徴収`・`レジ 現金過不足`・`経費 ガソリン代`・`確定申告 帳簿`・`人工代`・`簡易インボイス`・`インボイス レジ`）の行を**そのまま**写す（7 行）。
- `queryPages`: `data/search-console/20260928/query-page.json` の `rows` から、`normalizeQuery(row.query)`（`scripts/lib/target-query.js`）が 7 語のどれかの `normalizeQuery` と等しい行を**全部そのまま**写す（最上位だけに絞らない。`bestRankedPage` の選び方も試験に残すため）。
- `posts`: `queryPages` の各行の記事 URL（`/blog/<slug>/`）の slug と、その `merged_into` を最後までたどった slug のすべてについて、`readAllPosts()` の項目から `slug`・`review_status`・`merged_into`・`target_query` だけを写す。
- `postContents`: `posts` の slug のうち `readPublishedPostContents()` にあるものについて、`{ title, headings, body }` をそのまま写す（slug をキーにしたオブジェクト）。
- 記事は、このブランチの出発点（main = 98a4cdd1）の `content/posts` から写す。

試験の変更:

- いまの「実データ」の部分（`U.loadInputs()`・`readAllPosts()`・`readPublishedPostContents()` を使う所）を、固定データを読む形に置き換える。`extractGscCandidates()` に渡すのは `queries`・`queryPages`・`posts`・`postContents`（`new Map(Object.entries(...))`）・`existingTopics: []`・`denylist: { entries: [] }`。
- 先に、固定データが壊れていないことを確かめる項目を足す: `queries` がちょうど 7 行で、7 語がすべて入っている。
- 期待値と項目名は変えない: 候補はちょうど 1 件、`phrases[0] === 'インボイス レジ'`、`position === 30.1`、項目名「20260928 の指示書掲載7語はインボイス レジだけが残る」。加えて、その候補の `page` が `https://mori-zeirishi.net/blog/newseg-retail_store-retail-invoice-guide/` であることも確かめる。
- 使わなくなった `require` は消す。

### R4 「今週の却下5件を既存メタデータを変えずに記録する」を週次の更新で落ちないようにする

- `actualTopics.updated_at === '2026-09-28T11:39:44.485Z'` を、「`updated_at` が日時として読め、`2026-09-28T11:39:44.485Z` 以後」に変える。理由のコメントを 1〜2 行添える（週次の取り込みで候補が増えると `update-gsc-topics.js` が `updated_at` を書き換えるのは正しい動き。却下 5 件が消えず変わらないことが確かめたい中身）。
- `version === 1`、却下 5 件がそのまま残っていること（`rejected-topics-20260928.json` との完全一致）は変えない。項目名も変えない。

## テスト

- `node scripts/lib/__tests__/test-check-master-freshness.js`
- `node scripts/lib/__tests__/test-gsc-topics.js`
- `node scripts/lib/__tests__/test-simulator-dependencies.js`、`test-query-placement.js`、`test-search-console-ingest.js`
- `npm run masters:test`
- `node scripts/check-master-freshness.js --as-of 2026-10-27`（実データで、出典の改訂 148 件が従来どおり報告されること。試験から外しても合図が残っていることの確認）

## 変更してはいけないもの

- `scripts/check-master-freshness.js`、`scripts/update-gsc-topics.js`、`scripts/lib/` の各モジュール。
- マスター、国税庁データ、サーチコンソールのデータ、`data/gsc-topics.json`、`content/posts/*.md`。
- 2 本の試験の、ここで名指ししていない項目。
