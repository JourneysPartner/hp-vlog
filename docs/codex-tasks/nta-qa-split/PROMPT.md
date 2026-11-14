# OpenCode への依頼文（nta-qa-split 段 1）

あなたはこのリポジトリ（hp-vlog、枝 `fix/nta-qa-split-poppler`）の実装担当です。

1. `docs/codex-tasks/nta-qa-split/README.md` と `docs/codex-tasks/nta-qa-split/01-split-and-keep.md` を読み、R1〜R4 と試験 1〜8 を実装してください。
2. 参照ファイルは `.tmp-ref/`（`README.txt` に説明）。読むだけにし、変えないでください。試験の資料は `.tmp-ref/` から小さく切り出して `scripts/lib/__tests__/fixtures/nta-qa-split/` に置いてください。
3. 変えてよいファイルは README の「全段共通の厳守事項」にあるものだけです。`data/` は変えないでください。
4. 試験は `sbx` を通して実行してください（例: `sbx node scripts/lib/__tests__/test-nta-qa-split.js`）。少なくとも次を実行し、結果を報告してください。
   - `scripts/lib/__tests__/test-nta-qa-split.js`
   - `scripts/lib/__tests__/test-nta-qa-scope.js`
   - `scripts/lib/__tests__/test-fact-qa-slot.js`
   - `scripts/lib/__tests__/test-workflow-run-injection.js`
   - `scripts/lib/__tests__/test-nta-qa.js`（main でも「軽減税率 140 件以上」が失敗する既存の失敗があります。それ以外が増えていないことを確かめてください）
5. 01 の「受け入れの目安」を自分でも確かめ、区切れた問の数と、main と本文の文字が一致しない問の一覧を報告してください（確かめ用の小さなスクリプトはコミットしない場所、例えば `.tmp-ref/` の外の `.tmp-check-*.js` に置いてかまいません。終わったら消してください）。
6. コミット・push・パッケージのインストールはしないでください。ネットワークにも出ないでください。
7. 指示書と食い違う・決めきれない点は、勝手に決めず報告に【要判断】として書いてください。

最後の報告は日本語で、01 の「報告の形」に沿って書いてください。
