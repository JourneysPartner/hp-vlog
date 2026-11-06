# 段階 2: 照合が文を特定できなかった主張では止めない

前提と安全の決まり（S1〜S6）は `README.md`。

## いまの動き

- `extractClaims` は、AI が抜き出した主張を本文の文と結び付けられないとき、`discardedClaims`（理由「本文に見つからない」「主張の形式が不正」）に入れる。
- `analyze`（`fact-check.js` 1474〜1483 行付近）は、`droppedClaims`（上限で未照合）と `discardedClaims` を同じに扱い、`uncheckedClaimBlocksApproval(c)` が真（数字の主張など）なら `uncheckedNumeric` を数えて照合全体を `revise` にする（1679 行付近）。偽なら「人が確かめる箇所」（`review_items`）に載せる。
- 記録の `discarded_claims` の各項目には `stage`（`抜き出し`／`再照合`）と `blocks_approval` が入る。

## 要件

### R8 書き手の文から捨てた主張は止めない

- 段階が `抜き出し`（`rechecking` が偽）の `discardedClaims` は、`uncheckedClaimBlocksApproval` の結果にかかわらず `uncheckedNumeric` を数えない。記録の `blocks_approval` は `false` にし、「人が確かめる箇所」に載せる（いま偽のときと同じ `addReviewItem` の経路）。
- 「人が確かめる箇所」での状態の名前は「照合で文を特定できなかった」にする（画面の見出しと件数に出る）。`pointed_sentence`（AI が指した文）は、画面で「AI が指した文」として見せられるように残す。
- 段階が `再照合`（照合の自動修正で置き換えた文）の `discardedClaims` は今のまま（S6）。
- `droppedClaims`（上限で未照合）は今のまま。
- `LOGIC_VERSION` を `plan2-s5` に上げる。`plan2-s4` を固定で見ている試験は `rg -n "plan2-s4" scripts` で探して直す。

### R9 画面の文言（`review-page.js` の `renderFactDiscarded`・`renderFactReviewItems`）

- `blocks_approval` が偽の捨てた主張には「人が確かめる箇所にも載せています（承認は止めません）」を出す（今の文言のまま）。
- 「人が確かめる箇所」の一覧で、状態「照合で文を特定できなかった」の項目は、`pointed_sentence` があれば「AI が指した文: <文>」を出す。並び順は「資料なし」「上限で未照合」の後。
- 説明の文「数字の主張は照合できていないため、承認を止めています。」は、止めている項目が 1 件以上あるときだけ出す。

## 試験

`scripts/lib/__tests__/test-fact-discarded-claims.js` に足す（期待が変わる既存の項目は直し、最終報告に書く）。

1. 書き手の文で数字の主張が「本文に見つからない」で捨てられ、他に問題が無い → 照合の状態は `ok`、`discarded_claims[0].blocks_approval` は `false`、`review_items` に状態「照合で文を特定できなかった」で 1 件。
2. 同じく「主張の形式が不正」→ 1 と同じ。
3. 再照合の段階で数字の主張が捨てられる → 今までどおり `revise`、`blocks_approval` は `true`（S6）。
4. 上限で未照合の数字の主張 → 今までどおり（止める）。
5. #744 の形: 箇条書き「- <strong>10万円</strong>：上のいずれにも当てはまらない場合」を指し、要約「65万円・55万円の要件に当てはまらない場合は10万円」で捨てられる → 止めない、「人が確かめる箇所」に載る。
6. 画面: 1 の記録で「照合で文を特定できなかった 1 件」が件数に出て、「AI が指した文」が出る。止める項目が無いとき「承認を止めています」の文が出ない。

## 変えてよいファイル

- `scripts/lib/fact-check.js`
- `netlify/functions/review-page.js`
- `scripts/lib/__tests__/test-fact-discarded-claims.js`
- `LOGIC_VERSION` を固定で見ている試験・この決定で期待が変わる既存の試験（変えた試験と理由を最終報告に書く）

## 変えてはいけないもの

- 食い違い・期限の書き漏れ・資料なしの判定と修正（`repairBody` など）。
- 再照合の段階の捨てた主張と、上限で未照合の扱い（S6）。
- 照合の AI への指示文（プロンプト）。
