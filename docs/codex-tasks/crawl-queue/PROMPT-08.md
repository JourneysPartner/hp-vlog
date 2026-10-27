あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回の指示書は `docs/codex-tasks/crawl-queue/08-service-pages-content.md` と `09-title-refresh.md` の 2 本です。共通の厳守事項は同じフォルダの `README.md` にあります（01〜07 は実装済みなので触らないでください。07 の「対応している業種・働き方」の節は別 PR で main に入る予定なので、無くても動くように書いてください）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/service-content-titles` です。切り替えないでください。
- 08 → 09 の順に、R 番号どおり実装し、テストを書いてから次へ進んでください。
- git のコミットはできません（隔離の制約）。変更は作業ツリーに残したままにしてください。
- ネットワークは使えません。`npm install` は済んでいます。
- シェルは Git Bash が落ちることがあります。その場合は PowerShell か cmd で。`node`（v24）と `npm` は使えます。子プロセス起動が EPERM になったら報告して残りを個別に実行してください。
- 作業ツリーは CRLF です。テストの文字列比較は LF に揃えてから。

## 厳守

- 08 の「使ってよい事実」以外の数値・実績・顧客の声を書かない。事例は必ず「ご相談の例（想定）」と明記する。
- 09 は 10 本の `title` と `summary` だけ。本文・slug・日付・`updated_at` を変えない。
- 料金ページの金額、既存 FAQ の文言、`content/posts/*.md`（09 の 10 本を除く）を変えない。
- 公開ページに新しい JavaScript を足さない。説明・コメントは日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-service-pages-content.js
node scripts/lib/__tests__/test-title-refresh.js
node scripts/lib/__tests__/test-consolidation.js
node scripts/lib/__tests__/test-pickup-links.js
npm run build
npm run validate
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. 08・09 の R ごとに「何を変えたか」「触ったファイル」「テスト結果」
2. 08 で各ページに足した見出しの一覧（ページごとに箇条書き）
3. 09 の 10 本について、変更前後の title（表）
4. 毛利さん向けの確認方法（プレビューで見る場所を 3 つまで）
5. 【要判断】【要確認】として残した点
