# Codex への指示（fact-check-override 段階 1・2）

このリポジトリ（hp-vlog の作業用の取り出し、枝 `feat/fact-check-override`）で、照合（事実の照合）で止まった記事を人の判断で公開できるようにし、照合自身が本文の文を特定できなかった主張では承認を止めないようにしてください。

## 読むもの

1. `docs/codex-tasks/fact-check-override/README.md`（何が起きたか・決定・安全の決まり S1〜S6）
2. `docs/codex-tasks/fact-check-override/01-override.md`（段階 1: R1〜R7・試験・変えてよいファイル）
3. `docs/codex-tasks/fact-check-override/02-discarded-not-blocking.md`（段階 2: R8〜R9・試験・変えてよいファイル）

## やること

- 段階 1（R1〜R7）を実装して試験を通し、続けて段階 2（R8〜R9）を実装して試験を通してください。
- 文言は指示書の「」の中のとおりに使ってください。
- 変えてよいファイルは各指示書の「変えてよいファイル」だけです。
- 指示書と食い違うこと、指示書どおりにすると既存の試験が壊れること、安全の決まり S1〜S6 を守れない形になることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験

次を流して、結果を最終報告に書いてください。

```
node scripts/lib/__tests__/test-fact-check-override.js
node scripts/lib/__tests__/test-fact-discarded-claims.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-review-auth.js
node scripts/lib/__tests__/test-quality-gate.js
node scripts/lib/__tests__/test-publish-slot.js
node scripts/lib/__tests__/test-publish-prep.js
node scripts/lib/__tests__/test-placeholder-title.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-plan-02.js
node --check scripts/lib/fact-check.js
node --check netlify/functions/review-approve-background.js
node --check netlify/functions/review-page.js
```

`fact_check_blocking`・`blocks_approval`・`plan2-s4` を見ている他の試験は `rg -n "fact_check_blocking|blocks_approval|plan2-s4" scripts/lib/__tests__` で探し、関係するものも流してください。隔離の中では子プロセスの起動（`spawnSync`）が EPERM で落ちる試験があります。その場合は、落ちた理由がそれだけかを報告に書いてください（隔離の外で Claude が流し直します）。Git Bash が起動できないときは PowerShell か cmd を使ってください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）。
- 通信（AI の呼び出しを含む）。
- 指示書に無いファイルの変更（試験が書き出す `assets/js/tax-simulator.*.js` などが変わったら、元に戻してください）。

## 最終報告に書くこと

- 段階ごとの実装の要点（関数名と行）
- S1〜S6 をそれぞれどの試験で確かめたか
- R7 の数え直しの結果（当たる記事の本数）
- 流した試験と結果（通過の数、落ちたものは名前と理由）
- 期待を変えた既存の試験と理由
- 指示書と食い違った点・自分で決めずに残した点
