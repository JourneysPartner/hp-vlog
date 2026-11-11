# 依頼: 題材選びの試験 test-selector.js の Test 8 を、実データに頼らない形に直す

あなたは実装担当です。このリポジトリ（税理士事務所のサイト hp-vlog）で、指示書どおりに試験を直してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/selector-test-fixture/README.md`（この依頼の指示書。原因、方針、要件 S1〜S4）
2. `scripts/lib/__tests__/test-selector.js`（直す試験。180〜209 行の Test 8）
3. `scripts/lib/topic-selector.js` の `selectDailyTopics` と、`explanation.steps` を作る所（読むだけで、変えない）
4. `scripts/topic-pool.js` の題材の形（読むだけで、変えない）

## 変えてよいファイル

- `scripts/lib/__tests__/test-selector.js` だけ。選び方の本体・題材データ・ほかの試験は変えないでください。

## 必ず守ること

- 試験を消さない・弱めない。Test 8 の前半 2 項目の期待は今のまま。Test 8 の後半とほかの Test は変えない。
- 偽の題材が `filter-target-query` まで届くことを、試験の中で確かめる（S2）。

## 試験の動かし方

`sbx` だけが使えます（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

```
sbx node scripts/lib/__tests__/test-selector.js
```

## 最後の報告の形（日本語）

1. 何を変えたか（S1〜S4 のどれに当たるか。偽の題材の中身をそのまま）
2. 試験の結果（通過数・失敗数）
3. `explanation.steps` で、偽の題材がどの段を通ったか（段の名前と数）
4. 指示書と違うやり方をした所と、その理由
5. 【要確認】迷った点
