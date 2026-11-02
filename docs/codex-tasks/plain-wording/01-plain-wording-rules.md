# 01 やわらかい言葉と、書きすぎない細かさの決まり

背景・方針は `README.md`。この段階で、決まりの定数を作り、新規の生成と差し戻しの全文書き直しの指示に入れる。

## R1 決まりの定数

`scripts/lib/article-prompt-static.js` に、`READABILITY_RULES` の定義の直後へ次の定数を足し、`module.exports` に `PLAIN_WORDING_RULES` を足す。本文は下の枠の中を**1 文字も変えずに**そのまま使う（全角の記号・空白・改行も含む）。

定数の上に、次の内容のコメントを書く。
- 2026-11-02 に毛利が PR #737 の差し戻しで指摘した 4 点から作った決まりであること。
- 新規の生成（`STATIC_RULES`）と差し戻しの全文書き直し（`generate-draft.js` の `regenerateWithContentModel`）で、`READABILITY_RULES` の直後に置くこと。
- 部分の書き直しと更新案には入れないこと（`READABILITY_RULES` と同じ理由）。

```
═══ やわらかい言葉と、書きすぎない細かさ ═══
この節より、正確性のルール（出典・数値・条件・例外）と穏当な表現のルールを優先する。
- 気取った言い回しや文学的な言い回しを使わず、読者がふだん使う言葉で書く
  （❌「ふと手が止まるのが税金の扱いです」→ ⭕「気になるのが税金です」）
- 見出し（h2・h3）は、読者がふだん使う言葉で短く書く。読者が自分の状況を確かめる節は、読者の問いの形にする
  （❌「判断の分岐：自分はどこに当てはまるか」→ ⭕「自分はどれに当てはまるか」）
- 見出しに「判断の分岐」「〜の整理」のような漢字の名詞を重ねた言い方を使わない。「：」で前後に分けた見出しも使わない
- 判断のための表・箇条書き・チェックリストには、読者が判断するのに要ることだけを書く。確認先・参照先（タックスアンサーの番号など）の列や項目を足さない
  （❌ 表の列が「状況｜判断｜確認先」→ ⭕「状況｜判断」）
- 問い合わせ先や参照先は、読者が実際にそこへ問い合わせたり調べたりする場面でだけ書く
- 制度・控除・経費などの種類を紹介するときは、全部を並べない。その記事の読者に関係する代表的なものを数個挙げ、「など」で終える
  （❌ 所得控除を16種類すべて並べる → ⭕「所得控除には、医療費控除、社会保険料控除、生命保険料控除、扶養控除、基礎控除などがあります」）
- ただし、対象になるかどうかを決める列挙（源泉徴収の対象になる報酬、特例の対象者・対象資産など）は、資料のとおり削らずに書く
```

## R2 固定ルールへの挿入

`STATIC_RULES` の「═══ 文体・トーン ═══」の節で、今は

```
${READABILITY_RULES}

═══ 禁止事項 ═══
```

となっている箇所を、次の形にする（空行は 1 つずつ）。

```
${READABILITY_RULES}

${PLAIN_WORDING_RULES}

═══ 禁止事項 ═══
```

## R3 差し戻しの全文書き直しへの挿入

`scripts/generate-draft.js` の `regenerateWithContentModel` の指示でも、`${READABILITY_RULES}` と「═══ 禁止事項 ═══」の間を R2 と同じ形にする。`PLAIN_WORDING_RULES` は `READABILITY_RULES` と同じ場所（`article-prompt-static.js` からの読み込み）で受け取る。

部分の書き直し（`regenerateSection` の節の修正・節の追加、`regenerateTargeted`、`regenerateMultiPoint`）と、更新案（`refresh-article` の経路）には入れない。

## R4 リード文の例

`STATIC_RULES` の「【冒頭の型】」の 1) の例を、次のとおりにする（1 行目は今のまま、2 行目だけ変える。行頭の空白も今と同じ）。

今:
```
   例:「レジ横に置いた自販機の売上は、レシートも出ないので帳簿への書き方に迷いがちです。
      決算の直前になって手が止まる方は少なくありません。」
```

後:
```
   例:「レジ横に置いた自販機の売上は、レシートも出ないので帳簿への書き方に迷いがちです。
      決算が近づくと気になる方も多いはずです。」
```

## R5 構成テンプレートの注記

`STATIC_RULES` の「═══ 記事構成テンプレート」の節で、`11. まとめ（結論の再整理）` の行の直後（次の「→ 文字数上限に収まらない場合は」の行の前）に、次の 1 行を足す。

```
→ 上の番号の項目名は節の役割を表す。見出しの言葉は「やわらかい言葉と、書きすぎない細かさ」の見出しの決まりに従い、読者の言葉で書く。
```

## R6 禁止表現の追加

`data/banned-phrases.json` の `phrases` の末尾に、次の 1 件だけを足す。ほかのエントリと `version`・`description` は変えない。JSON の書式（字下げ 2 空白、`appliesTo` は 1 要素ずつ改行）は既存のエントリに合わせる。

```json
{
  "id": "no-te-ga-tomaru",
  "pattern": "手が止ま",
  "humanReadable": "手が止まる",
  "replacement": null,
  "reason": "気取った言い回しで、記事全体が固い印象になる（毛利指摘 2026-11-02、PR #737 の差し戻し）。固定ルールのリード文の例をまねて、既存 281 本中 23 本に出ていた。「気になる」「迷う」など、ふだんの言葉で書く。",
  "appliesTo": ["body"],
  "addedAt": "2026-11-02T00:00:00.000Z",
  "sourceArticle": "youtuber-tax-payment-guide",
  "autoExtracted": false
}
```

`replacement` は `null`（自動置換しない。書き手への指示に禁止表現として載り、本文に出たら警告だけ出す）。

## R7 試験

AI は偽の関数に置き換え、通信は禁止する（`test-readability-rules.js` の `capturePrompts` と同じやり方）。ファイルは作らない。

新しい試験 `scripts/lib/__tests__/test-plain-wording-rules.js` で次を確かめる。
1. `PLAIN_WORDING_RULES` は文字列で、「═══ やわらかい言葉と、書きすぎない細かさ ═══」で始まる。R1 の枠の本文と完全に一致する（試験の中に本文を写して比べる）。
2. `STATIC_RULES` に `PLAIN_WORDING_RULES` がちょうど 1 回あり、`\n\n${READABILITY_RULES}\n\n${PLAIN_WORDING_RULES}\n\n═══ 禁止事項 ═══` の並びになっている。
3. `buildGenerationPrompt` の結果で、`staticSystem` に含み、`dynamicSystem` と `user` に含まない。
4. `regenerateWithContentModel` が AI に渡す `system` に、2 と同じ並びで含む。
5. 部分の書き直し（節の修正・節の追加・最小修正。`regenerateMultiPoint` も偽の AI で呼べるなら含める）の `system` と `user` に含まない。
6. リード文の例が R4 の「後」と空白も含めて一致し、`STATIC_RULES` から `PLAIN_WORDING_RULES` を除いた部分に「手が止ま」が無い。
7. R5 の注記の行が、`11. まとめ（結論の再整理）` の直後にある。
8. `data/banned-phrases.json` に `id` が `no-te-ga-tomaru` のエントリがあり、`replacement` が `null`、`appliesTo` が `["body"]`。`formatForPrompt()` の出力に「手が止まる」を含む。`applyBannedPhrasesToBody('決算の前に手が止まる方もいます。')` が本文を変えず、警告（置換なし）として 1 件記録する。

`scripts/lib/__tests__/test-readability-rules.js` は、R2〜R4 に合わせて次だけを直す。
- 並びの確認を「`READABILITY_RULES` の後に空行 1 つ、`PLAIN_WORDING_RULES`、空行 1 つ、『═══ 禁止事項 ═══』」に合わせる。
- リード文の例の確認を R4 の「後」に合わせる。
- それ以外の確認（ダッシュが無いこと・部分の書き直しに入れないこと等）は残す。`PLAIN_WORDING_RULES` にもダッシュ（——、―）が無いことを確かめる。

## 変更してはいけないもの

- `READABILITY_RULES` の本文、`STATIC_RULES` の上記以外の行。
- `scripts/generate-draft.js` の `regenerateWithContentModel` の文体の節以外。
- 部分の書き直し・更新案・事実照合・字数の受入・題名のルール・書き手のモデルの選び方。
- `content/posts/`、`data/banned-phrases.json` の既存エントリ。
- ワークフロー（`.github/workflows/`）。
