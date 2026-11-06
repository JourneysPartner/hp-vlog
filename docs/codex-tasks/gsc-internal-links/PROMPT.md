あなたは hp-vlog（税理士事務所のサイト、Node.js の静的ビルド）の実装担当です。作業場所はこの作業フォルダ（枝 seo/gsc-internal-links）です。

## やること

docs/codex-tasks/gsc-internal-links/ の README.md・01-placement-links.md・02-weekly-report.md を読み、R1〜R13 をすべて実装してください。

- 01（R1〜R7）を先に、02（R8〜R13）を後に実装する。
- README の「全段階共通の厳守事項」と、各ファイルの「変更してはいけないもの」を必ず守る。特に content/posts/*.md と data/internal-link-terms.json は変えない。
- 指示書に書いていない判断が要る場合は、既存のコードの書き方に合わせて最小限で決め、最後の報告に「決めたこと」として書く。

## 試験

実装後に次を実行し、結果を報告してください。

- `node scripts/lib/__tests__/test-internal-placements.js`
- `node scripts/lib/__tests__/test-page-structure.js`
- `node scripts/lib/__tests__/test-search-console-ingest.js`（R13 を別ファイルにした場合はそれも）
- `npm run validate`
- `npm run build`
- `npm run masters:test`

隔離の中では子プロセスの起動（spawnSync）が EPERM で失敗する試験があります。その場合は「隔離が原因と思われる失敗」として区別して報告してください（隔離の外で再実行します）。

masters:test は試験の副作用で assets/js/tax-simulator*.js や生成物を書き換えることがあります。指示書にないファイルの変更は残さず、最後に `git status --short` の結果を報告してください。

## してはいけないこと

- git の commit・push・枝の切り替え（隔離の中では .git に書けません。コミットは別の担当が行います）
- ネットワークへの接続、npm install
- .github/workflows/ の変更

## 最後の報告（日本語）

1. 変えたファイルの一覧と、それぞれの変更の要点
2. R1〜R13 のそれぞれをどう実装したか（1〜2 行ずつ）
3. 「決めたこと」（指示書に無かった判断）
4. 既存の試験の期待を変えた箇所とその理由（R4・R5 の規則によるものだけのはず）
5. 試験の結果（通過数・失敗の名前と内容）
6. `git status --short` の結果
