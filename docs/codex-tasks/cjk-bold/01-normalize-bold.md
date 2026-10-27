# 01 太字の前処理

## R1 部品

新規 `scripts/lib/cjk-bold.js` に `normalizeBold(markdown)` を作り、`module.exports = { normalizeBold }` で出す。

変換の規則:

1. 行ごとに処理する。行をまたぐ `**` の対は扱わない（そのまま残す）。
2. コードは触らない: ` ``` ` または `~~~` で囲まれたコードブロックの中の行、行内の `` `…` `` の中。
3. 同じ行の中で、左から順に `**` と次の `**` を対にし、間の文字列 X を `<strong>X</strong>` に置き換える。ただし次の場合は置き換えずに元のまま残す:
   - X が空
   - X の先頭または末尾が空白（半角スペース・タブ・全角スペース）
   - `***` のように 3 個以上続く `*`（`***`・`****` の並びがある行は、その並びを含む対を置き換えない）
4. 対にならずに残った `**`（行の中で奇数個目）はそのまま残す。
5. X の中身（リンク `[…](…)`、HTML、`<a …>…</a>` を含む）は変えない。`marked` が X の中の Markdown を引き続き処理する。
6. 入力が文字列でないときは空文字を返す。改行コード（LF／CRLF）は入力のまま保つ。

## R2 組み込み

- `scripts/build.js` の `generatePost`: `linkTerms(post._body, …)` に渡す本文を `normalizeBold(post._body)` にする（文脈リンクを差し込む**前**に太字を確定させる。これで原因 2 も解消する）。
- ビルドで `marked` を呼ぶ他の箇所（記事の要約・FAQ・ハブの説明文など）があれば、記事本文と同じく `normalizeBold` を通してから渡す。無ければ何もしない（最終報告に「他の呼び出しの有無」を書く）。
- `netlify/functions/review-page.js`: `marked(body)` を `marked(normalizeBold(body))` に、`renderRefreshDiff` の `marked(row.text)` を `marked(normalizeBold(row.text))` にする。`require('../../scripts/lib/cjk-bold')` で読む（既存の `freshness-refresh` と同じ読み方）。

## R3 テスト

新規 `scripts/lib/__tests__/test-cjk-bold.js`（既存テストの流儀: 自前の `assert` と PASS/FAIL 集計、失敗があれば `process.exit(1)`）。`package.json` の `masters:test` の一覧に加える（最後に足す）。

部品の単体テスト（入力 → 期待値）:

| 入力 | 期待 |
|---|---|
| `取引先が**適格請求書（インボイス）**の保存` | `取引先が<strong>適格請求書（インボイス）</strong>の保存` |
| `消費税の**<a href="/blog/x/">輸出免税</a>**の対象` | `消費税の<strong><a href="/blog/x/">輸出免税</a></strong>の対象` |
| `**A**と**B**` | `<strong>A</strong>と<strong>B</strong>` |
| `a ** b ** c` | 変えない（先頭・末尾が空白） |
| `**片方だけ` | 変えない |
| `` `**code**` と **太字** `` | `` `**code**` と <strong>太字</strong> `` |
| ` ```\n**x**\n``` ` | 変えない |
| `| **全額経費** | 説明 |` | `| <strong>全額経費</strong> | 説明 |` |
| `***強調***` | 変えない |
| `行1**\n**行2` | 変えない（行をまたぐ） |
| CRLF の 2 行 `**a**\r\n**b**` | `<strong>a</strong>\r\n<strong>b</strong>` |

ビルドの結合テスト:

- `scripts/build.js` の `main` でビルドしたあと、`blog/<slug>/index.html`（`content/posts` で `review_status` が `published` の記事だけ）の `<article` 〜 `</article>` の中に `**` が 1 つも無い。残っていれば slug と前後 30 文字を表示して失敗にする。
- `ebay-export-invoice-system-impact` の HTML に `<strong>` で囲まれた「国内取引の仕入税額控除」がある。

## 変更してはいけないもの

- `content/posts/*.md`（1 本も変えない）。
- `scripts/lib/internal-linker.js`・`scripts/lib/citation-linker.js` の動き。
- `marked` の版と設定。
- テンプレート・CSS。
