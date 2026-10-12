あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b〜03e は実装済み・コミット済みです。今回は **`03f-real-run-2-fixes.md`（K1〜K7）だけ**を実装してください。実際の AI での 2 回目の確認で分かった問題の修正です。止める範囲・置き換える範囲（毛利さんの案 2）は変えません。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。git の読み取りは使えます（下書きは `origin/draft/...` で読めます）。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-real-run-2-fixes.js` に足してください。既存のテストの期待を変える場合は最小限にし、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。根拠の候補のテスト（K2）は実データ（`data/`）で行ってください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03f の「変更してはいけないもの」を守る。特に案 2 の止める範囲、承認の差し止めの 3 経路、fail-closed、引用が根拠の原文に実在することの確認。
- 数字の照合を緩めるのは K1（引用 1 文ではなく採用した根拠の原文にあればよい）と K5（数字の無い文）だけ。
- `content/posts/*.md` と `data/` の既存の取り込み結果を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-review-page.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。`npm run build` を実行した場合は、書き換わった追跡対象のファイルを元に戻してください。

## 最終報告（日本語で）

1. K1〜K7 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. K2: subject「贈与税の配偶者控除」等の主張で候補に入った資料
3. K3: 偽データでの判定の入力文字数（03e の作りと比べて）
4. 既存テストの期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
