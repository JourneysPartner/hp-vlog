あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/masters-notify/` にあります。まず `README.md` を読み、次に `01-notify-route.md` を実装してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/masters-notify` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。push と PR も別の担当が行います。
- 指示書の R 番号を順に満たし、テストを書いてから最終報告してください。
- 迷ったら README の「全段階共通の厳守事項」を優先し、判断が必要な点は実装せずに最終報告に【要判断】として書いてください。
- ネットワークは使えません。`npm install` は済んでいます。通知は送らないでください（`scripts/notify.js` を実際に動かさない）。
- Windows です。Git Bash が `CreateFileMapping ... error 5` で落ちることがあります。その場合は PowerShell か cmd を使ってください。ファイルは LF・UTF-8（BOM なし）で書いてください。
- この環境では子プロセスで node・git・bash を起動する試験が EPERM で落ちることがあります。その場合は落ちた試験名とエラーの 1 行目だけ報告してください。別の担当が環境の外で再実行します。EPERM を避けるために試験の設計を変えないでください。

## 厳守

- 既存の通知イベントの文面、`notify-dispatch.js`・`notify.js`・`chatwork.js`・`lineworks.js` を変えない。
- `check-master-freshness.js` の `check()`・`buildReport()`・既存の出力項目を変えない。
- `crawl-nta-sources.yml`・`check-existing-posts.yml` を変えない。
- ワークフローの `run:` の中に `${{ }}` を書かない。
- マスター・国税庁データ・記事を変えない。
- 鍵の形の文字列を直書きしない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-masters-workflow.js
node scripts/lib/__tests__/test-check-master-freshness.js
node scripts/lib/__tests__/test-workflow-run-injection.js
node scripts/lib/__tests__/test-workflow-change-detection.js
node scripts/lib/__tests__/test-run-test-files.js
npm run masters:test
node -e "const m=require('./scripts/check-master-freshness.js');const s=m.buildNotifySummary(m.check('2026-10-27'));console.log(s);console.log('文字数',s.length)"
git status --short
git diff --stat
```

## 最終報告（日本語で）

1. R1〜R6 ごとに「何を変えたか」「触ったファイル」「テスト結果（PASS/FAIL の数）」
2. 実データの要約の全文と文字数
3. ワークフローの差分の要約（各段の `if` の前後）
4. EPERM などで確かめられなかった試験
5. 【要判断】【要確認】として残した点
