# 段 1b: 受け入れで見つかった直し（2026-11-17）

01 の実装（R1〜R9）はそのまま。次の 3 点だけ直す。変えてよいファイルは 01 の「この段の厳守事項」と同じ。

## F1 `--dry-run` で落ちる

- 今: `crawlTaxAnswer`・`crawlShitsugi` の `--dry-run` の戻り値が `{ fetched: 0, skipped: 0, errors: [] }` のままなので、`crawlAll` の `aggregated.pendingDeletions.push(...r.pendingDeletions)` が「iterable でない」で落ち、`deletedStill` も `NaN` になる。
- 直し: 2 つの関数の `--dry-run` の戻り値にも `deletedStill: 0`・`pendingDeletions: []`・`goneUnrecorded: []`・`restored: []` を入れる（通常の戻り値と同じ形にする）。
- 試験: CLI を `--dry-run` で `--type taxanswer`・`--type shitsugi`・`--type all` それぞれ動かし、終了せず（`process.exit` が呼ばれず）、保存 0 件、戻り値の `deleted`・`deleted_still`・`deletion_held` が 0 で数（`NaN` でない）。`--report-file` を付けたときは、全部の節が「0 件」「なし」の報告が書かれる。

## F2 上限の値が無いときに止まらない

- 今: `applyPendingDeletions` は `items.length > maxDeletions` で判定するので、`maxDeletions` が `undefined`・`NaN`・負の数・小数・文字列だと比べた結果が false になり、全件を保存する（止まる側に倒れていない）。CLI は既定 20 を入れるので今は起きないが、部品として安全側にする。
- 直し: `Number.isInteger(maxDeletions) && maxDeletions >= 0` でないときは、一件も `save` を呼ばず `{ applied: [], held: <全件> }` を返す。
- 試験: `undefined`・`NaN`・`-1`・`1.5`・`'20'`（文字列）それぞれで、候補 1 件 → `save` 0 回・`held` 1 件。`0` で候補 1 件 → `held` 1 件。`20` で候補 20 件 → 20 回保存（今の T8 と同じ）。

## F3 報告の「戻ったページ」の行の題名

- 今: 表ではない箇条書きの行は、題名の改行をそのまま出すので、国税庁の題名に改行が入ると Markdown が崩れる。
- 直し: 戻ったページの行の題名・URL も、表の欄と同じく改行を空白に置き換える（`|` はそのままでよい）。
- 試験: 題名に `\n` を含む戻ったページ → 報告のその行が 1 行に収まる。

## 報告の形

1. F1〜F3 をどこでどう直したか（短く）。
2. 試験の結果（ファイルごとの通過数・失敗数）。01 の T17 の試験と `test-nta-deleted-pages.js` をすべて流すこと。
3. 【要判断】があれば。
