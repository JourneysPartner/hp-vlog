指示書 `docs/codex-tasks/review-auth/01b-review-fixes.md`（F1〜F8）を実装してください。01 の実装（コミット 2852dcd6）を独立レビューした指摘と、あなたの前回の報告の【要判断】（承認のバックグラウンド関数の 202）の修正です。レビューの全文は `review-01.md` にあります。

**F1 は High です（このままでは誰もログインできません）。** 原因と直し方は指示書のとおりです。

前回と同じ条件で作業してください。

- ブランチ `fix/review-auth` のまま、コミットしない。
- ネットワーク不可、依存関係を足さない。Blobs の条件付きの書き込みは `node_modules/@netlify/blobs/dist/main.d.ts` の型で形を確かめてから使う。
- 失敗時は安全側。3 つの処理の中身と応答を変えない。秘密をログ・画面・応答に出さない。
- 試験に鍵やトークンの形の文字列を書かない。
- 01 の試験の期待を緩めない（変えるのは F1〜F8 で変わる箇所だけ。理由を報告）。
- 対象外のテスト: `test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`・`test-fact-pages.js`・`test-materials-bundle.js`。

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

1. F1〜F8 ごとに「何を変えたか」「触ったファイルと行」「試験」
2. F2 の同時の要求の試験で、照合が呼ばれた回数（同じ IP 200 件・ばらばらの IP 200 件）
3. 既存の試験の期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】
