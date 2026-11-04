# 01 照合の自動修正で条件付きの別の額を落とさない（R1〜R6）

背景と方針は README.md。枝 `fix/repair-amount-notes`（origin/main 07b067c5 の上）。

## R1 根拠の抜粋に続く注を、修正に渡す

`judgeClaims` で quote（citations）が決まった後、各範囲の**直後**に続く根拠ページの文（page.units）を見る。文の先頭（空白を除く）が次のどれかで始まる間、連続して集める。

- `（注`・`(注`・`※`・`（※`・`ただし`・`なお`

上限は 3 文・合計 600 字。600 字を超える文は入れずにそこで止める。範囲が 2 つのときは範囲ごとに集め、`\n…\n` でつなぐ。

- 集めた文は、結果の新しい欄 `quote_notes`（文字列。無ければ欄を作らない）に入れる。**`quote` そのものは変えない**（引用の存在・数字の近さの確かめ、記録の表示は今のまま）。
- `quote_notes` は、状態が 食い違い・期限の書き漏れ のときだけ付ける（裏付けあり・資料なしには付けない）。
- `repairBody` に渡す corrections の各要素に `quote_notes` を入れる（あれば）。
- 記録（data/fact-check/*.json）の corrections・remaining に `quote_notes` が残ってよい。`compactRecord` で落とす欄の一覧があれば、落とさない。

## R2 修正の規則を足す

`repairInstructions` の 食い違い の instruction（今は「根拠の原文に合わせて、この文だけを直す」）を、次の文字列に置き換える（1 文字も変えない）。

```
根拠の原文に合わせて、この文だけを直す。正しい内容は correct に従う。quote_notes に、条件によって別の額・要件になると書かれているときは、その条件と額も落とさずに書く。元の文が過去の年分を扱っていない限り、過去の年分の扱い（「令和元年以前は」など）は書かない
```

期限の書き漏れ・資料なし・番号の instruction は変えない。`repairBody` の system の文字列も変えない。

## R3 置き換え文の数字を確かめる（食い違い・期限の書き漏れ）

`repairBody` の置き換えの確かめ（今の `reason` の判定の並び）に、状態が 食い違い または 期限の書き漏れ の指摘について次を足す。`enhanced` かどうかに関わらず行う。

- 置き換え文の数字 = `expandYearDates(normalizedNumbers(replacement), replacement)`。
- 許す数字 = 元の文・`correct`・`quote_notes`・`keep_numbers` のそれぞれに同じ処理をした数字の和。
- 置き換え文の数字のうち、許す数字に無いものが 1 つでもあれば、reason を `根拠の正しい内容に無い数字を足しています` とする。読めない数字（null）が置き換え文にあり、元の文に無い場合も同じ reason。
- この reason を `retryReasons` に加える（作り直しの依頼で理由が AI に伝わる）。
- 数字の比べ方は既存の `normalizedNumbers`・`expandYearDates` の正規化に従う（「令和元年」は `日付:令和1` になる）。新しい正規化は作らない。

既存の 資料なし の数字の確かめ（`numberGuards`）は変えない。

## R4 判定の規則を足す

`judgeClaims` の `instruction` の、「特定の年分の値として正しく書いている場合は裏付けありとしてください。」の直後に、次の文字列を足す（1 文字も変えない）。

```
主張が制度の控除額・上限額を「最高」「最大」「上限」などとして述べているのに、原文の注・ただし書きでは条件によって別の額（より高い額など）になると書かれていて、その文にも前後の文にもその条件と額が書かれていない場合は、食い違いとし、correct に条件と額を書いてください。
```

- `LOGIC_VERSION` を `plan2-s3` から `plan2-s4` に上げる（判定の規則が変わったので、前の版の記録を再利用しない）。`plan2-s3` を固定で見ている試験があれば、意図した変更として直す。
- 判定の他の文・例（example）は変えない。

## R5 言葉の決まり（data/banned-phrases.json に 3 件）

既存の項目の形（id・pattern・humanReadable・replacement・reason・appliesTo・addedAt・sourceArticle・autoExtracted）に合わせて末尾に足す。

| id | pattern | humanReadable | replacement | 理由（reason に書く） |
|---|---|---|---|---|
| `no-tegakari` | `手(?:がか\|掛か\|掛)り` | 手がかり | `ポイント` | 毛利指示 2026-11-04（PR #741）。「一つの手がかり」→「一つのポイント」。 |
| `no-jouken-desu` | `常見です` | 常見です | `よくあります` | 毛利指示 2026-11-04（PR #741）。ふだんの言葉にする。 |
| `no-jouken` | `常見` | 常見（〜の誤りなど） | `null`（警告のみ） | 「常見です」以外の形は自動で置き換えると文が崩れるので、人が直す。 |

- pattern の `\|` は表の都合で、JSON では `|`（正規表現の「または」）。
- appliesTo は `["body"]`、addedAt は `2026-11-04T00:00:00.000Z`、sourceArticle は `reselling-income-tax-classification`、autoExtracted は `false`。
- `no-jouken-desu` を `no-jouken` より前に置く（先に「よくあります」へ置き換え、残った形だけを警告する）。並び順で置換が決まることを `applyBannedPhrasesToBody` の実装で確かめ、違えば報告する。
- 公開済みの記事は変えない。

## R6 修正の数え方の調査（報告だけ）

#741 の記録では、c28 の置き換え文が本文に入っているのに、要約は「修正 0（食い違い 0…）・残った食い違い 1」で、c28 は remaining に元の文のまま残っている。置き換えが本文に入ったのに「修正 0」と数えた理由をコードで追い、最終報告に書く（ファイル名と行、どの条件でそうなるか）。**コードは直さない。**

## 試験（新規 `scripts/lib/__tests__/test-fact-repair-notes.js`）

偽の AI で、通信なしで動くこと。題材は #741 の実際の値（下の「題材」）を使う。

1. R1: No.2070 の原文の題材で、quote が「…最高55万円（令和元年以前は最高65万円）を控除することとされています。」で終わる 食い違い の結果に、`quote_notes` として「（注1）令和2年分以後の…最高65万円の青色申告特別控除が受けられます。」が入る。「ロ上記イ以外の…」は入らない。裏付けあり の結果には `quote_notes` が無い。`quote` は変わらない。
2. R1: 3 文・600 字の上限で止まる。
3. R2: 食い違い の instruction が指示書の文字列と一致する。repair に渡る corrections に `quote_notes` がある。
4. R3: 偽の修正 AI が #741 の悪い置き換え（「…最高55万円（令和元年以前は最高65万円）の青色申告特別控除を受けるには、…」）を返すと却下され、reason が `根拠の正しい内容に無い数字を足しています`。良い置き換え（「…最高55万円の青色申告特別控除を受けるには、…この要件に加えて、e-Taxで申告するか、帳簿を優良な電子帳簿として保存していれば、控除は最高65万円になります。それ以外の青色申告者は最高10万円です。」）は採られる（correct に 55万・65万・10万がある前提）。`enhanced` が偽でも却下される。
5. R3: 期限の書き漏れ で、correct にある期限の年月日を足す置き換えは採られ、correct に無い年を足すと却下される。
6. R4: judge の system に指示書の文字列が入っている。`LOGIC_VERSION` が `plan2-s4`。
7. R5: 「営利目的で続けているかどうかが一つの手がかりになります。」→「…一つのポイントになります。」、「思い込むのも常見です。」→「思い込むのもよくあります。」、「常見の誤り」は置き換えず警告 1 件。`formatForPrompt()` に 3 件が出る。
8. 既存: 資料なし の数字の確かめ（keep_numbers を消す・資料の無い数字を残す）の既存の試験がそのまま通る。

### 題材

- 根拠: `data/nta-sources/taxanswer/shotoku/2070.json`（読むだけ。試験では必要な部分を試験の中に写してよい）。
- c28 の値: `git show d99454a8:data/fact-check/reselling-income-tax-classification.json` の `corrections[0]`（sentence・quote・correct・before・after）。隔離の中で git が使えなければ、下の値を使う。
  - sentence: `事業所得にして青色申告をする場合は、複式簿記での記帳と、貸借対照表・損益計算書の添付が前提です。`
  - correct: `青色申告は簡易な記帳でもよいとされており、複式簿記（正規の簿記）による記帳と貸借対照表・損益計算書の添付は、最高55万円（65万円）の青色申告特別控除を受けるための要件です。それ以外の青色申告者は最高10万円の控除となります。`

## 変えてよいファイル

- `scripts/lib/fact-check.js`
- `data/banned-phrases.json`（3 件の追加だけ）
- `scripts/lib/__tests__/test-fact-repair-notes.js`（新規）
- `LOGIC_VERSION` の値を固定で見ている既存の試験（値の更新だけ）

## 変えてはいけないもの

- 照合の方針「案 2」、資料なしの数字の確かめ、`quote` の作り方と既存の確かめ（quoteExists・sufficientQuote・quoteSupportsNumbers）。
- basis の文の数の上限（金額は 2 文・要件は 4 文）。
- `repairBody` の system の文字列、判定の他の文。
- 制度名・金額を規則や処理に書き込むこと（試験の題材の中だけはよい）。
- 公開済みの記事、data/nta-sources/、data/law-sources/、data/fact-check/。
