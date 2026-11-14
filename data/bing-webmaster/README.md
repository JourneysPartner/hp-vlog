# data/bing-webmaster

Bing Webmaster Tools の週次取り込み先。中身の説明と設定手順は `docs/search-console-setup.md`。

- `latest.json` … 最新の取り込みの所在（サイト・期間・合計・失敗した窓口）
- `YYYYMMDD/traffic.json` … 日ごとの表示・クリック（サイト全体）
- `YYYYMMDD/queries.json` … 検索語（週ごとの上位。合計は全体ではない）
- `YYYYMMDD/pages.json` … ページ（週ごとの上位。合計は全体ではない）
- `YYYYMMDD/crawl.json` … 日ごとの巡回と索引の数
- `YYYYMMDD/feeds.json` … サイトマップ
- `YYYYMMDD/` … 取り込み日ごとのデータ（直近12回分を保持）
