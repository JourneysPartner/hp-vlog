データ更新のワークフローが、中身が変わっていないのに毎回 PR を立てています。変更判定を直してください。

## 読む順

1. `docs/codex-tasks/noop-data-pr/README.md` — 背景と対象
2. `docs/codex-tasks/noop-data-pr/01-detect.md` — 作るもの（A〜D）
3. `docs/codex-tasks/noop-data-pr/02-tests.md` — テストと回帰確認

## 要点

`crawl-nta-sources.yml` などの変更判定が

```bash
if git diff --quiet data/nta-sources/ 2>/dev/null; then
```

となっており、`meta.json` の `last_crawl_started_at` は実行のたびに必ず変わるため、
**常に「変更あり」**になります。2026-09-14 に溜まっていた自動生成 PR 8本のうち
7本が実質差分0行でした。

**共有スクリプト `scripts/has-substantive-change.js` を1本作り、7つのワークフローから呼ぶ**形にしてください。
YAML を7箇所それぞれ書き換えるのはやめてください。同じ抜けを7回作ることになります。

判定は「時刻のキーを再帰的に落としてから比較する」。キー名が `_at` で終わるものと
`last_crawl_duration_seconds` を落とします。**値は見ないでください**（日時の形を判定し始めると
形の違う時刻を取りこぼします）。

配列の順序は意味があるので**並べ替えないこと**。`deleted: true` が付いた変化は必ず拾うこと。

## いちばん壊れやすいところ

既存の `has_changes` という出力名を参照している箇所が、PR 作成の `if:` だけでなく
**通知とサマリにもあります**（`crawl-nta-sources.yml` は3箇所）。
取りこぼすと通知が壊れます。grep でゼロ件になるまで追随させてください。

## やってはいけないこと

- 時刻の更新そのものを止めない。記録としては必要です。止めるのは PR を立てることだけ
- 記事系のワークフロー（`daily-draft` `publish-scheduled` `regenerate-draft`）に触らない
- `data/` の中身を書き換えたままにしない（手で確認したら `git checkout -- data/` で戻すこと）

## 完了条件

- 02-tests.md のテストを足し、回帰確認の一覧がすべて通る
- `git status` が意図したファイルだけを示す（`data/` に差分が残っていないこと）

## 報告

- 作ったスクリプトの判定表（どの状況で changed=true になるか）
- 7つのワークフローそれぞれで、`has_changes` を参照していた箇所を何箇所直したか
- 手で確かめた結果（時刻だけ書き換えたとき／中身を書き換えたとき）

**コミット・push はしないでください。** レビュー後にこちらで行います。
