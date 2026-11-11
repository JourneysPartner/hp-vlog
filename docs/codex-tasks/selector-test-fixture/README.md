# 題材選びの試験 test-selector.js の Test 8 を、実データに頼らない形に直す（selector-test-fixture）

2026-11-11 利用者決定。

## 何が起きているか

`scripts/lib/__tests__/test-selector.js` の「Test 8: filter-target-query と topic_id」の前半 2 項目が、2026-11-11 の main で落ちる（21 通過・2 失敗）。`npm run masters:test` に入っているので、CI（Check Tax Simulator Masters）が赤になる。

- この 2 項目は、題材データ（`scripts/topic-pool.js` の `TOPICS`）から、検索需要つき（`demand_evidence.kind` が `search-suggest` か `gsc`）の最初の題材を選んで、検索語の重複を止める段（`filter-target-query`）を確かめている。
- 選ばれる題材 `suggest-ec-kakutei-673b3d`（「ネットショップ 確定申告 やり方」）の記事が、2026-11-11 に公開された（commit 718585a0）。そのため、この題材は手前の段（`filter-existing-slugs`）で「公開済み」として外れ、`filter-target-query` に届かない。
- **選び方の不具合ではない**。試験が実際の題材データと公開済みの記事に頼っているため、使っている題材が公開されるたびに起きる。

## 方針

- Test 8 の前半 2 項目は、**偽の題材（試験の中で作る、検索需要つきの題材 1 件）**で確かめる。偽の題材は、公開済みの記事・下書き・取り下げた題材のどれとも slug と言葉が重ならないようにする（例: slug `fixture-demand-topic-test8`、検索語 `試験用の検索語 偽の題材`）。
- 偽の題材が `filter-target-query` まで届くことを、試験の中で先に確かめる（届かなければ、その理由が分かる名前で落とす）。届かないまま 2 項目を通すことはしない。
- 偽の題材の項目（分類・顧客カテゴリ・題名など）は、`TOPICS` の実際の題材と同じ形にする。選び方の段が要る項目を、`TOPICS` の検索需要つきの題材から写してから、slug・題名・検索語・需要の根拠を偽のものに替える、という作り方でよい。ただし、写した元の題材が公開済みでも結果が変わらないこと（slug と言葉を替えているので外れないこと）を確かめる。
- Test 8 の後半（`filter-existing-slugs が topic_id でも一致`）と、ほかの Test は変えない。
- 選び方の本体（`scripts/lib/topic-selector.js` ほか）と題材データは変えない。

## 要件

- **S1** Test 8 の前半 2 項目（「一致する target_query を持つ候補は除外」「不一致なら検索語ゲートを通る」）を、偽の題材で確かめる形にする。期待（除外されたら `blocked === 1 && remaining === 0`、通ったら `blocked === 0 && remaining === 1`）は今のまま。
- **S2** その前に「偽の題材が filter-target-query まで届く」確かめを 1 つ足す（`explanation.steps` に `filter-target-query` の段があり、その手前の段で外れていない）。
- **S3** 今の `else` の道（検索需要つきの題材が無いときに 2 つ落とす）は、偽の題材を使うので要らなくなる。消してよい。
- **S4** 日付（`now: new Date()`）は今のままでよい。日付で結果が変わる場合は、Test 8 の中だけ決まった日付にしてよい（そうしたら報告に書く）。

## 試験（受け入れ）

- `test-selector.js` が今の main で全部通る（今の 21 通過＋足した確かめ、失敗 0）。
- 落ちることの確かめ（司令役が行う）: 選び方の本体の写しで `filter-target-query` の段を外すと、S1 の確かめが落ちる。
- `npm run masters:test` が全部通る（ほかの試験も含めて 77 本。画面の試験が `assets/js/tax-simulator-boot.js` などを書き換えるので、終わったら元に戻す）。

## 変えてよいファイル

- `scripts/lib/__tests__/test-selector.js` だけ。

## 元に戻す方法

- PR を戻す（試験のファイル 1 本と指示書だけの変更）。
