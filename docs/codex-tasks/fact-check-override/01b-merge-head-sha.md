# 段階 1b: マージする版を承認の版に固定する（S2 の残り）

段階 1・2 の実装の報告で、S2 に残りがあった。承認の書き込み（`putFile`）の後、PR のマージ（`mergePR`）までの間に枝が更新されると（例: 差し戻しの再生成が push する）、`mergePR` は更新後の枝をマージする。人が見ていない版が main に入りうる。

GitHub の PR マージ API は `sha`（PR の先頭がこの sha のときだけマージする）を受け付け、違えば 409 を返す。これを使う。

## 要件

### R10 `mergePR` に先頭の版の指定を足す（`netlify/functions/lib/github-api.js`）

- `mergePR(prNumber, commitTitle, { maxAttempts, intervalMs, expectedHeadSha })` のように任意の `expectedHeadSha` を受け付け、指定があればマージの要求の本文に `sha: expectedHeadSha` を入れる。
- `expectedHeadSha` を指定していて 409 が返ったときは、再試行せずにすぐ失敗として投げる（先頭が違うので待っても直らない）。投げる誤りの文言に「枝の先頭が承認の版と違う」を含める。
- 指定が無いときの動き（本文・再試行）は今と同じ。

### R11 承認でマージする版を固定する（`review-approve-background.js`）

- 新規記事の承認で、`putFile` の戻り値の `commit.sha` を受け取り、`mergePR` に `expectedHeadSha` として渡す（上書きかどうかにかかわらず）。
- 上書きを受け付けた承認で `commit.sha` が取れないときは、マージせずに `merge_failed` の通知を出す（S2）。上書きでない承認で取れないときは、今と同じに指定なしでマージする。
- マージが「枝の先頭が承認の版と違う」で失敗したときは、今の `merge_failed` の経路に乗せる（通知の文言は今のまま）。今ある「マージ失敗でも main がすでに approved なら失敗通知を出さない」判定は変えない。

## 試験

`test-fact-check-override.js` に足す（`test-publish-slot.js` など既存の偽の `putFile` が `commit` を返さない試験は、今の動きのままで通ること）。

1. `mergePR`: `expectedHeadSha` ありで本文に `sha` が入る。なしでは入らない（偽の `fetch` で本文を確かめる）。
2. `mergePR`: `expectedHeadSha` ありで 409 → 1 回で投げ、文言に「枝の先頭が承認の版と違う」。なしで 409 → 今までどおり再試行。
3. 承認: 偽の `putFile` が `{ commit: { sha: 'abc' } }` を返す → `mergePR` に `expectedHeadSha: 'abc'` が渡る（上書きあり・なしの両方）。
4. 上書きの承認で偽の `putFile` が `commit` を返さない → `mergePR` を呼ばず、`merge_failed` の通知。
5. 上書きでない承認で偽の `putFile` が `commit` を返さない → 今と同じに `mergePR` を呼ぶ。

## 変えてよいファイル

- `netlify/functions/lib/github-api.js`（`mergePR` だけ）
- `netlify/functions/review-approve-background.js`
- `scripts/lib/__tests__/test-fact-check-override.js`
- 偽の `mergePR` の引数を厳密に見ていて落ちる既存の試験（変えた試験と理由を最終報告に書く）
