あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回の指示書は `docs/codex-tasks/crawl-queue/05-replaces-dedup.md` だけです。背景と共通の厳守事項は同じフォルダの `README.md` にあります（01〜04 は実装・マージ済みなので触らないでください）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/replaces-dedup` です。ブランチを切り替えないでください。
- R1 → R6 の順に実装し、テストを書いてから最終確認へ進んでください。
- git のコミットはできません（隔離の制約）。変更は作業ツリーに残したままにしてください。コミットは別の担当が行います。
- ネットワークは使えません。`npm install` は済んでいます。外部 API は呼べないので、判定関数は差し込みで偽物に置き換えてテストしてください。
- シェルは Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd で実行してください。`node`（v24）と `npm` は使えます。
- 子プロセスの起動（`spawnSync(node)`）が隔離で EPERM になることがあります。その場合はその旨を報告し、残りのテストは個別に実行してください。

## 厳守

- `content/posts/*.md` は 1 ファイルも変更しない。
- 選定時の重複判定・品質ゲート・承認公開の手順を変えない。
- `replaces` の無いトピックでは、生成プロンプトも frontmatter も 1 文字も変わらないこと。
- 鍵・トークンをログやファイルに出さない。説明・コメントは日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-replaces.js
node scripts/lib/__tests__/test-crawl-queue-cadence.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
node scripts/lib/__tests__/test-consolidation.js
npm run validate
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R6 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. `replaces` が無いトピックで差分ゼロをどう確かめたか
3. `apply-replaces.js` の使い方（コマンド 1 行）と、`--dry-run` の出力例（fixture で可）
4. 【要判断】【要確認】として残した点
