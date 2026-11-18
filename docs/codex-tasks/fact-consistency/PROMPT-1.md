# 依頼: 照合の直しで、同じ文の指摘を 1 つの直しにまとめ、直した後に食い違う所を探し、速算表の決まりを本文で当て、画面の件数を直す

あなたは実装担当です。このリポジトリ（税理士事務所のサイト hp-vlog。記事の事実照合の仕組みを含む）で、指示書どおりに実装し、試験を書いて通してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/fact-consistency/01-consistency.md`（この依頼の指示書。要件 R1〜R14、試験 T1〜T23、既存の試験の扱い、変えてはいけないもの）
2. `docs/codex-tasks/fact-consistency/README.md`（背景と安全の条件 S1〜S9、コードの入口）
3. `docs/codex-tasks/fact-consistency/fixtures/pr796.json`（試験データ）
4. `scripts/lib/fact-check.js` の `repairNumberGuards`・`repairInstructions`・`repairBody`・`checkFacts`（特に 1650〜1990 行）・`call`・`checkArticle`・`applyFactResult`
5. `netlify/functions/review-page.js` の照合の要点（200〜230 行）・`renderFactCheck`・`renderFactRemaining`
6. `scripts/lib/article-prompt-static.js` の `income_tax_bracket`・`ruleMatchText`・`detectRulesFromBody`、`scripts/lib/body-patches.js` の `postfixRules`・`targetedSentences`
7. `scripts/lib/__tests__/test-fact-check.js`（偽の AI `fake` の作り）

## 変えてよいファイル

- `scripts/lib/fact-check.js`
- `netlify/functions/review-page.js`（R13・R14 だけ）
- `scripts/lib/article-prompt-static.js`（`income_tax_bracket` だけ。R11・R12）
- 新しい試験 `scripts/lib/__tests__/test-fact-consistency.js`・`scripts/lib/__tests__/test-bracket-rule-body.js`
- 既存の試験は、指示書の「既存の試験の扱い」に書いた直しだけ。直したものは全部、報告に名前と理由を書く。試験を消さない・弱めない・飛ばさない。

これ以外のファイルは変えないでください。

## 必ず守ること（安全の条件）と、それを確かめる試験

- S1 資料なしの「消す数字」から外すのは、同じ文の食い違い・期限の直しの correct などにある数字だけ。それ以外の資料の無い数字が残れば、今と同じく採らない（T3・T4）。
- S2 指摘が 1 つだけの文は、修正の依頼も結果も今と同じ（T5）。
- S3 直した後の食い違い探し（B）は本文を変えない（T8）。
- S4 B の失敗は `revise`。B のせいで `ok` にも `not_run` にもしない（T12・T13）。
- S5 B は、実際に本文へ入った食い違い・期限の書き漏れの直しがあり、`repair !== false` のときだけ動く（T10・T14）。
- S6 B の指摘は、記事にその文字のまま在るものだけ。直した文そのものは指摘にしない（T11・T16）。
- S7 B で止めた記事も `fact_check_blocking: true` になるだけで、今の上書きの仕組みは変えない（T8）。
- S8 速算表の決まりは、書いた後の本文で当たる条件を足すだけ。書く前の選び方は変えない（T20）。
- S9 画面に出す AI の文は全部エスケープする（T17）。

## 試験の動かし方

このシェルでは `sbx` だけが使えます。1 本ずつ次の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

```
sbx node scripts/lib/__tests__/test-fact-consistency.js
```

少なくとも次を動かし、結果を報告してください: test-fact-consistency.js、test-bracket-rule-body.js、test-fact-check.js、test-review-page-fact-layout.js、test-review-page.js、test-fact-check-override.js、test-conditional-rules.js、test-body-rule-detection.js、`scripts/lib/__tests__/` の他の `test-fact-*.js` 全部、test-published-facts-audit.js。子プロセスの起動が EPERM で落ちる試験があれば、その試験名だけ報告してください（サンドボックスの制約で、司令役が外で動かします）。

## 最後の報告の形（日本語）

1. 何を変えたか（関数ごと。R1〜R14 のどれに当たるか）
2. `repairNumberGuards` の siblingNumbers と removeNumbers の式、B の採る条件、`record.status` の式（コードの行）
3. 試験の結果（本数・通過数。落ちたものは名前・エラー・該当箇所）
4. 期待を変えた既存の試験の名前と理由（全部）
5. 指示書と違うやり方をした所と、その理由
6. 【要確認】迷った点
