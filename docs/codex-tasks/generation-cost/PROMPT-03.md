あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/generation-cost/` にあります。01・02 は実装済みでコミット済みです（78091dd2）。今回は **`03-gateway-dedup.md`（R0・R7〜R10）だけ**を実装してください。`README.md` の「全段階共通の厳守事項」も守ってください（03 は提供元を足すだけで、変数の既定値は変えません）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `feat/generation-cost` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験は `scripts/lib/__tests__/test-gateway-model.js` に書いてください（03 の「試験」1〜7）。既存の試験の期待は、変更によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。
- ネットワークは使えません。Vercel AI Gateway はすべて偽の fetch で試験してください。依存関係を追加しないでください（今の `content-model.js` と同じく `fetch` で書く）。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03 の「変更してはいけないもの」を守る。特に事実照合（`fact-check.js`・03n）と承認の差し止め、01 の流れ、指示文。
- `anthropic` のときの本文の生成・重複確認のリクエスト本文は今と 1 バイトも変えない。
- 鍵・トークンをログ・ファイル・例外の文に出さない。ワークフローの `run:` に入力を直接埋め込まない。
- `content/posts/*.md`・`data/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
npm run build
node scripts/lib/__tests__/test-gateway-model.js
node scripts/lib/__tests__/test-generation-one-pass.js
node scripts/lib/__tests__/test-openai-models.js
node scripts/lib/__tests__/test-content-model-routing.js
node scripts/lib/__tests__/test-env-resolution.js
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-withdrawn-topics.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R0・R7〜R10 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. R0 で、本文の生成の失敗のときに日次がどう終わるか（通知の理由の例）
3. 消した補助の関数があれば、その一覧
4. 既存の試験の期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
