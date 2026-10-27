# 01 双子記事の統合と重複ファイルの整理

## 目的

同じ検索語で競合している「本命（guide）」と「補強（practice）」を 1 本にまとめ、消える側を 301 で残す側へ向ける。あわせて同じ slug の古い下書きファイルを消し、クロール待ち行列と混乱を減らす。

## R1 統合する 4 組（残す側は 28 日間の表示回数が多い方）

| 組 | 残す（本命） | 統合して消す | 根拠（表示 / 平均順位） |
|---|---|---|---|
| A | `affiliate-pr-incorporation-incorporation-threshold-guide` | `affiliate-pr-incorporation-incorporation-threshold-practice` | 97 / 12.9 vs 10 / 38.2 |
| B | `affiliate-pr-growth-invoice-judgement-guide` | `affiliate-pr-growth-invoice-judgement-practice` | 92 / 9.9 vs 5 / 16.8 |
| C | `youtube-side-business-withholding-treatment-guide` | `youtube-side-business-withholding-treatment-practice` | 131 / 6.9 vs 39 / 6.1 |
| D | `shopify-growth-overseas-tax-uncertain-practice` | `shopify-growth-overseas-tax-uncertain-guide` | 60 / 7.2 vs 20 / 10.2 |

組 D だけ practice 側を残す（表示が 3 倍）。

### 統合のしかた（本文は原文のまま移す）

1. 消す側の本文から、導入の定型（読者への呼びかけ、記事の位置づけ）と、残す側と見出しが同じか明らかに同内容の節を除いた**残りの節を、そのままの文章で**残す側の末尾に追加する。追加ブロックの先頭は H2 で `実務編：<消す側の元の title>`、消す側の H2 は H3 に一段下げる。
2. FAQ が両方にあるときは、質問文が重複しないものだけを残す側の FAQ に足す。
3. 出典（`source_url` 等）が消す側にしか無いものは、残す側の出典欄に追加する。既存の出典の並びは変えない。
4. 残す側の frontmatter は本文追加に伴うものだけ変える: 更新日にあたる項目（build が `dateModified` に使っているもの。無ければ `updated` を新設して build 側で `dateModified` に反映）を統合日にする。`title`・`slug`・`date`・`category`・persona は変えない。
5. 消す側のファイルは残し、frontmatter を `review_status: "merged"`、`merged_into: "<残す側の slug>"` にする。本文は消さない（履歴と重複判定のため）。
6. **言い換え・要約・数字の変更・新しい税務記述の追加は禁止。** 判断に迷う節は「移す」を選ぶ（削るより安全）。

### build 側

- `review_status` が `published` 以外は現状どおり描画しない（確認のみ）。
- サイトマップ・一覧・ハブ・関連記事・トップから `merged` の記事が消えることをテストで担保する。
- 記事生成側の既存 slug 判定（`getExistingSlugs`、未マージ下書きの corpus、重複判定）が `merged` のファイルも「使用済み」として数えることを確認する。数えないなら数えるようにする（同じ話題が再生成されるのを防ぐ）。

## R2 301 リダイレクト

`netlify.toml` の `[[redirects]]` に 4 本追加する（`status = 301`）。既存の管理画面用のルールより**前**に置くか、後ろでも競合しない位置に置く。

```
[[redirects]]
  from = "/blog/affiliate-pr-incorporation-incorporation-threshold-practice/"
  to   = "/blog/affiliate-pr-incorporation-incorporation-threshold-guide/"
  status = 301
```

（B・C・D も同様。D は guide → practice。）

末尾スラッシュ無しの URL は Netlify が既定で正規化するので、`from` は末尾スラッシュ付きの 1 本でよい。

## R3 重複ファイル 6 本の削除

同じ slug の古い下書き（`review_status: draft`）を削除する。描画されている `published` の 1 本は触らない。

| slug | 削除するファイル（`content/posts/`） | 残す |
|---|---|---|
| `ebay-export-consumption-tax-refund-guide` | `2026-04-14-…` | `2026-05-01-…`（published） |
| `ebay-export-invoice-system-impact` | `2026-04-17-…` | `2026-05-03-…`（published） |
| `ebay-tax-refund-required-documents` | `2026-04-25-…`、`2026-05-01-…` | `2026-05-02-…`（published） |
| `ebay-taxable-vs-exempt-business` | `2026-04-29-…`、`2026-05-02-…` | `2026-05-03-…`（published） |

ファイル名は `grep -l '^slug: "<slug>"' content/posts/*.md` で確定させ、`review_status` を確認してから消す。削除で `sitemap.xml` の URL 数は変わらない（テストで担保）。

## R4 テスト

新規 `scripts/lib/__tests__/test-consolidation.js`（既存テストの流儀: 自前の `assert` と PASS/FAIL 集計）:

- 統合 4 組について、残す側の本文に `実務編：` の H2 があり、消す側の `review_status` が `merged` で `merged_into` が残す側を指す。
- 消す側の slug が `sitemap.xml`、`blog/index.html`、該当ハブ、残す側の関連記事欄のどこにも出ない。
- `netlify.toml` に 4 本の 301 があり、`from` と `to` が表のとおり。
- 同じ slug を持つファイルが `content/posts/` に 2 つ以上無い。
- 生成側の既存 slug 集合に `merged` の 4 slug が含まれる。

`npm run masters:test` の一覧にこのテストを加える。

## 変更してはいけないもの

- 上記 14 ファイル以外の `content/posts/*.md`。
- 残す側の `title`・`slug`・`date`・URL。
- 統合で移す文章の中身。
- 4 組以外の guide/practice の対（`オンラインサロン 会費 経費` や `一人親方 源泉徴収` で並んだ 2 本は別の話題なので対象外）。
