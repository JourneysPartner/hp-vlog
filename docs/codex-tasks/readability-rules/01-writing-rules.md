# 01 読みやすい日本語の決まりを書く時点の指示に足す

## R1 決まりの定数を作る

`scripts/lib/article-prompt-static.js` に定数 `READABILITY_RULES` を作り、`module.exports` に足す。`STATIC_RULES` より前で定義する（R2 で埋め込むため）。

本文は次のとおりにする（1 字も変えない。行頭の空白も含めてこのまま）。

```
═══ 読みやすい日本語（AI の文章に出やすい癖を避ける）═══
この節より、正確性のルール（出典・数値・条件・例外）と穏当な表現のルールを優先する。
読みやすくするために、条件・例外・注意書き・数値を削ったり丸めたりしない。
- 主語と述語を対応させる。制度・書類・数字を人のように動かさない
  （❌「この書類があなたを守ってくれます」→ ⭕「この書類を残しておくと、税務調査で取引を説明しやすくなります」）
- 修飾と条件がどこにかかるかを明確にする。条件が3つ以上重なる文は、文を分けるか箇条書きにする
- 1文はおおむね30〜45字を平均の目安にし、読点は1文に0〜2個を目安にする。間を作るだけの読点は打たない
- 英語を一語ずつ写した言い回し（「〜を可能にします」「〜にフォーカスします」）を使わず、ふつうの日本語で書く
- 見出しは本文の中身をそのまま表す言葉で書く。本文に出てこない比喩を見出しにしない
  （❌「申告という山を越える」→ ⭕「申告までの手順」）
- 「重要なのは」「ポイントは」などの前置きで文を始めない。伝えたい中身から書く
- 「AではなくB」は、A が読者の実際の誤解（収入と所得の取り違えなど）のときだけ使う。意味の増えない対比は書かない
- 地の文では、絵文字、ダッシュ（——、―）、文末のコロン（「〜は次のとおり：」）を使わない。文は「。」で終える
- 文末の「と言えるでしょう」は、区分を判断した結果を述べるときのほかは使わない
- 法令・通達の用語（課税標準、所得控除、特例など）は言い換えない。慣用句や自然な言い回しまで無理に言い換えない
```

定数の直前に、次の内容のコメントを日本語で書く。

- 出どころ: yomiyasu-pocket（https://github.com/nanaism/yomiyasu-pocket 、commit `c42712c4f79b1b66c06c2b63404d0f6692d46134`）の決まりを、推敲の指示から書く時点の指示に直したもの。文の長さと読点の目安は yomiyasu v2.4.0 の README の「7つの変換原則」から。
- ライセンス: MIT（Copyright (c) 2026 nanaism）。全文は `docs/third-party/yomiyasu-pocket-LICENSE.txt`。
- 新規の生成（`STATIC_RULES`）と差し戻しの全文書き直し（`generate-draft.js` の `regenerateWithContentModel`）で同じ定数を使う。部分の書き直しには入れない（理由は「変更してはいけないもの」）。

## R2 固定ルールに入れる

`STATIC_RULES` の「═══ 文体・トーン ═══」の節（「穏当で信頼感のある…」「読者に直接語りかける視点…」の 2 行）の直後、「═══ 禁止事項 ═══」の前に、空行 1 つを挟んで `${READABILITY_RULES}` を 1 回だけ埋め込む。その後ろにも空行 1 つを置き、「═══ 禁止事項 ═══」に続ける。

## R3 リード文の例からダッシュを外す

`STATIC_RULES` の「【冒頭の型】」の 1) の例を、次のとおり置き換える。

変更前:
```
   例:「レジ横に置いた自販機の売上、レシートも出ないし帳簿にどう書けばいいのか——
      決算の直前になって手が止まる方は少なくありません。」
```

変更後:
```
   例:「レジ横に置いた自販機の売上は、レシートも出ないので帳簿への書き方に迷いがちです。
      決算の直前になって手が止まる方は少なくありません。」
```

`STATIC_RULES` のうち `READABILITY_RULES` を除いた部分に、「——」と「―」が残らないことを確かめる。ほかに見つかった場合は直さず、場所を最終報告に書く。

## R4 差し戻しの全文書き直しに入れる

`scripts/generate-draft.js` の `regenerateWithContentModel` で組み立てる `systemPrompt` の「═══ 文体・トーン ═══」の節（4 行）の直後、「═══ 禁止事項 ═══」の前に、R2 と同じ形（前後に空行 1 つ）で `${READABILITY_RULES}` を 1 回だけ埋め込む。`READABILITY_RULES` は `./lib/article-prompt-static` から読み込む。

## R5 試験

`scripts/lib/__tests__/test-readability-rules.js` を新しく作る。書き方は同じフォルダの既存の試験（`test-conditional-rules.js` など）に合わせる。

1. `READABILITY_RULES` が文字列で、「═══ 読みやすい日本語」で始まり、`正確性のルール`・`30〜45字`・`0〜2個`・`ダッシュ（——、―）`・`重要なのは`・`と言えるでしょう`・`課税標準` を含む。
2. `STATIC_RULES` が `READABILITY_RULES` をちょうど 1 回含む。
3. `STATIC_RULES` の中で、`READABILITY_RULES` が「═══ 文体・トーン ═══」より後、その後の最初の「═══ 禁止事項 ═══」より前にある。
4. `STATIC_RULES` から `READABILITY_RULES` を取り除いた文字列に、「——」も「―」も含まれない。R3 の変更後の例の 1 行目を含む。
5. `buildGenerationPrompt` の結果で、`staticSystem` が `READABILITY_RULES` を含み、`dynamicSystem` と `user` は含まない（固定部分に置かれていて、キャッシュの対象になる）。引数は既存の試験（`test-prompt-builder.js`）の最小の形を使う。
6. `regenerateWithContentModel` を偽の `contentModel.generateSimple` で動かし、渡された `system` が `READABILITY_RULES` をちょうど 1 回含み、「═══ 文体・トーン ═══」より後、その後の最初の「═══ 禁止事項 ═══」より前にある。偽の関数の差し込み方は既存の試験（`test-generation-review-fixes.js`・`test-fact-plan-01.js` など）に合わせる。ネットワークは使わない。
7. 部分の書き直し（`regenerateSection`・`regenerateTargeted`）の AI への指示に `READABILITY_RULES` が入らない。6 と同じ偽の関数で確かめられる場合だけ書き、確かめられない場合は理由を最終報告に書く。

## 変更してはいけないもの

- `STATIC_RULES` のほかの文（R2 の埋め込みと R3 の例のほか）、`CONDITIONAL_RULES`（論点別ルール）、`DISCLAIMER_TEXT`（免責の文）、字数の表と補正（`WORD_COUNT_*`・`LENGTH_OVERSHOOT*`・`TOKEN_ESTIMATES_BY_MODEL`）。
- 差し戻しの指示のうち、R4 の埋め込みのほかの文。
- 部分の書き直し（`regenerateSection`・`regenerateTargeted`・`scripts/lib/partial-revise.js`・`scripts/lib/body-patches.js`）、鮮度の更新、題名・要約の作り直しの指示。既存の記事の一部だけを直す処理で、全体の文体の決まりを渡すと、直す対象の外まで書き換えて本文の短縮の見張りに当たるおそれがあるため。
- `data/banned-phrases.json`（禁止表現）、事実照合（`scripts/lib/fact-check.js` ほか）、モデルの設定（`content-model.js`・`gateway-model.js`・`aux-model.js`）、ワークフロー。
- `content/posts/`・`data/`。
