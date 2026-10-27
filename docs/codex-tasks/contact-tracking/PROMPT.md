あなたは hp-vlog（mori-zeirishi.net の Netlify サイト）のリポジトリで作業します。

## やること

`docs/codex-tasks/contact-tracking/README.md` と `docs/codex-tasks/contact-tracking/01-pretty-urls-and-submissions.md` を最初に全部読み、01 の R1〜R6 を実装し、「試験」の 1〜6 を作って通してください。

- 作業ブランチ `fix/contact-tracking` はチェックアウト済みです。ブランチを切り替えないでください。
- 指示書に書かれていないファイルは変えないでください（「変更してはいけないもの」を必ず守る）。ついでの整理・書式の変更もしないでください。
- 指示書と実際のコードが食い違っていて判断が要る場合は、勝手に決めず、最終報告に【要判断】として書いてください。

## 環境の注意

- 隔離の中ではネットワークが使えません。`npm install` は済んでいます。
- Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その時は PowerShell か cmd でコマンドを実行してください。
- 隔離の中では `.git` に書けないので、コミットはできません。コミットしようとせず、変更を作業ツリーに残して終えてください。
- 隔離の中では子プロセスで node を起動する試験（`spawnSync`）が EPERM で落ちることがあります。それが原因の失敗は、失敗した試験名と「隔離による EPERM」と書いて報告してください（隔離の外で再実行します）。

## 確かめること

1. 次を個別に実行し、結果を報告する。
   - `node scripts/lib/__tests__/test-analytics-store.js`
   - `node scripts/lib/__tests__/test-track-visit.js`
   - `node scripts/lib/__tests__/test-contact-transition.js`
   - （ビーコンの試験を別ファイルにした場合はそれも）
   - `node scripts/lib/__tests__/test-workflow-change-detection.js`
2. `npm run build` と `npm run validate`
3. `npm run masters:test`（時間がかかります。最後に 1 回）。`assets/js/tax-simulator-boot.js` の改行が変わった場合は、その差分は元に戻してください。

## 最終報告に書くこと（日本語）

- 変更したファイルの一覧と、R1〜R6 のそれぞれをどこでどう実装したか（1〜3 行ずつ）
- 試験の結果（通った数・落ちた試験の名前とエラー）
- 【要判断】があればその内容
- PR の本文の下書き（背景・変更点・試験・本番反映後の確認手順。README の「受け入れ確認」の最後の項目を確認手順として入れる）
