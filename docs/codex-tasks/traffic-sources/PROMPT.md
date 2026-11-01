`docs/codex-tasks/traffic-sources/README.md` と `01-sources-devices-engaged.md` を読み、01 の R1〜R6 と試験を実装してください。

## 作業の条件

- 作業場所はこのフォルダです。枝は `feat/traffic-sources` です。枝を切り替えないでください。
- この環境は隔離の中で動いていて、`.git` に書き込めません。`git add`・`git commit` はせず、実装と試験までで止めてください。コミットと PR は Claude が行います。
- ネットワークは使えません。追加のパッケージを入れないでください。
- `npm run build` は済んでいます。`contact.html` などの生成物は揃っています。
- Git Bash が動かないときは PowerShell か cmd に切り替えてください。
- 子プロセスを起こす試験が `EPERM` で失敗するのは隔離のせいです。その試験だけが失敗するなら、最終報告にそう書いてください。
- `assets/js/tax-simulator*` が変更済みに見えても触らないでください。
- 指示書に無いファイルを変更しないでください。`templates/pages/privacy.html` は絶対に変更しないでください。
- `scripts/build.js` の計測の文はテンプレート文字列の中にあります。バッククォートと `${` を入れないでください。
- 判断に迷う点は、推測で広げず、最終報告に【要確認】として書いてください。

## 確かめる試験

次を実行し、全部通してください。

```
node scripts/lib/__tests__/test-analytics-store.js
node scripts/lib/__tests__/test-track-visit.js
node scripts/lib/__tests__/test-contact-transition.js
```

## 最終報告に書くこと

1. 変更したファイルの一覧
2. 試験の結果（件数）
3. 指示書と違う判断をした点とその理由
4. 【要確認】の点
5. PR 本文の案（変更の理由・変更内容・確認した内容）
