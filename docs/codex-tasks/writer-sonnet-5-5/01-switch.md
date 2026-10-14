# 01 書き手の AI を Sonnet 5.5 に替える

背景と方針は `README.md`。ここは実装の要件。

## 要件

### R1 モデル別に送る項目を足す

- `scripts/lib/content-model.js`（または `article-prompt-builder.js`）に、モデル ID から Anthropic への
  追加項目を返す小さな関数を 1 つ作り、export する（名前は任意。例 `anthropicModelOptions(model)`）。
  - `claude-sonnet-5-5`（完全一致）→ `{ thinking: { type: 'between_tools' }, output_config: { effort: 'high' } }`
  - それ以外 → `{}`（Sonnet 4.6・Opus 5.5 などには何も足さない。`between_tools` は Sonnet 5.5 以外で 400）
  - 表はモデル ID をキーにした 1 か所の定数にし、なぜ必要かを 2〜3 行の注記で書く（考える分が max_tokens を食う・
    `disabled` は 400・他モデルには送れない）。
- この追加項目を、`toAnthropicRequest` の戻り（本文生成）と `generateSimple` の Anthropic 用リクエストの両方に入れる。
- `system`・`messages`・`cache_control` の付け方は変えない。

### R2 応答の読み方

- `callAnthropic` と `generateSimple`（Anthropic 側）で、`data.stop_reason === 'refusal'` のときは
  `throw new Error('Anthropic refusal' + (分類があれば ` (${data.stop_details.category})`))`。
  既存の catch → OpenAI への切り替えに乗る。本文や `explanation` はログに出さない。
- 両方とも戻り値に `stopReason: data.stop_reason || null` を足す。`callOpenAI` も
  `stopReason: (choice && choice.finish_reason) || null` を足す（`generate-draft.js` が
  `'max_tokens'` / `'length'` を見て「末尾途切れの疑い」を出す。今は値が来ないので効いていない）。
- 本文の取り出しは `type === 'text'` のブロックだけにそろえる（`generateSimple` は今 `b.text || ''`。
  考える工程のブロックは `type: 'thinking'` で返る）。
- `callAnthropic` の既存の usage ログ 1 行に `stop=${data.stop_reason}` を足す。`generateSimple` の Anthropic 側にも、
  同じ形の usage ログ（provider・model・in/out・stop。本文は出さない）を 1 行足す。初回実行で比を測るのに使う。

### R3 出力の上限をモデル別の比で計る

- `scripts/lib/article-prompt-static.js` の `TOKENS_PER_CHAR` / `FRONTMATTER_TOKENS` をモデル別にする。
  - 既定（`claude-sonnet-4-6`・OpenAI・未知のモデル）: 今の値のまま（0.8739 / 700）。
  - `claude-sonnet-5-5`: **仮置き** 1.14 / 910（4.6 の 1.3 倍。新しいトークナイザで約 3 割増えるため）。
    注記に「仮置き。初回の実行記録から測り直す」と日付（2026-10-13）を書く。
- `maxTokensFor(articleTypeOrOpts)` は、オブジェクトで呼ばれたとき `opts.model` を受け取る。
  `model` が無いときは、今の本文生成のモデル（`content-model` の `resolveModel(resolveProvider())`）を使う。
  - 文字列で呼ぶ形（`maxTokensFor('edge_case')`）も同じく今のモデルで計る。
  - 循環 require にならないこと（`content-model` は `article-prompt-builder` を関数の中で require している。
    `article-prompt-static` から `content-model` を読むなら関数の中で）。
  - `resolveProvider()` は鍵が無いと警告を出すので、1 回の `maxTokensFor` で何度も出さないこと。
  - 環境変数が無い（＝テスト）とき・`claude-sonnet-4-6` のときは、今と**同じ値**を返すこと。
- `scripts/generate-draft.js` は**変更しない**（保留中の PR #670 と衝突させないため）。呼び出し側はそのままで、
  `maxTokensFor` の中でモデルを解決する。

### R4 既定モデルと説明の更新

- `content-model.js` の `ANTHROPIC_DEFAULT_MODEL` を `'claude-sonnet-5-5'` に。同ファイル冒頭・`resolveModel` 付近の
  注記の `claude-sonnet-4-6` も合わせる。
- 説明文の「Sonnet 4.6」を「Sonnet 5.5」に（モデル名だけ。過去の実測の記録＝「2026-08-15 実測（Claude Sonnet 4.6）」
  のような履歴は残す）:
  `article-prompt-builder.js` 冒頭、`article-prompt-static.js` 冒頭、`aux-task-routing.js` の content_model の
  `impl` / `note`（テストが文字列を見ていないか確認）、`docs/aux-api-comparison.md`（本文生成の確定モデル・料金 $2/$10・
  環境変数の例）、`.github/workflows/daily-draft.yml` と `regenerate-draft.yml` の**コメント行だけ**。
- `scripts/propose-topics.js` の固定 `'claude-sonnet-4-6'` は**変えない**（どのワークフローからも呼ばれていない。
  報告にだけ書く）。

## テスト

既存のテストの書き方（`scripts/lib/__tests__/test-content-model-routing.js`・`test-prompt-builder.js` の fetch の差し替え方）に合わせる。

1. `toAnthropicRequest(ir, { model: 'claude-sonnet-5-5', … })` に `thinking.type === 'between_tools'` と
   `output_config.effort === 'high'` があり、`thinking` の中にほかの項目が無い。
2. 同じく `claude-sonnet-4-6` と `claude-opus-5-5` では `thinking` も `output_config` も無い。
3. `generateSimple` を `claude-sonnet-5-5` で呼ぶと、送ったリクエストに 1 と同じ項目がある。`claude-sonnet-4-6` では無い。
4. 応答が `stop_reason: 'refusal'` のとき、`generateContent` と `generateSimple` が OpenAI 側に切り替わる
   （OpenAI 呼び出しは差し替えで確認。実際の API は呼ばない）。
5. 応答の先頭に `{ type: 'thinking', thinking: '' }` があっても、本文は `text` ブロックだけになる。
6. `stopReason` が Anthropic（`max_tokens` を返す差し替え）でも OpenAI（`finish_reason: 'length'`）でも返る。
7. `maxTokensFor`: 環境変数なしで今と同じ値（既存テストのまま通る）。`{ …, model: 'claude-sonnet-5-5' }` は
   4.6 より大きく、7,000 字上限の型で 12,000 を超えない。`CONTENT_MODEL_PROVIDER=anthropic`・`ANTHROPIC_API_KEY=dummy`・
   `CONTENT_MODEL=claude-sonnet-5-5` を置くと、model 未指定でも 5.5 の値になる（テスト後に環境変数を元に戻す）。
8. `test-prompt-builder.js` の「Anthropic 既定モデル」の期待を `claude-sonnet-5-5` に。

`node scripts/lib/__tests__/<触ったテスト>.js` と、`test-workflow-change-detection.js`・`test-article-length.js`・
`test-word-count-by-intent.js`・`test-env-resolution.js`・`test-nta-figures.js` を流す。

## 変更してはいけないもの

- 記事を書く指示文（`STATIC_RULES` などプロンプトの中身）・字数の受入基準（`WORD_COUNT_RANGE`）。
- `scripts/generate-draft.js`、照合（fact-check）関係、周辺作業の Haiku（`aux-model.js`）、OpenAI のモデル。
- `temperature` 等・`fallbacks`（サーバー側の切り替え）・ストリーミングは足さない。
- ワークフローは**コメント行以外**変えない。GitHub のリポジトリ変数には触らない。
