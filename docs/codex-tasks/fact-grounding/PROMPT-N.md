あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i〜03m は実装済みで main に入っています。今回は **`03n-cost-batch-model.md`（N1〜N3）だけ**を実装してください。照合（fact-check）の費用を下げるための変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `feat/fact-cost-03n` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験は `scripts/lib/__tests__/test-fact-cost-03n.js` に書いてください（03n の「試験」1〜13）。既存の試験の期待は、N1〜N3 によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。
- Batch の宛先と応答の形は 03n に書いたとおりです。ネットワークは使えないので、偽の `fetch` と偽の時計で試験してください。依存関係は追加しないでください（Anthropic の SDK も入れず、今の `content-model.js` と同じく `fetch` で書く）。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03n の「変更してはいけないもの」を守る。特に AI への指示文、候補の出し方、資料表の作り、`max_tokens`、`cache_control`、止める範囲と承認の差し止め、fail-closed、`LOGIC_VERSION`（03l のまま）、照合の既定のモデル、書き手のモデルと呼び出し設定。
- Opus 5.5 で `FACT_CHECK_EFFORT` が無いとき、照合のリクエスト本文が今と 1 バイトも変わらないこと。
- 鍵・トークンをログ・記録・例外の文に出さない。ワークフローの `run:` に入力を直接埋め込まない（env 経由）。
- `content/posts/*.md`・`data/`・`fixtures/` を触らない（読むのはよい）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-content-model-routing.js
node scripts/lib/__tests__/test-env-resolution.js
node scripts/lib/__tests__/test-workflow-change-detection.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-precision-03l.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-review-fixes-5.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-withdrawn-topics.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. N1〜N3 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. 既存の試験の期待を変えた箇所とその理由
3. Batch の待ち・やり直し・取り消しの流れを、関数名と行で短く説明（Claude が差分を読むときの入口）
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
