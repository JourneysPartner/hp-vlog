# 01 管理画面をセッション Cookie の認証に載せ替える

背景・決定・厳守事項は `README.md`。用語:

- 「画面 5 本」＝ `admin-home`（`/admin`）・`admin-articles-page`（`/admin/articles`）・`admin-candidates-page`（`/admin/candidates`）・`admin-freshness-page`（`/admin/freshness`）・`admin-analytics-page`（`/admin/analytics`）
- 「読み取り 3 本」＝ `admin-list-articles`・`admin-list-candidates`・`admin-list-analytics`（GET）
- 「書き込み 3 本」＝ `admin-change-article-status`・`admin-save-candidates`・`admin-freshness-action`（POST）
- 「セッション」＝ `lib/review-auth.js` が発行・検証する Cookie `__Host-review_session`
- 「合言葉」＝ `reviewAuth.csrfToken(session, key)`（ヘッダ `X-Review-Token` で送る）

> **実装後の訂正（2026-11-19）**: A1 の `/admin` は一覧に入れていない。承認画面の既存の試験（`test-review-auth.js` の試験 5・F7）が `safeNext('/admin') === '/review'` を固定しており、その試験を直さないことを優先した。`ADMIN_PAGES` は `/admin/articles`・`/admin/candidates`・`/admin/freshness`・`/admin/analytics` の 4 つで、管理トップ（`/admin`）でログインした後は `/admin/articles` を開く。以下の「5 つの道筋」はこの 4 つに読み替える。

## A `lib/review-auth.js` に足すもの（これ以外は変えない）

### A1 `safeNext` が管理画面の 5 つの道筋も通す

- 値が次の 5 つのどれかと**完全に一致**するときは、その値を返す: `/admin`・`/admin/articles`・`/admin/candidates`・`/admin/freshness`・`/admin/analytics`。
- 一覧は `ADMIN_PAGES`（凍結した配列）として持ち、export する。
- それ以外は今の動きのまま（`/review?…` だけ通し、他は `/review`）。問い合わせ文字列・`#`・末尾の `/`・符号化（`%2f` など）・`/admin/api/…` が付いたものは一致しないので `/review` になる。

### A2 ログイン画面の文言を行き先で分ける

- `loginPage(next, …)` で、`safeNext(next)` が `ADMIN_PAGES` のどれかのときだけ、`<title>` と見出しを「管理画面にログイン」、ボタンを「管理画面を開く」にする。
- それ以外（承認画面）は今の文言のまま。フォームの送り先（`/review-login`）・`next` の符号化・スクリプト・ヘッダは変えない。

### A3 記録（`audit`）を外から使えるようにする

- `createReviewAuth` の戻り値に `audit(event, reason)` を足す（B4 で使う）。中身は変えない。

## B `lib/admin-auth.js` を作り直す

`requireBasicAuth` を無くし、次の 4 つを export する。試験のため `createAdminAuth({ reviewAuth, env, sleep })` の形で作り、既定の部品で作ったものを export する（`review-auth.js` と同じ考え方）。

### B1 `requireAdminPage(event, pagePath)`（画面 5 本用）

- `reviewAuth.requireSession(event)` を呼ぶ。
  - 401 のとき: `{ response: reviewAuth.loginPage(pagePath) }`（ステータス 401 のログイン画面。`pagePath` は関数ごとに固定の文字列で、要求の中身から作らない）。
  - それ以外の失敗（503）: その応答をそのまま `{ response }` で返す。
- 通ったとき: `{ session, key, nonce, csrfToken, headers }` を返す。
  - `nonce`: 毎回の乱数（`crypto.randomBytes(18).toString('base64url')`）。
  - `csrfToken`: `reviewAuth.csrfToken(session, key)`。
  - `headers`: `reviewAuth.pageHeaders(nonce)` に `'X-Robots-Tag': 'noindex, nofollow'` を足したもの。

### B2 `requireAdminRead(event)`（`admin-list-articles`・`admin-list-candidates` 用）

- `reviewAuth.requireSession(event)` の結果をそのまま返す（失敗は JSON の 401・503）。

### B3 `requireAdminAction(event)`（書き込み 3 本用）

- `reviewAuth.requireAction(event)` の結果をそのまま返す（送り元 → セッション → 合言葉と `Content-Type: application/json` の順。失敗は JSON の 403・401・503）。

### B4 `requireAnalyticsRead(event)`（`admin-list-analytics` だけ）

次の順で見る。戻り値は `Promise`（待ち時間があるため）。

1. `reviewAuth.requireSession(event)` が通れば通す。
2. 通らず、`Authorization` ヘッダが `Basic ` で始まるときは、自動処理用の読み取りとして次を**全部**確かめる。1 つでも外れたら、**1 秒待ってから**（`sleep(1000)`）JSON の 401（`{ error: '認証に失敗しました' }`、`Cache-Control: no-store`、**`WWW-Authenticate` は付けない**）。
   - `event.httpMethod` が `GET`。
   - `env.CONTEXT` が未設定か `production`（プレビューでは使えない）。
   - `Authorization` ヘッダが 1 つだけ（`headers` と `multiValueHeaders` の重複・食い違いは無効。`review-auth.js` の `header()` と同じ考え方。大文字小文字の違う同名ヘッダが 2 つあれば無効）。
   - `env.ADMIN_BASIC_USER`・`env.ADMIN_BASIC_PASS` がどちらも空でない文字列（未設定・空なら、この道は常に 401。503 にしない）。
   - base64 を戻した値の最初の `:` より前が ID、後ろがパスワード。ID とパスワードを、それぞれ SHA-256 にしてから `crypto.timingSafeEqual` で比べる。**片方が違っても両方の比較を必ず行う**（`&&` で 2 つ目を飛ばさない）。
3. どちらでもなければ、1 の応答（401・503）を返す。

記録: 通ったときは `audit(event, '自動処理の読み取り')`、外れたときは `audit(event, '自動処理の読み取りの失敗')`。ID・パスワード・ヘッダの値は記録しない。

## C 画面 5 本

- 入口を `requireAdminPage(event, '<その画面の道筋>')` に替える。`response` があればそれを返す。**認証を通るまで、GitHub・Blobs・ファイルの読み込みを始めない。**
- GET 以外の 405 は、今と同じく認証の後。
- 200 の応答のヘッダは `auth.headers`（CSP・`X-Frame-Options`・`Referrer-Policy: same-origin`・`nosniff`・`no-store`・`X-Robots-Tag`）。`Content-Type` は `pageHeaders` のものでよい。
- 画面の `<script>` 全部に `nonce="<auth.nonce>"` を付ける。`onclick="…"` などの属性に書いた処理があれば `addEventListener` に移す（今は無いはず。スクリプトが組み立てる HTML の中も含めて確かめる）。
- 書き込みを呼ぶ画面（`admin-articles-page`・`admin-candidates-page`・`admin-freshness-page`）は、合言葉をスクリプトに埋め込み（`review-page.js` の `scriptJson` と同じく、`<` を逃がした JSON で）、POST の `fetch` に `'X-Review-Token'` ヘッダで付ける。`Content-Type` は `application/json` のまま。
- 画面のスクリプトが呼ぶ管理 API（読み取り・書き込みとも）が 401 を返したら、`location.reload()` する（ログイン画面が出る）。
- 画面が固定の文字列（`const HTML = …`）で作られている場合は、要求ごとに nonce と合言葉を差し込む形に直す。差し込みは決まった目印の置き換えで行い、利用者や GitHub から来た値を通さない。
- 見た目・文言・並び・ボタンの動きは変えない。CSP で読み込めなくなるもの（`cdn.jsdelivr.net` の CSS・アイコンの字形は許可済み）があれば、直さずに報告する。

## D 読み取り 3 本

- `admin-list-articles`・`admin-list-candidates`: 入口を `requireAdminRead(event)` に替える。
- `admin-list-analytics`: 入口を `await requireAnalyticsRead(event)` に替える。
- GET 以外の 405 は、今と同じく認証の後。認証を通るまで GitHub・Blobs を読まない。

## E 書き込み 3 本

- 順番は `review-skip.js` と同じ: **POST 以外は 405 → `requireAdminAction(event)` → 中身**。
- `admin-freshness-action.js` の独自の確認（`Content-Type` の 415 と `isSameOriginRequest`）は `requireAdminAction` に含まれるので消す（確認を 1 か所にする）。`exports.isSameOriginRequest` も消す。これで `Content-Type` 無しは 415 → 403、`Origin` 無しで `Sec-Fetch-Site: same-origin` だけの要求は 400 → 403 になる（厳しくなる方向。試験の期待をこの 2 点だけ直し、報告する）。
- 中身の処理と、認証を通った後の応答は変えない。

## F そのほか

- `netlify/functions/` の下に `requireBasicAuth` と `WWW-Authenticate` の文字列を残さない（コメントも直す）。関数の冒頭のコメント「必須認証: HTTP Basic…」は、今の方式に合わせて直す。
- `netlify.toml` は**コメントだけ**直す（「HTTP Basic 認証必須」→「ログイン必須」など）。リダイレクト・ヘッダ・関数の設定は変えない。
- `.github/workflows/export-contact-transitions.yml` は変えない。

## 変更してはいけないもの

- `lib/review-auth.js` の A1〜A3 以外。`review-*.js`、`lib/review-html.js`。
- 管理画面の中身の処理と、認証を通った後の応答の形・画面の見た目。
- `data/`・`content/`・`blog/`・`.github/`・`docs/`（この指示書を含む）。
- 既存の試験の期待（E に書いた 2 点と、認証の方式が変わることによる「Basic ヘッダ → ログインした状態の要求」への差し替えを除く）。

## 試験

新しく `scripts/lib/__tests__/test-admin-auth.js` を作る。GitHub・Blobs・時刻・待ち時間は偽のものに差し替える（認証の部品は差し替えない。ログインした状態の要求は `review-auth-test-helpers.js` の `authenticatedEvent` で作る。必要なら手助けに関数を足してよいが、認証を素通りさせるものは作らない）。`test-admin-freshness.js` が登録されている `package.json` の `masters:test` の並びに、`test-admin-auth.js`・`test-admin.js`・`test-admin-nav.js`・`test-review-auth.js` のうち未登録のものを足す。

1. **Cookie 無し**: 画面 5 本は 401 のログイン画面（題名「管理画面にログイン」、フォームの送り先 `/review-login`、`next` を戻すとその画面の道筋、`admin-nav` など画面の中身が無い）。読み取り 3 本・書き込み 3 本（POST）は JSON の 401 か 403。11 本とも応答に `WWW-Authenticate` が無く、中身の関数（GitHub の取得・書き込み、Blobs、自動処理の起動）が呼ばれない。
2. **正しい Basic ヘッダだけ（Cookie 無し）**: `admin-list-analytics` の GET を除く 10 本は 1 と同じ結果で、中身の関数が呼ばれない。`admin-list-analytics` への POST も通らない。
3. **壊れた Cookie**: 署名の 1 文字違い・期限切れ・別のパスワードで作ったもの → 11 本とも通らない。
4. **ログインした状態の画面 5 本**: 200。CSP・`X-Frame-Options: DENY`・`Referrer-Policy: same-origin`・`X-Content-Type-Options: nosniff`・`Cache-Control: no-store`・`X-Robots-Tag` がある。HTML の `<script` は全部 nonce 付きで CSP の nonce と一致。HTML に `on…=` の属性が無い。nonce は要求ごとに違う。書き込みを呼ぶ 3 画面には、そのセッションの合言葉と `X-Review-Token` の送り方が入っている。別のセッションでは合言葉が違う。
5. **書き込み 3 本の確認**: ログインしていても、合言葉無し・違う合言葉・別のセッションの合言葉 → 403。`Origin` が違う（`https://deploy-preview-1--x.netlify.app`）・`Origin` も `Referer` も無い → 403。`Content-Type` が `text/plain` → 403。`CONTEXT=deploy-preview` → 403。**どの場合も中身の関数が呼ばれない。**全部そろったときだけ中身に進む（今ある試験の中身の確認がそのまま通る）。GET は 405。
6. **自動処理用の読み取り**（`admin-list-analytics`）: 正しい ID・パスワードの GET → 200。パスワード違い・ID 違い・`:` 無し・base64 でない値 → 401、`sleep(1000)` が 1 回、`WWW-Authenticate` 無し、Blobs を読まない。`ADMIN_BASIC_USER`／`ADMIN_BASIC_PASS` が未設定・空 → 401（空の ID・空のパスワードの Basic ヘッダでも通らない）。`CONTEXT=deploy-preview` → 401。`Authorization` が重複（`authorization` と `Authorization`、`multiValueHeaders` に 2 つ）→ 401。ログインした状態なら、Basic ヘッダが間違っていても 200。記録の出力に ID・パスワード・IP そのものが無い。
7. **`safeNext`**: 5 つの道筋はそのまま返る。`/admin/`・`/admin/articles?x=1`・`/admin/articles#x`・`/admin/api/list`・`/admin/../review`・`/administrator`・`//admin`・`/admin%2farticles`・`https://evil.example/admin` → どれも `/review`。
8. **ログインの流れ**: `next=/admin/articles` と正しいパスワードで `POST /review-login` → 303、`Location: /admin/articles`。その Cookie で管理画面も、承認画面の `requireSession` も通る。間違ったパスワード → 401 のログイン画面で、題名は「管理画面にログイン」、`next` は保たれる。
9. **ログイン画面の文言**: `next` が管理画面なら「管理画面にログイン」「管理画面を開く」。`/review?file=x.md` なら今の文言のまま。
10. **残り物の確認**: `netlify/functions/` の下のファイルに `requireBasicAuth`・`WWW-Authenticate` の文字列が無い（試験でファイルを読んで確かめる）。`admin-*.js` の 11 本すべてが `lib/admin-auth` の B1〜B4 のどれかを呼んでいる。
11. **既存の試験**: `test-review-auth.js` は**直さずに**全部通る。`test-admin.js`・`test-admin-nav.js`・`test-admin-freshness.js`・`test-contact-transition.js` は、Basic ヘッダで通していた所をログインした状態の要求に替えて通す（`test-admin.js` の Basic 認証そのものの試験 1〜6 は、B1〜B4 の試験に置き換える）。`test-contact-transition.js` の自動処理の読み取り（462 行付近）は Basic ヘッダのまま通ること。

**認証を外して通す・期待を緩める直し方はしない。**期待を変えたら、箇所と理由を報告する。
