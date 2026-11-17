# 段 1c: 影響の範囲のレビュー（Opus 5.5 xhigh、2026-11-17）の直し

レビューの結論は「マージ可」（Critical・High 0、Medium 1、Low 7）。Medium と、安く直せて削除の判定を厳しくする Low を直す。01・01b の R1〜R9・F1〜F3・S1〜S10 は、下で書き替える所のほかは変えない。変えてよいファイルは 01 の「この段の厳守事項」と同じ。

## G1（Medium）大量のときも PR 本文が作れるようにする

- 今: 報告の表と URL の一覧を全部 PR 本文に入れるので、上限で止めたものが数百件を超えると GitHub の本文の上限（65,536 字）を超え、`gh pr create` が失敗して報告が失われる。上限が効くはずの場面（国税庁側の不具合で大量に「無い」と出るなど）でこそ起きる。
- 直し:
  - `renderReport(summary, { maxRows })` に行数の上限を足す。表（新しく削除・上限で止めた）はそれぞれ先頭 `maxRows` 行まで、戻ったページの箇条書きも `maxRows` 行まで、一覧にはあるがページが無い URL は `maxRows * 2` 行まで。超えた分は「ほか N 件（全件は meta.json の `deleted_entries`・`deletion_held_entries`・`restored_entries`・`gone_unrecorded_urls` と、Actions の実行の要約にあります）」の 1 行にする。**見出しの件数は常に全件の数**（丸めない）。`maxRows` を渡さないときは今のまま全部出す。
  - CLI: `--report-file <path>` は PR 用（`maxRows: 50`）、新しい `--report-full-file <path>` は全件（上限なし）を書く。どちらも任意で、両方を同時に使える。
  - ワークフロー: 「Run crawl」で `--report-full-file "$RUNNER_TEMP/nta-crawl-report-full.md"` も渡す（`--report-file` と同じく `RUNNER_TEMP` があるときだけ）。「Emit job summary」で、全件の報告ファイルがあれば要約の後ろにつなぐ。
- 試験: 上限で止めたもの 500 件・一覧にはあるがページが無いもの 1,000 件の報告で、PR 用の文字数が 60,000 字未満、見出しの件数が 500・1,000、「ほか 450 件」「ほか 900 件」の行がある。全件の報告には 500 行の表がある。CLI で 2 つのファイルが書かれる。

## G2（Low）上限で止めたときの案内

- 報告の「上限を超えたため」の節の 1 文を「本当に削除なら、この PR は閉じてから、Actions の『Crawl NTA Sources』を max_deletions に N 以上を入れて手動で実行し直してください（両方をマージしない）。」に替える。ワークフローの確認ポイントの同じ行も「この PR は閉じてから」を入れる。
- Chatwork の上限の警告の行に、この実行の URL（`github.server_url`・`github.repository`・`github.run_id` から作る。`env:` で渡す）を足す。
- 試験: 報告の文。ワークフローは `test-workflow-run-injection.js` が通ること。

## G3（Low）転送の後の 404 は削除にしない

- 今: 404/410 の判定は転送をたどった後の応答で行うので、似て非なる行き先（`https://www.nta.go.jp.example.com/error/404.htm` など）が 404 を返すと `not_found` で削除の候補になる。
- 直し: `fetchWithRetry`・`fetchPageHead` で、404/410 を `not_found` にするのは `res.redirected !== true`（ページ自体が 404/410 を返した）ときだけ。転送された後の 404/410（エラーページの完全一致でないもの）は `http_error` として失敗に数える。S1 の (b) を「転送されずに 404/410 が返ったとき」と読み替える。
- 試験: S3 の行き先の一覧それぞれを状態 404 でも試し（GET と HEAD の両方）、`not_found`・`nta_error_page` にならない。転送なしの 404・410 は今までどおり `not_found`。

## G4（Low）HEAD だけで削除の候補にしない

- 今: HEAD がエラーページか 404 を返すと、本文を取らずに削除の候補にする。HEAD と GET で国税庁の扱いが違うと、生きたページが候補になり、毎月「前から削除済み」のまま戻らない。
- 直し: `performIncrementalFetch` で判定が `mark_deleted` のときも本文を 1 回取る（`rl.wait()` を挟む）。
  - 本文の取得の理由も `isGoneReason` → `gone`（理由は本文の取得のもの）。
  - 本文が取れた → 判定が `fetch` だったときと同じ流れ（hash が同じなら `hash_match_after_get` の道、違えば `fetched`。既存が削除済みなら復活）。HEAD の失敗の結果は `headMeta` に入れない（`last_modified`・`etag` は本文の取得のものを使う）。
  - ほかの失敗 → `error`（削除にしない）。
- 試験（CLI）: HEAD がエラーページ＋本文が取れる → 削除の印は付かず普通に保存。既存が削除済みなら印が外れ `restored` に入る。HEAD がエラーページ＋本文もエラーページ → 新しい削除。HEAD が 404＋本文が `retry_exhausted` → 失敗、保存なし。

## G5（Low）図の取り込みのモードで古い数を出さない

- `backfill-figures` は meta.json を書かないので、「Read meta.json」が前回の取り込みの数を読み、Chatwork に古い「上限で止めた」警告が出る。
- 直し: 「Read meta.json」で、モードが `backfill-figures` のときは `deleted`・`deleted_still`・`deletion_held`・`restored`・`gone_unrecorded` を 0 にして出す（モードは `env:` で `steps.mode.outputs.mode` から渡す）。ほかの数は今のまま。

## G6（Low）「使っている所」を探すファイルを足す

- `findReferences` の探すファイルに `data/nta-shitsugi-topics-candidate.json` と `data/curated-source-promotions.json` を足す（どちらも国税庁の URL を持ち、題材の候補・出典の昇格に使う）。
- 試験: 資料の木にこの 2 つの名前のファイルを置き、URL を引いていれば出る。

## G7（Low）試験の穴を塞ぐ

- (a) T15 を、本物の `fetchPage`（`nta-crawler` の本物）と偽の `globalThis.fetch`（302 でエラーページへ、状態 200）で動かす。直す前のコード（エラーページを本文として読む）なら落ちることを、報告に書く（確かめ方を一言）。
- (b) CLI: `--full`（`--incremental` なし）で記録あり＋本文がエラーページ → 新しい削除。`--full` でも上限が効く（21 件・上限 20 → 保存 0）。`--incremental` で HEAD が通り本文がエラーページ → 新しい削除。
- (c) CLI: 本文は取れて、本文を読む部品が「bodyArea が見つかりません」で例外を出す（11/01 に起きた本物の形）→ 失敗に数え、保存なし、削除の印なし。
- (d) T3 を `fetchPageHead` でも行う（状態 200 と 404、G3 と合わせて）。
- (e) CLI: 削除済みの記録＋HEAD が通り ETag が前と同じ → 本文を取り直す（偽の `fetchPage` が呼ばれる）→ 印が外れる。

## 直さないもの（PR 本文に記録だけ）

- レビュー 8: 保存の途中で失敗すると前の分だけ保存される（CI では commit されないので害なし）。
- 範囲外（前からある穴）: 取り込みが失敗して meta の値が空だと Chatwork の `awk` が構文エラーになり通知が届かない／国税庁の別のページへ転送されると記録がその中身で上書きされる／早く返す応答の本文を読み捨てない／No.5441 の `html_hash` が 9/6 の図の取り込みでエラーページの hash になっている可能性（今は転送を先に見分けるので害なし）。

## 報告の形

1. G1〜G7 をどこでどう直したか（短く）。
2. 試験の結果（ファイルごとの通過数・失敗数）。01 の T17 の試験と `test-nta-deleted-pages.js` をすべて流すこと。
3. G7 (a) の「直す前なら落ちる」の確かめ方。
4. 【要判断】があれば。
