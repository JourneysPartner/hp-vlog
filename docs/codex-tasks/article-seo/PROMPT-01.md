あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/article-seo/` にあります。まず `README.md` を読み、次に `01-page-structure.md` を実装してください。`02-*.md` と `03-*.md` はこの回では実装しません。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/article-seo-p1` です。ブランチを切り替えないでください。
- この環境では git にコミットできません（隔離の書き込み範囲外）。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。
- 指示書の R 番号を実装順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。新しい npm パッケージは追加できません（見出しの id は自前で付けます）。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- 隔離内では子プロセスで `node` を起動するテストが EPERM で落ちることがあります。テストはビルドの関数を直接 `require` して呼ぶ形にしてください。それでも落ちる場合は、その旨を最終報告に書いてください（別の担当が隔離の外で再実行します）。

## 厳守

- `content/posts/*.md` を触らない。
- 税務の文章を新しく書かない。
- 既存 URL・canonical・構造化データ・パンくずを変えない。
- 公開ページに新しい JavaScript を足さない。
- 一覧・ハブ・静的ページの HTML は差分ゼロ（`<title>` の変更は記事ページだけ）。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-page-structure.js
node scripts/propose-internal-link-terms.js
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R6 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 文脈リンクの辞書の一覧（語 → 記事の題名 → macros）。見つからなかった種語も列挙
3. 代表記事 3 本（物販・相続・建設から 1 本ずつ）について、目次の本数・関連記事 3 本の slug・文脈リンクの本数
4. `sitemap.xml` の URL 数（変更前 → 変更後）
5. 【要判断】【要確認】として残した点
6. 毛利さん向けの確認方法（プレビューで見る場所を 3 つまで）
