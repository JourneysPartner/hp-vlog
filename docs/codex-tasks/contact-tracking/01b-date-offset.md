# 01b 日付の 1 日ずれを直す（01 の追加）

01 の実装中に見つかった既存の不具合。01 と同じ PR に入れる。

## 不具合

`netlify/functions/lib/analytics-store.js` の `dateOffset(date, offset)` は、`${date}T00:00:00+09:00`（＝前日 15:00 UTC）から UTC の日付を取り出すため、**1 日前の日付を返す**（`dateOffset('2026-10-27', 0)` が `'2026-10-26'`）。

- 管理画面のアクセス解析（`admin-list-analytics.js`）は 90 日を「昨日〜91 日前」で読んでおり、**当日の記録が出ない**。カードの「今日」は昨日の値、「昨日」は一昨日の値になっている。
- 本番反映後の確認（記事 → 無料相談 → 管理画面に出るか）が当日にできない。
- `analytics-cleanup.js` の残す範囲も 1 日ずれている（今日を含む 90 日のつもりが、91 日前から残している。害は無い）。

## 実装要件

- R7 `dateOffset` を、日付の文字列を UTC の 0 時として読み（`${date}T00:00:00Z`）、`setUTCDate` で足し引きし、`toISOString().slice(0, 10)` で返す形に直す。引数・戻り値の形は変えない。
- `admin-list-analytics.js`・`analytics-cleanup.js` の呼び出し側は変えない（直した `dateOffset` で意図どおりになる）。

## 試験

- `dateOffset('2026-10-27', 0) === '2026-10-27'`、`-1 → '2026-10-26'`、`dateOffset('2026-11-01', -1) === '2026-10-31'`、`dateOffset('2027-01-01', -1) === '2026-12-31'`、`dateOffset('2026-02-28', 1) === '2026-03-01'`、`dateOffset('2026-10-27', -89) === '2026-07-30'`
- 管理 API の試験（`test-contact-transition.js` の 254 行付近）を、ずれを前提にした書き方から「API の `today`（`jstDate()`）の行が `daily` の最後に入り、当日の `submissions/<今日>` が合計に出る。90 日より前（`dateOffset(today, -90)`）は出ない」に直す。「この変更では修正しない」のコメントは消す。
- `analytics-cleanup.js` を偽の store で動かせるなら、`uniq/<今日−89日>/` は残り `uniq/<今日−90日>/` は消えることを確かめる（関数の作りで試せなければ、その旨を報告するだけでよい。作りを変えてまで試さない）。
- 01 の試験・`test-workflow-change-detection.js` がそのまま通る。
