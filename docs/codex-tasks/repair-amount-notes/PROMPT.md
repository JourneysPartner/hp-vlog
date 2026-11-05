# Codex への指示（repair-amount-notes 段階 1）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `fix/repair-amount-notes`）で、照合の自動修正が「条件付きの別の額」を落とさないようにし、禁止表現を 3 件足してください。

## 読むもの

1. `docs/codex-tasks/repair-amount-notes/README.md`（何が起きたか・原因・方針・厳守事項）
2. `docs/codex-tasks/repair-amount-notes/01-repair-notes.md`（実装要件 R1〜R6・試験・変えてよいファイル・変えてはいけないもの）

## やること

- `01-repair-notes.md` の R1〜R5 を実装し、R6 は調べて報告してください（R6 ではコードを直さない）。R2・R4 の文字列と R5 の項目は、指示書の枠・表のとおりに使ってください。
- 変えてよいファイルは `01-repair-notes.md` の「変えてよいファイル」だけです。
- 指示書と食い違うことや、指示書どおりにすると既存の試験が壊れることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

次を流して、結果を最終報告に書いてください。

```
node scripts/lib/__tests__/test-fact-repair-notes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-keep-supported.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-table-numbers.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-fact-check-03x.js
node scripts/lib/__tests__/test-banned-phrases.js
node scripts/lib/__tests__/test-banned-title.js
node scripts/lib/__tests__/test-plain-wording-rules.js
node --check scripts/lib/fact-check.js
```

`LOGIC_VERSION` を固定で見ている試験は `rg -n "plan2-s3" scripts` で探してください。隔離の中では子プロセスの起動（`spawnSync`）が EPERM で落ちる試験があります。その場合は、落ちた理由がそれだけかを報告に書いてください（隔離の外で Claude が流し直します）。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）。
- 通信（AI の呼び出しを含む）。
- 指示書に無いファイルの変更（試験が書き出す assets/js/tax-simulator.*.js などが変わったら、元に戻してください）。

## 最終報告に書くこと

- R1〜R5 の実装の要点（関数名と行）
- R6 の調査結果
- 流した試験と結果（通過の数、落ちたものは名前と理由）
- 指示書と食い違った点・自分で決めずに残した点
