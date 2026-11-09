# 01 再照合で誤りが残った自動修正を、もう 1 回だけ直し、だめなら元の文に戻す

背景・決定・安全の条件 S1〜S8 は `README.md`。行番号は main d00afaf9 の `scripts/lib/fact-check.js`。

## 用語

- **元の文** S: 1 回目の修正の対象になった、書き手の本文の文（`findings` の `sentence`、記録の `before`）。
- **1 回目の置き換え** X1(S): `repairPairs.get(S)`（記録の `after`）。
- **1 回目の再照合** `record.rechecked`（1637 行）。
- **誤りの行**: 再照合の行 r で、`r.status` が「食い違い」か「期限の書き漏れ」、かつ `blocksRepair(r)`（1647 行）が真のもの。
- **置き換えの中の行**: `normalizedClaim(r.sentence)` が空でなく、`normalizedClaim(置き換え).includes(normalizedClaim(r.sentence))` が真の行。

## R1 修正文の指示に「例外・選択肢を落とさない」を足す

`repairInstructions`（1213 行）の「食い違い」の指示の末尾に、次を足す（文面はこのとおり）。

> 。quote・quote_notes に例外（「〜の場合を除く」「ただし〜」など）や、別の判定のしかた・選択肢（「〜に代えて〜で判定することもできる」「いずれかを選べる」など）が書かれているときは、それを落とさずに書く

- 「期限の書き漏れ」「番号」「資料なし」の指示は変えない。
- 1 回目・2 回目の両方の修正に効く（同じ関数を通るため）。

## R2 2 回目の対象を決める

1 回目の修正を採れて（`repair.accepted`）、1 回目の再照合と `record.corrections` の解決の判定（1648〜1672 行）が終わった直後に、次の条件で**対象の元の文** S を集める。

- S の修正の記録 c が 1 件以上あり、どれかの `c.after` が空でない（置き換えを本文に入れた）。
- S の指摘（`findings` の中で `sentence === S` のもの）に `condition_mismatch` が 1 件も無い（S8）。
- `record.rechecked` の中に、X1(S) の**置き換えの中の行**で**誤りの行**が 1 件以上ある。その行の集まりを E1(S) とする。

対象が無ければ、何もせず今の処理を続ける（S2）。対象は元の文ごとにまとめる（同じ S に複数の指摘があっても 1 つ）。

- 制度名だけが一致して置き換えの中に無い誤りの行は対象にしない（今と同じく止めるだけ）。
- `options.repair === false` のときは 1 回目も無いので、2 回目も無い。

## R3 2 回目の修正の頼み方

- 入力の本文は 1 回目の後の本文 `revisedBody`。
- 指摘は E1(S) の各行 r（`id` の重複は除く）。`repairBody` が読む項目（`id`・`sentence`・`heading`・`status`・`type`・`subject`・`correct`・`quote`・`quote_notes`・`evidence_id`・`evidence`）は r のものを使い、`keep: []` とする。r の `sentence` は `revisedBody` の文そのものなので、今の `repairBody` の照合（1278 行）はそのまま通る。
- 各 r に **`earlier_fix`** を付ける: S の指摘（`findings`）ごとに `{ before: S, correct: f.correct, quote: f.quote }` の配列。
  - `repairBody` は `earlier_fix` があるときだけ、それを AI への `corrections` の各行にそのまま入れ、指示（`instruction`）の末尾に次を足す。
    > 。earlier_fix は 1 回目の修正で直した点です。その正しい内容は保ったまま、correct の指摘に合わせて直す
  - `earlier_fix` が無いとき（1 回目）の頼み方は 1 字も変えない（S2）。
- 歯止め（数字・列・長さ・本文の保全・`validateRepair`）は今の `repairBody` のまま全部効かせる。
- 呼び出しの記録: 2 回目の修正と 2 回目の再照合の `record.calls` の `task` は、頭に `again_` を付ける（`again_repair`・`again_extract`・`again_judge`。聞き直しなどがあればそれも同じ形）。AI に渡す `request.task` は今のまま（`repair`・`extract`・`judge`）。gateway の `task` の名前（1403 行）も同じ規則で頭を付ける。1 回目の名前（`repair`・`recheck_extract` など）は変えない。
- Batch の使い方は 1 回目と同じ（`immediate` を足さない）。

## R4 2 回目の再照合

2 回目の修正を採れた（`accepted`）とき:

- 各対象 S について、E1(S) の各行の文を 2 回目の置き換えに替えた X1(S) を **X2(S)** とする（X1(S) の中の該当する文を 2 回目の置き換えに置き換える）。2 回目の置き換えを採れなかった行（`rejected`）があれば、その S は R5 の「戻す」。
- 2 回目の修正の後の本文から、変わった文（`changedText(revisedBody, 2 回目の本文)` と、1632〜1635 行と同じ補い）を取り、`analyze` で再照合する。
  - `analyze` の `findings` には、対象 S の 1 回目の指摘と E1(S) の行の両方を渡す（両方の根拠を候補に必ず入れるため）。`pairs` は「S → X2(S)」と「r.sentence → 2 回目の置き換え」の両方を持つ Map。
  - 1640〜1646 行（条件確認の誤警報の扱い、書き手の資料があるときの `unchanged_numeric`）を 2 回目の結果にも同じように当てる。
- この結果を E2 とする。

## R5 2 回目の後の判定

対象 S ごとに、次のどちらかにする。

**残す**（次をすべて満たす）

- 2 回目の修正を採れ、S の E1 の行すべてに 2 回目の置き換えがある。
- E2 の中に、X2(S) の**置き換えの中の行**で**誤りの行**が無い。

このとき:

- `repairPairs.set(S, X2(S))`。
- S の修正の記録 c の `after` を X2(S) にし、`retry: { status: 'kept', first_after: X1(S) }` を付ける。
- c の `resolved` は、1652 行・1655〜1660 行・1662〜1670 行・1671〜1672 行と同じ式を、置き換えを X2(S)、再照合の結果を E2（S の分）に替えて計算し直す。

**戻す**（上を満たさないとき。2 回目の修正を採れない、2 回目の途中で例外が出た、E2 でも誤りが残った）

- `repairPairs.delete(S)`。
- S の修正の記録 c をすべて: `after: ''`、`resolved: false`、`reverted: true`、`proposal: X2(S)`（2 回目の置き換えが無ければ X1(S)）、`reason`（下）、`retry: { status: 'reverted', first_after: X1(S), ...(X2 があれば second_after: X2(S)), cause }` にする。
  - `reason` は「再照合で誤りが残ったため、元の文に戻しました」。
  - `cause` は「2 回目の修正を採れませんでした（<repairBody の理由>）」「2 回目の再照合でも誤りが残りました」「2 回目の修正・再照合を実施できませんでした」のどれか。

## R6 本文と記録を作り直す

対象を全部判定したら:

1. **本文**: 元の本文 `body` に、`repairPairs` に残った置き換えだけを当て直す（1690〜1692 行と同じ作り方: `splitUnits(body)` の見出しでない文で `repairPairs` にあるものを、後ろから置き換える）。これを `revisedBody` にする。
   - 戻した S が、作り直した本文に見出しでない文としてそのまま（`u.text === S`）あることを確かめる。`options.validateRepair` があれば、作り直した本文がそれを通ることも確かめる（日次の生成が渡す、引用・禁止語・字数の歯止め）。どちらかを満たさなければ（起きない想定）、**全部の修正を採らない**: `revisedBody = body`、`repairPairs` を空、すべての修正の記録を「戻す」と同じ形（`cause` は「元の文に戻せなかったため、すべての修正を採りませんでした」）にし、`record.rechecked` を空にする。人が確かめる箇所（3）は、全部の修正を戻したものとして扱う。
2. **`record.rechecked`**: 対象 S の X1(S) の置き換えの中の行を除き、「残す」にした S の E2 の行（X2(S) の置き換えの中の行）を足す。「戻す」にした S の E2 の行は足さない。
3. **人が確かめる箇所**:
   - 2 で除いた行（1 回目・2 回目の再照合の行で、本文に残らないもの）と `claimKey` が同じ `review_items` を除く。ただし、`record.claims` の行と `claimKey` が同じものと、R7 の項目は除かない。
   - 「戻す」にした S ごとに、R7 の項目を 1 件足す。
4. **`record.repair_retry`**: `{ targets: 対象の数, kept: 残した数, reverted: 戻した数 }` を足す（対象が無いときは足さない）。
5. 2 回目の途中で例外が出たとき（R5 の 3 つ目）は、`record.repair_warning` に「再照合で誤りが残った修正を元の文に戻しました（2 回目を実施できませんでした）」を入れる（1 回目で既に入っていれば、` / ` でつなぐ）。

この後、今の 1675 行（条件確認の戻し）以降をそのまま続ける。`repairPairs` は戻した S を含まないので、1690〜1692 行の作り直しでも戻した置き換えは本文に戻らない。

- 戻した S の元の指摘は、1699 行の `unresolved` に入り、`remaining` に残るので、状態は `revise` になる（S5。この段で状態の式は変えない）。
- 要約（1707 行〜）: 戻した数が 1 以上のとき、「上限で未照合 N」の後に `・元の文に戻した N` を足す。

## R7 人が確かめる箇所の項目と承認画面

- 状態の文字列 `REVERTED_FIX_REVIEW = '自動修正を元の文に戻した（修正案を確かめる）'`。`fact-check.js` と `review-page.js` の両方に同じ文字列で置く（今の `AI_SUPPORTED_NUMBERS_REVIEW` と同じ形）。
- 項目の中身: S の最初の指摘 f の `id`・`sentence`（= S）・`heading`・`type`・`subject`・`claim`・`s`、`status: REVERTED_FIX_REVIEW`、`proposal`（R5 と同じ）、`recheck`: 最後の再照合の誤りの行（E2 があれば E2、無ければ E1）の `[{ status, claim, correct, quote, evidence_id }]`、`evidence`: f と誤りの行の根拠（`{ id, title, url }`。今の `addReviewItem` と同じく原文は重ねない）。
- `review-page.js`:
  - 「直した箇所」（229 行の `pairs`）: `c.reverted` のときは「後:」に「元の文に戻しました（採らなかった修正案は人が確かめる箇所に載せています）」と出す（「再照合後も未解決です」は今のまま出る）。
  - 「人が確かめる箇所」（`renderFactReviewItems`）: `REVERTED_FIX_REVIEW` の項目に、「採らなかった修正案:」`factSentence(proposal)` と、`recheck` の各行の「再照合の指摘（<status>）:」`escapeHtml(correct)` と根拠（`renderFactEvidence` に `{ ...c, evidence_id, quote }` を渡す）を出す。
  - `factReviewGroups` の並びで `REVERTED_FIX_REVIEW` を先頭に置く。
  - 文字列はすべて今の関数（`factSentence`・`escapeHtml`）を通す。
- 承認・上書き（`review-approve-background.js` ほか）は変えない。

## R8 版

- `LOGIC_VERSION` を `plan2-s8` に上げる。試験の中の `plan2-s7` の文字列も直す（今 13 本・21 か所）。

## 試験（新しいファイル `scripts/lib/__tests__/test-fact-repair-retry.js`）

偽の AI（`callLLM`）と `searchEvidence` で作る（`test-fact-check.js` の `fake` と同じ形）。実例は `docs/codex-tasks/fact-repair-retry/fixtures/failed-fixes.json` を読む。

- **T1（R1）** 食い違いの修正の指示に「例外」「選択肢」を含む R1 の文がある。期限の書き漏れ・番号・資料なしの指示は main と同じ文字列。
- **T2（S2）** 1 回目の再照合が全部裏付けあり → 修正の呼び出し 1 回、`again_` の呼び出し無し、`retry`・`reverted`・`repair_retry` 無し、本文・`corrections`・状態が今と同じ。
- **T3（2 回目で直る、#755 の形）** `pr755_c33`: 元の文 → 1 回目の置き換え（`first_replacement`）→ 再照合で `recheck`（食い違い）→ 2 回目の置き換え（給与等支払額で判定できることを含む表の行。列の数は同じ）→ 2 回目の再照合で裏付けあり。確かめる: 本文に 2 回目の置き換えがあり、1 回目の置き換えと元の文が無い。`after` = 2 回目、`resolved: true`、`retry.status: 'kept'`、状態 `ok`。2 回目の修正の頼み方に `earlier_fix`（1 回目の指摘の `correct`）と R3 の指示の文がある。`record.calls` に `again_repair`・`again_extract`・`again_judge` がある。`record.rechecked` に 1 回目の置き換えの行が無い。
- **T4（2 回目もだめで戻る）** T3 と同じで、2 回目の再照合も食い違い。確かめる: 本文の表の行が元の文と 1 字も同じ。1 回目・2 回目の置き換えが無い。`after: ''`・`reverted: true`・`proposal` = 2 回目の置き換え・`resolved: false`・`retry.cause` = 「2 回目の再照合でも誤りが残りました」。状態 `revise`、`remaining` に元の指摘。`review_items` に `REVERTED_FIX_REVIEW` が 1 件（`proposal`・`recheck` 入り）。`applyFactResult` の後の前付けが `fact_check_blocking: true`・`recommendation: revise`。修正の呼び出しはちょうど 2 回（3 回目が無い）。
- **T5（2 回目の修正を採れない）** 2 回目の置き換えが歯止めで却下（例: 根拠に無い数字を足す）→ 戻す。`cause` に却下の理由。2 回目の再照合の呼び出しが無い。
- **T6（2 回目で例外）** 偽の AI が 2 回目の修正（または `again_judge`）で例外を投げる → 戻す。状態は `revise`（`not_run` ではない）。`repair_warning` に R6 の 5 の文。
- **T7（片方だけ）** 指摘 A・B の 2 文。A は 1 回目の再照合で裏付けあり、B は誤り → B だけ 2 回目。B を戻しても A の置き換えは本文に残り `resolved: true`。
- **T8（S8）** 条件確認だけの指摘（再照合で確かめられない）と、普通の食い違いの指摘（2 回目もだめ）が同じ記事にある → 最後の本文に両方の元の文がある（条件確認の戻し 1690〜1692 行が、戻した置き換えを当て直さない）。条件確認の指摘は今と同じく「条件の違いを要確認」の項目になる。
- **T9（期限の書き漏れ）** 期限を 1 文足した置き換え（元の文＋足した文）で、足した文が再照合で食い違い → 2 回目もだめ → 本文は元の文だけ（足した文が無い）。
- **T10（#744 の形）** `pr744_c37`: 2 回目の置き換えで言い回しを直し、2 回目の再照合で裏付けあり → 残す。同じ形で 2 回目も食い違い → 元の文「白色申告ではこの繰越ができません。」に戻る。
- **T11（承認画面）** `reverted` の修正の記録と `REVERTED_FIX_REVIEW` の項目を持つ記録で `renderFactCheck`（または今の試験が使う描画の関数）を呼ぶ → 「元の文に戻しました」「採らなかった修正案:」「再照合の指摘（食い違い）:」が出る。`proposal`・`correct` に `<script>` を入れても、そのまま出ない（エスケープされる）。`REVERTED_FIX_REVIEW` の文字列が `fact-check.js` と `review-page.js` で同じ。
- **T12（使い回し）** T4 の記録を前回の記録として、差し戻し後の照合（`checkArticle` の `previousRaw`、1806〜1835 行）が使い回せる（例外にならない）。使い回す行に、戻した置き換えの文の行が無い。
- **T13（S1）** どの試験でも、修正の呼び出しは 2 回以下、再照合（抜き出し）は 2 回以下。`repair: false` では修正 0 回。

## 既存の試験

- `test-fact-check.js` の「再照合で食い違いが残っても2回目の修正をしない」は、この決定で**意図して変わる**。名前を「再照合で食い違いが残ったら1回だけ直し、だめなら元の文に戻す」にし、期待を「修正 2 回・状態 revise・本文は元の文」に直す。
- 他の既存の試験で期待を変えてよいのは、**1 回目の再照合で置き換えの中に誤りの行が出る（2 回目が動く）ものだけ**。変えた試験は全部、名前と変えた理由を報告に書く。2 回目が動かない試験の期待は変えない。試験を消さない・弱めない。

## 変えてはいけないもの

- 検索（`scripts/lib/fact-evidence.js`）・抜き出し・判定の指示・数字の歯止め・聞き直し・段A/段B の仕組み。
- 1 回目の修正の頼み方（R1 の追記を除く）と、1 回目の判定・解決の式。
- 条件確認だけの修正の扱い（1675〜1698 行）。
- 承認・上書き・公開（`netlify/functions/review-approve-background.js` ほか）、`scripts/validate.js`、ワークフロー、カタログ（`data/`）、記事（`content/`）。
- パッケージ（`package.json`・`package-lock.json`）。

## レビュー 1 回目の対応（01d、2026-11-09）

Opus 5.5 xhigh の差分レビュー（`review-01.md`）は「直してからマージ」（High 2・Medium 2・Low 3）。次のとおり直す。

- **H1** 2 回目の再照合には、書き換わった文だけでなく、残す候補の置き換え X2(S) を丸ごと渡す（1 回目の 1632〜1635 行と同じ補い方で、X2(S) の全文を足す）。2 回目の判定（残す／戻す、解決の計算）は、X2(S) の中の全部の行を E2 から見る。これで、1 回目の置き換えの中で 2 回目に手を付けなかった文の「止める行」も E2 に入り直し、X1 の中に同じ文が 2 回あっても見落とさない。試験: 1 回目の置き換えが 2 文で、1 文目が食い違い・2 文目が資料なし（数字）→ 1 文目だけ 2 回目で直る → 状態は `revise` のまま、2 文目の資料なしが `remaining` に残る。
- **H2** 「全部の修正を採らない」予備の道では、残すにした対象の一覧も空にする（すべて戻したものとして記録し、`repair_retry` の数も合わせる）。試験: 対象 2 つ（A は 2 回目で裏付けあり、B は 2 回目も食い違い）で、作り直した本文だけが `validateRepair` を通らない → A・B とも `reverted: true`・`after: ''`・`resolved: false`・`retry.status: 'reverted'`、`retry.status: 'kept'` の記録が無い、`repair_retry` が `{ targets: 2, kept: 0, reverted: 2 }`、A・B の元の指摘が `remaining` にある。
- **M1** R2 の対象に「S の指摘のどれかが止める指摘（`blockingFinding`）である」を足す。止めない指摘だけの文（書き手の資料があるときの、要件・判定・手続の資料なしを案内に変える修正）は対象にせず、今と同じく置き換えが残り、再照合の誤りの行で止まる。試験: そういう文で再照合が置き換えの中に食い違い → 2 回目は動かず、状態 `revise`。
- **M2** 承認画面の「人が確かめる箇所」の `REVERTED_FIX_REVIEW` の項目で、再照合の各行の引用（`quote`）を `escapeHtml` を通して引用枠（`<blockquote>`）で出す。試験 T11 を、保存の形（`compactRecord` を通した記録）で描画して、引用の文が出ることまで確かめる形にする。
- **L3** 試験を直す: `test-fact-repair-retry.js` の 180 行付近の常に真になる確かめを正しくする。T6 に「`again_judge` の途中で失敗」の形を足す。T13 の回数の数えに `again_retry_repair` などの聞き直しも入れる。T2 で `corrections`・`rechecked`・`review_items`・本文・状態を全部比べる。
- **L1・L2** は直さず README の「残る穴」に記録する。

## レビュー 2 回目の対応（01e、2026-11-09）

差分レビュー（`review-01b.md`）は「直してからマージ」。H2・M1・M2・L3 は FIXED、H1 は部分的で、新しい N1（High）・N2・N3（Low）。次のとおり直す。

- **N1** 1 回目の再照合の行を `record.rechecked` から除くのは、次のどちらかのときだけにする（止める側に倒す）: (a) 最後の本文にその文がもう無い（`!actualSentence(revisedBody, r.sentence)`）、(b) 2 回目の再照合の残す行（`keptE2`）に同じ文（`normalizedClaim` が同じ）の行がある。人が確かめる箇所から除く行（R6 の 3）も同じ条件にそろえる。
- **N1** 2 回目の置き換えの組み立て（`secondReplacement`）は、2 回目の修正（`repairBody`）と同じく、X1 の中の同じ文を**全部**置き換える（関数で置き換える形のまま、全部の出現に当てる）。置き換えた X2 が 2 回目の修正の後の本文に無いときは、丸ごとの再照合を飛ばすのではなく、その対象を「戻す」にする（`cause` は「2 回目の修正を採れませんでした（置き換えの位置が見つかりません）」）。
- **N1 の試験** レビューの形 1（1 回目の置き換えの中に同じ誤りの文が 2 回）と形 2（書き手の資料がある記事で、止める指摘 T と止めない指摘 C の一般化の置き換えに同じ案内文が付き、その案内文が再照合で食い違い）で、どちらも誤りの文が本文に残るなら状態が `revise` になる（またはその文が本文に無い）ことを確かめる。
- **N2** 承認画面で、引用が空のときは引用枠を出さない。
- **N3** 試験の回数の数えを「修正の回数（`repair`＋`again_repair`）が 2 以下」と「各回の聞き直しが 1 以下」に分ける。
- README の費用の項に「予備の道の『元の文に戻した N』は、対象の外の修正も数える」を一言足す。

## レビュー 3 回目の対応（01f、2026-11-09）

差分レビュー（`review-01c.md`）は「直してからマージ」。前回の H1 の残り・N1・N2・N3 は FIXED。新しい N4（High）・N5（Medium）・N6（Low）を次のとおり直す。

- **N4** 人が確かめる箇所から外す行（`removedRows`）の条件から「2 回目の残す行が同じ文を見直した」（`coveredByKeptE2`）を外し、「最後の本文にその文が無い」ときだけにする（`addReviewItem` は同じ鍵を 2 回足さないので、外すと 2 回目の「条件の違いを要確認」なども戻らないため）。試験: 書き手の資料がある記事で、1 回目の置き換え「制度Cでは申請が必要です。制度Cの書類は郵送で出せます。」の 1 文目が食い違い・2 文目が条件確認の不一致（人に回る）→ 2 回目で 1 文目だけ直って残す → 「条件の違いを要確認」の項目が残る。直しを外すと落ちることを確かめる。
- **N5** 1 回目の再照合の行を `record.rechecked` から除く条件を、文の単位で見る形にする: 最後の本文の文（`sentenceRows(revisedBody)`）のうち、その行の文を含む（`normalizedClaim` で含む）ものを集め、**1 つも無い**か、**全部が 2 回目の残す行（`keptE2`）で見直した文**なら除く。どれか 1 つでも見直していない文があれば残す（形 2 は止まったまま）。試験: 誤りの文「制度Bの届出書を提出します。」が 2 回目で「開業した年は制度Bの届出書を提出します。」に直り裏付けあり → 状態 `ok`、`remaining` が空。N1 の形 1・形 2 の試験は今のまま通る。
- **N6** 2 回目の置き換えの組み立て（`secondReplacement`）を、1 回目の置き換えを文に分けて同じ文だけ替える形にする（本文への当て直し `applyRepairPairs` と同じ当て方。`applyRepairPairs(first, replaced)` でよい）。置き換える文が文の単位で見つからなければ今と同じく「戻す」。試験: 1 回目の置き換え「制度Dでは確定申告が必要です。申告が必要です。」の後ろの文だけが食い違い → 2 回目で後ろの文だけが替わり、前の文は崩れない。2 回目の置き換えが 2 回目の本文に無いときに戻す安全弁（1758 行付近）が働く試験も 1 本足し、その安全弁を外すと落ちることを確かめる（作れない場合は、作れない理由を報告に書く）。
