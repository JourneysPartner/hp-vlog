あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/large-file-read/` です。`README.md` で背景と厳守事項を読み、`01-get-file.md`（R1〜R7 と試験 1〜9）を実装してください。`netlify/functions/lib/github-api.js` の `getFile()` が 1MB を超えるファイルで空の中身を返し、管理画面の候補管理の一覧と保存が HTTP 500 になる不具合の直しです。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/github-large-file` です。ブランチを切り替えないでください。
- コミット・push・インストールはしないでください。実装と試験まで行います。
- ネットワークは使えません。GitHub への取得は試験で `global.fetch` を偽のものに差し替えてください。依存関係を追加しないでください。
- 試験の中に、鍵やトークンの形の文字列や本物らしいパスワードを書かないでください（「試験用のトークン」のような分かる文字列にする。Netlify の秘密情報の自動検出でビルドが止まった前例があります）。
- 作業用のファイルを作る場合は `.tmp-` で始まる名前にし、終わったら消してください。ファイルは LF で書いてください。
- node の実行は `sbx` を通してください（例: `sbx node scripts/lib/__tests__/test-github-get-file.js`）。

## 変えてよいファイル

- `netlify/functions/lib/github-api.js`（`getFile()` だけ）
- `scripts/lib/__tests__/test-github-get-file.js`（新規）
- `package.json`（`masters:test` への試験の登録だけ）

これ以外は変えないでください。

## 厳守（安全の条件）

`README.md` の「厳守」1〜5 のとおり。特に、中身を読めないときは空や途中の中身を返さず必ず例外にすること、返す `content` と `sha` が必ず同じ版であること、1MB 以下のファイルの動き（取得 1 回・URL・返す値）を変えないこと。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
sbx node scripts/lib/__tests__/test-github-get-file.js
sbx node scripts/lib/__tests__/test-admin-auth.js
sbx node scripts/lib/__tests__/test-admin.js
sbx node scripts/lib/__tests__/test-admin-freshness.js
sbx npm run validate
git status --short
git diff --stat
```

## 最終報告（日本語で）

1. R1〜R7 ごとに「何を変えたか」
2. 試験 1〜9 の結果（件数）と、既存の試験の結果
3. 厳守 1〜5 をどの試験で確かめたか
4. 【要判断】【要確認】として残した点
