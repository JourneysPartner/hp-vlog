あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/tsutatsu-crawl/`（`README.md`・`01-fixes.md`）です。国税庁の通達の取り込みが、一部の読めないページのせいで 9 種類とも 1 件も入らない問題を直してください（R1〜R4）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/tsutatsu-crawl` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験データは `docs/codex-tasks/tsutatsu-crawl/fixtures/`（`pages/` に読めなかった 66 ページの HTML、`expected.json` に期待値）です。変更しないでください。
- ネットワークは使えません。取得はテストで偽の関数に置き換えてください。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- `01-fixes.md` の「変更してはいけないもの」を守る。特に、番号の形の判定と、本当の読み落とし・取得の失敗では今と同じく取り込まない安全側。
- 特定のページ・URL だけを特別扱いする分岐を入れない（附則・別紙・前文の URL の判定は指示書のとおり）。
- `data/`・`content/posts/*.md`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-tsutatsu-crawl-fixes.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R1〜R4 ごとに「何を変えたか」「触ったファイルと行」「テスト結果」
2. R2 の原因（措置法・評価用の読み方が 0 件になっていた理由）
3. `expected.json` の 66 ページの結果（分類ごとの件数、`min_items` を満たさないものがあれば URL）
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
