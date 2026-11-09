# 02 照合の資料探しに「Q&A・事例集の専用の 1 枠」を足す（qa-slot）

2026-11-07 毛利さん決定（「この枠だけ数字も使う」）。照合（Opus）の判定・修正・承認の止めは変えず、主張ごとに資料を探す検索（`scripts/lib/fact-evidence.js` の `searchEvidence`）に、国税庁の Q&A・事例集（`data/nta-qa/`）を 1 枠だけ入れられるようにする。

## 背景（なぜ必要か）

- 照合の検索の目録 `evidenceCatalog()` は、タックスアンサー・質疑応答・法令・通達の 4 種だけを読む。`data/nta-qa/`（382 問・約 57 万字。インボイス 173・軽減税率 138・暗号資産 47・相続 13 ほか）は一切読まない。
- 10/21 の設計（`docs/codex-tasks/fact-plan/01-plan-and-writer-materials.md` 23 行目）で「照合の段 B の検索には Q&A を足さない（既存の検索の試験・基準値を変えないため）」とし、Q&A は書き手の資料（`fact_materials`、段 A）からだけ照合に渡すことにした。ところが段 A/B の切り替え `FACT_CHECK_WRITER_MATERIALS` は本番で未設定（止まっている）。→ **本番では Q&A がどの経路でも照合に届かない。**
- 実例: #693（一人親方のインボイス登録）の「翌年1月1日から戻したい場合は、その年の12月17日が期限です」「この期限は土日祝でも延びません」は正しいが、照合は資料なしとした。この内容は全資料のうち `data/nta-qa/invoice/jireishu.json`（インボイス制度において事業者が注意すべき事例集）にしか無い（「1/1から登録を取り消す場合、12/17まで（土日祝日の場合でもその翌日に期限が延長されない）」）。

## 試算（AI なし。2026-11-07、Claude）

main の照合記録 9 本＋#693 の記録（637 主張）で、今の検索と試作を比べた。「keep」は、Opus が根拠にしたページが今の検索の候補 7 件に入っている主張（538 件）。

| 試した形 | #693 c41（12/17） | c42（土日祝） | c63（要約の15日前） | keep の押し出し | Q&A が入る主張 |
|---|---|---|---|---|---|
| 目録に Q&A を足すだけ | × 問17 | × 問17 | × 問17 | 7 件 | 187 |
| 記事の分野で絞る（本文の枠に Q&A を許す形も含む） | × | × | × | 5〜7 件 | 127〜156 |
| **専用 1 枠（下の R3・R4）・数字を使わない** | × 問7 | ○ 事例集 | ○ 事例集 | 2 件 | 138 |
| **専用 1 枠・この枠だけ数字も使う（採用）** | ○ 事例集 | ○ 事例集 | ○ 事例集 | 2 件 | 153 |

- 目録に足すだけでは、記事全体の `tax_terms` が毎回の検索語に足されるため、題名にその語を持つ問17・問17-2 が上位を占め、事例集は 82 位だった。主張の文との一致だけで並べると、事例集は Q&A の中で 1 位だった。
- 押し出し 2 件: c40（基通1-4-1の2 → 事例集。事例集も同じ 15日前を書くので実害なし）、c46（消法57条の2 → 問7。実害あり、受け入れで再確認する）。

## 方針

- Q&A は、今の枠（記事の資料・直接引用・制度名の検索・一般の上位 3 枠・本文の枠）で競わせない。**専用の 1 枠**だけで入れる。
- 候補は 7 件のまま（判定に渡す資料表を増やさない）。
- 対象は、記事の分野に合う Q&A だけ（書き手に Q&A を渡すときと同じ決まり）。
- **この枠に限り、数字の型（金額・割合・期限・適用年・番号）の主張でも、主張の数字を含む一致を点に数える**（11/7 決定）。一般の枠の「数字の型は主張の数字で資格を与えない」（`numericEligible`）は変えない。
- 既存のページの点・順番は 1 つも変えない（語の珍しさ・母数・頻度は Q&A 抜きで計算する）。

## 要件

### R1 Q&A の資料を検索用に読む（`fact-evidence.js`）

- `data/nta-qa/index.json` の各問を読み、検索用の資料にする。
  - id は `qa:<source_key>/<id>`（`writer-materials.js` の `material_id` と同じ形。例 `qa:invoice/jireishu`）。
  - 種類 `kind: 'qa'`。`url` は index の URL（同じ PDF を多数の問が共有する）。`source_key`・`tax_domain`・`tax_category_code`・`q_no` を持つ。本文は各問のファイルの `body`。
  - 資料表に出す題名は「資料名 問の題名」（`${source_label} ${title}`）。**検索で題名の語として数えるのは問の題名だけ**（資料名は全問に共通なので数えない）。
- `evidenceCatalog()` は**変えない**（`article-plan.js` 112 行が `[...evidenceCatalog().entries, ...qaCatalog()]` で Q&A を自分で足しており、目録に入れると二重になる。`writer-materials.js` の `materialId` も目録を URL で引く）。Q&A は別の関数（例 `qaEvidenceEntries()`）で持つ。
- index.json や問のファイルが読めないときは例外にする（照合は not_run）。既存の目録と同じく、検索範囲を黙って狭めたまま通さない。

### R2 記事ごとの対象の絞り込み

- `fact-check.js` の `articleEvidenceOptions(meta)` に、Q&A の対象を決める文を足す（例 `qa_scope_text`）。中身は前付けの `tax_terms`・`pain_point`・`primary_question`・`reader_problem`・`search_intent`・`title` を空白でつないだもの（`scripts/generate-draft.js` の `buildQaBlockForTopic` と同じ欄）。
- 対象の Q&A = `nta-qa-sources.eligibleSourceKeys(qa_scope_text)` に含まれる `source_key`、かつ `entry.tax_domain === options.tax_domain`。
- `qa_scope_text` が無い呼び出し（他の呼び出し元・既存の試験）では Q&A を使わない。**結果は今と完全に同じ**にする。

### R3 Q&A 枠の点

- 既存の `scoreEvidence` と同じ考え方で点を付ける。ただし、次はすべて既存の目録（Q&A 抜き）から計算した値を使う。
  - 語の珍しさ（`df`）と母数（`scorePopulation` = 既存の目録の件数）
  - 数字の頻度・題名の頻度・本文の数（`statementFrequencies` の中身）
  - 珍しい数字の境目（`rareNumbers`）
- Q&A 枠の点 `qaScore` = 既存と同じ計算の `statementScore`（主張の文 claim＋sentence の語の一致、題名の一致、6 字の一致 1 つにつき 20 点。**数字を含む 6 字の一致も数える**）＋主題（`subject`）の語のうち主張の文に無いもの（本文にあれば珍しさ×1、題名にあれば×3）。
- 別の税目の扱い（`OTHER_TAX_SCORE`・`statementEligible`）は既存と同じに当てる。Q&A の税目は `tax_category_code` から `CATEGORY_TAX` で決める。
- 下限: `qaScore > 60` かつ 6 字の一致が 1 つ以上。定数は名前を付けてファイルの上に置き、根拠（11/7 の試算の表）をコメントに書く。

### R4 枠の入れ方（`searchEvidence`）

- Q&A は記事の資料（own）・直接引用（direct）・制度名の検索（subjectTop）・一般の上位 3 枠（diverse）・本文の枠（statementTop）のどれにも入れない。
- Q&A を URL で記事の資料と照らし合わせない（同じ PDF の URL を多数の問が共有するため、`source_bundle` に PDF の URL があると全問が記事の資料になってしまう）。
- 本文の枠の処理の後で、下限を満たす Q&A のうち `qaScore` が最も高いもの（同点は既存の `byScore`、さらに id の順）を 1 件だけ選ぶ。既に選ばれた id なら入れない。
- 入れる場所:
  - diverse が 3 件未満なら末尾に足す（何も押し出さない）。
  - 3 件あるなら 3 枠目と置き換える。ただし 3 枠目が直接引用か本文の枠のときは 2 枠目と置き換える。2 枠目も直接引用なら入れない。
- 候補は 7 件を超えない。返す資料の形（`text` は `contiguousExcerpt` の抜粋、`text_start`、`score`）は既存と同じ。

### R5 原文の読み込み

- `loadEvidenceText(ref)` が `qa:` の id に対して問の本文全体を返す。`buildPages` はこれで資料表を作る（6000 字以下は全文、超える問は主張の抜粋の範囲）。
- `writer-materials.js` の `resolveMaterial`・`materialId` は変えない（id の形が同じなので、記録の id は書き手の資料の id と一致する）。

### R6 速さ

- 対象の Q&A の配列と、点の計算に使う正規化の文字列・語の集合は、`source_key` の組と `tax_domain` ごとに 1 回だけ作って使い回す。主張ごとに目録全体の配列を作り直さない（作り直すと頻度表が毎回作り直され、極端に遅くなる）。
- 環境変数の読み出しを主張×資料の繰り返しの中に置かない（Windows では 1 回ごとに遅い。11/7 の試作で 30 分超になった）。
- 目安: 照合 1 本の検索時間が今の 1.2 倍以内。

### R7 版

- `fact-check.js` の `LOGIC_VERSION` を `plan2-s7` に上げる（過去の判定を使い回さない）。

## 試験（`scripts/lib/__tests__/test-fact-qa-slot.js` を新設）

- T1 `qa_scope_text` が無いとき、`searchEvidence` の結果（id・順番・抜粋・点）が変更前と完全に同じ。固定の主張を数件（インボイス・所得税・相続）で確かめる。
- T2 対象の Q&A が無い記事（所得税の記事・SCOPES に当たらない記事）でも、結果が変更前と完全に同じ。
- T3 `docs/codex-tasks/fact-search/fixtures/qa-slot/pr693-claims.json` の c41・c42・c63 で、`qa:invoice/jireishu` が候補に入る。候補は 7 件以内。
- T4 c40・c46 で、変更前の候補のうち記事の資料・制度名の検索・直接引用・本文の枠のページが残る。
- T5 入れる場所: 3 枠目が直接引用なら 2 枠目と置き換える／2・3 枠目とも直接引用なら入れない／diverse が 3 件未満なら足す（押し出さない）。
- T6 `source_bundle` に Q&A の PDF の URL があっても、その PDF の問が記事の資料にならない。
- T7 `loadEvidenceText({ id: 'qa:invoice/jireishu' })` が本文全体を返し、`buildPages` の資料表に載る。
- T8 分野の違う Q&A（tax_domain が違う、SCOPES に当たらない）は入らない。
- T9 下限: `qaScore` が 60 以下、または 6 字の一致が 0 の Q&A は入らない。
- T10 数字の型の主張でも、数字を含む 6 字の一致が Q&A 枠の点に入る。一般の枠の資格（`numericMatch`）は変わらない。
- T11 index.json が壊れているとき例外になる。
- T12 `evidenceCatalog()` の件数と中身が変わらない。

既存の照合の試験（`test-fact-check*.js`・`test-fact-pages.js`・`test-fact-plan-0*.js`・`test-catalog-coverage.js`・`test-fact-ai-supported-numbers.js` ほか）はすべて、期待を変えずに通ること。

## 変えてはいけないもの

- 判定・修正・再照合・承認の差し止め、引用の確かめ（引用の実在・数字が引用の前後 300 字にあるか・候補の外の資料の扱い）。
- 候補 7 件、既存の枠の選び方と順番、`numericEligible` の扱い。
- `evidenceCatalog()`・`writer-materials.js`・`article-plan.js`・`generate-draft.js`。
- 記事（`content/`）とカタログ（`data/`）。
- 特定の記事・語・ページ ID のための規則を足さない（事例集の id を決め打ちしない）。

## 弱くなる点（README に記録する）

- Q&A 枠だけ主張の数字を使うので、誤った数字を含む別の話題の問が、その 1 枠に入ることがある。残りの 6 枠は今どおり数字を使わずに選ぶので、正しい資料も並ぶ。対象は記事と同じ分野の Q&A に限る。

## 受け入れ（Claude）

1. 実装担当の報告と `git status`（指示書に無いファイルを触っていないか）。
2. 試算の道具（`%TEMP%\qa-bench`）を main と作業枝の本物の関数で流す。合格の目安は次のとおり。
   - keep の押し出し 2 件以内。押し出された主張には、正しいページが残ること。
   - #693 の 3 主張で事例集が候補に入る。
   - Q&A が入る主張は 160 前後。
   - 記事ごとの資料表の字数の増え方を記録する。
3. 関係の試験と、照合まわりの試験一式を隔離の外で流す。
4. 検索は全部の照合の入力を変えるので、Opus 5.5 xhigh でレビューする。
5. 実 AI: #693 を作業枝のコードで照合し直す（`fact-check.yml` の `code_ref`）。毛利さんの了承を得てから行う。
