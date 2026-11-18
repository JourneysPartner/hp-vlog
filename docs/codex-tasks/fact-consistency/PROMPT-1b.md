# 依頼: 照合の食い違い探し（01）の受け入れ・レビューの直し（01b）

あなたは実装担当です。前回あなたが実装した 01（作業ツリーに未コミットで残っています）を、指示書 01b のとおりに直し、試験を足して通してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/fact-consistency/01b-review-fixes.md`（この依頼の指示書。R15〜R23、試験の追加・直し）
2. `docs/codex-tasks/fact-consistency/01-consistency.md`・`README.md`（01 の要件と安全の条件 S1〜S9。そのまま有効）
3. 作業ツリーの今の変更（`git diff`。`scripts/lib/fact-check.js`・`netlify/functions/review-page.js`・`scripts/lib/article-prompt-static.js`・`scripts/lib/__tests__/test-fact-consistency.js`・`scripts/lib/__tests__/test-bracket-rule-body.js`）

## 変えてよいファイル

01 と同じ（`scripts/lib/fact-check.js`・`netlify/functions/review-page.js`・`scripts/lib/article-prompt-static.js` の `income_tax_bracket`・新しい試験 2 本・01 で触った既存の試験の字下げ）。これ以外は変えないでください。

## 必ず守ること

- 01 の S1〜S9。
- R16: 形の違う答えは止める（`failed`・`revise`）。中身の違いの行だけを捨てる。
- R17: 引き継ぐのは、前回の指摘の文字が今もそのまま在るときだけ。記録のファイルが無い・壊れているときは今までどおり照合を続ける。記録のファイルへの書き込みは今のまま。
- R18: 外す数字は、その sibling の quote・quote_notes・keep_numbers に在る数字だけ。
- R19: 書く前の決まりの選び方（`selectConditionalRuleEntries`）は変えない。
- 試験を消さない・弱めない・飛ばさない。

## 試験の動かし方

`sbx` だけが使えます。1 本ずつ `sbx node scripts/lib/__tests__/<名前>.js` の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

少なくとも次を動かし、結果を報告してください: test-fact-consistency.js、test-bracket-rule-body.js、test-fact-check.js、test-review-page-fact-layout.js、test-review-page.js、test-fact-check-override.js、test-conditional-rules.js、test-body-rule-detection.js、test-published-facts-audit.js、`scripts/lib/__tests__/` の他の `test-fact-*.js` 全部。`test-fact-plan-01.js` の P2・P3/P4 は main でも落ちる前からの失敗です。

## 最後の報告の形（日本語）

1. R15〜R23 ごとに何を変えたか（関数と行）
2. R16 の形の違いと中身の違いの分け方、R17 の引き継ぎの条件、R18 の式、R19 の式（コードの行）
3. 試験の結果（本数・通過数。落ちたものは名前・エラー・該当箇所）
4. 期待を変えた既存の試験の名前と理由（全部）
5. 指示書と違うやり方をした所と、その理由
6. 【要確認】迷った点
