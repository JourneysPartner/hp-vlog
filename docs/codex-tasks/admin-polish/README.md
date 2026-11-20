# 守りの強化 段 3: 管理画面のログインまわりの細かい直し（2026-11-20）

## 背景

段 2（#800、指示書 `docs/codex-tasks/admin-auth/`）で、管理画面のログインを承認画面と同じ仕組み（`lib/review-auth.js` のセッション Cookie・合言葉）に載せ替えた。そのとき【要確認】として残した点のうち、利用者が 2026-11-20 に次の 5 つを直すと決めた。

| 記号 | 内容 |
|---|---|
| A | 管理画面にログアウトのボタンを付ける |
| B | 自動処理用の読み取り（`ADMIN_BASIC_*`、`GET /admin/api/analytics` だけ）に失敗回数の上限を付ける |
| C | 管理画面 5 本の表示のエスケープを総点検し、穴があれば直す |
| D | ログインの入口の最初の確認（設定の誤り・送り元・形式）で弾かれたとき、管理画面から来たなら管理画面のログイン画面に戻す |
| F | ログイン全体の失敗回数の上限を、1 時間に 30 回から 10 回に下げる（承認画面と共用のまま） |

見送り（利用者決定）: 合言葉を管理画面と承認画面で分けること（E）。

## 利用者の決定（2026-11-20）

- A・B・C・D・F を直す。E は見送る。
- F は「外から 1 時間に 10 回間違えられると、新しいログインが 1 時間止まる」。上限は承認画面と共用のまま（分けない）。

## 全体で守ること（安全の条件）

1. 有効なセッション Cookie が無い要求は、管理画面 11 本のどれでも中身の処理（GitHub の読み書き・Blobs の読み込み・自動処理の起動）に届かない（段 2 と同じ）。
2. 自動処理用の ID・パスワードで通るのは、本番の `admin-list-analytics` の GET だけ（段 2 と同じ）。上限に達している間は、正しい ID・パスワードでも通さない。
3. 失敗回数の確保は、パスワードの照合より前に行う（同時に大量に送られても、上限を超えて照合しない）。記録の読み書きに失敗したら、照合せずに断る（安全側）。
4. 書き込み 3 本とログアウトは、送り元・セッション・合言葉・`Content-Type: application/json` が全部そろったときだけ進む（段 2 と同じ）。
5. 応答に `WWW-Authenticate` を付けない。パスワード・Cookie・合言葉・鍵・ID・IP そのものをログ・画面・応答に出さない。
6. ログイン後に戻す先は、今の決まった一覧（`ADMIN_PAGES` と `/review?…`）だけ。要求の中身から新しい行き先を作らない。
7. 承認画面の認証の中身（Cookie の名前・期限・鍵の作り方・IP ごとの上限（15 分に 5 回）・停止の長さ・`requireSession`・`requireAction`・`logout`）は、この段で決めた F と D 以外は変えない。
8. 画面の見た目は、ログアウトのボタンを足す以外は変えない。CSP（nonce 付きの script だけ）を緩めない。属性に処理を書かない（`onclick=` など）。

## 元に戻す方法

この PR を revert する。Blobs の記録の形は変えない（B は新しい名前の記録を足すだけ）。戻した後に残る B の記録は使われず、害は無い。

## 受け入れ確認（Claude）

- 差分を読み、上の 1〜8 と `01-admin-polish.md` の要件を式まで確かめる。特に B の確保の順番と、F の数字の変更が 1 か所だけであること。
- C は、実装担当の一覧（データが HTML に入る所すべて）を自分でもコードと照らす。
- `sbx` の中で関係する試験と `npm run validate` を流す。
- デプロイ後、本番で: ログアウトのボタンで管理画面のログイン画面に戻る、ログインし直して 5 つの画面が開く、`Export Contact Transitions` の手動実行が成功する（利用者の了承を得てから実行する）。

## 【要確認】（この段では直さない）

- ログアウトは Cookie を消すだけで、盗まれた Cookie は期限（12 時間）まで使える（承認画面も同じ。前から）。
- 正しいログインも全体の 10 回に数える（前から同じ数え方）。1 時間に 10 回ログインし直すことは普段ないので、変えない。
- 外の人が 1 時間に 10 回まちがった Basic を送ると、週 1 回の `Export Contact Transitions` が 429 で失敗する（停止の通知 `admin_basic_locked` が届く）。利用者の決定どおりの動き。
- 成功の直後（約 60 秒以内）に手動でもう一度実行すると、記録の反映の遅れで競合の 429 になることがある（ログインと同じ、前から）。

## レビュー（2026-11-20、Opus 5.5 xhigh）

Critical・High・Medium は 0 件。Low 4 件のうち、`safeHref` がタブ・改行をはさむ値を通す件と、候補管理の「適合」の列のエスケープ漏れは、この PR で直した。D1 の文の食い違いは文を直した。残り（記録だけ）: 自動処理の読み取りに同時に大量に送る試験が無い（数え方はログインと共通で、ログイン側は同時 200 件で試験済み）、ログアウトの処理を実際に動かす試験が無い（文字列があるかだけ。デプロイ後に画面で確かめる）。

## コードの入口

- `netlify/functions/lib/review-auth.js`: `login()`（246 行付近）、`rateRecord`・`readRate`、`loginPage()`
- `netlify/functions/lib/admin-auth.js`: `requireAnalyticsRead()`・`basicReadAllowed()`
- `netlify/functions/lib/admin-nav.js`: `renderAdminNav()`
- 画面 5 本: `admin-home.js`・`admin-articles-page.js`・`admin-candidates-page.js`・`admin-freshness-page.js`・`admin-analytics-page.js`
- ログアウトの手本: `netlify/functions/review-page.js` の `btnLogout`（630 行付近）
- 通知の文: `netlify/functions/lib/notify/message.js` の `review_auth_locked`
- 試験: `scripts/lib/__tests__/test-review-auth.js`・`test-admin-auth.js`・`test-admin-nav.js`・`test-admin.js`・`test-admin-freshness.js`・`test-contact-transition.js`・`review-auth-test-helpers.js`
