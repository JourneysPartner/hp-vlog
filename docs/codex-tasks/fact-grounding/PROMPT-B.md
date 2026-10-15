あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。まず `README.md` を読んでください。01〜03 は前回の回で実装済み・コミット済みです。今回は次の順で行ってください。

1. `03b-review-fixes.md`（01〜03 のレビュー指摘の修正。あれば最優先）
2. `04-catalog-coverage.md`（主要税法・施行令・措置法関係通達をカタログに追加）
3. `05-published-audit.md`（公開済み記事の一括照合。実装だけで実行しない）

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。git の読み取りは使えます。
- 指示書の R 番号・F 番号を順に満たし、テストを書いてから最終報告してください。
- 迷ったら指示書の「変更してはいけないもの」と README の「照合は落とす側に倒す」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。法令の ID・章立ては `docs/codex-tasks/fact-grounding/fixtures/law-ids.json`、通達のページの見本は `fixtures/tsutatsu/`（一覧は `fixtures/tsutatsu-pages.json`、Shift_JIS のバイト列のまま）にあります。実際の取り込み（e-Gov・国税庁への接続）はしないでください。取り込みはマージ後に CI の手動ワークフローで行います。
- LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd でコマンドを実行してください。ファイルは LF で書いてください。
- この環境では子プロセスで node を起動するテスト（build を呼ぶもの）が EPERM で落ちることがあります。その場合は落ちたテスト名だけ報告してください。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、記事系のワークフローを変えるとコミット前は必ず落ちます。直さないでください。
- main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は今回の対象外です。直さないでください。

## 厳守

- `content/posts/*.md` を触らない。`data/law-sources/`・`data/nta-tsutatsu/` の既存の取り込み結果を手で書き換えない（定義と取り込み処理・読み込み処理だけを変える）。
- 既存の法令（民法・戸籍法・不動産登記法等）と手続き機関のページ、既存の通達（所基通・法基通・消基通・相基通）の解析結果を変えない。
- 既存の選定・重複判定・品質ゲート・禁止表現・論点別ルール・番号の照合を弱めない。カタログに無い番号の警告は従来どおり。
- 指示書にあるもの以外のプロンプト文言を変えない。
- 05 のスクリプトとワークフローは実装だけ。実行しない。定期実行にしない。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run build
npm run validate
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-citation-linker.js
node scripts/lib/__tests__/test-law-citation-rule.js
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-freshness-refresh.js
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-promote-source.js
node scripts/lib/__tests__/test-llm-auto-trust.js
node scripts/lib/__tests__/test-llm-source-selector.js
node scripts/lib/__tests__/test-source-selection-improvement.js
node scripts/lib/__tests__/test-partial-revise.js
node scripts/lib/__tests__/test-placeholder-title.js
node scripts/lib/__tests__/test-quality-gate.js
git status --short
git diff --stat
```

04・05 の新しいテストファイルも実行してください。あわせて `scripts/lib/__tests__/` の全テストを実行し、上の対象外 4 本と EPERM 以外に失敗が無いことを確かめてください。`npm run build` が書き換えた追跡対象のファイルは元に戻してください。

## 最終報告（そのまま PR 本文になります。日本語で）

1. 03b の F 番号ごと、04 の R1〜R4、05 の R1〜R3 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 04: 追加した法令・通達の一覧（key・別名・`elms`）、「措通」の解決の結果（見本の番号ごとにどの通達に決まったか）、取り込み後のサイズの見積もり
3. 04: 通達の見本ページの解析結果（通達ごとの項目数・最初と最後の番号・重複した番号）
4. 05: `--dry-run` の見積もり（偽の LLM で、公開済み記事 10 本あたりの主張の件数と渡す文字数）
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
7. マージ後に Claude が行う作業（取り込みワークフローの実行手順と、取り込み後に確かめること）
