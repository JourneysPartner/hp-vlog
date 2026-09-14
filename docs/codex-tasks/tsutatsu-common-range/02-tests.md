# 02 テスト

## 追加先

既存の `scripts/lib/__tests__/test-tsutatsu.js` に足す。新しいファイルは作らなくてよい。

## 条番号の判定（`looksLikeProvisionNo`）

通ること:

```
181～223共-6 / 23～35共-2 / 183～193共-1 / 194～198共-1
```

通らないこと:

```
181～223共        枝番が無い
～223共-6          左端が無い
181～～223共-6     波記号の連続
181～223～300共-6  1要素に範囲が2回
```

既存の形が今までどおり通ること（**回帰の要。必ず入れる**）:

```
37-13 / 6-4-5 / 37-14の2 / 12の5-1-1 / 1の3・1の4共-1 / 36・37共-1 / 194・195-1
```

## 波記号の正規化（`normalizeProvisionNo`）

```
'181〜223共－6'  → '181～223共-6'   （U+301C → U+FF5E、全角ハイフン → 半角）
'181~223共-6'    → '181～223共-6'   （U+007E → U+FF5E）
'１８１～２２３共－６' → '181～223共-6'  （全角数字も既存どおり半角に）
```

## ページの解析（`parseTsutatsuPage`）

実ページを叩かず、HTML の断片を直接渡して確かめること。

```html
<h2>（支払の意義）</h2>
<p class="indent1"><strong>181～223共－1 </strong>法第4編《源泉徴収》に規定する「支払の際」…</p>
```

- `provisions` が1件で、`no` が `181～223共-1` になること
- `title` が `（支払の意義）` になること
- `body` に本文が入り、条番号が本文の先頭に残っていないこと

## 取りこぼしの報告（`parseTsutatsuPage` の `skipped`）

条番号として読めない `<h2>` ブロック（例：`<strong>参考</strong>`）を渡したとき、

- `provisions` に入らないこと
- `skipped` に1件入り、`title` が取れていること

条番号が全部読めるページでは `skipped` が空配列になること。

## 照合順序（`findProvision`）

カタログを差し替えられる形でテストできないなら、実カタログで次を確かめればよい。

- `findProvision('36-40～43','shotoku')` が `36-40` を返すこと（左端。#605 の回帰）
- `findProvision('181-6','shotoku')` が `181-6` を返すこと（完全一致）
- `findProvision('181～223共-6','shotoku')` が **`181-6` を返さないこと**
  （カタログ再生成前は `null`、再生成後は `181～223共-6` 自身。どちらでも
  「`181-6` にすり替わらない」ことだけを見る）

最後のものは #605 で作り込んだ防壁なので、**必ず残すこと**。

## 回帰確認

```
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-nta-qa-scope.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-partial-revise.js
node scripts/lib/__tests__/test-selector.js
npm run build
```

`npm run build` は `assets/js/tax-simulator-boot.js` に差分を出すことがある。
出たら `git checkout -- assets/js/tax-simulator-boot.js` で戻すこと。
