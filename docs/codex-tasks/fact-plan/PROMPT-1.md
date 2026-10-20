あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-plan/` にあります。今回は **`01-plan-and-writer-materials.md`（P1〜P8）**を実装してください。記事を書く前に扱う制度と制度ごとの資料を決めて書き手に渡し、渡した資料を記録して、照合（fact-check）ではまずその資料で判定する（段 A）、資料なしになった主張だけ今と同じ全体の検索で判定し直す（段 B）変更です。

## 進め方

- まず `README.md` の 1（背景・試しの結果）と 01 を全部読んでください。
- 作業ブランチは現在チェックアウト済みの `feat/fact-plan-01`（main の上）です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- P2 の関連の確かめは、指示書の表の実例（「２割特例（…）」に「基準期間がない法人の納税義務の免除の特例」を選んでしまう、「棚卸資産の評価方法」に No.1110 を選んでしまう）を、まず今の `searchEvidence` で再現してから作ってください。
- 試験は `scripts/lib/__tests__/test-fact-plan-01.js` に書いてください（01 の P7 の 1〜12）。既存の試験の期待は、この変更で必ず変わるもの（`LOGIC_VERSION` の文字列など）だけを最小限直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。確かめを弱める方向に期待を変えないでください。`test-workflow-change-detection.js` の期待は変えないでください（未コミットの間は落ちる試験なので流さなくてよい）。
- ネットワークは使えないので、偽の LLM で試験してください。依存関係は追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 01 の P8「変更してはいけないもの」を守る。特に、書き手の資料が無い記事の照合は呼び出し・記録・結果とも今と同じにする。照合の確かめ（引用の実在・数字の歯止め・候補の外の資料・期限の書き漏れ）、止める範囲、承認の差し止め、fail-closed を弱めない。
- 計画・資料探しの失敗で生成を止めない（今と同じ生成に戻し、注意書きを出す）。`FACT_PLAN_ENABLED=false` では生成の指示と前付けを今と 1 字も変えない。
- `searchEvidence` のカタログに Q&A を足さない（計画の資料探しの側だけで Q&A を探す）。
- 鍵・トークンをログ・記録・例外の文に出さない。
- `content/posts/*.md`・`data/`・`docs/codex-tasks/fact-grounding/fixtures/` を触らない（読むのはよい）。ワークフローは P6 の env の行と `fact-check.yml` の取り出し一覧だけ。説明・コメント・最終報告は日本語。
- 判断に迷う点は【要判断】として最終報告に残し、指示書の既定どおりに実装してください。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-check-03x.js
node scripts/lib/__tests__/test-fact-check-03w.js
node scripts/lib/__tests__/test-fact-check-03v.js
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
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-materials-bundle.js
node scripts/lib/__tests__/test-law-changes-injection.js
node scripts/lib/__tests__/test-nta-qa-scope.js
node scripts/lib/__tests__/test-generation-one-pass.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. P1〜P6 ごとに「何を変えたか」「触ったファイルと関数」「試験の結果（PASS/FAIL の数）」
2. P2 の表の実例ごとに、選んだページ（題名と id）と、関連の確かめのどの条件で通ったか。成り立たなかった行があれば理由
3. 段 A / 段 B と歯止め（`checkTally`）の流れを関数名と行で短く説明
4. 既存の試験の期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点（P3 の出典未確定の題材の扱いを含む）
