独立したレビューの結論は「直してからマージ（Critical・High 0）」でした。指示書 `docs/codex-tasks/admin-auth/` の実装（コミット済み）に、次の 4 点を直してください。前回と同じ条件です（ブランチ `security/admin-auth-session` のまま、コミットしない、ネットワーク不可、依存関係を足さない、鍵の形の文字列を書かない、期待を緩めない、説明・報告は日本語）。

変えてよいファイル: `netlify/functions/lib/admin-auth.js`・`netlify/functions/admin-candidates-page.js`・`netlify/functions/admin-list-candidates.js`・`netlify/functions/admin-save-candidates.js`・`scripts/lib/__tests__/test-admin-auth.js`・`test-admin.js`・`test-contact-transition.js`。これ以外（特に `lib/review-auth.js`・`review-*.js`・`test-review-auth.js`・`docs/`）は変えないでください。

## B1（Medium）自動処理用の読み取りを、本番の住所だけに限る

- Netlify では、動いている関数に `CONTEXT` が入らない見込みです（ビルドのときだけの変数）。今の `basicReadAllowed` は `CONTEXT` だけで「本番だけ」を判断しているので、プレビューやブランチのデプロイ（`deploy-preview-N--<サイト名>.netlify.app` など）でも通ります。
- 直し方（`netlify/functions/lib/admin-auth.js` の `basicReadAllowed`）:
  - `singleHeader(event, 'host')` が `mori-zeirishi.net` と完全に一致することを必須にする（host が無い・重複・別の値は通さない）。
  - `event.rawUrl` があるときは、`new URL(event.rawUrl).origin` が `https://mori-zeirishi.net` であることも必須にする（読めない値は通さない）。
  - `CONTEXT` の確認は残す。
  - 外れたときの扱いは今と同じ（1 秒待って 401、`WWW-Authenticate` 無し、Blobs を読まない）。
- 試験:
  - 足す: `CONTEXT` 無し＋ host が `deploy-preview-1--x.netlify.app` → 401・`sleep(1000)` 1 回。host 無し → 401。host が `mori-zeirishi.net` でも `rawUrl` が `https://deploy-preview-1--x.netlify.app/admin/api/analytics` → 401。`rawUrl` が読めない値 → 401。host が重複（`host` と `Host`）→ 401。ハンドラ全体でも、プレビューの host では Blobs を読まない。
  - 自動処理として通す今の試験（`test-admin-auth.js` の試験 2・6、`test-admin.js`、`test-contact-transition.js` の 462 行付近）には `host: 'mori-zeirishi.net'` を足す。`rawUrl` が `https://mori-zeirishi.net/admin/api/analytics` の場合に通ることも 1 つ確かめる。

## B2（Low）候補画面で保存中にログインが切れたとき、黙って再読み込みしない

- `netlify/functions/admin-candidates-page.js` の保存（`API_SAVE` の POST と、409 の後の取り直し）が 401 を受けたときは、`location.reload()` をやめ、画面の今ある保存の表示（`setIndicator`）で「ログインが切れたため保存していません。ページを開き直してログインしてください。」と出す。まだ送っていない変更を捨てない（今の失敗時の扱いに合わせる）。
- 最初の一覧の読み込み（`API_LIST` の GET）の 401 は、今のまま `location.reload()`。
- 試験: 画面のスクリプトに、保存の 401 でこの文言を出す分岐があり、保存の道では `location.reload()` を呼ばないこと（文字列の確認でよい。今ある画面の試験のやり方に合わせる）。

## B3（Low）候補の一覧・保存の応答に `Cache-Control: no-store`

- `admin-list-candidates.js`・`admin-save-candidates.js` の、認証を通った後の応答すべて（200・400・405・409・500 など）のヘッダに `'Cache-Control': 'no-store'` を足す。応答の本文とステータスは変えない。
- 試験: ログインした状態の一覧（200）と保存（200）に `Cache-Control: no-store` がある。

## B4（Low）試験の穴を埋める（`test-admin-auth.js`）

- 試験 5 に「`origin` も `referer` もヘッダそのものが無い（キーごと消す）」場合を足す（今は値を `undefined` にしているだけ）→ 403、中身に届かない。
- 試験 2 に「正しい Basic ＋正しい `origin`・`content-type: application/json`・`host`、Cookie 無し」で書き込み 3 本が 401 になり、中身に届かないことを足す。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-admin-auth.js
node scripts/lib/__tests__/test-admin.js
node scripts/lib/__tests__/test-admin-nav.js
node scripts/lib/__tests__/test-admin-freshness.js
node scripts/lib/__tests__/test-contact-transition.js
node scripts/lib/__tests__/test-review-auth.js
git status --short
git diff --stat
```

最終報告（日本語）: B1〜B4 ごとに、変えた所・試験の結果・期待を変えた箇所と理由・【要確認】。
