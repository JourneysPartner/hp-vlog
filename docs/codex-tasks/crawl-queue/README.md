# クロール待ち行列の解消と物販優先の導線（2026-09-27）

## 背景（数字はすべて 2026-09-25 のサーチコンソール実測）

サーチコンソールの取り込み（`fetch-search-console.yml`）が 2026-09-25 に初めて動き、あわせて URL 検査 API で全 303 URL の索引状態を調べた。

| 項目 | 値 |
|---|---|
| サイトマップ | 2026-09-03 送信、09-22 最終読込、305 URL、エラー 0 |
| 索引済み | 87 |
| 検出したが未クロール（検出 - インデックス未登録） | 167 |
| Google が URL 自体を知らない | 49 |
| クロール済みなのに索引外 | 0 |
| 最古のクロール日 | 2026-08-26（サーチコンソール登録日。その日に 45 URL を一斉クロール） |
| Google のクロール速度 | 週 16〜19 URL |
| 新規記事の追加 | 週 7〜8 本（日次で「本命＋補強」の 2 本組を生成） |

- 読まれたページは 87 本すべて索引に入っている。品質で落とされた URL はゼロ。**問題は純粋にクロールが追いついていないこと。**
- 記事の索引率は公開月で分かれる: 4月 0/32、5月 2/51、6月 14/53、7月 17/48、8月 18/47、9月 12/34。Google は新しい順に読んでいる。
- 待ち行列 216 に対し差し引き週 9 本しか減らない → 現状のままだと消化に約 6 か月。
- 28 日間の検索表示 3,677・クリック 74。表示が来ているのは 一人親方・コンテンツ販売・アフィリエイト・Shopify の「業種×具体的な処理」の記事。eBay・相続・サービスページはほぼ圏外（サービス 7 本合計 表示 8）。
- 同じ検索語で「本命（guide）」と「補強（practice）」の 2 本が競合している組が 4 つあり、弱い側は 40 位前後。
- 4 つの URL に記事ファイルが 10 個重なっている（古い方は `review_status: draft` で描画されないが残っている）。
- Google が把握している各ページへの参照元は平均 1.0。内部リンクは全記事ほぼ一律 4〜6 本で、重要ページを示す重み付けがない。

## 決定事項（毛利、2026-09-25〜27）

- 一人親方・コンテンツ販売・アフィリエイトの流入は受ける。ただし**集客の本命はネット物販**（eBay 輸出・国内 EC・せどり）。
- 双子記事の統合と重複ファイルの整理をやる。4〜5 月の記事は品質で落ちたわけではないので一括削除はしない。
- 記事のペースを週 3 本に落とし、浮いた分を統合と eBay 消費税還付の中核記事の作り直しに回す。
- 索引登録の手動リクエストの順番は Claude が決める（`docs/seo/index-request-queue.md`）。
- 索引状態の診断を週次の取り込みに組み込む。

## 段階

| 段階 | 指示書 | 内容 | 触る場所 |
|---|---|---|---|
| 01 | `01-consolidate.md` | 双子 4 組の統合と 301、重複ファイル 6 本の削除 | `content/posts/`（統合対象のみ）、`netlify.toml`、build の除外 |
| 02 | `02-cadence.md` | 1 回 1 本生成、月水金、物販寄りの配分、質疑応答の絞り込み、eBay 還付の中核トピック追加 | `scripts/generate-draft.js`、`scripts/lib/category-balance.js`、`scripts/lib/shitsugi-topics.js`、`netlify.toml`、`daily-draft.yml` |
| 03 | （手作業）`docs/seo/index-request-queue.md` | サーチコンソールでの索引登録リクエストの順番。実装なし | — |
| 04 | `03-internal-links.md` | トップの「まず読む」枠、物販ハブの固定枠、物販記事から中核 5 本とサービスページへの導線 | `templates/`、`scripts/build.js`、`data/` |
| 05 | `04-index-status-weekly.md` | URL 検査 API で全 URL の索引状態を週次取得し、レポートに載せる | `scripts/`、`.github/workflows/fetch-search-console.yml`、`data/search-console/` |

実装順は 01 → 02 → 04 → 05（03 は毛利の手作業）。段階ごとに別コミットにする。

## 全段階共通の厳守事項

1. **`content/posts/*.md` は 01 で名指しした統合対象（本命 4・補強 4）と重複ファイル 6 本以外、変更しない。** 追加・改稿・並べ替えもしない。
2. 税務の記述を新しく書かない。統合で本文を移すときは**原文のまま**移す（言い換え・要約・数字の変更を禁止）。事実の数値（料金・登録番号・実績）は生成物に入れない。
3. 既存 URL を変えない。消える URL は必ず 301 で残す側へ向ける。
4. 生成された HTML の見た目は既存のクラス・部品を使う。新しい JavaScript を足さない。
5. 秘密（鍵 JSON・トークン）をログ・ファイル・PR 本文に出さない。
6. 各段階でテストを追加し、既存テストを壊さない。実行コマンドは下の「受け入れ確認」。
7. ユーザーが決めていないことは【要判断】として PR 本文に残す。勝手に決めて「決定事項」と書かない。
8. 説明文（PR 本文・コメント・レポートの文言）は日本語。識別子は英語のままでよい。

## 元に戻す方法

- 01: 補強記事の `review_status` を `published` に戻し、本命記事の追記ブロックを削り、`netlify.toml` の 301 を消す。削除した重複ファイルは git から復元。
- 02: `netlify.toml` の cron を `5 0 * * *` に戻し、生成本数の既定を 2 に戻す（設定値ひとつ）。配分表は既定を均等に戻す。
- 04: `data/pickup-posts.json` を空にすれば枠は出なくなる（テンプレートは空のときに何も描かない）。
- 05: ワークフローの手順を 1 つ消すだけ。既存の取り込みには影響しない。

## 受け入れ確認（Claude が実施）

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/lib/__tests__/test-industry-hubs.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
```

加えて:
- `sitemap.xml` の URL 数が 統合前 − 4（補強 4 本）になっている。重複ファイル削除で URL 数は変わらない。
- 統合した本命 4 本の HTML に、補強側の本文が「実務編」として入っている。
- `netlify.toml` に 4 本の 301 がある。
- 物販の記事 HTML に中核 5 本への枠が出て、相続の記事 HTML には出ない。
- トップに「まず読む」枠が出て、リンク先 5 本＋サービス 2 本が正しい。
- `data/search-console/report.md` に「索引の状態」の節が出る（鍵が無ければ「未取得」と出て失敗しない）。

## コードの入口

| 場所 | 何があるか |
|---|---|
| `scripts/build.js` | 記事・静的ページ・ハブ・サイトマップの生成。`isPublished`（`review_status === 'published'` のみ描画）、`renderRelatedPostsHtml`（関連 3 本）、`buildHubLinksHtml`、`pickFeaturedPosts`（ハブ固定枠、最大 3） |
| `scripts/lib/hub-membership.js` | 記事 → 業種ハブ（`hubMacroFor`）。persona 優先、次に frontmatter の macro |
| `scripts/lib/service-links.js` | 記事末尾の「このサービスについて相談する」の対応表 |
| `scripts/lib/cluster-taxonomy.js` | macro 一覧（`ALL_MACROS`、`物販` など）と persona → macro |
| `scripts/lib/category-balance.js` | 大分類の偏り是正。均等比率 `FAIR_RATIO` と 7 日 30% のハードキャップ |
| `scripts/generate-draft.js` | 日次生成。`pickPair`（本命＋補強の 2 本組）、`--force-slug`、GitHub Actions への出力 |
| `scripts/lib/shitsugi-topics.js` / `scripts/curate-shitsugi-candidates.js` | 国税庁「質疑応答事例」起点の候補 |
| `scripts/topic-pool.js` | トピックプール（シナリオ展開・質疑応答・サジェストの合流） |
| `netlify/functions/scheduler-daily-draft.js` と `netlify.toml` の `[functions."scheduler-daily-draft"]` | 日次生成の時刻トリガー（cron `5 0 * * *` = JST 9:05） |
| `.github/workflows/daily-draft.yml` | 生成ワークフロー。2 本目が無いときの通知（`single_reason`）あり |
| `scripts/fetch-search-console.js` / `scripts/report-search-console.js` | 週次取り込みとレポート。鍵の読み取りは `parseServiceAccountJson` |
| `data/hub-config.json` | ハブの固定枠（`featured`、slug 最大 3） |
| `docs/seo/index-request-queue.md` | 手動リクエストの順番表（Claude が診断結果から生成） |
