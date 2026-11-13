# OpenCode への依頼（fact-jubun-quote 01b）

このフォルダ（hp-vlog の作業用の取り出し、枝 `fix/fact-jubun-quote`）には、01 の実装がコミット前の状態で入っています。レビューの指摘 1 件を、試験を足して塞いでください。

## 読むもの

1. `docs/codex-tasks/fact-jubun-quote/01b-review-fixes.md`（指摘・やること・変えてよいファイル）
2. 必要なら `docs/codex-tasks/fact-jubun-quote/README.md` と `01-jubun-and-quote.md`

## 試験（`sbx` を通して流す）

```
sbx node scripts/lib/__tests__/test-fact-jubun-quote.js
sbx node scripts/lib/__tests__/test-fact-keep-supported.js
sbx node scripts/lib/__tests__/test-review-page.js
sbx node scripts/lib/__tests__/test-review-page-fact-layout.js
```

## してはいけないこと

- `git commit`・`git push`・枝の切り替え・通信・`npm install`
- `scripts/lib/__tests__/test-fact-jubun-quote.js` のほかのファイルの変更

## 最終報告に書くこと

- 足した確かめ（行）
- `renderGeneralizedAnswer` から書き添えを消すと、どの assert が落ちるか
- 流した試験と結果（落ちたものは名前・誤りの文・理由）
