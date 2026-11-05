# Codex への指示（discarded-claims-record 01b レビュー指摘の修正）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `feat/discarded-claims-record`、PR #743）で、レビューの指摘 3 件を直してください。承認の判断は変えません。

## 読むもの

1. `docs/codex-tasks/discarded-claims-record/01b-review-fixes.md`（直す中身・試験・変えてよいファイル・変えてはいけないもの）
2. 必要なら `README.md`・`01-discarded-claims.md`（元の要件）

## やること

- `01b-review-fixes.md` の F1〜F3 を直し、試験を足してください。画面の文言は指示書のとおりに使ってください。
- 変えてよいファイルは `01b-review-fixes.md` の「変えてよいファイル」だけです。
- **承認の判断（`status`・承認を止める数・`remaining`・`review_items`）が変わる形になりそうなら、実装せずに止めて最終報告に書いてください。**
- 指示書と食い違うことや、指示書どおりにすると既存の試験が壊れることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

次を流して、結果を表で最終報告に書いてください。

```
node scripts/lib/__tests__/test-fact-discarded-claims.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-fact-repair-notes.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-plan-02.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-keep-supported.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-table-numbers.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-review-fixes-5.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-check-03o.js
node scripts/lib/__tests__/test-fact-check-03p.js
node scripts/lib/__tests__/test-fact-check-03r.js
node scripts/lib/__tests__/test-fact-check-03u.js
node scripts/lib/__tests__/test-fact-check-03v.js
node scripts/lib/__tests__/test-fact-check-03w.js
node scripts/lib/__tests__/test-fact-check-03x.js
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-fact-precision-03l.js
node --check scripts/lib/fact-check.js
node --check netlify/functions/review-page.js
git diff --check
```

隔離の中では子プロセスの起動（`spawnSync`）が EPERM で落ちる試験があります。その場合は、落ちた理由がそれだけかを報告に書いてください（隔離の外で Claude が流し直します）。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）。
- 通信（AI の呼び出しを含む）。
- 指示書に無いファイルの変更（試験が書き出す assets/js/tax-simulator.*.js などが変わったら、元に戻してください）。

## 最終報告に書くこと

- F1〜F3 の直し方の要点（関数名と行）
- このファイル以外の既存の試験を変えていないこと
- 足した試験の一覧
- 流した試験と結果（通過の数、落ちたものは名前と理由）
- 指示書と食い違った点・自分で決めずに残した点
