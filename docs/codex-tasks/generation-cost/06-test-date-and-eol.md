# 06 試験の時限式（F4）と作業フォルダの改行コード（03o・03n）

2026-10-26 時点で、照合と無関係の試験が 2 種類落ちている。どちらも本番のコードの不具合ではない。

## T1 F4 の試験が 2026-10-25 を過ぎると落ちる

- 落ちる試験: `scripts/lib/__tests__/test-generation-review-fixes.js` の「F4: 7日間だけ候補IDで除外し、検索語や恒久取り下げを変えない」（233〜234 行目の `recordWithdrawnFile` → `assert.deepEqual(... runner.additions)`）。
- 原因: 試験は固定の日付 `now = 2026-10-19` で一時的な除外（`generation-failed-candidate`）を作るので、期限 `expires_at` は `2026-10-25T15:00:00.000Z` になる。追記の処理 `appendWithdrawnTopics`（`scripts/lib/withdrawn-topics.js`）は**実際の今日の日付**で期限切れの項目を捨てるので、10/25 15:00Z を過ぎると追記の結果が空になる。
- 本番の処理（期限切れを追記のときに捨てる）は正しい。**直すのは試験だけ**。
- 直し方: 追記の確かめに使う記録（230〜234 行目の `runner`）は、実際の今日の日付で作る（`now: new Date()` か、`now` を渡さない）。その部分だけを変え、同じ試験の前半（固定の日付で `findWithdrawnTopic` を確かめる部分）と、ほかの F4 の試験（`expires_at` を `2026-10-25T15:00:00.000Z` と固定で確かめる部分は `runSingleDraft('2026-10-19', …)` の固定日なので時限式ではない）は変えない。
- 変更してはいけないもの: `scripts/lib/withdrawn-topics.js`・`scripts/record-withdrawn-topics.js`・`data/withdrawn-topics.json`（本番のコードとデータ）。

## T2 作業フォルダのワークフローが CRLF だと 03o・03n の試験が落ちる

- 落ちる試験: `scripts/lib/__tests__/test-fact-check-03o.js`・`test-fact-cost-03n.js`（どちらも `.github/workflows/*.yml` を読み、改行 `\n` を前提に確かめる）。
- 原因: この PC は `core.autocrlf=true` で、作業フォルダの `.github/workflows/*.yml` のうち 12 本が CRLF になっている（リポジトリの中身は LF。GitHub Actions は Linux で LF のまま動く）。ワークフローを読む試験は 2 本を含めて 13 本ある。
- 直し方: `.gitattributes` に `.github/workflows/*.yml text eol=lf` の 1 行を足す（既存の行の並びと書き方に合わせる）。試験の側は変えない。
- 作業フォルダのファイルを LF に戻す操作（`git checkout`）は git に書き込むので Codex はしない。Claude が後で行う。Codex の環境で 03o・03n が CRLF のせいで落ちても、それは想定どおりなので落ちた試験名だけ報告する。
- 変更してはいけないもの: `.github/workflows/` の中身（改行コードも含めて書き換えない）・既存の `.gitattributes` の行。

## 受け入れ確認（Claude が隔離の外で行う）

- T1: `test-generation-review-fixes.js` が全部通る。さらに、実際の日付を 2026-11-30 などに進めても通る（期限の 7 日の中で作るので）。
- T2: `.gitattributes` を足した後、作業フォルダのワークフローを LF に戻すと 03o・03n が通る。`git diff` は `.gitattributes` の 1 行と試験の数行だけ。
