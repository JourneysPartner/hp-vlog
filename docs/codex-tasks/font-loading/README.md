# フォントの読み込みで表示を止めない（font-loading）

2026-11-06 毛利決定「直す」（X の SEO ポストの検討の F）。

## 背景と数字

この PC の Chrome で Lighthouse 12（性能のみ）を測った結果（2026-11-06、本番）:

| ページ | スマホ | パソコン |
|---|---|---|
| トップ | 55 点・FCP 12.6 秒・LCP 12.8 秒 | 78 点・1.8 秒 |
| 商品券の記事 | 60 点・4.4 秒・4.5 秒 | 73 点・2.3 秒 |
| サービス一覧 | 69 点・4.9 秒・5.1 秒 | 79 点・2.0 秒 |

CLS は全ページ 0。表示を止めている資源（render-blocking）は Google Fonts の CSS（Noto Sans JP 400/700 と Zen Old Mincho 700、CSS だけで 90KB、字形ファイル多数）と Bootstrap の CSS（jsDelivr）。推定の短縮は 11 秒。

## 方針

- **読み込み後の見た目は今と同じ**（同じ書体・同じ太さ）。変えるのは読み込み方だけ。
- フォントの CSS を非同期にし、フォントが届くまでは端末の日本語書体で先に文字を出す。
- Bootstrap の CSS は配置に要るので止めたままにし、接続だけ先に始める。

## R1 フォントの CSS を非同期にする

公開ページのテンプレート 24 本（`git grep -l "fonts.googleapis.com/css2" -- templates`）の head で、今の

```html
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&family=Zen+Old+Mincho:wght@700&display=swap" rel="stylesheet">
```

を次に置き換える（URL は今と同じもの。preconnect の 2 行は今のまま残す）:

```html
<link rel="preload" href="（同じ URL）" as="style">
<link rel="stylesheet" href="（同じ URL）" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="（同じ URL）"></noscript>
```

- テンプレートに直接書かれている。build.js 側で head を組み立てている箇所があれば、そこも同じにする。
- 公開ページには CSP が無い（netlify.toml の CSP は /tools/* だけ）ので onload は動く。/tools/* と管理画面・レビュー画面（netlify/functions/*-page.js）は**変えない**。

## R2 Bootstrap の CDN へ先に接続する

同じ 24 本で、Bootstrap の CSS の link の前に `<link rel="preconnect" href="https://cdn.jsdelivr.net">` を 1 行足す。Bootstrap の CSS・JS の URL・版・defer は変えない。

## R3 代わりの書体を指定する

assets/css/style.css の変数を、フォントが届く前に近い見た目で出るようにする:

```css
--font-family:  'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif;
--font-display: 'Zen Old Mincho', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', serif;
```

先頭の書体（読み込み後の見た目）は変えない。

## R4 試験

scripts/lib/__tests__/test-performance-basics.js に節を足す（既存の確かめは消さない・弱めない。「2. フォントは2ウェイト」は新しい形でも通るように読み取りを直すのは可）:

1. 対象の全ページで、Google Fonts の CSS を読む `rel="stylesheet"` に `media="print"` と `onload="this.media='all'"` がある。
2. 同じ URL の `rel="preload" as="style"` と `<noscript>` の読み込みがある。
3. `media` の無い（表示を止める）Google Fonts の stylesheet が無い。
4. `https://cdn.jsdelivr.net` の preconnect がある。
5. style.css の 2 つの変数の先頭が今と同じ書体で、代わりの書体が入っている。

## 変更してはいけないもの

- 書体・太さ・フォントの URL、Bootstrap の版と URL、netlify.toml、tools/、netlify/functions/
- 記事・データ（content/、data/）

## 受け入れ確認（Claude）

- test-performance-basics.js・build・validate・masters:test が通る。
- 試し公開（deploy preview）で、トップ・記事・サービス一覧を Lighthouse でスマホ・パソコンとも測り、上の表と比べる。CLS が 0 のままであること。
- 試し公開の画面で、フォントが読み込まれた後の見た目が本番と同じであること（スクリーンショットで比べる）。

## 元に戻す方法

この枝のマージコミットを revert。
