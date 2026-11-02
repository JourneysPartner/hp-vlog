# Codex への指示（plain-wording 段階 1）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `feat/plain-wording-rules`）で、記事の書き方に「やわらかい言葉と、書きすぎない細かさ」の決まりを足してください。

## 読むもの

1. `docs/codex-tasks/plain-wording/README.md`（背景・方針・厳守事項）
2. `docs/codex-tasks/plain-wording/01-plain-wording-rules.md`（実装要件 R1〜R7 と、変更してはいけないもの）

## やること

- `01-plain-wording-rules.md` の R1〜R7 を実装してください。R1 の決まりの本文・R4 の例・R5 の注記・R6 の JSON は、指示書の枠の中の文字列を 1 文字も変えずに使ってください。
- 変えてよいファイルは次だけです。これ以外のファイルは変えないでください。
  - `scripts/lib/article-prompt-static.js`
  - `scripts/generate-draft.js`（`regenerateWithContentModel` の文体の節の直後と、読み込みの行だけ）
  - `data/banned-phrases.json`（1 件の追加だけ）
  - `scripts/lib/__tests__/test-plain-wording-rules.js`（新規）
  - `scripts/lib/__tests__/test-readability-rules.js`
- 指示書と食い違うことや、指示書どおりにすると既存の試験が壊れることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

次を流して、結果を最終報告に書いてください。

```
node scripts/lib/__tests__/test-plain-wording-rules.js
node scripts/lib/__tests__/test-readability-rules.js
node scripts/lib/__tests__/test-banned-phrases.js
node scripts/lib/__tests__/test-banned-title.js
node scripts/lib/__tests__/test-prompt-builder.js
node --check scripts/lib/article-prompt-static.js
node --check scripts/generate-draft.js
```

隔離の中では子プロセスの起動（`spawnSync`）が EPERM で落ちる試験があります。その場合は、落ちた理由がそれだけかを報告に書いてください（隔離の外で Claude が流し直します）。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います。隔離の中では `.git` に書けません）。
- 通信（AI の呼び出しを含む）。
- `content/posts/` の記事の変更、ワークフローの変更、`READABILITY_RULES` の本文の変更。

## 最終報告に書くこと

- 変えたファイルと、それぞれの変更の要約。
- 試験の結果（通過数・失敗数、失敗があれば名前と理由）。
- 指示書と食い違った点や、判断に迷った点（無ければ「無し」）。
