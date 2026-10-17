# 01 レビュー画面と承認などの処理の認証

背景・方針・厳守事項は `README.md`。用語: 「3 つの処理」＝ `review-approve-background`・`review-revise`・`review-skip`。

## R1 共通の部品 `netlify/functions/lib/review-auth.js`（新規）

レビューの認証に関わることを 1 か所にまとめ、画面と 3 つの処理から使う。試験のため、時刻・Blobs・環境変数を差し替えられる形にする（`track-visit.js` の `getStoreFn` と同じ考え方）。

## R2 設定と鍵

- パスワード: 環境変数 `REVIEW_PASSWORD`。**未設定、または 12 文字未満なら設定の誤りとして、画面も処理も 503**（理由は「レビューのパスワードが未設定です」程度。値や長さは出さない）。
- 署名の鍵: HKDF-SHA256 で作る。
  - 元の秘密: `REVIEW_SESSION_SECRET` があればそれ（32 文字以上でなければ 503）、無ければ `GH_APP_PRIVATE_KEY`。どちらも無ければ 503。
  - salt: `REVIEW_PASSWORD` の SHA-256。**パスワードを変えると、それまでのセッションは全部無効になる。**
  - info: `hp-vlog review session v1`。
- パスワードの比較: 入力と設定値をそれぞれ SHA-256 にしてから `crypto.timingSafeEqual`（長さで差が出ないように）。

## R3 セッション Cookie

- 名前 `__Host-review_session`。属性 `HttpOnly; Secure; SameSite=Lax; Path=/`（`Domain` は付けない）。`Max-Age` は 12 時間（43200 秒）。
- 中身: `base64url(JSON{ v:1, iat, exp, sid })` + `.` + `base64url(HMAC-SHA256(鍵, 前半))`。`sid` は 16 バイトの乱数。
- 確かめ方: 形・署名（`timingSafeEqual`）・`v`・期限（`exp` が今より後、`iat` が未来でない、`exp - iat` が 12 時間以下）を全部見る。どれか違えば無効。
- 期限の延長はしない（12 時間で入り直し）。
- ログアウト: `POST /review-logout`（R6 と同じ CSRF の確認つき）で Cookie を消す（`Max-Age=0`）。画面の右上に「ログアウト」。

## R4 ログイン

- `/review` に有効なセッションが無いとき、レビュー画面の代わりに**ログイン画面**を返す（ステータス 401、本文は HTML）。
  - 入力欄はパスワード 1 つだけ（`type="password"`、`autocomplete="current-password"`、`autofocus`）。ボタン「レビュー画面を開く」。
  - **下書きの本文・題名・照合の記録・ファイル名を、ログイン画面の HTML に一切含めない。** GitHub への取得もしない（ログイン前に取得しない）。
  - 元の URL（`/review?file=…&ref=…`）は、隠し項目 `next` に入れて送る。
- `POST /review-login`（新しい関数 `review-login.js`。`netlify.toml` に `/review-login` → 関数のリダイレクトを足す）:
  - 受け取る形は `application/x-www-form-urlencoded`（ログイン画面のフォーム）。
  - 送り元の確認（R6 の Origin の確認）を行う。
  - 失敗回数の上限（R5）を先に見る。上限なら 429 で「しばらくしてからお試しください」のログイン画面。
  - パスワードが合えば、Cookie を付けて `303` で `next` へ移る。`next` は **`/review?` で始まる同じサイトの道筋だけ**を許す（`//`・`\`・`http`・改行・`/review` 以外は `/review` に置き換える。外のサイトへ飛ばさない）。
  - 合わなければ 401 で「パスワードが違います」のログイン画面（`next` は保つ）。失敗のたびに 1 秒待ってから返す。
- 3 つの処理と `review-logout` に有効なセッションが無ければ 401（JSON）。画面側は 401 を受けたら「ログインし直してください」と出して、ログイン画面へ移す。

## R5 失敗回数の上限（Netlify Blobs、store 名 `review-auth`）

- 送り元の IP（`x-nf-client-connection-ip`、無ければ `x-forwarded-for` の先頭）は、SHA-256（署名の鍵とは別の固定の接頭辞つき）にしてから鍵に使う。IP をそのまま保存・ログ出力しない。
- IP ごと: 15 分間に 5 回失敗したら、その IP は 15 分間ログインできない。
- 全体: 1 時間に 30 回失敗したら、1 時間すべてのログインを止め、Chatwork に 1 回だけ知らせる（既存の通知の仕組み。本文に IP やパスワードを入れない）。
- 成功したら、その IP の失敗回数を消す（全体の数は消さない）。
- **Blobs が読めない・書けないときは、ログインさせない（503）。** 失敗回数を数えられない状態で通さない。
- 数え方は「時刻の窓ごとの数」で足りる（厳密な同時書き込みの整合までは要らない）。

## R6 他のサイトからの操作の乗っ取りを防ぐ（CSRF）

3 つの処理・`review-login`・`review-logout`（いずれも POST）で、次を**全部**満たさなければ 403:

1. `Origin` ヘッダが `https://mori-zeirishi.net` と完全に一致（無い場合は `Referer` の origin で代える。どちらも無ければ 403）。**プレビュー（`*.netlify.app`）からの操作はこれで止まる（README 方針 6）。**
2. 3 つの処理と `review-logout` は、`Content-Type` が `application/json` で、ヘッダ `X-Review-Token` が正しい。
   - トークン＝ HMAC-SHA256(鍵, `csrf:` + セッションの `sid`) の base64url。レビュー画面の HTML に埋め込み、画面のスクリプトが送る。
3. 有効なセッションがある（`review-login` を除く）。

順番は「Origin → セッション → トークン → 中身の処理」。中身の処理（GitHub への書き込み等）は、全部通ってから始める。

## R7 画面の守り（XSS・はめ込み）

レビュー画面とログイン画面の応答に付けるヘッダ:

- `Content-Security-Policy`: `default-src 'none'; script-src 'nonce-<毎回の乱数>'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`
- `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`

画面の作り:

- 画面のスクリプトは `nonce` 付きの 1 つの `<script>` にまとめる。**`onclick="…"` などの属性に書いた処理は CSP で動かなくなるので、全部 `addEventListener` に移す。**ボタンの動き（承認・差し戻し・見送り・見送り＋今後生成しない・コメント欄の開閉）は今と同じにする。
- 今エスケープせずに HTML に出している値を全部エスケープする: 題名（`<title>` と見出し）・要約・カテゴリ・狙う検索語・副の検索語・出典の題名・ファイル名・公開日時の入力値・状態の表示。URL（出典 URL・プレビュー URL）は `https://` で始まるものだけリンクにし、属性はエスケープする。
- 記事本文（`marked` の出力）から、次を除いてから画面に出す: `script`・`style`・`iframe`・`object`・`embed`・`form`・`input`・`button`・`textarea`・`select`・`meta`・`link`・`base`・`svg`・`math` の要素（`script`・`style` は中身ごと）、`on` で始まる属性、`href`・`src` のうち `http:`・`https:`・`mailto:`・`#`・`/` で始まらないもの（`javascript:`・`data:` など）。**主な守りは CSP、これは二重の守り。**本文の普通の書式（見出し・表・箇条書き・太字・リンク）は変えない。
- 照合の欄（#681 の `renderFactCheck`・`renderFactCheckSummary`）は既にエスケープしている。変えない。

## R8 ログに残すもの

- 成功・失敗・上限・設定の誤り・CSRF で止めた件を、IP のハッシュの先頭 8 文字・理由・時刻だけで残す。パスワード・Cookie・トークン・鍵・入力値は出さない。

## 変更してはいけないもの

- 3 つの処理の中身（照合の差し止め、`recommendation` の判定、PR のマージ・閉じる・枝の削除、通知）と、その応答の形（認証を通った後）。
- `lib/admin-auth.js` と管理画面。
- レビュー画面の見た目と並び（#681 の照合の要点・本文・詳細の並び）。足すのは右上の「ログアウト」だけ。
- Chatwork の通知のリンクの形（`/review?file=…&ref=…`）。

## 試験（新しく `scripts/lib/__tests__/test-review-auth.js`）

1. 設定: `REVIEW_PASSWORD` 無し・11 文字 → 画面も 3 つの処理も 503。鍵の元が無い → 503。`REVIEW_SESSION_SECRET` が 31 文字 → 503。
2. Cookie: 正しいものは通る。署名の 1 文字違い・期限切れ・`iat` が未来・`exp - iat` が 12 時間超・形の崩れ・別のパスワードで作ったもの → 全部無効。
3. ログイン画面: Cookie 無しの `/review?file=x.md&ref=draft/x` は 401 のログイン画面で、GitHub の取得関数が**呼ばれない**。HTML に下書きの題名・本文・ファイル名（`x.md`）が無い（`next` の値はエスケープして入る）。
4. ログイン成功: 正しいパスワード → 303、`Location` が `next`、`Set-Cookie` に `__Host-review_session`・`HttpOnly`・`Secure`・`SameSite=Lax`・`Path=/`・`Max-Age=43200`。
5. `next` の検査: `https://evil.example/`・`//evil.example`・`/\evil`・`/review%0d%0aSet-Cookie:`・`/admin` → どれも `/review` に置き換わる。
6. ログイン失敗: 401、1 秒待つ（時刻は差し替えて確かめる）、Cookie を付けない。
7. 上限: 同じ IP で 5 回失敗 → 6 回目は正しいパスワードでも 429。15 分後に入れる。別の IP は入れる。全体で 30 回 → 全部 429、通知は 1 回だけ。成功でその IP の数が消える。
8. Blobs の失敗: 読み書きが例外 → 503、ログインさせない。
9. 3 つの処理: Cookie 無し → 401。Origin 違い（`https://deploy-preview-1--x.netlify.app`・無し）→ 403。トークン無し・違う → 403。`Content-Type` が `text/plain` → 403。**全部通ったときだけ中身の処理が呼ばれる**（中身の関数が呼ばれないことを、止まる場合それぞれで確かめる）。
10. ログアウト: Cookie を消す。CSRF の確認つき。
11. ヘッダ: レビュー画面とログイン画面に R7 のヘッダが全部ある。`<script` は 1 つで `nonce` が CSP と一致。HTML に `onclick=` など `on…=` の属性が無い。
12. エスケープ: 題名・要約・カテゴリ・検索語・出典の題名・ファイル名に `<script>alert(1)</script>` と `"><img src=x onerror=alert(1)>` を入れても、エスケープされて出る。出典 URL が `javascript:alert(1)` ならリンクにならない。
13. 本文の除去: `<script>`・`<img src=x onerror=…>`・`<a href="javascript:…">`・`<iframe>`・`<form>` を含む本文で、それらが無くなる。普通の見出し・表・リンク（`https://`）は残る。
14. ログ: 失敗・成功のログにパスワード・Cookie・IP そのものが含まれない。
15. 実データ: `docs/codex-tasks/review-page-layout/fixtures/` の下書きを、ログインした状態で描くと、#681 の試験と同じ並び（照合の要点 → 本文 → 詳細）で出る。

既存の試験（README の「コードの入口」）は、ログインした状態の要求を作る試験用の手助け（Cookie・Origin・トークンを付ける）を使って通すこと。**認証を外して通す・期待を緩める直し方はしない。**期待を変えたら、箇所と理由を報告する。
