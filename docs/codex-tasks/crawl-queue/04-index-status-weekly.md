# 04 索引状態の週次取得（URL 検査 API）

## 目的

「検出 - インデックス未登録」がどのくらいのペースで減るかを、サーチコンソールの画面を開かずに毎週の PR とレポートで追えるようにする。2026-09-25 に手元で同じことをやって 303 URL・約 9 分で取れている。

## 事実（2026-09-25 に確認済み）

- エンドポイント: `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`、本文 `{ "inspectionUrl": "<URL>", "siteUrl": "https://mori-zeirishi.net/", "languageCode": "ja" }`。
- スコープは `https://www.googleapis.com/auth/webmasters.readonly` で通った。サービスアカウントの権限は「制限付き」で足りた。
- 結果は `inspectionResult.indexStatusResult` に入る。使う項目: `verdict`、`coverageState`（例: `送信して登録されました` / `検出 - インデックス未登録` / `URL が Google に認識されていません`。`languageCode: ja` だと日本語で返る）、`indexingState`、`pageFetchState`、`lastCrawlTime`、`googleCanonical`、`referringUrls`（配列）、`sitemap`（配列）。
- 上限: 1 プロパティあたり 1 日 2,000 回、1 分 600 回。1 回あたり数秒かかる。
- プロパティは `sc-domain:` 側が 403 なので、`fetch-search-console.js` と同じ順（ドメイン → URL プレフィックス）で使えた方を使う。

## R1 取得スクリプト `scripts/inspect-index-status.js`

- 鍵は環境変数 `GSC_SERVICE_ACCOUNT_JSON`。読み取りは `fetch-search-console.js` の `parseServiceAccountJson` を使う（重複実装しない。必要なら関数を `scripts/lib/` に移して両方から参照）。鍵が無ければ「未設定のためスキップ」を出して正常終了（取り込みと同じ挙動）。
- 対象 URL は `sitemap.xml` の `<loc>`。件数が 1,800 を超えるときは先頭 1,800 件までにして残りを警告に出す。
- 並列 4、1 件ごとに 150ms 空ける、1 件 60 秒で打ち切り、429 は 15 秒待って 1 回だけやり直す。失敗した URL は結果に `error` を入れて続行（全体を落とさない）。
- 出力: `data/search-console/YYYYMMDD/index-status.json`
  ```json
  { "fetchedAt": "…", "property": "…", "total": 303, "rows": [ { "url": "…", "kind": "記事", "coverage": "…", "verdict": "…", "indexing": "…", "fetch": "…", "lastCrawl": "…", "googleCanonical": "…", "referring": 1, "inSitemap": true } ] }
  ```
  `kind` は URL から判定（トップ／サービス／料金／対応地域／業種ハブ／記事／ツール／その他）。
- `latest.json` に `files.indexStatus` を追加する。既存の項目は変えない。
- 取り込みと同じ保持期間（12 週）。古い日付の削除は既存の `prune` に任せる（同じディレクトリに置くので追加処理は不要）。
- 進捗は 25 件ごとに 1 行。URL・状態以外（トークン・鍵）は出さない。

## R2 レポートの節 `report-search-console.js`

`report.md` に「索引の状態」の節を追加する（鍵が無い週や取得失敗の週は「未取得」と 1 行）。

1. 合計: 索引済み／検出 - 未登録／Google 未認識／その他／取得失敗 の件数。前回（1 つ前の `index-status.json`）との差分を「（前回比 +N / −N）」で併記。
2. 種別ごと: 件数・索引済み・索引率。
3. 記事の公開月ごと: 件数・索引済み。公開月は `content/posts/` の frontmatter から slug で引く（`site-corpus` の既存関数があればそれを使う）。
4. 「今週 新しく索引に入った URL」: 前回 未索引 → 今回 索引済み の一覧（最大 30）。
5. 「未索引の重要ページ」: サービス／料金／対応地域／業種ハブ／ツール／`data/pickup-posts.json` の中核記事 で未索引のもの。
6. 待ち行列の目安: `未索引の合計 ÷ 直近 4 回の「新しく索引に入った件数」の平均` を「このペースだと約 N 週」で 1 行（4 回分無ければ出さない）。

管理画面（`admin-analytics-page.js`）は `report.md` をそのまま出しているので変更不要。表示が崩れないことだけ確認する。

## R3 ワークフロー

`.github/workflows/fetch-search-console.yml` の「Fetch from Search Console」の手順で、`fetch-search-console.js` の後・`report-search-console.js` の前に `node scripts/inspect-index-status.js` を入れる。鍵が無いときのスキップは既存の分岐に乗せる。実行時間が伸びるので `timeout-minutes` を 30 にする。PR 作成の手順は変えない。

`workflow_dispatch` の入力に `skip_inspection`（既定 `false`）を足し、`true` のときは検査を飛ばす（週の途中で取り込みだけ再実行したいとき用）。

## R4 テスト

`scripts/lib/__tests__/test-search-console-ingest.js` に節を追加するか、新規 `test-index-status.js`:

- 鍵が無ければスキップして `status: 'skipped'` を返す。
- 偽の `fetchImpl` で 5 件を検査し、`index-status.json` の形・`kind` 判定・`latest.json` の `files.indexStatus` を確認。
- 429 → 15 秒待ち（テストでは待ち時間を差し替え可能に）→ 再試行、2 回目失敗で `error` を入れて続行。
- `report.md` に節が出る／前回ファイルがあれば差分と「新しく索引に入った URL」が出る／未取得なら 1 行になる。
- 秘密がログに出ない（`log` に渡した文字列に `private_key` の値が含まれない）。

`npm run masters:test` に加える（既存の `test-search-console-ingest.js` が一覧に無ければこの機会に加える）。

## 変更してはいけないもの

- `fetch-search-console.js` の取り込み結果の形式（`queries.json` 等）と期間の決め方。
- `report.md` の既存の節の順番と見出し（新しい節は末尾に足す）。
- 秘密の扱い（環境変数からのみ。ファイルに書かない）。
