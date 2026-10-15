あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b〜03f は実装済み・コミット済みです。今回は **`03g-number-guard.md`（M1・M2）だけ**を実装してください。照合の最後の歯止め（`sufficientQuote` と `normalizedNumbers`）を締め直す小さな修正です。指示書に書いた箇所以外は変えないでください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-number-guard.js` に足してください。既存のテストの期待は、日付の読み方の変更で `normalizedNumbers` の出力の形が変わるものだけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 照合は落とす側に倒す。M1・M2 は歯止めを締める変更で、緩める変更は入れない。
- 03g の「変更してはいけないもの」を守る。
- `content/posts/*.md` と `data/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. M1・M2 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. 指示書のテストの例それぞれの判定結果
3. 既存テストの期待を変えた箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
