# 02 テスト

## 追加先

`scripts/lib/__tests__/test-nta-qa-scope.js` は scope の判定だけを見ている。
分割のテストは無いので、**新規に `scripts/lib/__tests__/test-nta-qa-split.js`** を作る。

`crawl-nta-qa.js` は実行するとネットワークに出るので、分割関数と目次判定を
`module.exports` に出して、テストからは関数だけを呼ぶこと。
`require.main === module` のときだけクロールが走るようにする（既にそうなっていれば触らない）。

## 目次の判定（`looksLikeTableOfContents`）

点線として扱う文字それぞれで、6文字以上続けば true になること。

```
·（U+00B7）  ・（U+30FB）  ．（U+FF0E）  .（U+002E）  …（U+2026）
```

- 5文字以下は false
- 文字列の**末尾でなくても** true（途中に点線があっても目次とみなす）
- 点線を含まない普通の本文は false

実データの断片で確かめること。

```
"【令和５年 10 月改訂】 ······················································ 22"  → true
"····································· 16"                                    → true
```

## `splitByQuestion`

**目次を落とすこと。**

- `【答】` を含まない塊は出力に入らない
- 点線で終わる塊は出力に入らない
- 150字未満の塊は出力に入らない

**本文は拾うこと。**

- `（見出し）問52 …【答】 …` の形は出力に入る
- 同じ問番号が目次と本文の両方にあるとき、**本文（`【答】` を含むほう）が採られる**
- 目次が先に来ても本文が先に来ても結果が同じであること（**順序に依存しないこと**）

最後のものは今回の不具合の核心（PDF の読み順が実行ごとに変わる）なので必ず入れる。

## 既存の2つの分割関数が壊れていないこと

`splitByNumberedHeading`（暗号資産）と `splitByParenQuestion`（相続）に
目次判定を足したあとも、本文が従来どおり拾えること。

実データから短い断片を作って確かめる。既存のガード（答の有無・150字）は**緩めない**。

## 本文が短くなる更新のガード

保存の判定を関数に切り出してテストする（ファイル書き込みそのものはテストしない）。

| 既存 | 新しい | 期待 |
|---:|---:|---|
| 707字 | 222字 | 見送る |
| 4,827字 | 130字 | 見送る |
| 707字 | 700字 | 書き込む |
| 707字 | 360字（50%超） | 書き込む |
| 200字 | 50字 | 書き込む（既存が300字未満なので比率は見ない） |
| 無し（新規） | 130字 | 書き込む |

## 回帰確認

```
node scripts/lib/__tests__/test-nta-qa-split.js
node scripts/lib/__tests__/test-nta-qa-scope.js
node scripts/lib/__tests__/test-has-substantive-change.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-selector.js
npm run build
```

`npm run build` は `assets/js/tax-simulator-boot.js` に差分を出すことがある。
出たら `git checkout -- assets/js/tax-simulator-boot.js` で戻すこと。

## 実データでの確認（ネットワークに出ずに行う）

`data/nta-qa/keigen/` の既存レコードのうち、`【答】` を含まないものを数える。

```
いま: gaiyo-14 と jirei-42 の2件
```

この2件が「目次判定で落ちる形」であることを、その `body` を
`looksLikeTableOfContents` に渡して確かめること（どちらも点線で終わる）。
