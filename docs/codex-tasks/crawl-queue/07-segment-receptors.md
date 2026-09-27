# 07 流入が来ている 3 分野の受け皿（専用ページは作らない）

## 背景

28 日間の検索表示で流入が来ているのは、一人親方（建設）・コンテンツ販売・アフィリエイト／インフルエンサーの記事だった。毛利の決定（2026-09-25）: この 3 分野は**受ける**が、集客の本命はネット物販。専用のサービスページは作らず、既存のサービスページに「対応している業種・働き方」を足し、業種ハブからサービスへ導線を張る。

記事 → サービスの対応（`scripts/lib/service-links.js`）は既に `construction_solo → tax-return`、`content_seller → online-seller`、`influencer_creator / youtuber → tax-return`。この対応に合わせる。

## R1 設定 `data/service-segments.json`

サービス slug → 対応する業種・働き方の一覧。文言は下書き（【要確認】毛利が PR のプレビューで確認・修正する。料金・件数・実績などの数値は入れない）。

```json
{
  "_note": "サービスページの「対応している業種・働き方」。label は見出し、blurb は 1 文、hub は /blog/macro/<hub>/ へのリンク。空配列なら節を出さない。",
  "tax-return": [
    { "label": "一人親方・建設業", "hub": "construction", "blurb": "人工代・材料費・外注費の区分、受け取った源泉徴収の処理、青色申告まで一緒に整えます。" },
    { "label": "インフルエンサー・クリエイター・YouTuber", "hub": "influencer", "blurb": "PR 案件や広告収入の計上時期、源泉徴収の精算、経費の線引きを実務に沿って整理します。" },
    { "label": "ネット販売・せどり", "hub": "retail", "blurb": "複数のモール・決済の売上集計から棚卸、消費税の判定まで対応します。" }
  ],
  "online-seller": [
    { "label": "コンテンツ販売（note・Kindle・オンラインサロン）", "hub": "content", "blurb": "権利確定日での収入計上、プラットフォーム手数料の処理、所得区分の判断を扱います。" },
    { "label": "アフィリエイト・ブログ", "hub": "influencer", "blurb": "ASP 報酬の計上時期、インボイス登録の要否、法人化の目安を扱います。" }
  ],
  "bookkeeping": [
    { "label": "美容サロン", "hub": "salon", "blurb": "予約システムや決済端末の売上取り込み、簡易課税の判定まで含めて記帳します。" },
    { "label": "小売店", "hub": "retail-store", "blurb": "レジ売上・現金過不足・返品・商品券の処理を月次で整えます。" },
    { "label": "一人親方・建設業", "hub": "construction", "blurb": "現場ごとの原価と外注費の管理を記帳の段階から揃えます。" }
  ],
  "startup": [
    { "label": "法人化を考えるクリエイター・アフィリエイター", "hub": "influencer", "blurb": "売上規模と所得税・法人税の比較、設立のタイミングと手続きを整理します。" }
  ]
}
```

`hub` は `/blog/macro/<hub>/` が存在するものだけ。存在しない hub や未知のサービス slug は build が警告して飛ばす。

## R2 サービスページの節

- 各 `templates/pages/services/<slug>.html` に `{{SERVICE_SEGMENTS_HTML}}` を追加する。位置は「できること」の直後、「進め方」の前。
- 出力: 既存の節の見た目（`section-label` = `For You`、`section-heading` = 「対応している業種・働き方」、`divider-orange`）。中身はカードで、`label`（見出し）、`blurb`（1 文）、リンク「業種別ガイドを読む」→ `/blog/macro/<hub>/`。既存の `service-card` 系のクラスを再利用し、新しい CSS は最小限、JavaScript は足さない。
- 一覧が空のサービスでは節を丸ごと出さない（`ebay-export`、`inheritance`、`tax-audit` は今回は空）。

## R3 業種ハブ → サービス

- 業種ハブの「関連するサービス」（`renderHubServicesHtml`、`hub.services`）が、少なくとも次を含むようにする: `construction → tax-return, bookkeeping`、`content → online-seller, tax-return`、`influencer → tax-return, startup`、`youtube → tax-return`。定義場所は `scripts/lib/hub-content.js`（無ければ該当の定義元）。既にあるものは順序だけ整える（対応するサービスを先頭に）。

## R4 テスト

`scripts/lib/__tests__/test-service-segments.js`（`npm run masters:test` に追加）:

- 設定の `hub` がすべて実在のハブ、サービス slug がすべて `service-links.js` に定義済み、数値（`\d`）が `label` / `blurb` に含まれない。
- build 後、`services/tax-return/index.html` に一人親方とインフルエンサーの節とハブへのリンクがある。`services/ebay-export/index.html` には節が無い。
- `blog/macro/construction/index.html` に `/services/tax-return/` へのリンクがある。
- 空配列にしたとき節が出ず build が失敗しない。
- `sitemap.xml` の URL 数と一覧が変わらない。

## 変更してはいけないもの

- サービスページの既存の文言・料金・FAQ。
- `content/posts/*.md`。
- 記事末尾のサービス案内（`service-links.js`）の対応表。
