あなたは hp-vlog（mori-zeirishi.net の Netlify サイトと記事の自動生成）のリポジトリで作業します。

## やること

`docs/codex-tasks/revise-multi-point/README.md` と `docs/codex-tasks/revise-multi-point/01-multi-point.md` を最初に全部読み、01 の R1〜R7 を実装し、「試験」の 1〜11 を作って通してください。試験データは `docs/codex-tasks/revise-multi-point/fixtures/` にあります。

- 作業ブランチ `fix/revise-multi-point` はチェックアウト済みです。ブランチを切り替えないでください。
- 指示書に書かれていないファイルは変えないでください（「変更してはいけないもの」を必ず守る）。ついでの整理・書式の変更もしないでください。
- 指示書と実際のコードが食い違っていて判断が要る場合は、勝手に決めず、最終報告に【要判断】として書いてください。

## 環境の注意

- 隔離の中ではネットワークが使えません。`npm ci` は済んでいます。本物の LLM は呼ばないでください（試験は偽の LLM だけ）。
- Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その時は PowerShell か cmd を使ってください。
- 隔離の中では `.git` に書けないので、コミットはしないでください（変更を作業ツリーに残して終える）。試験 11 の一時フォルダの git は OS の一時フォルダに作ってください（書けなければ理由を出して飛ばす）。
- 隔離の中では `spawnSync` の試験が EPERM で落ちることがあります。それが原因の失敗は「隔離による EPERM」と書いて報告してください。
- `npm run masters:test` は main でも既存の失敗（`test-check-master-freshness.js`・`test-gsc-topics.js`）で止まります。全体ではなく、関係する試験を個別に `node scripts/lib/__tests__/<名前>.js` で実行してください。
- `npm run build` で `assets/js/tax-simulator-boot.js` の改行が変わったら、その差分は元に戻してください。

## 確かめること

1. `node scripts/lib/__tests__/test-revise-multi-point.js`
2. 01 の最後に挙げた既存の試験を個別に
3. `npm run validate`

## 最終報告（日本語）

- 変更したファイルと、R1〜R7 をどこでどう実装したか（1〜3 行ずつ）
- 試験の結果（通った数・落ちた試験の名前とエラー）
- 既存の試験の期待を変えたものの一覧と理由
- 【要判断】があればその内容
- PR 本文の下書き（背景・変更点・試験・元に戻す方法）
