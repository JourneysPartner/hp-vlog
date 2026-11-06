あなたは hp-vlog（税理士事務所のサイト、Node.js の静的ビルド）の実装担当です。作業場所はこの作業フォルダ（枝 perf/font-loading）です。

## やること

docs/codex-tasks/font-loading/README.md を読み、R1〜R4 をすべて実装してください。「変更してはいけないもの」を必ず守ってください。指示書に無い判断が要る場合は、既存の書き方に合わせて最小限で決め、最後の報告に書いてください。

## 試験

- `node scripts/lib/__tests__/test-performance-basics.js`
- `npm run validate`
- `npm run build`
- `npm run masters:test`

隔離の中では子プロセスの起動（execFileSync・spawnSync）が EPERM で失敗する試験があります。その場合は「隔離が原因と思われる失敗」として区別して報告してください（隔離の外で再実行します）。試験の副作用で指示書に無いファイル（assets/js/tax-simulator*.js など）が変わったら元に戻してください。

## してはいけないこと

- git の commit・push・枝の切り替え（コミットは別の担当が行います）
- ネットワークへの接続、npm install

## 最後の報告（日本語）

1. 変えたファイルの一覧（テンプレートは本数でよい）と変更の要点
2. R1〜R4 をどう実装したか
3. 決めたこと（指示書に無かった判断）
4. 試験の結果（通過数・失敗の名前と内容）
5. `git status --short` の結果
