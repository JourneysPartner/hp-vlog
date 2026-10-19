# 03n 照合の費用の削減（日次生成だけまとめて頼む・照合のモデルを分けて指定する）

## 背景（2026-10-17 の実測）

照合 1 回の費用を、実際の記録の `usage` から Opus 5.5 の料金（入力 $4・出力 $20・キャッシュ書込 $5・キャッシュ読み $0.20 / 100 万トークン、1 ドル 150 円）で計算した。

| 記事 | 照合 1 回 | 出力（抜き出し・判定の思考と答え） | キャッシュ書込（判定の資料表） | その他の入力 |
|---|---|---|---|---|
| #642 在庫評価（10/15） | 75 円 | 32 円 | 25 円 | 16 円 |
| #643 小規模宅地（10/15） | 90 円 | 27 円 | 53 円 | 10 円 |
| #644 贈与の非課税（10/15） | 133 円 | 67 円 | 45 円 | 19 円 |
| #680 生前贈与の現金（10/16 本番） | 82 円 | 38 円 | 28 円 | 14 円 |

記事を書く費用（1 本 45〜55 円）の 1.5〜2.5 倍。毛利さん「まだ高い」。

## 毛利さんの決定（2026-10-17）

1. **まとめて頼む方式（Message Batches API、全トークン半額）は日次生成の照合だけ**に使う。結果が数分〜最長 24 時間遅れるため、人が待つ照合（差し戻しの再生成・更新案・手動の照合ワークフロー）は今のまま即時に頼む。
2. 実 AI では **Sonnet 5.5 で照合する案だけ**を試す（候補を 4 件に絞る B9 は後回し）。試すには、照合のモデル設定が書き手の設定（Sonnet 5.5 は思考を切る）に引きずられない作りが要る。

見込み: Batch だけで日次の照合は約半額（#680 で 82→約 41 円）。Sonnet 5.5 を採れば、さらに約半分。

## N1 照合の呼び出し設定を書き手の設定から切り離す

- 今は `content-model.js` の `callAnthropic` が `toAnthropicRequest` → `anthropicModelOptions(model)` を必ず付ける。`claude-sonnet-5-5` には書き手用の `thinking: { type: 'between_tools' }`（思考を切る）と `output_config.effort: 'high'` が付くため、`FACT_CHECK_MODEL=claude-sonnet-5-5` にすると判定が思考なしで走ってしまう。
- `generateContent` の `opts.modelOptions`（オブジェクト）を新設する。渡されたときは `anthropicModelOptions(model)` の代わりにそれを使う。渡されないとき（書き手・差し戻し・補助の呼び出し）は今と同じ。OpenAI には使わない。
- 照合は常に `modelOptions` を渡す。中身は既定で `{}`（＝思考は adaptive、effort はモデルの既定）。変数 `FACT_CHECK_EFFORT` が `low`・`medium`・`high`・`xhigh`・`max` のいずれかなら `{ output_config: { effort } }`。それ以外の値（空は「指定なし」）は、モデル名が不正なときと同じく AI を呼ばずに `not_run`・要約「照合のモデル設定が不正です」（fail-closed）。
- **Opus 5.5 で `FACT_CHECK_EFFORT` が無いとき、抜き出し・判定・修正・再照合の各リクエスト本文は今と 1 バイトも変わらない**こと（試験で確かめる）。

## N2 抜き出しのモデルを分けて指定できるようにする

- 変数 `FACT_CHECK_EXTRACT_MODEL`（任意）: 抜き出し（`extract`・`recheck_extract`）のモデル。無ければ `FACT_CHECK_MODEL` と同じ。判定・再判定・修正は `FACT_CHECK_MODEL`。
- 検査は今のモデル名の検査と同じ（`anthropic` なら `claude-`、`openai` なら今の正規表現）。不正なら `not_run`・「照合のモデル設定が不正です」。
- 記録: `model` は今のまま（`FACT_CHECK_MODEL`）。`extract_model`（常に書く）と `effort`（指定なしは `null`）を足す。`calls` の各行に `model` を足す。
- 差分照合の使い回し（`checkArticle`）の条件に「前回の `extract_model`（無い古い記録は前回の `model` とみなす）と今回の抜き出しのモデルが同じ」「前回の `effort`（無ければ `null`）と今回が同じ」を足す。今の記録は、設定を変えなければ今どおり使い回せる。
- `LOGIC_VERSION` は `03l` のまま（判定の作りは変えない）。

## N3 日次生成の照合だけ Batch で頼む

### 入れる場所

- 変数 `FACT_CHECK_BATCH`（`true` のときだけ有効）。照合の提供元が `anthropic` のときだけ使い、`openai` では無視して今どおり。
- `.github/workflows/daily-draft.yml` の Generate draft の env に `FACT_CHECK_BATCH: ${{ vars.FACT_CHECK_BATCH || 'true' }}` と `FACT_CHECK_BATCH_MAX_WAIT_MINUTES: ${{ vars.FACT_CHECK_BATCH_MAX_WAIT_MINUTES }}` を足す（戻すときは GitHub の変数 `FACT_CHECK_BATCH=false`）。
- `regenerate-draft.yml`・`refresh-article.yml` には `FACT_CHECK_BATCH` を**足さない**（人が待つので即時）。
- `daily-draft.yml`・`regenerate-draft.yml`・`refresh-article.yml`・`fact-check.yml` の照合の env に `FACT_CHECK_EXTRACT_MODEL: ${{ vars.FACT_CHECK_EXTRACT_MODEL }}` と `FACT_CHECK_EFFORT: ${{ vars.FACT_CHECK_EFFORT }}` を足す（どの経路でも同じ設定で照合し、差分照合の使い回しが設定違いで外れないように）。
- `fact-check.yml`（手動の照合）に入力を足す: `model`（文字列・任意。空なら `vars.FACT_CHECK_MODEL`）、`extract_model`（文字列・任意。空なら `vars.FACT_CHECK_EXTRACT_MODEL`）、`batch`（真偽・既定 false）。env は `FACT_CHECK_MODEL: ${{ inputs.model || vars.FACT_CHECK_MODEL }}` の形にし、`run:` の中に入力を直接埋め込まない。

### 頼み方（`content-model.js` に足す。依存は増やさず、今と同じ `fetch` で書く）

- 1 回の AI 呼び出しを「1 件だけのバッチ」として出す。中身（`params`）は**同期で送る本文と同じもの**（`toAnthropicRequest` と N1 の `modelOptions` で作る。`cache_control` もそのまま）。
- 宛先と形（ヘッダーは同期と同じ `content-type`・`x-api-key`・`anthropic-version`）:
  - 作成: `POST https://api.anthropic.com/v1/messages/batches`、本文 `{"requests":[{"custom_id":"<id>","params":<同期の本文>}]}`。`custom_id` は英数字・`_`・`-` だけで 64 文字以内（例: `fc-judge-2`）。応答の `id` を控える。
  - 状態: `GET https://api.anthropic.com/v1/messages/batches/<id>`。`processing_status` が `in_progress`・`canceling`・`ended`。
  - 結果: `ended` になったら `GET https://api.anthropic.com/v1/messages/batches/<id>/results`。1 行 1 件の JSON（JSONL）。`{"custom_id":…,"result":{"type":"succeeded","message":{…}}}` の `message` は同期の応答と同じ形（`content`・`usage`・`stop_reason`・`stop_details`）。ほかの `type` は `errored`（`error` 付き）・`canceled`・`expired`。
  - 取り消し: `POST https://api.anthropic.com/v1/messages/batches/<id>/cancel`。
- `succeeded` は同期と同じ戻り値（`{ text, usage, provider, model, stopReason }`）にする。`stop_reason` が `refusal` なら同期と同じく例外（同期にやり直さない。同じ答えになるため）。`max_tokens` はそのまま返す（判定の半分に分ける既存の処理が働く）。ログは同期と同じ 1 行に `mode=batch` と待った秒数を足す。鍵は出さない。

### 待ち時間と、やり直し

- 変数 `FACT_CHECK_BATCH_MAX_WAIT_MINUTES`（既定 60）は **1 記事の照合全体**で待ってよい合計。状態の確認の間隔は `FACT_CHECK_BATCH_POLL_SECONDS`（既定 30、5 未満は 5）。
- 合計の待ち時間を使い切ったら、そのバッチを取り消し、最大 60 秒だけ `ended` を待つ。その間に `succeeded` が出ていればそれを使う（二重に払わない）。出ていなければ同じリクエストを同期で 1 回頼む（`mode: 'sync-fallback'`）。
- 作成・状態・結果の HTTP の失敗、通信の失敗、結果が読めない・`custom_id` が無い、`errored`・`expired`・こちらが取り消していない `canceled` のときも、同期で 1 回頼む（`mode: 'sync-fallback'`、記録に `batch_error`＝`safeDiagnostic` の短い診断）。
- 一度でも同期にやり直したら、その記事の残りの呼び出しはすべて同期（`mode: 'sync'`）。
- 照合の `call` は今 `cfg.timeoutMs`（既定 10 分）で打ち切っている。Batch のときの打ち切りは「残りの待ち時間＋作成・結果取得・取消後の確認の余裕250秒＋`cfg.timeoutMs`」にし、待っている間に打ち切られないようにする。打ち切りの合図（`signal`）が来たら確認をやめ、バッチを取り消す（失敗は無視）。
- 試験で実時間を待たないよう、時計と待ち（`sleep`）を差し替えられるようにする。

### 記録

- 記録の最上位に `batch`（真偽）。`calls` の各行に `mode`（`sync`・`batch`・`sync-fallback`）、Batch のときは `wait_seconds`（整数）、やり直しの理由があれば `batch_error`。バッチの id は記録に残さずログにだけ出す。
- 費用は記録から計算できればよい（コードに料金は持たない）。

## 試験（偽の fetch・偽の時計で。ネットワークは使わない）

新しい試験ファイル `scripts/lib/__tests__/test-fact-cost-03n.js` に書く。

1. Opus 5.5・`FACT_CHECK_EFFORT` なし: 抜き出し・判定・修正のリクエスト本文が、今のコード（`toAnthropicRequest` に `anthropicModelOptions` を付けた形）と一致する。
2. `FACT_CHECK_MODEL=claude-sonnet-5-5`: 照合の本文に `thinking` が無く `between_tools` が出ない。`FACT_CHECK_EFFORT=medium` なら `output_config.effort` が `medium`。書き手の `generateContent`（`modelOptions` なし）は今どおり `between_tools`。
3. `FACT_CHECK_EXTRACT_MODEL` を別にすると、抜き出し・再抜き出しだけそのモデル、判定・修正は `FACT_CHECK_MODEL`。記録の `extract_model`・`effort`・`calls[].model`。
4. `FACT_CHECK_EFFORT=fast`・不正な `FACT_CHECK_EXTRACT_MODEL` → AI を呼ばず `not_run`・「照合のモデル設定が不正です」。
5. 差分照合の使い回し: 抜き出しのモデルか effort が前回と違えば全体を照合。`extract_model` の無い古い記録で設定が同じなら今どおり差分で照合。
6. Batch の成功: 作成 → `in_progress` → `ended` → `succeeded`。戻り値が同期と同じ形、`usage` が記録に入る、`mode: 'batch'`、同期の呼び出しは 0 回。
7. Batch の待ち切れ: `in_progress` のまま合計の待ち時間を超える → 取り消し → 同期で 1 回（`sync-fallback`）→ 残りは `sync`。待った合計が上限を超えない。
8. 取り消しと完了が重なる: 取り消し後に `ended`・`succeeded` → その結果を使い、同期は呼ばない。
9. 失敗からのやり直し: 作成が HTTP 500・結果が `errored`・`expired`・JSONL が壊れている → それぞれ `sync-fallback` と `batch_error`。`batch_error` とログに鍵（`x-api-key` の値）が出ない。
10. `refusal` の結果 → 同期と同じく照合不能（`not_run`）で、同期にやり直さない。`max_tokens` の結果 → 判定を半分に分ける既存の処理が働く。
11. `FACT_CHECK_BATCH=true` でも提供元が `openai` なら同期。`FACT_CHECK_BATCH` が無い・`false` なら同期で、作成の宛先を呼ばない。
12. 打ち切り: Batch で待っている間は `cfg.timeoutMs` で打ち切られない。合図が来たら取り消しを呼ぶ。
13. ワークフロー: `daily-draft.yml` だけが `FACT_CHECK_BATCH` を持ち、既定が `true`。`regenerate-draft.yml`・`refresh-article.yml` は持たない。4 本とも `FACT_CHECK_EXTRACT_MODEL`・`FACT_CHECK_EFFORT` を持つ。`fact-check.yml` に入力 `model`・`extract_model`・`batch` があり、`run:` に入力を埋め込んでいない。

既存の試験（`test-fact-*.js`・`test-content-model-routing.js`・`test-env-resolution.js`・`test-workflow-change-detection.js` ほか）は通ったままにする。期待を変えた場合は理由を報告する。

## 変更してはいけないもの

- AI への指示文（抜き出し・判定・修正の system と instruction の文言）、候補の出し方（`searchEvidence`・1 主張 7 件）、資料表の作り（`fact-pages.js`）、`max_tokens` の値、`cache_control` の付け方。
- 止める範囲（案 2）、承認の差し止めの 3 経路、fail-closed、引用の実在確認、数字の歯止め、「答えの多くが確認を通らなければ照合不能で止める」、`reject_reason`、`LOGIC_VERSION`。
- 照合の既定のモデル（`claude-opus-5-5`）。書き手のモデルと呼び出し設定（`ANTHROPIC_MODEL_OPTIONS`）。
- `content/posts/*.md`・`data/`・`fixtures/`。

## 元に戻す方法

- Batch: GitHub の変数 `FACT_CHECK_BATCH=false`（日次も即時に戻る）。
- モデル: 変数 `FACT_CHECK_MODEL`・`FACT_CHECK_EXTRACT_MODEL`・`FACT_CHECK_EFFORT` を消す（Opus 5.5・既定の effort に戻る）。

## 受け入れ確認（Claude が行う）

1. 全テスト（前からの 4 本だけが落ちる）・`npm run validate`。
2. 実 AI（`fact-check.yml` を作業枝から手動実行、`code_ref` も作業枝）: #642〜#644 の下書き枝と main の #680 を `model=claude-sonnet-5-5`・`batch=true`・`repair=true` で照合する（Batch の形の確認を兼ねる。費用は 1 周約 90 円、ばらつきを見るためもう 1 周してよい）。
   - 合格の目安: 今の Opus が捕まえている既知の誤り（#644 の結婚・子育て資金の期限、配偶者控除の居住要件、#643 の措法69の4① の括弧書き、ほか 10/14〜15 の実測で捕まえたもの）を同じように捕まえる。#680 の正しい記述（特定贈与者ごとに累計 2,500 万円・一律 20%）を食い違い・資料なしで書き換えない。抜き出しで主張を落としていないか（Opus の記録と比べて主張の数・既知の誤りの文が抜き出されているか）。
   - 費用: 記録の `calls` から、Batch の半額を入れて 1 本の円を出し、Opus の実測と比べる。
3. 結果を毛利さんに報告し、日次の照合のモデル（Opus 5.5 のまま／Sonnet 5.5／抜き出しだけ Opus など）を決めてもらう。
