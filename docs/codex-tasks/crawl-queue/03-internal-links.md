# 03 内部リンクの重み付け（物販の中核へ集める）

## 目的

Google が把握している各ページへの参照元は平均 1.0 本で、重要ページを示す手がかりがない。ネット物販の中核 5 本とサービスページへ、クロール済みのページ（トップ・物販の記事・物販ハブ）からリンクを集中させ、先に読ませる。

## R1 中核 5 本の定義を 1 か所に置く

`data/pickup-posts.json`:

```json
{
  "_note": "トップの「まず読む」枠、物販ハブの固定枠、物販記事の案内枠で使う中核記事。slug のみ。存在しない slug や未公開の slug は build が警告して飛ばす。",
  "netshop_core": [
    "ebay-shouhizei-kanpu-kihon",
    "ebay-export-consumption-tax-refund-guide",
    "ebay-tax-refund-required-documents",
    "ebay-taxable-vs-exempt-business",
    "ebay-export-invoice-system-impact"
  ],
  "netshop_services": ["ebay-export", "online-seller"]
}
```

- 将来 eBay 還付の中核記事（02 R5）が公開されたら、この配列を差し替えるだけで全枠が切り替わる。
- build は slug を `postsMap` で引き、公開中（`isPublished`）のものだけ使う。1 本も無ければ枠自体を描かない。

## R2 トップページの「まず読む」枠

- `templates/pages/index.html` に `{{PICKUP_POSTS_HTML}}` を追加し、位置は業種ガイド（`{{HUB_GUIDE_HTML}}`）と最新記事（`{{LATEST_POSTS_HTML}}`）の間。
- 見出し（H2）: 「ネット販売・eBay 輸出の消費税、まずここから」。1 行の説明: 「還付の仕組みから必要書類、インボイスの影響まで。順番に読めば全体がつかめます。」
- 中身: 中核 5 本のカード（既存の記事カード部品 `renderLatestPostCard` を再利用。title と冒頭 1 行）。カードの下に 2 つのボタン: 「eBay 輸出・越境 EC の税務」→ `/services/ebay-export/`、「ネット販売・せどり・フリマの税務」→ `/services/online-seller/`（既存のボタンのクラスを使う）。
- スマホで 1 列、PC で 2〜3 列。既存の CSS で足りるならクラスを足さない。新しい JavaScript は禁止。
- 構造化データ（`ItemList` 等）は足さない。

## R3 物販ハブの固定枠

- `data/hub-config.json` の `retail.featured` に中核の先頭 3 本を入れる（`pickFeaturedPosts` は最大 3）。
- ハブの固定枠が 5 本まで持てるように上限を引数化してもよいが、他のハブは 3 のまま。

## R4 物販の記事から中核へ

- 対象: `hubMacroFor(post) === '物販'`、または `primary_persona` が `ebay_export_seller` / `domestic_ec_seller` / `reseller_marketplace_seller` の記事。
- 記事本文の直後、既存のサービス案内（`service-links.js` の枠）の**前**に、案内枠を build 時に差し込む（記事の Markdown は触らない。テンプレートの部品として `templates/blog-post.html` に `{{PICKUP_BOX_HTML}}` を追加）。
- 見出し（H2 相当のスタイル、見出しタグは H2 で可）: 「ネット販売の消費税、基本から確認する」。中身は中核 5 本のうち自分自身を除いたもののタイトルリンク（最大 4 本）と、サービスページ 1 本（`ebay_export_seller` なら `/services/ebay-export/`、それ以外は `/services/online-seller/`）。
- 対象外の記事（相続・サロン・建設など）には何も出さない。
- 関連記事欄（3 本）はそのまま。ただし物販の記事では、関連 3 本のうち中核と重複するものは別の記事に差し替えて、リンク先が二重にならないようにする。

## R5 テスト

新規 `scripts/lib/__tests__/test-pickup-links.js`:

- `data/pickup-posts.json` の slug がすべて公開中の記事で、サービス slug が `services/<slug>/index.html` として存在する。
- build 後、`index.html` に中核 5 本と 2 つのサービスページへのリンクがある。
- 物販の記事（例: `ebay-growth-platform-fee-treatment-guide`）の HTML に案内枠があり、自分自身へのリンクが無い。
- 相続の記事の HTML に案内枠が無い。
- `retail` ハブの HTML の固定枠に中核 3 本が出る。
- `sitemap.xml` の URL 数と一覧が 01 適用後と変わらない（内部リンクの変更で URL は増減しない）。
- `pickup-posts.json` を空配列にした場合、トップに枠が出ず build が失敗しない。

`npm run masters:test` に加える。

## 変更してはいけないもの

- `content/posts/*.md`。
- 既存のサービス案内枠の文言と位置。
- 記事の `canonical`・構造化データ・パンくず。
- 物販以外の記事の HTML（差分ゼロをテストで確認: 代表 1 本の build 前後で `PICKUP` 関連以外の差分が無いこと）。
