# 段 6 の当日の手順（Orca の自動化から起動した Claude が行う）

Orca の自動化「C-1 段6 施行確認と切替」が、毎年 12/1〜12/7 の 9:00（日本時間）に、プロジェクト `HP・LP作成` で Claude（Opus 5.5・xhigh）を起動する。起動した Claude はこの手順書のとおりに進める。利用者決定（2026-11-13）: **施行の確認から下書き PR まで**を任せる。**マージはしない。**

作業の中身は `docs/codex-tasks/r8-switch/06-enforce-r8.md`。実装は OpenCode に任せ、Claude はコードも試験も書かない（全体の CLAUDE.md）。

## 1. もう済んでいないか

1. `cd hp-vlog`（単独のコマンドで）→ `git fetch origin`。
2. `git show origin/main:data/tax-simulator/masters/data/basic-deduction/deductions.json` で `BD-R8-TIER-01` の `legal_status` を見る。`effective` なら段 6 は済み。
3. `gh pr list --head r8/stage6-enforce --state all` で PR があるか見る。
4. 済み、または PR があるときは、何も変えずに 7 章（止める）へ。

## 2. 施行の確認

1. 確認の道具を main から一時フォルダへ書き出す（作業フォルダはまだ作らない）: `git show origin/main:scripts/check-law-revisions-enforced.js > "$TEMP/r8s6-check.js"`
2. `node "$TEMP/r8s6-check.js" 340AC0000000033_20261201_508AC0000000012 332AC0000000026_20261201_508AC0000000012`
   - 終了コード 0: 施行済み。今日（日本時間）を「確認日」として 3 に進む。
   - 1: 未施行。2: 確認できない（e-Gov に届かないなど）。どちらも何も変えずに 7 章へ。12/7 より前なら自動化は止めない（翌日またやる）。12/7 なら自動化を止める。
3. 施行済みなら作業フォルダを作る: `git worktree add -b r8/stage6-enforce .tmp-wt-r8-stage6 origin/main`（枝が既にあれば作り直さない。7 章へ進み、その旨を知らせる）。作った worktree へ `cd`（単独のコマンドで）→ `npm ci`。
4. 確かめた結果（版ごとの状態と施行日）は、最後の報告と PR の本文に書く。一時フォルダの `r8s6-check.js` は消す（`rm -f` を単独のコマンドで）。

## 3. OpenCode に任せる

1. 依頼文を `%TEMP%\r8s6-stage6-request.md`（UTF-8）に書く。中身: 「指示書 `docs/codex-tasks/r8-switch/06-enforce-r8.md` のとおりに作業する。確認日は YYYY-MM-DD。コミット・push・インストールをしない。試験は `sbx` を通す。最後の報告は指示書の『確かめること』1〜5 と、直した試験の名前と理由」。
2. 起動（Bash のバックグラウンドで、見張りを立てる）:
   `node "C:\Users\ko-ch\orca\projects\機能調査\output\go-launch\go-job.mjs" --project <worktree の絶対パス> --prompt <依頼文> --timeout-min 90 --title r8-stage6`
3. 終了コード 0 以外、`protectedChanges` が空でない、`denials` が多いときは、受け入れに進まずに理由を調べる（`C:\Users\ko-ch\AI_AGENT_LESSONS\notes` を先に検索）。直せなければ 7 章へ（途中の状態を報告）。

## 4. 受け入れ

1. 差分を読む。`git diff --stat` に、指示書に無いファイルが無いこと。
2. マスターの差分: `git diff -U0 -- data/tax-simulator/masters/data` の `+`・`-` の行に、`legal_status`・`as_of_date`・`support_status`・`_status`・`_caveat`・`_action_after_enforcement` 以外が無いこと（grep で確かめる）。`enacted` → `effective` の行がちょうど 27 件。
3. 試験は先に `sbx` で（`"/c/Users/ko-ch/orca/projects/機能調査/output/go-launch/bin/sbx" npm run masters:validate` など）。差分を読んだ後に、隔離の外で `npm run masters:test`（10 分以上かかる。バックグラウンドで）・`npm run masters:gate`。試験が書き換えた `assets/js/tax-simulator-boot.js` などは `git show HEAD:<file> > <file>` で戻す（改行だけの差のことが多い）。
4. 金額が 1 件でも変わっていたら、直さずに 7 章へ（不具合として報告）。

## 5. レビュー

1. Opus 5.5 xhigh の別セッションでレビューする（メモリ `review-subprocess-launch` の手順。依頼文と差分は worktree の中の `.tmp-` のファイルに置き、終わったら消す）。
2. Critical・High は OpenCode に直させ（同じ worktree で新しい依頼）、試験と差分のレビューで確かめる。Medium は直すか、理由を付けて台帳に記録する。Low は記録するだけでよい。

## 6. コミットと下書き PR

1. 文書も直す（Claude が書く）:
   - `docs/codex-tasks/r8-switch/README.md`: 段 6 の行の状態を「下書き PR #…（確認日 YYYY-MM-DD）。マージは利用者の指示」にする（PR 番号は作ってから）。
   - `docs/tax-simulator/deferred-items.md`: C-1 の末尾に段 6 の記録（確認日、27 件を effective、残りは 2027-01-01 の住民税 6 件と BD-R9）。
   - `docs/tax-simulator/r8-switch/golden-2026.md` 4 章の「結果の状態」の段落: ①は国保の代用だけで `partial`、④は `complete`、②は `complete`（施行後）。
2. コミットは段ごとに分ける（データと試験／まとめファイル／文書）。コミットの最後に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
3. `git push -u origin r8/stage6-enforce:r8/stage6-enforce`。
4. `gh pr create --draft`。題「段 6: 所得税の令和8年度改正の施行に合わせて記録を施行済みにする」。本文は `.tmp-pr-body.md` に Write で書いて `--body-file`。本文に書くこと: e-Gov で確かめた版と状態・施行日、公開画面の変化（単身などの結果から「施行前・概算」が消える、④は計算完了、①は国保の代用で一部概算のまま、配偶者特別控除などで住民税の令和9年度分の記録を使う結果は 2027-01-01 まで注記が残る）、金額は変わらないこと、試験とレビューの結果、マージは利用者の指示で行うこと。最後に `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
5. CI の結果を見張り、結果を報告に書く。
6. メモリの `handoff-c1-r8-switch.md` に段 6 の到達点を書く。

## 7. 止める・知らせる

1. 自動化を止める（1 章で済みだったとき、6 章まで終わったとき、2 章で 12/7 のとき、作業が途中で止まったとき）: `orca automations list --json` で名前「C-1 段6 施行確認と切替」の id を探し、`orca automations edit <id> --disabled`。Orca の CLI は `C:\Users\ko-ch\AppData\Local\Programs\orca\resources\bin\orca.exe`。
   - 2 章で未施行・確認できなかった日（12/7 より前）は止めない。
2. 利用者に知らせる。使えれば `PushNotification`（短く: 「段 6 の下書き PR #… ができました。マージはご指示で」など）。最後の報告にも同じことを書く。
3. **マージしない。** 本番への反映は、利用者の指示でマージした後に `/tools/simulator-status.json` で確かめる。
