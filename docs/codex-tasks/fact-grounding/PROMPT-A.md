あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。まず `README.md` を読み、今回は `01-materials.md`・`02-writing-rules.md`・`03-fact-check-gate.md` を実装してください（04・05 は次の回）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です（`fix/draft-supply` の上に積んであります）。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取りは使えます。
- 指示書の R 番号を順に満たし、テストを書いてから最終報告してください。中核は 03 です。01・02 で時間を使いすぎないでください。
- 迷ったら指示書の「変更してはいけないもの」と README の「照合は落とす側に倒す」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。LLM 呼び出しはテストで偽の関数に置き換えてください。根拠検索のテストは実データ（`data/`）で行ってください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- この環境では子プロセスで node を起動するテスト（build を呼ぶもの）が EPERM で落ちることがあります。その場合は落ちたテスト名だけ報告してください。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、`daily-draft.yml`・`regenerate-draft.yml` を変えるとコミット前は必ず落ちます。直さないでください。
- main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は今回の対象外です。直さないでください。

## 厳守

- `content/posts/*.md` を触らない。
- 既存の選定・重複判定・品質ゲート・禁止表現・論点別ルール・番号の照合を弱めない。新しい関門は追加のみ。
- 指示書にあるもの以外のプロンプト文言を変えない。
- `fix/draft-supply` の変更（取り下げ記録・次の候補を試す・点検の判定）を壊さない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-draft-schedule.js
node scripts/lib/__tests__/test-title-refresh.js
node scripts/lib/__tests__/test-selector.js
node scripts/lib/__tests__/test-ai-dedup.js
node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-llm-source-selector.js
node scripts/lib/__tests__/test-source-selection-improvement.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` と `scripts/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。`npm run build` が書き換えた追跡対象のファイルは元に戻してください。

## 最終報告（そのまま PR 本文になります。日本語で）

1. 01 の R1〜R4、02 の R1〜R4、03 の R1〜R8 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 03 テスト 2（根拠検索の実データ）: 6 つの主張それぞれで上位 3 件に入った原文（種類・番号・該当文の抜粋）
3. 01 テスト 1・3 の実データの結果（#644 の資料の束の中身と文字数、10-05 と 4124 から添付された条）
4. 1 記事あたりの LLM 呼び出し回数と、渡す文字数の見積もり（照合の費用の目安）
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
7. 毛利さん向けの確認方法（レビュー画面のどこを見るか、3 つまで）
