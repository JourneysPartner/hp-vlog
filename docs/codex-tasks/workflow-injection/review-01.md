# 01 の差分レビュー（Opus 5.5 xhigh、2026-10-20）

対象: e0ebeaa6（55c74c71..e0ebeaa6）。結論: **軽微を直せばマージ可**。Critical・High なし。

## 直すもの（02）

| # | 内容 | 直し方 |
|---|---|---|
| M1 | 見張りの試験（`test-workflow-run-injection.js` の `dangerousExpression`）が、`${{` の直後の語しか見ていない。`${{ env.PREP_TITLE1 }}`・`${{ format('{0}', steps.prep.outputs.title1) }}`・`${{ toJSON(github.event) }}`・`${{ fromJSON(steps.x.outputs.y).z }}`・`${{ steps.prep.outputs['title1'] }}`・`${{ github['event']['inputs']['year'] }}`・`${{ Steps.prep.outputs.title1 }}`（大文字）・`${{ github.event_name == 'x' && github.event.inputs.year || '' }}`・`${{ github.ref_name }}` を見逃す。今のワークフローに 0 件なので将来の穴 | 「許すものだけ通す」方式にする: `run:`・`script:` の中の `${{ … }}` は、中身（前後の空白を除く）が `github.server_url`・`github.repository`・`github.run_id`・`github.run_number`・`github.workflow`・`job.status`・`runner.temp`・`runner.os`・`secrets.<名前>`・`vars.<名前>`・`steps.<id>.outcome`・`steps.<id>.conclusion` のどれかに**完全に一致**するときだけ許す（大文字小文字を区別しない）。上の見逃した形をすべて「落ちる例」として試験に足す |
| L7 | `check-tax-simulator-masters.yml` の PR 番号の変数名 `GITHUB_EVENT_NUMBER` は、GitHub が自分用に使う `GITHUB_` で始まる | `PR_NUMBER` に変える |

## 記録するもの（直さない）

| # | 内容 | 理由 |
|---|---|---|
| L2 | 見張りの試験が CI で自動では動かない（`pull_request` で動くのは `check-tax-simulator-masters.yml` だけで、`.github/workflows/**` の変更では起動しない） | 全テストの CI が無いのは前からの作り。ワークフローを変える PR の受け入れ確認で Claude が流す。CI を足すかは別の判断 |
| L3 | `check-tax-simulator-masters.yml` で `as_of` を間違えると、形の確認の手順に `continue-on-error: true` があるため、集計が空欄で書かれ、最後の手順が「出典が取得できていません」という別の理由で落ちる | 間違った値はコマンドに渡らず、ジョブは失敗で終わる（止める側）。直すには手順の追加が要る（今回の範囲外） |
| L4 | 報告文 `CHECK_REPORT` を env に入れたため、1 つの値が約 128KB を超えると手順が起動できない（今の報告文は約 44KB、全件が該当すると約 180KB の見込み） | その大きさでは前からの別の上限（Chatwork 通知の env・PR コメントの 65,536 字）にも当たる。直すなら点検のスクリプトに報告文をファイルへ書かせる |
| L5 | `crawl-nta-sources.yml` の `log_tail` を、終わりの目印を `EOF` に固定して `$GITHUB_OUTPUT` に書いている（以前から）。記録に `EOF` だけの行があると値が切れる | `log_tail` を使う所は無い。次にこのワークフローを触るときに削る |
| L6 | `only` で空白を拒むようになった（`minpo, koseki` はエラー。前は空白で分かれ `koseki` が黙って無視されていた） | 安全側の変化 |
