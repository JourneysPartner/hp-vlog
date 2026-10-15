あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/tsutatsu-crawl/` です。01（R1〜R4）は実装済み・コミット済み（03c43988）です。今回は **`01b-review-fixes.md`（B1〜B7）だけ**を実装してください。01 のレビュー（`review-01.md`）で見つかった安全側の穴の修正です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/tsutatsu-crawl` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験データは `docs/codex-tasks/tsutatsu-crawl/fixtures/`（`expected.json` は「(共)」の 3 ページを `provisions` に変更済み）です。変更しないでください。
- ネットワークは使えません。取得はテストで偽の関数に置き換えてください。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 01・01b の「変更してはいけないもの」を守る。特に、読み落とし・取得の失敗・項目 0 件で止める安全側を弱めない。番号の形の判定そのものは変えない（「(共)」の正規化だけ）。
- 特定のページ・URL だけを特別扱いする分岐を入れない。
- `data/`・`content/posts/*.md`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-tsutatsu-crawl-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. B1〜B7 ごとに「何を変えたか」「触ったファイルと行」「テスト結果」
2. 試験データ 66 ページの結果（分類ごとの件数、(共) の 3 ページの項目数）
3. 既存テストの期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
