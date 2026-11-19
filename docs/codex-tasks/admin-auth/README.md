# 管理画面のログインを承認画面と同じ仕組みに載せ替える（2026-11-19、守りの強化 段 2）

## 背景

- 管理画面（`/admin` と `/admin/…`、関数 `admin-*.js` の 11 本）は HTTP Basic 認証（`lib/admin-auth.js`、ID とパスワードの 2 欄）で守っている。
  - 失敗回数の上限が無い（総当たりを止められない）。
  - ブラウザは Basic 認証の ID・パスワードを要求のたびに自動で付けるので、他のサイトからの操作の乗っ取り（CSRF）への守りが、関数ごとにばらばら（`admin-freshness-action` だけ送り元を見ている。`admin-change-article-status`・`admin-save-candidates` は見ていない）。
  - 画面に Content-Security-Policy（CSP）が無い。
- 承認画面（`/review`）は 10 月の #683 で、パスワード 1 つのログイン・署名つきのセッション Cookie・失敗回数の上限・CSRF の 3 重の守り・CSP を入れた（`lib/review-auth.js`、指示書 `docs/codex-tasks/review-auth/`）。
- リポジトリは公開のまま進める（11/19 利用者決定）。関数のコードは誰でも読める前提で守る。

## 利用者の決定（2026-11-19）

1. **パスワードは承認画面と共通にする。** 承認画面のパスワード（`REVIEW_PASSWORD`）1 つで、承認画面にも管理画面にも入れる。どちらかでログインすれば、12 時間は両方使える（同じ Cookie）。Netlify の新しい設定は作らない。
2. **今の ID・パスワード（`ADMIN_BASIC_USER`・`ADMIN_BASIC_PASS`）は、アクセス解析の数字の読み取り専用に残す。** 毎週月曜の自動処理（`.github/workflows/export-contact-transitions.yml`）が `GET /admin/api/analytics` を読むためだけに使う。ほかの画面・処理には使えなくする。

## 方針

1. 管理画面の 11 本は、有効なセッション Cookie が無ければ何も出さない・何もしない。Basic 認証の小窓（`WWW-Authenticate`）は出さない。
2. 画面（5 本）は、セッションが無ければ承認画面と同じログイン画面を出し、ログイン後に元の画面へ戻す。ログインの入口は今の `POST /review-login` の 1 つだけ（失敗回数の上限も 1 つを共有する）。
3. 書き込みの処理（3 本）は、承認画面の 3 つの処理と同じ 3 重の確認（送り元・セッション・画面ごとの合言葉）を通ってから中身に進む。
4. 画面に承認画面と同じ CSP を付ける。
5. 自動処理用の読み取りは `admin-list-analytics` の GET だけ、本番だけ。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-admin-session.md` | 共通の部品・画面 5 本・読み取り 3 本・書き込み 3 本・自動処理用の読み取り・試験 |

## 全段階共通の厳守事項

- 失敗時は安全側: 設定が無い・Cookie が壊れている・確認のどれかが通らない、は全部「出さない・処理しない」。
- **認証を通らない要求が、中身の処理（GitHub の読み書き・Blobs の読み込み・自動処理の起動）に届かないこと。** 試験で、止まる場合それぞれについて中身の関数が呼ばれないことを確かめる。
- パスワード・Cookie・合言葉・鍵・ID・IP そのものを、ログ・画面・応答に出さない。
- 承認画面の認証の中身（Cookie の名前・期限・鍵の作り方・失敗回数の上限・`requireSession`・`requireAction`・`login`・`logout` の動き）を変えない。`lib/review-auth.js` に足してよいのは `01-admin-session.md` の A1〜A3 だけ。
- 承認画面の関数（`review-*.js`）と `lib/review-html.js` を変えない。
- 管理画面の中身の処理（記事の状態の変更・候補の保存・更新候補の操作・一覧・集計）と、認証を通った後の応答の形・画面の見た目を変えない。
- 依存関係を足さない。`data/`・`content/`・`blog/`・`.github/` を触らない。
- 鍵やトークンの形の文字列・本物らしいパスワードを試験に書かない（Netlify の秘密情報の検出でビルドが止まる）。

## 毛利さんにお願いすること

設定の作業は無い。マージ後は、管理画面を開くと ID・パスワードの小窓の代わりにログイン画面が出るので、承認画面のパスワードを入れる。

## 元に戻す方法

この PR を revert すると、Basic 認証に戻る（`ADMIN_BASIC_USER`・`ADMIN_BASIC_PASS` は消さずに残しているので、そのまま入れる）。

## 受け入れ確認（Claude）

1. `01-admin-session.md` の試験と、既存の管理画面・承認画面・アクセス解析の試験が通る。
2. 独立したレビュー（Opus 5.5、xhigh）で、認証の抜け・CSRF・XSS・自動処理用の読み取りの範囲・失敗時の扱いを見る。
3. マージは月水金 9:05・毎日 12:00・18:00 の直前を避ける。
4. デプロイ後、本番で次を確かめる:
   - ログインせずに `/admin`・`/admin/articles` などを開くとログイン画面だけが出る（401、`WWW-Authenticate` 無し）。
   - ログインせずに `/admin/api/list`・`/admin/api/change` などを呼ぶと 401。
   - 自動処理の ID・パスワードで `GET /admin/api/analytics` は 200、同じ ID・パスワードで `/admin/api/list` は 401（確認は利用者の秘密を見ずに、`Export Contact Transitions` の手動実行の成功で行う）。
   - 毛利さんがログイン画面から入り、5 つの画面と、候補の保存・更新候補のボタンが今まで通り動く。

## 【要確認】（今回は直さない。段 3 の候補）

- 管理画面にログアウトのボタンが無い（承認画面の「ログアウト」を押せば同じ Cookie が消える。Basic 認証のときも無かった）。
- 自動処理用の読み取り（`ADMIN_BASIC_*`）には失敗回数の上限が無い（失敗のたびに 1 秒待つだけ）。読めるのはアクセス解析の数字だけ。パスワードが長い乱数なら総当たりは現実的でない。
- 管理画面の一覧・候補の表示のエスケープの総点検（今回は CSP で二重に守る）。

レビュー（2026-11-19、Opus 5.5 xhigh。Critical・High 0）で記録した点:

- **過去のデプロイの住所（`<デプロイID>--<サイト名>.netlify.app`）では、当時のコード（Basic 認証、書き込みを含む）が動き続ける見込み。** この PR では塞がらない。Netlify の Deploys の一覧から古いデプロイを開き、`/admin` で小窓が出るかを確かめてから対処を決める（本番以外のデプロイの保護・古いデプロイの削除・GitHub App の鍵の作り直し。環境変数の変更だけでは効かない）。
- ログインの失敗回数の上限を承認画面と共用したので、外から 1 時間に 30 回間違えられると、新しいログインが 1 時間止まる（ログイン済みは止まらない）。
- 管理画面と承認画面の合言葉が同じ値（`csrf:<sid>`）。分けるなら `review-auth.js` の変更が要る。
- ログインの最初の確認（405・503・送り元・形式）で弾かれると、管理画面から来ても承認画面のログイン画面が出る。
- 動いている関数には `CONTEXT` が入らない見込み。自動処理用の読み取りは host と `rawUrl` で本番に限った（PROMPT-B の B1）。承認画面は `review-auth.js` の host の確認がプレビューを止めている。

## コードの入口

- `netlify/functions/lib/admin-auth.js`（今の Basic 認証。作り直す）
- `netlify/functions/lib/review-auth.js`（承認画面の認証。`safeNext` 35 行付近、`pageHeaders` 52 行付近、`requireSession` 154 行付近、`requireAction` 164 行付近、`loginPage` 184 行付近）
- `netlify/functions/review-page.js`（`requireSession` → ログイン画面、`pageHeaders(nonce)`、合言葉の埋め込み `scriptJson` と `X-Review-Token` の送り方の手本。767 行付近と 614 行付近）
- `netlify/functions/review-skip.js` 37〜42 行（POST の確認 → `requireAction` の順の手本）
- 管理画面: `admin-home.js`・`admin-articles-page.js`・`admin-candidates-page.js`・`admin-freshness-page.js`・`admin-analytics-page.js`（画面）、`admin-list-articles.js`・`admin-list-candidates.js`・`admin-list-analytics.js`（読み取り）、`admin-change-article-status.js`・`admin-save-candidates.js`・`admin-freshness-action.js`（書き込み）
- 試験: `scripts/lib/__tests__/test-admin.js`・`test-admin-nav.js`・`test-admin-freshness.js`・`test-contact-transition.js`（421 行付近から管理 API）・`test-review-auth.js`・`review-auth-test-helpers.js`（ログインした状態の要求を作る手助け）
