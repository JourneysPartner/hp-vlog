あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i〜03k は実装済みで main に入っています。今回は **`03l-precision-fixes.md`（L1〜L5）だけ**を実装してください。本番初稼働の記事（#680）で見えた照合の誤り 2 件と、main で落ちている試験 2 本の修正です。原因の切り分けは指示書に書いてあります。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-precision-03l` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- L1〜L3 のテストは新しいファイル `scripts/lib/__tests__/test-fact-precision-03l.js` に足してください。L4・L5 は既存のテストファイルを直します。既存のテストの期待は、L1〜L5 によって変わるものだけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテストのうち `test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js` は対象外です（`test-fact-pages.js`・`test-materials-bundle.js` は今回直す対象です）。

## 厳守

- 03i〜03l の「変更してはいけないもの」を守る。特に案 2 の止める範囲、承認の差し止めの 3 経路、fail-closed、引用の実在確認、数字の歯止め（H1・G3・H2・03g）、**候補の出し方（`searchEvidence`）**、照合のモデルと呼び出し設定、7c775b48 の「答えの多くが確認を通らなければ照合不能で止める」と `reject_reason`。
- 指示文の変更は L2 の資料なしの修正の指示 1 か所だけ。
- `content/posts/*.md`・`data/`・`fixtures/` を触らない（読むのはよい）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-precision-03l.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-review-fixes-5.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. L1〜L5 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. 既存テストの期待を変えた箇所とその理由
3. `test-fact-pages.js` の T1（3 本の量、資料の種類別の内訳）と T2（既知の誤り 8 件）の結果
4. L3 で `material: true` の分割結果が変わったか
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
