あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回の指示書は `docs/codex-tasks/crawl-queue/10-freshness-p1.md` の 1 本です。設計の背景は `docs/seo/freshness-design.md`、共通の厳守事項は `docs/codex-tasks/crawl-queue/README.md` にあります（01〜09 は実装済みまたは別 PR で進行中なので触らないでください）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/freshness-p1` です。切り替えないでください。
- R1 → R3 の順に実装し、テストを書いてから最終確認へ進んでください。
- git のコミットはできません（隔離の制約）。変更は作業ツリーに残したままにしてください。
- ネットワークは使えません。`npm install` は済んでいます。Chatwork や GitHub の API は呼べないので、通知は既存の `scripts/notify.js` の呼び出し部分を差し替え可能にして偽物でテストしてください。
- シェルは Git Bash が落ちることがあります。その場合は PowerShell か cmd で。`node`（v24）と `npm` は使えます。子プロセス起動が EPERM になったら報告して残りを個別に実行してください。
- 作業ツリーは CRLF です。テストの文字列比較は LF に揃えてから。

## 厳守

- 記事の本文・frontmatter・更新日を変えない。`content/posts/*.md` は 1 ファイルも変更しない。
- 既存の週次取り込み（`fetch-search-console.js` / `inspect-index-status.js` / `report-search-console.js`）の出力形式は変えない。レポートの節は末尾に足すだけ。
- 入力データ（`data/nta-sources/`、`data/tax-reform-outline.json`、`data/tax-calendar.json`、`data/search-console/`）が無い・古い場合でも失敗せず、空の候補で正常終了する。
- 秘密をログに出さない。説明・コメント・レポート文言は日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-search-console-ingest.js
node scripts/lib/__tests__/test-index-status.js
node scripts/build-freshness-candidates.js   （実データで実行し、候補の上位 10 件の slug と理由を報告）
npm run validate
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R3 ごとに「何を変えたか」「触ったファイル」「テスト結果」
2. 実データで出た候補の上位 10 件（slug・スコア・理由）
3. レポートに追加した節の見出しと、Chatwork 通知の本文例
4. 【要判断】【要確認】として残した点
