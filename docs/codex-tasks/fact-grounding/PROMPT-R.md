あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i〜03q は実装済みで main に入っています。今回は **`03r-evidence-number-precision.md`（R1〜R5）だけ**を実装してください。照合（fact-check）が、①個人の記事の主張に法人税など別の税目の資料を候補として渡してしまう、②数字の一部だけ裏付けのある答えで、裏付けのある数字まで記事から消してしまう、③根拠のタックスアンサー自身の番号を数字の確認で求めてしまう、の 3 つを直す変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-check-03r` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- まず 03r の「背景」を読み、R1 の例（#642 の c8・c26）と R3 の例（#644 の「相続開始前3年超7年以内は総額100万円まで加算対象外」）を、偽のカタログ・偽の LLM の試験で再現してから直してください。
- 試験は `scripts/lib/__tests__/test-fact-check-03r.js` に書いてください（03r の「試験」1〜8）。既存の試験の期待は、R1〜R5 によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。確かめを弱める方向に期待を変えないでください。`test-workflow-change-detection.js` の期待は変えないでください（今回はワークフローを触らないので、この試験はすべて通るはずです）。
- ネットワークは使えないので、偽の LLM・偽のカタログ（`searchEvidence` の `options.catalog`）で試験してください。依存関係は追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03r の「変更してはいけないもの」を守る。特に、止める範囲と承認の差し止め、fail-closed、引用の実在確認と数字の歯止め（前後 300 字）を弱めない。R3 は「2 か所目の文の中に足りない数字が全部ある」「主張の制度名の語を含む」「判定に見せた同じページの中だけ」の 3 条件を外さず、足した後も今の確かめをそのままかけること。
- 判定・抜き出しの指示文を変えない。修正の指示文は、R4 の `keep_numbers` がある指摘への 1 文の追記だけ。`keep_numbers` が無いときの修正・判定・抜き出しのリクエスト本文は今と 1 バイトも変わらないこと。
- `nta-source-matcher.js` の `tokenizeForMatcher`・`rankSources`、検索用の索引（`data/**/*.index.json`）、1 主張 7 件の上限、`fact-pages.js` の資料表の作り、`max_tokens`、Batch、照合のモデルと effort を変えない。
- 鍵・トークンをログ・記録・例外の文に出さない。
- `content/posts/*.md`・`data/`・`docs/codex-tasks/fact-grounding/fixtures/`・`.github/workflows/` を触らない（読むのはよい）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-check-03r.js
node scripts/lib/__tests__/test-fact-check-03o.js
node scripts/lib/__tests__/test-fact-check-03p.js
node scripts/lib/__tests__/test-fact-cost-03n.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-precision-03l.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-fact-review-fixes-4.js
node scripts/lib/__tests__/test-fact-review-fixes-5.js
node scripts/lib/__tests__/test-fact-review-fixes-6.js
node scripts/lib/__tests__/test-catalog-coverage.js
node scripts/lib/__tests__/test-nta-source-matcher-guard.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-workflow-change-detection.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R1〜R5 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. 既存の試験の期待を変えた箇所とその理由
3. R1（税目の点の下げ方）・R3（2 か所目の探し方と確かめ）・R4（`keep_numbers` の流れ）を、関数名と行で短く説明（Claude が差分を読むときの入口）
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
