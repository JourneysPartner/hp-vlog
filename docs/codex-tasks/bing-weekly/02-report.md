# 02 週次レポートに「Bing の数字」の節を足す

`scripts/report-search-console.js` に、新しい関数 `buildBingSection({ bing, gscLatest, gscPages })` を足して書き出し、`buildReport` から呼ぶ。置き場所は「## 索引の状態」の節の後、「## 更新候補（上位 10）」の前。それ以外の節の中身と順番は変えない。

## R9 読み込み

- `run()` は `data/bing-webmaster/latest.json` と、その `files` が指すファイルを読む（`options.bingRoot` で場所を差し替えられること）。無い・読めない・壊れているときは `bing = null` として続ける（レポートは止めない）。
- `buildReport` の引数に `bing = null` を足す。形は `{ latest, traffic, queries, pages, crawl, feeds }`（各ファイルの中身。読めなかったものは null）。
- 鍵はこのスクリプトでは扱わない。

## R10 節の中身

`n`・`pos`・`table`・`linkCell`・`pageKind`・`signed` など今ある関数を使う。表の中の文字は `linkCell` を通す。

```
## Bing の数字（Bing Webmaster Tools）

- 取得日時: <latest.fetched_at>
- 期間: <window.start> 〜 <window.end>（Bing が返した日数 <days_reported>/28）
- 表示 <n> ／ クリック <n>（ウェブのほか、チャット・ニュース・画像・動画・ナレッジパネルの表示も含みます）
- 参考: Google（ページ別の合計、<gscLatest.range.start>〜<gscLatest.range.end>）表示 <n> ／ クリック <n>
- AI の回答での引用（AI Performance）は API で取れないため、月 1 回 Bing の画面で確かめます。

### 検索語の上位 20（表示回数順）

Bing は週ごとに上位の検索語だけを返すため、この表の合計は全体の数ではありません（期間内の週 <weeks>、うち上限に達した週 <weeks_at_cap>）。

| 検索語 | 表示 | クリック | 平均順位 |

### ページの上位 20（クリック順）

| ページ | 種別 | クリック | 表示 | 平均順位 |

### 巡回とサイトマップ

- 索引にあるページ（InIndex）: <最新の日の値>（期間の初日 <初日の値>、差 <signed>）
- 期間の合計: 巡回したページ <CrawledPages の合計> ／ 巡回の誤り <CrawlErrors> ／ 4xx <Code4xx> ／ 5xx <Code5xx> ／ robots.txt で止めた <BlockedByRobotsTxt>
- 被リンク（InLinks、最新の日）: <値>

| サイトマップ | 種類 | 状態 | 最後の読み込み | URL 数 |
```

細かい決まり:

- `bing` が null（未取り込み）: 見出しの下に「（Bing はまだ取り込まれていません。設定は docs/search-console-setup.md の「Bing Webmaster Tools の取り込み」を参照）」の 1 行だけ。
- **古いデータ**: `gscLatest.fetched_at` が `bing.latest.fetched_at` より 3 日を超えて新しいとき、見出しの直後に「**今週の Bing の取り込みは失敗したか未設定です。以下は <bing の取得日（YYYY-MM-DD）> の取り込みの数字です。**」を出す（数字はそのまま載せる）。
- `window` が null: 箇条書きの「期間」は「（まだ数字がありません）」、表示・クリックの行は出さない。
- `days_reported` が 28 未満のとき、または `conflicting_dates` があるとき、期間の行の後ろに「Bing の数字が食い違ったため除いた日: <日付をカンマ区切り>」（あれば）を出す。
- 「参考: Google」の合計は `gscPages`（`pages.json` の rows）の表示・クリックの合計。`gscPages` が無ければこの行を出さない。
- 平均順位は `pos(position)`、null なら「—」。
- ページの表は `clicks` の多い順 → `impressions` の多い順。種別は `pageKind(page)`。
- `sections.<名前>.status === 'failed'` の窓口は、その表・行の代わりに「（取得に失敗しました: <reason>）」。ファイルはあるが rows が空なら「（まだデータがありません）」。
- 巡回: 期間内の行を日付順に並べ、最新の日・初日の値を使う。項目が無い（undefined）ときは「—」。合計は数のある行だけを足す。
- サイトマップの表: 最後の読み込みは `LastCrawled`（無ければ「—」）。行が無ければ「（サイトマップの記録はありません）」。

## R11 試験（01 の `test-bing-webmaster.js` に足す）

小さな偽のデータで:

1. `bing = null` で「まだ取り込まれていません」の 1 行だけが出る。
2. 普通のデータで、期間・合計・Google の参考・検索語の表（上位 20 で切る、順位なしが「—」）・ページの表（クリック順、種別）・巡回（InIndex の差、合計）・サイトマップの表が出る。
3. 古いデータの注意: Bing の取得が GSC より 4 日古いと出る、2 日なら出ない。
4. queries が失敗のとき、その表の代わりに「取得に失敗しました: <reason>」。
5. 表の文字の `|` が `\|` になる。
6. 節の位置: 「## 索引の状態」より後、「## 更新候補（上位 10）」より前。
7. `run()` が `bingRoot` の latest.json が無くても壊れていても止まらない。

既存の試験（`test-search-console-ingest.js`・`test-gsc-link-report.js`・`test-index-status.js`・`test-freshness-candidates.js`）は期待を変えずに通ること。

## 変更してはいけないもの

- 既存の節の中身・順番・見出しの文字（PR 本文は report.md の先頭 12 行を使う）
- `scripts/fetch-search-console.js`、`netlify/functions/admin-analytics-page.js`
