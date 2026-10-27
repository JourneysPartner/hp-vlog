# 01 LINE の枠をリンクにし、押された回数を数える

README.md の「全段階共通の厳守事項」を先に読むこと。

## R1 お問い合わせページの枠を 1 つのリンクにする（`templates/pages/contact.html`）

`<!-- LINE -->` の `<div class="line-cta-box">…</div>` を、次の形の `<a>` に置き換える（見出し・説明文の文言は今のまま）。

```html
<!-- LINE -->
<a class="line-cta-box" href="https://lin.ee/u1IDDuS" data-track="line">
  <h4><i class="bi bi-chat-dots-fill me-2"></i>LINEでのご相談も受付中</h4>
  <p>LINEからお気軽にメッセージをどうぞ。スピーディにご返信します。</p>
  <span class="btn-line">LINEで相談する</span>
</a>
```

- `target` と `rel` は付けない（同じタブで開く。LINE の公式の友だち追加ボタンのコードと同じ）。
- `href="#"` はページ内に残さない。
- 他のテンプレート（`index.html` の「LINEでも気軽に相談OK」など）は変えない。

## R2 見た目（`assets/css/style.css` の `.line-cta-box`・`.btn-line`）

- 枠（`a.line-cta-box`）: `display: block`、文字色は白のまま（全体の `a { color: inherit }` で見出し・説明文・ボタンの色が変わらないこと）、下線なし、`cursor: pointer`。
- ホバーとキーボードで選んだとき（`:hover`・`:focus-visible`）: 枠を 2〜3px 浮かせ、影を少し濃くする。文字色は白のまま。
- キーボードで選んだとき（`:focus-visible`）: 枠の外側に、緑の背景と灰色の地の両方で見える輪郭を出す（例: `outline: 3px solid var(--color-secondary); outline-offset: 3px;`）。
  マウスでクリックしただけのときは輪郭を出さない（`:focus` ではなく `:focus-visible` を使う）。
- 中の `.btn-line`: 見た目（白地・緑字・丸い形・大きさ）は今のまま。今の `.btn-line:hover` の浮き上がりは、枠のホバー時の
  `.line-cta-box:hover .btn-line`（と `:focus-visible`）に移す。浮き上がりは枠だけにし、ボタンを二重に動かさない。
- 動きを減らす設定（`prefers-reduced-motion: reduce`）では浮き上がりをしない。ファイル末尾の既存の
  `@media (prefers-reduced-motion: reduce)` があればそこに足す。
- 他のクラスの見た目は変えない。

## R3 ビーコンで LINE が押されたことを送る（`scripts/build.js` の `ANALYTICS_BEACON`）

- 既存の先頭の判定（本番のホストでない・Do Not Track）で `return` したあとは何もしない（今までどおり）。
- 送る処理（`sendBeacon`、失敗時は `fetch` の `keepalive`）を 1 つの関数にまとめ、閲覧の送信と LINE の送信の両方で使う。
  閲覧の送信の中身・順番・`sessionStorage` の扱いは変えない。
- `document.addEventListener('click', …)` を 1 つ登録する。押された要素から `closest('a[data-track="line"]')` で
  リンクを探し、見つかった時だけ次を送る。
  - `{ p: location.pathname, e: 'line' }`
  - 現在のページが問い合わせページ（既存の `isContact`）で、`sessionStorage` の `mz_contact_from` に値があれば `r` にその値を足す。
    `sessionStorage` が使えない時は `r` なしで送る（例外で送信を止めない）。
- `preventDefault` しない。押した要素が要素でない・`closest` が無い場合も例外にしない。
- `data-track="line"` を付ければ、今後ほかのページに LINE のボタンを置いても同じく数えられる形にする（パス名で絞らない）。

## R4 受け口で LINE の送信を受け付ける（`netlify/functions/lib/analytics-store.js`）

- `parseBeaconPayload` が受け付けるキーを `p`・`r`・`e` にする。`e` があるときは**文字列 `'line'` と完全に一致する時だけ**受け付け、
  それ以外（別の文字列・数値・空文字・null など）は本文ごと `null` を返す。
- 戻り値を `{ path, ref, event }` にする。`event` は `'line'` か `null`。`e` が無い送信の `path`・`ref` は今と完全に同じにする。
- `ref` の条件は今のまま（現在ページが問い合わせ・送信完了ページで、遷移元が許可されたパス、かつ問い合わせ・送信完了ページでない時だけ）。
- `path` は今までどおり許可リストに無ければ `null`。
- 新しく `lineKey(date)`（`line/<日付>`）と `incrementLine(store, date, fromPath, options)` を足し、既存の `incrementFrom` を使う。保存の形は
  `transitions/`・`submissions/` と同じ `{ date, total, byFrom }`。両方を `module.exports` に足す。
- `parseBeaconBody` の戻り値は今のまま（パスだけ）。

## R5 受け口の処理（`netlify/functions/track-visit.js`）

`event === 'line'` の送信では、本番判定・ボット判定・訪問者の Cookie の扱いは今のままにしたうえで、次だけを行う。

1. 1 分あたりの重複除外: `markRate(store, minute, vidHash, 'line:' + path)`（閲覧の重複除外と別のマーカーになる）。
   作られなかった（同じ人が同じ分にもう押している）時は何も増やさず 204 を返す。
2. `incrementLine(store, date, ref || path)`。つまり、問い合わせページの前に見ていたページが分かればそのページ、分からなければ押したページ
   （問い合わせページなら `/contact.html`）として数える。
3. 2 が `false`（書き込みの再試行切れ）の時、または例外の時は、閲覧の時と同じく自分が作った重複除外のマーカーだけを消す。
4. `markUnique`・`incrementPageview`・`incrementTransition`・`incrementSubmission` は呼ばない。

`event` が `null` の送信の処理は今と同じにする。

## R6 管理画面の API（`netlify/functions/admin-list-analytics.js`）

- 日ごとの行（`daily` の各要素）に `lineFrom`（`line/<日付>` の `byFrom`。無ければ `{}`）を足す。読み込みは既存の 4 つと同じ
  `Promise.all` の中で行う。
- 返す JSON の最上位に、90 日分を合計した `lineFrom` を足す（`contactFrom`・`submittedFrom` と同じ作り方。正の整数だけ足す）。
- 既存のフィールドは変えない。

## R7 管理画面のアクセス解析（`netlify/functions/admin-analytics-page.js`）

- 「問い合わせにつながったページ」「送信完了につながったページ」の並びに、3 つ目のパネル「LINE 相談につながったページ」を足す。
  一覧の作り方は既存の `renderFrom(rows, 'lineFrom', '<id>')` を使う。
- 見出しの下（または横）に、選択中の期間の合計回数を「合計 N 回」と出す。期間ボタン（7・30・90 日）で切り替わること。
- 説明文: 「選択中の期間に、お問い合わせページの『LINEで相談する』が押された回数です。ページ名は、問い合わせページの前に見ていたページです
  （直接来た場合は『お問い合わせ』）。同じ人が 1 分以内に続けて押した分は 1 回と数えます。友だち追加まで進んだかは、LINE 公式アカウントの管理画面で確かめてください。」
- 3 枚のパネルが横幅 720px 以下でも崩れないこと（既存の `.from-panels` の作りに合わせる。必要なら 3 列にし、狭い画面では 1 列）。
- 値はすべて既存の `escapeHtml` を通して出す。

## 変更してはいけないもの

- 上に書いたファイル以外（試験ファイルと、この指示書のフォルダを除く）。特に `content/`、他のテンプレート、`netlify.toml`、
  `analytics-cleanup.js`、`analytics-page-map.json`、`.github/workflows/`、`scripts/lib/inquiry-signals.js`。
- 既存の許可リスト（`FIXED_PATHS`・`PRETTY_PATHS`・`isAllowedPath`）、`MAX_BODY_BYTES`、`isProductionRequest`、`isBot`。
- 既存の試験の期待値（既存の試験を弱めたり消したりしない。ビーコンの試験で偽の `document` に `addEventListener` を足すような、
  新しい作りに合わせるための補助の変更はよい）。

## 試験

既存の試験ファイルに足す（新しいファイルにした場合は PR 本文に書く）。

1. `test-analytics-store.js`（`parseBeaconPayload`）
   - `{"p":"/contact","e":"line"}` → `{ path: '/contact.html', ref: null, event: 'line' }`
   - `{"p":"/contact","e":"line","r":"/blog/x/"}` → `ref: '/blog/x/'`
   - `e` が `'LINE'`・`'other'`・`''`・`1`・`null`・`true` → `null`
   - 許可リストに無いパスで `e: 'line'` → `null`
   - 知らないキー（例 `x`）が付いていれば `e: 'line'` でも `null`
   - `e` の無い既存の送信の戻り値は `event: null` で、`path`・`ref` は今と同じ（既存の試験はそのまま通る）
   - `incrementLine` が `line/<日付>` に `{ date, total, byFrom }` で積み上がる
2. `test-track-visit.js`（偽の store を使う既存の作りで）
   - LINE の送信 1 回で `line/<日付>` の `total` が 1、`byFrom` が遷移元（無ければ `/contact.html`）で 1。`daily/`・`uniq/`・`transitions/`・
     `submissions/` は作られない・増えない。
   - 同じ訪問者が同じ分に 2 回送ると 1 回だけ数える。閲覧の重複除外マーカーとは別で、同じ分に閲覧と LINE の両方が数えられる。
   - 本番でないホスト・ボットの UA・`e` が `'line'` 以外では何も保存しない。
   - `incrementLine` の書き込みが再試行切れの時・例外の時に、自分の重複除外マーカーが消える。
3. `test-contact-transition.js`（`build.js` の実際のビーコン文字列を動かす既存の作りで）
   - 問い合わせページで `a[data-track="line"]` の中の要素（例: `.btn-line` の `<span>`）を押すと、`{ p: '/contact', e: 'line', r: '/blog/x/' }`
     が送られる（`mz_contact_from` に `/blog/x/` がある時）。無い時は `r` なし。`sessionStorage` が壊れている時も `r` なしで送られる。
   - `data-track="line"` の無いリンクやリンク以外を押しても送られない。
   - 本番でないホスト・Do Not Track の時は、読み込み時もクリック時も何も送られない（クリックの受け手が登録されないか、登録されても送らない）。
   - クリックで `preventDefault` が呼ばれない。
   - 閲覧の送信（読み込み時の 1 回）の中身は今までの試験どおり。
4. 生成されたお問い合わせページ（`npm run build` 後のルートの `contact.html`）に、`href="https://lin.ee/u1IDDuS"` と `data-track="line"` を持つ
   `<a class="line-cta-box"` があり、`href="#"` のリンクが無いこと。試験の置き場所は既存の生成ページの試験に合わせる
   （`test-contact-transition.js` が生成ページを読んでいればそこに足す）。
5. 管理画面: `admin-list-analytics.js` に偽の store を渡して呼び、日ごとの `lineFrom` と最上位の `lineFrom`（合計）が返ること。
   既存のフィールドが変わらないこと。認証は既存の試験のやり方に合わせる（`requireBasicAuth` を通す環境変数・ヘッダー）。
   鍵の形の文字列は使わない（README の厳守事項）。
