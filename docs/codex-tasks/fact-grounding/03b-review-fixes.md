# 03b 01〜03 のレビュー指摘の修正（2026-10-10、Opus 5.5 xhigh のレビュー）

対象はコミット 9826f0ce（01・02）・2e9c63a5（03）。総合判定「修正してからマージ」（Critical 1・High 2・Medium 4・Low 9）。F1〜F7 は必ず直す。F8〜F16 も直す。最後の「記録だけするもの」は直さない。

この関門は「承認してよいか」を決めるので、どの修正も**落とす側に倒す**（迷ったら承認できない側）。

## F1（Critical）公開中の記事の更新案は、照合で止めても承認され main に書かれる

- `netlify/functions/review-approve-background.js` の更新案の経路（`prepareMain` → `refreshQualityFailure(raw, …)`、229 行付近）は **main の公開記事**の frontmatter しか見ていない。`runRefreshMode` の照合が枝に `fact_check_status: revise` / `recommendation: revise` を書いても、承認すると `putFile(…, 'main')` が通る。`not_run` でも同じ。既存テスト `test-review-approve-refresh.js` は枝が `recommendation: reject` でも 200 になることを確かめている（この既存の動きは変えない）。
- 直し方:
  - `applyFactResult`（`scripts/lib/fact-check.js`）が、止めるかどうかを独立した項目 `fact_check_blocking: true|false` として frontmatter に書く（`revise` は常に true、`not_run` は `FACT_CHECK_FAIL_OPEN=true` のときだけ false、`ok` は false）。
  - 承認処理は、**新規の下書きの経路と更新案の経路の両方で**、`recommendation` とは別に次を見て 400 を返す（`putFile` は 0 回）: 枝の frontmatter の `fact_check_blocking` が true、または `fact_check_status` が `revise`。更新案の経路は `branchMeta` で判定する。理由の文面は日本語で「事実の照合で承認できない状態です（…）。差し戻して直してください」。
  - 照合の項目が 1 つも無い枝（照合導入前の下書き・更新案）は従来どおり承認できる。ただし承認のログに「照合の記録なし」を出す（F12）。
- テスト: 更新案で `fact_check_blocking: true`（status revise と not_run の 2 通り）→ 400・`putFile` 0 回。照合の項目が無い更新案 → 従来どおり 200。新規の下書きで `recommendation: publish` だが `fact_check_blocking: true` → 400。既存の `test-review-approve-refresh.js` の他の項目は変えずに通る。

## F2（High）部分再生成を止めた設定で「題名だけ」の差し戻しをすると、全文を作り直しても照合されず前回の ok を引き継ぐ

- `scripts/generate-draft.js` の `finalizeRegeneration` は、実際に行った再生成の範囲ではなく `classification.scope === 'frontmatter'` を見て照合を飛ばす。`ENABLE_PARTIAL_REVISE=false` だと範囲は `full` になり本文は全部書き直されるのに、`inheritFactMetadata` が前回の `ok`・`publish` と古い JSON を引き継ぐ。
- 直し方: 照合を飛ばして前回の結果を引き継ぐ条件を「**本文が変わっていない**（frontmatter を除いた本文を改行・末尾空白だけ揃えて比べて一致）」にする。本文が 1 文字でも変われば照合をやり直す。
- テスト: `ENABLE_PARTIAL_REVISE=false` で題名だけの差し戻し → 本文が変わるので照合が呼ばれる。本当に題名だけ変わった場合は照合を呼ばずに引き継ぐ。

## F3（High）主出典が汎用ページのとき、既存の「弱い出典の探し直し」と LLM での出典選定を飛ばしている

- `generate-draft.js` 2776・2790 行付近（`generic.has(t)` で `continue`）と再生成の `!isGenericSource`（3196 行付近）。税目ごとの既定出典（`tax-authority-refs.js` の 6501・1350・2210・4152）はすべて `data/generic-source-pages.json` に入っているので、既定出典に倒れた題材は探し直しを一切受けず、主出典が汎用のまま（#642 の原因そのもの）になる。01 の「変更してはいけないもの: 主出典の決め方」に反する。
- 直し方: 既存の探し直し（`enrichTaxTerms` → `ensureSourceOnTopic`）と LLM 選定（`enrichSourceWithLLM`）は従来どおり**先に**実行する。その後、最終的な主出典がまだ汎用ページのときだけ `supplementGenericSource` で補助出典を足す。再生成の経路も同じ順にする。
- テスト: 「01 R3」のテストを、探し直し・LLM 選定が汎用ページの題材でも呼ばれること、探し直しで主出典が具体的なページに変わったら補強しないこと、変わらなければ補強すること、に直す。`test-llm-auto-trust.js`・`test-source-selection-improvement.js`・`test-llm-source-selector.js` は変えずに通る。

## F4（Medium）照合を通した下書きは、題名だけの差し戻しで仮置き題名の revise を外せなくなる

- 仮置き題名の下書きは revise で、照合が ok でも `fact_check_prev_recommendation` に revise が控えられる。題名だけを差し戻すと `clearPlaceholderTitleWarning` が publish に戻すが、その後 `inheritFactMetadata` が revise と警告を書き戻す（`fact-check.js` 302〜318 行付近、`generate-draft.js` 3185〜3191 行付近）。2026-08-25 の修正（仮置き題名が確定したら revise を外す）を壊している。照合の記録が無い古い下書きでも 315 行の else 側で同じことが起きる。
- 直し方: `clearPlaceholderTitleWarning` を `inheritFactMetadata` の**後**に実行する。仮置きの理由を外したときは `fact_check_prev_recommendation` も同じように直す。照合が止めている場合（`fact_check_blocking: true`）は publish に戻さない。
- テスト: 仮置き題名 → 題名だけの差し戻しで題名が確定 → 照合 ok なら publish。照合が revise なら revise のまま。照合の記録が無い古い下書きでも publish に戻る。

## F5（Medium）主張の抜き出しが 0 件・一部が捨てられても ok になる

- `fact-check.js` 48〜55・215・227・239 行付近。
- 直し方:
  - (a) 本文に中身がある（見出しを除いた本文が 200 文字以上）のに主張が 0 件なら `not_run`（理由「主張を抜き出せませんでした」）。
  - (b) `sentence` と本文の照合の前に、両方の Markdown の強調（`**`・`__`・`*`・`` ` ``）、リンク（`[文字](URL)` → 文字）、空白、全角半角を揃える。一致したら本文の実際の文に置き換えて使う。それでも本文に無い文は捨てて件数を `discarded` に記録し、要約に出す。**捨てた主張が 1 件でもあれば `revise`**（照合できなかった主張があるため。上限での `dropped` と同じ扱い）。
  - (c) 食い違いの修正は、再照合で同じ制度（`subject`）について「裏付けあり」が得られたときだけ解決とする（期限の書き漏れと同じ条件）。直した文から主張が 0 件しか取れなかった場合は未解決として残す。
- テスト: (a)(b)(c) それぞれ。強調記号つきの文が捨てられずに照合されること。

## F6（Medium）引用の照合が、ごく短い引用で満たせてしまう

- `fact-check.js` 86〜87 行付近。`quote: '令和'` や `'。'` でも原文に含まれれば通る。
- 直し方: 引用は、揃えた後で 15 文字以上（または根拠の 1 文全体）であること。さらに種類が `期限`・`金額`・`割合`・`適用年` の主張では、`裏付けあり` なら主張の数字・日付が、`食い違い`・`期限の書き漏れ` なら `correct` の数字・日付が、引用に含まれること（漢数字・全角数字は算用数字に揃えてから比べる。「令和九年三月三十一日」と「令和9年3月31日」は同じ）。満たさなければ `資料なし`。
- テスト: 短い引用・数字が引用に無い裏付けあり・漢数字の日付で一致する場合。

## F7（Medium）出典差し替えの道具が照合の差し止めを消す

- `scripts/promote-source.js` 157〜171 行付近は `recommendation` と `review_warning` を出典の適合判定の結果で上書きする。`fact_check_status: revise` が残っていても承認できるようになる。
- 直し方: F1 の `fact_check_blocking` を承認時に見ることで塞がる。加えて、`promote-source.js` は `fact_check_*` の項目を消さない・変えない。`fact_check_blocking: true` のときは `recommendation` を publish にしない。
- テスト: 照合で止まっている下書きに出典差し替えをかけても、`fact_check_*` が残り承認できない。

## F8（Low）指示書にない文言の変更を戻す

- `generate-draft.js` 1054 行付近: 改行なしで連結され「…留めてください- 出典が未確定です」になる。改行を入れる。
- 出典が未確定のときの既存の一文（「制度の一般的な説明にとどめ…」）が消えている。`02-writing-rules.md` が置き換えを指定している文以外は元に戻す（02 を読み、指定された置き換えだけにする）。
- `nta-source-body.js` 151〜159 行付近: 本文が取れない主出典（法務局のページ等）でも「これが唯一の根拠」のブロックが出るようになった。本文が無いときは従来どおりブロックを出さない。
- `generate-draft.js` 1136 行付近: 同じ通達が二重に入ることがある。重複を除く。
- テスト: それぞれの文字列で確かめる。

## F9（Low）照合に失敗した経路で古い照合記録が残る

- `generate-draft.js` 2591〜2595 行付近は失敗時に JSON を書かないので、差し戻しの枝では前回の JSON が残り、画面に古い詳細が出る。
- 直し方: 失敗（`not_run`）でも `data/fact-check/<slug>.json` に `status: not_run` と理由を書く。記録に本文のハッシュ（`body_sha256`）を入れ、レビュー画面は下書きの本文のハッシュと違えば「この記録は今の本文と一致しません（古い記録）」と出して、状態を ok と表示しない。

## F10（Low）照合記録が大きくなる

- 根拠の抜粋（最大 2,000 文字 × 3 件）が主張・修正・再照合のたびに重複して保存される。1MB を超えると GitHub の取得 API が中身を返さず、画面が「記録なし」になる。
- 直し方: 根拠は `evidence` 表に id ごとに 1 回だけ保存し、主張・修正・再照合からは id で参照する。画面もそれに合わせる。主張 40 件・根拠 3 件ずつ・すべて別の根拠の偽データで、JSON が 600KB 未満になることをテストする。

## F11（Low）frontmatter が照合の設定に混ざる

- `fact-check.js` 292 行付近の `{...meta, ...options}`。frontmatter の `enabled`・`provider`・`model` 等が照合の設定を変えられる。
- 直し方: frontmatter からは `tax_terms`・`source_bundle`・`tax_domain` だけを渡す。

## F12（Low）照合の記録なし・取得失敗の区別

- レビュー画面の「照合の記録なし」は取得に失敗したときも同じ表示（`review-page.js` 269〜276 行付近）。取得失敗は「照合の記録を読めませんでした」と分ける。
- 照合の項目が無い下書き・更新案を承認したとき、承認のログ（と既存の通知に載せられるなら通知）に「照合の記録なし」を残す。

## F13（Low）手動照合ワークフローの入力と設定ミス

- `fact-check.yml` の入力の説明は「content/posts/ からのパス」だが、スクリプトはリポジトリ直下から解決する。説明をスクリプトに合わせる（またはどちらでも解決できるようにする）。
- `FACT_CHECK_PROVIDER=openai` で `FACT_CHECK_MODEL` が未設定だと claude のモデル名が OpenAI に送られる。プロバイダとモデルの組み合わせが合わないときは呼び出さずに `not_run`（理由「照合のモデル設定が不正です」）にする。

## F14（Low）同じ制度の 2 件目の「期限の書き漏れ」

- `fact-check.js` 89〜92 行付近は 2 件目を「資料なし」に落とすので、正しい文から具体を外す修正指示になり得る。2 件目は重複として捨てる（修正の対象にしない）。

## F15（Low・既存）レビュー画面の review_warning がエスケープされていない

- `netlify/functions/review-page.js` 169 行付近は `review_warning` をエスケープせずに HTML に出している。照合が足す文は固定文だが、全文再生成の `review_warning` を引き継ぐので LLM の出力が入りうる。既存の欄の見た目は変えずに HTML エスケープする（改行の扱いは今と同じに）。
- テスト: `<script>` を含む review_warning がエスケープされる。

## F16（Low）照合の呼び出しの時間切れ

- 照合（抜き出し・判定・修正）の LLM 呼び出しに明示の時間切れを設ける（既定 10 分、`FACT_CHECK_TIMEOUT_MS`）。時間切れは `not_run`（落とす側）。修正の出力は最大 12,000 トークンなので、既定の 300 秒で切れないこと。
- テスト: 偽の LLM が時間切れ → `not_run`・`fact_check_blocking: true`。

## 記録だけするもの（直さない）

- L5: 修正で該当文以外に文を足すことは止めていない（事実は再照合で拾える）。
- L9: 更新案の照合記録は承認時に枝ごと消え、main に残らない。監査の記録が要るなら別作業。
- 上限 40 件を超えた主張・捨てた主張があると revise になる。実 LLM での受け入れ確認で revise になる割合を測り、必要なら `FACT_CHECK_MAX_CLAIMS` を上げる（Claude と毛利さんで判断）。

## 変更してはいけないもの

- 01〜03 で実装した挙動のうち、上の F1〜F16 以外。
- 既存の品質ゲートの条件・承認処理の他の部分（`test-review-approve-refresh.js` の既存の項目を含む）。
- 既存の出典の決め方（F3 で元に戻す）・生成後の重複判定・論点別ルール・番号の照合。
- `content/posts/*.md`。
