# 01b 受け入れとレビュー 1 回目の直し

01 の実装（未コミットの作業ツリー）に対する、司令役の受け入れ確認と Opus 5.5 xhigh の差分レビュー（結論「直してからマージ」）の直し。要件の番号は 01 の続き。01 の要件・安全の条件 S1〜S9 はそのまま有効。

実装担当の【要確認】3 点（reason・suggestion も 300 字で切る／同じ行の重複は dropped に数えない／古い記録・読めない記録では出さない）は、このままでよい。

## 直すこと

### R15（High）B の答えの `where` が数値でも読む

今は `typeof row.where === 'string'` のときだけ読むので、`"where": 45` は捨てられる。本物の AI は番号を数値で返すことが多い。

- `where` が文字列で、前後の空白を除いて `'title'`・`'summary'` ならそれ。そうでなければ、元の値（数値・`"45"`・`"[45]"` など）をそのまま `unitNumber` に渡す。
- 試験の偽の AI は、本物と同じく数値の番号で返す形を主にする（T16 を数値に変え、文字の番号の行も 1 つ残す）。

### R16（Medium）形の違う行は失敗として止める

R7 の確かめを 2 つに分ける。

- 形の違い → 答え全体を R9 の失敗（`failed: true`、`revise`）にする:
  - 行がオブジェクトでない
  - `where` が `'title'`・`'summary'` でも、`unitNumber` で読める番号でもない
  - `text` が空でない文字列でない
  - `correction` が文字列でない
- 中身の違い → 今のとおりその行だけ捨てて `dropped` に数える:
  - 番号に当たる単位が無い
  - `text` が対象に無い
  - 直した文そのもの（R20）
  - 知らない `correction`

詳細の画面（`renderFactCheck` の B の所だけ）で、`dropped` が 1 以上なら `AI が挙げたが採らなかった ${n} 件` を小さく出す。照合の要点のカードには出さない。

### R17（Medium）止めた理由を、後の照合へ引き継ぐ

今は B が「その回に直しが入ったとき」しか動かない。そのため、差し戻しの再生成や手動の照合し直しで止めが消え、食い違う見出し・要約が残ったまま `ok` になりうる。

- `checkArticle` は、記事の照合記録のファイル（`recordPath(slug, options.recordDir)`）があれば読む（`previousRaw` の有無に関係なく）。`slug` が同じで `consistency` がオブジェクトのときだけ、次を `checkFacts` に渡す。読めない・壊れているときは渡さず、照合は続ける。
  - `previous_consistency`: 記録の `consistency`
  - `previous_consistency_afters`: 記録の `corrections` のうち、id が `consistency.corrections` にあるものの `after` の配列
- `checkFacts` は、B の後・状態を決める前に、次を引き継ぐ。
  - `previous_consistency.findings` のうち、形が正しく（where・text が文字列）、`text` が今もそのまま在るもの:
    - title なら今の題名に、summary なら今の要約に、body なら最後の本文（`revisedBody`）に在る
    - 今回の findings と同じ（where, text）のものは足さない
    - 足すときは `carried: true` を付ける
  - `previous_consistency.failed === true` で、今回 B が動いておらず（`record.consistency` が無い）、`previous_consistency_afters` が 1 件以上あって全部が最後の本文に在るなら、`failed` を引き継ぐ（`carried: true`）。
  - 引き継いだものは、R8 の状態・要約の式でそのまま止める理由になる。
- 画面では、引き継いだ行に `（前回の照合から引き継ぎ）` を添える。
- `repair: false`（公開済みの一括照合など、`checkFacts` を直接呼ぶ所）は `previous_consistency` を渡さないので変わらない。

### R18（Medium）A で外す数字を、資料の文に在る数字だけにする

今の siblingNumbers は sibling の `correct` の数字をそのまま使う。判定・要件・手続・番号の食い違いの `correct` は資料で数字を確かめていないので、`correct` が元の文の資料の無い数字（例「約2万円」）を言い直すと、資料なしの見張りが外れる。

```
evidenceNumbers = [g.quote || '', g.quote_notes || ''].flatMap(text => expandYearDates(normalizedNumbers(text), text))
  + (g.keep_numbers || []) の数字
siblingNumbers = （01 の candidates）.filter(n => n !== null && evidenceNumbers.includes(n))
```

g は sibling ごとに計算する（ある sibling の数字は、その sibling の資料の文で確かめる）。#796 の c42 で要る 10・195万・330万・20 は、全部 c42 の quote に在る。

### R19（Medium）C の当たる条件を、同じ文・所得税に絞る

R11 の条件を次に置き換える（今の 3 つの条件はそのまま）。

- `t.__body` を `/[。！？\n]/` で文に分ける。次を全部満たす文が 1 つでもあれば当たる。
  - 区切りの金額（R11 の正規表現）がある
  - `/税率|課税所得|課税される所得/` がある
  - 相続税・贈与税の文ではない。`/相続税|贈与税|相続|贈与|遺産/` があり、`所得税` が無い文は除く。`t.tax_domain` が `inheritance_tax`・`gift_tax` のときは、その文に `所得税` があるときだけ当たる。

### R20（Low）直した文の判定を、本文の位置で行う

今の `after.includes(unit.text)` は、「はい。」のような短い単位を、直した文と関係なく捨てる。

- 最後の本文の中で、applied の各 `after` が出てくる位置（全部の出現）を範囲にする。
- 単位の `[start, end)` がどれかの範囲と重なるときだけ、直した文として捨てる。

### R21（Low）見出しそのものが指摘のときの場所

対象の単位が見出しなら、行に `heading_unit: true` を付け、`heading` は `''` にする。画面の場所は `本文の見出し` と出す。

### R22（試験）

01 の試験に次を足す・直す。

- T10 の前半: 直しを有効にし、全部が裏付けありで直しが入らない照合で、consistency_check を呼ばず、`consistency` の欄が無いこと（今の前半は `not_run` で終わっていて B まで届いていない）。
- T7: `corrections` の件数（2）と、c42・c43 が両方 `resolved` であることを見る。
- R9: `options.signal` を中断済みにして consistency_check で例外を投げると、`checkFacts` が例外を投げる（`failed` にしない）。失敗の `error` に偽の AI の応答の文が入らない。
- T24（R15）: `where` が `45`（数値）・`"45"`・`"[45]"` の行を、どれも同じく採る。
- T25（R16）: 形の違う行（文字列の行・`where: '本文'`・`text: 1`・`correction: ['c1']`）が 1 つでもあれば `failed`・`revise`。中身の違いだけなら今のとおり。詳細の画面に `AI が挙げたが採らなかった` が出る。
- T26（R17）:
  - 前回の記録の findings の text が今も在り、今回は直しが無い → 引き継いで `revise`、`carried: true`、画面に `前回の照合から引き継ぎ`。
  - text が無くなっている → 引き継がず `ok`。
  - 前回が `failed` で、直した文が今も在る → `failed` を引き継ぐ。直した文が無い → 引き継がない。
  - 記録のファイルが無い・壊れている → 今までどおり。
  - `checkArticle` に記録のファイルの場所（`recordDir`）を渡して確かめる。
- T27（R18）: 判定の食い違いの `correct` が「…所得税は約2万円増えます。」で、quote に 2万円が無いとき、同じ文の資料なし（約2万円）の見張りは外れず、「約2万円」を残した置き換えは採らない。T1（c42・c43）は今のとおり通る。
- T28（R19）:
  - 当たらない文: 「課税遺産総額が4,000万円の場合、相続税の税率は20%です。」「贈与額が900万円なら贈与税の税率は30%です。」
  - 当たらない本文: 「課税所得の考え方を説明します。売上が900万円の年もありました。」（別の文）
  - `tax_domain: 'inheritance_tax'` の本文で所得税の語が無い文も当たらない。
  - T19 の文は当たる。
- T29（R20・R21）: 「はい。」だけの単位を指す行は、直した文と関係なければ採る。見出しの単位を指す行は `heading_unit: true` で、画面に `本文の見出し`。

### R23 字下げ

01 で既存の試験の偽の AI に足した行の字下げを、周りの行に合わせる（中身は変えない）。

## 直さないこと（README に記録済み）

- `generate-draft.js` の `validateRepair` は `findUnappliedRules` を使う。照合の直しが新しく区切りの金額と税率を同じ文に入れると、直し全体が採られない（止める側。レビューの Low 5）。
- 表の行では、食い違いの直しが資料なしの列の見張り（「外さない列を書き換えています」）に弾かれる。今回の差分より前からの穴。

## 変えてよいファイル・変えてはいけないもの

01 と同じ。加えて、`checkArticle` が記録のファイルを読むのは R17 のためだけにする。書き込みは今のとおり。
