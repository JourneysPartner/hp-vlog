# 02 点検の「生成が動いたか」を生成予定（cron）基準にする

背景は `README.md` の問題 2。

## R1 判定を部品にする

新しいモジュール `scripts/lib/draft-schedule.js`:

- `readDraftCron(netlifyTomlText)` … `[functions."scheduler-daily-draft"]` の `schedule = "..."` を取り出す。
- `parseCron(expr)` … `分 時 * * 曜日` の形だけを受け付ける（曜日は `*`・単一の数字・カンマ区切り。0 と 7 は日曜）。時刻は **UTC**（Netlify の cron は UTC）。それ以外の形は「読めない」として返す。
- `latestExpectedSlot(now, cron, graceMinutes = 180)` … `now − 猶予` 以前で最も新しい予定時刻（UTC の Date）を返す。猶予はスケジューラの遅れと生成の所要時間（4 分前後）を見込んだもの。
- `judgeDraftRan(runs, slot, toleranceMinutes = 10)` … `runs` は `gh run list --json createdAt,conclusion,displayTitle` の配列。`conclusion === 'success'` かつ `createdAt >= slot − 許容` の件数を返す。手動実行（`[source=manual]`）も数える。
- cron が読めないときは「毎日 00:05 UTC」とみなし（多めに警告する側に倒す）、警告文を返す。

## R2 点検スクリプト

新しいスクリプト `scripts/check-draft-ran.js`:

- 引数 `--runs <file>`（`gh run list` の JSON）。`netlify.toml` はリポジトリから読む。現在時刻は環境変数 `CHECK_NOW`（ISO 8601）で上書きできる（テスト用）。
- 標準出力に「直近の生成予定: YYYY-MM-DD HH:MM JST（曜日）／その後に成功した生成: N 件」を出す。
- `GITHUB_OUTPUT` があれば `count=<N>` と `expected_jst=<YYYY-MM-DD>` を書く。
- N が 0 なら `::error::直近の生成予定（YYYY-MM-DD）の後に成功した記事生成がありません` を出す。終了コードは 0（ジョブの失敗判定は既存の最終ステップが `count` を見て行う）。

## R3 ワークフロー

`.github/workflows/check-existing-posts.yml` の「Check daily draft ran」の中身を差し替える:

```
gh run list --workflow=daily-draft.yml --limit 20 --json createdAt,conclusion,displayTitle > /tmp/draft-runs.json
node scripts/check-draft-ran.js --runs /tmp/draft-runs.json
```

- ステップ名・`id: draftrun`・出力名 `count` は変えない（後続の通知と最終判定がそのまま使う）。
- 通知ステップのコメント文を「直近の生成予定（${{ steps.draftrun.outputs.expected_jst }}）の後に成功した記事生成がありません（実行されていない可能性があります）。」に変える。それ以外のステップは変えない。
- 冒頭のコメント（「直近24時間に成功した生成があるかを…」）を新しい判定の説明に直す。

## テスト（新しいファイル `scripts/lib/__tests__/test-draft-schedule.js`）

cron は実際の `5 0 * * 1,3,5` を使う。時刻は UTC で書き、コメントに JST を添える。

1. `netlify.toml` から `5 0 * * 1,3,5` を読める。
2. 予定時刻の計算（猶予 180 分）:
   - 日曜 01:00 UTC（日曜 10:00 JST）→ 金曜 00:05 UTC
   - 月曜 00:30 UTC（月曜 09:30 JST、猶予内）→ 金曜 00:05 UTC
   - 月曜 04:00 UTC → 月曜 00:05 UTC
   - 火曜・木曜・土曜の朝 → それぞれ月・水・金の 00:05 UTC
3. 2026-10-04〜10-09 の実際の点検時刻（10/4 00:16、10/5 00:20、10/6 01:59、10/7 01:09、10/8 01:27、10/9 01:35 UTC）と、実際の生成時刻（10/2・10/5・10/7・10/9 の 00:05 UTC 前後、すべて success）で、全日「成功（count ≥ 1）」になる。
4. 予定日の生成が失敗（`failure`）だけ → count 0。予定より前の成功だけ → count 0。予定の後に手動の成功 → count ≥ 1。
5. 読めない cron（例 `@daily`、`5 0 1 * *`）→ 毎日扱いと警告。
6. `check-draft-ran.js` を `CHECK_NOW` と偽の runs ファイルで動かし、`GITHUB_OUTPUT` に `count` と `expected_jst` が書かれる。

`test-crawl-queue-cadence.js` が `package.json` のどのテスト一覧に入っているかを確かめ、同じ一覧に新しいテストを登録する（どこにも入っていなければ登録しない）。

## 変更してはいけないもの

- `netlify.toml` のスケジュール、`scheduler-daily-draft.js`、`daily-draft.yml` の起動条件。
- 点検の記事検証（Validate all posts）と Chatwork 通知の中身。
