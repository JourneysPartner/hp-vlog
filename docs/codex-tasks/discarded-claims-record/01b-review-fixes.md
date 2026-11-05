# 01b レビュー指摘の修正（2026-11-05、Opus 5.5 xhigh のレビュー）

対象はコミット 16a00e6c（PR #743）。結果は Critical 0・High 0・Medium 1・Low 2。承認の判断は変わっていないことを確認済み。3 件とも直す。

## F1（Medium）照合が途中で失敗した記録（not_run）でも「承認が止まっています」と出る

- 場所: `netlify/functions/review-page.js` の `renderFactCheckSummary`（`discardedBlocking`・赤い枠）と `renderFactDiscarded`（説明の文・1 件ごとの「承認を止めています」・`open`）。
- 起きること: 抜き出しで数字の主張が捨てられた後、判定が API の失敗などで例外になると、`status` は `not_run` になるが、一覧は記録に残り、本文のハッシュも一致するので `usable` になる。画面は「数字を照合できなかった主張 1 件で承認が止まっています。」と出す。`FACT_CHECK_FAIL_OPEN=true` のときは not_run でも承認は止まらないので、文が事実と食い違う。止まっている本当の理由は照合の失敗。
- 直し方:
  - 「承認を止めている」と言う表示は、`factCheckState` が返す `status` が `revise` のときだけにする。対象: 要点の赤い枠、詳細の見出しの「（うち承認を止めている m 件）」、`<details open>`、説明の文の後半、1 件ごとの赤い文。
  - `status` が `revise` でないとき（`not_run` など）:
    - 要点に赤い枠を出さない。
    - 詳細は閉じた `<details>`、見出しは `捨てた主張 n 件`。
    - 説明の文は `照合の AI が抜き出した主張のうち、本文の文と結び付けられなかったものです。照合が最後まで動かなかったため、この一覧は承認の判断に使っていません。`
    - 1 件ごとの「承認を止める／止めない」の行は出さない。
  - `renderFactDiscarded` に `status` を渡す（`renderFactCheck` の中で求めた値）。

## F2（Low）AI の番号が文字列・全角だと `pointed_sentence` が付かない

- 場所: `scripts/lib/fact-check.js` の `extractClaims`（`Number.isInteger(c.s)` の所）。
- 起きること: AI が `s` を `"12"`・`"[12]"`・`"１２"` の形で返すと、`unitNumber` は 12 と読んで文を探すが、`pointed_sentence` は付かない。「本文に見つからない」では、どの文の主張かが残らない（#741 と同じ状態）。
- 直し方: すでに求めている `number`（`unitNumber(c?.s)`）を使い、`number` があり `units[number - 1]` があるときに `pointed_sentence` を付ける。`fields()` の `s` の扱いは変えない。
- `01-discarded-claims.md` の R1「番号が整数でない・範囲の外なら、欄を作らない」は、「番号が読めない（`unitNumber` が読めない）・範囲の外なら、欄を作らない」に読み替える。

## F3（Low）壊れた記録で確認の画面が例外になる

- 場所: `review-page.js` の `renderFactDiscarded`・`renderFactCheckSummary`。
- 起きること: `discarded_claims` が配列でない値（`{}`・`true`・文字列）や、要素に `null` があると TypeError になり、確認の画面が 500 になる。
- 直し方: 両方の関数で、一覧を `Array.isArray(record.discarded_claims) ? record.discarded_claims.filter(c => c && typeof c === 'object') : null` として扱う。`null`（配列でない・欄が無い）なら、今の「欄が無い古い記録」と同じ扱い（`discarded` が 1 以上なら「この記録には主張の一覧がありません」）。

## 試験（`scripts/lib/__tests__/test-fact-discarded-claims.js` に足す・直す）

1. F1: `status` が `not_run` で本文のハッシュが一致し、`blocks_approval` が真の要素がある記録で、要点に赤い枠と「承認が止まっています」が無い。詳細は `<details open>` でなく、「この一覧は承認の判断に使っていません」が出て、「承認を止めています」が無い。同じ記録で `status` を `revise` にすると、今どおり赤い枠・`open`・「承認を止めています」が出る。
2. F1: 本物の `checkFacts` で、抜き出しで数字の主張を捨てた後に判定の偽の AI が例外を投げると `status` が `not_run` になり、その記録を画面に通すと 1 と同じ表示になる。
3. F2: `s` が `"1"`・`"[1]"`・`"１"` のとき、`pointed_sentence` が 1 番目の文になる（今ある `'1'` で欄が無いことを確かめる期待値は、この形に直す）。読めない番号（`"a"`・`0`・範囲の外）では欄が無い。
4. F3: `discarded_claims` が `{}`・`true`・`'x'` のとき、要点も詳細も例外にならず、`discarded` が 1 なら「この記録には主張の一覧がありません」が出る。要素に `null`・数字が混ざっても例外にならず、正しい要素だけが出る。

既存の試験（このファイル以外）は変えない。

## 変えてよいファイル

- `netlify/functions/review-page.js`（F1・F3 だけ）
- `scripts/lib/fact-check.js`（F2 だけ）
- `scripts/lib/__tests__/test-fact-discarded-claims.js`

## 変えてはいけないもの

- 承認の判断（`status`・承認を止める数・`remaining`・`review_items`・要約の文・`review-approve-background.js`）、`blocks_approval` の決め方、記録の欄の形。
- 画面の他の表示。
