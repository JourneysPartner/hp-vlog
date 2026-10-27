# 日本語の太字が「**」のまま表示される不具合 — 指示書

2026-10-28 作成。毛利さんの指摘（2026-10-27、`ebay-export-invoice-system-impact` の「eBay輸出セラーとインボイス制度の原則」に「**」がそのまま出ている。「*」は記事に出してはいけない文字）。

## 何が起きているか

記事の Markdown（`content/posts/*.md`）の太字 `**…**` が、公開ページで太字にならず `**` の記号のまま表示される。2026-10-27 時点の手元ビルドで、記事 269 本のうち 37 本・138 か所。

原因は 2 つ。どちらも Markdown 変換（`marked` v9、CommonMark の規則）で `**` が太字の始まり・終わりと認められないこと。

1. **日本語の括弧・句読点に接する `**`（122 か所）**: 例 `取引先が**適格請求書（インボイス）**の保存`。閉じの `**` の直前が `）`（約物）で直後が `の`（文字）なので、CommonMark の規則では閉じにならない。日本語の文章では頻繁に起きる既知の問題。
2. **文脈リンクが `**` のすぐ内側に入る（16 か所）**: `scripts/lib/internal-linker.js` の `linkTerms` が Markdown の段階で `<a href="…">輸出免税</a>` を差し込むため、`消費税の**<a href="…">輸出免税</a>**の対象` になり、`**` の直後が `<`（約物）で始まりと認められない。

## 方針

- 記事のファイル（`content/posts/*.md`）は 1 本も変えない。直すのは変換の段階。
- Markdown を HTML にする前に、同じ行の中で対になる `**…**` を `<strong>…</strong>` に置き換える前処理を 1 か所の部品にまとめ、公開ページのビルドとレビュー画面の両方で使う。
- 今まで正しく太字になっていた箇所の見た目は変えない（`marked` が出す `<strong>` と同じになる）。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-normalize-bold.md` | 前処理の部品・ビルドとレビュー画面への組み込み・テスト |

## 元に戻す方法

この PR を revert する（記事ファイルは変えていないので、ビルドし直せば元の表示に戻る）。

## 受け入れ確認（Claude）

1. 隔離の外で `npm run build`・`npm run validate`・新しいテスト・関連する既存テスト。
2. main と本ブランチでビルドした記事 HTML を突き合わせ、違いが「`**` が `<strong>` になった箇所」だけであること。
3. 本文に `**` が残る記事が 0 本であること。
4. プレビューで `ebay-export-invoice-system-impact` ほか数本を目視。

## コードの入口

- `scripts/build.js` の `generatePost`（`linkTerms` → `linkCitations` → `marked` の順）
- `netlify/functions/review-page.js`（`marked(body)` と `renderRefreshDiff` の `marked(row.text)`）
- `scripts/lib/internal-linker.js`（`linkTerms`。今回は変えない）
