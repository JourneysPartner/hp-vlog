あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。記事の事実照合で、主張ごとに資料を探す検索（`scripts/lib/fact-evidence.js` の `searchEvidence`）が、正しいページを候補 7 件に入れられない取りこぼしを直してください。指示書は `docs/codex-tasks/fact-search/` の `README.md` と `01-search-recall.md` です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-search-recall`（main の上）。ブランチを切り替えないでください。コミットはしないでください（この環境ではできません）。
- 基準は `%TEMP%\hpstatus\search-bench\` にあります（`cases.json`・`bench.js`・今の結果 `base.txt`）。まず `node "%TEMP%\hpstatus\search-bench\bench.js" .` を流して今の結果（keep 712/712・target 0/18・資料表 611,483 字）を確かめ、直すたびに流してください。`cases.json` と `bench.js` は変えないでください（測り方を変えない）。作業用のファイルはリポジトリの外（`%TEMP%` の下）に置いてください。
- 指示書の R1〜R5 を守り、一般の順位づけの直しにしてください。特定の記事・語・ページ ID のための規則（同義語の表への追加、決め打ち）は足さないでください。候補の数（7 件）は増やさないでください。
- 試験は `scripts/lib/__tests__/test-fact-search-recall.js` を新しく作ってください（指示書の「試験」1〜5）。既存の試験の期待は変えないでください（`LOGIC_VERSION` の値だけは直してよい。直した箇所を報告）。
- ネットワーク不可・依存関係の追加なし・LF・説明は日本語。Git Bash が使えなければ PowerShell/cmd を使ってください。判断に迷う点は【要判断】として残し、指示書の既定どおりに実装してください。

## 完了時に実行して結果を報告するもの

```
node "%TEMP%\hpstatus\search-bench\bench.js" .
node scripts/lib/__tests__/test-fact-search-recall.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-03r.js
node scripts/lib/__tests__/test-fact-pages.js
node scripts/lib/__tests__/test-fact-plan-01.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）と EPERM 以外に失敗が無いことを確かめてください。`test-workflow-change-detection.js` は未コミットの間は落ちるので流さなくてよい。

## 最終報告（日本語で）

1. 何を変えたか（関数と行）、採った直し・試して採らなかった直しとその基準の結果（keep・target・資料表）
2. `bench.js` の最終結果（keep・target・記事ごとの資料表）。外れた keep があれば全件と、その主張に残る正しいページ
3. 拾えない target の理由（何位にいるか、何が上に来るか）
4. 試験の結果（全テストは対象外と EPERM を名前だけ）
5. 【要判断】【要確認】
