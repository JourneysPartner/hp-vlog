# 01 同じ文の直しをまとめる・直した後の食い違い探し・速算表の決まり・画面の件数

背景・決定・安全の条件 S1〜S9 は `README.md`。試験データは `fixtures/pr796.json`。行番号は main（c2a340bee）のもの。

## A 同じ文の指摘を 1 つの直しにまとめる（`scripts/lib/fact-check.js`）

### R1 資料なしの「消す数字」から、同じ文の食い違い・期限の直しの数字を外す

`repairNumberGuards(findings)` で、`status === '資料なし'` の指摘 f ごとに次を足す。

```
siblings = findings.filter(g => g !== f && g.sentence === f.sentence && ['食い違い', '期限の書き漏れ'].includes(g.status))
siblingNumbers = siblings
  .flatMap(g => [g.correct || '', g.quote_notes || '', ...(g.keep_numbers || [])])
  .flatMap(text => expandYearDates(normalizedNumbers(text), text))
  .filter(n => n !== null)
removeNumbers = （今の removeNumbers）.filter(n => !siblingNumbers.includes(n))
```

- `g.sentence`（元の文）は siblingNumbers に入れない。元の文には資料の無い数字が入っているため。
- guard の戻り値に `siblingNumbers` も足す。`rowRemovals` は今のとおり `guard.removeNumbers` から作る（外した数字は表の行でも消さなくてよくなる）。
- siblings が無い f は、keepNumbers・removeNumbers とも今と同じ。

### R2 書き手の資料の設定での資料なしの確かめにも siblingNumbers を許す

`repairBody` の 1342 行（`enhanced && REVIEW_TYPES.has(f.type) && checkedNumbers.some(n => !keepNumbers.includes(n))`）は、`keepNumbers` と `siblingNumbers` のどちらにも無い数字があるときだけ「資料の無い数字が残っています」にする。

### R3 同じ文の指摘には、同じ 1 つの置き換えを返させる

`repairInstructions(findings)` で、同じ `sentence` の指摘が 2 つ以上あるときは、その全部の項目に次を足す。

- `same_sentence_ids`: その文の指摘の id 全部（findings の並び順）
- `instruction` の末尾に `。この文には same_sentence_ids の指摘が全部かかっています。全部の指摘を満たす1つの置き換えを作り、どの id にも同じ replacement を返す`
- さらに、資料なしの項目で R1 の siblingNumbers が空でないときは、その後ろに `。同じ文の食い違い・期限の直し（correct）にある数字は、その直しのために残してよい。外すのは資料の無い部分だけ`

指摘が 1 つだけの文は、項目も `instruction` も今と 1 字も変えない（S2）。`repairBody` の system の文、`checkSentences`（1348〜1362 行）、2 回目の直し（1364〜1380 行）は変えない。

## B 直した後に、直した内容と食い違う所を探す（`scripts/lib/fact-check.js`）

### R4 題名と要約を照合に渡す

`checkArticle` が `checkFacts` を呼ぶときの options に `article_meta: { title: String(meta.title || ''), summary: String(meta.summary || '') }` を足す。`checkFacts` を直接呼ぶ所（公開済みの一括照合 `audit-published-facts.js` など）は変えない。`article_meta` が無いときは題名・要約を空の文字として扱う。

### R5 動く条件と場所

`checkFacts` で最後の本文 `revisedBody` が決まった後（条件確認の戻しの処理の後、1974 行の `const unresolved = ...` の前）に、次の applied が 1 件以上あり、かつ `options.repair !== false` のときだけ動かす。

```
applied = record.corrections.filter(f => f.resolved && ['食い違い', '期限の書き漏れ'].includes(f.status) &&
  typeof f.after === 'string' && f.after && revisedBody.includes(f.after))
```

- 資料なしを案内に変えた直し（`generalized`）だけ、または直しが無いときは、呼び出しも `record.consistency` の欄も作らない（S5）。
- 本文は変えない（S3）。

### R6 呼び出し

```
call({ task: 'consistency_check', maxTokens: 4000, system: CONSISTENCY_SYSTEM,
  user: JSON.stringify({
    corrections: applied.map(f => ({ id: f.id, before: f.before, after: f.after, correct: f.correct || '' })),
    title, summary,
    body: renderUnits(splitUnits(revisedBody)),
  }) })
```

- Batch を使ってよい（`immediate` を付けない）。
- `record.calls` の `task` は `consistency_check` そのものにする。今の `call` は `rechecking` が true だと `recheck_` を付けるので、呼ぶ直前に `rechecking = false`（`again` も false）にする。この呼び出しの後に、再照合の呼び出しは無い。
- `CONSISTENCY_SYSTEM` は次の文のとおりにする（定数で置く）。

```
記事の一部の文を、資料に合わせて直しました。corrections の before が直す前の文、after が直した後の文、correct が資料に基づく正しい内容です。
記事の題名（title）・要約（summary）・本文（body。[番号] 付き、見出しを含む）の中から、直した後の内容と矛盾する記述を全部挙げてください。
矛盾する記述とは、直す前の誤った内容を前提にしている記述、直す前の誤った内容を言い換えて繰り返している記述、直した後の内容と同時には成り立たない記述です。
直した文（after）そのものは挙げない。矛盾しない記述や、詳しさが違うだけの記述は挙げない。記憶で補わず、corrections の correct と after だけを基準にする。
出力は JSON 配列だけです: [{"where":"title" または "summary" または本文の番号,"text":"該当する記述を元の文字のまま","correction":"直しの id","reason":"何が矛盾するか（1文）","suggestion":"直した内容に合わせた書き方の例（1文）"}]
無ければ [] を出力してください。
```

### R7 答えの確かめ（採る条件）

`parseJson` で読み、配列でなければ R9（失敗）。行ごとに次をすべて満たすものだけ採る。満たさない行は `dropped` に数える。

- `where` が `'title'`・`'summary'`、または `unitNumber(where)` が `splitUnits(revisedBody)` のどれかの `s` に当たる。
- `text` が空でない文字列で、前後の空白を除いたものが、対象の文字の中にそのまま在る。対象は、title・summary ならその文字、本文の番号ならその単位の `text`。見出しの単位は、先頭の `#` と空白を除いた文字でも探す。
- 対象が本文の単位のとき、その単位の `text` が applied のどれかの `after` と同じ、または `after` を含む、または `after` に含まれるなら採らない（直した文そのもの、S6）。
- `correction` が applied のどれかの id。
- 同じ（where, text）は 1 つにまとめる。

採った行は次の形にする（文字は 300 字で切る）。

```
{ where: 'title' | 'summary' | 'body', s: 本文なら番号・他は null, heading: 本文ならその単位より前の最後の見出しの文字（# を除く）・他は '',
  text, correction_id, reason, suggestion }
```

### R8 記録・状態・要約

- `record.consistency = { checked: true, corrections: applied の id, findings: 採った行, dropped: 数 }`
- `record.status` の式（1980 行）に足す: `record.remaining.length || uncheckedNumeric || consistencyBlocks ? 'revise' : 'ok'`。`consistencyBlocks` は `record.consistency && (record.consistency.failed || record.consistency.findings.length > 0)`。
- `record.summary` に、findings が 1 件以上なら `・直した内容と食い違う箇所 ${n} 件`、失敗なら `・直した内容との食い違いを確かめられませんでした` を、`・人が確かめる箇所 …` の直後に足す。
- `applyFactResult` は変えない。`fact_check_blocking` は今の式（`status === 'revise'`）で true になる（S7）。

### R9 失敗の扱い（止める側）

呼び出しの例外・時間切れ・読めない答え・配列でない答えは、`record.consistency = { checked: false, failed: true, corrections: applied の id, findings: [], dropped: 0, error: 短い説明 }` にして続ける。`record.status` は `revise`。照合全体を `not_run` にしない（S4）。ただし `options.signal` が中断済みのときは、今の他の呼び出しと同じく例外をそのまま投げる。`error` に鍵・URL の問い合わせ文字列・応答の全文を入れない。

### R10 版

`LOGIC_VERSION` を `'plan2-s11'` にする。

## C 書いた後の本文で速算表の決まりを当てる（`scripts/lib/article-prompt-static.js`）

### R11 当たる条件を足す

`income_tax_bracket.match` に、今の条件（そのまま残す）の「または」として次を足す。見るのは本文（`t.__body`）だけで、企画の欄は見ない。

```
typeof t.__body === 'string' &&
  /(?:195|330|695|900|1,?800|4,?000)万円|(?:1,950,000|3,300,000|6,950,000|9,000,000|1,949,000|3,299,000|6,949,000|8,999,000)円/.test(t.__body) &&
  /税率|課税所得|課税される所得/.test(t.__body)
```

`detectRulesFromBody` は文ごとにも呼ばれる（`body-patches.js` の `targetedSentences`）。そのため、同じ文に金額と「税率」などがあれば、その文が部分修正の対象になる。

### R12 決まりの文に、文の中の書き方の例を足す

`income_tax_bracket.text` の末尾（「→ 出典が無い場合は…」の行の後）に次を足す。今の文は消さない。

```
  文の中で書くときも同じ:
  ❌「課税所得が195万円を超えて330万円以下の人（税率10%）」
  ✓「課税所得が195万円以上330万円未満の人（税率10%）」
  円単位で書くときは速算表のとおり「1,950,000円から3,299,000円まで」と書く。
```

## 画面 `netlify/functions/review-page.js`

### R13 照合の要点の「本文の変更」は、実際に入った直しだけを数える

219 行を次にする。

- 直した: `corrections.filter(c => c.resolved && !c.generalized).length`
- 資料が無く案内に変えた: `corrections.filter(c => c.resolved && c.generalized).length`
- 採れなかった直し `u = corrections.filter(c => !c.resolved).length` が 1 以上なら、`・採れなかった直し ${u} 件` を続ける。
- 「うち AI は裏付けありと答えた」の数（`rejectedSupported`）も `c.resolved` のものだけにする。

詳細の「直した箇所」「資料が無く案内に変えた箇所」の一覧（246〜247 行）は変えない。

### R14 直した内容と食い違う箇所を出す

- 照合の要点のカード（`renderFactRemaining` を出す所の直後）と、詳細の `renderFactCheck`（`renderFactRemaining(record)` の直後）の両方に出す。
- `record.consistency?.findings?.length` が 1 以上なら、赤い枠（`alert alert-danger`）に見出し `直した内容と食い違う箇所 ${n} 件`。行ごとに、場所（題名・要約・本文の見出しの名前）、`text`、`reason`、`suggestion`（「書き方の例: 」を前に付ける）を出す。
- `record.consistency?.failed` なら、赤い枠に `直した内容と食い違う所を確かめられませんでした（自動の確認が失敗しました）。差し戻すか、内容を確かめてから確認欄に印を付けてください`。
- `consistency` が無い古い記録では何も出さず、例外も出さない。
- AI の文は全部 `escapeHtml`（本文の文は今の `factSentence`）を通す（S9）。

## 試験

新しい試験は `scripts/lib/__tests__/test-fact-consistency.js`（A・B・画面）と `scripts/lib/__tests__/test-bracket-rule-body.js`（C）に書く。偽の AI の作りは `test-fact-check.js` の `fake` と同じ形にする。`fixtures/pr796.json` を読んで使う。

### A

- T1 `same_sentence.findings`（c42 食い違い・c43 資料なし）で `repairBody` を呼ぶ。偽の AI は 2 つの id に `same_sentence.good_replacement` を返す。置き換えが本文に入り、`rejected` は空。
- T2 T1 の修正の依頼で、c42・c43 の両方の項目に `same_sentence_ids: ['c42','c43']` があり、instruction に R3 の文がある。c43 の instruction には siblingNumbers の文もある。
- T3 偽の AI が「約2万円」を残した置き換えを返すと、c43 は「資料の無い数字が残っています」、c42 は「同じ文の別の指摘の置き換えを採れませんでした」。本文は変わらない。
- T4 偽の AI が「所得20万円の増加で」を残した置き換えを返すと、T3 と同じく採らない（20万は c42 の correct に無い）。
- T5 資料なしの指摘が 1 つだけの文: 依頼の項目に `same_sentence_ids` が無く、instruction は今と同じ文字（main の `repairInstructions` の資料なしの文を試験に書いて比べる）。
- T6 資料なしが 2 つだけ（食い違い無し）の文: 両方に `same_sentence_ids` があり、removeNumbers は今と同じ。
- T7 `checkFacts` を通しで: c42・c43 の形の主張、T1 の置き換え、再照合は裏付けあり、consistency_check は `[]`。`record.status` が `ok`、`remaining` が空、c42・c43 とも `resolved: true`。

### B

- T8 食い違いの直しが 1 件入る `checkFacts`。偽の AI の consistency_check が、本文の見出しの単位と `summary` を指す 2 行を返す。`record.consistency.findings` が 2 件、`record.status` が `revise`、要約に `直した内容と食い違う箇所 2 件`。`record.calls` に `task === 'consistency_check'` が 1 件。本文は B を足す前と同じ。`applyFactResult` の結果で `fact_check_blocking: true`。
- T9 consistency_check の依頼の user に、corrections（id・before・after・correct）・title・summary・`[番号] ` 付きの本文（見出しを含む）がある。
- T10 直しが資料なしの案内だけ、または直しが無い: consistency_check を呼ばない。記録に `consistency` の欄が無い。状態は今と同じ。
- T11 採らない行: 知らない where、対象に無い text、直した文そのもの、知らない correction。どれも `dropped` に数え、findings にしない。全部採らなければ、他に止める理由が無いとき `ok`。
- T12 consistency_check で偽の AI が例外を投げる: `consistency.failed` が true、`status` が `revise`、要約に `直した内容との食い違いを確かめられませんでした`。`not_run` にならない。
- T13 答えが読めない文字・配列でない: T12 と同じ。
- T14 `repair: false`: consistency_check を呼ばない。
- T15 `checkArticle` に frontmatter の title・summary を持つ記事を渡すと、consistency_check の依頼に同じ title・summary が入る。
- T16 `consistency.body_after_repair` と `consistency.correction` で、偽の AI が `expected_conflicts` の 3 行を返す（見出しと箇条書きは、依頼の本文から番号を探して返す）。3 行とも採られる。

### 画面

- T17 `consistency.findings` のある記録で、照合の要点と詳細に `直した内容と食い違う箇所 3 件` と各行が出る。`<script>` を含む text・reason はエスケープされる。`failed` の記録では失敗の文が出る。`consistency` の無い記録では出ず、例外も無い。
- T18 `screen_counts.corrections` の記録で、照合の要点が `直した 1 件・資料が無く案内に変えた 2 件・採れなかった直し 2 件` と出る。

### C

- T19 `detectRulesFromBody({ title: fixture.title }, '課税所得が195万円を超えて330万円以下の人（税率10%）なら、…')` に `income_tax_bracket` が入る。
- T20 `selectConditionalRuleEntries({ title: fixture.title })` には入らない（書く前の選び方は変わらない）。
- T21 「売上が330万円を超えた」（税率・課税所得の語なし）や「税率10%」（区切りの金額なし）だけの文では入らない。
- T22 `income_tax_bracket.text` に `195万円以上330万円未満` と `1,950,000円から3,299,000円まで` がある。今の文（「195万円未満 → 5%」など）も残っている。
- T23 `postfixRules(fixture.original_body, { topic: { title: fixture.title }, generateSimple: 偽 })` の依頼に、`income_tax_bracket` の決まりの文と、「課税所得が195万円を超えて330万円以下」の文が入る。

## 既存の試験の扱い

- 版の文字列 `plan2-s10` → `plan2-s11` の置き換え（期待のそれ以外は変えない）: test-fact-check-03o.js・test-fact-check-03r.js・test-fact-check-03u.js・test-fact-check-03v.js・test-fact-cost-03n.js・test-fact-discarded-claims.js・test-fact-jubun-quote.js・test-fact-keep-supported.js・test-fact-plan-01.js・test-fact-plan-02.js・test-fact-precision-03l.js・test-fact-recheck-n7.js・test-fact-repair-notes.js・test-fact-review-fixes-4.js・test-fact-table-numbers.js（他にもあれば同じく）。
- 食い違い・期限の直しが入る既存の試験で、偽の AI が `consistency_check` に答えられず結果が変わるもの: 偽の AI に「`task === 'consistency_check'` なら `[]` を返す」を足すだけで直す。期待は変えない。
- 呼び出しの回数・並びを数える試験: `consistency_check` の 1 回分だけ期待を足してよい。
- R3 で依頼の項目が変わる試験（同じ文に指摘が 2 つ以上ある試験）: 依頼の中身の期待だけ直してよい。結果の期待は変えない。
- どれも、直した試験の名前と理由を全部報告する。試験を消さない・弱めない・飛ばさない。

## 変えてはいけないもの

- `data/`・`content/`・`blog/`・`.github/`・`package.json`・`package-lock.json`
- `scripts/lib/fact-evidence.js`・`scripts/lib/writer-materials.js`・`scripts/generate-draft.js`・`scripts/audit-published-facts.js`・承認の関数（`netlify/functions/review-approve*.js` など）
- `article-prompt-static.js` の `income_tax_bracket` 以外の決まり
- `body-patches.js`（C は `article-prompt-static.js` だけで足りる）
- 照合の判定（judge）・抜き出し・再照合・条件確認・2 回目の直しの中身

## 基準の試験（main c2a340bee、Claude が sbx の外で実行）

対象 44 本（`test-fact-*.js` 全部・`test-review-page*.js`・`test-conditional-rules.js`・`test-body-rule-detection.js`・`test-generation-*.js`・`test-published-facts-audit.js`）。43 本通過、1 本失敗。

- `test-fact-plan-01.js` は main でも落ちる（前からの失敗。この依頼では直さない）。
  - P2「変更前の外れを再現し、段Bの候補・点・抜粋を維持」: `32.77 !== 32.78`
  - P3/P4「切替falseでもW規則を含むpromptIRと従来の前付けにバイト単位で一致」: hash の不一致

この 2 つ以外の失敗が増えないこと、版の文字列の置き換え以外でこの試験の結果が変わらないことを報告で確かめる。
