# 01 捨てた主張を記録と確認の画面に残す（R1〜R4）

背景と方針は README.md。枝 `feat/discarded-claims-record`（origin/main 2c5fb9c2 の上。#742 のマージ後）。

## R1 抜き出しで AI が指した文を残す（`extractClaims`）

- `discardedClaims` の各要素に、欄 `pointed_sentence` を足す。値は、抜き出しの AI が返した番号 `s` が指す文（`units[s - 1].text`。その回の `extractClaims` に渡った本文の文）。
  - 「本文に見つからない」では、今は `sentence` に要約が入るため、どの文の主張か分からない。この欄で分かるようにする。
  - 番号が整数でない・範囲の外なら、欄を作らない。
  - 見出しを指した場合も、その見出しの文をそのまま入れる。
- 他の欄（`sentence`・`heading`・`type`・`subject`・`claim`・`s`・`type_label`・`status`）の値は変えない。
- `claims`・`droppedClaims` には足さない。書き手資料モードの抜き出し直しで消す決まり（621 行あたり）も変えない。

## R2 記録に一覧を書く（`checkFacts`）

- 記録に欄 `discarded_claims`（配列）を足す。記録を作る所（1360 行あたり、`discarded: 0` の隣）で `[]` にする。
- `analyze` で `record.discarded += extracted.discarded` をする所（1466 行あたり）で、`extracted.discardedClaims` の各要素を次の形で `record.discarded_claims` に足す。

  | 欄 | 値 |
  |---|---|
  | `sentence`・`heading`・`type`・`subject`・`claim`・`s`・`type_label`（あれば）・`status`・`pointed_sentence`（あれば） | `discardedClaims` の要素のまま |
  | `stage` | 修正の後の再照合（`rechecking` が真）なら `再照合`、それ以外は `抜き出し` |
  | `blocks_approval` | 承認を止める数（`uncheckedNumeric`）に数える主張なら `true`、「人が確かめる箇所」に回す主張なら `false` |

- `blocks_approval` は、1469 行の条件（`isNumericClaim(c) || (!NUMERIC_TYPES.has(c.type) && !REVIEW_TYPES.has(c.type))`）と**同じ関数**で決める。この条件を小さな関数に出し、`uncheckedNumeric` を足す所と `blocks_approval` を決める所の両方から呼ぶ（2 か所で条件がずれないように）。条件そのものは変えない。
- 「人が確かめる箇所」（`review_items`）に入れる要素は今のまま。`pointed_sentence` は `review_items` に入れない（`addReviewItem` に渡す前に外す）。
- 修正の前の控え `beforeRepair`（1575 行あたり）に `discarded_claims` の写しを入れ、条件確認だけの修正を戻す所（1641 行あたり、`record.discarded = beforeRepair.discarded`）で `record.discarded_claims` も戻す。
- 決まり: 照合が最後まで動いた記録（`status` が `ok`・`revise`）では、いつも `record.discarded_claims.length === record.discarded`。
- `compactRecord` は今のままでこの欄を落とさないはず。落とすなら残す（要素に `evidence` は無いので、表に移す処理は要らない）。
- 前の記録の使い回し（1770 行あたり）の条件は変えない。前の版の記録には欄が無い。読む側は「欄が無い」を「一覧が無い古い記録」として扱う。
- 要約（`summary`）の文は変えない。

## R3 確認の画面に出す（`netlify/functions/review-page.js`）

画面の文はふだんの言葉で書く（英語のコード用語を出さない）。AI が返した文字（文・要約・制度名・種類・理由）は、すべて `factSentence` または `escapeHtml` を通す。

### 詳細（`renderFactCheck`）

「人が確かめる箇所」（`renderFactReviewItems`）の後に、関数 `renderFactDiscarded(record)` の結果を出す。

- `record.discarded_claims` が 1 件以上:
  - `<details>` で、見出しは `捨てた主張 n 件（うち承認を止めている m 件）`（m が 0 なら括弧を付けない）。m が 1 以上なら `<details open>`。
  - 説明の 1 文: `照合の AI が抜き出した主張のうち、本文の文と結び付けられなかったものです。数字の主張は照合できていないため、承認を止めています。`
  - 1 件ごとに枠を 1 つ:
    - 文: `pointed_sentence` があればそれ、無ければ `sentence`（`factSentence`）。
    - `要約: <claim>`
    - `種類: <type> / 制度名: <subject>`
    - `理由: <理由の言い換え>`。`本文に見つからない` → `AI が指した文に、要約の数字や言葉が見つかりませんでした`、`主張の形式が不正` → `AI の答えの形が正しくありませんでした（種類・制度名など）`、それ以外はそのまま。
    - `段階: 最初の照合`（`stage` が `抜き出し`）／`段階: 修正の後の再照合`（`再照合`）。
    - `blocks_approval` が真なら `<div class="text-danger">数字を照合できていないため、承認を止めています</div>`、偽なら `<div class="small">人が確かめる箇所にも載せています（承認は止めません）</div>`。
- 欄が無く、`record.discarded` が 1 以上（古い記録）: `<p>捨てた主張 n 件（この記録には主張の一覧がありません）</p>`。
- 0 件なら何も出さない。

### 要点（`renderFactCheckSummary`）

- 記録が使える（`usable`）とき、`blocks_approval` が真の要素が m 件（m ≥ 1）あれば、`<div class="alert alert-danger">` で `数字を照合できなかった主張 m 件で承認が止まっています。` と、その主張ごとに `<p>文（pointed_sentence か sentence）／要約: claim</p>` を出す。続けて `詳しくは本文の後ろの「捨てた主張」` への案内（既存の `#factCheck` への案内と同じ形でよい）。
- 欄が無く `record.discarded` が 1 以上の古い記録: `<p>捨てた主張 n 件（この記録には主張の一覧がありません）</p>`。
- 既存の表示（状態・承認止めの赤い枠・本文の変更・人が確かめる箇所・候補の外・残った食い違い）は変えない。

## R4 変えないことの確かめ

- 既存の試験の `status`・`remaining`・`review_items`・`summary`・承認の判断に関わる期待値は、1 つも変えない。既存の試験が `discardedClaims` や記録の全体を丸ごと比べていて新しい欄で落ちるときは、新しい欄を期待値に足すだけにし、報告に書く。
- `netlify/functions/review-approve-background.js`・`blockingFinding`・`uncheckedNumeric` の数え方・`LOGIC_VERSION` は変えない。

## 試験（新規 `scripts/lib/__tests__/test-fact-discarded-claims.js`）

偽の AI で、通信なしで動くこと。

1. R1: 「本文に見つからない」の要素に、AI の番号が指す文が `pointed_sentence` として入る。`sentence` は今どおり要約。番号が範囲の外・整数でないと欄が無い。「主張の形式が不正」にも入る。
2. R2: 数字の主張（金額）が「本文に見つからない」で捨てられた記事で、`discarded_claims` が 1 件（`stage` `抜き出し`、`blocks_approval` true、`claim`・`pointed_sentence` が入る）、`discarded` 1、`status` `revise`、`remaining` は空、`review_items` にその主張が無い。
3. R2: 要件の主張が捨てられた記事で、`blocks_approval` false、`status` は他に止める理由が無ければ `ok`、`review_items` には今どおり入り、`review_items` の要素に `pointed_sentence` が無い。
4. R2: 種類が 8 語のどれでもない主張（例 `その他`）は `blocks_approval` true（今どおり承認を止める）。
5. R2: 修正の後の再照合の抜き出しで捨てられた主張は `stage` `再照合` で一覧に入り、件数が `discarded` と合う。
6. R2: 条件確認だけの修正を戻す流れで、`discarded_claims` が修正の前の一覧に戻り、件数が `discarded` と合う。
7. R2: 書き手資料モードの抜き出し直しで回復した主張は一覧に残らない（`discarded` 0、一覧 0 件）。回復しなかった主張は残る。
8. R2: `compactRecord` の後も `discarded_claims` がそのまま残る。
9. R2: 2〜7 のすべてで `record.discarded_claims.length === record.discarded`。
10. R3: 要点に赤い枠と件数・文・要約が出る。詳細に一覧（理由・段階・承認を止める旨）が出て、承認を止めている主張があれば `<details open>`。要約・制度名・文に `<script>` や `"` を入れても、そのまま HTML にならない（エスケープされる）。
11. R3: 欄の無い古い記録で `discarded` 1 なら「この記録には主張の一覧がありません」が出る。`discarded` 0 なら新しい表示は何も出ない。古い記録（本文と一致しない）では出ない。
12. R3: #741 の形（裏付けあり 57 件・残った食い違い 0・未解決 0・捨てた主張 1 件の金額の主張「控除は最高65万円になります」、`status` `revise`）の記録で、要点に「数字を照合できなかった主張 1 件で承認が止まっています。」とその文が出る。

## 変えてよいファイル

- `scripts/lib/fact-check.js`（R1・R2 だけ）
- `netlify/functions/review-page.js`（R3 だけ）
- `scripts/lib/__tests__/test-fact-discarded-claims.js`（新規）
- 既存の試験のうち、新しい欄を期待値に足す必要があるもの（足すだけ）

## 変えてはいけないもの

- 承認の判断: `status` の決め方、`uncheckedNumeric` の数え方の条件、`blockingFinding`、`remaining`、`review_items` の中身、`review-approve-background.js`。
- 抜き出し・判定・修正の AI への指示、`LOGIC_VERSION`、前の記録の使い回しの条件、要約の文。
- 公開済みの記事、data/ の全部。
