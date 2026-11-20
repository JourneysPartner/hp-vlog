# 01 `getFile()` で 1MB 超のファイルを blob API から読む

## 実装の要件

R1. `getFile(filepath, ref)` の contents API の取得（URL・ヘッダ・失敗時の例外）は今のまま。

R2. 答え `data` を次の順に扱う。
- `data.type` が文字列で `'file'` でなければ例外（フォルダーなど）。
- `data.encoding === 'base64'` なら今と同じく `data.content` を base64 として読む。
- `data.encoding === 'none'` なら R3 で blob から読む。
- それ以外の encoding（未定義を含む）は例外。

R3. blob の取得:
- URL は `${API_BASE}/repos/${REPO()}/git/blobs/${data.sha}`。`data.sha` が 40 桁の 16 進数（小文字）でなければ取得せずに例外。
- ヘッダは `headers()` と同じもの（既定の JSON の media type）。
- `res.ok` でなければ、403・429 のときは `logRateLimit(res, 'getFile blob')` を呼び、`GitHub GET blob ${res.status}: ${text}` の例外。
- 答えの `encoding` が `'base64'` でなければ例外。答えの `sha` が `data.sha` と違えば例外。
- 中身は答えの `content` を base64 として読む（GitHub は base64 を改行で区切ることがあるので、`Buffer.from(..., 'base64')` のまま扱ってよい）。

R4. どちらの道でも、読んだバイト列の長さが `data.size`（数のとき）と違えば例外。

R5. 返す値は今と同じ `{ content: <utf8 の文字列>, sha: data.sha }`。

R6. 例外の文に `Authorization` の値・トークンを入れない（今の contents の失敗と同じく、GitHub の答えの本文だけ）。

R7. `putFile()` とそのほかの関数は変えない。

## 試験（新規 `scripts/lib/__tests__/test-github-get-file.js`）

`global.fetch` を差し替え、`GH_APP_ID`・`GH_APP_PRIVATE_KEY`・`GH_APP_INSTALLATION_ID` を消し、`GITHUB_TOKEN` に「試験用のトークン」のような分かる文字列を入れる（鍵やトークンの形の文字列は書かない）。終わったら元に戻す。ネットワークは使わない。

1. 1MB 以下（encoding base64）: 取得は 1 回だけ、URL は今と同じ（ref の符号化を含む）、`content`・`sha` が正しい。
2. 1MB 超（encoding none、content 空）: 2 回目の取得が `/git/blobs/<sha>`、返す `content` が blob の中身、`sha` が contents の `sha`。日本語を含む中身で確かめる。
3. blob の `sha` が違う → 例外、中身を返さない。
4. バイト数が `size` と違う（base64 の道と blob の道の両方）→ 例外。
5. blob の取得が 404・403 → 例外（状態の数字を含む）。403 では `logRateLimit` の警告が出てもよい。
6. encoding が未定義・`'utf-8'` など → 例外。`type` が `'dir'` → 例外。`sha` が 40 桁の 16 進数でない → blob を取りに行かずに例外。
7. 例外の文に `GITHUB_TOKEN` の値が含まれない（3〜6 のすべて）。
8. 本物の `admin-list-candidates.js` を、ログインした要求（`review-auth-test-helpers.js`）で呼ぶ: 1MB 超の偽の答え（候補 2 件以上）で 200、`candidates` の件数・`sha` が正しい。blob の取得が失敗したら 500 で、空の一覧（200）を返さない。
9. 本物の `admin-save-candidates.js` を、ログインした要求（合言葉・`Content-Type: application/json`・送り元をそろえる）で呼ぶ: 1MB 超の偽の答えで PUT が 1 回送られ、PUT の本文の `sha` が contents の `sha`、`content` を読むと更新が入っている。送った `sha` が違えば 409 で PUT を送らない。blob の取得が失敗したら 500 で PUT を送らない。

`package.json` の `masters:test` の並びに `scripts/lib/__tests__/test-github-get-file.js` を足す（ほかは変えない）。

## 変えてはいけないもの

- `netlify/functions/lib/github-api.js` の `getFile()` 以外
- `netlify/functions/admin-*.js`・`review-*.js`・`lib/admin-auth.js`・`lib/review-auth.js`
- 既存の試験・`data/`・`content/`・`blog/`・`.github/`・`docs/`（この指示書を含む）
