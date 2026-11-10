# 依頼: 前に言葉を足す直しで食い違いが消える穴（N7）を、1 回目と 2 回目の照合で合わせて塞ぐ

あなたは実装担当です。このリポジトリ（税理士事務所のサイト hp-vlog。記事の事実照合の仕組みを含む）で、指示書どおりに実装し、試験を書いて通してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/fact-recheck-n7/01-n7.md`（この依頼の指示書。言葉の決まり、要件 R1〜R6、試験 T1〜T11、既存の試験の扱い、変えてよいファイル、変えてはいけないもの）
2. `docs/codex-tasks/fact-recheck-n7/README.md`（背景・方針・安全の条件 N-S1〜N-S6）
3. `scripts/lib/fact-check.js` の `checkFacts`（特に 1649〜1898 行）・`normalizedClaim`・`sentenceRows`・`blockingFinding`、`scripts/lib/fact-units.js` の `splitUnits`
4. `scripts/lib/__tests__/test-fact-repair-retry.js`（試験の手本。偽の AI の作り、`budget`。N1-2 は 690 行、N5-1 は 788 行）

## 必ず守ること（安全の条件）と、それを確かめる試験

- N-S1 止める側にだけ変わる。今 `revise` の照合が `ok` になることは無い（T1〜T3・T6・T9 は `revise` に変わり、T4・T5・T7・T8・T10 は今と同じ）。
- N-S2 照合の後の本文は今と 1 字も違わない。AI の呼び出しの回数・種類も同じ（全部の試験で `r.body` と `budget` を確かめる）。
- N-S3 置き換えの中に元の誤りの文を含む文が無いときは、今と同じ（既存の試験が全部通る）。
- N-S4 期限の書き漏れと条件確認の扱いは今と同じ（T5・T8、既存の条件確認の試験）。
- N-S5 fact-repair-retry の S1〜S8 はそのまま（`test-fact-repair-retry.js` が全部通る）。
- N-S6 照合全体を `not_run` にする道を増やさない。

## 試験の動かし方

このシェルでは `sbx` だけが使えます。1 本ずつ次の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

```
sbx node scripts/lib/__tests__/test-fact-recheck-n7.js
```

少なくとも次を動かし、結果を報告してください: test-fact-recheck-n7.js、test-fact-repair-retry.js、test-fact-check.js、test-review-page-fact-layout.js、test-review-page.js、test-fact-check-override.js、上の 13 本、それと `scripts/lib/__tests__/` の他の `test-fact-*.js` 全部。子プロセスの起動が EPERM で落ちる試験があれば、その試験名だけ報告してください（サンドボックスの制約で、司令役が外で動かします）。

## 最後の報告の形（日本語）

1. 何を変えたか（関数・行ごと。R1〜R6 のどれに当たるか）
2. 足した 3 つの条件の式（コードの行をそのまま）
3. 試験の結果（ファイルごとの本数・通過数。落ちたものは名前・エラー・該当箇所）
4. 期待を変えた既存の試験の名前と理由（版の文字列のほかに全部）
5. 指示書と違うやり方をした所と、その理由
6. 【要確認】迷った点
