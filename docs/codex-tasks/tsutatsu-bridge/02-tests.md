# 02 テスト

新規に `scripts/lib/__tests__/test-tsutatsu-bridge.js` を作る。既存テストの書き方に合わせること（`test-law-sources.js` が同じ構造の先行例）。

- `assert(cond, label)` を自前で持ち、`結果: N passed, M failed` を出して `process.exit(failed > 0 ? 1 : 0)`
- ラベルは日本語で、何を守っているかが分かる文にする
- 背景をファイル冒頭のコメントに書く（なぜこのテストがあるか）

## 固定してほしいこと

### 1. 引用検出の穴（01 の A）

```
所得税法施行令第14条、第15条、所得税基本通達2-1、3-3
  → 所基通 2-1 と 3-3 の2件が検出される
所得税法第10条、所得税基本通達10-14、10-15
  → 10-14 と 10-15 が検出され、「第10条」を通達番号として拾わない
所得税基本通達181～223共-6
  → 1件検出される
```

### 2. 既存の検出を壊していないこと（01 の A-3）

`所基通36-10` / `消基通5-9-10` / `法人税基本通達9-2-9` / `相続税法基本通達11の2-1` が従来どおり検出・照合できること。

### 3. 橋渡し（01 の B）

- 通達を関係法令に持つ質疑応答事例で、原文ブロックが空でないこと
- そのブロックに通達の条番号と原文が含まれること
- 最大3条に収まること
- カタログに無い通達番号が混ざらないこと
- 出典が無いトピック、カタログ外の URL では空文字を返すこと
- 壊れたレコードでも例外を投げず空文字を返すこと

### 4. 二重添付の防止（01 の C）

差し戻し再生成の `buildRegenSourceBlocks` の戻り値に、今回の橋渡し由来のブロックが混ざっていないこと。

## 実データを使うテストの注意

`data/nta-tsutatsu/` と `data/nta-sources/shitsugi/` は実データなので、**特定の1件の内容に依存した断定は避ける**（クロールで内容が変わりうる）。「この事例なら通達が1件以上引ける」程度に留め、条文の文面そのものを assert しない。

ただし例外として、次の2件は関係法令欄が安定しているので slug を指定してよい。

- `data/nta-sources/shitsugi/shotoku/07/05.json`（関係法令が法律のみ。通達ブロックは空になるはず）
- 通達を含む事例は、テスト実行時に `data/nta-sources/shitsugi` を走査して**最初に見つかったもの**を使う（特定の1件に依存しない）

## 回帰確認

次を実行して、すべて通ること。

```
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-nta-qa-scope.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-partial-revise.js
node scripts/lib/__tests__/test-selector.js
npm run build
```

`npm run build` は `assets/js/tax-simulator-boot.js` を書き換えることがある。差分が出たら `git checkout -- assets/js/tax-simulator-boot.js` で戻し、**コミットに含めない**こと。
