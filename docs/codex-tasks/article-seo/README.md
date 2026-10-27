# 記事の作り方の SEO 見直し（2026-09-27）

設計は `docs/seo/article-seo-redesign.md`。毛利が 2026-09-27 に要判断 5 点をすべて承認した。

## 背景（数字は 2026-08-26〜09-22 のサーチコンソール実測。`data/search-console/20260925/`）

| 項目 | 値 |
|---|---|
| 記事 62 本の合計 | 表示 3,521・クリック 59 |
| 小売のインボイス記事（`newseg-retail_store-retail-invoice-guide`） | 26 語で表示 441・クリック 1。表示の中心は「インボイス制度 レシート」「簡易インボイス」「適格簡易請求書」で題名と冒頭が答えていない |
| 「塗料 勘定科目」 | 9 位。一問一答の語に本命 5,000 字の下限 |
| 「人工代」 | 33 表示・38 位。建設の外注費記事の一部でしか扱っていない |
| 同じ検索語に 2 ページが出た語 | 7 語（うち双子 4 組は #645 の 01 で統合済み・301 済み） |
| Google が把握する被参照 | 平均 1.0 本／ページ |
| 見出しのアンカー | marked 9 は id を出さない。生成 HTML の `<h2>` に id 無し。目次も無い |
| 題名 | 30〜70 字＋`<title>` の事務所名 11 字。検索結果に出るのは先頭 30 字前後 |

生成に渡る「検索意図」は語の袋（例: `商品レビュー 商品レビュー 提供 商品 収入 なる 税金 具体例 仕訳`）で、「この語で上位を取る」という単位が無い。題名・見出し・要約にその語を置く指示も、生成後の機械確認も、GSC で「狙った語で何位か」を測る手段も無い。

## 決定事項（毛利、2026-09-27）

1. 題名の上限を 70 字から **45 字**に下げる。主検索語を先頭 15 字以内に置く。
2. 一問一答（answer 型）の本文下限を **2,500 字**に下げる（2,500〜4,000 字）。
3. **本文内の文脈リンク**をビルド時に自動付与する（辞書方式。記事の Markdown は触らない）。
4. 双子 4 組の統合（弱い側を 301）→ **#645 の 01 で完了済み**。本タスクでは何もしない。
5. 記事ページの `<title>` の事務所名を「｜毛利税理士事務所」に短くする。

## 段階

| 段階 | 指示書 | 内容 | 触る場所 |
|---|---|---|---|
| 01 | `01-page-structure.md` | 見出し id と目次、関連記事 3 本、本文内の文脈リンク（辞書）、`<title>` サフィックス短縮 | `scripts/build.js`、`scripts/lib/`（新規 2 本）、`templates/blog-post.html`、`assets/css/blog.css`、`data/internal-link-terms.json`、テスト |
| 02 | `02-target-query.md` | 狙う検索語の確定工程、題名・要約・リードの配置ルール、意図の型で長さ、SEO 点検、選定ゲート、意味のある slug、frontmatter、レビュー画面 | `scripts/generate-draft.js`、`scripts/lib/article-prompt-static.js`、`article-prompt-builder.js`、`draft-normalizer.js`、`topic-selector.js`、`site-corpus.js`、`preflight-check.js`、`title-lint.js`、`validate.js`、`netlify/functions/review-page.js`、`data/banned-phrases.json`、`docs/article-generation-rules.md`、テスト |
| 03 | `03-gsc-loop.md` | 週次レポートに「伸ばしやすい語」の所在と推奨、「狙った語の順位」、鮮度候補に SEO 改稿の信号、GSC 由来の記事候補 | `scripts/report-search-console.js`、`scripts/lib/freshness-candidates.js`、新規 `scripts/lib/gsc-topics.js`・`scripts/update-gsc-topics.js`、`scripts/topic-pool.js`、`.github/workflows/fetch-search-console.yml`、テスト |

実装順は 01 → 02 → 03。段階ごとに別ブランチ・別 PR（01 の枝から 02 を切り、02 の枝から 03 を切る。マージ順は 01 → 02 → 03）。Codex は隔離内でコミットできないので、コミットは Claude が作る。

## 全段階共通の厳守事項

1. **`content/posts/*.md` は変更しない。** 追加・改稿・並べ替え・frontmatter の書き換えもしない。新しい frontmatter 項目は新規生成の記事にだけ付く。
2. 税務の記述を新しく書かない。プロンプトのルール文に税務の数値・制度の説明を足さない（配置・長さ・型の指示だけ）。
3. 手動レビュー・承認の運用を変えない。自動公開・自動承認を作らない。
4. 正確さのルール（論点別ルール `CONDITIONAL_RULES`・数値の階層 L1〜L3・年分・出典解決・通達照合・禁止語）を変えない。追加のみ。
5. 既存の選定フィルタ（existing-slugs / time-limited / denylist / relevance / quality-fit / topic-identity / cooldown / similarity / 生成後の重複判定）を弱めない。バイパスを作らない。新ゲートは追加のみ。
6. 既存 URL を変えない。既存記事の slug・canonical・構造化データ・パンくずを変えない。
7. 新しい npm パッケージを追加しない（隔離内はネット不可。marked の見出し id は自前で付ける）。公開ページに新しい JavaScript を足さない。
8. 秘密（鍵・トークン）をログ・ファイル・PR 本文に出さない。
9. 各段階でテストを追加し、既存テストを壊さない。`npm run masters:test` に登録する。
10. ユーザーが決めていないことは【要判断】として最終報告に残す。勝手に決めて「決定事項」と書かない。
11. 説明文（コメント・PR 本文・レポートの文言・レビュー画面の文言）は日本語。識別子は英語のままでよい。
12. 更新日（`updated_at` / `dateModified`）は内容を変えたときだけ動かす（鮮度設計の決定）。01 のビルド変更で既存記事の日付を動かさない。

## 元に戻す方法

- 01: `data/internal-link-terms.json` の `terms` を空配列にすれば文脈リンクは消える。目次は `buildTocHtml` の呼び出し 1 行、関連 3 本は関数の差し戻し、`<title>` はテンプレート 1 行。
- 02: `resolveTargetQuery` の呼び出しを外せば従来の生成に戻る（frontmatter の新項目は空で出る）。長さは `rangeFor` が intent 無しなら従来の記事タイプ別に落ちる。
- 03: ワークフローの手順 1 つとレポートの節を消すだけ。`DISABLE_GSC_TOPICS=true` で候補の合流を止められる。

## 受け入れ確認（Claude が実施。隔離の外で）

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-page-structure.js
node scripts/lib/__tests__/test-target-query.js
node scripts/lib/__tests__/test-seo-lint.js
node scripts/lib/__tests__/test-gsc-topics.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-selector.js
node scripts/generate-draft.js --dry-run
```

加えて:
- 01: 代表記事の HTML で h2 に id が付き、目次のアンカーが一致する。相続の記事に文脈リンクが出ない（辞書に相続の語が無い場合）。`sitemap.xml` の URL 数が変わらない。`<title>` が「…｜毛利税理士事務所」。
- 02: `--dry-run` で選定が通る。偽の LLM で `resolveTargetQuery` が JSON を読み、不正な出力で従来どおりに落ちる。frontmatter に `topic_id` / `target_query` / `secondary_queries` / `intent_type` が出る。
- 03: `report.md` に「伸ばしやすい語」の所在・推奨列と「狙った語の順位」の節が出る。鍵が無くても失敗しない。

## コードの入口

| 場所 | 何があるか |
|---|---|
| `scripts/build.js` | `generatePost`（記事 HTML。`linkCitations` → `marked` → テンプレート）、`buildRelatedArticleHtml`（関連 1 本、pickup との重複回避）、`buildPickupBoxHtml`、`buildHubLinksHtml`、`isPublished`、`postsMap` |
| `scripts/lib/citation-linker.js` | 本文中の「No.XXXX」をリンク化（Markdown 文字列に対して。既存リンク範囲はスキップ）。`applyExternalLinkRenderer`（marked 9 の renderer 上書きの例） |
| `templates/blog-post.html` | 記事ページ。`{{BODY}}` `{{PICKUP_BOX_HTML}}` `{{RELATED_ARTICLE_HTML}}` `{{HUB_LINKS_HTML}}`、`<title>{{TITLE}}｜毛利順活税理士事務所</title>` |
| `assets/css/blog.css` | `.blog-article`（本文）、`.blog-related-article`、`.blog-hub-links` |
| `scripts/lib/hub-membership.js` | 記事 → 業種ハブ（`hubMacroOf(post)` が日本語の macro 名） |
| `scripts/lib/topic-similarity.js` | `similarityScore(candidate, existing)` → `{ score, breakdown }`（0〜1） |
| `scripts/lib/article-prompt-static.js` | `STATIC_RULES`（キャッシュ対象の固定ルール）、`WORD_COUNT_RANGE`（受入基準）、`guideTextFor` / `maxTokensFor`（キャリブレーション）、`ARTICLE_TYPE_CHECKLIST`、`CONDITIONAL_RULES` |
| `scripts/lib/article-prompt-builder.js` | `buildDynamicGenerationBlock`（可変ブロック）、`buildFrontmatterTemplate`、`buildGenerationPrompt`、user メッセージのタイトル指示 |
| `scripts/lib/article-length.js` | `checkBodyLength(content, articleType)`（下限 ×0.9、上限そのまま） |
| `scripts/generate-draft.js` | `main()`（選定 → `ensureSourceOnTopic` → `enrichTaxTerms` → `enrichSourceWithLLM` → 生成ループ）、`generateArticle`（生成 → 正規化 → 長さ調整 → `retryTitleOnce` → ルール反映 → 警告を `review_comment` に）、`checkGeneratedArticle`（生成後の重複判定・取り下げ）、`getExistingSlugs`、`callSimpleOpenAI`（補助的な LLM 呼び出し。content-model 経由） |
| `scripts/lib/tax-terms.js` | 生成前に LLM で「論点語」を決める小さな工程の見本（system / user / JSON 解析 / 一般語の除外 / 失敗時は従来どおり） |
| `scripts/lib/draft-normalizer.js` | `buildCanonicalFrontmatter`（frontmatter の正本）、`checkLlmTitle`（題名の採否。80 字超で不採用）、`normalizeGeneratedDraft` |
| `scripts/lib/title-lint.js` | `lintTitle`（`MAX_LEN_WARN=70` / `MAX_LEN_FAIL=80`、同語反復、禁止句） |
| `scripts/lib/preflight-check.js` | 生成直後の規則ベース検査（現在は呼び出し元なし。02 で `generateArticle` から使う） |
| `scripts/lib/topic-selector.js` | `selectDailyTopics`（フィルタの並び。`explanation.steps` に段階名を積む）、`priorityBreakdown`（需要 ×3・季節 ×2・問い合わせ ×2・…）、`demandKindOf` / `enforceDemandKindDailyLimit` |
| `scripts/lib/site-corpus.js` | `readAllPosts`（frontmatter の抽出項目。ここに無い項目は選定側から見えない） |
| `scripts/collect-pending-drafts.js` | 未マージ下書きの corpus（同じ項目を持たせる） |
| `scripts/lib/suggest-topics.js` / `scripts/update-suggest-topics.js` | サジェスト由来の候補（`demand_evidence.kind: 'search-suggest'`、週次 PR で人の検収）。03 の GSC 由来候補はこれを見本にする |
| `scripts/topic-pool.js` | `getAllTopics()`（curated ＋ 展開 ＋ 質疑応答 ＋ サジェストの合流） |
| `scripts/report-search-console.js` | 週次レポート。`buildReport`（節の並び）、`run`（`latest.json` → `queries` / `pages` / `query-page`） |
| `scripts/lib/freshness-candidates.js` | 鮮度の更新候補（信号と重み `SIGNAL_WEIGHTS`、上位 30） |
| `data/search-console/latest.json` | `files.queries` / `files.pages` / `files["query-page"]`（行: `{ query, page, clicks, impressions, ctr, position }`） |
| `data/search-suggest/raw-latest.json` | サジェストの生データ（`seeds[].phrases`） |
| `netlify/functions/review-page.js` | レビュー画面（適合スコアのチップ、`recommendation` のバナー） |
