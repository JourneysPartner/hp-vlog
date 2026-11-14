# OpenCode への依頼（fact-jubun-quote）

このフォルダ（hp-vlog の作業用の取り出し、枝 `fix/fact-jubun-quote`）で、照合の数字の読み方で「十分」「不十分」を 10 と読まないようにし、承認画面に出す AI の引用を 200 字で切らないようにしてください。

## 読むもの

1. `docs/codex-tasks/fact-jubun-quote/README.md`（何が起きたか・決定・安全の決まり T1〜T8）
2. `docs/codex-tasks/fact-jubun-quote/01-jubun-and-quote.md`（R1〜R3・期待の表・試験 1〜9・変えてよいファイル）

## やること

- R1〜R3 を実装し、新しい試験 `scripts/lib/__tests__/test-fact-jubun-quote.js` に試験 1〜9 を書いてください。画面の文言は指示書の中のとおりに使ってください。
- 変えてよいファイルは、指示書の「変えてよいファイル」だけです。
- 指示書と食い違うこと、既存の試験が壊れること、T1〜T8 を守れない形になることに気づいたら、自分で決めずに最終報告に書いてください。

## 試験（すべて `sbx` を通して流す）

```
sbx node --check scripts/lib/fact-check.js
sbx node --check netlify/functions/review-page.js
sbx node scripts/lib/__tests__/test-fact-jubun-quote.js
sbx node scripts/run-test-files.js scripts/lib/__tests__/test-fact-ai-supported-numbers.js scripts/lib/__tests__/test-fact-check-03o.js scripts/lib/__tests__/test-fact-check-03p.js scripts/lib/__tests__/test-fact-check-03r.js scripts/lib/__tests__/test-fact-check-03s.js scripts/lib/__tests__/test-fact-check-03t.js scripts/lib/__tests__/test-fact-check-03u.js scripts/lib/__tests__/test-fact-check-03v.js scripts/lib/__tests__/test-fact-check-03w.js scripts/lib/__tests__/test-fact-check-03x.js scripts/lib/__tests__/test-fact-check-diagnostic.js scripts/lib/__tests__/test-fact-check-override.js scripts/lib/__tests__/test-fact-check.js scripts/lib/__tests__/test-fact-cost-03n.js scripts/lib/__tests__/test-fact-discarded-claims.js scripts/lib/__tests__/test-fact-keep-supported.js scripts/lib/__tests__/test-fact-number-guard.js scripts/lib/__tests__/test-fact-pages.js scripts/lib/__tests__/test-fact-plan-01.js scripts/lib/__tests__/test-fact-plan-02.js scripts/lib/__tests__/test-fact-precision-03l.js scripts/lib/__tests__/test-fact-qa-slot.js scripts/lib/__tests__/test-fact-real-run-2-fixes.js scripts/lib/__tests__/test-fact-real-run-fixes.js scripts/lib/__tests__/test-fact-recheck-n7.js scripts/lib/__tests__/test-fact-repair-notes.js scripts/lib/__tests__/test-fact-repair-retry.js scripts/lib/__tests__/test-fact-review-fixes-2.js scripts/lib/__tests__/test-fact-review-fixes-3.js scripts/lib/__tests__/test-fact-review-fixes-4.js scripts/lib/__tests__/test-fact-review-fixes-5.js scripts/lib/__tests__/test-fact-review-fixes-6.js scripts/lib/__tests__/test-fact-review-fixes.js scripts/lib/__tests__/test-fact-search-recall.js scripts/lib/__tests__/test-fact-table-numbers.js scripts/lib/__tests__/test-review-page-fact-layout.js scripts/lib/__tests__/test-review-page.js
```

- 作業を始める前の main では、上の 37 本はすべて通りました（2026-11-13、Claude がサンドボックスの外で確認）。
- 隔離の中で子プロセスの起動が EPERM で落ちる試験は、理由がそれだけかを報告に書いてください。

## してはいけないこと

- `git commit`・`git push`・枝の切り替え（コミットは Claude が行います）
- 通信（AI の呼び出しを含む）・`npm install`
- 指示書に無いファイルの変更。試験が `assets/js/tax-simulator*.js` を書き換えたら、元に戻してください

## 最終報告に書くこと

- R1〜R3 の要点（関数名と行）
- T1〜T8 をそれぞれどの試験で確かめたか
- 流した試験と結果（通過の数。落ちたものは名前・誤りの文・理由）
- 期待を変えた既存の試験と理由
- 指示書と食い違った点・自分で決めずに残した点
