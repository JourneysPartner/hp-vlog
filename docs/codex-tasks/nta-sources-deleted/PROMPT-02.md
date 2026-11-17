# OpenCode への依頼文（nta-sources-deleted 段 2、2026-11-17）

あなたはこのリポジトリ（hp-vlog、枝 `fix/nta-sources-unlisted`）の実装担当です。段 1（01・01b・01c）は実装済み・マージ済みです。

1. `docs/codex-tasks/nta-sources-deleted/README.md` と `docs/codex-tasks/nta-sources-deleted/02-unlisted-records.md` を読み、P1〜P7 と試験 V1〜V19 を実装してください。守ること U1〜U12 は、どれも試験で確かめてください。段 1 の要件（01・01b・01c）は、02 で書き足す所のほかは変えないでください。
2. 変えてよいファイルは 02 の「この段の厳守事項」にあるものだけです。`data/`・`docs/`・`package.json`・ほかのワークフロー・今のほかの試験の中身は変えないでください。ファイルを消す処理を足さないでください。
3. 試験は `sbx` を通して実行してください（例: `sbx node scripts/lib/__tests__/test-nta-deleted-pages.js`）。少なくとも次を実行し、結果を報告してください。
   - `scripts/lib/__tests__/test-nta-deleted-pages.js`（今ある試験と足した試験の全件が通ること）
   - 02 の V19 に挙げた今の試験すべて（全件通ること）
   - `scripts/lib/__tests__/test-workflow-run-injection.js`（`sbx` の中で bash が起動できないことがあります。その場合は起動できなかったことだけ報告してください。Claude が外で実行します）
4. 確かめ用の小さな台本を作るなら `.tmp-check-*.js` に置き、終わったら消してください（コミットはしません）。
5. コミット・push・パッケージのインストールはしないでください。ネットワークにも出ないでください（本物の国税庁のページは取りに行かない）。
6. 指示書と食い違う・決めきれない点は、勝手に決めず報告に【要判断】として書いてください。

最後の報告は日本語で、02 の「報告の形」に沿って書いてください。
