あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。まず `README.md` を読んでください。01〜05 と 03b は実装済み・コミット済みです。今回は **`03c-review-fixes.md`（G1〜G11）だけ**を実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取りは使えます。
- G 番号を順に満たし、テストを書いてから最終報告してください。テストは新しいファイル `scripts/lib/__tests__/test-fact-review-fixes-2.js` に足してください（既存のテストを直す必要があるときは最小限に）。
- 迷ったら指示書の「変更してはいけないもの」と README の「照合は落とす側に倒す」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。LLM・GitHub・通知の呼び出しはテストで偽の関数に置き換えてください。取り込み（e-Gov・国税庁への接続）はしないでください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- この環境では子プロセスで node を起動するテストが EPERM で落ちることがあります。その場合は落ちたテスト名だけ報告してください。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、記事系のワークフローを変えるとコミット前は必ず落ちます。直さないでください。
- main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は今回の対象外です。直さないでください。

## 厳守

- `content/posts/*.md` と `data/` の既存の取り込み結果を触らない。
- 承認の差し止め（`fact_check_blocking`）と、その 3 経路（新規の下書き・更新案・出典差し替えの道具）の動きを弱めない。
- 既存の選定・重複判定・品質ゲート・禁止表現・論点別ルール・番号の照合を弱めない。
- 指示書にあるもの以外のプロンプト文言を変えない。`netlify.toml` は G10 の規則を足すだけ。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-catalog-coverage.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-freshness-refresh.js
node scripts/lib/__tests__/test-admin-freshness.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-promote-source.js
node scripts/lib/__tests__/test-placeholder-title.js
node scripts/lib/__tests__/test-partial-revise.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-netlify-ignore.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。`npm run build` が書き換えた追跡対象のファイルは元に戻してください。

## 最終報告（そのまま PR 本文の一部になります。日本語で）

1. G1〜G11 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. G3: 指示書の例（「一定の要件…令和9年3月31日」、110万円と百十万円、令和8年と令和9年）の判定結果
3. 全テストの結果（対象外と EPERM は名前だけ）
4. 【要判断】【要確認】として残した点
