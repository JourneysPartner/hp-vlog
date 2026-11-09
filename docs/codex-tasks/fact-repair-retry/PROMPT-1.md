# 依頼: 再照合で「まだ誤り」と出た自動修正を、もう 1 回だけ直し、だめなら元の文に戻す

あなたは実装担当です。このリポジトリ（税理士事務所のサイト hp-vlog。記事の事実照合の仕組みを含む）で、指示書どおりに実装し、試験を書いて通してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/fact-repair-retry/01-repair-retry.md`（この依頼の指示書。要件 R1〜R8、試験 T1〜T13、既存の試験の扱い、変えてはいけないもの）
2. `docs/codex-tasks/fact-repair-retry/README.md`（背景と安全の条件 S1〜S8）
3. `scripts/lib/fact-check.js` の `checkFacts`（特に 1597〜1714 行）・`repairBody`・`repairInstructions`・`correctionPairs`・`changedText`・`call`・`analyze`・`matchesCorrection`・`blockingFinding`
4. `netlify/functions/review-page.js` の `renderFactCheck`・`renderFactReviewItems`・`factReviewGroups`
5. `scripts/lib/__tests__/test-fact-check.js`（偽の AI `fake` の作り。151 行の試験はこの依頼で期待が変わる）
6. `docs/codex-tasks/fact-repair-retry/fixtures/failed-fixes.json`（T3・T4・T10 の試験データ）

## 変えてよいファイル

- `scripts/lib/fact-check.js`
- `netlify/functions/review-page.js`（R7 の表示だけ）
- 新しい試験 `scripts/lib/__tests__/test-fact-repair-retry.js`
- `scripts/lib/__tests__/test-fact-check.js` の 151 行の試験（名前と期待を指示書のとおりに）
- 次の 13 本の試験の中の版の文字列 `plan2-s7` → `plan2-s8` の置き換え（21 か所。期待値のそれ以外は変えない）:
  test-fact-check-03o.js test-fact-check-03r.js test-fact-check-03u.js test-fact-check-03v.js test-fact-cost-03n.js test-fact-discarded-claims.js test-fact-keep-supported.js test-fact-plan-01.js test-fact-plan-02.js test-fact-precision-03l.js test-fact-repair-notes.js test-fact-review-fixes-4.js test-fact-table-numbers.js
- 他の既存の試験は、2 回目が動くために結果が変わるものだけ、期待を直してよい。直したものは全部、報告に名前と理由を書く。試験を消さない・弱めない。

これ以外のファイル（`data/`・`content/`・`fact-evidence.js`・`generate-draft.js`・`validate.js`・承認の関数・ワークフロー・設定・パッケージ）は変えないでください。

## 必ず守ること（安全の条件）と、それを確かめる試験

- S1 2 回目は 1 回の照合で多くても 1 回。修正の呼び出しは 2 回以下、再照合は 2 回以下（T13）。
- S2 1 回目の再照合で、置き換えた文の中に食い違い・期限の書き漏れが無いときは、本文・記録とも今と同じ（R1 の指示の追記と版を除く）（T2）。
- S3 最後の本文に、最後の再照合で食い違い・期限の書き漏れと出た置き換えが残らない（T3・T4・T9・T10）。
- S4 元に戻した文は、書き手の元の文と 1 字も違わない。他の修正・他の文は変わらない（T4・T7・T9）。
- S5 元に戻した記事は `revise` のまま、元の指摘が `remaining` に残る（T4）。
- S6 採らなかった修正案と再照合の指摘が `corrections` と `review_items` に残り、承認画面に出る（T4・T11）。
- S7 2 回目の途中の失敗は元の文に戻す側に倒す。照合全体を `not_run` にしない（T5・T6）。
- S8 条件確認だけの修正の扱い（1675〜1698 行）は変えない。戻した置き換えが、その処理の作り直しで本文に戻らない（T8）。

## 試験の動かし方

このシェルでは `sbx` だけが使えます。1 本ずつ次の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

```
sbx node scripts/lib/__tests__/test-fact-repair-retry.js
```

少なくとも次を動かし、結果を報告してください: test-fact-repair-retry.js、test-fact-check.js、test-review-page-fact-layout.js、test-fact-check-override.js、test-fact-ai-supported-numbers.js、test-fact-number-guard.js、test-fact-repair-notes.js、test-fact-table-numbers.js、test-fact-keep-supported.js、上の 13 本、それと `scripts/lib/__tests__/` の他の `test-fact-*.js` 全部。子プロセスの起動が EPERM で落ちる試験があれば、その試験名だけ報告してください（サンドボックスの制約で、司令役が外で動かします）。

## 最後の報告の形（日本語）

1. 何を変えたか（関数ごと。R1〜R8 のどれに当たるか）
2. 2 回目の対象の決め方と、元に戻すときの本文の作り直しの式（コードの行）
3. 試験の結果（本数・通過数。落ちたものは名前・エラー・該当箇所）
4. 期待を変えた既存の試験の名前と理由（全部）
5. 指示書と違うやり方をした所と、その理由
6. 【要確認】迷った点
