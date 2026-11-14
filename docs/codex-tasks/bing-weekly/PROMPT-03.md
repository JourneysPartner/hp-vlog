あなたは hp-vlog（税理士事務所のサイト、Node.js の静的ビルド）の実装担当です。作業場所はこの作業フォルダ（枝 seo/bing-weekly、01・02 の実装はコミット済み）です。

## やること

docs/codex-tasks/bing-weekly/03-review-fixes.md を読み、R12〜R17 を実装してください。README.md・01-fetch.md・02-report.md は前提として読んでください。

- README の「方針（全段階共通の厳守事項）」を守る。特に、鍵・鍵の入った URL・応答の本文・例外の文をログ・保存するファイル・レポートに入れないこと。
- 変えるのは scripts/fetch-bing-webmaster.js・scripts/report-search-console.js・.github/workflows/fetch-search-console.yml・scripts/lib/__tests__/test-bing-webmaster.js だけ。
- 既存の試験の期待は、03 の R13 に書いた「9 (d)」以外は変えない。
- 指示書に無い判断が要る場合は最小限で決め、最後の報告に「決めたこと」として書く。

## 試験

実装後に次を sbx で実行し、結果を報告してください。

- `node scripts/lib/__tests__/test-bing-webmaster.js`
- `node scripts/lib/__tests__/test-search-console-ingest.js`
- `node scripts/lib/__tests__/test-gsc-link-report.js`
- `node scripts/lib/__tests__/test-freshness-candidates.js`

## してはいけないこと

- git の commit・push・枝の切り替え
- ネットワークへの接続、npm install、本物の Bing の API を呼ぶこと

## 最後の報告（日本語）

1. 変えたファイルと変更の要点
2. R12〜R17 のそれぞれをどう実装したか（1〜2 行ずつ）
3. 「決めたこと」
4. 試験の期待を変えた箇所とその理由
5. 試験の結果（通過数・失敗の名前と内容）
6. `git status --short` の結果
