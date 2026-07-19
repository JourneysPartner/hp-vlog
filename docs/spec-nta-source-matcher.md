# 仕様書・設計書：出典の自動マッチャ＋ガードレール

最終更新: 2026-07-19 / ステータス: ドラフト（実装前レビュー v2・レビュー反映・codex 実装向け）

> v2 反映（実装可否を左右する P1 の確定）：
> **[P1] auto の公開方針を統一** — Phase 1 は **`provenance='auto'` を一律"承認保留（needs_source_review）"** とし、
> confidence は人間向けの順位付けだけに使う（"curated 昇格前も事故ゼロ"の保証と整合。auto を自動承認可能にしない）。
> **[P1] provenance/confidence を実経路で保持** — 出典は現状 scenario 系3ファイルが `{tax_domain,pain_point}` だけで
> 早期確定し url/title しか残さない。**完成 topic を受ける単一契約 `resolveSourceForTopic(topic)`** に集約し、
> scenario 系3ファイル＋`draft-normalizer.js`＋結合テストを実装対象に追加。
> **[P1] 承認・公開で"現在の frontmatter から再判定"を必須化** — `review-approve-background.js` と `publish-due.js` は
> 保存済み score を信用せず、現在の source_url/provenance から `checkSourceAlignment` を**再実行**して判定する。
> **[P2]** スコアリング（重み・閾値・1-2位差・同点順・ストップワード）を確定／**matcher 専用トークナイザに分離**
> （既存 `topic-similarity.js` は日本語2gramを生成しておらず、変更は重複判定に波及するため）／
> **税目フィルタを 1対多**（`tax_domain → tax_category_code[]`）にし、未対応/カタログ欠損/JSON破損は **null→必ず保留**。

## 1. 目的・背景

記事生成で「論点（pain_point）に対応する正しい国税庁タックスアンサー」が付かず、**汎用の
No.6501（納税義務の免除）に静かにフォールバック**して事故が起きている（例: #297 簡易課税事業区分→本来 No.6509、
#306 高額特定資産の3年縛り→本来 No.6502）。個別に手当てする"もぐら叩き"では、同型の穴が残る。

現状の消費税 deepdive 論点のうち **14件が今も汎用 No.6501 にフォールバック**する（`residential-rental-input-tax-restriction`・
`taxable-sales-ratio`・`individual-vs-proportional-method`・`travel-expense-input-tax` 等）。

一方で、**正しい出典は"もう手元にある"**：`data/nta-sources/index.json` に国税庁ページ **2,222件**（タックスアンサー／質疑応答）が
クロール済みで、`nta-index-builder`／`nta-store`／`nta-ngram-check` の機構も揃っている（No.6502 も収録済み）。
つまり「ネットで探せない」のではなく「**手元の検証済みカタログに配線していない**」だけ。

### 方針
- **手元の検証済み国税庁カタログから、論点に最も適合するタックスアンサーを自動選定**する（＝"ネット検索の安全版"）。
- 自動選定の信頼度が低い／汎用既定にしか落ちない場合は、**承認保留（needs_source_review）にして公開前に必ず止める**。
- ライブなネット検索は採用しない（他社ブログ・古い記事の混入や、LLM による番号捏造のリスクを避けるため）。

### 非スコープ
- 本文の事実そのものの正誤判定（数値の完全検証）。本仕様は「出典の割当と、出典ズレの検出・保留」に限定。
- 既存の手動出典マップ（`DEFAULT_SOURCE_BY_PAIN`）や #299/#308 の是正は**そのまま最上位の"人が検証済み"層**として残す。

## 2. 現状の仕組みと穴（調査結果）

### 2.1 出典の割当
- deepdive 論点（`scenario-deep-dive.js`）は**大半が自前の `source_url` を持たない**（4件のみ例外）。
- 生成時 `ensureSourceOnTopic()`（`generate-draft.js`）が `getDefaultSourceForTopic()` を呼ぶ。優先順は
  **① pain 別マップ `DEFAULT_SOURCE_BY_PAIN` → ② 税目既定 `DEFAULT_SOURCE_BY_TAX_DOMAIN`（消費税=No.6501）→ ③ 国税庁トップ**。
- ①は**人が手で登録するホワイトリスト**（LLM の番号捏造を防ぐため）。新 pain を足しても①への登録は強制されず、
  未登録なら②の汎用 No.6501 に落ちる。

### 2.2 品質ゲートが見逃す理由（重要）
- `source-alignment.js:checkSourceAlignment()` は「期待出典 `expectedSourceFor(topic)`」と「実際の source_url」を比べる。
- pain 未登録だと**期待も②の汎用 No.6501**になり、実際の source も②で **6501 → 一致とみなし `score:5`**。
  だから #306 は `source_alignment_score:5` で承認可能な状態になっていた。
- 既存の n-gram チェック（`nta-ngram-check` / `validate.js`）は「**原文を3文以上コピーしていないかの転載検知**」であり、
  "出典がテーマに合っているか" は見ない（むしろ"似すぎ"を罰する）。→ 出典ズレは検出できない。

### 2.3 使える資産
- `data/nta-sources/index.json`：`{ entries: [{ id, type('taxanswer'|'shitsugi'), tax_category, tax_category_code,
  title, url, file_path, char_count_body, deleted, ... }] }`（本文は `file_path` の個別 JSON）。
- `nta-store.js`：`readJson` / `loadTaxAnswerEntry(categoryCode, id)`（本文取得）。
- `source-alignment.js`：`NEEDS_SOURCE_REVIEW`（保留フック・pain 集合）、`expectedSourceFor`、`checkSourceAlignment`。

## 3. 全体設計

出典解決は **完成した topic を受け取る単一契約 `resolveSourceForTopic(topic)`** に集約する
（現状は scenario 系3ファイルが `{tax_domain,pain_point}` だけで早期確定し、以後 `ensureSourceOnTopic` は
source_url がある限り再解決しない＝matcher も provenance も効かない。§4.2 参照）。

```
（完成 topic：title/search_intent/pain_point/tax_domain 等が揃った状態）
   │
   ▼  resolveSourceForTopic(topic)  → { url, title, provenance, confidence }
      ① topic.source_url（明示・人が指定）      … provenance='explicit'
      ② DEFAULT_SOURCE_BY_PAIN[pain]            … provenance='curated'（人が検証済み・最優先）
      ③ ★nta-source-matcher（ローカルカタログ） … provenance='auto'（confidence 同梱）
      ④ 税目既定（No.6501 等）                  … provenance='domain-fallback'
      ⑤ 国税庁トップ                            … provenance='ultimate'
   │
   ▼  draft-normalizer が frontmatter へ保持：
      source_url / source_title / source_provenance / source_confidence
   │
   ▼  ★ガードレール（生成時＝validate/選定 と、承認時＝review-approve と、公開時＝publish の3点で
      "現在の frontmatter" から再判定）
      provenance ∈ {auto, domain-fallback, ultimate} → needs_source_review（保留・承認/公開させない）
      provenance ∈ {explicit, curated} かつ URL 一致 → aligned（score 5）
```

**auto の扱い（P1・確定）**：Phase 1 は **`provenance='auto'` を一律"保留"** とする（自動承認しない）。
confidence は「人が確認する順番」を決めるための順位付けにのみ使い、**閾値で自動承認可否を分けない**。
→ これで「curated 昇格前も事故ゼロ」の保証と矛盾しない。

## 4. コンポーネント設計

### 4.1 新規 `scripts/lib/nta-source-matcher.js`（自動マッチャ）
- **入力**：完成 topic（`title`・`search_intent`・`primary_question`・`reader_problem`・`pain_point`・`subcluster`・`tax_domain`）。
- **対象**：`index.json` の `type==='taxanswer'` かつ `deleted!==true`。**税目で事前フィルタ**（§5 の 1対多マップ）。
- **専用トークナイザ（`topic-similarity.js` とは分離）**：既存 `topic-similarity.js` は日本語2gramを生成せず
  （カタカナ/漢字連続と英数字のみ抽出）、変更は重複記事判定に波及するため**流用しない**。matcher 専用に:
  - 漢字連続（2字以上）・カタカナ連続（2字以上）・英数字語を抽出し、**漢字連続は 2-gram も併産**（部分一致を拾う）。
  - **ストップワード**（「について」「場合」「とは」「等」「制度」「取扱い」「取り扱い」「消費税」「所得税」など、
    税目名・汎用語）を除去（実装時に一覧確定）。「消費税」等の税目名はフィルタで効くので加点対象から外す。
- **スコアリング（確定）**：候補タイトル vs topic 語で重み付き加点。
  - `title_overlap`（topic 語とタイトル語の重なり率, Jaccard）× **0.6**
  - `institution_hit`（「高額特定資産」「簡易課税」「事業区分」等の**制度名**がタイトルに含まれる）× **0.3**
  - `pain_keyword_hit`（pain 由来キーワードの一致）× **0.1**
  - score は 0..1 に正規化。
- **採用条件（曖昧なら当てない）**：
  - **採用閾値** `score ≥ 0.45`。
  - **1位と2位の最低差** `top1 - top2 ≥ 0.12`（僅差は曖昧とみなす）。
  - 上記を満たさなければ **`null`**（＝ ④domain-fallback に落ち、ガードレールで保留）。
  - 同点・同スコアが複数 → `null`（順序に依存しない決定＝カタログ順で"たまたま"選ばない）。
- **出力**：`{ url, title, no, tax_category_code, score(0..1), candidates:[{no,title,score}…上位5] }` または `null`。
- 任意（Phase 2）：本文（`file_path`）読取で再ランク。

### 4.2 単一契約 `resolveSourceForTopic(topic)` への集約（P1）
- **問題**：出典は現状 `scenario-deep-dive.js`(L813)・`scenario-expansion.js`(buildTopic)・`scenario-new-segments.js`
  が **展開時に `{tax_domain,pain_point}` だけで確定**し、url/title のみ保存。`ensureSourceOnTopic` は source_url が
  あると再解決しない。→ matcher も provenance/confidence も効かない。
- **対応**：
  - 出典解決を **`resolveSourceForTopic(topic)`（`tax-authority-refs.js`）** に一本化。§3 の優先順で
    `{url,title,provenance,confidence}` を返す。matcher は完成 topic を見るので、この呼び出しは
    **title/search_intent が揃った後**（`draft-normalizer` の frontmatter 構築時、または生成直前）に行う。
  - **scenario 系3ファイルは早期に url/title を焼き込まない**（または焼いても provenance を持たせ、
    `resolveSourceForTopic` が最終上書きする）。二重解決を避け、最終決定を1箇所にする。
  - **`draft-normalizer.js`** は `source_url`/`source_title` に加え **`source_provenance`/`source_confidence`** を
    frontmatter に必ず出力（欠落時は既定 `unknown`／`0`）。
- **後方互換**：明示 source・curated マップは挙動不変（matcher は穴埋めのみ・優先度は下）。

### 4.3 ガードレール（`source-alignment.js`）＋ 承認/公開の再判定（P1・必須）
- **`checkSourceAlignment` の是正**：出典が **汎用既定にしか落ちていない**（`provenance ∈ {domain-fallback, ultimate}`、
  または pain が curated 未登録で税目既定に一致しているだけ）の場合、現状の「期待==実際==6501 → score 5」を**やめ**、
  **`needs_source_review`（score 3・severity 'soft'・aligned=false）** を返す。`provenance='auto'` も**保留**（§3）。
  - frontmatter 非依存でも効くよう、`expectedSourceFor` に **「curated 由来かどうか」** を返させ、
    「実際の source が curated 個別出典と一致」した時だけ aligned=5 とする。
- **承認・公開での再判定（必須変更）**：
  - **`review-approve-background.js`**：保存済み `source_alignment_score` を信用せず、**現在の frontmatter
    （source_url/source_provenance/pain_point/tax_domain）から `checkSourceAlignment` を再実行**し、
    `needs_source_review`／score≤3 なら **承認を 400 でブロック**。
  - **`publish-due.js`**：公開直前にも同じ再判定を行い、保留該当なら**公開しない**（スキップ＋通知）。
  - 既存の `NEEDS_SOURCE_REVIEW` 集合は併用（明示保留したい pain 用）。

### 4.4 （Phase 2・任意）出典↔本文の内容整合チェック
- n-gram 転載検知の"逆"：記事本文と**引用元本文の正の重なりが極端に低い**場合、出典ズレの疑いとして保留。
- 閾値調整が要るため Phase 2。まずは §4.2/§4.3 の provenance ガードで事故を止める。

## 5. 税目フィルタ（1対多・必ず保留に倒せる契約）

- 実カタログの `tax_category_code` は **8種**：`gensen / hojin / hyoka / joto / shohi / shotoku / sozoku / zoyo`
  （`taxanswer` 672・`shitsugi` 1,550）。**1対1では正解を取りこぼす**（例: 相続の正解は `sozoku` だけでなく
  `zoyo`・`hyoka` にもある）。
- **`tax_domain → tax_category_code[]`（配列）** で定義する。初期案（実装時にカタログ実値で最終確認）：
  - `consumption_tax` → `['shohi']`
  - `income_tax` → `['shotoku']`
  - `withholding` → `['gensen','shotoku']`
  - `bookkeeping_expenses` → `['shotoku']`（記帳・経費は所得税系）
  - `invoice_system` → `['shohi']`
  - `inheritance_tax` → `['sozoku','zoyo','hyoka']`
  - `overseas_transactions` → `['shohi']`
- **必ず保留に倒す契約**：`tax_domain` 未対応／`index.json` 欠損・読取失敗／JSON 破損／該当カテゴリ0件 の場合、
  matcher は **`null` を返す**（例外を投げない）。→ ④domain-fallback に落ち、ガードレールで **needs_source_review**。
- 既存の手動マップ（`DEFAULT_SOURCE_BY_PAIN`）は**正解教師データ**として matcher の回帰テストに流用。

## 6. バックフィル（既存 pain の穴を埋める運用）

- 一度だけ、**全 deepdive pain に matcher を走らせて出典案を出力**するスクリプト（`scripts/propose-sources.js`）を用意。
- 出力（候補＋score＋上位N）を**人が確認**し、良いものを **`DEFAULT_SOURCE_BY_PAIN` に昇格**（＝curated 化）。
  これで 14件（消費税系）ほかの在庫を計画的に解消。
- 昇格まで未整備 pain は §4.3 のガードレールで**保留**されるため、事故は起きない（auto も保留なので同じ）。

## 7. 実装対象ファイル

- **新規**：
  - `scripts/lib/nta-source-matcher.js`（matcher 本体・専用トークナイザ）
  - `scripts/propose-sources.js`（バックフィル提案）
  - `scripts/lib/__tests__/test-nta-source-matcher.js`
  - `scripts/lib/__tests__/test-source-provenance-e2e.js`（topic→frontmatter の provenance/confidence 結合）
- **変更**：
  - `scripts/lib/tax-authority-refs.js`：**`resolveSourceForTopic(topic)`** 新設（§3 の優先順・provenance/confidence）。
  - `scripts/lib/scenario-deep-dive.js`／`scenario-expansion.js`／`scenario-new-segments.js`：早期の url/title 焼き込みを
    やめる（または provenance 付きにして最終上書きに委ねる）。
  - `scripts/lib/draft-normalizer.js`：frontmatter に `source_provenance`/`source_confidence` を保持。
  - `scripts/generate-draft.js`：`ensureSourceOnTopic` を `resolveSourceForTopic` 経由に。
  - `scripts/lib/source-alignment.js`：`expectedSourceFor`/`checkSourceAlignment` を provenance 対応（汎用/auto は保留）。
  - `netlify/functions/review-approve-background.js`：**承認時に再判定**（保存 score を信用しない）。
  - `netlify/functions/publish-due.js`：**公開時に再判定**（保留該当は公開しない）。

## 8. テスト計画

- **matcher（既知解）**：`high-value-asset-3year-restriction`→6502、`simplified-tax-business-category`→6509、
  `consumption-tax-judgement`→6501/6505 圏 が妥当な**消費税(shohi)**タックスアンサーに当たる（他税目に飛ばない）。
  僅差・曖昧・カテゴリ0件・JSON破損は **`null`**。
- **専用トークナイザ**：日本語2gramを含むこと、ストップワードが除去されること、`topic-similarity.js` を変更しないこと。
- **税目フィルタ（1対多）**：`inheritance_tax` は `sozoku/zoyo/hyoka` を対象に含む。未対応 domain は `null`。
- **provenance 結合（E2E）**：topic → `resolveSourceForTopic` → `draft-normalizer` の frontmatter に
  `source_provenance`/`source_confidence` が**保持される**（curated/auto/domain-fallback の各ケース）。
- **auto は保留**：`provenance='auto'` の記事は `checkSourceAlignment` が **aligned=false／needs_source_review**（score≤3）。
- **ガードレール（生成時）**：pain 未登録で汎用 6501 に落ちる topic は **score 5 にならず needs_source_review**。
- **承認・公開の再判定（必須ケース）**：**`source_alignment_score: 5` を frontmatter に残したまま、`source_url` を
  6501／fallback に書き換えた記事**が、
  - `review-approve-background` で **承認できない（400 ブロック）**、
  - `publish-due` で **公開されない（スキップ）** ことを確認。
- **オフライン決定論**：ネット非依存・実行ごとに同結果（カタログ順に依存しない）。
- **回帰**：`test-simplified-tax-source`／`test-high-value-asset-source`／`test-selector`／`test-cross-domain-refs`／
  `test-conditional-rules`／`test-publish-slot` 全 PASS。`npm run build`／`npm run validate` 成功。

## 9. 段階リリース

- **Phase 1（本仕様・MVP）**：`resolveSourceForTopic` 集約＋matcher（タイトル/語・専用トークナイザ）＋
  provenance/confidence の frontmatter 保持＋ガードレール（**auto/汎用は一律保留**）＋
  **承認・公開での再判定（必須）**。これ単体で「同型事故」を止められる。
- **Phase 2（任意）**：本文読取での再ランク精度向上、出典↔本文の内容整合チェック、`propose-sources` で
  14件（ほか）の在庫を curated 昇格。curated が増えれば auto 保留の件数は自然に減る。

## 10. 確定事項・未決事項

**確定（レビュー反映）**
- **auto は Phase 1 では自動承認しない（一律保留）**。confidence は人間の確認順の順位付けのみ。
- **出典解決は `resolveSourceForTopic(topic)` に一本化**し、完成 topic（title 等）を見て決める。
- **承認時（review-approve）と公開時（publish-due）に、保存 score でなく現在の frontmatter から再判定**（必須）。
- **税目フィルタは 1対多**、未対応/欠損/破損は `null`→保留。
- **matcher 専用トークナイザを新設**（`topic-similarity.js` は変更しない）。

**未決（実装時に確定）**
- 採用閾値 `0.45` と 1-2位差 `0.12`、重み `0.6/0.3/0.1` の初期値チューニング（既知解セットで調整）。
- ストップワード一覧の確定。
- `tax_domain → tax_category_code[]` の最終確認（`bookkeeping_expenses`/`withholding` の割当など）。
- 既存記事（公開済み）は**再判定しない**（本仕様は新規生成・再生成のみ対象。既存の source は不変更）。
- **カタログの鮮度**：改正で古くなる → 月次クロール運用（#242 系）に依存。改正直後は curated 優先が安全。
