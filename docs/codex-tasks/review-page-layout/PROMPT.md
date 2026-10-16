あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/review-page-layout/` です。`README.md` で背景と方針を読み、`01-layout.md`（R1〜R5 と試験 1〜9）を実装してください。記事のレビュー画面で、照合の一覧が記事本文の前を埋めている問題の修正です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/review-page-fact-layout` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験データは `docs/codex-tasks/review-page-layout/fixtures/`（10/16 の実際の下書きと照合の記録）です。変更しないでください。
- ネットワークは使えません。依存関係を追加しないでください（`marked` は導入済み）。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 承認を止める理由（残った食い違い・未解決の資料なし・要修正・照合の差し止め・未実施・古い記録・読めない記録）を、記事本文より後ろに移したり畳んだりしない。
- 変えるのは `netlify/functions/review-page.js` と試験だけ。照合の記録の形、`scripts/lib/fact-check.js`・`scripts/generate-draft.js`・`netlify/functions/review-approve-background.js`、承認ボタンの有効・無効の条件を変えない。
- 画面に出す文字は全部エスケープする。R5 で除くと決めた書式のタグ以外は除かない。
- スクリプトを足さない（開閉は `<details>`）。
- `data/`・`content/posts/*.md`・`fixtures/` を触らない。既存の試験の期待を弱めない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-multi-source-frontmatter.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R1〜R5 ごとに「何を変えたか」「触ったファイルと行」
2. 試験 1〜9 の結果。実データの画面で、本文より前の照合の部分の文字数と、本文より後ろに入った件数
3. 既存テストの期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
