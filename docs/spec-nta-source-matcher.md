# 仕様書・設計書：出典の自動マッチャ＋ガードレール

最終更新: 2026-07-19 / ステータス: ドラフト（実装前レビュー用・codex 実装向け）

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

```
topic ─▶ ensureSourceOnTopic
          │  ① topic.source_url（明示）           … そのまま
          │  ② DEFAULT_SOURCE_BY_PAIN[pain]        … 人が検証済み（最優先）
          │  ③ ★nta-source-matcher（ローカルカタログ自動選定）
          │       confidence ≥ 閾値 → その出典を採用（provenance='auto'）
          │  ④ 税目既定（No.6501 等）              … 最後の手段（provenance='domain-fallback'）
          │  ⑤ 国税庁トップ                        … provenance='ultimate'
          ▼
   frontmatter に source_url / source_title＋source_provenance / source_confidence を付与
          ▼
   ★ガードレール（source-alignment / 承認ゲート）
     provenance が 'domain-fallback' / 'ultimate'、または auto かつ低信頼 → needs_source_review（保留）
```

## 4. コンポーネント設計

### 4.1 新規 `scripts/lib/nta-source-matcher.js`（自動マッチャ）
- **入力**：topic（`title`・`search_intent`・`primary_question`・`reader_problem`・`pain_point`・`subcluster`・`tax_domain`）。
- **対象**：`index.json` の `type==='taxanswer'` かつ `deleted!==true`。**税目で事前フィルタ**（`tax_domain` → 国税庁 `tax_category_code` へマッピング。例: consumption_tax→消費税カテゴリ）。
- **スコアリング**（LLM 非使用・決定論的・オフライン）：
  - タイトル・トピック語のトークン重なり（`topic-similarity.js` のトークナイザを再利用：kebab 分解＋日本語2gram/漢字・カタカナ抽出）。
  - **制度名の一致を強く加点**（例「高額特定資産」「簡易課税」「事業区分」等の連続漢字・専門語がタイトルに含まれる）。
  - 任意（Phase 2）：本文（`file_path`）を読み、topic 語との重なりで再ランク。
- **出力**：`{ url, title, no, tax_category, score(0..1), candidates: [{no,title,score} …上位N] }` または閾値未満で `null`。
- **同点・低差**時は `null`（曖昧なら当てない＝ガードレールで保留させる方が安全）。

### 4.2 `getDefaultSourceForTopic` / `ensureSourceOnTopic` への配線
- 優先順を §3 のとおり拡張。**②（手動マップ）が最優先**、③にマッチャ、④に汎用既定。
- 返り値に **provenance**（`explicit`/`curated`/`auto`/`domain-fallback`/`ultimate`）と **confidence** を含める。
- `ensureSourceOnTopic` は `source_url`/`source_title` に加え、frontmatter へ
  **`source_provenance` / `source_confidence`** を書き込む（後段ゲートと可観測性のため）。
- **後方互換**：既存の手動マップ・明示 source は挙動不変（マッチャは"穴埋め"だけ）。

### 4.3 ガードレール（`source-alignment.js` / 承認・選定ゲート）
- **穴を塞ぐ中核**：出典が **汎用の税目既定にしか落ちていない（provenance='domain-fallback'/'ultimate'）** 場合、
  現状の「期待==実際==6501 で score 5」を**やめ**、`checkSourceAlignment` は **`needs_source_review`（score 3・severity 'soft'・aligned=false）** を返す。
- **auto かつ低信頼**（confidence < 閾値）も同様に保留扱い。
- 実装オプション：
  - (a) frontmatter の `source_provenance` を見て判定（生成物に情報がある場合）。
  - (b) topic から `expectedSourceFor` が「pain 個別を確定できず税目既定に落ちた」ことを検知して判定（frontmatter 非依存）。
  - → 両立できるよう、`expectedSourceFor` に「curated かどうか」を返させるのが堅い。
- これにより **出典未整備・低信頼の記事は必ず承認ゲート前で止まる**（自動公開されない）。既存の
  `NEEDS_SOURCE_REVIEW` 集合はそのまま併用（明示的に保留したい pain 用）。

### 4.4 （Phase 2・任意）出典↔本文の内容整合チェック
- n-gram 転載検知の"逆"：記事本文と**引用元本文の正の重なりが極端に低い**場合、出典ズレの疑いとして警告/保留。
- 閾値調整が要るため Phase 2。まずは §4.3 の provenance ガードで十分に事故を防げる。

## 5. データ／マッピング

- **`tax_domain` → 国税庁 `tax_category_code`** の対応表（消費税／所得税／相続／贈与／…）。`index.json.by_category` の
  実キーに合わせて定義（実装時にカタログの実値を確認）。
- 既存の手動マップ（`DEFAULT_SOURCE_BY_PAIN`）は**正解の教師データ**でもある：マッチャの回帰テストに流用する。

## 6. バックフィル（既存 pain の穴を埋める運用）

- 一度だけ、**全 deepdive pain にマッチャを走らせて出典案を出力**するスクリプト（`scripts/propose-sources.js`）を用意。
- 出力を人が確認し、良いものを **`DEFAULT_SOURCE_BY_PAIN` に昇格**（＝curated 化）。これで 14件の在庫を計画的に解消。
- 昇格するまでの間も、§4.3 のガードレールで**未整備 pain は保留**されるため、事故は起きない。

## 7. 実装対象ファイル

- **新規**：
  - `scripts/lib/nta-source-matcher.js`（マッチャ本体）
  - `scripts/propose-sources.js`（バックフィル提案・任意）
  - `scripts/lib/__tests__/test-nta-source-matcher.js`
- **変更**：
  - `scripts/lib/tax-authority-refs.js`（`getDefaultSourceForTopic` に③マッチャ・provenance/confidence）
  - `scripts/generate-draft.js`（`ensureSourceOnTopic` で provenance/confidence を frontmatter へ）
  - `scripts/lib/source-alignment.js`（`expectedSourceFor`/`checkSourceAlignment` を provenance 対応・汎用フォールバックは保留）
  - （必要に応じ）`scripts/validate.js`／承認ゲート（保留判定の反映確認）

## 8. テスト計画

- **マッチャ（既知解）**：`high-value-asset-3year-restriction`→6502、`simplified-tax-business-category`→6509、
  `consumption-tax-judgement`→6501/6505 圏、`taxable-sales-ratio`／`individual-vs-proportional-method` 等が
  「妥当な消費税タックスアンサー」に当たる（税目フィルタが効き、他税目に飛ばない）。曖昧時 `null`。
- **オフライン決定論**：ネット非依存・実行ごとに同結果。
- **配線**：手動マップ登録済み pain は従来どおり（マッチャに横取りされない＝curated 最優先）。
- **ガードレール**：pain 未登録で汎用 6501 に落ちる topic は `checkSourceAlignment` が **score 5 にならず needs_source_review**。
  auto 高信頼は aligned、auto 低信頼は保留。
- **回帰**：`test-simplified-tax-source`／`test-high-value-asset-source`／`test-selector`／`test-cross-domain-refs`／
  `test-conditional-rules` 全 PASS。`npm run build`／`npm run validate` 成功。

## 9. 段階リリース

- **Phase 1（本仕様・MVP）**：マッチャ（タイトル/語ベース）＋配線（provenance/confidence）＋ガードレール
  （汎用フォールバック/低信頼→保留）。これ単体で「同型事故」を止められる。
- **Phase 2（任意）**：本文読取での再ランク精度向上、出典↔本文の内容整合チェック、`propose-sources` による
  14件の一括バックフィル→curated 昇格。

## 10. リスク・未決事項

- **誤マッチのリスク**：似た制度名で別ページに当たる可能性 → 閾値は**高精度寄り**（曖昧なら当てず保留）で運用。
  ガードレールが最終防波堤。
- **カタログの鮮度**：`nta-sources` は改正で古くなる → 既存の月次クロール運用（#242 系）に依存。改正直後は
  curated マップ優先が安全。
- `tax_domain`→`tax_category_code` の実キー確認（実装時にカタログ実値で確定）。
- 閾値（confidence）の初期値と、保留（needs_source_review）に倒す境界の調整。
- 既存記事（公開済み）は**再判定しない**（本仕様は新規生成・再生成のみ対象。既存の source は不変更）。
