# 段 2b: 影響の範囲のレビューの直し（2026-11-17）

02 の実装（4ade7114）への影響の範囲のレビュー（Opus 5.5 xhigh）の結論は「マージ可」、Critical・High 0、Medium 2・Low 7。ここでは Medium 2 件と、安く直せる Low を直す。02 の要件は、ここで書き替える所のほかは変えない。

## 直すこと

### H1（Medium M1）一覧から外れた記録の「別のページへの転送」を、どの道でも見る

今は U9 の判定が `fetched` の道にしかない。次の 2 つの道では、転送先の答えで記録を保存してしまう。

- (a) 記録の URL が国税庁の別のページへ転送され、転送先の HEAD の ETag か Last-Modified が記録と同じ → `skip` で `last_checked_at` を書いて保存、結果は `alive_unchanged`。
- (b) HEAD は違うが、GET が転送されて本文の hash が記録と同じ（`hash_match_after_get`）→ 転送先の etag・last_modified で記録を書き替えて保存、`alive_unchanged`。

直し方:

- `scripts/lib/nta-crawler.js` の `fetchPageHead` の成功の戻り値に `redirected`（`res.redirected === true`）と `finalUrl`（`res.url`、無ければ取りに行った URL）を足す（P3 と同じ形）。ほかの項目と失敗の戻り値は変えない。
- `performIncrementalFetch` の `skipped` の戻り値に、その判断の元になった応答を載せる（HEAD の skip なら `head`、hash の一致なら `fetchResult`）。今の項目と、一覧にある記録の動きは変えない。
- `processEntry` は `options.rejectForeignRedirect` のとき、`skipped` と `fetched` の両方の道で、保存の**前に**、元になった応答（`head` か `fetchResult`）が `redirected === true` で `finalUrl` が記録の `url` と違えば、保存せず `redirected`（行き先付き）を返す。`gone`・`error` の道は今のまま。
- 一覧にある記録（`rejectForeignRedirect` なし）の動きは変えない。

試験（`test-nta-deleted-pages.js` に足す）:

- V11b 一覧から外れた記録＋HEAD が別のページへ転送（`ok: true`・`redirected: true`・`finalUrl` が別）で ETag が記録と同じ → 保存なし、結果は `redirected_elsewhere`・行き先付き、`errors` に入らない。
- V11c 一覧から外れた記録＋HEAD は違う、GET が別のページへ転送で本文の hash が記録と同じ → 保存なし、`redirected_elsewhere`。
- V11d 一覧にある記録で同じ (a)・(b) の応答 → 今までどおり保存する（動きが変わらないこと）。
- 本物の `fetchPageHead` を偽の `globalThis.fetch` で動かし、転送なし → `redirected: false`・`finalUrl` が取りに行った URL、別のページへの転送 → `redirected: true`・`finalUrl` が行き先、エラーページへの転送は今までどおり `nta_error_page`。

### H2（Medium M2）多すぎて訪ねなかったときも表を出す

- `renderReport` で `unlisted_check` が `skipped_too_many` のとき、理由の 1 文の後に、`done` のときと同じ表（`maxRows` とあふれの 1 行付き）を出す。`skipped_filter`・`skipped_dry_run` は今のまま（理由の 1 文だけ、「なし」を出さない）。
- 試験: V17 に、`skipped_too_many` で表の行と、あふれの 1 行が出ることを足す。

### H3（Low L2・L3）前から削除済みの記録で毎月の数が増え続けないようにする・確かめていないときに 0 と出さない

- 報告の節「国税庁の一覧から外れた DB の記録: N 件」の N と表から、`deleted_before` を外す。代わりに節の中に 1 行「前から削除済みで一覧にも無いもの（訪ねない）: M 件」を出す（M が 0 なら出さない）。meta.json の `unlisted_entries` は今のまま `deleted_before` を含める（中身は毎月同じなので余計な PR にはならない）。
- `crawl_results.unlisted` は `deleted_before` を除いた数にする。`crawl_results.unlisted_deleted_before`（数）を足す。
- ワークフローの PR 本文の表の行「国税庁の一覧から外れた記録」は、`unlisted_check` が `done` のときは数、`skipped_too_many` のときは「多すぎるため確かめていない（N 件）」、そのほか（`skipped_filter`・`skipped_dry_run`・空）のときは「確かめていない」と出す。値は `env:` で渡し、`run:` の中に新しい `${{ … }}` を書かない。
- 試験: 前から削除済み 2 件＋新しく削除 1 件の実行で、見出しは 1 件、表に削除済みの 2 件が出ず、「前から削除済みで一覧にも無いもの（訪ねない）: 2 件」が出る。`crawl_results.unlisted` 1・`unlisted_deleted_before` 2。

### H4（Low L5）ログの結果の名前

- `logUnlistedSummary` は、ラベルの関数を空の引数で呼ばず、短い名前（outcome のまま、または `UNLISTED_OUTCOME_LABELS` とは別の短い日本語）で出す。「取れなかった（、記録は変えない）」のような崩れた文を出さない。
- 試験: ログに崩れた文（`（、` や `:  ` の続き）が出ないこと。

### H5（Low L6）記録の項目と置き場所の食い違いも訪ねない

- `selectUnlisted` は、`url` の一致に加えて、記録の `id` が `key.id` と、`tax_category_code` が `key.category` と、質疑応答では `String(section).padStart(2, '0')` が `key.section` と同じことを確かめる。違えば `invalid_record`（訪ねない・保存しない）。
- 試験: V10 に、`id` 違い・`tax_category_code` 違い・節違い（質疑応答）を足す。

### H6（Low L1）PR 本文が長すぎるときに PR が作れなくならないようにする

- ワークフローの「Create PR if changes」で、報告ファイルをつないだ後の `pr-body.md` の字数（`LC_ALL=C.UTF-8 wc -m`。GitHub の上限 65,536 は字数で、日本語はバイトで数えると 3 倍になるため）を確かめ、60,000 字を超えたら、つないだ報告を外し、代わりに「報告が長すぎるため本文に載せていません。全件は Actions の実行の要約（<実行の URL>）と meta.json にあります」の 1 文を足す（`gh pr create` が失敗して取り込みの結果が失われないようにする）。実行の URL は `env:` で渡す。
- 試験: ワークフローの試験の形に合わせて、`run:` に新しい `${{ … }}` が無いこと（`test-workflow-run-injection.js`）。60,000 字の判定は、bash で動かせる形なら `test-workflow-run-injection.js` の bash の試験と同じやり方で足してよい。無理なら【要判断】で報告。

### H7（Low L4）分類の一覧が取れなかったときの通知

- Chatwork の通知で、meta.json の `unlisted_entries` に `category_unlisted` が 1 件以上あれば警告の行（「国税庁の一覧で 1 件も取れなかった分類があります：一覧の取得の不具合を疑う（実行: <RUN_URL>）」）を足す。数は「Read meta.json」で `jq` で数えて出力に足す。backfill-figures では 0。

### H8 上限で止めたときの案内に 1 文

- 「上限を超えたため印を付けなかったもの」の案内の 1 文は変えず、その次の行に「実行し直すときは max_pages を空のままにしてください（入れると一覧から外れた記録を確かめません）」を足す。

## 直さないこと（記録だけ）

- L7 `full` では、生きている一覧外の記録の結果が、中身が同じでも「ページはある（中身を更新）」と出る（一覧にある記録と同じ扱いで、言い方だけの問題）。
- 範囲外（前からの穴）: 一覧にある記録の道は別のページへの転送を見ない／`--backfill-figures` は `redirected` を見ない／タックスアンサーの読み取りは `id` を題名から取る／質疑応答の分類の一覧が取れないと一覧にある記録の取り込みもその月その分類を落とす／`total_entries_processed` に `errors` が入らない／段の境目で `RateLimiter` が作り直される。

## 変えてよいファイル

02 の「この段の厳守事項」と同じ。加えて、H6 の判定の試験のために `scripts/lib/__tests__/test-workflow-run-injection.js` に足してよい（今の試験の中身は変えない）。また、02 で足した V の試験（V1〜V18）は、ここでの直しに合わせて書き替えてよい（段 1 の試験 T1〜T16・F1〜F3・G1〜G7 の中身は変えない）。

## 報告の形

1. H1〜H8 それぞれをどこでどう直したか（短く）。
2. 試験の結果（ファイルごとの通過数・失敗数）。失敗があれば名前・エラー・場所。
3. 指示書と違えたところ、決めきれなかったところ（【要判断】）。
