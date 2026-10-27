指示書 `docs/codex-tasks/review-auth/01c-review-fixes-2.md`（G1〜G3）を実装してください。01b の修正（935ea059）の再レビューの指摘です。再レビューの全文は `review-01b.md` にあります。

**G1 が主です。** 照合の前に回数を確保する作り（F2）が、`@netlify/blobs` 10.7.9 の `setJSON` の不具合で本番では効いていません。`set` と、書き込みの失敗で例外を投げる `fetch` に替え、試験は本物のライブラリに偽の `fetch` を渡して確かめてください。

前回と同じ条件で作業してください。

- ブランチ `fix/review-auth` のまま、コミットしない。ネットワーク不可、依存関係を足さない。
- 失敗時は安全側。3 つの処理の中身と応答を変えない。秘密をログ・画面・応答に出さない。試験に鍵やトークンの形の文字列を書かない。
- 01・01b の試験の期待を緩めない（変えるのは G1〜G3 で変わる箇所だけ。理由を報告）。
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

1. G1〜G3 ごとに「何を変えたか」「触ったファイルと行」「試験」
2. G1 の本物のライブラリでの試験の結果（書き込みの要求の条件ヘッダ、同時 200 件での照合の回数、書き込みの失敗での扱い）
3. 既存の試験の期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】
