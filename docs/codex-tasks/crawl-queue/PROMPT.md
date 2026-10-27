あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/crawl-queue/` にあります。まず `README.md` を読み、次に `01-consolidate.md` → `02-cadence.md` → `03-internal-links.md` → `04-index-status-weekly.md` の順に実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/crawl-queue` です。ブランチを切り替えないでください。
- 段階ごとに別コミットにしてください。コミットメッセージは日本語で、先頭に `feat(crawl-queue): 01 …` のように段階番号を入れます。
- 指示書の R 番号を実装順に満たし、各段階のテストを書いてから次へ進んでください。
- 迷ったら指示書の「変更してはいけないもの」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。外部 API は呼べないので、テストは偽の `fetchImpl` で行ってください。
- push と PR 作成はしないでください（別の担当が行います）。

## 厳守

- `content/posts/*.md` は `01-consolidate.md` で名指しした 14 ファイル以外、触らない。
- 税務の文章を新しく書かない。統合で移す本文は原文のまま。数字を変えない。
- 既存 URL を変えない。消える URL は 301 を残す。
- 新しい JavaScript を公開ページに足さない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・PR 本文は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
npm run masters:test
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/lib/__tests__/test-industry-hubs.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
git status --short
git log --oneline origin/main..HEAD
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. 段階ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 統合 4 組の残す側・消す側と、移した節の見出し一覧
3. 削除した重複ファイル 6 本のファイル名
4. `sitemap.xml` の URL 数（変更前 → 変更後）
5. 配分表・allowlist・pickup の各設定ファイルのパスと既定値
6. 【要判断】【要確認】として残した点
7. 毛利さん向けの確認方法（プレビューで見る場所を 3 つまで）
