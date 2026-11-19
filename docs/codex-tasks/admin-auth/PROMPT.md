あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/admin-auth/` です。`README.md` で背景・利用者の決定・厳守事項を読み、`01-admin-session.md`（A〜F と試験 1〜11）を実装してください。管理画面（`netlify/functions/admin-*.js` の 11 本）の HTTP Basic 認証を、承認画面と同じセッション Cookie の認証（`netlify/functions/lib/review-auth.js`）に載せ替える修正です。**認証・セキュリティの境界の変更なので、抜けが無いことを最優先にしてください。**

## 進め方

- 作業ブランチは現在チェックアウト済みの `security/admin-auth-session` です。ブランチを切り替えないでください。
- コミット・push・インストールはしないでください。実装と試験まで行います。
- ネットワークは使えません。Blobs・GitHub・時刻・待ち時間は、試験で偽のものに差し替えてください。依存関係を追加しないでください。
- 試験の中に、鍵やトークンの形の文字列や本物らしいパスワードを書かないでください。試験用のパスワードは「試験用のパスワード」のような分かる文字列にし、鍵は実行時に作ってください（Netlify の秘密情報の自動検出でビルドが止まった前例があります）。
- 作業用のファイルを作る場合は `.tmp-` で始まる名前にし、終わったら消してください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験の名前だけ報告してください。

## 変えてよいファイル

- `netlify/functions/lib/admin-auth.js`（作り直し）
- `netlify/functions/lib/review-auth.js`（`01-admin-session.md` の A1〜A3 だけ）
- `netlify/functions/admin-*.js`（11 本）
- `netlify.toml`（コメントだけ）
- `package.json`（`masters:test` への試験の登録だけ）
- `scripts/lib/__tests__/test-admin-auth.js`（新規）・`test-admin.js`・`test-admin-nav.js`・`test-admin-freshness.js`・`test-contact-transition.js`・`review-auth-test-helpers.js`

これ以外は変えないでください。特に `netlify/functions/review-*.js`・`lib/review-html.js`・`scripts/lib/__tests__/test-review-auth.js`・`.github/`・`data/`・`content/`・`blog/`・`docs/`。

## 厳守（安全の条件）

1. 有効なセッション Cookie が無い要求は、11 本のどれでも中身の処理（GitHub の読み書き・Blobs の読み込み・自動処理の起動）に届かない。
2. 正しい `ADMIN_BASIC_USER`・`ADMIN_BASIC_PASS` の Basic ヘッダで通るのは、本番の `admin-list-analytics` の GET だけ。ほかの 10 本と、GET 以外では通らない。
3. 書き込み 3 本は、送り元・セッション・合言葉（`X-Review-Token`）・`Content-Type: application/json` が全部そろったときだけ中身に進む。
4. 応答に `WWW-Authenticate` を付けない。パスワード・Cookie・合言葉・鍵・ID・IP そのものをログ・画面・応答に出さない。
5. 承認画面の認証の中身（Cookie・鍵・失敗回数の上限・`requireSession`・`requireAction`・`login`・`logout`）を変えない。`test-review-auth.js` は直さずに全部通ること。
6. 管理画面の中身の処理・認証後の応答の形・画面の見た目を変えない。
7. 既存の試験は、ログインした状態の要求を作る手助け（`review-auth-test-helpers.js`）を使って通す。認証を外して通す・期待を緩める直し方はしない（`01-admin-session.md` の E に書いた 2 点は直してよい）。
8. 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-admin-auth.js
node scripts/lib/__tests__/test-admin.js
node scripts/lib/__tests__/test-admin-nav.js
node scripts/lib/__tests__/test-admin-freshness.js
node scripts/lib/__tests__/test-contact-transition.js
node scripts/lib/__tests__/test-review-auth.js
node scripts/lib/__tests__/test-review-page.js
npm run validate
git status --short
git diff --stat
```

## 最終報告（日本語で）

1. A〜F ごとに「何を変えたか」「触ったファイル」
2. 試験 1〜11 の結果（件数）
3. 認証を通らない要求が中身の処理に届かないことを、11 本それぞれでどう確かめたか
4. 既存の試験の期待を変えた箇所とその理由
5. CSP で動かなくなる恐れがある所（属性に書いた処理・外部の読み込みなど）を調べた結果
6. 【要判断】【要確認】として残した点（特に、Netlify の実行環境で確かめないと分からないこと）
