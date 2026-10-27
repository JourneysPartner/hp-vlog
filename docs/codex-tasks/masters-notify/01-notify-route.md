# 01 鮮度の通知を notify.js の経路で送り、試験の失敗と切り離す

背景は `README.md`。

## 実装要件

### R1 通知の文面: 新しいイベント `master_freshness`（`netlify/functions/lib/notify/message.js`）

- `buildMessage('master_freshness', { title, summary, prUrl })` を足す。書き方は `freshness_candidates` に合わせる（空行が 2 つ続かないようにする処理も同じ）。
  - 件名: `【税シミュレーター】マスターの確認が必要です`
  - 本文: 
    1. `税シミュレーターのマスター鮮度チェックで、確認が必要な項目が見つかりました。`
    2. 空行
    3. `summary`
    4. 空行
    5. `prUrl` があれば `▶ 実行結果（全文）: <prUrl>`
    6. 空行
    7. `マスターの値はまだ変更していません。出典の原文を読み、見直しが要るか確認してください。`
- ファイル冒頭の「イベント種別」の一覧に 1 行足す。
- 試験（`scripts/lib/__tests__/test-notify-message.js`）に足す: 件名、`summary` と URL が本文に入ること、`prUrl` が無いときに URL の行が出ないこと、空行が 2 つ続かないこと。

### R2 通知用の短い要約（`scripts/check-master-freshness.js`）

- `buildNotifySummary(result)` を足して `module.exports` に加える。`check()` の戻り値から、次の順に組み立てた文字列を返す。
  1. 件数の行（0 件の行は出さない）:
     - `出典の改訂: N 件（出典 M 枚）`（`hashMismatch` の件数と、`source_document_id` の種類数）
     - `対象期間のレコード無し: N 件`（`coverageGap`）
     - `次の期間が未登録（予告）: N 件`（`coverageUpcoming`）
     - `出典が取得できない: N 件`（`sourceMissing`）
     - `台帳に無い出典: N 件`（`sourceUnknown`）
     - `source_hash 未記録: N 件`（`hashUntracked`）
     - `確認待ち(blocked): N 件`、`未承認: N 件`
  2. 出典の改訂があれば、空行のあと `■ 改訂された出典` と、出典ごとに 1 行 `・<label>（<件数> 件）`。件数の多い順、同数は `label` の順。**最大 15 行**。超えた分は `・ほか K 枚` の 1 行にまとめる。
  3. 対象期間のレコード無しがあれば、空行のあと `■ 対象期間のレコード無し` と、1 行ずつ `・<label>: <period>（<state>）`。最大 10 行、超えた分は `・ほか K 件`。
  4. 出典が取得できないものがあれば、空行のあと `■ 出典が取得できない` と、1 行ずつ `・<label>`（最大 10 行、超えた分は `・ほか K 件`）。
- 全体が **1,500 文字を超えたら**、1,500 文字以内に収まるところで行の切れ目で切り、最後に `（以下略。全文は実行結果を参照）` を付ける。
- 要確認が 0 件なら空文字を返す。
- `main()` で、`GITHUB_OUTPUT` があるときに `notify_summary<<NOTIFY_EOF` … `NOTIFY_EOF` の形で書き出す（既存の `report` と同じ書き方）。既存の出力項目と順番は変えない。

### R3 ワークフロー（`.github/workflows/check-tax-simulator-masters.yml`）

段の名前・順番・`run:` の中身は、ここに書いたもの以外は変えない。

- `Validate master data`: `id: validate` を付け、`if: ${{ !cancelled() }}` にする（入力型の検査が落ちても、マスターの形の検査と鮮度チェックは動かす）。
- `Check master freshness`: `if: ${{ !cancelled() && steps.validate.outcome == 'success' }}` を付ける（試験が落ちても動く。マスターの形が壊れていたら動かない）。`continue-on-error: true` はそのまま。
- `Comment on PR`: `if: ${{ !cancelled() && github.event_name == 'pull_request' && steps.check.outputs.needs_attention != '' }}`（鮮度チェックが出力を書かなかったときは空のコメントを出さない）。
- `Notify Chatwork` の段を、次の `Notify` の段に置き換える（Chatwork の API を直接呼ぶ処理と `CHATWORK_*` の参照をこのワークフローから無くす）:
  - `if: ${{ !cancelled() && github.event_name != 'pull_request' && steps.check.outputs.needs_attention != '' && steps.check.outputs.needs_attention != '0' }}`
  - `env:` に `NETLIFY_NOTIFY_URL: ${{ vars.NETLIFY_NOTIFY_URL }}`、`NOTIFY_WEBHOOK_SECRET: ${{ secrets.NOTIFY_WEBHOOK_SECRET }}`、`NOTIFY_SUMMARY: ${{ steps.check.outputs.notify_summary }}`、`RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`
  - `run:` は `node scripts/notify.js --event master_freshness --title "税シミュレーターのマスター鮮度チェック" --summary "$NOTIFY_SUMMARY" --pr-url "$RUN_URL" || echo "::warning::通知に失敗しました（処理は継続）"`（`check-tax-reform.yml` の `Notify` と同じ形）
- `Emit job summary`: そのまま（`if: always()`）。
- `Fail if sources are unreachable`: `if: ${{ !cancelled() && steps.check.outcome == 'failure' }}`（試験が落ちたときも、出典が取れない旨を出す）。
- 冒頭のコメントの「通知」の説明を、新しい経路（`scripts/notify.js` → Netlify）に合わせて 1〜2 行直す。
- `on.pull_request.paths` に足す: `'scripts/lib/**'`、`'scripts/update-gsc-topics.js'`、`'scripts/notify.js'`、`'netlify/functions/lib/notify/**'`、`'data/gsc-topics.json'`、`'data/query-synonyms.json'`、`'docs/codex-tasks/weekly-signal-fixes/*.json'`。既存の行は残す（`scripts/lib/__tests__/**` は `scripts/lib/**` に含まれるが、消さなくてよい）。

### R4 ワークフローの試験 `scripts/lib/__tests__/test-masters-workflow.js`（新規）

`js-yaml` で `check-tax-simulator-masters.yml` を読み、次を確かめる（他の試験と同じ `✓`/`✗` と `N passed, M failed`）。

- R3 の各段の `if` が上のとおりであること（文字列の完全一致でよい。空白の違いは正規化してよい）。
- `Check master freshness` に `continue-on-error: true` があること。
- ワークフローのどこにも `CHATWORK_API_TOKEN`・`CHATWORK_ROOM_ID`・`api.chatwork.com` が無いこと。
- `Notify` の段: `run:` に `${{` が無いこと、`scripts/notify.js` と `--event master_freshness` を含むこと、`env` の 4 項目が上のとおりであること。
- 段の順番: `Run master tests` → `Check master freshness` → `Comment on PR` → `Notify` → `Emit job summary` → `Fail if sources are unreachable`。
- `paths` に R3 で足した 7 行と、既存の行がすべてあること。

### R5 要約の試験（`scripts/lib/__tests__/test-check-master-freshness.js` に試験 8 を足す）

`check()` の戻り値の形をした架空のオブジェクトで `buildNotifySummary()` を確かめる。

- 件数の行が出る。0 件の行は出ない。
- 同じ出典の改訂がまとめられ、件数の多い順に並ぶ。
- 出典が 16 枚以上なら 15 行＋`・ほか K 枚`。
- 1,500 文字を超える入力で、1,500 文字以内に切られ、最後が `（以下略。全文は実行結果を参照）`。
- 要確認が 0 件なら空文字。
- 実データ（`check('2026-10-27')`）でも 1,500 文字以内で、`出典の改訂: 148 件（出典 30 枚）` を含む（件数は実データで変わりうるので、この項目は「`出典の改訂:` の行がある」「1,500 文字以内」だけを合否にし、件数は参考として表示する）。

### R6 `masters:test` への登録

- `package.json` の `masters:test` の最後に `scripts/lib/__tests__/test-notify-message.js` と `scripts/lib/__tests__/test-masters-workflow.js` を足す（`test-notify-message.js` はどの CI にも登録されていなかった）。既存の一覧と順番は変えない。

## テスト

```
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-masters-workflow.js
node scripts/lib/__tests__/test-check-master-freshness.js
node scripts/lib/__tests__/test-workflow-run-injection.js
node scripts/lib/__tests__/test-workflow-change-detection.js
node scripts/lib/__tests__/test-run-test-files.js
npm run masters:test
```

## 変更してはいけないもの

- README の「全段階共通の厳守事項」のとおり。
