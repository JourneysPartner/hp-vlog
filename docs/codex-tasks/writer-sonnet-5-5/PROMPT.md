hp-vlog リポジトリで作業してください。作業ブランチは `feat/writer-sonnet-5-5`（すでに切り替え済み。main から作成）。

`docs/codex-tasks/writer-sonnet-5-5/README.md` と `01-switch.md` を読み、01 の R1〜R4 を実装し、テスト項目を足して流してください。

- 範囲は 01 の「要件」だけ。「変更してはいけないもの」に挙げたファイルは触らないでください（特に `scripts/generate-draft.js`）。
- 隔離の中では `.git` に書けないので、コミットはしなくて構いません（Claude が後でコミットします）。
- Git Bash が落ちる場合は PowerShell か cmd でコマンドを実行してください。ネットワークは使えません。
- 実際の API（Anthropic / OpenAI）は呼ばないでください。テストは fetch・OpenAI を差し替えて確かめます。

最後に、次を短く報告してください:
1. 変えたファイルと要点（R1〜R4 ごと）
2. 足した・変えたテストと、流したテストの結果（通過数／失敗があれば名前と理由）
3. `maxTokensFor` の値の比較表（記事タイプ 2〜3 種 × Sonnet 4.6 / Sonnet 5.5）
4. 指示書と違う判断をした箇所、気になった点
