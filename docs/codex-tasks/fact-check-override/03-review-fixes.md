# 段階 3: レビューの指摘の直し（2026-11-06 Opus 5.5 xhigh、Critical 0・High 0・Medium 3・Low 6）

レビュー全文: `%TEMP%\hpstatus\review-fact-override\review.md`。直すのは F1〜F5。M3・L3・L5・L6 は直さず記録する（下の「直さないもの」）。

## 要件

### F1（M1）主張を 1 件も抜き出せなかった照合を「照合済み」にしない（`fact-check.js` 1488 行付近）

- いま: 書き手の段階で正しく抜き出せた主張が 0 件でも、捨てた主張が 1 件でもあれば「主張を抜き出せませんでした」（`emptyClaims`）を投げない。段階 2 で捨てた主張が止めなくなったので、全部捨てると何も確かめずに `ok` になる。
- 直し: 書き手の段階（`rechecking` が偽）で `!extracted.claims.length` かつ本文（見出しを除く）が 200 字以上なら、捨てた主張の有無にかかわらず `emptyClaims` の誤りを投げる。結果は今の `emptyClaims` と同じ経路（`not_run` で止まる。人は確認欄で上書きできる）。再照合の段階の条件は今のまま。
- 試験: 446 字程度の本文で数字の主張を全部捨てる → `not_run`・`fact_check_blocking: true`。捨てた主張と正しい主張が混ざる（正しい主張 1 件以上）→ 今までどおり（捨てた分は止めない）。

### F2（M2）先頭が一致している 409 は再試行する（`github-api.js` の `mergePR`）

- いま: `expectedHeadSha` を指定すると 409 で 1 回で失敗する。書き込みの直後は GitHub の PR の先頭の情報が遅れて 409 になることがあり、通常の承認も取りこぼす。
- 直し: `expectedHeadSha` を指定していて 409 が返ったら、PR を取り直す（`GET /repos/{repo}/pulls/{n}`）。`head.sha === expectedHeadSha` なら一時的な失敗として今までと同じ間隔・回数で再試行する（再試行の要求にも `sha` を入れたまま）。違うとき、または PR を取り直せないときは、すぐ「枝の先頭が承認の版と違う」で失敗にする。
- 試験: 409 で先頭が一致 → 再試行して成功。409 で先頭が違う → 1 回で失敗。409 で PR の取り直しが失敗 → 1 回で失敗。

### F3（L1）上書きのログを品質ゲートの後に出す（`review-approve-background.js` 404 行付近）

- 「照合の指摘を人の判断で上書き」のログは、すべてのゲートを通って承認を書き込む直前（新規）・main に書き込む直前（更新案）に出す。

### F4（L2）上書きの欄は `updateApprovalFields` だけで書く（同 564 行付近）

- `updateFrontmatter` に渡す `updates` に `fact_check_override*` の欄を入れない（`recommendation` の復元は入れてよい）。上書きの欄は後の `updateApprovalFields` だけで書く。
- 試験: 既に `fact_check_override*` の欄がある記事を、要約に `$'` や `$&` を含めて上書きで承認 → 各欄が 1 行ずつで値が正しい。

### F5（L4）再生成で古い上書きの欄を引き継がない（`fact-check.js` の `inheritFactMetadata` 1838 行付近）

- `fact_check_` で始まる欄を引き継ぐとき、`fact_check_override` で始まる欄は除く。
- 試験: 上書きの欄がある記事から本文の変わらない再生成で引き継ぐ → 上書きの欄が無い。

## 直さないもの（PR 本文に記録する）

- M3（S6 は 1 回の照合の中だけ）: 照合の自動修正で置き換えた文が差し戻しの再生成で残ると、次の照合ではその文は書き手の文として扱われ、写せなければ止めない（「人が確かめる箇所」には出る）。利用者の決定（照合が文を特定できなかった主張では止めない）に沿うので受け入れる。README の S6 に範囲を書く。
- L3: 「誰が」は記録しない。レビューのパスワードは 1 つなので「ログインした人」になる。README に書く。
- L5: 「主張の形式が不正」も「照合で文を特定できなかった」と表示される（文言だけ）。
- L6: 照合の記録が古いとき、確認欄の文言はそれに触れない（要点の欄には警告が出る）。
- 前からの穴（今回の差分と無関係）: 読んでから書くまでにファイルが変わると `putFile` が 409 で通知なく 500。照合で止まっていない記事の承認は `file_sha` を照らし合わせない。

## 変えてよいファイル

- `scripts/lib/fact-check.js`・`netlify/functions/lib/github-api.js`・`netlify/functions/review-approve-background.js`
- `scripts/lib/__tests__/test-fact-check-override.js`・`scripts/lib/__tests__/test-fact-discarded-claims.js`
- この直しで期待が変わる既存の試験（変えた試験と理由を最終報告に書く）
