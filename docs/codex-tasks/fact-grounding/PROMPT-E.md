あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b・03c・03d は実装済み・コミット済みです。今回は **`03e-real-run-fixes.md`（E1〜E4）だけ**を実装してください。実際の AI での確認で分かった問題の修正と、毛利さんが決めた方針（案 2）の反映です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。git の読み取り（`git show <枝>:<パス>` を含む）は使えます。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-real-run-fixes.js` に足してください。既存のテストの期待が方針の変更（E1）で変わる場合だけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。根拠の候補のテスト（E2）は実データ（`data/`）で行ってください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03e の「変更してはいけないもの」を守る。特に承認の差し止め（`fact_check_blocking`）の 3 経路、fail-closed、引用と数字の照合、`record.error`、空の system ブロックを送らない修正。
- 数字の事実（金額・割合・期限・適用年・番号）の扱いは緩めない。緩めるのは要件・判定・手続の「資料なし」だけ（止めずに一覧に出す）。
- `content/posts/*.md` と `data/` の既存の取り込み結果を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-catalog-coverage.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-approve-refresh.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。`npm run build` を実行した場合は、書き換わった追跡対象のファイルを元に戻してください。

## 最終報告（日本語で）

1. E1〜E4 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. E2: #643 の下書きの主張で、根拠の候補に入った資料（種類・番号・題名）
3. 既存テストの期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
