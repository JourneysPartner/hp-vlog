# 段階 1: 人の判断で照合の止めを外す

前提と安全の決まり（S1〜S6）は `README.md`。

## 要件

### R1 レビュー画面に確認欄を出す（`review-page.js`）

- `fetchPostFromGitHub` が記事の中身と一緒にファイルの sha も返すようにし、画面の script に `FILE_SHA` として埋める（`scriptJson` を使う）。
- 照合で承認が止まっている記事（承認の処理と同じ条件: `fact_check_blocking` が真、または `fact_check_status` が `revise`）だけ、操作ボタンの上に次の確認欄を出す。
  - 印の欄の文言: 「照合の指摘を確認しました。指摘が残ったまま、自分の判断で公開します」
  - 状態が `not_run`（照合が最後まで動かなかった）のときは、上の文言の前に「照合が最後まで動いていません。」を付ける。
  - 印を付けるまで「このまま公開」（更新案なら「更新を反映する」）を押せない。印を外したらまた押せない。
- 承認の送信には常に `file_sha: FILE_SHA` を入れる。印が付いているときだけ `fact_check_override: true` を入れる。
- 照合で止まっていない記事の画面と送信の中身は、`file_sha` が増える以外は変えない。
- 「照合の要点」の赤い枠の文言「照合で承認が止まっています」の後に「（下の確認欄に印を付ければ公開できます）」を足す。

### R2 承認の処理で上書きを受け付ける（`review-approve-background.js`）

照合の止め（365 行付近）を次のように変える。

1. 照合で止まる条件に当たらない記事: 今と同じ。
2. 当たる記事で、要求に `fact_check_override: true` が無い: 今と同じに止める（S1）。理由の文言は「事実の照合で承認できない状態です（<状態>）。直す場合は差し戻してください。指摘を確認したうえで公開する場合は、レビュー画面の確認欄に印を付けて押してください」。
3. 当たる記事で、`fact_check_override: true` がある:
   - 要求の `file_sha` が無い、または `branchFile.sha` と違う → 承認しない。通知（新規は `quality_blocked`、更新案は `refresh_approve_failed`）の理由は「記事の内容が変わりました。レビュー画面を開き直して、もう一度確かめてください」。状態コードは 409（S2）。
   - 一致する → 照合の止めだけを外して先に進む。ログに `[review-approve] 照合の指摘を人の判断で上書き: <filename>` を出す。
- `fact_check_override` は `true`（真偽値）のときだけ有効にする。文字列の `"true"` などは無いものと同じに扱う。

### R3 照合が書き換えた `recommendation` を元に戻してから品質ゲートを通す

- 上書きを受け付けた記事で、次の 3 つがすべて当てはまるときだけ、`recommendation` を `fact_check_prev_recommendation` の値に戻したものとして品質ゲート（452 行付近）を判定する。
  - `recommendation` が `revise`
  - `fact_check_prev_recommendation` の欄がある
  - `fact_check_status` が `revise` か `not_run`
  （`applyFactResult` の `ownRevise` と同じ考え方。照合が書き換えた `revise` だけを戻す。）
- `fact_check_prev_recommendation` が `revise` か `reject` なら戻しても止まる（S3）。欄が無い記事は戻さない（今までどおり「recommendation が revise です」で止まる）。
- 出典ガード・仮置きタイトル・公開済みの保護・スコアの判定は、今の順番と条件のまま（S3）。

### R4 承認した記事に上書きの記録を残す

- 新規記事の承認（520〜540 行付近の `updates`）に、上書きを受け付けたときだけ次を足す。
  - `recommendation`: R3 で戻した値（戻したときだけ）
  - `fact_check_override`: `true`
  - `fact_check_override_at`: 承認の時刻（`nowJST()`）
  - `fact_check_override_status`: そのときの `fact_check_status`
  - `fact_check_override_summary`: そのときの `fact_check_summary`
  - `fact_check_override_sha`: 見た版の sha
- `fact_check_status`・`fact_check_summary`・`fact_check_blocking` は変えない（S4）。
- 更新案（`handleRefreshApproval`）で上書きしたときは、main に書く記事の frontmatter に同じ欄を足す。既存の「反映する変更がありません」などの判定は変えない。書き込みの形を変えるのが大きくなる場合は、自分で決めずに最終報告に書く。

### R5 通知の文面

- `approved`（公開予約の完了）と `refresh_published` の通知に、上書きのときだけ「照合の指摘が残ったまま、確認のうえ公開しました（照合: <要約>）」の行を足す。上書きでないときの文面は変えない。
- `notify/message.js` の既存の試験が見ている文面は変えない。

### R6 古い上書きの記録を消す（`fact-check.js` の `applyFactResult`）

- 新しい照合の結果を記事に書くとき、`fact_check_override` で始まる欄があれば frontmatter から消す（S5）。`updateMeta` に欄を消す手段が無ければ足す。その他の欄の並びと書き方は変えない。

### R7 検証の安全網（`validate.js`）

- `review_status` が `approved`・`scheduled`・`published` のどれかで、`fact_check_blocking` が真または `fact_check_status` が `revise` の記事は、`fact_check_override` が `true` でなければ誤りにする。文言は「照合で止まっている記事が <状態> になっています（照合の指摘を確認した記録がありません）」。
- 2026-11-06 時点の main で、この条件に当たる記事は 0 本（Claude が確認済み）。実装後に `content/posts` で数え直し、0 本でなければ誤りにせず最終報告に書く。

## 試験

新しい試験ファイル `scripts/lib/__tests__/test-fact-check-override.js` に書く。既存の `test-review-approve-refresh.js`・`test-review-page.js` の注入（`injected` の偽の `getFile`・`putFile`・`sendNotification` など）の書き方に合わせ、本物の関数を使う。

1. 止まっている記事・印なし → 400、`putFile` は呼ばれない、通知の理由に「確認欄に印を付けて」が入る（S1）。
2. 止まっている記事・`fact_check_override: "true"`（文字列）→ 1 と同じ（S1）。
3. 止まっている記事・印あり・`file_sha` 無し、または違う → 409、`putFile` も `mergePR` も呼ばれない、理由に「開き直して」（S2）。
4. 止まっている記事・印あり・sha 一致・`fact_check_prev_recommendation: "publish"` → 承認される。書き込んだ frontmatter に `review_status: approved`・`recommendation: publish`・`fact_check_override: true`・`fact_check_override_at`・`_status`・`_summary`・`_sha` があり、`fact_check_status`・`fact_check_blocking`・`fact_check_summary` は元のまま（S4）。`approved` の通知に上書きの行がある。
5. 4 と同じで `fact_check_prev_recommendation: "revise"` → 品質ゲートで止まる（S3）。`"reject"` も止まる。
6. 4 と同じで `fact_check_prev_recommendation` の欄が無い → 止まる（S3）。
7. 印あり・sha 一致でも、仮置きタイトル／出典ガードで止まる記事は止まる（S3）。
8. 照合で止まっていない記事に印と sha を付けて送っても、承認の結果と書き込みは今と同じ（`fact_check_override*` の欄を書かない）。
9. 更新案の経路: 印なし → 今と同じに止まる。印あり・sha 一致 → 反映され、main に書く frontmatter に上書きの欄がある。sha 違い → 反映しない。
10. `not_run` で止まっている記事も、印あり・sha 一致なら承認できる。
11. 画面: 止まっている記事だけ確認欄が出て、`btnApprove` が初めは押せない。`not_run` の文言。止まっていない記事の HTML には確認欄が無い。送信の中身に `file_sha` がある。
12. `applyFactResult`: `fact_check_override*` の欄がある記事に新しい結果を書くと、その欄が消え、他の欄は今と同じ（S5）。
13. `publish-due.js`: 上書きで承認した記事（`recommendation: publish`・`fact_check_status: revise`・`fact_check_override: true`・公開時刻を過ぎた `approved`）は公開される。
14. `validate.js`: `approved` で `fact_check_blocking: true` かつ上書きの記録なし → 誤り。上書きの記録あり → 誤りなし。

## 変えてよいファイル

- `netlify/functions/review-approve-background.js`
- `netlify/functions/review-page.js`
- `netlify/functions/lib/notify/message.js`
- `scripts/lib/fact-check.js`（R6 の部分だけ。段階 2 は `02-discarded-not-blocking.md`）
- `scripts/validate.js`
- `scripts/lib/__tests__/test-fact-check-override.js`（新規）
- 既存の試験は、この決定で期待が変わるものだけ（変えた試験と理由を最終報告に書く）

## 変えてはいけないもの

- 照合の判定そのもの（段階 2 を除く）・照合の記録の中身・`fact_check_status` の付け方。
- 差し戻し（`review-revise.js`）・見送り・再生成のワークフロー。
- `scripts/publish-due.js` の品質ゲートの条件（R3・R4 で `recommendation` が戻るので変えずに通る）。
- 認証（`review-auth`）の仕組み。
