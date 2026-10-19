あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/generation-cost/` にあります。`README.md` を読んでから、**`01-one-pass-and-dedup.md`（R1〜R4）と `02-openai-models.md`（R5・R6）**を実装してください。日次の記事の生成の費用を下げるための変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `feat/generation-cost` です（PR #687 の `feat/fact-cost-03n` の上）。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。01 と 02 の変更が同じファイルに混ざる場合は、最終報告にどの行がどちらかを書いてください（Claude が分けてコミットします）。
- 試験は `scripts/lib/__tests__/test-generation-one-pass.js`（01）と `scripts/lib/__tests__/test-openai-models.js`（02）に書いてください。既存の試験の期待は、変更によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。
- ネットワークは使えません。AI・OpenAI の一覧はすべて偽の関数・偽の fetch で試験してください。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- README の「全段階共通の厳守事項」と、01・02 の「変更してはいけないもの」を守る。特に事実照合（`fact-check.js`・03n）、承認の差し止め、書き手のモデル（`CONTENT_MODEL`）と重複確認のモデル（`AUX_MODEL`）、論点別ルールの本文、受入の字数。
- 【要判断】は指示書の既定値で実装し、変数で切り替えられるようにする。
- 鍵・トークンをログ・ファイル・例外の文に出さない。ワークフローの `run:` に入力を直接埋め込まない。
- `content/posts/*.md`・`data/` を触らない（ルールの定義は `scripts/lib/article-prompt-static.js` にある）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
npm run build
node scripts/lib/__tests__/test-generation-one-pass.js
node scripts/lib/__tests__/test-openai-models.js
node scripts/lib/__tests__/test-content-model-routing.js
node scripts/lib/__tests__/test-env-resolution.js
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R1〜R6 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」。R1 は計算した補正値・1 文字あたりのトークン数と、その計算の根拠
2. R3 の 2 で洗い出した「税目をまたぐ語で当たるルール」の一覧（直したもの・直さなかったもの）
3. R6 で外したもの（`high_quality` の入力の扱いを含む）と、Anthropic が失敗したときの日次・差し戻しの動き
4. 既存の試験の期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 01 と 02 の変更が同じファイルに混ざった箇所
7. 【要判断】【要確認】として残した点
