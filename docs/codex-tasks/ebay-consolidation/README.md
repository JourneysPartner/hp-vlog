# eBay 記事の統合（試行）— 指示書

2026-10-27 作成。毛利さん承認済み（同日）。

## 背景と数字

- サーチコンソールの「ページ」レポート（2026-10-27 取得、〜10/23）: 登録 97／未登録 224。うち「検出 - インデックス未登録」214。
- 構造の問題は無い（全記事 200・自己 canonical・サイトマップ掲載・トップから 2〜3 クリック）。Google は既知の約 100 ページを再クロールしているのに新しい URL をほとんど読まない＝サイト全体の優先度が低い。
- 「クロール済み - インデックス未登録」2 件は eBay の記事で、10/24 まで登録済みだったものが 10/25 の再クロール後に外された。どちらにも同じ論点の別記事がある。
  - `ebay-just-opened-consumption-tax-judgement-practice`（`ebay-taxable-vs-exempt-business` と同じ「基準期間 1,000 万円」の判定）
  - `ebay-growth-incorporation-threshold-guide`（双子の `-practice` と同じ論点）
- guide/practice の双子は全体で 34 組。今回は eBay の 4 組だけで試し、4〜6 週間後に統合先の登録・表示を見てから広げる。

## 方針

- 同じ論点の 2 本を 1 本にまとめ、消える側の URL は残す側へ 301 で転送する。
- やり方は前例 `docs/codex-tasks/crawl-queue/01-consolidate.md`（2026-09-27、PR #645）と同じ。消える側の重ならない節を**原文のまま**「実務編：<消える側の元の title>」として残す側の末尾に移す。
- 税務の文章は新しく書かない・言い換えない・数字を変えない。事実照合は今回かけない（毛利さんの判断。毛利さんがプレビューで目視確認する）。
- 手数料の消費税の双子（`ebay-growth-platform-fee-treatment-guide`／`-practice`）は保留。どちらも検索 5〜6 位でクリックがあるため、今回は触らない。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-merge-four-pairs.md` | 4 組の統合・301・索引リクエスト表の更新・テスト |

## 厳守事項

- `content/posts/*.md` は `01` で名指しした 8 ファイル以外を触らない。
- 残す側の `title`・`slug`・`date`/`published_at`・`related_slug`・`source_url`・`source_title`・URL を変えない。
- 移す文章の中身を変えない（見出しの階層を 1 段下げることだけ許す）。
- 消える側のファイルは消さない（重複判定と履歴のため）。
- 新しい JavaScript を公開ページに足さない。説明・コメントは日本語。

## 元に戻す方法

この段階の PR を revert する（記事 8 本・`netlify.toml`・索引リクエスト表・テストが元に戻る）。

## 受け入れ確認（Claude）

1. 隔離の外で `npm run build`・`npm run validate`・`npm run masters:test`（既存の赤は main と比べて増えていないか）と `node scripts/lib/__tests__/test-consolidation.js`。
2. 移した節が原文と一致すること（見出しの `#` 1 個の差だけ）を別スクリプトで突き合わせる。
3. `sitemap.xml` の URL 数が 310 → 306。
4. プレビューで統合先 4 本の表示と、消える側 4 本の旧 URL が 301 で統合先に飛ぶこと。

## コードの入口

- `scripts/build.js`（`review_status` が `published` 以外は描画しない。関連記事は公開中の記事だけを選ぶ）
- `scripts/lib/__tests__/test-consolidation.js`（前例の 4 組のテスト。ここに足す）
- `netlify.toml` の `# ── Redirects / Rewrites` 節
- `docs/seo/index-request-queue.md`（毛利さんが手動で索引リクエストする順番表）
