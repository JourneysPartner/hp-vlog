あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/admin-polish/` です。`README.md` で背景・利用者の決定・安全の条件を読み、`01-admin-polish.md`（F・D・B・A・C と試験 1〜6）を実装してください。管理画面のログインまわりの細かい直しで、ログインの失敗回数の上限・自動処理用の読み取りの上限・ログアウトのボタン・表示のエスケープの点検です。**認証・セキュリティの境界の変更なので、抜けが無いことを最優先にしてください。**

## 進め方

- 作業ブランチは現在チェックアウト済みの `security/admin-polish` です。ブランチを切り替えないでください。
- 順番は F → D → B → A → C を勧めます（F と B は同じ数え方の仕組みを使います）。
- コミット・push・インストールはしないでください。実装と試験まで行います。
- ネットワークは使えません。Blobs・GitHub・時刻・待ち時間・通知は、試験で偽のものに差し替えてください（`review-auth-test-helpers.js`・`createReviewAuth({ getStoreFn, now, sleep, notify })` の形）。依存関係を追加しないでください。
- 試験の中に、鍵やトークンの形の文字列や本物らしいパスワードを書かないでください。試験用のパスワードは「試験用のパスワード」のような分かる文字列にしてください（Netlify の秘密情報の自動検出でビルドが止まった前例があります）。
- 作業用のファイルを作る場合は `.tmp-` で始まる名前にし、終わったら消してください。ファイルは LF で書いてください。
- node の実行は `sbx` を通してください。

## 変えてよいファイル・変えてはいけないもの

`01-admin-polish.md` の「変えてよいファイル」「変えてはいけないもの」のとおりです。

## 厳守（安全の条件）

`README.md` の「全体で守ること」1〜8 のとおりです。特に:

- 回数の確保はパスワードの照合より前。記録の読み書きに失敗したら照合せずに断る。
- 上限に達している間は、正しいパスワード・正しい自動処理の ID でも通さない。
- 自動処理の読み取りの記録（`basic-ip/…`・`basic-global`）と人のログインの記録（`ip/…`・`global`）を混ぜない。
- 既存の試験の期待を変えてよいのは、F の数字（30 → 10）と D で行き先・文が変わる所だけ。認証を外す・期待を緩める直し方はしない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
sbx node scripts/lib/__tests__/test-review-auth.js
sbx node scripts/lib/__tests__/test-admin-auth.js
sbx node scripts/lib/__tests__/test-admin-nav.js
sbx node scripts/lib/__tests__/test-admin.js
sbx node scripts/lib/__tests__/test-admin-freshness.js
sbx node scripts/lib/__tests__/test-contact-transition.js
sbx node scripts/lib/__tests__/test-notify-message.js
sbx node scripts/lib/__tests__/test-review-page.js
sbx npm run masters:test
sbx npm run validate
git status --short
git diff --stat
```

## 最終報告（日本語で）

1. F・D・B・A・C ごとに「何を変えたか」「触ったファイル」
2. 試験 1〜6 の結果（件数）と、上のコマンドの結果（落ちたものは名前・エラー・場所）
3. 既存の試験の期待を変えた箇所（ファイル・行）とその理由
4. C の一覧: 画面 5 本で、外から来る値が HTML・属性・script に入る所すべて（ファイル:行、入る値、守り方。直した所は「直した」と書く）
5. B の確保の順番（どの行で回数を確保し、どの行で照合するか）
6. 【要判断】【要確認】として残した点
