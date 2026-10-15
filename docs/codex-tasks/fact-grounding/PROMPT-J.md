あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i（資料はページ単位で 1 回だけ・答えは番号で）は実装済み・コミット済みです（d6f29d5e・7c775b48）。今回は **`03j-review-fixes.md`（J1〜J12）だけ**を実装してください。03i のレビュー指摘（High 2・Medium 5・Low）と、実際の AI での確認で分かった点の修正です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-review-fixes-4.js` に足してください。既存のテストの期待は、J1〜J12 によって変わるものだけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03i・03j の「変更してはいけないもの」を守る。特に案 2 の止める範囲、承認の差し止めの 3 経路、fail-closed、引用の実在確認、数字の歯止め（H1・G3・H2・03g）、候補の出し方、照合のモデルと呼び出し設定、7c775b48 の「全部落ちるときは照合不能で止める」と `reject_reason`。
- 指示文の変更は J7 の 1 行だけ。
- `content/posts/*.md`・`data/`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-number-guard.js
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

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. J1〜J12 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. 既存テストの期待を変えた箇所とその理由
3. `test-fact-pages.js` の T1（3 本の量）と T2（既知の誤り 8 件）の結果が 03i から変わったか
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
