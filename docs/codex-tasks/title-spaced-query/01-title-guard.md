# 01 題名の空白・検索語の貼り付けを点検で止め、作り直しの指示とログを直す

背景と安全の決まり T1〜T7 は `README.md`。

## 変えてよいファイル

- `scripts/lib/title-lint.js`
- `scripts/lib/seo-lint.js`
- `scripts/lib/title-retry.js`（新規）
- `scripts/generate-draft.js`（`retryTitleOnce` と、1785〜1821 行の検索語の点検の道だけ）
- `scripts/lib/article-prompt-static.js`（1140 行と 1301 行の 2 か所だけ）
- `scripts/validate.js`（240〜250 行の検索語のある記事の点検だけ）
- `scripts/lib/__tests__/test-title-spaced-query.js`（新規）
- `package.json`（`masters:test` の一覧の末尾に、新しい試験を 1 本足すだけ）

## R1 日本語の文字の間の空白を fail にする（`title-lint.js`）

- 次の関数を足して export する。

```js
// 日本語の文字の間にある空白を探す。見つかれば、その部分（前後 1 字を含む）を返す。無ければ ''。
function findJapaneseSpace(title) { ... }
```

  - 比べる文字列は `String(title || '').normalize('NFKC')`（全角空白・半角カナを揃えるため）。
  - 日本語の文字 = `\p{Script=Han}`・`\p{Script=Hiragana}`・`\p{Script=Katakana}`・`ー`・`々`・`〆`。
  - 正規表現は「日本語の文字 1 字 + 空白（`\s`）1 字以上 + 日本語の文字 1 字」（`u` フラグ）。最初に当たった部分（`match[0]`）を返す。
- `lintTitle` の「1. 禁止フレーズ」の後に、`findJapaneseSpace(title)` が空でなければ `fails.push(\`日本語の間に空白: "${見つかった部分}"\`)` を 1 つだけ足す（何か所あっても 1 つ）。
- ほかの判定・順番・文言は変えない。

### R1 の期待（`lintTitle(題名).fails` に「日本語の間に空白」が入るか）

| 題名 | 入るか | 見つかった部分 |
|---|---|---|
| `せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税` | 入る | `り 確` |
| `せどり　確定申告　バレない？無申告の流れ`（全角空白） | 入る | `り 確`（NFKC の後なので半角空白） |
| `ﾒﾙｶﾘ 売上の確定申告はいくらから？`（半角カナ） | 入る | `リ 売` |
| `ネットショップのセラー 確定申告の流れ` | 入る | `ー 確` |
| `せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税` | 入らない | |
| `eBay 輸出の消費税還付はいつ戻る？手続きの流れ` | 入らない | |
| `インボイス 2割特例はいつまで使える？` | 入らない | |
| `確定申告は必要？ 副業の所得が20万円以下のとき` | 入らない | |
| `ふるさと納税 ｜ 上限額の目安` | 入らない | |

## R2 検索語の貼り付けを fail にする（`seo-lint.js`）

- 次の関数を足して export する。

```js
// 主検索語を空白で区切ったまま題名に貼っているか。語が 2 つ以上の検索語だけを見る。
function titleHasRawQuery(title, targetQuery) { ... }
```

  - 語は `tokenizeQuery(targetQuery)`（`meaningfulTokens` ではない。1 字の語も含める）。語が 2 つ未満なら `false`。
  - 題名は `normalizedText(title)` の後、空白の続き（`\s+`）を半角空白 1 つにまとめる。
  - その題名が `語.join(' ')` を含めば `true`。
- `lintSeo` の題名の点検（30〜40 行）で、`titleHasRawQuery(title, target_query)` なら `fails.push('title_raw_query')`。`title_missing_query`・`title_query_late`・`title_too_long`・`title_too_short` の判定は変えない（貼り付けた題名は語がそろっているので `title_missing_query` にはならない）。
- `target_query` が空のとき・語が無いときに何も返さない、今の早期 return は変えない。

### R2 の期待（`lintSeo({ title, summary: '', body: '', target_query }).fails` に `title_raw_query` が入るか）

| target_query | 題名 | 入るか |
|---|---|---|
| `せどり 確定申告 バレない` | `せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税` | 入る |
| `せどり 確定申告 バレない` | `せどり　確定申告　バレない？無申告の流れ`（全角空白） | 入る |
| `せどり 確定申告 バレない` | `せどり  確定申告 バレない？無申告の流れ`（空白 2 つ） | 入る |
| `せどり 確定申告 バレない` | `せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税` | 入らない |
| `インボイス 2割特例` | `インボイス 2割特例はいつまで使える？` | 入る |
| `インボイス 2割特例` | `インボイスの2割特例はいつまで使える？` | 入らない |
| `eBay 輸出` | `EBAY 輸出の消費税還付はいつ戻る？` | 入る（小文字に揃えて比べる） |
| `年末調整` | `年末調整 やり方` | 入らない（語が 1 つ） |

## R3 作り直しの採否とログ（`title-retry.js`・`generate-draft.js` 1785〜1821 行）

`scripts/lib/title-retry.js` を新しく作り、次を export する。

```js
// 検索語の点検で、題名だけ作り直すきっかけにする fail。
const RETITLE_TRIGGER_CODES = Object.freeze(['title_missing_query', 'title_too_long', 'title_raw_query']);

// 作り直した題名を採るか。
// beforeFails / retriedFails は lintSeo の fails（題名以外の code も混ざってよい）。
// titleCheck は checkLlmTitle の結果 { ok, reasons }。
// 返り値 { accept: boolean, reason: string }。reason は採らないときの理由（採るときは ''）。
function decideRetitle({ beforeFails, retriedFails, titleCheck }) { ... }
```

`decideRetitle` の条件（上から順に見て、最初に当たったものを返す）:

1. `titleCheck.ok` が false → `{ accept: false, reason: \`題名の点検: ${titleCheck.reasons.join(' / ')}\` }`
2. `retriedFails` に `title_raw_query` がある → `{ accept: false, reason: '検索語を空白区切りのまま貼っている' }`
3. `title_` で始まる fail の数が、作り直した後で減っていない → `{ accept: false, reason: \`題名の fail が減らない（${前の数} → ${後の数}）\` }`
4. それ以外 → `{ accept: true, reason: '' }`

`generate-draft.js` の検索語の点検の道（1796〜1821 行）を次のように変える。

- 1796 行の条件を `seo.fails.some(code => RETITLE_TRIGGER_CODES.includes(code))` にする。
- 作り直しを呼ぶ**前**に、次のログを 1 行出す（`fails` は `seo.fails` のうち `title_` で始まるもの）。
  `console.warn(\`[seo] 題名が点検に落ちました（${fails.join(', ')}）: "${normalized.title}" → 題名だけ作り直します\`)`
- 1806〜1807 行の採否を `decideRetitle({ beforeFails: seo.fails, retriedFails: retriedSeo.fails, titleCheck })` に置き換える。`accept` が true のときの処理（1808〜1815 行）は今のまま。
- `accept` が false のときは次のログを出し、元の題名のままにする（T5）。
  `console.warn(\`[seo] 作り直した題名を採用せず（${decision.reason}）: "${retitled}" → 元の題名のまま\`)`
- `retitled` が null のとき（`retryTitleOnce` が自分で理由をログに出している）と、例外のときは今のまま。
- 作り直しの回数は今のまま 1 回（T3）。

## R4 作り直しの指示（`title-retry.js`・`generate-draft.js` `retryTitleOnce`）

`title-retry.js` に、`retryTitleOnce` の指示を組み立てる関数を移して export する。

```js
// 本文の見出しと冒頭から、題名だけを作り直す指示を組み立てる。
function buildRetitlePrompt(body, topic) { ... return { system, user }; }
```

- `heads`・`lead` の取り出し方は、今の 1619〜1620 行と同じにする。
- `system` は今の 1621〜1631 行の行の並びのまま、**「- 主検索語が渡されたときは、その語を先頭15文字以内に置く。」の 1 行だけ**を次の 4 行に置き換える。ほかの行は 1 字も変えない。

```
- 主検索語が渡されたときは、その各語を先頭15文字以内に入れる。各語は助詞などを補って、自然な日本語の文としてつなぐ。
- 題名に空白を入れない。主検索語を空白で区切ったまま並べない。
  悪い例（主検索語「メルカリ 売上 確定申告」）: メルカリ 売上 確定申告 いくらから必要か
  良い例: メルカリの売上は確定申告が必要？いくらからかと申告の流れ
```

- `user` は今の 1632〜1641 行のまま。ただし `主検索語: …` の行の**直後**に、主検索語があるときだけ次の 1 行を足す（語は `tokenizeQuery` で分け、`／` でつなぐ）。主検索語が無いときは足さない。
  `主検索語の各語: せどり／確定申告／バレない`
- `retryTitleOnce` は `const { system, user } = buildRetitlePrompt(body, topic);` を使い、AI の呼び出し（`callSimpleOpenAI({ system, user }, 200)`）・1 行目を取る処理・`checkLlmTitle` での採否・ログは今のまま。

## R5 本文用の指示（`article-prompt-static.js` 2 か所）

- 1140 行の「主検索語があれば先頭 15 文字以内に置く。」の直後に、次の文を足す（同じ行の中）。
  `主検索語は助詞を補って文にし、空白で区切ったまま題名に並べない（題名に空白を入れない）。`
- 1301 行の `  ・題名: 先頭 15 文字以内` を `  ・題名: 先頭 15 文字以内（空白で区切ったまま並べず、助詞を補って文にする）` にする。
- ほかの行は変えない。

## R6 `validate.js` の警告

- 240〜250 行の `if (fm.target_query) { … }` の中、今の 2 つの警告の後に次を足す。**警告だけで、error にはしない**（人が直した題名の公開を止めないため）。
  - `titleHasRawQuery(fm.title, fm.target_query)` なら
    `warnings.push(\`title に target_query「${fm.target_query}」が空白区切りのまま入っています: 助詞を補って文にしてください\`)`
- `if (fm.target_query)` の**外**（検索語の無い記事も対象）、9b の前に次を足す。
  - `findJapaneseSpace(fm.title)` が空でなければ
    `warnings.push(\`title の日本語の間に空白があります（"${見つかった部分}"）: 検索語を空白区切りのまま貼っていないか確認してください\`)`

## 試験 `scripts/lib/__tests__/test-title-spaced-query.js`

手本は `test-title-lint.js`・`test-placeholder-title.js`（`assert` の形、最後に `PASS: n / FAIL: m`、落ちたら `process.exit(1)`）。

1. R1 の表の 9 行（`lintTitle` の fails と、`findJapaneseSpace` の返り値）。
2. `checkLlmTitle('せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税', { macro: '物販', article_type: 'basic_explainer' })` が `ok: false` で、`reasons` に「日本語の間に空白」を含む。直した題名は `ok: true`。
3. R2 の表の 8 行（`lintSeo` の fails と `titleHasRawQuery`）。`target_query` が空のときは `lintSeo` の fails が空のまま。
4. `decideRetitle` の 5 通り:
   - 前 `['title_raw_query']`、後 `[]`、点検 ok → 採る
   - 前 `['title_missing_query', 'title_too_long']`、後 `['title_raw_query']`、点検 ok → 採らない（理由は「検索語を空白区切りのまま貼っている」）
   - 前 `['title_missing_query']`、後 `[]`、点検 `{ ok: false, reasons: ['日本語の間に空白: "り 確"'] }` → 採らない（理由は「題名の点検: 」で始まる）
   - 前 `['title_too_long']`、後 `['title_too_long']`、点検 ok → 採らない（理由は「題名の fail が減らない（1 → 1）」）
   - 前 `['title_missing_query', 'summary_missing_query']`、後 `['summary_missing_query']`、点検 ok → 採る（題名以外の code は数えない）
5. `RETITLE_TRIGGER_CODES` が 3 つの code をこの順で持ち、変えられない（`Object.isFrozen`）。
6. `buildRetitlePrompt`:
   - `system` に R4 の 4 行が入り、「その語を先頭15文字以内に置く。」が無い。
   - 今の `system` のほかの行（「28〜45文字。45文字を超えない。」「末尾に「を解説」「について」「まとめ」を付けない。」「「徹底解説」「完全ガイド」「必読」は使わない。」「同じ名詞を繰り返さない。」「記事に書かれていないことをタイトルにしない。」「出力はタイトルの文字列のみ。前置きも引用符も付けない。」）がそのまま入る。
   - 主検索語「せどり 確定申告 バレない」のとき、`user` に `主検索語: せどり 確定申告 バレない` と、その次の行に `主検索語の各語: せどり／確定申告／バレない` がある。
   - 主検索語が無いとき、`user` に `主検索語: （指定なし）` があり、「主検索語の各語」が無い。
   - 本文の見出し（`## ` と `### `、最大 12 本）と冒頭 300 字が、今と同じく入る。
7. `generate-draft.js` の文字列の確かめ（`test-placeholder-title.js` 99 行の形）: `require('./lib/title-retry')` があり、`RETITLE_TRIGGER_CODES.includes`・`decideRetitle(`・`buildRetitlePrompt(` を使い、「その語を先頭15文字以内に置く」が残っていない。「[seo] 題名が点検に落ちました」「[seo] 作り直した題名を採用せず」のログの文がある。
8. `article-prompt-static.js` の文字列に R5 の 2 つの文がある。
9. T1: `content/posts/*.md` の全記事について、`lintTitle(title).fails` に「日本語の間に空白」が無く、`target_query` のある記事で `lintSeo` の fails に `title_raw_query` が無い。
10. R6: OS の一時フォルダーに記事のファイルを 2 つ書き、`validateFile` で確かめる（`content/posts/` の今の記事の frontmatter を 1 本写して、題名と `target_query` だけを変える）。
    - 題名「せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税」・検索語「せどり 確定申告 バレない」→ 警告に 2 つの新しい文の両方が入り、errors は写した元の記事と同じ数のまま。
    - 題名「せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税」→ 新しい 2 つの警告は出ない。
    - 書いたファイルは最後に消す。

## 流す試験（すべて `sbx` を通す）

```
sbx node --check scripts/lib/title-lint.js
sbx node --check scripts/lib/seo-lint.js
sbx node --check scripts/lib/title-retry.js
sbx node --check scripts/generate-draft.js
sbx node --check scripts/lib/article-prompt-static.js
sbx node --check scripts/validate.js
sbx node scripts/lib/__tests__/test-title-spaced-query.js
sbx node scripts/run-test-files.js scripts/lib/__tests__/test-title-lint.js scripts/lib/__tests__/test-seo-lint.js scripts/lib/__tests__/test-placeholder-title.js scripts/lib/__tests__/test-banned-title.js scripts/lib/__tests__/test-title-builder.js scripts/lib/__tests__/test-title-contrast-pairs.js scripts/lib/__tests__/test-title-refresh.js scripts/lib/__tests__/test-duplicate-content-mitigation.js scripts/lib/__tests__/test-generate-draft-output-normalization.js scripts/lib/__tests__/test-preflight-check.js scripts/lib/__tests__/test-query-placement.js scripts/lib/__tests__/test-target-query.js scripts/lib/__tests__/test-prompt-builder.js scripts/lib/__tests__/test-article-length.js
sbx npm run masters:test
sbx node scripts/validate.js
```

## 変えてはいけないもの

- 今ある `lintTitle`・`lintSeo`・`checkLlmTitle` の判定・文言・順番（足すだけ）。
- 仮置きの道（1762〜1783 行）、要約の作り直し（1823〜1847 行）、`seoIssues` の作り方（1849〜1854 行）。
- AI の呼び出しの相手・回数・`maxTokens`。
- 記事（`content/posts/`）・データ（`data/`）。
- 既存の試験の期待。変えないと通らないときは、変えずに理由を報告する。
