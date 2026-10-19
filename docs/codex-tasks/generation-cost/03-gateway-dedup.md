# 03 Vercel AI Gateway で本文の生成を DeepSeek V4.1 Flash（1017）、重複確認を GLM-5.3 Flash に替える

## 背景と決定（2026-10-19）

- **本文の生成**（差し戻しの再生成・短縮・ルールの部分修正・論点語・狙う検索語など `content-model.js` を通るものすべて）を、毛利さんの決定で **DeepSeek V4.1 Flash（Vercel AI Gateway の `deepseek/deepseek-v4.1-flash-1017`）** に替える。費用を優先し、誤りは事実照合（Opus 5.5、変えない）で捕まえる前提。差し戻しの再生成は本文の生成と同じモデルにそろえる（毛利さんの指示）。
  - Claude の試験（10/16・10/19 と同じ入力、本番の照合をかけた）: 本文は 6,136 字・5,308 字で 1 回で上限内（Sonnet 5.5 は 7,371・7,760 字で作り直し）。本文の費用は 1 本約 1 円（Sonnet 5.5 は約 45 円）。照合で見つかった誤りは 1 件（10/19「相続時精算課税は 110 万円以下でも申告が必要」。令和6年以後は不要）。1 回の生成に 2〜7 分かかる（考える分が多い）。
- **話題の重複確認**（`ai-dedup.js` → `aux-model.js`、今は Claude Haiku 4.5）を **GLM-5.3 Flash（`zai/glm-5.3-flash`）** に替える。
  - Claude の試験（重複 3 件・重複でない 8 件）: 重複 3 件はどのモデルも見つけた。重複でない 8 件の誤判定は Haiku 4.5 が 7 件（決定論的なガードで 1 件）、GLM-5.3 Flash が 2 件（ガードで 0 件）。1 回の費用は Haiku 4.5 約 3 円、GLM 約 0.4 円。
- どちらも Anthropic の API には無いので、**Vercel AI Gateway**（OpenAI 互換の API）で呼ぶ。鍵は GitHub の Secret `AI_GATEWAY_API_KEY`。どちらのモデルも画像を読める（Gateway のモデル一覧の `vision`）。
- 補助モデル（`aux-model.js`）を実際に使っているのは重複確認だけ（差し戻しの分類・題名の整え・軽い校正の関数はどこからも呼ばれていない）。
- 事実照合（Opus 5.5・Anthropic・03n の Batch）は変えない。

## R0 本文の生成の失敗を取り下げとして記録しない（01・02 のレビューでの指摘）

- 02 の R6 で、本文の生成の失敗を `recorder.record(topic, 'generation-failed', …)` で記録するようにした。この記録は `data/withdrawn-topics.json` に入り、`findWithdrawnTopic` は段階を見ずに除外するので、**API の利用上限・一時的な障害だけでその話題が二度と選ばれなくなる**（2026-10-19 に実際に Anthropic の利用上限に達した）。
- 本文の生成の失敗は取り下げとして記録しない。その日の試行の記録（`attempts` と通知の理由）にだけ残す。
- 失敗が API の呼び出しの失敗（認証・利用上限・429・5xx・通信・時間切れ）のときは、次の候補を試さずにその日の生成を終える（候補を無駄に消費しない）。理由は「本文生成モデルの呼び出しに失敗（<短い診断>）」として、今の 0 本の通知に載せる。
- すでに `generation-failed` で記録された項目が除外に使われないよう、`findWithdrawnTopic`・`findWithdrawnQuery` は `generation-failed` の段階を無視する（今の記録には無いが、念のため）。

## R7 Vercel AI Gateway の汎用の呼び出し

- 新しいモジュール（例 `scripts/lib/gateway-model.js`）に `callGateway({ model, system, user, figures, maxTokens, task, signal, timeoutMs })` を作る。
  - `POST https://ai-gateway.vercel.sh/v1/chat/completions`、ヘッダー `content-type: application/json`・`authorization: Bearer <AI_GATEWAY_API_KEY>`、本文 `{ model, max_tokens, messages: [{ role: 'system', content: system }, { role: 'user', content: <user> }] }`。
  - 図（`figures`、`{ media_type, data(base64) }`）があるときは、user の content を配列にして、今の `toOpenAIMessages` と同じく図ごとに説明の文字列と `{ type: 'image_url', image_url: { url: 'data:<media_type>;base64,<data>' } }` を並べ、最後に本文の文字列を置く。
  - 応答 `choices[0].message.content`（文字列）を本文として返す。`finish_reason` が `length` なら `stopReason: 'max_tokens'`、それ以外は `end_turn`。戻り値は今の `callAnthropic` と同じ形（`{ text, usage: { input_tokens, output_tokens }, provider: 'gateway', model, stopReason }`）。
  - 使用量をログに 1 行出す: `[gateway] model=<名前> task=<用途> usage(in=<prompt_tokens> out=<completion_tokens> reasoning=<completion_tokens_details.reasoning_tokens> cached=<prompt_tokens_details.cached_tokens>) finish=<finish_reason>`。
  - 429・5xx・通信の失敗は 2 回まで待って再試行（15 秒・30 秒）。それ以外の失敗は例外（鍵を伏せる。`safeDiagnostic` の考え方）。鍵が無いときは呼ばずに例外。
  - 時間切れは呼び出し側が渡す（既定 5 分）。

## R8 重複確認を Gateway で呼べるようにする

- `aux-model.js` の提供元に `gateway` を足す（`AUX_MODEL_PROVIDER=gateway`、モデル名は `AUX_MODEL`）。`gateway` のときは `callGateway` を使う。
- 出力の上限: 考える分も上限に入るので、`gateway` のときは呼び出し側の値（400・300）ではなく 8,000 にする（試験の実測は出力 125〜740 トークン）。`finish_reason` が `length` のときは今の「答えが読めない」と同じ扱い。
- 呼ばれていない補助の関数（差し戻しの分類・題名の整え・軽い校正）は消してよい（消した場合は最終報告に書く）。

## R9 本文の生成（`content-model.js` を通るものすべて）を Gateway で呼べるようにする

- `CONTENT_MODEL_PROVIDER=gateway` のとき、`generateContent` と `generateSimple` は `callGateway`（モデル名は `CONTENT_MODEL`）を使う。system は `staticSystem` と `dynamicSystem` の空でないものを空行でつなぐ。図はそのまま渡す。`cache_control` は送らない（Gateway 側の自動キャッシュに任せる）。
- 出力の上限: 考える分が多いので、`gateway` のときの `max_tokens` は、本文の生成（`generateContent`）が 64,000、`generateSimple` は `max(呼び出し側の値, 16,000)`。本文の長さは出力の上限ではなく、字数の指示と 01 の R2（超過分だけ短くする）で抑える。
- 時間切れ: 本文の生成 15 分、`generateSimple` 5 分（試験の実測は本文 2〜7 分）。
- 字数の補正（01 の R1 の表）に `deepseek/deepseek-v4.1-flash-1017` を足す。値は 1.11（今の既定。この指示で 5,308・6,136 字を書いた実測をコメントに書く）。`TOKEN_ESTIMATES_BY_MODEL` は `gateway` では使わない（上の固定の上限を使う）。
- 失敗したときの予備は無い（02 の R6）。日次は R0 のとおり、その日の生成を終えて通知する。差し戻しは今の失敗の通知。
- `generate-draft.js` の「本文生成: content-model 経由 provider=… model=…」のログに `gateway` が出ること、鍵の有無の判定（今は `ANTHROPIC_API_KEY`）が `gateway` では `AI_GATEWAY_API_KEY` を見ること。
- `anthropicModelOptions`（Sonnet 5.5 の思考オフ）は `anthropic` のときだけ使う。

## R10 ワークフローと切り替え

- `daily-draft.yml`・`regenerate-draft.yml`・`refresh-article.yml` の生成の env に `AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}` を足す。`CONTENT_MODEL_PROVIDER`・`CONTENT_MODEL`・`AUX_MODEL_PROVIDER`・`AUX_MODEL` は今どおり GitHub の変数から読む（コードの既定値は変えない）。
- 切り替え（マージ後に Claude か毛利さんが行う）: GitHub の変数 `CONTENT_MODEL_PROVIDER=gateway`・`CONTENT_MODEL=deepseek/deepseek-v4.1-flash-1017`・`AUX_MODEL_PROVIDER=gateway`・`AUX_MODEL=zai/glm-5.3-flash`。
- 元に戻す: 変数を `anthropic`・`claude-sonnet-5-5`・`anthropic`・`claude-haiku-4-5-20251001` に戻す。

## 試験（偽の fetch で。ネットワークは使わない）

`scripts/lib/__tests__/test-gateway-model.js` に書く。

1. `callGateway` の宛先・ヘッダー・本文の形（図あり・なし）。応答の本文と `stopReason`、使用量のログ（鍵が出ない）。
2. 429・500・通信の失敗で 2 回まで再試行、3 回目で例外。400 は再試行しない。鍵が無ければ呼ばない。時間切れ。
3. `AUX_MODEL_PROVIDER=gateway` で重複確認が `callGateway` を `AUX_MODEL` と上限 8,000 で呼ぶ。`finish_reason=length` は答えが読めない扱い。`anthropic` のときは今どおり。
4. `CONTENT_MODEL_PROVIDER=gateway` で `generateContent`（上限 64,000・時間切れ 15 分・system のつなぎ方・図）と `generateSimple`（上限 `max(値, 16000)`）が `callGateway` を `CONTENT_MODEL` で呼ぶ。`cache_control`・`thinking` を送らない。`anthropic` のときは今どおり（本文が 1 バイトも変わらない）。
5. 字数の補正の表に DeepSeek があり 1.11。
6. R0: 本文の生成の失敗で取り下げの記録が増えない。API の失敗なら次の候補を試さずに終わり、理由が通知に載る。`generation-failed` の段階の記録は除外に使われない。
7. ワークフローに `AI_GATEWAY_API_KEY` が Secret から渡り、`run:` に埋め込まれていない。

既存の試験は通ったままにする。期待を変えた場合は理由を報告する。

## 変更してはいけないもの

- 事実照合（`fact-check.js`・03n、Opus 5.5・Anthropic）。承認の差し止め。
- 重複確認・本文の生成の指示文、01 で決めた流れ（1 回の生成・短縮・部分修正・生成前の重複確認）。
- `content/posts/*.md`・`data/`。
