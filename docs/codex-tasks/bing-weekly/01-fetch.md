# 01 Bing の取り込み

新しいスクリプト `scripts/fetch-bing-webmaster.js` を作り、週次のワークフローから呼ぶ。書き方（CommonJS・`run(options)` で env・now・fetchImpl・outRoot・log を差し替えられる形・`module.exports`）は `scripts/fetch-search-console.js` に合わせる。

## R1 呼ぶ窓口と鍵

- 鍵: `env.BING_WEBMASTER_API_KEY`。空なら `[bing] BING_WEBMASTER_API_KEY が未設定のためスキップします` と出して `{ status: 'skipped' }` を返す。何も書かない。終了コード 0。
- サイト: `SITE_URLS = ['https://mori-zeirishi.net/', 'https://mori-zeirishi.net']`。最初の窓口（GetRankAndTrafficStats）で 1 つ目が失敗したら 2 つ目を試し、取れたほうを以後の窓口に使う（`fetch-search-console.js` のプロパティの選び方と同じ）。
- 呼ぶ窓口は次の 5 つだけ。`Object.freeze` した一覧にし、URL を作る関数は一覧に無い名前を渡されたら例外にする。

| 名前（保存の鍵） | 窓口 | 必須 |
|---|---|---|
| traffic | GetRankAndTrafficStats | 必須 |
| queries | GetQueryStats | |
| pages | GetPageStats | |
| crawl | GetCrawlStats | |
| feeds | GetFeeds | |

- URL: `https://ssl.bing.com/webmaster/api.svc/json/<窓口>?siteUrl=<encodeURIComponent(サイト)>&apikey=<encodeURIComponent(鍵)>`。方法は GET だけ。ヘッダは `Accept: application/json`。1 回ごとに 30 秒で時間切れ（`AbortSignal.timeout`）。
- 再試行: HTTP 429・5xx・接続の失敗・時間切れのときだけ、5 秒・15 秒あけて最大 2 回（待ち時間は試験で 0 にできるよう options で差し替えられること）。それ以外の 4xx はすぐ失敗。
- 応答の `d` が配列でなければ、その窓口の失敗。

## R2 失敗の理由の文（鍵を出さない）

ログと latest.json に書く失敗の理由は、**決まった形だけ**で作る。応答の本文・URL・例外の `message` をそのまま使わない。

- `<窓口>: HTTP <番号>`。応答の本文が JSON で `ErrorCode`（整数）と `Message`（`/^[A-Za-z0-9 _.-]{1,80}$/` に合う文字列）を持つときだけ、` ErrorCode <数> <Message>` を足す（例 `GetQueryStats: HTTP 400 ErrorCode 3 InvalidApiKey`）。
- 接続の失敗: `<窓口>: 接続できませんでした（<error.name>）`。時間切れ: `<窓口>: 時間切れ`。形の違い: `<窓口>: 応答の形が違います`。
- 最後の守り: ログに出す文と、保存する JSON の文字列を、出す・書く直前に確かめ、鍵そのもの・`encodeURIComponent(鍵)`・`apikey` のどれかを含んでいたら、出さず・書かずに例外で止める（終了コード 1、文は `[bing] 鍵が含まれるため書き込みを止めました`）。

## R3 日付・数・順位の読み方

- 日付: `/Date(<ミリ秒>)/` と `/Date(<ミリ秒>±hhmm)/` は、ミリ秒を UTC の暦日 `YYYY-MM-DD` にする（後ろの時差は使わない）。`2026-11-07T00:00:00` のような文字列は先頭 10 文字。どちらでもない行は捨てて、捨てた行の数を数える。
- 数（表示・クリック・巡回の各数）: 0 以上の整数でなければ、その行を捨てて数える。
- 順位（`AvgImpressionPosition`・`AvgClickPosition`）: 0 より大きい数のときだけ使う。-1・0・数でないものは「順位なし」（null）。倍率はかけない（定数 `POSITION_SCALE = 1` にし、コメントに「受け入れで画面と比べて確かめる」と書く）。
- 項目は下の R4 の表にあるものだけを取り出す（応答の他の項目、`__type` などは保存しない）。

## R4 期間とまとめ方

- **期間（window）**: traffic の最新の日付を end、end の 27 日前を start とする（28 日）。traffic が 0 行なら、queries・pages・crawl の中で最新の日付を end にする。どれも 0 行なら期間なし（`window: null`、各ファイルの rows は空）。
- **同じ日付の行（traffic・crawl）**: 取り出した値が全部同じなら 1 行として数える。違えば、その日を除き、`conflicting_dates` に日付を記録する。
- **traffic**: 期間内の行（日付順）を保存。`totals` に表示・クリックの合計、`days_reported` に期間内の日数。
- **queries・pages**: 日付が start〜end に入る行を、検索語（pages は `Query` 列の URL）の文字列ごとにまとめる。表示・クリックは足す。`position` は `AvgImpressionPosition` を表示回数で重みを付けた平均（順位なし・表示 0 の行は除く）、`click_position` は `AvgClickPosition` をクリック数で重みを付けた平均（順位なし・クリック 0 の行は除く）。どちらも小数第 2 位で丸め、対象が無ければ null。`weeks` はその語が出た日付の数。並びは表示の多い順 → クリックの多い順 → 文字列の順で、最大 1,000 行。
- 窓口ごとに、期間内で使った日付の数（`weeks`）と、行の数が 100 以上の日付の数（`weeks_at_cap`）を記録する（1 週あたり最大 100 行は【要確認】の観察）。
- **crawl**: 期間内の行（日付順）。項目は `CrawledPages`・`InIndex`・`CrawlErrors`・`Code2xx`・`Code301`・`Code302`・`Code4xx`・`Code5xx`・`BlockedByRobotsTxt`・`AllOtherCodes`・`ConnectionTimeout`・`DnsFailures`・`ContainsMalware`・`InLinks` を **Bing の名前のまま** 保存（無い項目は書かない）。日付は `date`。
- **feeds**: 期間で切らない。`Url`・`Type`・`Status`・`UrlCount`・`FileSize`・`Compressed` はそのまま、`Submitted`・`LastCrawled` は `YYYY-MM-DD`。

## R5 保存の形

```
data/bing-webmaster/
  README.md                 中身の説明（R7）
  latest.json               最新の取り込みの所在
  YYYYMMDD/traffic.json     { site_url, window, rows: [{ date, impressions, clicks }] }
  YYYYMMDD/queries.json     { site_url, window, rows: [{ query, impressions, clicks, position, click_position, weeks }] }
  YYYYMMDD/pages.json       { site_url, window, rows: [{ page, impressions, clicks, position, click_position, weeks }] }
  YYYYMMDD/crawl.json       { site_url, window, rows: [{ date, CrawledPages, InIndex, ... }] }
  YYYYMMDD/feeds.json       { site_url, rows: [{ Url, Type, Status, UrlCount, FileSize, Compressed, Submitted, LastCrawled }] }
```

latest.json:

```json
{
  "fetched_at": "2026-11-15T19:00:00.000Z",
  "site_url": "https://mori-zeirishi.net/",
  "window": { "start": "2026-10-14", "end": "2026-11-10", "days_reported": 28, "conflicting_dates": [] },
  "totals": { "impressions": 0, "clicks": 0 },
  "files": { "traffic": "20261115/traffic.json", "queries": "20261115/queries.json" },
  "sections": {
    "traffic": { "status": "ok", "raw_rows": 180, "dropped_rows": 0, "date_min": "2026-05-15", "date_max": "2026-11-10" },
    "queries": { "status": "ok", "raw_rows": 2400, "dropped_rows": 0, "used_rows": 400, "weeks": 4, "weeks_at_cap": 4, "date_min": "2026-05-15", "date_max": "2026-11-06" },
    "feeds": { "status": "failed", "reason": "GetFeeds: HTTP 500" }
  }
}
```

- `date_min`・`date_max` は期間で切る前の全部の行の範囲（Bing がどこまで遡って返すかを見るため）。
- 日付フォルダの名前は取得日（UTC）の `YYYYMMDD`。直近 12 個を残す（`require('./fetch-search-console').prune` を使ってよい）。
- **traffic が失敗したら何も書かない**（latest.json も前のまま）。`run()` は例外、コマンドは終了コード 1。
- traffic 以外の窓口が失敗したら、その窓口のファイルは書かず、`files` から外し、`sections.<名前>` を `{ status: 'failed', reason }` にして、残りは保存する。終了コード 0 で、失敗した窓口ごとに `::warning::Bing の <名前> を取得できませんでした（<理由>）` を出す。
- JSON は `fetch-search-console.js` と同じく `JSON.stringify(…, null, 2)` ＋末尾の改行。

## R6 形の記録（毎回ログに出す）

窓口ごとに 1 行。受け入れで本物の応答の形を確かめるためのもの。検索語・URL の中身や数の値は出さない。

```
[bing] GetQueryStats: 2,400 行（日付 2026-05-15〜2026-11-06、日付 26 種類、1 日付あたり最大 100 行）、項目 AvgClickPosition,AvgImpressionPosition,Clicks,Date,Impressions,Query、順位 1.0〜87.5、捨てた行 0
```

- 項目は最初の行のキーを並べ替えたもの（`__type` は除く）。順位は queries・pages の `AvgImpressionPosition` のうち 0 より大きいものの最小〜最大。traffic・crawl は「同じ日付の重複 <数>、食い違い <数>」を足す。
- 最後に `[bing] 保存: <YYYYMMDD>（期間 <start>〜<end>、表示 <n> ／ クリック <n>、検索語 <n> 行 ／ ページ <n> 行）`。

## R7 ワークフロー・文書

### `.github/workflows/fetch-search-console.yml`

- 冒頭のコメントの「必要な secret」に `BING_WEBMASTER_API_KEY — Bing Webmaster Tools の API キー（任意。未設定なら Bing だけスキップ）` を足す。
- `workflow_dispatch.inputs` に `dry_run`（boolean、既定 false、説明「試しに動かす（PR・通知・GSC 候補の更新をせず、結果を成果物に置く）」）を足す。
- 「Fetch from Search Console」の直後に手順を足す:

```yaml
      - name: Fetch from Bing Webmaster Tools
        env:
          BING_WEBMASTER_API_KEY: ${{ secrets.BING_WEBMASTER_API_KEY }}
        run: |
          if [ -z "$BING_WEBMASTER_API_KEY" ]; then
            echo "::notice::BING_WEBMASTER_API_KEY が未設定のため Bing の取り込みをスキップします"
          else
            node scripts/fetch-bing-webmaster.js || echo "::warning::Bing の取り込みに失敗しました（サーチコンソールの処理は続けます）"
          fi
```

- 「Update GSC topics」と「Create PR if changed」に `if: ${{ inputs.dry_run != true }}` を付ける（予定の実行では inputs が空なので今どおり動く）。「Notify freshness candidates」は今の `if:` のままでよい（PR が無ければ動かない）。
- 「Create PR if changed」: `git status --porcelain -- …` と `git add` に `data/bing-webmaster` を足す（今の `git add data/search-console data/freshness` の並びは崩さず、その後ろに足す）。PR 本文の「全文: data/search-console/report.md」の前に「Bing の数字はレポートの「Bing の数字」の節にあります。」の 1 文を足す。
- 最後に手順を足す:

```yaml
      - name: Upload dry-run result
        if: ${{ inputs.dry_run == true }}
        uses: actions/upload-artifact@v4
        with:
          name: bing-dry-run
          path: |
            data/bing-webmaster/
            data/search-console/report.md
          retention-days: 3
          if-no-files-found: warn
```

- 変えないもの: `on.schedule`・`permissions`・`concurrency`・既存の手順の名前と順番・「Fetch from Search Console」の中身・`run:` の中に `${{ inputs.* }}` などを書かない決まり（`test-workflow-run-injection.js`）。

### `docs/search-console-setup.md`

末尾の「うまくいかないとき」の前に節「## Bing Webmaster Tools の取り込み」を足す。中身:

- 鍵は GitHub Secret `BING_WEBMASTER_API_KEY`（2026-11-13 に毛利が登録済み）。鍵は利用者ごとに 1 つで、サイトごとではない。作り直したら Secret も更新する。未設定なら Bing だけスキップし、サーチコンソールの取り込みは今どおり。
- 取り込むもの: 検索の表示・クリック（日ごと。ウェブ以外のチャット・ニュース・画像・動画も含む）、検索語・ページ（週ごとの上位だけ。合計は全体ではない）、巡回（日ごと）、サイトマップ。AI Performance（AI の回答での引用）は API に無いので取り込まない。
- 貯まるもの: R5 の木の図。保持は直近 12 回分。
- うまくいかないとき: ログに `ErrorCode 3 InvalidApiKey` → 鍵の誤り（Secret の貼り直し）。Bing が失敗してもサーチコンソールの PR は作られ、レポートの節に「今週の Bing の取り込みは失敗したか未設定です」と出る。
- 試しに動かす: Actions →「Fetch Search Console」→ Run workflow で `dry_run` に印を付ける（PR は作らず、結果を成果物 `bing-dry-run` に 3 日置く）。

「関係するファイル」の表に `scripts/fetch-bing-webmaster.js`（Bing の取り込み）と `data/bing-webmaster/` を足す。

### `data/bing-webmaster/README.md`（新規）

`data/search-console/README.md` と同じ形で 5 行ほど（latest.json・YYYYMMDD/ の 5 ファイル・保持 12 回・説明は docs/search-console-setup.md）。

## R8 試験（新しいファイル `scripts/lib/__tests__/test-bing-webmaster.js`、`masters:test` の末尾に足す）

本物の API は呼ばない。偽の fetch（`test-search-console-ingest.js` の書き方）で次を確かめる。偽の鍵は `fake-bing-key-for-tests` のような鍵らしくない文字列を使う。一時フォルダに書き、終わったら消す。

1. 鍵が無ければ `skipped`、何も書かない、fetch を 1 回も呼ばない。
2. 呼んだ URL: 5 つの窓口だけ、方法は GET（または未指定）、`https://ssl.bing.com/webmaster/api.svc/json/` で始まり、`siteUrl` と `apikey` が付く。一覧に無い窓口名（`SubmitUrl` など）で URL を作ろうとすると例外。
3. 1 つ目のサイトで失敗したら 2 つ目を使う。
4. 日付: `/Date(1316156400000-0700)/` → `2011-09-16`、`/Date(1772755200000)/` → `2026-03-06`、ISO の文字列、読めない日付の行は捨てて数える。
5. 期間: traffic の最新日から 28 日。期間外の行が使われない。traffic が 0 行のときは他の窓口の最新日。全部 0 行なら `window: null`。
6. 同じ日付の行: 同じ値なら 1 回だけ数え、違えばその日を除いて `conflicting_dates` に入る。
7. queries のまとめ: 2 週分の同じ語が足され、順位が表示回数の重み付き平均になり、-1 の順位・表示 0 の行は平均に入らない。`click_position` も同様。1,000 行で切る。並び順。
8. 失敗の扱い: traffic が失敗 → 例外、何も書かない（前からある latest.json は中身が変わらない）。queries だけ失敗 → `sections.queries.status === 'failed'`、`files.queries` が無い、他は保存。429 → 再試行して成功。400 → 再試行しない。
9. **鍵が漏れない**: 偽のサーバーが (a) 400 で本文に URL 全体（鍵入り）を返す、(b) fetch が URL 全体を含む message の例外を投げる、(c) 成功、のそれぞれで、書いた全部のファイルの中身と、log に渡った全部の文に、偽の鍵・`apikey` が含まれない。失敗の理由の文が R2 の決まった形になっている。
10. 応答の余計な項目（`__type`・知らない項目）が保存されない。
11. 古い日付フォルダが 12 個を超えたら消える。
12. ワークフロー（文字で確かめる。CRLF は LF に直してから）: Bing の手順が「Fetch from Search Console」の後・「Build freshness candidates and report」の前にある。鍵は `env:` で渡し、`run:` に `secrets.` が無い。失敗しても止まらない（`|| echo "::warning::`）。`git add` に `data/bing-webmaster` がある。`dry_run` のとき「Update GSC topics」「Create PR if changed」が動かず、「Upload dry-run result」が動く。
13. 記事生成の側が Bing のデータを読まない: `scripts/` の下（`__tests__` を除く）で `bing-webmaster` を含む `.js` は `fetch-bing-webmaster.js` と `report-search-console.js` だけ。

## 変更してはいけないもの

- `scripts/fetch-search-console.js`・`scripts/inspect-index-status.js`・`scripts/update-gsc-topics.js`・`scripts/generate-draft.js`・`scripts/topic-pool.js`
- `data/search-console/` の中のデータ（試験は一時フォルダで）
- `.github/workflows/` の `fetch-search-console.yml` 以外
- `netlify.toml`
