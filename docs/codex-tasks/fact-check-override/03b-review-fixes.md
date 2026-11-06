# 段階 3b: 差分レビューの指摘の直し（2026-11-06 Opus 5.5 xhigh 差分レビュー、Critical 0・High 0・Medium 1・Low 3）

差分レビュー全文: `%TEMP%\hpstatus\review-fact-override\review-2.md`。M1・L1・L2 は FIXED。M2・L4 が一部だけ直っていた。

## 要件

### G1（N1・Medium）マージ可の待ちで先頭の版も待つ（`github-api.js` の `waitForMergeable`、`review-approve-background.js` 595 行付近）

- いま: `waitForMergeable` は PR の先頭の版を見ない。書き込みの直後は PR の先頭が古い版のままのことがあり、古い「マージ可」を受け取ってマージが 409 → 取り直しても古い先頭 → 1 回で `merge_failed`。
- 直し: `waitForMergeable(prNumber, { maxAttempts, intervalMs, expectedHeadSha })` で、`expectedHeadSha` の指定があれば `pr.head?.sha === expectedHeadSha` になるまでは「マージ可」を受け付けずに待つ。待ちきれなかったときの戻り値と、その後の動きは今と同じ（マージは版を指定して送り、409 → 取り直しで先頭が違う → 止まる）。承認の処理は `expectedHeadSha` があるとき `waitForMergeable` にも渡す。F2 の 409 の再試行は最後の安全網として残す。
- 試験: 1 回目の取得は古い先頭でマージ可、2 回目は承認の版 → マージは 1 回で成功し、版が指定されている。先頭が最後まで追いつかない → マージは版を指定して送られ、`merge_failed`。`expectedHeadSha` なしの `waitForMergeable` は今と同じ。

### G2（N2・Low）本文を変えない再生成でも古い上書きの欄を消す（`fact-check.js` の `inheritFactMetadata`）

- 再生成した側（`after`）にある `fact_check_override` で始まる欄を、`updateMeta` の消す欄の引数に渡す（`applyFactResult` と同じ形）。引き継ぐ欄が無くても消す欄があれば `updateMeta` を呼ぶ。
- 試験: 元の記事（上書きの欄あり）のタイトルだけを変えた再生成 → 上書きの欄が無い。

### G3（N4・Low）PR の取り直しに失敗したときのログの文言（`github-api.js` の `mergePR`）

- 取り直しに失敗したときは「PR を取り直せなかった」、先頭が違うときは「枝の先頭が承認の版と違う」と分けて投げる。どちらも再試行しない（今と同じ）。既存の試験の文言の期待は、先頭が違う場合だけに合わせる。

## 記録だけ（README に書いた）

- N3: F1 で、2026-10-12 の決定（案 2）で `ok` にしていた「長文で要件・判定・手続の主張だけを全部捨てた」場合も `not_run` で止まるようになった。人が確認欄で上書きできるので安全側の変更として受け入れる。公開済み記事の照合（`audit-published-facts.js`）では「照合できなかった」になる。

## 変えてよいファイル

- `netlify/functions/lib/github-api.js`（`waitForMergeable`・`mergePR`）・`netlify/functions/review-approve-background.js`・`scripts/lib/fact-check.js`（`inheritFactMetadata`）
- `scripts/lib/__tests__/test-fact-check-override.js`・`scripts/lib/__tests__/test-fact-discarded-claims.js`
- 偽の `waitForMergeable` の引数を厳密に見ていて落ちる既存の試験（変えた試験と理由を最終報告に書く）
