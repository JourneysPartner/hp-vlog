# 01b レビューの指摘（Medium 1 件）を試験で塞ぐ

## 指摘

試験 8（`scripts/lib/__tests__/test-fact-jubun-quote.js`）の記録には、「案内に変えた」欄（`renderGeneralizedAnswer`）と「人が確かめる箇所」（`renderAiSupportedNumberEvidence`）の両方がある。`includes` で見ているので、片方の欄に出ていれば通る。レビューで、`review-page.js` の `renderGeneralizedAnswer` から `${quoteTruncatedNote(answer)}` を消しても、どの試験も落ちなかった。

## やること（試験だけ。コードは変えない）

試験 8 に、次の確かめを足す。

- `review_items: []` の記録（「案内に変えた」欄だけが引用を出す記録）を作る。`pageRecord` に引数を足すか、`{ ...pageRecord(quote), review_items: [] }` のように作ってよい。
- その記録の `page.renderFactCheck({}, 記録)` で:
  - 220 字の引用（`'<script>alert("x")</script>' + '引'.repeat(220)`）が全文で出る。`<script>` は出ず、`&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;` で出る。書き添えの文は出ない。
  - 200 字ちょうどの引用では書き添えの文が出る。199 字・201 字では出ない。
- `renderGeneralizedAnswer` から書き添えを消すと、この確かめが落ちることを、最終報告で説明する（実際にコードを変えて流す必要はない。どの assert が落ちるかを書く）。

## 変えてよいファイル

- `scripts/lib/__tests__/test-fact-jubun-quote.js` だけ。

## 変えてはいけないもの

- `scripts/lib/fact-check.js`、`netlify/functions/review-page.js`、ほかの試験、`docs/` の下。
