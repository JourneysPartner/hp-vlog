# 段 1: 手直し PR の画面・承認・差し戻し・見送り・通知

README.md の厳守事項 1〜8 を必ず守る。行番号は origin/main 3b6ffaab 時点の目安。

## 用語

- **手直し PR**: 次をすべて満たす PR。判定は**サーバー側**（review-page.js と各関数）で毎回行い、画面から送られた値を信じない。
  1. 枝の名前が `edit/` で始まり、`^edit/[a-z0-9][a-z0-9_-]{0,80}$` に合う。
  2. その枝の open な PR が 1 本あり、base が `main`。
  3. PR の変更ファイルが、次の**許可リスト**だけからなる:
     - `content/posts/<file>`（画面の file と同じ 1 本だけ。記事は 1 PR に 1 本）
     - `data/internal-link-placements.json`
     - `data/fact-check/<その記事の slug>.json`
     - `scripts/lib/__tests__/test-title-refresh.js`
  4. main と枝の両方で、その記事の `review_status` が `published`、`slug` が同じ。
- 1〜4 のどれかが欠けたら「手直し PR として扱えない」。その理由を画面に出し、承認ボタンを押せなくする。

## R1 GitHub の部品（netlify/functions/lib/github-api.js）

- `listPRFiles(prNumber)` を足す（GET /repos/{owner}/{repo}/pulls/{n}/files、per_page=100、ページをたどる。返すのは `{ filename, status }` の配列）。301 件以上なら例外。
- `getFile(path, ref)` の `?ref=` を `encodeURIComponent` で符号化する（今は符号化していない）。日次の下書き・更新案の動きは変わらないこと。

## R2 判定の部品（新しいファイル netlify/functions/lib/manual-edit.js）

- `isManualEditRef(ref)`: 用語の 1 の正規表現。
- `ALLOWED_EXTRA_FILES`、`checkManualEditPR({ filename, ref, findPR, listPRFiles, getFile })`: 用語の 1〜4 を確かめ、`{ ok, reasons[], pr, headSha, mainFile, branchFile, files }` を返す。`headSha` は `pr.head.sha`。
- `diffFrontmatter(mainRaw, branchRaw)`: 1 行の `key: "value"` の項目を比べ、変わった項目の `{ key, before, after }` を返す（題名・説明文・updated_at・reviewed_at など）。
- 本文の差分は既存の `freshnessRefresh.diffSections(mainBody, branchBody)` を使う。

## R3 画面（netlify/functions/review-page.js）

- ref が `isManualEditRef` に合うときは `checkManualEditPR` を呼び、`editContext` を作る（723-739 の refreshContext と同じ場所）。
- 手直し PR の画面:
  - 上の案内: 「公開中の記事の手直しです。承認すると、この PR をマージして公開中の記事に反映します（題名・説明文も変わります。公開日は変わりません）」。PR へのリンク（`pr.html_url`）。
  - 「変わる項目」の表: `diffFrontmatter` の結果（項目名・前・後）。
  - 「本文の変更箇所」: 更新案と同じ形（renderRefreshDiff と同じ見た目でよい）。
  - 「この PR で変わるファイル」の一覧（`files`）。
  - 隠すもの: 公開日時の入力（460-467）、今後このテーマを生成しない（490-498）、見送り＋今後生成しない（519-521）。
  - `checkManualEditPR` が `ok: false` なら、理由を赤で出し、承認ボタンを押せなくする（差し戻し・見送りは押せる）。
  - 照合の表示・照合の上書き欄は今のまま出す。
- 画面のスクリプトは、承認・差し戻し・見送りの送信に `head_sha`（画面が表示に使った `headSha`）を足す。手直し PR 以外では送らない（既存の送信は変えない）。

## R4 承認（netlify/functions/review-approve-background.js）

- 入力の検査を足す: `filename` は `^[\w-]+\.md$`、`ref` は文字列で 200 字以内（違えば 400）。日次の下書き・更新案にも効くが、今の正しい値はすべて通ること。
- 416 の公開済みの 409 の**前**に、ref が `isManualEditRef` に合えば `handleManualEditApproval` に渡す（依存の差し込みは handleRefreshApproval と同じ形。332-342 に getPR・listPRFiles・commentOnPR を足す）。
- `handleManualEditApproval` の順序:
  1. `checkManualEditPR` が ok でなければ、`edit_approve_failed` を通知して 409。
  2. 送られた `head_sha` が無い、または `headSha` と違えば、`edit_approve_failed`（「画面を開いた後に PR が更新されました。画面を開き直してください」）で 409。
  3. 照合の停止（390-404 と同じ判定・同じ上書きの条件）、出典ガード（427-449、枝の内容）、仮置きタイトル（469-482）、品質ゲート（484-531）を、枝の記事に対して今と同じく効かせる。止まれば今と同じ通知の種類（quality_blocked・source_blocked）で 400。
  4. 照合の上書きが受け入れられたときだけ、枝の記事に上書きの記録の欄（factOverrideUpdates の結果）を putFile で書き、その新しいコミットの sha を以後の `expectedHeadSha` にする。それ以外では**枝に何も書かない**（review_status・publish_at などは厳守事項 2 のとおり触らない）。
  5. `waitForMergeable(pr.number, expectedHeadSha)` → `mergePR(pr.number, expectedHeadSha)`。手直し PR では、mergeable_state が `clean`・`has_hooks` 以外（`unstable`・`blocked`・`dirty`・`behind`・不明のまま時間切れ）なら**マージせず** `edit_approve_failed`（状態を書く）で 409。日次の下書きの waitForMergeable の今の動きは変えない（手直し PR 用の引数か別の関数で分ける）。
  6. マージ後に `getPR(pr.number)` で `merged === true` を確かめる。true なら `edit_published`（題名・公開中の記事の URL `https://mori-zeirishi.net/blog/<slug>/`・PR の URL）を通知して 200。false なら `edit_approve_failed`。
  7. 枝は消さない。
- 617-629 の「main が approved/scheduled/published なら二度押し扱い」は、手直し PR では使わない（`getPR(n).merged` で判定する）。既にマージ済みの PR への承認は `edit_processed`（「この手直しはすでに反映済みです」）で 200。
- 今の 416-425 の 409（手直し PR でない公開済みの記事）にも `edit_approve_failed`（「この画面では承認できない種類の PR です。GitHub で確認してください」）の通知を足す。

## R5 差し戻し（netlify/functions/review-revise.js）

- ref が `isManualEditRef` に合うときは、41 の後で分ける:
  - 記事のファイル・denylist・banned-phrases・公開枠には**何も書かない**。ワークフローを起動しない。
  - PR に「承認画面から差し戻し: <コメント>」をコメントし、`edit_revise_requested`（題名・コメント・PR の URL・画面の URL）を通知して 200。
- 手直し PR でない ref の今の動きは変えない。

## R6 見送り（netlify/functions/review-skip.js）

- ref が `isManualEditRef` に合うときは、47 の後で分ける:
  - 記事のファイル・denylist・公開枠には**何も書かない**。
  - PR に「承認画面から見送り」をコメントして閉じ、`edit_skipped` を通知して 200。枝は消さない。
- 手直し PR でない ref の今の動きは変えない。

## R7 通知の種類（netlify/functions/lib/notify/message.js）

- `edit_ready`（件名「【手直しの確認】<題名>」。本文に画面の URL・PR の URL・変更の要約（comment））、`edit_published`、`edit_approve_failed`、`edit_processed`、`edit_revise_requested`、`edit_skipped` を足す。書き方は refresh_* と同じ形。
- notify-dispatch.js が受け付ける項目は今のまま（title・reviewUrl・prUrl・comment・publicUrl・filename）で足りるはず。足りなければ足す。

## R8 通知のワークフロー（新しいファイル .github/workflows/manual-edit-ready.yml）

- きっかけ: `pull_request` の `opened`・`reopened`・`ready_for_review`（base が main）と、`workflow_dispatch`（入力 `pr_number`）。
- 条件: head の枝が `edit/` で始まり、PR が下書き（draft）でない。変更ファイルの中の `content/posts/*.md` がちょうど 1 本。
- 動き: その記事の題名を読み、`node scripts/notify.js --event edit_ready --title "<題名>" --review-url "https://mori-zeirishi.net/review?file=<ファイル名>&ref=<符号化した枝名>" --pr-url "<PR の URL>" --comment "<PR の題名>"`。環境変数は refresh-article.yml 48-49 と同じ（`vars.NETLIFY_NOTIFY_URL`・`secrets.NOTIFY_WEBHOOK_SECRET`）。
- 権限は `contents: read`・`pull-requests: read` だけ。枝の checkout は main（PR の枝のコードを動かさない）。PR の情報は `gh pr view` か GitHub の API で読む。

## R9 試験

新しい試験ファイル（例 scripts/lib/__tests__/test-manual-edit-review.js）を作り、`package.json` の `masters:test` に足す。test-review-approve-refresh.js と同じく、本物の認証（authenticatedEvent）と偽の GitHub の部品で動かす。少なくとも:

1. 判定: `edit/` 以外の枝、PR なし、base が main 以外、許可リストにないファイル（例 `scripts/build.js`）、記事が 2 本、main か枝の review_status が published でない、slug が違う → それぞれ ok: false と理由。
2. 画面: 手直し PR で、案内・変わる項目（題名・説明文の前後）・本文の変更箇所・ファイル一覧が出て、公開日時・今後生成しない・見送り＋今後生成しないが出ない。ok: false なら承認ボタンが disabled。送信に head_sha が入る（vm で画面のスクリプトを動かす。test-fact-check-override.js 181-197 の形）。
3. 承認の成功: mergePR に表示時の head sha が渡り、枝・main とも putFile されない（上書きなしのとき）、deleteBranch が呼ばれない、getPR で merged を確かめ、edit_published が 1 回通知される。
4. head sha の違い → マージしない、409、edit_approve_failed。head_sha なし → 同じ。
5. mergeable_state が unstable・blocked・dirty・時間切れ → マージしない、edit_approve_failed。
6. マージ後に merged が false → edit_approve_failed（成功扱いにしない）。既にマージ済み → edit_processed、mergePR を呼ばない。
7. 照合の停止: 上書きなし → 400 でマージしない。上書きあり（同意＋file_sha が合う）→ 上書きの欄だけ枝に書き、その新しい sha でマージ。
8. 出典ガード・仮置きタイトル・品質ゲートで止まる → マージしない。
9. 差し戻し（手直し PR）: putFile・triggerWorkflow・denylist・banned-phrases の書き込みが 0 回、commentOnPR 1 回、edit_revise_requested 1 回。
10. 見送り（手直し PR）: putFile 0 回、closePR 1 回、deleteBranch 0 回、edit_skipped 1 回。
11. 手直し PR でない公開済みの記事の承認 → 409 で edit_approve_failed が通知される（今は通知なし）。
12. 回帰: 日次の下書きの承認・差し戻し・見送りと、更新案の承認・見送りが今と同じ（既存の試験が通る）。
13. 入力の検査: filename が `../x.md` や `a.txt` → 400。ref が 201 字 → 400。
14. getFile が ref を符号化する（`edit/a b` → `edit%2Fa%20b`）。
15. 通知の文面: 新しい 6 種類が JSON のまま出ず、件名と URL が入る（test-notify-message.js に足してよい）。
16. ワークフロー: YAML を読み、きっかけ・条件（`edit/`・draft でない）・権限・checkout が main であることを確かめる簡単な試験。

## 変更してはいけないもの

- 日次の下書き・更新案の承認・差し戻し・見送りの動き（入力の検査と getFile の符号化を除く）。
- `deleteBranch` の draft/* の制限、mergePR の再試行と expectedHeadSha の扱い、requireAction・review-auth.js。
- 既存の試験の期待値（壊れたら、こちらの実装を直す）。
- `.github/workflows/` の既存のワークフロー、netlify.toml、netlify-ignore。
- 記事（content/posts/）と data/ の中身。

## 2026-11-09 レビュー後に変えたこと（上の R の記述より、こちらが正）

独立レビュー（Opus 5.5 xhigh）2 回の指摘で、次のとおり変えた。上の本文と食い違うところは、ここに書いたものが今の動き。

- 判定（R2）: main と枝で `review_status`・`slug`・`publish_at`・`published_at`・`approved_at`・`publish_slot` の 6 項目が同じであること、PR が下書きでないこと、変更ファイルの `previous_filename` と `status`（記事は modified のみ、ほかは added・modified のみ）、merge base の版の記事と今の main の記事が同じこと（`compareCommits`）も条件。枝の記事は表示時の head sha の版で読む。`listPRFiles` は `filename`・`status`・`previous_filename`・`additions`・`deletions` を返す。
- 枝名（R2・R8）: `edit/` で始まるが形の正しくない枝は、画面・承認・差し戻し・見送りのすべてで断る。ワークフローも同じ `isManualEditRef` で判定する。
- 承認（R4）: mergeable_state が `unstable` のときは、すぐ断らずに check runs と commit status を読む。失敗があれば止め、pending だけなら最大 8 分待つ（読み取りの一時的なエラーは 3 回まで続けて待つ）。待つ間に head が変われば止め、PR がマージ・クローズされればそれに合わせて終える。確認の後も `unstable` が残れば数回読み直す。照合の上書きを書いたときは、そのコミットの親が表示時の head と同じか確かめる。マージに失敗した後や二度押しの「反映済み」は、マージされた版の head が見た版と同じときだけ。
- 通知（R7）: 手直しでない公開済みの記事の 409 と、形の正しくない edit/ の枝は `edit_unsupported`。差し戻し・見送りの失敗は `edit_revise_failed`・`edit_skip_failed`。
- ワークフロー（R8）: 題名は head sha の版の記事を GitHub の API でデータとして読む（失敗しても赤くしない）。`file=` を符号化、PR が open でなければ通知しない、フォークの PR は除く。

見送った指摘（記録）:
- N4: 照合の上書きをして承認した後、別のタブから二度押しすると「違う版がマージされています」と出る（上書きのコミットが入るため）。ボタンは押すと無効になり、頻度は低い。
- N6: 確認を待つ間（最大約 9 分）に main の同じ記事が変わると、3 方向マージで main の変更も入る（巻き戻しにはならない）。
- L12: filename・ref の形式違いの 400 は通知しない（画面からは来ないため）。
- 要確認 N2: GitHub App に Checks・Commit statuses の読み取り権限が無いと、`unstable` のときに毎回「自動の確認の状態を確認できませんでした」で止まる（止まる側に倒れる）。最初の通しの確認で確かめる。
