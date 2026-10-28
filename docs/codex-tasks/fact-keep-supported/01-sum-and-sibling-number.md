# 01 合計の金額・同じ文の資料の番号・承認画面の表示

README を先に読むこと。試験データ `fixtures/644-record-36b726eb.json` は #644 の 2 回目の再生成の照合記録（`compactRecord` の形。資料の本文は `evidenceRefs(record, { evidence_ids: [...] })` で戻せる）。

- c16: 金額。`rejected_answer` に Opus の答え（No.4452・引用）。`reject_reason` は「引用が短い・数字が引用の近くに無い」
- c35: 番号。資料なし（Opus の答え）
- c45: c35 と同じ文の要件。No.4508（`https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm`）で裏付けあり

## R1 合計の金額を裏付けとして認める（`scripts/lib/fact-check.js`）

`sufficientQuote` の数字の確認（今は `quoteSupportsNumbers` で、主張の数がすべて引用の前後 300 字の数に含まれるか）に、次の救済を足す:

- 対象: `claim.type === '金額'` かつ `status === '裏付けあり'` のときだけ（`食い違い`・`期限の書き漏れ` の `correct` の数には使わない）。
- 条件（全部）:
  1. 主張の文 `claim.sentence` に合計を表す語がある: `合計` `合わせ` `併せ` `あわせ` `合算` `足す` `足し` `加え` `加算` `上乗せ` `プラス`
  2. 引用の近くにそのまま無い数 n について、**同じ引用の同じ出現位置の前後 300 字**（今の `quoteSupportsNumbers` が数を集める範囲と同じ）にある数から、値の違う 2 つ a・b を選んで a + b = n になる
  3. a か b の少なくとも一方が、主張の文の数（`normalizedNumbers(claim.sentence)` を、`sufficientQuote` が今使っている自分の番号を除く処理と同じ扱いで読んだもの）にも含まれる
  4. n・a・b はどれも接頭辞の無い数（`日付:` `割合:` などで始まらない）で、10000 以上（円の金額。年数・回数などの小さい数を拾わない）
- 引用が 2 つ（`\n…\n` で区切り）のときは、各部分の範囲の中だけで a・b を探す（2 つの部分をまたいで足さない）。
- 合計で認めた数は、判定の結果（`results` の行）に記録する（例 `sum_support: [{ number: '21100000', parts: ['1100000', '20000000'] }]`。形は任せるが、記録の JSON に残り、`compactRecord` で消えないこと）。
- `partialQuoteNumbers`（一部の数だけ裏付けられたときの `supported_numbers`）も、同じ条件で合計の数を裏付けありの数として数える。

## R2 同じ文の資料の番号（`fact-check.js`）

判定の後（`checkFacts` の `analyze` が採用した結果を返す前。最初の照合と再照合の両方）に、次を行う関数（例 `supportNumbersFromSiblings(claims)`、export して試験する）を通す:

- 対象: `type === '番号'` かつ `status === '資料なし'` の主張（`reject_reason` が `NO_REPAIR_REASONS` のものは除く）。
- 主張の番号: `claim.claim` からタックスアンサーの番号（`No.` `Ｎｏ．` `No` `タックスアンサー` `タックスアンサーNo.` `TA` の後ろの 4 桁。全角は半角に揃える）を全部取る。`claim.claim` に無ければ `claim.sentence` から取る。**条文・通達の番号**（`第…条`・`…条の…`・`…通…-…` など）が `claim.claim` に含まれるときは対象にしない（今回はタックスアンサーの番号だけ）。
- 同じ文（`sentence` が完全一致）の別の主張で、`type !== '番号'`・`status === '裏付けあり'`・根拠の資料（`evidence_id` の資料）が `kind: 'taxanswer'` で、その `no` が主張の番号の 1 つと一致するものを探す。
- **主張の番号すべて**に一致する主張があれば、その番号の主張を裏付けありにする:
  - `status: '裏付けあり'`・`evidence_id`・`quote` は一致した主張のもの（番号が複数なら最初の番号のもの）。`evidence` にその資料が無ければ足す。`correct: ''`。
  - `reject_reason`・`rejected_answer` は消し、代わりに `number_from_sibling: { id: <一致した主張の id>, previous_status: '資料なし', previous_reject_reason: <元の reject_reason または ''> }` を残す。
- 1 つでも一致しない番号があれば何もしない（資料なしのまま。今までどおり止めて具体を外す）。
- `食い違い`・`期限の書き漏れ` の番号の主張は触らない。

## R3 承認画面の表示（`netlify/functions/review-page.js`）

「資料が無く案内に変えた箇所」の各行（`renderFactCheck` の `pairs`、`generalized` の修正）に、その主張の元の判定を足す:

- 記録の `claims`（無ければ `rechecked`）から同じ `id` の主張を探し、`rejected_answer` があれば
  `AI の答え: <status>（<資料の題名、無ければ URL>）／機械が採らなかった理由: <reject_reason>` と、引用（200 字まで）を表示する。
- `rejected_answer` が無ければ `AI の答え: 資料なし`（`reject_reason` があれば `（<reject_reason>）` を付ける）。
- すべて `escapeHtml` を通す。
- 「照合の要点」（`renderFactCheckSummary`）の「資料が無く案内に変えた N 件」に、`rejected_answer.status` が `裏付けあり` のものが M 件（M ≥ 1）あれば `（うち AI は裏付けありと答えた M 件）` を足す。

## R4 記録の版

`LOGIC_VERSION` を `plan2-s3` にする（判定の後の確認が変わるので、古い記録を差し戻しで使い回さない）。

## 試験（新しく `scripts/lib/__tests__/test-fact-keep-supported.js`。偽の LLM で、ネットワークを使わない）

1. R1: 試験データの c16（文・要約）と `rejected_answer.quote`、資料 No.4452 → `sufficientQuote(c16, { quote, correct: '' }, ref4452, '裏付けあり')` が true。次は false のまま:
   - (a) 合計の語が無い文「基礎控除110万円があり、2,110万円まで非課税での贈与が可能です。」（要約も同じ数）
   - (b) 合計が合わない「合計2,210万円」
   - (c) 足す数が文に無い「合計2,110万円まで非課税での贈与が可能です。」（要約「合計2,110万円まで非課税」）
   - (d) `type: '割合'` の主張（合計の語あり・数が合う作り例でよい）
   - (e) `status: '食い違い'` で `correct` に「合計2,110万円」
   - (f) a・b が引用の前後 300 字の外にしか無い（資料の本文を作って確かめる）
2. R1: `partialQuoteNumbers` が、合計の数と足す数を `supported_numbers` に含める（文に裏付けの無い別の金額があるとき）。
3. R2: 試験データの c35・c45（`evidenceRefs` で資料を戻した形）→ c35 が裏付けあり、`evidence_id` が 4508、`number_from_sibling.id === 'c45'`。次は資料なしのまま:
   - c45 の根拠が No.4452／c45 が資料なし／c35 の要約が「No.4508・No.4510」／c35 が食い違い／c35 の要約に「措法70条の2」を含む
4. 通し: `checkFacts`（既存の試験 `fact-pages-test-helpers.js` などの偽の LLM の作り方に合わせる）に c16・c35 の 2 文（＋c45 の文と同じ）を含む本文を渡し、偽の判定が c16 を No.4452 の該当文で裏付けあり、c35 を資料なし、c45 を No.4508 で裏付けありと答える → 記録の `status` が `ok`、`corrections` が空、本文が変わらない、c16 に合計の記録、c35 に `number_from_sibling`。
5. 通し: 4 で c16 の文の数を「合計2,210万円」にする → 今までどおり資料なし→具体を外す修正の対象になる（`corrections` に入る）。
6. R3: `generalized` の修正と `rejected_answer`（引用に `<script>` を含む）がある記録 → 「AI の答え: 裏付けあり」・理由・引用が出て、`<script>` がエスケープされる。`rejected_answer` が無いもの → 「AI の答え: 資料なし」。要点に「（うち AI は裏付けありと答えた 1 件）」。
7. `LOGIC_VERSION === 'plan2-s3'`。

既存の試験（全部通すこと）: `scripts/lib/__tests__/` の `test-fact-*.js` 全部・`test-review-page.js`・`test-review-page-fact-layout.js`・`test-published-facts-audit.js`・`test-materials-bundle.js`。`plan2-s2` を期待している試験は `plan2-s3` に直してよい（一覧にする）。それ以外の既存の期待を変える必要が出たら、変える前に最終報告に【要判断】で理由を書く。

## 変更してはいけないもの

- `blockingFinding`・`REVIEW_TYPES`・`NUMERIC_TYPES`・具体を外す修正の指示（`repairInstructions`）・修正の採否（`repairBody` の保全条件）
- 判定のプロンプト（`instruction`・`example`・資料表の形）と抜き出しのプロンプト
- `quoteSupportsNumbers` の範囲（300 字）・日付・基準日・表の行の扱い
- `generate-draft.js`・ワークフロー・`review-approve-background.js`
