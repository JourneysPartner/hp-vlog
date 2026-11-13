あなたは hp-vlog（税理士事務所のサイト、Node.js の静的ビルド）の実装担当です。作業場所はこの作業フォルダ（枝 seo/bing-weekly）です。

## やること

docs/codex-tasks/bing-weekly/ の README.md・01-fetch.md・02-report.md を読み、R1〜R11 をすべて実装してください。

- 01（R1〜R8）を先に、02（R9〜R11）を後に実装する。
- README の「方針（全段階共通の厳守事項）」と、各ファイルの「変更してはいけないもの」を必ず守る。特に、鍵（`BING_WEBMASTER_API_KEY`）と鍵の入った URL・応答の本文・例外の文を、ログ・保存するファイル・レポートに入れないこと（R2）。
- 呼ぶ窓口は 01 の R1 の 5 つだけ。他の窓口（URL の送信など）の名前をコードに書かない。
- 指示書に書いていない判断が要る場合は、既存のコード（scripts/fetch-search-console.js・scripts/report-search-console.js）の書き方に合わせて最小限で決め、最後の報告に「決めたこと」として書く。
- 試験の偽の鍵は `fake-bing-key-for-tests` のような鍵らしくない文字列にする。

## 試験

実装後に次を sbx で実行し、結果を報告してください。

- `node scripts/lib/__tests__/test-bing-webmaster.js`
- `node scripts/lib/__tests__/test-search-console-ingest.js`
- `node scripts/lib/__tests__/test-gsc-link-report.js`
- `node scripts/lib/__tests__/test-index-status.js`
- `node scripts/lib/__tests__/test-freshness-candidates.js`
- `node scripts/lib/__tests__/test-workflow-run-injection.js`
- `npm run validate`
- `npm run build`
- `npm run masters:test`

隔離の中では子プロセスの起動（spawnSync・bash）が EPERM などで失敗する試験があります。その場合は「隔離が原因と思われる失敗」として区別して報告してください（隔離の外で再実行します）。

masters:test・build は試験の副作用で assets/js/tax-simulator*.js や sitemap.xml などの生成物を書き換えることがあります。指示書にないファイルの変更は残さず、最後に `git status --short` の結果を報告してください。

## してはいけないこと

- git の commit・push・枝の切り替え（コミットは別の担当が行います）
- ネットワークへの接続、npm install、新しい依存の追加
- 本物の Bing の API を呼ぶこと（試験はすべて偽の fetch で）
- `.github/workflows/fetch-search-console.yml` 以外のワークフローの変更

## 最後の報告（日本語）

1. 変えたファイルの一覧と、それぞれの変更の要点
2. R1〜R11 のそれぞれをどう実装したか（1〜2 行ずつ）
3. 「決めたこと」（指示書に無かった判断）
4. 既存の試験の期待を変えた箇所とその理由（無いはず）
5. 試験の結果（通過数・失敗の名前と内容）
6. `git status --short` の結果
