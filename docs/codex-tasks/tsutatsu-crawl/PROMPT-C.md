あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/tsutatsu-crawl/` です。01・01b は実装済み・マージ済み（#679）です。今回は **`01c-comments.md`（D1〜D4 と試験 1〜9）だけ**を実装してください。国税庁の通達ページの HTML のコメント（画面に出ない部分）に残る、消された古い条文を取り込まないようにする修正と、取り込みの後の品質の検査を新しい通達に合わせる修正です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/tsutatsu-comments` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験データは `docs/codex-tasks/tsutatsu-crawl/fixtures/`（今回 `pages/` に 8 ページを足しました。01c の試験はそれと既存の 1 ページの計 9 ページを使います。既存の 66 ページと `expected.json` も含め、変更しないでください）。
- ネットワークは使えません。取得はテストで偽の関数に置き換えてください。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 01・01b・01c の「変更してはいけないもの」を守る。特に、読み落とし・取得の失敗・項目 0 件・項目の減少で止める安全側を弱めない。減少を受け入れるのは、前のカタログの本文にコメントの印があった番号だけ。
- 番号の形の判定そのものは変えない（書き出すだけ）。
- 特定のページ・URL・番号だけを特別扱いする分岐を入れない。
- ワークフローの変更は 01c D2 の 1 行と出力 1 つだけ。
- `data/`・`content/posts/*.md`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-tsutatsu-comments.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-crawl-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-workflow-change-detection.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. D1〜D4 ごとに「何を変えたか」「触ったファイルと行」「テスト結果」
2. 01c の試験の 9 ページの結果（ページごとの条の数、コメントを除いて消えた番号、重複の有無）
3. 既存の 66 ページの結果が変わっていないこと（分類ごとの件数）
4. 既存テストの期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
