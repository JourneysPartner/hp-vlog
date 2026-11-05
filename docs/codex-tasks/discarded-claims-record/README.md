# 捨てた主張を照合の記録と確認の画面に残す（2026-11-05）

## 何が起きたか

2026-11-04 の日次記事（PR #741「せどりの確定申告は雑所得？」）は、2 回の再生成（144baa86・94d7c380）で本文は直ったが、照合の記録が「捨てた主張 1」で `revise`（承認できない）のまま止まった。主張 57 件はすべて裏付けあり、残った食い違い 0・未解決 0。

照合の記録（data/fact-check/<slug>.json）にも確認の画面にも、**どの文の、どの主張を捨てたのか**が残っていない。記録にあるのは件数（`discarded`）と要約の「捨てた主張 1」だけ。人は本文と記録を突き合わせて推定するしかなかった（推定: 「この要件に加えて、e-Taxで申告するか、…控除は最高65万円になります。」の金額の主張）。

## 原因（コード）

- `extractClaims`（scripts/lib/fact-check.js）は、抜き出しの AI が返した主張のうち、指した文に要約の数字・語が見つからないものを「本文に見つからない」、種類・制度名・要約の形が不正なものを「主張の形式が不正」として `discardedClaims` に入れる（文・要約・種類・制度名・理由が揃っている）。
- `checkFacts` の `analyze` は、`discardedClaims` を次のように扱う。
  - 数字の主張（`isNumericClaim`）と、種類が 8 語のどれでもない主張 → 数（`uncheckedNumeric`）だけを足す。この数が 1 以上なら `status` は `revise`（承認を止める）。**中身はどこにも残らない。**
  - 要件・判定・手続の主張 → 「人が確かめる箇所」（`review_items`）に入る（承認は止めない）。
- 記録の `discarded` は件数だけ。

## 方針

- **承認の判断は変えない（fail-closed のまま）。** `status`・`remaining`・`review_items`・`uncheckedNumeric`・`blockingFinding`・承認の歯止め（netlify/functions/review-approve-background.js）は変えない。捨てた主張は今までどおり数え、数字の主張なら今までどおり承認を止める。
- 足すのは「記録に一覧を書く」と「画面に一覧を出す」だけ。
- 判定は変わらないので `LOGIC_VERSION` は上げない。前の記録の使い回しの条件（`prior.discarded === 0` など）も変えない。
- 承認の判断が変わる形になりそうなら、実装せずに止めて報告する（毛利の指示 2026-11-05）。

## 段階

| 段 | 内容 | 指示書 |
|---|---|---|
| 1 | R1〜R4（抜き出しで指した文を残す・記録の一覧・確認の画面・変えないことの確かめ） | `01-discarded-claims.md` |

## 全段共通の厳守事項

- 変えてよいファイルは `01-discarded-claims.md` の「変えてよいファイル」だけ。
- 公開済みの記事、data/ の全部（data/fact-check/ の既存の記録を含む）は変えない。
- 通信しない（AI の呼び出しを含む）。偽の AI で試験する。
- 画面に出す文字（AI の返した要約・制度名・文）は、必ず既存の `factSentence`・`escapeHtml` を通す。

## 元に戻す方法

この枝のコミットを revert する。記録に欄が 1 つ増えるだけで、判定は変わらない。戻した後の記録にこの欄が残っていても、読む側が無視するので害は無い。

## 受け入れ確認（Claude）

1. 指示書の試験と、照合・確認の画面の関係する試験がすべて通る（main で落ちる既存の試験は除く）。
2. 既存の試験の `status`・`remaining`・`review_items`・`summary` の期待値を 1 つも変えていない（変えたら理由が報告にある）。
3. #741 の記録の形（捨てた主張 1・数字の主張）で、確認の画面の要点に「数字を照合できなかった主張で承認が止まっている」ことと、その文・要約が出る。

## コードの入口

- `scripts/lib/fact-check.js` — `extractClaims`（518 行あたり。`discardedClaims` を作る所は 600 行あたり、書き手資料モードの抜き出し直しで消す所は 621 行あたり）、`checkFacts` の `analyze`（1442 行あたり。捨てた主張を数える所は 1466〜1471 行あたり）、修正の前の控え `beforeRepair` と、条件確認だけの修正を戻す所（1575・1641 行あたり）、要約（1668 行あたり）、`compactRecord`（63 行）
- `netlify/functions/review-page.js` — `renderFactCheckSummary`（161 行）・`renderFactCheck`（191 行）・`renderFactReviewItems`（120 行）・`factSentence`（72 行）
- 試験: `scripts/lib/__tests__/test-fact-*.js`、確認の画面は `scripts/lib/__tests__/test-review-page-fact-layout.js`
