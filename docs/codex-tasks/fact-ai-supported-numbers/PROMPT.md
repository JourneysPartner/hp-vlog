# Codex への指示（fact-ai-supported-numbers 段階 1）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `feat/fact-ai-supported-numbers`）で、照合の AI が「裏付けあり」と答えた文を、機械の数字の確かめだけで書き換えないようにしてください。

## 読むもの

1. `docs/codex-tasks/fact-ai-supported-numbers/README.md`（何が起きたか・決定・安全の決まり T1〜T4）
2. `docs/codex-tasks/fact-ai-supported-numbers/01-review-not-rewrite.md`（U1・U2・試験・変えてよいファイル）

## やること

- U1・U2 を実装し、試験 1〜6 を足してください。文言は指示書の「」の中のとおりに使ってください。
- 変えてよいファイルは指示書の「変えてよいファイル」だけです。
- 指示書と食い違うこと、既存の試験が壊れること、T1〜T4 を守れない形になることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

```
node scripts/lib/__tests__/test-fact-ai-supported-numbers.js
node scripts/lib/__tests__/test-fact-keep-supported.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-override.js
node scripts/lib/__tests__/test-fact-discarded-claims.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-plan-02.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-repair-notes.js
node scripts/lib/__tests__/test-fact-table-numbers.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node --check scripts/lib/fact-check.js
node --check netlify/functions/review-page.js
```

`rg -n "plan2-s5|rejected_answer|引用が短い" scripts/lib/__tests__` で見つかる試験も流してください。隔離の中で子プロセスの起動が EPERM で落ちる試験は、理由がそれだけかを報告に書いてください。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）。この作業フォルダは git worktree なので git の書き込みはできません。
- 通信（AI の呼び出しを含む）・`npm install`（node_modules は親の hp-vlog にあります）。
- 指示書に無いファイルの変更（試験が書き出す `assets/js/tax-simulator*.js` が変わったら元に戻す）。

## 最終報告に書くこと

- U1・U2 の要点（関数名と行）
- T1〜T4 をそれぞれどの試験で確かめたか
- 流した試験と結果（通過の数、落ちたものは名前と理由）
- 期待を変えた既存の試験と理由
- 指示書と食い違った点・自分で決めずに残した点
