# 02 テスト

## 追加先

`scripts/lib/__tests__/test-nta-qa-split.js` に足す。ネットワークには出さないこと。

id を決める処理を関数に切り出して `module.exports` に出し、そこをテストする。

```js
buildEntryId(docId, qNo)          // 1件ぶんの id
resolveEntryIds(docId, parts)     // 分割結果すべてぶん（衝突の解消を含む）
```

## `buildEntryId`

| 入力 | 期待 |
|---|---|
| `jirei` + `問4` | `jirei-4` |
| `jirei` + `問４` | `jirei-4` とは違う id（全角の印が付く） |
| `jirei` + `問12` | `jirei-12` |
| `jirei` + `問1-1` | `jirei-1-1`（ハイフンは残る） |
| `gaiyo` + `問１` | `gaiyo-1` とは違う id |

**半角の id が従来と変わらないこと**を明示的に確かめること（回帰の要）。

## `resolveEntryIds`

実データの形で確かめる。

```
入力: [ {qNo:'問３', title:'問３ 水産物の販売'},
        {qNo:'問3', title:'問3 通信販売'} ]
→ 2つとも別の id になる
→ 半角の '問3' は 'jirei-3' のまま
```

**順序に依存しないこと**（今回いちばん大事）。

```
上の配列と、順序を入れ替えた配列で、
「qNo → id」の対応が完全に一致すること
```

全角・半角以外の理由で衝突した場合（同じ qNo が2回来るなど）も、
両方が残り、id が異なり、順序を入れ替えても対応が変わらないこと。

## 重複した file_path を index に入れない

index を組み立てる処理を関数に切り出してテストする。

- 同じ `file_path` を持つ2件を渡すと、1件だけになること
- 別の `file_path` なら両方残ること
- 残るのが先に来たほうであること（順序が決まっていること）

## 既存の分割ガードが壊れていないこと

#610 で入れたガード（`【答】` 必須・150字・点線・本文短縮の見送り・孤児の削除）の
テストが全部通ること。**緩めないこと。**

## 回帰確認

```
node scripts/lib/__tests__/test-nta-qa-split.js
node scripts/lib/__tests__/test-nta-qa-scope.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-selector.js
npm run build
```

`npm run build` は `assets/js/tax-simulator-boot.js` に差分を出すことがある。
出たら `git checkout -- assets/js/tax-simulator-boot.js` で戻すこと。
