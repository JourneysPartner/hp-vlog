あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/review-auth/` です。`README.md` で背景と方針を読み、`01-review-auth.md`（R1〜R8 と試験 1〜15）を実装してください。記事のレビュー画面と、承認・差し戻し・見送りの処理に、パスワードのログインをかける修正です。**認証・セキュリティの境界の変更なので、抜けが無いことを最優先にしてください。**

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/review-auth` です（レビュー画面の並びの修正 #681 の上に作っています）。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- ネットワークは使えません。Blobs・GitHub・通知・時刻は、テストで偽のものに差し替えてください。依存関係を追加しないでください（`crypto`・`@netlify/blobs` は導入済み）。
- テストの中に、鍵やトークンの形の文字列（`sk-…` など）や本物らしいパスワードを書かないでください。試験用のパスワードは「試験用のパスワード」のような分かる文字列にし、鍵は実行時に作ってください（Netlify の秘密情報の自動検出でビルドが止まった前例があります）。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`・`test-fact-pages.js`・`test-materials-bundle.js`）は対象外です。

## 厳守

- 失敗時は安全側（README の厳守事項）。設定が無い・Blobs が使えない・Cookie が壊れている、はすべて「入れない・処理しない」。
- 3 つの処理の中身（照合の差し止め・`recommendation` の判定・マージ・通知）と応答の形を変えない。入口に認証を足すだけ。
- 中身の処理（GitHub への書き込み等）は、Origin・セッション・トークンの確認が全部通ってから始める。
- パスワード・Cookie・トークン・鍵・IP そのものを、ログ・画面・応答に出さない。
- `lib/admin-auth.js` と管理画面を変えない。`data/`・`content/posts/*.md`・`fixtures/` を触らない。
- 既存の試験は、ログインした状態の要求を作る手助けを使って通す。認証を外して通す・期待を緩める直し方はしない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-review-auth.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-skip-refresh.js
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

1. R1〜R8 ごとに「何を変えたか」「触ったファイルと行」
2. 試験 1〜15 の結果
3. 認証を通らない要求が中身の処理に届かないことを、3 つの処理それぞれでどう確かめたか
4. 既存テストの期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点（特に、Netlify の実行環境で確かめないと分からないこと）
