あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回の指示書は `docs/codex-tasks/crawl-queue/06-draft-branch-hygiene.md` と `07-segment-receptors.md` の 2 本です。共通の厳守事項は同じフォルダの `README.md` にあります（01〜05 は実装・マージ済みなので触らないでください）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/receptors-hygiene` です。切り替えないでください。
- 06 → 07 の順に、R 番号どおり実装し、各段階のテストを書いてから次へ進んでください。
- git のコミットはできません（隔離の制約）。変更は作業ツリーに残したままにしてください。コミットは別の担当が行います。
- ネットワークは使えません。`npm install` は済んでいます。`gh` や GitHub API は呼べないので、呼び出しは差し替え可能にして偽物でテストしてください。
- シェルは Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd で実行してください。`node`（v24）と `npm` は使えます。
- 子プロセスの起動（`spawnSync(node)`）が隔離で EPERM になることがあります。その場合はその旨を報告し、残りのテストは個別に実行してください。
- 作業ツリーは CRLF です。テストで文字列比較をするときは LF に揃えてから比べてください。

## 厳守

- `content/posts/*.md` は 1 ファイルも変更しない。
- 重複判定のロジック、承認・公開の手順、通知文言を変えない。
- OPEN の枝と `draft/` 以外の枝を削除する経路を作らない。`--apply` なしでは何も消さない。
- サービスページの既存の文言・料金・FAQ を変えない。数値（料金・件数・実績）を新しく書かない。
- 公開ページに新しい JavaScript を足さない。鍵・トークンをログやファイルに出さない。説明・コメントは日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-draft-branch-hygiene.js
node scripts/lib/__tests__/test-service-segments.js
node scripts/lib/__tests__/test-industry-hubs.js
node scripts/lib/__tests__/test-pickup-links.js
node scripts/prune-draft-branches.js --help（または引数なしの dry-run が git/gh 不在でも落ちないことの確認）
npm run build
npm run validate
git status --short
git diff --stat
```

## 最終報告（そのまま PR 本文になります。日本語で）

1. 06・07 の R ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. `prune-draft-branches.js` の dry-run 出力の形（見出し行と 2 行の例）
3. `data/service-segments.json` の文言一覧（毛利さんが確認しやすいように、サービスごとに label と blurb を箇条書き）
4. 毛利さん向けの確認方法（プレビューで見る場所を 3 つまで）
5. 【要判断】【要確認】として残した点
