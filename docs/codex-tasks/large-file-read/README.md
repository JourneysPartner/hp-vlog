# 1MB を超えるファイルを GitHub から読めない不具合の直し（2026-11-20）

## 背景

- 管理画面の候補管理（`/admin/candidates`）の一覧 `GET /admin/api/candidates/list` が HTTP 500 を返す。保存 `POST /admin/api/candidates/save` も同じ所で落ちる。
- 原因: `netlify/functions/lib/github-api.js` の `getFile()` は contents API（`GET /repos/{owner}/{repo}/contents/{path}`）の JSON の `content` を base64 として読む。GitHub の文書では 1MB を超え 100MB までのファイルは「raw か object の media type だけ対応。object では content は空文字、encoding は "none"」。`data/nta-shitsugi-topics-candidate.json` は 1,527,420 バイトなので `content` が空になり、`JSON.parse('')` が落ちる。
- いつから: このファイルは 2026-06-23 の最後の保存のとき 910,950 バイト、2026-07-05 の `581ceb450` で 1,210,391 バイトになった。それ以降、一覧も保存も動いていない（管理画面のログインの載せ替え #800 とは無関係）。
- 文書の裏付け（2026-11-20 に読んだもの）:
  - Get repository content: "Between 1-100 MB: Only the raw or object custom media types are supported. ... when using the object media type, the content field will be an empty string and the encoding field will be "none"."
  - Get a blob（`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`）: "This endpoint supports blobs up to 100 megabytes in size." "The content in the response will always be Base64 encoded."
  - Create or update file contents（PUT）: 大きさの上限は文書に無い。

## 方針

`getFile()` だけを直す。contents API の答えで `encoding` が `"none"` のときは、同じ答えの `sha` を使って blob API から中身を取る。返す `{ content, sha }` の形は変えない。中身と `sha` は必ず同じ版のものになる（blob は sha で固定されるため、間に別の保存が入っても取り違えない）。

`getFile()` を使う関数はほかにもある（承認画面・鮮度・記事の状態の変更など）。1MB 以下のファイルでは今と同じ 1 回の取得で、動きは変わらない。

## 厳守（安全の条件）

1. 1MB 以下のファイルでは、取得の回数（1 回）・URL・返す値が今と同じ。
2. 返す `content` と `sha` は必ず同じ版。blob の答えの `sha` が contents の `sha` と違えば失敗にする。
3. 中身を読めないとき（blob の取得の失敗・encoding が base64 でない・バイト数が `size` と違う・ファイルでない）は、空や途中の中身を返さず、必ず例外にする（黙って空の一覧や空のファイルを書き戻さない）。
4. 例外の文やログにトークン・Authorization の値を出さない。
5. `putFile()`・保存の楽観的並行制御（sha の照合と 409）・管理画面の応答の形と見た目を変えない。

## 元に戻す方法

この PR を revert する。データは変えないので、戻しても失うものは無い。

## 受け入れ確認（Claude）

- 差分を読み、上の 1〜5 を式まで確かめる。
- `sbx` の中で新しい試験と、関係する既存の試験（`test-admin-auth.js`・`test-admin.js`・`test-admin-freshness.js`）・`npm run validate` を流す。
- マージ後、本番の候補管理の一覧が開くかを利用者に見てもらう。

## 【要確認】

- 保存（PUT）が 1.5MB のファイルを受け付けるかは文書に書いていない。PUT が断られても書き込みは起きず、画面に失敗が出るだけ（GitHub の PUT は 1 回のコミットで、途中まで書かれることは無い）。最初の保存のときに確かめる。断られたら、書き込みを Git Data API（blob → tree → commit → ref）に替える別の直しを考える。

## コードの入口

- `netlify/functions/lib/github-api.js` の `getFile()`
- 使う側: `netlify/functions/admin-list-candidates.js`・`admin-save-candidates.js`
- 試験の形の例: `scripts/lib/__tests__/test-admin-freshness.js` の「GitHub APIのref取得とPRページ送り」（`global.fetch` の差し替え）、ログインした要求の作り方は `scripts/lib/__tests__/review-auth-test-helpers.js` と `test-admin-auth.js`
