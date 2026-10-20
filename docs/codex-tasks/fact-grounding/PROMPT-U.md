あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。03i〜03t は実装済みです（03r〜03t は `fix/fact-check-03r`、PR #696）。今回は **`03u-extract-types-and-evidence.md`（U1〜U3）だけ**を実装してください。照合（fact-check）で、①抜き出しの種類の名前の書き方のせいで要件の主張が捨てられる、②年だけの日付が本文の年月日と結びつかず主張が捨てられる、③判定で同じ資料表の候補の外の正しい資料が却下される、の 3 つを直す変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-check-03u`（`fix/fact-check-03r` の上）です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- まず 03u の「背景」を読み、U1（`"type":"対象・条件"` で捨てる）・U2（`日付:令和6` と `日付:令和6-1-1`）・U3（候補の外のページで落とす）を偽の LLM の試験で再現してから直してください。
- 試験は `scripts/lib/__tests__/test-fact-check-03u.js` に書いてください（03u の「試験」1〜5）。既存の試験の期待は、U1〜U3 によって変わるもの（指示文の文字列・リクエスト本文の一致・`LOGIC_VERSION`）だけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。確かめを弱める方向に期待を変えないでください。`test-workflow-change-detection.js` の期待は変えないでください。
- ネットワークは使えないので、偽の LLM で試験してください。依存関係は追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03u の「変更してはいけないもの」を守る。特に、止める範囲と承認の差し止め、fail-closed、引用の実在確認と数字の歯止めを弱めない。U3 は候補の外のページにも今と同じ確かめを全部かけること。U1 の読み替えは指示書の一覧だけ。
- 修正の指示文、候補の出し方、資料表の作り、主張数の上限、`max_tokens`、Batch、照合のモデルと effort を変えない。
- 鍵・トークンをログ・記録・例外の文に出さない。
- `content/posts/*.md`・`data/`・`docs/codex-tasks/fact-grounding/fixtures/`・`.github/workflows/` を触らない（読むのはよい）。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-check-03u.js
node scripts/lib/__tests__/test-fact-check-03t.js
node scripts/lib/__tests__/test-fact-check-03s.js
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
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-workflow-change-detection.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. U1〜U3 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. 既存の試験の期待を変えた箇所とその理由
3. U3（候補の外のページを認める流れ、候補への追加と記録）を関数名と行で短く説明
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】として残した点
