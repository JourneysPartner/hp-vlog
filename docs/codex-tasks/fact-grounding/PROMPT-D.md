あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b・03c は実装済み・コミット済みです。今回は **`03d-review-fixes.md`（H1〜H4）だけ**を実装してください。小さな修正です。指示書に書いた箇所以外は変えないでください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-review-fixes-3.js` に足してください。既存のテストは変えないでください（H1 で既存のテストの期待が変わる場合だけ最小限に直し、最終報告に書いてください）。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 照合は落とす側に倒す。H1 で「裏付けあり」になる条件を緩めない（足すだけ）。H2 は違う割合を同じとみなさない。
- 承認の差し止め（`fact_check_blocking`）とその 3 経路、03c の G1〜G11 を壊さない。
- `content/posts/*.md` と `data/` の既存の取り込み結果を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-catalog-coverage.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-published-facts-audit.js
git status --short
git diff --stat
```

## 最終報告（日本語で）

1. H1〜H4 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. H1・H2 の指示書の例それぞれの判定結果
3. 上のコマンドの結果
4. 【要判断】【要確認】として残した点
