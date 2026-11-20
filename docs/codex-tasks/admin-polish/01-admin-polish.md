# 01 段 3 の実装要件（A・B・C・D・F）

## F. ログイン全体の上限を 1 時間に 10 回へ

F1. `lib/review-auth.js` の `login()` で、全体（記録 `global`）の上限を 30 回から 10 回にする。停止の長さ（1 時間）・数え方（照合の前に確保する・正しいログインも数える）・通知（上限に達したとき 1 回だけ `review_auth_locked`）・IP ごとの上限（15 分に 5 回、記録 `ip/<hash>`）は変えない。
F2. 数字は名前の付いた定数にまとめる（例: `GLOBAL_LOGIN_LIMIT = 10`）。B でも同じ数え方を使うので、数字を散らさない。

## D. ログインの入口で弾かれたときの行き先

D1. `login()` の最初の確認のうち、設定の誤り（503）・送り元の誤り（403）・形式の誤り（403）で弾くとき、`Content-Type` が `application/x-www-form-urlencoded` か、本文に `next=` があれば、本文の `next` を `safeNext()` に通した行き先でログイン画面を出す。そうでなければ今と同じ `/review`。GET など（405）は今と同じ `/review`。（11/20 のレビューで、初めの文「form のときだけ」が試験 2 の「形式の誤り」と食い違うと分かり、実装に合わせて直した。行き先は `safeNext()` の決まった一覧に限られ、`Location` には入らない）
D2. 行き先が管理画面（`ADMIN_PAGES`）のときは、文を「管理画面を開き直してからログインしてください」にする。承認画面のときの文は今のまま（「レビュー画面を開き直してからログインしてください」）。503 の文は今のまま。
D3. この確認の段では、今と同じく Blobs に触れない・パスワードを照合しない・Cookie を出さない。本文を読むのは行き先を決めるためだけ。

## B. 自動処理用の読み取りに失敗回数の上限

B1. `lib/review-auth.js` の `createReviewAuth()` に、自動処理用の読み取りの回数を確保する関数（例: `reserveBasicAttempt(event)`）を足して返す。`login()` と同じ仕組み（`rateRecord`・`readRate`・条件付きの書き込み・競合のときの戻し）を共通の内部の関数にまとめて使う。複製しない。`login()` の記録の名前（`ip/<hash>`・`global`）・形・動きは F 以外変えない。
B2. B の記録は、ログインと別の名前にする: IP ごとは `basic-ip/<hash>`（15 分に 5 回で 15 分止める）、全体は `basic-global`（1 時間に 10 回で 1 時間止める）。ログインの記録と混ぜない（B の失敗で人のログインが止まらないように）。
B3. 全体の上限に達したとき、通知を 1 回だけ送る。種類は新しい `admin_basic_locked`。`lib/notify/message.js` に文を足す: 件名「【ブログ】自動処理の読み取りを一時停止しました」、本文「アクセス解析の自動処理用の ID・パスワードの失敗回数が上限に達したため、1時間止めました。心当たりがない場合は、認証設定とアクセス状況を確認してください。」。通知の失敗は記録だけして先に進む（ログインと同じ）。
B4. `lib/admin-auth.js` の `requireAnalyticsRead()` の順番:
  1. セッションが有効なら今と同じくそのまま通す（回数を数えない）。
  2. `Authorization` が `Basic ` で始まらなければ今と同じ（セッションの 401・503）。
  3. 秘密に関係しない前提（GET・本番の host と `rawUrl`・`ADMIN_BASIC_*` の設定あり・Basic の形が読める）が欠けたら、回数を数えずに今と同じ 401（1 秒待つ）。
  4. 回数を確保する。止まっている・競合した → 429（JSON、`{"error":"しばらくしてからお試しください"}`、`Cache-Control: no-store`、照合しない）。記録の読み書きに失敗 → 503（JSON、照合しない）。
  5. ID とパスワードを照合する（今と同じく両方を必ず比べる）。合えば IP ごとの記録を消して `{ basic: true }`。違えば 1 秒待って 401。
B5. 監査の記録は今と同じ形で、理由に「自動処理の読み取りの上限」「自動処理の読み取りの記録の読み書き失敗」を足す。ID・パスワード・IP そのものは出さない。
B6. `.github/workflows/export-contact-transitions.yml` は変えない（週 1 回の実行なので上限に届かない）。

## A. 管理画面のログアウトのボタン

A1. `lib/admin-nav.js` の `renderAdminNav()` の並びの最後に「ログアウト」のボタン（`<button type="button">`、`.admin-nav` の中だけで効く見た目）を足す。リンクの並び・見た目は変えない。
A2. 画面 5 本（`/admin`・`/admin/articles`・`/admin/candidates`・`/admin/freshness`・`/admin/analytics`）すべてで押せるようにする。合言葉を持っていない画面には、ほかの画面と同じ形（`requireAdminPage()` の `csrfToken` を nonce 付きの script に JSON で埋める）で持たせる。
A3. 押したら `POST /review-logout`（`Content-Type: application/json`、`X-Review-Token: <その画面の合言葉>`、本文 `{}`）。200 なら `location.assign('/admin/articles')`（管理画面のログイン画面が出る）。401 なら同じく `/admin/articles` へ。それ以外は失敗の文を画面に出す（`textContent` で）。押している間はボタンを押せなくする。
A4. 処理は各画面の nonce 付きの script の中で `addEventListener` で付ける。属性に処理を書かない。共通の処理にするなら `admin-nav.js` から文字列で返し、各画面の nonce 付きの script に埋める。
A5. `review-logout.js`・`review-auth.js` の `logout()` は変えない。

## C. 表示のエスケープの総点検（画面 5 本）

C1. 画面 5 本のサーバー側の HTML と、ブラウザで動く script（`innerHTML`・`insertAdjacentHTML`・テンプレート文字列）で、GitHub・Blobs・API・URL の問い合わせから来る値が HTML に入る所をすべて洗い出す。
C2. どれも `& < > " '` の 5 つを置き換えるエスケープを通す。`href`・`src` に入る値は、`https://`・`http://` で始まるものか、`/` で始まり `//` で始まらないものだけにし、それ以外は `#` にする（エスケープもする）。script の中に埋める値は `<` を `<` にした JSON にする（`</script>` で抜けられないように）。
C3. 数・固定の文字列だけが入る所は直さなくてよいが、一覧には「数だけ」と書く。
C4. 見た目・動きは変えない（エスケープの結果は、普通の文字では今と同じ表示になる）。

## 試験

既存の試験の期待を変えてよいのは、F の数字（30 → 10）と、D で行き先・文が変わる所だけ。それ以外の期待を緩めない。

1. F: 全体で 10 回目の確保で止まり、11 回目以降は正しいパスワードでも 429。1 時間後に戻る。通知は 1 回。IP ごとの 5 回・15 分は今と同じ。
2. D: 管理画面の `next` を付けた要求が、送り元の誤り・形式の誤り（本文は form）・設定の誤りで弾かれると、管理画面のログイン画面（題名「管理画面にログイン」、`next` が同じ管理画面、管理画面の文）になる。承認画面の `next`・`next` なし・form でない本文・GET は今と同じ。どれも Blobs に触れず照合しない。
3. B: 正しい ID・パスワードで 200、IP の記録が消える。違うと 401。同じ IP で 5 回違えると、正しい ID・パスワードでも 429 で照合しない。別々の IP で全体 10 回違えると 429・通知 1 回・1 時間後に戻る。記録の読み書きの失敗・競合で照合しない（503・429）。前提が欠けた要求（POST・プレビューの host・設定なし・Basic の形の誤り）は回数を数えない。B の失敗が人のログインの記録（`ip/…`・`global`）を増やさない。セッションがあれば Basic を見ない。
4. A: 画面 5 本の HTML にログアウトのボタンがあり、合言葉が埋まり、処理が nonce 付きの script の中にある。属性の処理（`on…=`）が無い。`renderAdminNav()` のリンクの並びは今と同じ。
5. C: 画面 5 本のサーバー側の出力に、`<img src=x onerror=alert(1)>`・`"><script>alert(1)</script>`・`javascript:alert(1)` を含む偽のデータを入れ、そのまま出ないこと（エスケープされる・リンクは `#` になる）を確かめる。ブラウザで動く script のエスケープの関数と URL の確かめの関数も、同じ文字で確かめる。
6. 段 2 の守り（認証の無い要求が中身に届かない、`WWW-Authenticate` が無い、ログに秘密が出ない）の既存の試験がすべて通る。

## 変えてよいファイル

- `netlify/functions/lib/review-auth.js`（F・D・B1〜B3 だけ）
- `netlify/functions/lib/admin-auth.js`（B4・B5）
- `netlify/functions/lib/admin-nav.js`（A1・A4）
- `netlify/functions/lib/notify/message.js`（B3 の文だけ）
- `netlify/functions/admin-home.js`・`admin-articles-page.js`・`admin-candidates-page.js`・`admin-freshness-page.js`・`admin-analytics-page.js`（A2〜A4・C）
- `scripts/lib/__tests__/test-review-auth.js`・`test-admin-auth.js`・`test-admin-nav.js`・`test-admin.js`・`test-admin-freshness.js`・`test-contact-transition.js`・`review-auth-test-helpers.js`・`test-notify-message.js`
- 新しい試験を足すなら `scripts/lib/__tests__/test-admin-escape.js`、`package.json` は `masters:test` への登録だけ

## 変えてはいけないもの

- 上に無いファイル。特に `netlify/functions/review-*.js`・`lib/review-html.js`・`netlify/functions/admin-list-*.js`・`admin-save-candidates.js`・`admin-change-article-status.js`・`admin-freshness-action.js`・`netlify.toml`・`.github/`・`data/`・`content/`・`blog/`・`docs/`
