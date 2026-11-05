# Codex への指示（repair-amount-notes 01b レビュー指摘の修正）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `fix/repair-amount-notes`、PR #742）で、レビューの Medium 1 件を直してください。

## 読むもの

1. `docs/codex-tasks/repair-amount-notes/01b-review-fixes.md`（直す中身・試験・変えてよいファイル・変えてはいけないもの）
2. 必要なら `docs/codex-tasks/repair-amount-notes/01-repair-notes.md` の R3（許す数字の文言を今回広げています）

## やること

- `01b-review-fixes.md` の F1 を直し、試験を書き換え・追加してください。
- 試験 S4-6 は、correct を指摘ごとに別にした形で、直す前のコードでは落ちることを先に確かめてください（確かめ方と結果を報告に書く）。
- 変えてよいファイルは `01b-review-fixes.md` の「変えてよいファイル」だけです。
- 指示書と食い違うことや、指示書どおりにすると既存の試験が壊れることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

次を流して、結果を表で最終報告に書いてください。

```
node scripts/lib/__tests__/test-fact-repair-notes.js
node scripts/lib/__tests__/test-fact-plan-02.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-keep-supported.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-table-numbers.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-review-fixes-5.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-fact-check-03o.js
node scripts/lib/__tests__/test-fact-check-03p.js
node scripts/lib/__tests__/test-fact-check-03r.js
node scripts/lib/__tests__/test-fact-check-03u.js
node scripts/lib/__tests__/test-fact-check-03v.js
node scripts/lib/__tests__/test-fact-check-03x.js
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-fact-precision-03l.js
node scripts/lib/__tests__/test-banned-phrases.js
node scripts/lib/__tests__/test-banned-title.js
node scripts/lib/__tests__/test-plain-wording-rules.js
node --check scripts/lib/fact-check.js
git diff --check
```

隔離の中では子プロセスの起動（`spawnSync`）が EPERM で落ちる試験があります。その場合は、落ちた理由がそれだけかを報告に書いてください（隔離の外で Claude が流し直します）。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）。
- 通信（AI の呼び出しを含む）。
- 指示書に無いファイルの変更（試験が書き出す assets/js/tax-simulator.*.js などが変わったら、元に戻してください）。

## 最終報告に書くこと

- F1 の直し方の要点（関数名と行）
- S4-6 が直す前のコードで落ちることの確かめ方と結果
- 足した試験の一覧（名前と、何を確かめるか）
- 流した試験と結果（通過の数、落ちたものは名前と理由）
- 指示書と食い違った点・自分で決めずに残した点
