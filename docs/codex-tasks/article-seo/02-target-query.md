# 02 狙う検索語を記事に持たせる（生成ルール）

新規に生成する記事だけが対象。既存記事の本文・frontmatter は変えない。

## 用語

- **主検索語 `target_query`**: この記事で上位を取る検索語 1 つ。検索窓に打つ形（例: `レシート インボイス`、`塗料 勘定科目`）。2〜4 語。
- **副検索語 `secondary_queries`**: 主検索語と別の切り口で、h2 か FAQ で拾う語。2〜5 個。
- **意図の型 `intent_type`**: `answer`（一問一答）／`decide`（判断・比較）／`guide`（手順・全体像）。
- **`topic_id`**: トピックプール側の識別子（従来の `topic.slug`）。**プール側の `slug` は変えない**。記事の URL になる `slug` だけを新しくする。

## R1 新規 `scripts/lib/target-query.js`

- `tokenizeQuery(q)`: NFKC 正規化 → 小文字 → 空白・`・`・`、`・`／` で分割 → 空を除く。
- `normalizeQuery(q)`: `tokenizeQuery` の結果を並べ替えて空白 1 つで結合したキー（語順の違いを同一視する）。
- `deriveIntentType(query)`: 規則で仮決め。`answer` = 勘定科目／仕訳／税率／期限／いつまで／いつから／いくらから／とは／できる／かかる／必要か／なる（か）／何種／どっち以外の可否；`decide` = どっち／違い／有利／すべき／必要？／比較／メリット／向いて；`guide` = やり方／手順／流れ／確定申告／還付／申告／計算方法／始め方。どれにも当たらなければ `decide`（既存の本命記事の構成に近いため）。優先順位は answer → decide → guide の順に判定する。
- `prefillTargetQuery(topic)`: LLM を呼ばない仮決め。`topic.demand_evidence.kind` が `search-suggest` または `gsc` なら `phrases[0]` を主、残りを副に。それ以外は `null`。
- `resolveTargetQuery(topic, callLLM, { suggestRaw, gscQueries, existingSlugs })`:
  - LLM に JSON だけを返させる（`tax-terms.js` と同じ流儀。system に制約、user に企画メタ）:

    ```json
    { "target_query": "レシート インボイス", "secondary_queries": ["適格簡易請求書 要件", "簡易インボイス 業種"], "intent_type": "answer", "slug_words": "receipt-invoice-requirements" }
    ```

  - system の制約: 検索窓に打つ形で 2〜4 語（助詞を入れない）／読者が実際に使う言い方（業種名・商品名・プラットフォーム名を含めてよい）／副検索語は主検索語の言い換えではなく別の切り口／`intent_type` は 3 値のいずれか／`slug_words` は英語 3〜6 語の kebab-case で主検索語の意味を表す（`newseg-` `deepdive-` `shitsugi-` `suggest-` `gsc-` で始めない）／確信が無い項目は空にする。
  - user に渡すもの: `title`（あれば）、`primary_question`、`reader_problem`、`search_intent`、`persona`、`tax_domain`、`demand_evidence.phrases`（あれば「実際に検索されている語」として）。
  - 検証: 主検索語は 2〜30 字・4 語以内・一般語だけ（消費税／税金／確定申告 など `tax-terms.js` の `TOO_GENERIC` に相当する語だけ）で終わらない。副検索語は最大 5・重複と主検索語との一致を除く。`intent_type` が不正なら `deriveIntentType(target_query)`。`slug_words` は `^[a-z0-9]+(-[a-z0-9]+){2,5}$` に合い、禁止の接頭辞で始まらず、`existingSlugs` に無いこと。不正なら空（呼び出し側が `topic.slug` に落とす）。
  - 裏取り `evidence`: `suggestRaw.seeds[].phrases` と `gscQueries`（`{ query, impressions, position }` の配列）に `normalizeQuery` が一致する語（または主検索語の全トークンを含む語）があれば `{ suggest: [...], gsc: [...] }` に入れる。無くても失敗にしない。
  - LLM が失敗・不正なら `prefillTargetQuery` の結果、それも無ければ `null`（生成は従来どおり続ける。frontmatter の新項目は空）。
- `findTargetQueryOwner(key, corpus)`: `normalizeQuery` が一致する `target_query` を持つ記事（公開・予約・未マージ下書き）を返す。副検索語との一致は返さない（警告用に別関数 `findSecondaryOverlap` を用意してよい）。

## R2 生成フローへの組み込み（`scripts/generate-draft.js`）

- `main()` の `enrichSourceWithLLM` のループの後、生成ループの前に、**全トピック分**を先に決める（ペアの相手の slug を frontmatter に書くため）:
  1. `topic.topic_id = topic.slug`。
  2. `resolveTargetQuery(topic, callLLM, …)`（`callLLM` は既存の `callSimpleOpenAI` を使う。`suggestRaw` は `data/search-suggest/raw-latest.json`、`gscQueries` は `data/search-console/latest.json` の `files.queries` の行。どちらも無ければ空）。結果を `topic.target_query`、`topic.secondary_queries`（配列）、`topic.intent_type`、`topic.target_query_evidence` に置く。無ければ `topic.intent_type` は `deriveIntentType(topic.primary_question || topic.title || '')`。
  3. `topic.url_slug` = 検証済みの `slug_words`。無ければ `topic.slug`。`getExistingSlugs()`＋未マージ下書き＋同じ実行の他トピックの `url_slug` と重ならないこと。重なれば `topic.slug` に落とし、それも重なれば従来と同じ扱い（生成しない）。
  4. **生成前の取り下げ**: `topic.target_query` があり `findTargetQueryOwner` が既存記事を返したら、その記事の slug が `topic.replaces` に含まれる場合を除き、このトピックを生成せず `lastSelectionWarnings` に「狙う検索語「…」は <slug> が既に持っている → 取り下げ」を積んで次へ。`--force-slug` のときは `console.error` して `process.exit(1)`（既存の重複 slug の扱いと同じ）。
  5. ログ: `[query] 主検索語: … / 副: … / 型: … / 裏取り: suggest N 件・gsc N 件 / slug: …`。
- 生成ループ: ファイル名は `${dateStr}-${topic.url_slug}.md`。`results[].slug`、`GITHUB_OUTPUT` の `slug1` `slugs`、通知に渡す slug は **`url_slug`**（プレビュー URL `/blog/<slug>/` に使われるため）。`checkGeneratedArticle` の除外集合には `topic.slug` と `url_slug` の両方を入れる。
- `generateArticle(dateStr, topic, pairedTopic)`: 長さ判定は `checkBodyLength(content, articleType, topic.intent_type)`（R4）。タイトル仮置きの処理の後に **SEO 点検**（R5）を入れる。
- `getExistingSlugs()`: 既存記事の `slug` に加えて `topic_id` も集合に入れる（`--force-slug` の重複判定と選定の `filter-existing-slugs` が `topic_id` でも当たるように）。
- `retryTitleOnce(body, topic)`: 制約を「28〜45 文字。45 を超えない」「主検索語（渡されたとき）の語を先頭 15 文字以内に置く」「末尾に『を解説』『について』『まとめ』を付けない」に変え、user に `主検索語: …` を渡す。
- 新規 `retrySummaryOnce(body, topic, currentSummary)`: 120 字以内、先頭 60 字以内に主検索語の語と結論。出力は要約の文字列のみ。不採用条件（10 字未満・200 字超・記入欄の残り）は `buildCanonicalFrontmatter` の summary 判定と同じ。

## R3 frontmatter と corpus

- `draft-normalizer.js` `buildCanonicalFrontmatter`: `slug` 行は `topic.url_slug || topic.slug`。`procedure_stage` の次に追加:

  ```yaml
  topic_id: "（topic.slug）"
  target_query: "（主検索語。無ければ空）"
  secondary_queries: "（カンマ区切り。無ければ空）"
  intent_type: "（answer / decide / guide。無ければ空）"
  ```

  配列ではなくカンマ区切りの文字列にする（`parseFrontmatter` が配列を読めない。`replaces` と同じ流儀）。`related_slug` はペアの相手の `url_slug || slug`。`summaryOverride` を受け取れるようにする（R5 の要約再生成用。`titleOverride` と同じ形）。
- `article-prompt-builder.js` `buildFrontmatterTemplate`: `slug` は `topic.url_slug || topic.slug`。同じ 4 行を追加（LLM が見る雛形にも出す。値はシステムが埋めるので記入欄にしない）。
- `site-corpus.js` `readAllPosts`: `topic_id`（無ければ `slug`）、`target_query`、`secondary_queries`、`intent_type` を追加。`collect-pending-drafts.js` の corpus も同じ項目を持たせる。
- `topic-selector.js` `filter-existing-slugs`: `existingSlugs` に `topic_id` も入れる。
- `validate.js`: 新項目を許容。`target_query` がある記事だけ、題名にその語が 1 つも無ければ **warning**（error にしない）。`intent_type` は 3 値か空。`secondary_queries` は文字列。
- `netlify/functions/review-page.js`: 適合スコアのチップの近くに「狙う検索語: …（型: 一問一答）」「副: …」を出す（無ければ出さない）。本命記事（`article_role: main`）の場合、レビューの確認事項として 1 行「実務で実際によくある場面（出典に無い一次情報）が 1 つ以上あるか」を表示する。

## R4 意図の型で長さと冒頭を決める

- `article-prompt-static.js`:
  - `WORD_COUNT_RANGE_BY_INTENT = { answer: { min: 2500, max: 4000 }, decide: { min: 4000, max: 6000 }, guide: { min: 5000, max: 7000 } }`。
  - `rangeFor({ articleType, intentType })`: `intentType` があればそれ、無ければ従来の `WORD_COUNT_RANGE[articleType]`、それも無ければ `edge_case`。**補強記事（support）は従来の記事タイプ別のまま**（intent を使わない。補強は原則の深掘りで長さの意味が違う）。
  - `guideTextFor(range)` はそのまま。`wordCountGuideFor({ articleType, intentType, articleRole })` を追加し、builder と user メッセージはこれを使う。`maxTokensFor(articleTypeOrOpts)` は文字列（従来）とオブジェクト `{ articleType, intentType, articleRole }` の両方を受ける。
  - `ARTICLE_TYPE_CHECKLIST` の `basic_explainer` と `comparison_decision` に `'実務で実際によくある場面（出典に無い一次情報）'` を追加。
  - `STATIC_RULES` の「═══ SEO ルール ═══」を次に差し替える（他の節は触らない）:

    ```
    ═══ SEO ルール ═══
    - 可変条件に「狙う検索語」があるときは、主検索語の語（分かち書きした各語）を次の位置に、自然な日本語で置く:
      ・題名: 先頭 15 文字以内
      ・summary: 先頭 60 文字以内に主検索語の語と結論
      ・リード文（最初の h2 まで）: 主検索語の語を含む文を 1 つ以上
      ・h2: 少なくとも 1 本に主検索語の語。副検索語は h2 か FAQ の h3 の疑問文で拾う
      ・同じ語を段落ごとに繰り返さない（詰め込みは逆効果）
    - summary（meta description）は具体的な結論・情報を含む文にする（「○○を解説します」のような曖昧表現は禁止）。120 文字以内
    - 記事冒頭で検索意図にすぐ答える（前置きを長くしない）
    - 1記事1検索意図。複数テーマを詰め込まない
    - 業種名・取引名・悩みを自然に含め、想定読者を明確にする
    - チェックリスト・判断ポイント・相談の境目を必ず入れ、「制度の説明」だけで終わらせない
    ```

  - 「═══ タイトル自然化ルール ═══」の先頭に追加: 「題名は 28〜45 文字。45 文字を超えない。『｜副題』を付ける場合も合計 45 文字以内。主検索語があれば先頭 15 文字以内に置く。末尾に『を解説』『について』『まとめ』を付けない（字数を使うだけで意味を足さない）」。
  - 「【書き始める前のチェック】」の「本命記事（5000〜7000文字）なら…」を「指定レンジに応じて h2 の本数を決める（7,000 字なら 8〜12 本、4,000 字なら 5〜7 本、1 本 400〜700 字）」に。
- `article-prompt-builder.js` `buildDynamicGenerationBlock`: 企画メタの後に次のブロック（`target_query` があるときだけ）:

  ```
  ═══ 狙う検索語 ═══
  主検索語: ${topic.target_query}
  副検索語: ${secondary.join(' / ')}
  意図の型: ${label}
  ${intentInstruction}
  ```

  `intentInstruction`:
  - answer: 「一問一答。リード文の 1 文目で答えを書く（例:『塗料の勘定科目は消耗品費です。ただし年末に残った分は棚卸資産にします。』）。その後に読者の場面と疑問を短く。構成は 答え → 根拠 → 例外・分岐 → 仕訳例か表 → よくある間違い → FAQ → まとめ。**下限を満たすための増量はしない**（指定レンジの下限は目安。答えが済んだら短くてよい）」
  - decide: 「判断・比較。冒頭 2 文で結論の方向と、結論が分かれる条件を示す。以降は既存の構成テンプレート（判断ポイント・チェックリスト重視）」
  - guide: 「手順・全体像。既存のリード文の型と構成テンプレートのまま」
  - user メッセージのタイトル指示「30〜70 文字を目安。70 文字を超えない」→「28〜45 文字。45 文字を超えない。主検索語があれば先頭 15 文字以内に置く」。
- `article-length.js` `checkBodyLength(content, articleType, intentType)`: `rangeFor` を使う。第 3 引数は省略可（従来どおり動く）。answer 型は下限判定の許容率をそのまま（0.9）でよい。
- `generate-draft.js` の `generateWithOpenAI` / `maxTokens` の計算は `{ articleType, intentType, articleRole }` を渡す。

## R5 SEO 点検 `scripts/lib/seo-lint.js`

- `lintSeo({ title, summary, body, target_query, secondary_queries })` → `{ fails: [], warns: [] }`。`target_query` が無ければ両方空。トークンは `tokenizeQuery`。英数字は大文字小文字を同一視。2 文字未満のトークンは無視。
  - `title_missing_query`（fail）: 主検索語のトークンが 1 つでも題名に無い。
  - `title_query_late`（warn）: 全部あるが、最後に見つかったトークンの開始位置が 15 文字を超える。
  - `title_too_long`（fail）: 45 文字超。`title_too_short`（warn）: 28 文字未満。
  - `summary_missing_query`（fail）: 先頭 60 文字にトークンが 1 つも無い。`summary_too_long`（warn）: 120 文字超。
  - `lead_missing_query`（warn）: 最初の `## ` より前の本文にトークンが 1 つも無い。
  - `h2_missing_query`（warn）: どの h2 にもトークンが無い。
  - `secondary_not_covered`（warn）: 副検索語のうち、h2・h3 にトークンが 1 つも出ないもの（語ごとに 1 件）。
  - `keyword_stuffing`（warn）: 主検索語の全トークンを含む段落が全段落の 60% を超える。
- `preflight-check.js` `preflightCheck(raw)`: `meta.target_query` があれば `lintSeo` を呼び、fails は `warnings` に「SEO: …」として入れる（preflight はブロックしない）。
- `generate-draft.js` `generateArticle`: タイトル仮置きの処理の後、`topic.target_query` があれば:
  1. `lintSeo` を実行。`title_missing_query` か `title_too_long` があれば `retryTitleOnce`（主検索語つき）を 1 回。新題名が `checkLlmTitle` を通り、かつ再点検で題名の fail が減るときだけ採用（`titleOverride`）。
  2. `summary_missing_query` があれば `retrySummaryOnce` を 1 回。採用条件は同じ流儀（`summaryOverride`）。
  3. 残った fails と warns を `review_comment` に「⚠ SEO: …」として追記（既存の warnings と同じ結合）。本文は再生成しない。
  4. ログ `[seo] 点検: fail N / warn N（…）`。

## R6 選定ゲート `filter-target-query`

- `topic-selector.js`: `filter-existing-slugs` の直後に追加。候補の `prefillTargetQuery` が取れるもの（サジェスト・GSC 由来）について、`normalizeQuery` のキーが corpus（公開・予約・未マージ下書き）のどれかの `target_query` と一致すれば除外。`explanation.steps` に `{ step: 'filter-target-query', blocked, remaining, blockedDetails }`。プレフィルが無い候補は通す（生成前の取り下げ R2-4 が最後の砦）。

## R7 題名の長さと禁止語

- `title-lint.js`: `MAX_LEN_WARN` 70 → 45、`MAX_LEN_FAIL` 80 → 60。`SOFT_WARN_PATTERNS` に `/のポイント$/`。`HARD_FAIL_PATTERNS` に `/(を解説|について|まとめ)$/`。`CONTRAST_PAIRS` は触らない。
- `draft-normalizer.js` `checkLlmTitle`: `t.length > 80` → `> 60`。
- `validate.js`: 題名の警告は既存記事のため 80 字のまま。`target_query` がある記事だけ 45 字超で warning。
- `data/banned-phrases.json` に title 限定の行を 1 つ追加（`appliesTo: ["title"]`、`pattern: "(を解説|について|まとめ)$"`、`replacement: null`、`reason: "検索結果の表示幅を字数だけ使う末尾語（毛利決定 2026-09-27）"`）。`detectBannedInTitle` がこれを拾うことを確認。

## R8 文書

- `docs/article-generation-rules.md`: 5（文字数）に意図の型の表を追加、6（タイトル）を 28〜45 字・先頭 15 字・末尾語禁止に、12（SEO）を R4 の文言に、17（frontmatter）に 4 項目を追加、新節「20. 狙う検索語」（用語・決め方・配置・点検の要点）。既存の記述の言い回しは変えない（追記と差し替え箇所だけ）。

## R9 テスト

- 新規 `test-target-query.js`: `tokenizeQuery` / `normalizeQuery`（全角半角・語順）、`deriveIntentType`（各型 2 例ずつ＋既定）、`prefillTargetQuery`（suggest あり・無し）、`resolveTargetQuery`（偽の `callLLM`: 正常 JSON／前後に文章が付いた JSON／不正 JSON／一般語だけ／不正 slug／既存 slug と衝突／禁止接頭辞）、`evidence` の一致、`findTargetQueryOwner`。
- 新規 `test-seo-lint.js`: 各 fail・warn の発生と非発生、`target_query` 無しで空、英字の大小、60 文字・15 文字の境界。
- 新規 `test-word-count-by-intent.js`: `rangeFor`（intent あり・無し・support）、`maxTokensFor` の両引数形、`wordCountGuideFor` の文言に数値が入る。
- `test-generate-draft-output-normalization.js` に追加: `url_slug` が `slug` 行に出る、`topic_id` が元の slug、4 項目が出る、`summaryOverride` が効く、`secondary_queries` がカンマ区切り。
- `test-selector.js` に追加: `filter-target-query` が一致で除外し、不一致で通す。`filter-existing-slugs` が `topic_id` で当たる。
- `title-lint` のテスト（既存があれば追記、無ければ `test-title-lint.js`）: 45 字超 warn、60 字超 fail、末尾語 fail、`のポイント` warn、対比ペアは従来どおり通る。
- `test-preflight-check.js`（無ければ新規）: `target_query` ありで SEO の warning が出る。
- すべて `npm run masters:test` に追加。

## 変更してはいけないもの

- `content/posts/*.md`（既存記事の slug も含む）。
- `CONDITIONAL_RULES`、数値の階層、年分の書き方、出典の引用ルール、免責文、CTA。
- トピックプール側の `slug`（`topic-pool.js`・`scenario-expansion.js`・`shitsugi-topics.js`・`suggest-topics.js` の識別子）。cooldown・denylist・類似度の計算。
- 手動承認の流れ（`review-approve-background.js` の判定を緩めない）。
- `WORD_COUNT_RANGE`（記事タイプ別の既存値）と補強記事の長さ。
