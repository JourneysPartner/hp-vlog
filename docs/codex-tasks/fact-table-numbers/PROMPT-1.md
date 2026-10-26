あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。記事の事実照合（`scripts/lib/fact-check.js`）の機械の確かめが、国税庁のページの表で空白で区切られた数字（「400 80％」）を 1 つの数（40080％）として読み、Opus の正しい裏付けを落として正しい数字を記事から消した不具合と、表の行の扱いの穴を直してください。指示書は `docs/codex-tasks/fact-table-numbers/` の `README.md` と `01-table-numbers.md` です（R1〜R4）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-table-numbers`（main の上）。ブランチを切り替えないでください。コミットはしないでください（この環境ではできません）。
- 基準は `%TEMP%\hpstatus\fact-table\` にあります（`table-bench.js`・基準の数字 `reference.json`・10/26 の記録と記事・今の結果 `base.txt`）。まず `node "%TEMP%\hpstatus\fact-table\table-bench.js" .` を流して今の結果（1: 違う 303・読めない数を含む資料 3／2: 0/6・誤った数字が 1/3 通る／3: 2/5）を確かめ、直すたびに流してください。`table-bench.js`・`reference.json`・記録・記事は変えないでください（測り方を変えない）。`--make-reference` は流さないでください。作業用のファイルはリポジトリの外（`%TEMP%` の下）に置いてください。
- 指示書の R1〜R4 と「変更してはいけないもの」を守ってください。特定の記事・語・ページ ID のための決め打ちは足さないでください。引用の位置の探し方と前後 300 字の範囲は変えないでください。
- 試験は `scripts/lib/__tests__/test-fact-table-numbers.js` を新しく作ってください（指示書の「試験」1〜8）。既存の試験の期待は変えないでください（`LOGIC_VERSION` の値だけは直してよい。直した箇所を報告）。
- ネットワーク不可・依存関係の追加なし・LF・説明は日本語。Git Bash が使えなければ PowerShell/cmd を使ってください。判断に迷う点は【要判断】として残し、指示書の既定どおりに実装してください。

## 完了時に実行して結果を報告するもの

```
node "%TEMP%\hpstatus\fact-table\table-bench.js" .
node scripts/lib/__tests__/test-fact-table-numbers.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-precision-03l.js
node scripts/lib/__tests__/test-fact-check-03o.js
node scripts/lib/__tests__/test-fact-check-03p.js
node scripts/lib/__tests__/test-fact-check-03r.js
node scripts/lib/__tests__/test-fact-check-03u.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-fact-search-recall.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）と EPERM 以外に失敗が無いことを確かめてください。`test-workflow-change-detection.js` は未コミットの間は落ちるので流さなくてよい。`test-fact-check-03o.js`・`test-fact-cost-03n.js` はこの PC の作業ツリーの改行（CRLF）で落ちることがあるので、落ちたら理由を書くだけでよい。

## 最終報告（日本語で）

1. 何を変えたか（関数と行）。R1 で同じ読み方にした数字の読み取りの経路の一覧（指示書に無いものを含む）と、区切りの実装の仕方
2. `table-bench.js` の最終結果（1〜3 の全部）。1 で基準と違う資料があれば全件と理由
3. 試験の結果（全テストは対象外と EPERM を名前だけ）
4. 【要判断】【要確認】
