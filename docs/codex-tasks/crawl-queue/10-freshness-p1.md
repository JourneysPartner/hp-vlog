# 10 記事の鮮度: 第 1 段階（変化の検知と更新候補の一覧）

設計は `docs/seo/freshness-design.md`。毛利の判断（2026-09-27）: 表示は更新日だけ（「内容を確認: 日付」は出さない）／更新候補は管理画面に加えて Chatwork にも週 1 回／週次取り込みの PR に同乗してよい／年度切り替えの判定を LLM に下書きさせてよい（第 3 段階）。

この段階では**候補を出すだけ**。記事の本文・日付は一切変えない。

## R1 候補の生成 `scripts/build-freshness-candidates.js`

入力（すべて既存の成果物。無いものは空として扱い、失敗しない）:

| 信号 | 参照 | 該当記事の引き方 | 重み |
|---|---|---|---|
| 出典ページの更新 | `data/nta-sources/`（`crawl-nta-sources` が保存するハッシュ・取得日） | 記事の `source_url`（と `source_supplements` の url）が一致し、記事の公開日より後に出典が変わった | 3 |
| 税制改正の項目 | `data/tax-reform-outline.json` | 記事の `tax_domain` / `category` が項目の税目と一致し、本文に項目の制度名（改正一覧の見出し語）を含む | 2 |
| 年度の記述 | 本文 | 「令和 N 年分」「20XX 年分」「20XX 年 M 月 D 日以後（前）」のうち、現在の年度より前のものを含む（判定の年度は `data/tax-calendar.json` と暦から） | 2 |
| 検索の反応の低下 | `data/search-console/` の直近 4 回の `pages.json` | 同じ URL の表示回数が直近 2 回とも、その前 2 回の平均の半分以下（表示が 20 回以上あった URL だけ） | 1 |

出力 `data/freshness/candidates.json`:

```json
{ "generatedAt": "…", "candidates": [ { "slug": "…", "url": "…", "title": "…", "score": 5, "impressions28d": 120,
  "reasons": [ { "kind": "source_updated", "detail": "No.6551 が 2026-09-10 に更新", "where": "出典欄" },
               { "kind": "fiscal_year", "detail": "「令和7年分」を含む", "where": "## 申告の手順" } ] } ] }
```

- `score` = 重みの合計 × （表示回数の順位で 1.0〜2.0 の係数。物販の中核 `data/pickup-posts.json` は常に 2.0）。
- 上位 30 件を残す。`review_status` が `published` の記事だけ対象。
- 実行は `fetch-search-console.yml` の取り込みの後（週 1 回）。鍵が無い週も、出典と年度の信号だけで動く。

## R2 表示

- `report.md`（週次レポート）の末尾に「更新候補（上位 10）」の節: 題名（リンク）、理由、表示回数。既存の節の順番は変えない。
- 管理画面 `/admin/analytics` はレポートをそのまま出しているので追加作業なし。表示が崩れないことだけ確認。
- Chatwork: 週次取り込みの PR 作成後に、上位 5 件を 1 通で通知する（既存の `scripts/notify.js` を使う。宛先・文体は既存の通知に合わせる。候補が 0 件なら送らない）。

## R3 テスト

`scripts/lib/__tests__/test-freshness-candidates.js`（`npm run masters:test` に追加）: 4 つの信号それぞれの一致・不一致、重みと係数、上位 30 件の切り詰め、published 以外の除外、入力が無いときに空で成功、レポートの節、通知本文の形（0 件で送らない）。

## 変更してはいけないもの

- 記事本文・frontmatter・更新日。
- 既存の取り込み・レポート・通知の形式（追加のみ）。
- 第 2 段階（部分再生成と `updated_at`）・第 3 段階（年度の一括切り替え）はこの指示書に含めない。
