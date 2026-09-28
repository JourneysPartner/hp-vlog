# 03 サーチコンソールの結果を記事に戻す

02 の `target_query` を前提にする。既存記事の本文は変えない（改稿の実行は鮮度設計の第 2 段階で扱う。ここでは候補と根拠を出すまで）。

## R1 週次レポートの拡張（`scripts/report-search-console.js`）

- 新規 `scripts/lib/query-placement.js` `locateQuery(query, { title, headings, body })` → `'title' | 'h2' | 'body' | 'none'`。`seo-lint.js` の `tokenizeQuery` を使い、全トークンがその場所にあれば一致。判定順は title → h2（見出し文）→ body。
- 記事本文の読み込み: `site-corpus.readAllPosts` は本文を持たないので、`slug → { title, headings, body }` を `content/posts/` から 1 回だけ読む小さな関数を用意する（`gray-matter`）。公開中の記事だけ。
- 「伸ばしやすい語（順位 11〜30 位で表示回数が多いもの）」の表に列を足す: **該当ページ**（`query-page` の行でその語の表示が最も多いページ。記事なら slug、それ以外は種別）、**語の所在**（title／h2／本文／無し）、**推奨**。推奨の規則:
  - 所在が `title` → 「見出しと本文の充実」
  - 所在が `h2` か `body` → 「題名の見直し」
  - 所在が `none` で順位 20 以下 → 「h2 の追加」
  - 所在が `none` で順位 20 超 → 「新記事の候補」
  - 該当ページが記事でない → 「該当ページの文面」
- 新しい節「## 狙った語の順位」を「伸ばしやすい語」の直後に追加: `target_query` を持つ公開記事ごとに、`queries` の行（`normalizeQuery` で一致）から順位・表示・クリックを出す。無ければ「表示なし」。対象記事が 0 本なら「（対象の記事はまだありません）」。既存の節の順番は変えない。
- `query-page` の読み込みは `latest.files["query-page"]`。無い週は列を「（不明）」で埋めて失敗しない。

## R2 鮮度候補に「SEO 改稿」の信号（`scripts/lib/freshness-candidates.js`）

- `SIGNAL_WEIGHTS` に `seo_growable: 2` を追加。
- 条件: 公開中の記事が、ある語の `query-page` で表示回数が最も多いページであり、その語の順位が 11〜30、表示が 10 回以上、`locateQuery` が `title` でない。取り込みの鮮度は既存の `MAX_SEARCH_AGE_DAYS`。
- `reasons` の形: `{ kind: 'seo_growable', detail: '「インボイス制度 レシート」（表示34・15位）が題名に無い（所在: 本文）', where: '題名' }`。1 記事に複数の語があれば表示回数の多い順に最大 3 件。
- レポートの「更新候補」の表示は既存のまま（理由が増えるだけ）。

## R3 GSC 由来の記事候補

サジェスト由来（`update-suggest-topics.js` → `data/search-suggest-topics.json` → `suggest-topics.js`）と同じ 3 段構成。人の検収は週次 PR のマージ。

### 新規 `scripts/update-gsc-topics.js`

- 入力: `latest.json` の `queries` と `query-page`。対象の語: 28 日の表示が 10 回以上、かつ次のいずれか: 最上位ページの順位が 20 超／最上位ページで `locateQuery` が `none`／最上位ページが記事でない。除外: `normalizeQuery` が一致する `target_query` を持つ記事がある語、既に `data/gsc-topics.json` にある語、`data/topic-denylist.json` に当たる語。
- 選別: `update-suggest-topics.js` の `selectTopics` と同じ LLM 選別（同じ関数を再利用できる形に切り出す。プロンプトの文言は変えない）。出力の項目は suggest と同じ（`persona` / `tax_domain` / `category` / `article_type` / `primary_question` / `reader_problem`）＋ `impressions` / `position` / `page`（根拠）。
- 出力 `data/gsc-topics.json`: `{ "version": 1, "topics": [ { "slug": "gsc-<hash>", "phrases": ["インボイス制度 レシート", "イン ボイス 制度 レシート"], "impressions": 54, "position": 16.2, "page": "/blog/…/", "persona": …, …, "selected_at": "…" } ] }`。同じ語の表記ゆれ（`normalizeQuery` が一致、または一方が他方の全トークンを含む）は 1 件にまとめて `phrases` に並べる。既存の行は保持する。
- API キーが無ければログを出してスキップ（失敗にしない）。
- `.github/workflows/fetch-search-console.yml` の「Build freshness candidates and report」の後に `node scripts/update-gsc-topics.js` を足す。PR 本文に新しく増えた候補の一覧（語・表示・順位・提案 persona）を載せる。

### 新規 `scripts/lib/gsc-topics.js`

- `expandGscTopics()`: `suggest-topics.js` と同じ検証（persona / tax_domain / category / article_type の許容値、`phrases` 必須、企画メタ必須）。プールのトピック形式に変換: `slug` はそのまま（`gsc-<hash>`）、`title` 空、`cluster` は `gsc-<tax_domain>`、`subcluster` と `pain_point` は slug、`search_intent` は `phrases.join(' ')`、`demand_evidence: { kind: 'gsc', score, phrases, impressions, position }`。`score` = `min(95, 80 + floor(impressions / 10))`（自サイトでの実測はサジェストより強い証拠。質疑応答の上限 91 を上回ってよい）。
- `DISABLE_GSC_TOPICS=true` で空を返す。`getLastGscStats()` を用意し、`generate-draft.js` の冒頭のログにサジェストと同様に 1 行出す。
- `scripts/topic-pool.js` `getAllTopics()` でサジェストの次に合流。
- `topic-selector.js` `demandKindOf` / `enforceDemandKindDailyLimit`: `gsc` も 1 日 1 本の上限に含める（サジェストと同じ扱い）。

## R4 双子の統合

#645（01-consolidate）で 4 組とも統合・301 済み。本タスクでは何もしない。`test-consolidation.js` が通ることだけ確認する。

## R5 テスト

- 新規 `test-query-placement.js`: 4 つの所在、トークンの部分一致、英字の大小。
- `test-search-console-ingest.js`（または新規 `test-report-growable.js`）: 列の追加、推奨の規則 5 通り、`query-page` が無い週、「狙った語の順位」の節（一致あり・無し・対象 0 本）。
- `test-freshness-candidates.js` に追加: `seo_growable` の一致・不一致（順位 10、31、表示 9、所在 title）、最大 3 件、重み。
- 新規 `test-gsc-topics.js`: 対象の語の抽出規則、除外（`target_query` 保有・既存・denylist）、表記ゆれの統合、`expandGscTopics` の検証と変換、`score` の式、`DISABLE_GSC_TOPICS`、選別 LLM は偽の関数で。
- すべて `npm run masters:test` に追加。

## 変更してはいけないもの

- 記事本文・frontmatter・更新日。
- 既存のレポートの節の順番と文言（列と節の追加のみ）。
- サジェスト側の選別プロンプトの文言（再利用のための切り出しはよい）。
- 鮮度設計の第 2 段階（部分再生成・`updated_at`）はこの指示書に含めない。
