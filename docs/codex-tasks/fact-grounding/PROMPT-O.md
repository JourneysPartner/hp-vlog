あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i〜03n は実装済みで main に入っています。今回は **`03o-cost-precision.md`（O1〜O10）だけ**を実装してください。照合（fact-check）の費用を下げ、正しい数字を「資料なし」に落とす確かめ方を直す変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-check-03o` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- まず 03o の「背景」を読み、O1 の不具合（`correctionPairs` が隣り合う対象で末尾まで広がる）を試験で再現してから直してください。
- 試験は `scripts/lib/__tests__/test-fact-check-03o.js` に書いてください（03o の「試験」1〜12）。既存の試験の期待は、O1〜O10 によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。`test-workflow-change-detection.js` の期待は変えないでください。そのうち「記事系ワークフローは作業ツリーで変更されていない」は、`daily-draft.yml`・`publish-scheduled.yml`・`regenerate-draft.yml` に未コミットの変更があると必ず落ちる見張りです。O8 でこの 2 本に env を足すのは指示どおり行い、この 1 件の失敗は最終報告に「未コミットのため」と書くだけにしてください（コミット後に Claude が流します）。同じファイルの残りの項目は通してください。
- ネットワークは使えないので、偽の LLM・偽の `fetch`・偽の時計で試験してください。依存関係は追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03o の「変更してはいけないもの」を守る。特に、止める範囲と承認の差し止め、fail-closed、引用の実在確認と数字の歯止めを弱めない（O4 の年だけの例外は引用した文の中だけ、O6 は部分ごとに同じ確かめをする）。
- 同期（即時）で頼むリクエスト本文は、O8 の変数が無いとき今と 1 バイトも変わらないこと（判定の指示文を変えるので `system` の文言は変わるが、`cache_control`・`thinking`・`output_config` などの形は同じ）。
- 抜き出し・修正の指示文、候補の出し方、初回の資料表の作り（`fact-pages.js`）、`max_tokens` を変えない。
- 鍵・トークンをログ・記録・例外の文に出さない。ワークフローの `run:` に入力を直接埋め込まない（env 経由）。
- `content/posts/*.md`・`data/`・`docs/codex-tasks/fact-grounding/fixtures/` を触らない（読むのはよい）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-check-03o.js
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
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-published-facts-audit.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. O1〜O10 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. 既存の試験の期待を変えた箇所とその理由
3. O1（再照合の範囲）・O2（Batch の再判定の資料表）・O6（範囲 2 つの引用の確かめ）の流れを、関数名と行で短く説明（Claude が差分を読むときの入口）
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
