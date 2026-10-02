あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回の指示書は `docs/codex-tasks/crawl-queue/11-freshness-p2.md` の 1 本です。設計の背景は `docs/seo/freshness-design.md`、共通の厳守事項は `docs/codex-tasks/crawl-queue/README.md` にあります（01〜10 は実装済みなので触らないでください）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `seo/freshness-p2` です。切り替えないでください。
- 指示書の「今の仕組みのまま作ると起きる問題」を先に読み、該当するコード（`review-approve-background.js`・`publish-due.js`・`build.js` の日付・`source-guard.js`・`generate-draft.js` の `--regenerate`）を確かめてから着手してください。
- 実装は R1 → R6 の順に進め、テストを書いてから最終確認へ進んでください。
- git のコミットはできません（隔離の制約）。変更は作業ツリーに残したままにしてください。
- ネットワークは使えません。`npm install` は済んでいます。
  - LLM・Chatwork・GitHub の API は呼べません。呼び出し部分を差し替え可能にし、偽物でテストしてください。
  - ワークフローの YAML は実行できないので、文字列の検査でテストしてください。
- シェルは Git Bash が落ちることがあります。その場合は PowerShell か cmd を使ってください。`node`（v24）と `npm` は使えます。子プロセスの起動が EPERM になったら、報告したうえで残りを個別に実行してください。
- 作業ツリーは CRLF です。テストで文字列を比べるときは LF に揃えてからにしてください。

## 厳守

- `content/posts/*.md` は 1 ファイルも変更しない。
- 通常の下書きの、生成・差し戻し・承認・見送り・予約公開の挙動を変えない。更新案の分岐は `refresh_of: "published"` の記事だけに効かせる。
- 承認経路で `publish_at`・`published_at`・`publish_slot`・`approved_at` を書き換えない。
- `publish-due.js` と `build.js` の日付の出し方は変えない。
- ワークフローでは入力値を `run:` に直接展開しない（`env:` 経由で使う）。
- 秘密をログに出さない。説明・コメント・画面の文言・通知の文面は日本語で書く。

## 完了時に実行して結果を報告するもの

```
npm run masters:test
node scripts/lib/__tests__/test-freshness-refresh.js
node scripts/lib/__tests__/test-freshness-candidates.js
node scripts/lib/__tests__/test-netlify-ignore.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-review-page.js
node scripts/build-freshness-candidates.js   （実データで実行し、候補件数と、file・refreshable が付いた上位 5 件を報告。更新された data/freshness/candidates.json はこの変更に含める。管理画面が file を使うため）
npm run validate
npm run build
git status --short
git diff --stat
```

`masters:test` に既存の失敗がある場合は、テスト名・エラー・該当箇所を報告し、今回の変更と関係があるかを書いてください。

## 最終報告（そのまま PR 本文になります。日本語で）

1. R1〜R6 ごとに「何を変えたか」「触ったファイル」「テスト結果」
2. 承認経路で公開日の 3 項目に触れていないことを、どのテストで確かめたか
3. 通知 3 種と `refresh_published` の文面例、レビュー画面の更新案表示の要素
4. 【要判断】【要確認】として残した点
