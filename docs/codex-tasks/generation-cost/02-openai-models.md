# 02 GPT は最新の Luna を自動で選ぶ・使用量をログに出す・GPT-5.4 の予備を撤去する

README の「毛利さんの決定」4・5 を実装する。

## R5 最新の Luna を OpenAI のモデル一覧から自動で選ぶ

- 新しいモジュール（例 `scripts/lib/openai-models.js`）に `resolveLunaModel()` を作る。
  1. 変数 `OPENAI_LUNA_MODEL` が空でなければ、その名前を使う（緊急時の固定）。
  2. 無ければ `GET https://api.openai.com/v1/models`（ヘッダー `Authorization: Bearer <OPENAI_API_KEY>`）。応答は `{ "data": [ { "id": "..." }, ... ] }`。
  3. `id` が **`gpt-<数字>-luna` または `gpt-<数字>.<数字>-luna` に完全一致**するものだけを候補にする（`-batch`・`-fast`・`-mini`・日付つきなど、後ろに何か付くものは除く）。版（主・副）の大きいものを選ぶ。
  4. 一覧を読めない（鍵が無い・HTTP の失敗・15 秒で時間切れ・候補が無い）ときは、既定値 `gpt-6-luna`（コードの定数。新しいモデルの確認後に人が更新する）を使い、警告を 1 行出す。
  5. 1 回の実行で一度だけ問い合わせ、結果を覚えておく。選んだ名前と理由を 1 行ログに出す（例 `[openai-model] Luna: gpt-6-luna（一覧から自動選択）`／`（変数で固定）`／`（一覧を読めず既定値）`）。鍵は出さない。
- これを使う箇所（今は別々の変数）:
  - 出典の選定 `makeOpenAILuna`（`LLM_SOURCE_SELECT_MODEL`、既定 `gpt-5.6-luna`。日次は変数で `gpt-6-luna`）
  - 検索候補の話題集め `update-suggest-topics.js`（`LLM_SUGGEST_MODEL`）
  - Search Console の話題集め `update-gsc-topics.js`（`LLM_GSC_MODEL`）
  - 質疑応答の選別 `triage-shitsugi-topics.js`（`LLM_TRIAGE_MODEL`）
  - ほかに OpenAI の Luna を呼んでいる箇所があれば同じにする（最終報告に一覧）
- 上の 4 つの変数はコードとワークフローから外し、OpenAI を使うワークフロー（`daily-draft.yml`・`update-suggest-topics.yml`・`fetch-search-console.yml`・`triage-shitsugi.yml` ほか）に `OPENAI_LUNA_MODEL: ${{ vars.OPENAI_LUNA_MODEL }}` を足す。`makeOpenAILuna` は今は同期で callLLM を返すので、最初の呼び出しのときにモデルを決める形にする。
- **使用量のログ**: Luna の呼び出しごとに `[openai] model=<名前> task=<用途> usage(in=<入力> out=<出力> cached=<キャッシュ読み>)` を 1 行出す（`completion.usage` の `prompt_tokens`・`completion_tokens`・`prompt_tokens_details.cached_tokens`）。用途は `source_select`・`suggest`・`gsc`・`triage` など。
- 注意: 新しい Luna が出ると、試さないまま切り替わる（毛利さんの決定。危険は承知のうえ）。応答の形が変わって読めないときは、今の各処理の「読めなければ使わない」動き（出典は従来の決め方のまま、など）のまま止める側に倒れることを確かめる。

## R6 GPT-5.4 の予備を撤去する

- `content-model.js`: `generateContent`・`generateSimple` で、Anthropic が失敗したときに OpenAI（`OPENAI_MODEL`、既定 `gpt-5.4`）で生成し直す予備をやめ、失敗をそのまま返す。`CONTENT_MODEL_PROVIDER` が無いときの既定を `openai` から `anthropic` にする。本文の生成の提供元に `openai` を指定する経路（`gpt-5.4` を使うもの）も外す。
  - 事実照合の `FACT_CHECK_PROVIDER=openai`（03n。`FACT_CHECK_MODEL` で明示したモデルだけを使う）は残す。
- `aux-model.js`: 提供元 `openai`（`OPENAI_MODEL`・`gpt-5.4` を使う）を外し、`anthropic` と `rule_based` だけにする。
- `generate-draft.js`: `OPENAI_MODEL`・`OPENAI_MODEL_HIGH`・`gpt-5.4` を使う箇所（本文の生成・差し戻しの再生成の OpenAI の経路、`--high-quality` など）を外す。日次の入力 `high_quality`（説明は「Opus 4.6 で高品質生成」）が何を切り替えているかを確かめ、`gpt-5.4` にしか効かないなら入力ごと外す（最終報告に書く）。
- ワークフロー（`daily-draft.yml`・`regenerate-draft.yml`・`refresh-article.yml` ほか）から `OPENAI_MODEL`・`OPENAI_MODEL_HIGH` を外す。`OPENAI_API_KEY` は Luna に要るので残す。
- Anthropic が失敗したときは、日次は今の「生成できなかった」の扱い（取り下げ・0 本の通知など）、差し戻しは今の失敗の通知（`regenerate_failed`）になることを確かめる。

## 試験（偽の fetch・偽の SDK で。ネットワークは使わない）

新しい試験ファイル `scripts/lib/__tests__/test-openai-models.js` に書く。

1. 一覧に `gpt-5.6-luna`・`gpt-6-luna`・`gpt-6-luna-batch`・`gpt-6-luna-2026-09-01`・`gpt-6-mini`・`gpt-6.1-luna-fast` があるとき `gpt-6-luna` を選ぶ。`gpt-6.1-luna` が加われば `gpt-6.1-luna`。`gpt-10-luna` は `gpt-9.5-luna` より新しい（数字で比べる）。
2. `OPENAI_LUNA_MODEL` があれば一覧を呼ばずにそれを使う。
3. 一覧が HTTP 500・時間切れ・候補なし・鍵なし → `gpt-6-luna` と警告。鍵がログ・警告に出ない。
4. 1 回の実行で一覧の問い合わせは 1 回。
5. 出典の選定・検索候補・Search Console・質疑応答の選別が、選んだモデル名で呼ぶ。使用量のログが出る。
6. 本文の生成・`generateSimple` で Anthropic が失敗 → OpenAI を呼ばずに失敗を返す。`CONTENT_MODEL_PROVIDER` が無いとき `anthropic`。`aux-model` に `openai` の経路が無い。
7. ワークフロー: `OPENAI_MODEL`・`LLM_SOURCE_SELECT_MODEL`・`LLM_SUGGEST_MODEL`・`LLM_GSC_MODEL`・`LLM_TRIAGE_MODEL` がどこにも無く、OpenAI を使うワークフローに `OPENAI_LUNA_MODEL` がある。

既存の試験（`test-content-model-routing.js`・`test-env-resolution.js`・`test-llm-source-*`・`test-gsc-topics.js`・`test-fact-cost-03n.js` ほか）は通ったままにする。予備の撤去で期待を変えた場合は理由を報告する。

## 変更してはいけないもの

- 事実照合（03n の `FACT_CHECK_PROVIDER`・`FACT_CHECK_MODEL`・Batch を含む）。
- 書き手のモデル（`CONTENT_MODEL`）、重複確認のモデル（`AUX_MODEL`）。
- 出典の選定・話題集めの指示文と、答えが読めないときの扱い。
