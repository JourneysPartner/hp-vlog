# 段 2: 国税庁の一覧から外れた DB の記録も、本文で確かめる

README の背景・方針と、段 1 の `01-error-page-as-deleted.md`・`01b-acceptance-fixes.md`・`01c-review-fixes.md`（実装済み・マージ済み、#792）を先に読むこと。ここでは段 2 の実装の要件（P1〜P8）、守ること（U1〜U12）、試験（V1〜V19）を書く。

## なぜ要るか（2026-11-17 に確かめた事実）

- 段 1 は国税庁の一覧（index）に載っているページだけを訪ねる（段 1 の S7）。
- DB には、国税庁の一覧から外れた記録が 2 件ある: `taxanswer/gensen/2882.json`（No.2882「恒久的施設（PE）（平成29年から平成30年分）」）と `taxanswer/shohi/6555.json`（No.6555「海外旅行者が出国に際して携帯する物品の輸出免税」）。どちらも国税庁では `302 → https://www.nta.go.jp/error/404.htm`（ページが無い）。記事・照合の記録・シミュレーターからの参照は無い。
- 訪ねないので、この 2 件は DB で「生きた資料」のまま残り、照合・出典の候補に使われ得る。
- DB の記録 2,229 件（タックスアンサー 679・質疑応答 1,550）はすべて、記録の `url` がファイルの置き場所から決まる形（P2 の「正しい URL」）と一致する。

## 守ること（安全の条件。すべて試験で確かめる）

- U1 一覧から外れた記録に削除の印を付けてよいのは、段 1 の S1 と同じとき（その記録の URL を本文で取りに行き、転送の行き先が国税庁のエラーページと完全に一致した、または転送なしで 404/410 が返った）だけ。HEAD の答えだけでは付けない（段 1 の G4 と同じく、本文で確かめる）。
- U2 段 1 の S2 の失敗（`retry_exhausted`・`http_error`・`mojibake_detected`・`parse_failed`・転送の後の 404 など）は削除にせず、記録（JSON）は一字も変えない。失敗は今までどおり `errors` に数える。
- U3 新しい削除の上限（既定 20、`--max-deletions`）は、一覧にある記録の新しい削除と**合わせて**数える。超えたら一件も印を付けない（段 1 の S5 と同じ）。
- U4 次のときは、一覧から外れた記録を一件も訪ねず、記録も変えない: `--type` が `all` でない、`--category` がある、`--max-pages` がある、`--dry-run`。（`--probe`・`--rebuild-index`・`--backfill-figures` は今のまま取り込みの流れに入らない。）
- U5 一覧の項目が 1 件も取れなかった分類（種類と分類の組。例: 質疑応答の `joto`）の記録は訪ねない。質疑応答の分類ごとの一覧の取得の失敗（今は警告だけで続く）はこれに当たる。
- U6 訪ねる対象（U4・U5・U7・U8 で外した残り）が 100 件を超えたら、一件も訪ねず、件数と注意を報告・meta.json・通知に出す（一覧の取得や読み取りの不具合を疑うため）。100 件ちょうどは訪ねる。
- U7 前から削除済み（`deleted: true`）で一覧にも無い記録は訪ねない。記録は変えない。報告に件数と一覧を出す。
- U8 訪ねてよいのは、記録の `url` が P2 の「正しい URL」と完全に一致する記録だけ。一致しない・`url` が無い・JSON が読めない記録は訪ねず、記録も変えない。報告に出す。
- U9 一覧から外れた記録の本文を取りに行き、本文は取れたが国税庁の別のページへ転送されていた（`redirected` が true で、行き先が記録の `url` と違う）ときは、記録を変えない。報告に行き先と一緒に出す。`errors` には数えない。
- U10 ページが生きていた記録は、一覧にある記録と同じ扱いにする（HEAD で変わっていなければ `last_checked_at` だけ、本文が変わっていれば中身を更新）。報告に出す。
- U11 中身のファイルは消さない（`unlink`・`rm` などを足さない）。
- U12 一覧にある記録の扱いは段 1 のまま変えない（段 1 の試験がそのまま通る）。同じ記録を 1 回の実行で 2 度訪ねない。

## 実装の要件

### P1 DB の記録の一覧（`scripts/lib/nta-store.js`）

- 新しい `listRecordKeys()` を足して書き出す。`NTA_SOURCES_DIR` の下の `taxanswer/<分類>/<id>.json` と `shitsugi/<分類>/<節>/<id>.json` だけを返す（中身は読まない）。
  - 戻り値: `[{ type: 'taxanswer', category, id, file_path: 'taxanswer/<分類>/<id>.json' }, { type: 'shitsugi', category, section, id, file_path: 'shitsugi/<分類>/<節>/<id>.json' }]`。`file_path` は index.json と同じ形（`/` 区切り）。`file_path` の順に並べる。
  - 深さが違うもの・`.json` で終わらないもの（`.json.tmp` など）・`images/`・`index.json`・`meta.json`・`token-df.json` は返さない。`taxanswer/`・`shitsugi/` が無ければ空の配列。
- 引数で調べる場所を変えられるようにしてよい（試験で一時フォルダーを渡すため）。既定は `NTA_SOURCES_DIR`。

### P2 一覧から外れた記録を選ぶ部品（新しい `scripts/lib/nta-unlisted.js`）

通信しない、ファイルを書かない部品にする。

- `UNLISTED_CHECK_LIMIT = 100`（U6）。
- `canonicalUrlOf(key)`: 「正しい URL」を返す。タックスアンサー `https://www.nta.go.jp/taxes/shiraberu/taxanswer/<分類>/<id>.htm`、質疑応答 `https://www.nta.go.jp/law/shitsugi/<分類>/<節>/<id>.htm`。
- `selectUnlisted({ keys, listedFilePaths, listedCategories, loadRecord })`:
  - `keys` は P1 の戻り値。`listedFilePaths` はこの実行で一覧に載っていた項目の `file_path` の集まり、`listedCategories` は一覧の項目が 1 件以上あった `<種類>/<分類>`（例 `taxanswer/gensen`・`shitsugi/joto`）の集まり。`loadRecord(key)` は記録を読む関数（読めなければ null）。
  - `listedFilePaths` にあるものは外す（一覧にある記録）。残りを「一覧から外れた記録」として、次のどれか 1 つに分ける:
    - `category_unlisted`（U5）: その `<種類>/<分類>` が `listedCategories` に無い。記録は読まなくてよい。
    - `invalid_record`（U8）: 記録が読めない・`url` が無い・`url` が `canonicalUrlOf(key)` と一致しない。
    - `deleted_before`（U7）: `deleted === true`。
    - 訪ねる対象（`targets`）: 上のどれでもないもの。
  - 戻り値は、上の分け方ごとの配列（各要素は `key`・`record`（あれば）・`url`・`title`）。どれも `file_path` の順。
- 報告・meta に出す結果の名前（`outcome`）と日本語のラベルをここに置く:

| outcome | ラベル |
|---|---|
| `deleted` | 新しく削除済みにした |
| `held` | 上限を超えたため印を付けなかった |
| `alive_updated` | ページはある（中身を更新） |
| `alive_unchanged` | ページはある（変わっていない） |
| `redirected_elsewhere` | 国税庁の別のページへ転送（記録は変えない）: <行き先> |
| `error` | 取れなかった（<理由>、記録は変えない） |
| `deleted_before` | 前から削除済み（訪ねない） |
| `invalid_record` | 記録が読めない・URL が正しくない（訪ねない） |
| `category_unlisted` | 国税庁の一覧でこの分類が 1 件も取れなかった（訪ねない） |
| `not_checked` | 対象が多すぎるため訪ねなかった |

### P3 本文の取得の戻り値（`scripts/lib/nta-crawler.js`）

- `fetchPage` の成功の戻り値に `redirected`（`res.redirected === true` なら true、ほかは false）と `finalUrl`（`res.url`、無ければ取りに行った URL）を足す。ほかの項目と、失敗の戻り値は変えない。

### P4 取り込みの流れ（`scripts/crawl-nta-sources.js`）

- `crawlTaxAnswer`・`crawlShitsugi` は、戻り値に `listedFilePaths`（一覧の全項目の `file_path`。`--max-pages` で途中までしか回らなくても一覧の全部）と `listedCategories`（P2 の形）を足す。`--dry-run` の早く返す道では空でよい。
- `crawlAll` で、両方の取り込みの後・`applyPendingDeletions` の前に、一覧から外れた記録を扱う:
  1. U4 のどれかに当たれば何もしない（`unlisted_check` を `skipped_filter` か `skipped_dry_run` にする。`listRecordKeys` も呼ばない）。
  2. `store.listRecordKeys()` と P2 の `selectUnlisted` で分ける。記録の読み込みは、一覧にある記録と同じ部品（タックスアンサーは `store.loadTaxAnswerEntry(分類, id)`、質疑応答は `store.readJson(store.shitsugiPath(分類, 節, id))`）で行う。
  3. 訪ねる対象が `UNLISTED_CHECK_LIMIT` を超えたら一件も訪ねない（`unlisted_check` を `skipped_too_many`、対象の結果は `not_checked`）。
  4. 超えなければ `file_path` の順に訪ねる（`unlisted_check` は `done`）。1 件ずつの扱いは、一覧にある記録と**同じ処理**を使う（`performIncrementalFetch` と、その後の skipped・gone・error・fetched の分け方）。写しを作らずに済むよう、`crawlTaxAnswer`・`crawlShitsugi` の 1 件分の処理を関数に切り出してよい（一覧にある記録の動きは変えない）。一覧の項目の形（`{ id, category, url, section? }`）は記録から作る（`url` は記録の `url`）。
  5. 違いは次の 2 つだけ:
     - 新しい削除の候補には `unlisted: true` を付ける（上限は一覧にある記録の候補と合わせて数える。U3）。
     - `fetched` の道で `fetchResult.redirected === true` かつ `fetchResult.finalUrl !== 記録の url` なら、保存せず結果を `redirected_elsewhere`（行き先も残す）にする（U9）。
  6. 結果（P2 の outcome）を記録ごとに決める。`deleted`・`held` は `applyPendingDeletions` の後に決める。
- 集計: 訪ねた記録の数は今の `fetched`・`skipped`・`deleted`・`deletion_held`・`errors` に今までどおり入る（`total_entries_processed` も）。一覧から外れた記録のまとめは次の名前で `aggregated` に足す: `unlisted_check`（`done`・`skipped_filter`・`skipped_dry_run`・`skipped_too_many`）、`unlisted_check_limit`（100）、`unlisted_entries`（`{ type, url, title, file_path, outcome, reason?, final_url? }` の配列、`url` の順。`skipped_filter`・`skipped_dry_run` なら空）、`unlisted`（`unlisted_entries` の件数）。
- `metaEntryOf` は、`unlisted: true` の候補だけ `unlisted: true` を足す（一覧にある記録の `deleted_entries`・`deletion_held_entries` の形は変えない）。
- ログ: 一覧から外れた記録の数・訪ねた数・結果ごとの数を 1 行で出す。U4・U6 で訪ねなかったときは理由を出す。
- 一覧にある記録と同じ記録を 2 度訪ねない（`listedFilePaths` で外すので起きないはず。試験で確かめる）。

### P5 meta.json（`scripts/lib/nta-index-builder.js` の `saveMeta`）

- `crawl_results.unlisted`（数、無ければ 0）、上の階に `unlisted_check`（文字列、無ければ null）・`unlisted_check_limit`（数、無ければ null）・`unlisted_entries`（配列、無ければ空。`url` の順）を足す。今の項目と `total_entries_processed` の数え方は変えない。

### P6 報告ファイル（`scripts/lib/nta-deletions.js` の `renderReport`）

- 「新しく削除済み」「上限で止めた」の表で、`unlisted: true` の行の「見分けた理由」の後ろに「（国税庁の一覧からも外れている）」を付ける。
- 最後に新しい節を毎回出す:

```
## 国税庁の一覧から外れた DB の記録: N 件
```

  - `unlisted_check` が `skipped_filter` なら「絞り込み（--type・--category・--max-pages）があるため確かめていません」、`skipped_dry_run` なら「--dry-run のため確かめていません」、`skipped_too_many` なら「訪ねる対象が M 件あり、上限（100 件）を超えたため一件も訪ねていません。国税庁の一覧の取得・読み取りの不具合を疑ってください」を 1 行出す。
  - 記録があれば表 `| 種類 | 題名 | URL | 結果 |`（結果は P2 のラベル。`redirected_elsewhere` は行き先、`error` は理由を入れる）。`|` と改行は今の表と同じく置き換える。0 件なら「なし」。
  - 行数は今の表と同じ `maxRows` で抑え、あふれたら今の形の 1 行（全件は meta.json の `unlisted_entries` と実行の要約にある）を出す。見出しの件数は丸めない。
- `writeReport`（`scripts/crawl-nta-sources.js`）は、一覧から外れた記録のまとめを `renderReport` に渡す。使っている所（`findReferences`）は、新しく削除・上限で止めたものに今までどおり出す（一覧から外れたものも含む）。

### P7 ワークフロー（`.github/workflows/crawl-nta-sources.yml`）

- 「Read meta.json」で `crawl_results.unlisted`（無ければ 0）と `unlisted_check`（無ければ空）を読む。backfill-figures のときは 0・空にする（今の削除の数と同じ扱い）。
- 「Create PR if changes」の表に「国税庁の一覧から外れた記録」の行を足す。確認ポイントに「一覧から外れた記録があれば: 下の節で結果を見る。『ページはある』は国税庁が一覧から外した古いページの可能性がある」を足す。
- Chatwork の通知: `unlisted_check` が `skipped_too_many` なら警告の行（「一覧から外れた記録が多すぎるため確かめていません：一覧の取得の不具合を疑う（実行: <RUN_URL>）」）を足す。
- ジョブの要約: 数の行を 1 行足す。
- `run:` の中に新しい `${{ … }}` を書かない（値は `env:` で渡す）。`has-substantive-change.js` の行と `if:` は変えない。

### P8 CI で回す

- `package.json` は変えない（試験は今の `test-nta-deleted-pages.js` に足す。すでに `masters:test` に入っている）。

## 試験

`scripts/lib/__tests__/test-nta-deleted-pages.js` に足す（今の試験の作りと偽の部品を使う）。今ある試験（T1〜T16・F1〜F3・G1〜G7）の中身は変えない。例外として、`baseDependencies` の偽の `nta-store` に `listRecordKeys: () => []` を 1 行足してよい（`--type all` の今の試験が P4 で `listRecordKeys` を呼ぶため）。偽の `listRecordKeys` を試験ごとに差し替えて、一覧から外れた記録を作る。試験の資料は `scripts/lib/__tests__/fixtures/nta-deleted-pages/` に足してよい（実在の 2882・6555 の記録の写しは置かない。題名・本文は架空にする）。

- V1 一覧から外れた記録 2 件（タックスアンサー `gensen/2882`・`shohi/6555` の形、分類は一覧に 1 件以上ある）＋HEAD・本文ともエラーページ → 両方に削除の印。保存された記録は既存と比べて `deleted`・`deleted_reason`・`deleted_at`・`last_checked_at` だけが違う。報告の削除の表に「（国税庁の一覧からも外れている）」付きで出て、新しい節にも `deleted` で出る。meta の `deleted_entries` の 2 件に `unlisted: true`。
- V2 一覧から外れた記録＋転送なしの 404・410 → 削除の印（U1）。
- V3 一覧から外れた記録＋HEAD はエラーページだが本文は取れる → 削除にしない（`alive_updated` か `alive_unchanged`）。
- V4 一覧から外れた記録＋段 1 の S2 の失敗それぞれ（`retry_exhausted`・`http_error` 403・`mojibake_detected`・転送なしの `parse_failed`・転送の後の 404）→ 印なし、保存なし、`errors` に入る、結果は `error`（理由付き）。
- V5 上限: 一覧にある新しい削除 15 件＋一覧から外れた新しい削除 6 件・上限 20 → 保存 0 件、21 件とも「上限で止めた」、一覧から外れた 6 件の結果は `held`。合わせて 20 件 → 20 件保存。`--max-deletions 0` で一覧から外れた 1 件だけ → 止まる。
- V6 U4: `--type taxanswer`・`--type shitsugi`・`--category hojin`・`--max-pages 5`・`--dry-run` のそれぞれで、偽の `listRecordKeys` が一覧に無い記録を返しても、その URL は `fetchPage`・`fetchPageHead` に一度も渡らず、保存もされない。`unlisted_check` が `skipped_filter`（`--dry-run` は `skipped_dry_run`）で、報告の節に理由の 1 文が出る。
- V7 U5: 質疑応答の一覧が `joto` を 1 件も返さない（分類の一覧の取得の失敗の想定）とき、`shitsugi/joto/...` の記録は訪ねず保存もせず、結果は `category_unlisted`。同じ実行で、一覧に項目のある分類の一覧から外れた記録は訪ねる。タックスアンサーの分類でも同じ。
- V8 U6: 訪ねる対象 101 件 → 一件も訪ねず保存なし、`unlisted_check` が `skipped_too_many`、101 件とも `not_checked`、報告に「上限（100 件）を超えた」の 1 文。100 件ちょうど → 100 件とも訪ねる。U7・U8・U5 で外したものは 100 件に数えない。
- V9 U7: 前から削除済み＋一覧に無い → 訪ねず保存なし、結果は `deleted_before`。meta の `deleted_still` には数えない。
- V10 U8: `url` が無い／`http://www.nta.go.jp/...`／`https://www.nta.go.jp.example.com/...`／分類か id が置き場所と違う URL／JSON が読めない（`loadRecord` が null）→ どれも訪ねず保存なし、結果は `invalid_record`。
- V11 U9: 本文は取れたが `redirected: true`・`finalUrl` が記録の `url` と違う → 保存なし、結果は `redirected_elsewhere`、報告に行き先が出る、`errors` に入らない。`redirected: true` でも `finalUrl` が記録の `url` と同じなら今までどおり保存する。
- V12 U10: 一覧から外れた記録＋HEAD の ETag が前と同じ → `last_checked_at` だけ違う記録を保存、`alive_unchanged`。本文の hash が違う → 中身を更新して保存、`alive_updated`。
- V13 U12: 一覧にある記録は新しい節に出ず、どの URL も 1 回の実行で `fetchPage` に 2 度以上渡らない（HEAD も同じ）。一覧から外れた記録が 0 件なら、新しい節は「なし」で、ほかの動きは段 1 のまま。
- V14 `listRecordKeys`（P1）: 一時フォルダーに `taxanswer/gensen/2882.json`・`shitsugi/joto/16/01.json`・`images/x.json`・`index.json`・`meta.json`・`token-df.json`・`taxanswer/gensen/1.json.tmp`・`taxanswer/gensen/sub/2.json`・`shitsugi/joto/3.json`・`taxanswer/x.json` を作る → 最初の 2 件だけを `file_path` の順で返す。フォルダーが無ければ空の配列。
- V15 `fetchPage`（P3）: 偽の `globalThis.fetch` で、転送なし → `redirected: false`・`finalUrl` が取りに行った URL。国税庁の別のページへの転送 → `redirected: true`・`finalUrl` が行き先。エラーページへの転送は今までどおり `nta_error_page`。
- V16 `saveMeta`（P5）: 新しい項目が書かれる。渡さない呼び出しでは `crawl_results.unlisted` 0・`unlisted_check` null・`unlisted_check_limit` null・`unlisted_entries` 空。今の項目は変わらない。
- V17 報告（P6）: 新しい節の各結果のラベル、`redirected_elsewhere` の行き先・`error` の理由、題名の `|` と改行の置き換え、`maxRows` で抑えたときのあふれの 1 行と丸めない見出しの件数、0 件の「なし」、`skipped_*` の 3 つの理由の文。
- V18 ファイルを消さない（U11）: V1〜V12 の実行の間、偽の `fs` の `unlinkSync`・`rmSync`・`rmdirSync` が一度も呼ばれない（呼ばれたら落ちる偽物を渡す）。
- V19 今の試験が通る: 段 1 の T17 に挙げた 10 本（`test-nta-crawler.js`・`test-nta-index-builder.js`・`test-freshness-as-of.js`・`test-has-substantive-change.js`・`test-workflow-change-detection.js`・`test-masters-workflow.js`・`test-demand-driven-selection.js`・`test-shitsugi-triage.js`・`test-required-meta.js`・`test-crawl-queue-cadence.js`）と、`test-nta-deleted-pages.js` の今ある試験すべて。今の試験の中身は変えない（上の 1 行の例外だけ）。

## この段の厳守事項（変えてよいファイル）

- `scripts/lib/nta-store.js`・`scripts/lib/nta-unlisted.js`（新規）・`scripts/lib/nta-crawler.js`（P3 だけ）・`scripts/crawl-nta-sources.js`・`scripts/lib/nta-index-builder.js`（P5 だけ）・`scripts/lib/nta-deletions.js`（P6 だけ）・`.github/workflows/crawl-nta-sources.yml`（P7 だけ）
- `scripts/lib/__tests__/test-nta-deleted-pages.js`（足すのと、上の 1 行）・`scripts/lib/__tests__/fixtures/nta-deleted-pages/**`（足すだけ）
- 変えないもの: `data/`・`docs/`・`package.json`・`package-lock.json`・ほかのワークフロー・`scripts/has-substantive-change.js`・今のほかの試験・`scripts/lib/nta-index/`・`scripts/lib/nta-parsers/`・`scripts/lib/shitsugi-topics.js`。

## 報告の形

1. 変えたファイルと、P1〜P7 それぞれをどこでどう実装したか（短く）。1 件分の処理を切り出したなら、その関数と、一覧にある記録の動きが変わらない理由。
2. 試験の結果（ファイルごとの通過数・失敗数）。失敗があれば名前・エラー・場所。
3. U1〜U12 をどの試験で確かめたかの対応表。
4. 指示書と違えたところ、決めきれなかったところ（【要判断】）。
