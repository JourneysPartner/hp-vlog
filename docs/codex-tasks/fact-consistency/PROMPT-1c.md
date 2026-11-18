# 依頼: 照合の食い違い探しの「止めた理由の引き継ぎ」の穴を塞ぐ（01c）

あなたは実装担当です。前回までにあなたが実装した 01・01b（作業ツリーに未コミットで残っています）を、指示書 01c のとおりに直し、試験を足して通してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/fact-consistency/01c-carry-fixes.md`（この依頼の指示書。R24〜R26、試験 T30〜T32）
2. `docs/codex-tasks/fact-consistency/01b-review-fixes.md` の R17、`01-consistency.md` の R7〜R9・R14、`README.md` の安全の条件 S1〜S9
3. `docs/codex-tasks/fact-consistency/review-01b.md`（レビュー 2 回目。新しい指摘 Medium 1・2・Low 1 の再現のしかた）
4. 作業ツリーの今の変更（`scripts/lib/fact-check.js` の `checkFacts` の B と引き継ぎ・`checkArticle`、`netlify/functions/review-page.js` の `renderFactConsistency`、`scripts/lib/__tests__/test-fact-consistency.js`）

## 変えてよいファイル

`scripts/lib/fact-check.js`・`netlify/functions/review-page.js`・`scripts/lib/__tests__/test-fact-consistency.js`。これ以外は変えないでください。

## 必ず守ること

- 01 の S1〜S9 と 01b の R16〜R21 を壊さない。
- R25 で前回の `consistency` を写すのは、結果が `not_run` の回だけ。そのとき `record.status`・`record.summary`・`fact_check_blocking` は変えない。
- R24 で、新しい記録では id で直した文を引かない（`afters` を使う）。`afters` の無い古い記録だけ id で引く。
- 試験を消さない・弱めない・飛ばさない。

## 試験の動かし方

`sbx` だけが使えます。1 本ずつ `sbx node scripts/lib/__tests__/<名前>.js` の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

少なくとも次を動かし、結果を報告してください: test-fact-consistency.js、test-fact-check.js、test-review-page-fact-layout.js、test-review-page.js、test-fact-check-override.js、test-fact-cost-03n.js、test-published-facts-audit.js、`scripts/lib/__tests__/` の他の `test-fact-*.js` 全部。`test-fact-plan-01.js` の P2・P3/P4 は main でも落ちる前からの失敗です。

## 最後の報告の形（日本語）

1. R24〜R26 ごとに何を変えたか（関数と行）
2. 失敗を引き継ぐ条件の式と、`not_run` の回に写す条件の式（コードの行）
3. R26 の試験が、B の `if (options.signal?.aborted) throw error;` を消すと落ちることを確かめたか
4. 試験の結果（本数・通過数。落ちたものは名前・エラー・該当箇所）
5. 期待を変えた既存の試験の名前と理由（全部）
6. 指示書と違うやり方をした所と、その理由／【要確認】
