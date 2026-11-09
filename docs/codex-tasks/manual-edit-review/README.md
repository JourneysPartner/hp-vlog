# 公開中の記事の手直し PR を承認画面で確かめて承認する

2026-11-09 毛利の決定（「そうしよう」）。Claude が手で直した公開中の記事の PR（例: #748・#751・#756）を、日次の下書きと同じ承認画面（Chatwork の通知のリンク先）で確かめて承認できるようにする。

## 背景

- 承認画面（`/review?file=<file>&ref=<枝>`、netlify/functions/review-page.js）が扱うのは、日次の下書き（枝 `draft/<日付>-<slug>`）と、公開中の記事の更新案（枝 `draft/refresh-<slug>`）だけ。
- 手作業の PR（枝 `seo/...` など）の ref を付けて開くと、通常の下書きと同じ画面になり、押すと次のことが起きる（2026-11-09 調査。行番号は origin/main 3b6ffaab）。
  - 承認: review-approve-background.js 416-425 の 409 で止まるが、**通知を出さない**。背景関数なので画面は常に 202 → 黙って失敗する。
  - 差し戻し: review-revise.js が枝に `needs_revision` を書き、denylist と main の banned-phrases に書き足し、regenerate-draft.yml で AI が手直しを作り直して push する。
  - 見送り: review-skip.js が枝に `skipped` を書き、PR を閉じる。
  - 更新案の経路（handleRefreshApproval）は main の frontmatter に枝の本文を載せて記事 1 ファイルだけ書くので、題名・説明文と記事以外のファイルの変更が落ちる。
- 手作業の PR の多くは、題名・説明文（frontmatter）と本文の両方を変え、`data/internal-link-placements.json` や `scripts/lib/__tests__/test-title-refresh.js` も変える（#751）。

## 方針

- 新しい種類「公開中の記事の手直し」（以下「手直し PR」）を足す。見分けは**枝の名前 `edit/<slug>`** と、サーバー側の確かめ（下の R2）。Claude はこれから手直し PR をこの名前の枝で作る。
- 承認 = その PR を**マージ**して公開中の記事に反映する。題名・説明文も変わる。公開日は変えない。
- 差し戻し = 記事のファイルには何も書かず、PR にコメントを残して Chatwork に知らせる（AI の作り直しはしない。直すのは Claude）。
- 見送り = 記事のファイルには何も書かず、PR を閉じてコメントを残す。
- PR が「下書き（draft PR）」でなくなったとき（作成時に下書きでない場合を含む）に、承認画面のリンクを Chatwork に送る。

## 段階

| 段 | 内容 | 指示書 |
|---|---|---|
| 1 | 画面・承認・差し戻し・見送り・通知・試験 | 01-review-flow.md |

1 段で全部入れる（途中の段で止めると、画面と承認の動きが食い違うため）。

## 全段階共通の厳守事項

1. 日次の下書き（`draft/<...>`）と更新案（`draft/refresh-<slug>`）の今の動きを変えない。既存の試験はすべて通ったままにする。
2. 手直し PR の承認では、frontmatter の `review_status`・`publish_at`・`published_at`・`approved_at`・`publish_slot` を**書き換えない**（公開中の記事が一度消える事故を防ぐ）。
3. 見た版だけを承認できる: 画面が表示に使った PR の先頭のコミット（head sha）を承認の送信に含め、サーバーはそれと PR の今の先頭が一致し、マージにも同じ sha を渡す。違えば止める（再試行しない）。
4. マージの成功は `getPR(n).merged === true` で判定する。main の review_status では判定しない（手直し PR では main が最初から published のため）。
5. 失敗・拒否はすべて Chatwork に通知する（画面には 202 しか返らないため）。
6. 枝は消さない（`deleteBranch` は draft/* だけのまま）。
7. 認証・CSRF（requireAction、/review-auth-check の事前確認）、出典ガード、仮置きタイトル、品質ゲート、照合の停止と上書きは、手直し PR にもそのまま効かせる。
8. 鍵の形の文字列を試験や資料に書かない（Netlify の秘密情報検出でビルドが落ちる）。

## 元に戻す方法

この PR の差し戻し（revert）で戻る。データの移行は無い。`edit/` の枝の手直し PR は、戻した後は GitHub の画面でマージする（今と同じ）。

## 受け入れ確認（Claude）

- 01-review-flow.md の試験がすべて通り、`npm run masters:test` に入っていて CI で動く。
- 既存の試験（test-review-approve-refresh、test-review-skip-refresh、test-review-page、test-fact-check-override、test-draft-branch-hygiene、test-notify-message ほか）が通る。
- 差分を読み、厳守事項 1〜8 を一つずつ確かめる。
- 独立レビュー（Opus 5.5 xhigh）で High 0。
- マージ後、Claude が小さな手直し PR を `edit/` の枝で 1 本作り、Chatwork の通知 → 画面の表示 → 承認 → 本番反映を毛利と確かめる。

## コードの入口

- 画面: netlify/functions/review-page.js（319 isRefresh、723-739 refreshContext、460-467 公開日時、490-498 suppressTopic、510-521 ボタン、526-530・604-627 画面のスクリプト）
- 承認: netlify/functions/review-approve-background.js（332-342 依存の差し込み、390-404 照合、416-425 公開済みの 409、427-531 ガード、581-629 マージと成功判定、179-329 handleRefreshApproval）
- 差し戻し・見送り: netlify/functions/review-revise.js、review-skip.js
- GitHub の部品: netlify/functions/lib/github-api.js（getFile 137、findPR 251、getPR 280、waitForMergeable 305、mergePR 337、deleteBranch 385、closePR 409、commentOnPR 426）
- 通知: netlify/functions/lib/notify/message.js、scripts/notify.js、netlify/functions/notify-dispatch.js
- 差分: scripts/lib/freshness-refresh.js の diffSections
- 試験の書き方: scripts/lib/__tests__/test-review-approve-refresh.js（_handler(event, deps)＋authenticatedEvent）、test-fact-check-override.js（review-page の api.getFile の差し替え）、review-auth-test-helpers.js
