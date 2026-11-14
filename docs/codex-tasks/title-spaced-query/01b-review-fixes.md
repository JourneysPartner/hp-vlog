# 01b レビューの指摘を直す（Medium 1・Low 2 件）

背景は `README.md` の「レビュー」。01 で入れた R1〜R6 の動きは変えない。T1〜T7 も同じ。

## 変えてよいファイル

- `scripts/lib/title-retry.js`
- `scripts/generate-draft.js`（1774〜1806 行の検索語の点検の道の題名の作り直しだけ）
- `scripts/lib/__tests__/test-title-spaced-query.js`

## F1 検索語の点検の道の題名の作り直しを関数に移す（Medium-1）

`title-retry.js` に次を足して export する。

```js
// 検索語の点検に落ちた題名を、1 回だけ作り直す。
// 採らないとき・作り直せないとき・失敗したときは、元の題名のまま返す（仮置きにしない）。
// retry(body, topic) は題名の文字列か null を返す（generate-draft の retryTitleOnce）。
// lintSeo・checkTitle は seo-lint の lintSeo と draft-normalizer の checkLlmTitle。
// 返り値 { accepted: boolean, title: string }。accepted が false なら title は元の題名。
async function retitleForSeo({ title, summary, body, topic, seoFails, retry, lintSeo, checkTitle, warn = console.warn }) { ... }
```

動き（上から順に）:

1. `seoFails` に `RETITLE_TRIGGER_CODES` のどれも無ければ、`retry` を呼ばずに `{ accepted: false, title }` を返す。ログも出さない。
2. 01 の R3 と同じ文で、作り直す前のログを `warn` に 1 行出す。
   `[seo] 題名が点検に落ちました（${title_ で始まる seoFails を ', ' でつないだもの}）: "${title}" → 題名だけ作り直します`
3. `retry(body, topic)` を **1 回だけ** 呼ぶ。例外のときは `warn(\`[seo] 題名の作り直しに失敗（${e.message}）→ 元の題名を維持\`)` を出して `{ accepted: false, title }` を返す（今の 1804 行と同じ文）。
4. 返り値が空（null・空文字）なら `{ accepted: false, title }` を返す（ログは足さない。レビュー L5）。
5. `lintSeo({ title: 作り直した題名, summary, body, target_query: topic.target_query, secondary_queries: topic.secondary_queries })` と、`checkTitle(作り直した題名, { macro: topic.macro, article_type: topic.article_type })` を出し、`decideRetitle({ beforeFails: seoFails, retriedFails, titleCheck })` で決める。
6. 採らないときは 01 の R3 と同じ文で `warn(\`[seo] 作り直した題名を採用せず（${reason}）: "${作り直した題名}" → 元の題名のまま\`)` を出し、`{ accepted: false, title }` を返す。
7. 採るときは `{ accepted: true, title: 作り直した題名 }` を返す。

`generate-draft.js` の 1774〜1806 行を次の形にする（中身の動きは今と同じ）。

```js
    try {
      const retitle = await retitleForSeo({
        title: normalized.title, summary: normalized.summary, body: normalized.body,
        topic, seoFails: seo.fails, retry: retryTitleOnce, lintSeo, checkTitle: checkLlmTitle,
      });
      if (retitle.accepted) {
        normalized = normalizeGeneratedDraft(normalized.content, topic, {
          now, pairedTopic, titleOverride: retitle.title, summaryOverride: normalized.summary,
        });
        seo = lintSeo({ …今と同じ… });
        console.log(`[seo] 題名を作り直しました: "${normalized.title}"`);
      }
    } catch (e) {
      console.warn(`[seo] 題名の作り直しに失敗（${e.message}）→ 元の題名を維持`);
    }
```

- 外側の `try` は残す（作り直した後の `normalizeGeneratedDraft` が投げたときも、元の題名のまま続けるため）。
- 仮置きの道（`retryTitleOnce` を直接呼ぶ 1 か所）は変えない。検索語の点検の道からは `retryTitleOnce` を直接呼ばない。
- 要約の作り直し（1808 行〜）は変えない。

## F2 主検索語の各語を小文字にしない（Low-2）

- `buildRetitlePrompt` の「主検索語の各語」の行は、`tokenizeQuery` ではなく次で分ける（小文字にしない）。
  `String(topic.target_query || '').normalize('NFKC').split(/[\s・、／/]+/u).map(t => t.trim()).filter(Boolean)`
- 主検索語「eBay 輸出」→ `主検索語の各語: eBay／輸出`。「ＮＩＳＡ 確定申告」→ `主検索語の各語: NISA／確定申告`。
- `title-retry.js` で `tokenizeQuery` を使わなくなったら、`require` も消す。

## F3 壊しても通る試験を塞ぐ（Low-1）

`test-title-spaced-query.js` に足す・直す。

1. 空白が 2 か所ある題名（`せどり 確定申告 バレない 無申告の流れ`）で、「日本語の間に空白」の fail が**ちょうど 1 つ**。
2. R1 の表に 2 行足す: `人々 の税金の流れ`（当たる、見つかった部分 `々 の`）、`経費の月末〆 支払いの流れ`（当たる、`〆 支`）。
3. R2 の表に 1 行足す: 主検索語 `副業 税 申告`、題名 `副業 税 申告の流れと注意点`（入る。1 字の語も含めて比べる）。
4. `decideRetitle`: 点検 `{ ok: false, reasons: ['x'] }` かつ後に `title_raw_query` → 理由が「題名の点検: 」で始まる（条件 1 が先）。
5. R6: `target_query` の行を消した記事で、題名が空白入りなら空白の警告が出る（検索語の無い記事も対象）。
6. `buildRetitlePrompt` の `system` を、`split('\n')` した行の配列として、期待の配列とまるごと比べる（最初の 2 行「あなたは日本の税務ブログの編集者です。記事本文に合った日本語のタイトルを1つ作ります。」「制約:」と順番も含める）。
7. 主検索語「eBay 輸出」で `主検索語の各語: eBay／輸出`、「ＮＩＳＡ 確定申告」で `主検索語の各語: NISA／確定申告`。
8. 試験 10 は特定の記事に頼らない。`content/posts/` の中で `target_query` のある記事を名前順で 1 本選び、それを写して使う。
9. `retitleForSeo`（F1）を、偽の `retry` と本物の `lintSeo`・`checkLlmTitle` で確かめる。`retry` は呼ばれた回数を数え、`warn` は出た文を集める。主検索語は「せどり 確定申告 バレない」（9-5 だけ「インボイス 2割特例」）。
   1. `seoFails` が `['summary_missing_query']` だけ → `retry` は 0 回、元の題名、ログ無し。
   2. `retry` が空白入りの題名「せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税」を返す → 採らない、元の題名、`retry` は 1 回、「作り直した題名を採用せず」のログ。
   3. `retry` が直した題名「せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税」を返す（前の fail は `['title_missing_query']`）→ 採る、題名が変わる、`retry` は 1 回、作り直す前のログに元の題名と `title_missing_query` が入る。
   4. `retry` が投げる → 採らない、元の題名、`retry` は 1 回、「題名の作り直しに失敗」のログ。
   5. `retry` が R2 だけに当たる題名「インボイス 2割特例はいつまで使える？期限と届出の流れ」を返す（前の fail は `['title_too_long']`）→ 採らない、元の題名。
   6. `retry` が null → 採らない、元の題名、`retry` は 1 回。
10. `generate-draft.js` の文字列: `retitleForSeo(` を使い、`retry: retryTitleOnce` を渡す。`await retryTitleOnce(` はちょうど 1 か所（仮置きの道）。

## 流す試験（すべて `sbx` を通す）

01 の「流す試験」と同じ。

## 変えてはいけないもの

- 01 の R1〜R6 の判定・文言・ログの文。
- 仮置きの道、要約の作り直し、`seoIssues` の作り方。
- AI の呼び出しの相手・回数・`maxTokens`。
- 記事・データ。既存の試験の期待。
