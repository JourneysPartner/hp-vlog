# 段 1: 国税庁のエラーページへの転送を「削除済み」として扱う

README の背景・方針を先に読むこと。ここでは実装の要件（R1〜R9）、守ること（S1〜S10）、試験（T1〜T17）を書く。

## 守ること（安全の条件。すべて試験で確かめる）

- S1 「削除済み」の印を付けてよいのは、そのページ自体を取りに行って、(a) 転送の行き先が国税庁のエラーページ（R1 の完全一致）だったとき、または (b) 404/410 が返ったとき、だけ。
- S2 次は削除にしない。今までどおり「失敗」として数え、記録（JSON）は一字も変えない: 通信の失敗・時間切れ（`retry_exhausted`）・5xx・403 などほかの 4xx（`http_error`）・文字化け（`mojibake_detected`）・転送なしで本文の場所が見つからない（`parse_failed`）・国税庁の別のページへの転送。
- S3 似て非なる行き先は削除にしない: `https://www.nta.go.jp/error/404.html`、`https://www.nta.go.jp/error/500.htm`、`https://www.nta.go.jp/taxes/error/404.htm`、`https://www.nta.go.jp.example.com/error/404.htm`、`https://nta.go.jp/error/404.htm`、`http://www.nta.go.jp/error/404.htm`、`https://www.nta.go.jp:8443/error/404.htm`、転送されていない（`redirected` が false の）応答。
- S4 中身のファイルは消さない。付けるのは `deleted: true`・`deleted_reason`・`deleted_at`・`last_checked_at` だけで、ほかの項目は変えない。
- S5 一回の実行で**新しく**削除にする資料が上限（既定 20、`--max-deletions` で変える）を超えたら、どれにも印を付けない（保存しない）。その資料は報告の「上限で止めたもの」と meta.json に出す。上限ちょうどの数は印を付ける。
- S6 削除済みの資料が取れたら印を外す（本文の hash が同じでも外す）。削除済みの資料は、HEAD の ETag・Last-Modified が前と同じでも飛ばさず本文を取り直す。
- S7 国税庁の一覧（index）に載っていない資料は訪ねないので、削除にしない（今のまま）。一覧のページが取れないときも同じ。削除の判定は、訪ねた個々のページの応答だけで行う。
- S8 新しく削除にした資料と上限で止めた資料は、報告ファイル（R6）に全部出す。件数を丸めない。
- S9 削除済みの質疑応答から記事の題材を作らない（R7）。
- S10 `--backfill-figures` は、エラーページへ転送されたページの記録を書き換えない（`html_hash` をエラーページの hash にしない）。

## 実装の要件

### R1 エラーページの見分け（`scripts/lib/nta-crawler.js`）

- 定数 `NTA_ERROR_PAGE_URL = 'https://www.nta.go.jp/error/404.htm'` と関数 `isNtaErrorPageUrl(url)` を足して公開する。
  - `new URL(url)` で読み、`protocol === 'https:'`・`hostname === 'www.nta.go.jp'`・`port === ''`・`pathname === '/error/404.htm'` のときだけ true。クエリ（`?…`）と `#…` は見ない。読めなければ false。
- `fetchWithRetry` と `fetchPageHead` で、応答を受け取った直後（404/410・5xx・`res.ok` の判定より前）に、`res.redirected === true` かつ `isNtaErrorPageUrl(res.url)` なら、再試行せずに `{ ok: false, status: res.status, reason: 'nta_error_page', finalUrl: res.url }` を返す（HEAD は今の形に合わせて `url`・`checkedAt` も付ける）。エラーページ自体の状態が 200 でも 404 でも同じ扱いにする。
- `fetchPage` は失敗のときの戻り値に `finalUrl` を通す（ほかは今のまま）。

### R2 差分の判定（`decideIncrementalAction`）

- HEAD の理由が `nta_error_page` なら `{ decision: 'mark_deleted', reason: 'head_error_page' }`。`not_found` は今のまま `head_404`。
- 既存の記録が `deleted === true` で HEAD が取れた（`ok`）ときは、ETag・Last-Modified を比べる前に `{ decision: 'fetch', reason: 'recheck_deleted' }`。
- ほかの分岐は今のまま。

### R3 削除の部品（新しい `scripts/lib/nta-deletions.js`）

取り込みの CLI から使う。試験しやすいよう、通信はしない。

- `GONE_REASON_LABELS`: `{ nta_error_page: '国税庁のエラーページ（/error/404.htm）へ転送', not_found: '404/410 が返った' }`。`isGoneReason(reason)` はこの 2 つだけ true。
- `markDeleted(existing, reason, at)`: `{ ...existing, deleted: true, deleted_reason: reason, deleted_at: <既存が削除済みで deleted_at があればそれ、無ければ at>, last_checked_at: at }` を返す。引数を書き換えない。
- `clearDeleted(entry)`: `deleted`・`deleted_reason`・`deleted_at` を除いた写しを返す。
- `applyPendingDeletions(pending, { maxDeletions, save })`: `pending.length > maxDeletions` なら一件も `save` を呼ばず `{ applied: [], held: pending }`。そうでなければ全件 `save(item)` して `{ applied: pending, held: [] }`。`maxDeletions` は 0 以上の整数（0 なら新しい削除は必ず止まる）。
- `findReferences(items, { root })`: 各資料を使っている所を探す（報告用。見つからなくても止めない）。
  - 探す場所: `content/posts/`・`data/fact-check/`・`data/tax-simulator/`・`scripts/lib/`（`__tests__` を除く）・`scripts/topic-pool.js`。拡張子 `.md`・`.json`・`.js`・`.yml`。`assets/` は生成物なので見ない。
  - 探す文字: URL のパスの `taxanswer/` または `shitsugi/` から後ろ（例 `taxanswer/hojin/5441.htm`、`shitsugi/joto/16/09.htm`）。タックスアンサーは、`data/tax-simulator/` の中だけ `"taxanswer_id": "5441"`（引用符の有無と空白は問わない、後ろに数字が続くものは除く）も探す。
  - 戻り値は資料ごとに、見つかったファイルの `root` からの相対パス（`/` 区切り）を名前順で。
- `renderReport(summary)`: R6 の Markdown を返す。

### R4 取り込みの流れ（`scripts/crawl-nta-sources.js`）

- `performIncrementalFetch`:
  - 判定が `mark_deleted` のとき、また本文の取得の失敗理由が `isGoneReason` のときは `{ action: 'gone', reason: 'nta_error_page' | 'not_found', checkedAt }` を返す（HEAD の `head_404` は `not_found`、`head_error_page` は `nta_error_page`）。ほかの失敗は今までどおり `error`。
  - 本文を取り直して hash が同じだった（`hash_match_after_get`）とき、既存が削除済みなら `clearDeleted` した記録を返し、復活として数えられるよう印（例 `restored: true`）を戻り値に付ける。
- `crawlTaxAnswer`・`crawlShitsugi` の `gone` の扱い:
  - 既存の記録が無い → 保存しない。`goneUnrecorded` に `{ kind, url, reason }` を足す。`errors` には入れない。
  - 既存が削除済み → `markDeleted(existing, reason, checkedAt)` を保存（`deleted_at` は前のまま）。`deletedStill` を 1 足す。上限には数えない。
  - それ以外 → まだ保存しない。`pendingDeletions` に `{ kind, entry: markDeleted(existing, reason, checkedAt), url, title, id, file_path, reason }` を足す。
- 本文が取れて保存する経路で、既存が削除済みだったものは `restored` に `{ kind, url, title }` を足す（保存する記録には削除の項目が入らないことを試験で確かめる）。
- `crawlAll`: 2 種類を回し終えた後、合わせた `pendingDeletions` を `applyPendingDeletions` に渡す（`save` は種類に応じて `store.saveTaxAnswerEntry`・`store.saveShitsugiEntry`）。その後に `buildAndSaveIndex`（今の条件のまま）、最後に `--report-file` があれば報告を書く（`--skip-index` でも書く）。
- 引数: `--max-deletions <N>`（0 以上の整数。それ以外は今の不明な引数と同じくメッセージを出して終了コード 2。既定 20）と `--report-file <path>`（UTF-8 で書く。親フォルダーが無ければ作る）。`--help` にも足す。
- ログ: 新しく削除にしたものは `[deleted]`、上限で止めたものは `[held]`、戻ったものは `[restored]` の行を出す（理由は日本語のラベル）。
- `test-freshness-as-of.js` の偽の部品で動くこと: 新しく `require` するのは `nta-deletions` だけにし、`nta-crawler` の新しい関数は CLI から直接呼ばない（偽物に無いため）。`fs` を新しく使うなら、`--report-file` のときだけ通る場所で読み込む。

### R5 meta.json（`scripts/lib/nta-index-builder.js` の `saveMeta`）

- `crawl_results` に足す: `deleted`（この実行で新しく印を付けた数。今の `deleted` の意味を「新しく」に変える）、`deleted_still`、`deletion_held`、`restored`、`gone_unrecorded`。
- 上の階層に足す: `max_deletions`、`deleted_entries`・`deletion_held_entries`（`{ type, url, title, file_path, reason }` の配列、URL 順）、`restored_entries`（`{ type, url, title }`）、`gone_unrecorded_urls`（URL の配列、URL 順）。
- `total_entries_processed` = fetched + skipped + deleted + deleted_still + deletion_held。
- 渡されない項目は 0 か空の配列にする（`--rebuild-index` など今の呼び出しを壊さない）。

### R6 報告ファイル（PR 本文に貼る Markdown）

次の節を、この順で毎回すべて出す（該当なしは「なし」）。

```
## 国税庁で削除されたページ（この PR で「削除済み」の印を付けたもの）: N 件

| 種類 | 題名 | URL | 見分けた理由 | この資料を使っている所 |
|---|---|---|---|---|
| タックスアンサー | No.5441 研究開発税制について(概要) | https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm | 国税庁のエラーページ（/error/404.htm）へ転送 | なし |

## 上限を超えたため印を付けなかったもの: N 件（上限 M 件）

（1 件以上のときだけ次の 1 文）本当に削除なら、Actions の「Crawl NTA Sources」を、max_deletions に N 以上を入れて手動で実行し直してください。
（表は上と同じ形）

## 国税庁で戻ったページ（「削除済み」の印を外したもの）: N 件

## 前から削除済みで、今回も無かったもの: N 件

## 国税庁の一覧には載っているがページが無いもの（DB に記録なし・変更なし）: N 件

<details><summary>URL の一覧</summary>

- https://…

</details>
```

- 種類は「タックスアンサー」「質疑応答事例」。題名はタックスアンサーなら `No.<番号> <題名>`、質疑応答はそのまま。
- 使っている所は `` `content/posts/…md` `` を「、」でつなぎ、10 件を超えたら「ほか N 件」。無ければ「なし」。
- 表の欄の中の `|` は `\|` に、改行は空白に置き換える（題名は国税庁から来る文字なので）。

### R7 削除済みの質疑応答から題材を作らない（`scripts/lib/shitsugi-topics.js`）

- `expandShitsugiTopics` で本文の記録を読んだ直後に、`deleted === true` なら `throw new Error('国税庁で削除済みです')`（今の「読めない」と同じ数え方・同じ警告の出し方）。ほかは変えない。

### R8 ワークフロー（`.github/workflows/crawl-nta-sources.yml`）

- 手動実行の入力 `max_deletions`（文字列、既定は空。説明「新しく削除済みにしてよい件数の上限（空なら 20）。上限で止まった後、人が確かめて上げるときに使う」）。
- 「Determine crawl mode」で、空でなければ `^(0|[1-9][0-9]*)$` を確かめ（違えば `::error::` を出して止める）、incremental・full のときだけ引数に `--max-deletions <N>` を足す。
- 「Run crawl」で `--report-file "$RUNNER_TEMP/nta-crawl-report.md"` を足す。
- 「Read meta.json」で `deleted_still`・`deletion_held`・`restored`・`gone_unrecorded` も読む（無ければ 0）。
- 「Create PR if changes」: 本文を `$RUNNER_TEMP/pr-body.md` に書き、`gh pr create --body-file` で渡す。今の表に「新しく削除済み」「前から削除済み」「上限で止めた」「戻った」「一覧にはあるがページが無い」の行を足し、報告ファイルがあれば（backfill-figures では無い）後ろにつなぐ。確認ポイントの先頭に「新しく削除済みにした資料があれば、下の一覧で国税庁のページが本当に無いことを確かめてからマージする」「上限で止めたものがあれば、確かめてから max_deletions を上げて手動で実行し直す」を足す。
- Chatwork の通知: 上限で止めたものが 1 件以上なら警告の行を足す。
- ジョブの要約: 足した数の行を足す。
- `run:` の中に新しい `${{ … }}` を書かない（値は `env:` で渡す。`test-workflow-run-injection.js` が見る）。`has-substantive-change.js` の行と `if:` は変えない（`test-workflow-change-detection.js` が見る）。

### R9 CI で回す

- `package.json` の `masters:test` の最後に `scripts/lib/__tests__/test-nta-crawler.js scripts/lib/__tests__/test-nta-deleted-pages.js` を足す（どちらも通信しないこと）。ほかの scripts は変えない。

## 試験

新しい `scripts/lib/__tests__/test-nta-deleted-pages.js`（試験の資料は `scripts/lib/__tests__/fixtures/nta-deleted-pages/`）。取り込みの CLI は `test-freshness-as-of.js` の `crawlWithFigures` と同じ形（`vm` で動かし、通信・保存は偽物）で動かす。取り込みの流れの試験では `fetchPage`・`fetchPageHead` の戻り値を偽物で決め、待ち時間（`RateLimiter`・再試行）を使わない。`nta-crawler` の部品の試験は `globalThis.fetch` を偽物に差し替え（終わったら戻す）、`maxRetries: 0` で動かす。

- T1 本文の取得: 302 でエラーページへ（`redirected: true`、`url` がエラーページ、状態 200）→ `ok: false`・`reason: 'nta_error_page'`・`finalUrl`。`fetch` は 1 回だけ呼ばれる。エラーページの状態が 404 でも同じ。
- T2 HEAD も T1 と同じ。
- T3 S3 の行き先の一覧それぞれ → `nta_error_page` にならない（状態 200 なら `ok: true`）。
- T4 `decideIncrementalAction`: HEAD `nta_error_page` → `mark_deleted`／削除済み＋ETag 同じ → `fetch`（`recheck_deleted`）／削除済みでない＋ETag 同じ → 今のまま `skip`／HEAD `not_found` → 今のまま `head_404`。
- T5 記録あり＋本文の取得がエラーページ → 保存された記録は、既存と比べて `deleted`・`deleted_reason`・`deleted_at`・`last_checked_at` だけが違う（ほかは深く一致）。
- T6 記録なし＋エラーページ → 保存なし、`goneUnrecorded` に入り、`errors` に入らない。
- T7 記録あり＋S2 の失敗それぞれ（`retry_exhausted`・`http_error` 403・5xx の再試行切れ・`mojibake_detected`・転送なしの `parse_failed`・国税庁の別のページへの転送で本文が取れた場合）→ 削除の印は付かず、失敗の場合は記録の保存なし。
- T8 上限: 新しい削除が 21 件・上限 20 → 削除の保存 0 件、報告の「上限で止めたもの」に 21 件全部。20 件・上限 20 → 20 件保存。`--max-deletions 25` で 21 件 → 21 件保存。`--max-deletions 0` → 1 件でも止まる。タックスアンサーと質疑応答を合わせて数える。
- T9 前から削除済み＋今回も無い → 新しい削除に数えず上限にも数えない。`deleted_at` は前のまま。
- T10 復活: 削除済み＋本文が取れて hash が違う → 削除の項目の無い記録を保存、`restored` に入る。hash が同じ（`hash_match_after_get`）でも同じ。
- T11 報告ファイル: 新しい削除の題名・URL・理由のラベル・使っている所が出る。上限で止めた節と再実行の 1 文。題名の `|` と改行の置き換え。該当なしの節は「なし」。
- T12 `findReferences`: 資料の中の記事が URL を引いている → その記事のパスが出る。`__tests__` と `assets/` は見ない。`"taxanswer_id": "5441"` は `data/tax-simulator/` の中だけ当たり、`54410` には当たらない。
- T13 `saveMeta`: R5 の項目と `total_entries_processed`。項目を渡さない呼び出しでも 0・空の配列で書ける。
- T14 `expandShitsugiTopics`: 本文の記録が `deleted: true` の候補は題材に入らず、読めないものとして数えられる。削除済みでない候補は今までどおり入る。
- T15 `--backfill-figures`: 取り直しがエラーページ（`fetchPage` が `nta_error_page`）→ 記録のファイルは一字も変わらない。
- T16 引数: `--max-deletions -1`・`abc`・`1.5` → 終了コード 2。
- T17 今の試験が通る: `test-nta-crawler.js`・`test-nta-index-builder.js`・`test-freshness-as-of.js`・`test-has-substantive-change.js`・`test-workflow-change-detection.js`・`test-masters-workflow.js`・`test-demand-driven-selection.js`・`test-shitsugi-triage.js`・`test-required-meta.js`・`test-crawl-queue-cadence.js`。`test-freshness-as-of.js` を変えてよいのは、偽の部品の一覧に `'nta-deletions': <本物の部品>` を 1 行足すことだけ。ほかの今の試験は変えない（足すのはよい）。

## この段の厳守事項（変えてよいファイル）

- `scripts/lib/nta-crawler.js`・`scripts/lib/nta-deletions.js`（新規）・`scripts/crawl-nta-sources.js`・`scripts/lib/nta-index-builder.js`・`scripts/lib/shitsugi-topics.js`・`.github/workflows/crawl-nta-sources.yml`・`package.json`（`masters:test` だけ）
- `scripts/lib/__tests__/test-nta-deleted-pages.js`（新規）・`scripts/lib/__tests__/fixtures/nta-deleted-pages/**`（新規）・`scripts/lib/__tests__/test-nta-crawler.js`（足すだけ）・`scripts/lib/__tests__/test-nta-index-builder.js`（足すだけ）・`scripts/lib/__tests__/test-freshness-as-of.js`（T17 の 1 行だけ）
- 変えないもの: `data/`・`docs/`・ほかのワークフロー・`scripts/has-substantive-change.js`・今の試験の中身・`package-lock.json`。

## 報告の形

1. 変えたファイルと、R1〜R9 それぞれをどこでどう実装したか（短く）。
2. 試験の結果（ファイルごとの通過数・失敗数）。失敗があれば名前・エラー・場所。
3. S1〜S10 をどの試験で確かめたかの対応表。
4. 指示書と違えたところ、決めきれなかったところ（【要判断】）。
