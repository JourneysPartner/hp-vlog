# 記事の生成の費用の見直し（1 回の生成で済ませる・重複確認を 1 回に・GPT の整理）

## 背景（2026-10-19 の実測）

日次生成 1 本の API 料金を、10/16（run 38827432477）と 10/19（run 39179174483）の記録の usage から計算した（1 ドル 150 円）。

| # | 処理 | モデル | 10/16 | 10/19 |
|---|---|---|---|---|
| 1 | 話題の重複確認（選ぶとき） | Claude Haiku 4.5（`AUX_MODEL`） | 3.4 円 | 3.4 円 |
| 2 | 税務の論点語 | Claude Sonnet 5.5（`CONTENT_MODEL`） | 0.2 円 | 0.2 円 |
| 3 | 出典の選定（論点ごとに 3 回） | GPT-6 Luna（`LLM_SOURCE_SELECT_MODEL`） | 使用量の記録なし | 同 |
| 4 | 狙う検索語 | Sonnet 5.5 | 0.4 円 | 0.4 円 |
| 5 | 本文の生成 | Sonnet 5.5 | 25 円 | 26 円 |
| 6 | 本文が長すぎたときの全文の作り直し | Sonnet 5.5 | 19 円 | 20 円 |
| 7 | 論点別ルールの反映（本文全体の書き直し） | Sonnet 5.5 | 10 円 | 10 円 |
| 8 | 話題の重複確認（生成後） | Haiku 4.5 | 3.4 円 | 3.4 円 |
| 9 | 事実照合 | Claude Opus 5.5 | 82 円 | 100 円 |

分かったこと:

- **6 は 2 回とも発生**。1 回目の本文が 7,371 字・7,760 字で上限 7,000 字を超え、圧縮の指示つきで全文を作り直した（作り直し後は約 5,600 字）。字数の指示は 2026-08-15 に Sonnet 4.6 で測った「指示の 1.11 倍書く」で補正していて（`article-prompt-static.js` の `LENGTH_OVERSHOOT`）、指示の上限は約 6,100 字。10/14 に書き手が Sonnet 5.5 に替わってからは指示の 1.21〜1.27 倍を書いている。出力の上限（`maxTokensFor`）も Sonnet 5.5 を 1 文字 1.14 トークンと見積もって計算しているが、実測は 1 文字約 0.92 トークン（10/16: 本文 7,371 字＋frontmatter で出力 7,316 トークン）で、超過を止められていない。
- **7 は 2 回とも誤反応**。論点別ルール `dependent_income_threshold`（所得税の扶養の所得ライン）が「基礎控除」「配偶者控除」の語で当たり、贈与税の記事（「贈与税の基礎控除」「贈与税の配偶者控除」）で本文全体を書き直していた（結果は 5,600 字 → 5,600 字）。本文が通達を引くと、それだけでも書き直しが走る（`applyMissingRulesToBody` の `cited.citations.length`）。
- **8 は 9/8 の事故で入った**（891fc738。選ぶときの確認は企画の情報だけで、生成した記事が既存の 3 本と重複した）。その後 9/28 に、本文の生成前に狙う検索語と URL を決める処理（`prepareQueries`）が入ったので、生成前により詳しい情報で確かめられる。
- 3 と週次の話題集め（検索候補・Search Console・質疑応答の選別）は OpenAI で、使用量をログに出していない。週次は既定の `gpt-5.6-luna` のまま（日次は変数で `gpt-6-luna`）。
- Anthropic が失敗したときに GPT-5.4 で生成し直す予備がある（ふだんは使わない）。

## 毛利さんの決定（2026-10-19）

1. 本文は **1 回の生成で済ませる**（5〜7）。全文の作り直し・本文全体の書き直しをやめる。
2. それでも 1 回目が上限を超えたときは、**超えた分だけ短くする安い呼び出しを 1 回だけ**許す（全文の作り直しはしない）。
3. 話題の重複確認は **生成前の 1 回にまとめる**（狙う検索語・URL が決まった後、本文の生成の前）。生成後の AI の確認はやめる。
4. GPT は **OpenAI のモデル一覧から最新の Luna を自動で選ぶ**。
5. **GPT-5.4 の予備は撤去**する。

モデルの見直し（重複確認・本文の生成を DeepSeek V4.1 Flash・GLM-5.3 Flash・Gemini 3.8 Flash で試す）は別に Claude が実 AI で試験している。本作業ではモデルを替えない。

参考（2026-10-19、Claude の試験。重複 3 件・重複でない 8 件、今の頼み方のまま）: 重複 3 件はどのモデルも見つけた。重複でない 8 件を重複と誤判定したのは Haiku 4.5 が 7 件（後処理のガードで 1 件まで減る）、DeepSeek V4.1 Flash（1017）4 件、Gemini 3.8 Flash 4 件、GLM-5.3 Flash 2 件（ガードで 0 件）。11 件の費用は Haiku 4.5 33 円・DeepSeek 2.3 円・GLM 4.3 円・Gemini 23 円。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-one-pass-and-dedup.md` | 字数の補正・超過時の短縮・ルールの事前反映と誤反応・生成後の書き直しの撤去・重複確認を生成前の 1 回に |
| 02 | `02-openai-models.md` | GPT の最新の Luna の自動選択・使用量のログ・GPT-5.4 の予備の撤去 |

作業枝は `feat/generation-cost`（`feat/fact-cost-03n`＝PR #687 の上に積む。`content-model.js` の同じ箇所を触るため）。

## 全段階共通の厳守事項

- 事実照合（`fact-check.js` と 03n の Batch）を変えない。照合の結果で承認を止める仕組み（fail-closed）を弱めない。
- 書き手のモデル（`CONTENT_MODEL`）と呼び出し設定、重複確認のモデル（`AUX_MODEL`）を変えない。
- 既存の品質ゲート・禁止表現・論点別ルールの本文（`text`）・通達番号と条番号の照合・題名の点検を弱めない。
- 記事の主題・構成・文体の指示は、字数とルールの箇所以外を変えない。
- `content/posts/*.md`・`data/`（ルールの定義を除く）を触らない。鍵をログ・ファイルに出さない。説明・コメント・最終報告は日本語。ファイルは LF。

## 元に戻す方法

- 01: 字数の補正値は `article-prompt-static.js` の表を戻す。超過時の短縮・ルールの部分修正・生成前の重複確認は、それぞれ環境変数で旧動作に戻せるようにする（01 に記載）。
- 02: 最新の Luna の自動選択は、変数 `OPENAI_LUNA_MODEL` にモデル名を入れると固定できる。

## 受け入れ確認（Claude が行う）

- 全テスト（前からの 4 本だけが落ちる）・`npm run build`・`npm run validate`。
- 実際の日次生成 1 回（マージ後の定期実行、または手動）の記録で: 本文の生成が 1 回で済む（6・7 の呼び出しが無い、または短縮が 1 回）、生成前の重複確認が 1 回、生成後の AI の重複確認が無い、GPT のモデル名と使用量がログに出る。

## コードの入口

- 生成: `scripts/generate-draft.js`（`runSingleDraft` → `prepareSources` → `prepareQueries` → `generateTopics` → `generateArticle`。長さの判定と作り直しは `generateArticle` の `checkBodyLength` の直後、ルールの反映は `applyMissingRulesToBody`、生成後の重複確認は `checkGeneratedArticle`、選ぶときの重複確認は `runSingleDraft` と選定の関数の `checkDuplicatesWithAI`）
- 字数: `scripts/lib/article-prompt-static.js`（`WORD_COUNT_RANGE`・`LENGTH_OVERSHOOT`・`LENGTH_SAFETY`・`calibratedRange`・`TOKEN_ESTIMATES_BY_MODEL`・`maxTokensFor`）、`scripts/lib/article-length.js`
- ルール: `article-prompt-static.js` の論点別ルール（`match` と `text`）、`findUnappliedRules`・`findUnappliedReferencePages`
- 重複確認: `scripts/lib/ai-dedup.js`（`checkDuplicatesWithAI`・`buildCandidateBlock`・`checkGeneratedDuplicateWithAI`）
- モデル: `scripts/lib/content-model.js`、`scripts/lib/aux-model.js`、`scripts/lib/llm-source-selector.js`（`makeOpenAILuna`）、`scripts/update-suggest-topics.js`・`update-gsc-topics.js`・`triage-shitsugi-topics.js`
- ワークフロー: `daily-draft.yml`・`regenerate-draft.yml`・`refresh-article.yml`・`update-suggest-topics.yml`・`fetch-search-console.yml`・`triage-shitsugi.yml`
