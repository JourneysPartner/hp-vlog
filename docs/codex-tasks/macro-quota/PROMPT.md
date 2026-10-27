あなたは hp-vlog（mori-zeirishi.net の Netlify サイトと記事の自動生成）のリポジトリで作業します。

## やること

`docs/codex-tasks/macro-quota/README.md` と `docs/codex-tasks/macro-quota/01-strict-quota.md` を最初に全部読み、01 の R1〜R4 を実装し、「試験」の 1〜6 を作って通し、「確かめること（実データ）」を実行してください。

- 作業ブランチ `feat/macro-quota` はチェックアウト済みです。ブランチを切り替えないでください。
- 指示書に書かれていないファイルは変えないでください（「変更してはいけないもの」を必ず守る）。ついでの整理・書式の変更もしないでください。
- 指示書と実際のコードが食い違っていて判断が要る場合は、勝手に決めず、最終報告に【要判断】として書いてください。

## 環境の注意

- 隔離の中ではネットワークが使えません。`npm install` は済んでいます。
- Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その時は PowerShell か cmd を使ってください。
- 隔離の中では `.git` に書けないので、コミットはしないでください（変更を作業ツリーに残して終える）。
- 隔離の中では `spawnSync` の試験が EPERM で落ちることがあります。それが原因の失敗は「隔離による EPERM」と書いて報告してください。
- `npm run masters:test` は main でも 3 本目（`test-check-master-freshness.js`、出典ハッシュ 148 件）で止まる既存の失敗があります。`masters:test` 全体ではなく、関係する試験を個別に実行してください。`test-gsc-topics.js` の失敗も既存です。
- `npm run build` で `assets/js/tax-simulator-boot.js` の改行が変わったら、その差分は元に戻してください。

## 確かめること

1. `node scripts/lib/__tests__/test-macro-quota.js` と、01 の試験 6 に挙げた既存の試験を個別に実行
2. `npm run build` と `npm run validate`
3. 「確かめること（実データ）」

## 最終報告（日本語）

- 変更したファイルと、R1〜R4 をどこでどう実装したか（1〜3 行ずつ）
- 試験の結果（通った数・落ちた試験の名前とエラー）、実データでの判定の結果
- 【要判断】があればその内容
- PR 本文の下書き（背景・変更点・試験・元に戻す方法）
