# 02 GSC 由来の記事候補の規則を直し、却下を記録できるようにする

背景は `README.md` の「問題 2」。

## 実装要件

### R1 統合済み記事は統合先で所在を判定する（`scripts/update-gsc-topics.js`）

- 検索語の最上位ページが記事 URL（`/blog/<slug>/`）で、その slug の記事が `review_status: "merged"` かつ `merged_into` を持つなら、所在の判定は `merged_into` の記事（公開中）の題名・h2・本文で行う。統合が連鎖していれば最後までたどる（循環は 5 段で打ち切り）。
- `merged_into` は `content/posts/*.md` の frontmatter から読む。`site-corpus.js` の `readAllPosts()` は `merged_into` を返さないので、`readAllPosts()` の返す項目に `merged_into` を追加する（他の項目と同じ書き方。既存の利用者に影響しない追加のみ）。
- 候補の `page` には元の URL（Google が出している URL）をそのまま残す。

### R2 順位の閾値を「伸ばしやすい語」と揃える

`extractGscCandidates()` の判定を次に置き換える。

- 最上位ページが**記事**（R1 の統合先解決後も含む）: `position > 30` かつ 所在が `title` でも `h2` でもない（`body` または `none`）ときだけ候補。
- 最上位ページが記事以外（トップ・サービス・ハブ・ツールなど）: 従来どおり `position > 20` なら候補。
- 閾値 30 と 20 は定数に出す（`ARTICLE_POSITION_MIN = 30`、`NON_ARTICLE_POSITION_MIN = 20`）。

### R3 同義語で所在を判定する（`scripts/lib/query-placement.js`）

- `data/query-synonyms.json`（新規）: `{ "_note": "...", "groups": [["簡易インボイス", "適格簡易請求書"], ["インボイス", "適格請求書"]] }`。`_note` には「検索語の所在判定で同じ語として扱う組。正式名称と通称など、意味が同じものだけを入れる」と書く。
- `locateQuery(query, content, options)` の各トークンの一致判定で、トークンが同義語の組に入っていれば、組のどれか 1 つが含まれていれば一致とする。組の読み込みは `options.synonyms`（テスト用）→ 無ければ `data/query-synonyms.json` を 1 回だけ読んでキャッシュ。ファイルが無い・壊れているときは同義語なしで動く（警告 1 回）。
- 正規化（NFKC・小文字化）はトークンと同じものを同義語にもかける。
- `locateQuery` は週次レポートの「語の所在」と鮮度の SEO 改稿信号でも使われている。そちらの結果も同義語で変わってよい（意図した変更）。

### R4 却下の記録（`scripts/lib/gsc-topics.js`・`scripts/update-gsc-topics.js`）

- `data/gsc-topics.json` の候補は任意の項目 `status`（`"rejected"` のみ意味を持つ）、`rejected_at`（YYYY-MM-DD）、`reject_reason`（文字列）を持てる。
- `expandGscTopics()` は `status === "rejected"` の候補を生成候補に入れない。`stats` に `rejected` の件数を足す（`getLastGscStats()` でも返す）。形式の検査（`validateTopic`）は却下候補にもかけ、壊れた却下候補は従来どおり `invalid` に数える。
- `update-gsc-topics.js` の既出判定（`isKnownPhrase`）は却下候補の `phrases` も含める（現状のままで満たすなら変更不要。テストで確認する）。
- 週次 PR 本文の文言（`.github/workflows/fetch-search-console.yml` の `gh pr create --body`）の「GSC 由来の記事候補は、この PR で検収してからマージしてください。」の直後に「採用しない候補は削除せず `"status": "rejected"` を付けてください（削除すると翌週また提案されます）。」を足す。

### R5 今週の却下を記録する（データ）

`docs/codex-tasks/weekly-signal-fixes/rejected-topics-20260928.json` の 5 件（`status: "rejected"`・`rejected_at`・`reject_reason` 付き）を `data/gsc-topics.json` の `topics` に追加する。`version` はそのまま、`updated_at` は変えない。すでに同じ `slug` の候補があれば、その候補をこの内容で置き換える。

## テスト

`test-gsc-topics.js` と `test-query-placement.js` に追加する。

- R1: 統合済み記事の URL が 6.5 位でも、統合先の題名に語があれば候補にならない。連鎖（A→B→C）と循環（A→B→A）で落ちない。
- R2: 記事 25 位・所在 body → 候補にならない。記事 35 位・所在 body → なる。記事 35 位・所在 title → ならない。サービスページ 25 位 → なる。
- R3: 「簡易インボイス」が「適格簡易請求書」を題名に持つ記事で `title`。同義語が無い語の結果は従来と同じ。同義語ファイルが無くても動く。
- R4: `status: "rejected"` の候補は `expandGscTopics()` の結果に入らず `stats.rejected` に数える。却下候補の語は `extractGscCandidates()` で再提案されない。
- 実データ: `data/search-console/20260928/` の検索語と `content/posts` で `extractGscCandidates()` を実行した結果が、`README.md` の表の「新規則」列と一致する（R5 の却下記録を入れる前の既存候補なしの状態で「インボイス レジ」だけが残る）。fixture として必要な部分を切り出してよい。

## 変更してはいけないもの

- LLM 選別（`callLLM`）のプロンプトと、候補の採否以外の出力形式。
- 週次レポートの節の順番と既存の列。
- `content/posts/*.md`。
- サジェスト由来の候補（`suggest-topics`）の規則。
