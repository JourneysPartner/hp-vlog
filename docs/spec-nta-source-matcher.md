# 仕様書・設計書：出典の自動マッチャ＋ガードレール

最終更新: 2026-07-19 / ステータス: ドラフト（実装前レビュー v4・レビュー反映・codex 実装向け）

> v4 反映（「auto も生成する」方針に伴う残 P1×3・P2×1）：
> **[P1] auto を選定に通すための実装対象・契約を明記** — 現行 `topic-selector` は `decision==='approve'` だけ通し、
> `evaluateTopicFit` は soft／score≤3 で `revise` を返す＝**auto は生成前に除外**される。`customer-relevance.js`/
> `topic-selector.js` を実装対象に追加し、**「唯一の保留理由が needs_source_review で、他の適合（顧客適合・検索意図）は
> 合格」の時だけ選定を許可**する契約に（検索意図不足・顧客不適合は従来どおり除外）。
> **[P1] 既存記事と validate の両立** — main は記事166件中 `source_provenance` 0件・published 多数。provenance 欠落を
> 一律ブロックすると既存が壊れる。**`source_guard_version` を導入**し、新規/再生成は v1 必須・欠落ブロック、既存 published は
> レガシー＝警告のみ、未承認/予約中は承認・公開を止めて再生成/移行を促す。
> **[P1] 既存 CURATED_TOPICS(54件) の explicit 移行** — 全54件が `source_url` を持つが `source_provenance` は0件。
> 移行時に **`source_provenance:'explicit'` を付与**（人手指定URLを信頼済み override とする）。回帰テスト追加。
> **[P2] カタログ障害時の `rankSources` 返却形を fail-closed で定義**（`errorCode:'catalog_unavailable'`）。
>
> v3 反映：解決タイミングを選定前に／URL だけで explicit 昇格しない・再生成後 provenance 保持／公開は scripts/publish-due.js・
> validate 追加／matcher API を rankSources・selectSource に分離。

> v3 反映（実装経路との照合で判明した P1×3・P2×1）：
> **[P1] 解決タイミングを"選定より前"に前倒し** — 出典は pool 構築（`getAllTopics`→`expandAll`）で焼かれ、
> `selectDailyTopics` の品質ゲート（`evaluateTopicFit`→`checkSourceAlignment`）が**選定より先**に走る。早期URLを消すと
> curated 含む scenario topic が「source 未設定」で全滅する。→ **`resolveSourceForTopic` は「scenario 展開完了後・選定/品質ゲート前」**に実行。
> **完成 topic の定義を「非LLMメタデータが揃った状態（title は任意・空でよい）」に修正**し、matcher は title 非依存にする。
> **[P1] URL があるだけで explicit にしない** — 再生成では auto/fallback 記事にも URL が既にある。URL 存在だけで
> explicit 昇格＝保留回避になるのを禁止。**既存 `source_provenance` を再生成後も保持**／auto・fallback・unknown を
> explicit に自動昇格しない／provenance 欠落は unknown＝保留／再生成（全文・部分・タイトルのみ）後も provenance 不変のテスト。
> **[P1] 公開ゲートのパス誤り＋validate 欠落** — 公開は `scripts/publish-due.js`（`netlify/functions/` ではない）。
> 再判定3段（生成=validate／承認／公開）のうち **`scripts/validate.js` を実装対象に追加**（現状 provenance を渡していない）。
> **[P2] matcher の API 分割** — `rankSources(topic)`（常に上位5・score・margin を返す）と
> `selectSource(ranking)`（採用条件を満たす時だけ選定・他は null）に分離し、`propose-sources` が候補を提示できるように。
> **confidence の定義**も明記。
>
> v2 反映：auto を一律保留／`resolveSourceForTopic` 集約／承認・公開で再判定／スコアリング確定／専用トークナイザ分離／税目フィルタ 1対多。

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

出典解決は **単一契約 `resolveSourceForTopic(topic)`** に集約する。**実行位置は「scenario 展開完了後・
選定/品質ゲートの前」**（＝`getAllTopics`/`expandAll` 後、`selectDailyTopics` の前）。現状は scenario 系3ファイルが
`{tax_domain,pain_point}` だけで早期確定し、`selectDailyTopics`（`evaluateTopicFit`→`checkSourceAlignment`）が
**選定より先**に走るため、早期URLを消すと curated 含む topic が「source 未設定」で全滅する（§4.2）。

- **完成 topic の定義**：**非LLMメタデータが揃った状態**（`tax_domain`/`pain_point`/`cluster`/`subcluster`/
  `search_intent`/`primary_question`/`reader_problem`/deepdive の `topic` 語 等）。**title は任意（この時点では空）**。
  → **matcher は title 非依存**で、上記テキストから照合する。

```
expandAll（scenario 展開）─▶ resolveSourceForTopic(topic)  → { url, title, provenance, confidence }
   ① 人が明示（topic が provenance='explicit' を伴って持つ場合）… 'explicit'  ※URL があるだけでは昇格しない
   ② DEFAULT_SOURCE_BY_PAIN[pain]                            … 'curated'（人が検証済み・最優先）
   ③ ★nta-source-matcher（ローカルカタログ・selectSource）  … 'auto'（confidence 同梱）
   ④ 税目既定（No.6501 等）                                  … 'domain-fallback'
   ⑤ 国税庁トップ                                            … 'ultimate'
      ▼
   selectDailyTopics（品質ゲート）… source は"解決済み"なので未設定全滅は起きない（§4.3 選定は緩め）
      ▼
   本文生成 → draft-normalizer が frontmatter へ保持：
      source_url / source_title / source_provenance / source_confidence
      ▼
   ★ガードレール（"現在の frontmatter" から再判定・3点：生成=validate／承認=review-approve／公開=publish）
      provenance ∈ {auto, domain-fallback, ultimate, unknown} → needs_source_review（承認/公開を止める）
      provenance ∈ {explicit, curated} かつ URL が期待出典と一致 → aligned（score 5）
```

**auto の扱い（P1・確定）**：Phase 1 は **`provenance='auto'` を一律"保留"**（自動承認しない）。confidence は
「人が確認する順番」の順位付けにのみ使う。

**"保留"は「選定除外」ではなく「承認/公開で止める」**（重要）：auto/fallback の topic も**生成はされる**
（matcher が妥当な出典を当てて接地するので本文品質は保てる）。ただし **承認・公開・validate の provenance ゲートで
必ず止まる**ので、人の確認なしには公開されない。選定段階で落として"何も作らない"のではなく、
"作るが人が出典を確認するまで公開しない"設計（＝バックフィルと両立）。

## 4. コンポーネント設計

### 4.1 新規 `scripts/lib/nta-source-matcher.js`（自動マッチャ）

- **入力（title 非依存）**：完成 topic のうち **title を使わない**（この時点で空）。照合語は
  `search_intent`・`primary_question`・`reader_problem`・deepdive の `topic` 語・`pain_point`・`subcluster`。
- **対象**：`index.json` の `type==='taxanswer'` かつ `deleted!==true`。**税目で事前フィルタ**（§5 の 1対多マップ）。
- **専用トークナイザ（`topic-similarity.js` とは分離）**：既存 `topic-similarity.js` は日本語2gramを生成せず
  （カタカナ/漢字連続と英数字のみ抽出）、変更は重複記事判定に波及するため**流用しない**。matcher 専用に:
  - 漢字連続（2字以上）・カタカナ連続（2字以上）・英数字語を抽出し、**漢字連続は 2-gram も併産**（部分一致を拾う）。
  - **ストップワード**（「について」「場合」「とは」「等」「制度」「取扱い」「取り扱い」「消費税」「所得税」など、
    税目名・汎用語）を除去（実装時に一覧確定）。税目名はフィルタで効くので加点対象から外す。

#### API を 2 段に分離（P2）
- **`rankSources(topic)`**：**常に**候補ランキングを返す（採用可否に関係なく）。
  `{ candidates: [{ no, title, url, tax_category_code, score }…上位5], top1, top2, margin, errorCode: null }`。
  - **カタログ障害時は fail-closed の返却形**（例外を投げない）：
    `{ candidates: [], top1: null, top2: null, margin: 0, errorCode: 'catalog_unavailable' }`
    （`index.json` 欠損・読取失敗・JSON 破損・該当カテゴリ0件・未対応 domain 等）。
    → `selectSource` は `null`、`resolveSourceForTopic` は ④fallback、`propose-sources` は **errorCode を人に表示**。
  - スコアリング（確定）：候補タイトル vs topic 語で重み付き加点。
    - `title_overlap`（topic 語とページタイトル語の Jaccard）× **0.6**
    - `institution_hit`（「高額特定資産」「簡易課税」「事業区分」等の**制度名**がタイトルに含まれる）× **0.3**
    - `pain_keyword_hit`（pain 由来キーワードの一致）× **0.1**
    - score は 0..1 に正規化。`margin = top1.score - top2.score`（候補1件なら margin=top1.score）。
- **`selectSource(ranking)`**：**採用条件を満たす時だけ**採用結果を返し、他は `null`。
  - 採用条件：`top1.score ≥ 0.45` **かつ** `margin ≥ 0.12`。同点・僅差・候補0件は `null`
    （順序に依存せず"たまたま"選ばない）。
  - **confidence の定義（確定）**：`confidence = top1.score`（0..1、採用されたページの適合度）。
    `margin` は採用判定に使うだけで confidence 値には混ぜない（人が「僅差だった」を別途見られるよう ranking に残す）。
  - 返り値：`{ url, title, no, tax_category_code, confidence, margin }` または `null`。
- `resolveSourceForTopic` は ③で `selectSource(rankSources(topic))` を使う。`propose-sources` は
  `rankSources` を使い、**採用されなくても上位候補・score・margin を人に提示**できる。
- 任意（Phase 2）：本文（`file_path`）読取で再ランク。

### 4.2 単一契約 `resolveSourceForTopic(topic)` への集約と**実行位置**（P1）
- **問題**：出典は現状 `scenario-deep-dive.js`(L813)・`scenario-expansion.js`(buildTopic)・`scenario-new-segments.js`
  が **展開時に `{tax_domain,pain_point}` だけで確定**し、url/title のみ保存。しかも `selectDailyTopics` の品質ゲート
  （`evaluateTopicFit`→`checkSourceAlignment`）は**選定＝生成より前**に走り、**source 未設定だと除外**される。
  よって早期URLを単純に消すと、**curated 含む scenario topic が全滅**する。
- **実行位置（確定）**：**`resolveSourceForTopic` は「scenario 展開完了後・`selectDailyTopics` の前」**に一括適用する
  （例：`getAllTopics()` が `expandAll()` の結果を返す直前、または pool 構築の最終段）。matcher は title 非依存なので
  この時点（title 空）で動く。→ 選定時には source が"解決済み"で、未設定全滅は起きない。
- **対応**：
  - 出典解決を **`resolveSourceForTopic(topic)`（`tax-authority-refs.js`）** に一本化。§3 の優先順で
    `{url,title,provenance,confidence}` を返す。
  - **scenario 系3ファイルは早期に url/title を焼き込まない**（最終決定は resolveSourceForTopic の1箇所）。
  - **`draft-normalizer.js`** は `source_url`/`source_title` に加え **`source_provenance`/`source_confidence`** を
    frontmatter に必ず出力（欠落時は `unknown`／`0`）。

#### explicit の定義・期待URL・既存 CURATED の移行（P1）
- **explicit は「人間による信頼済み override」**：`provenance='explicit'` の topic は、その **`source_url` 自体を正本
  （期待URL）** とみなす（＝「explicit かつ URL が期待出典と一致」は常に真＝人が指定したものを信頼する）。
  curated の期待URLは `DEFAULT_SOURCE_BY_PAIN[pain].url`。→ §4.3 の「aligned=5」判定の"期待URL"はこの2系統から取る。
- **既存 `CURATED_TOPICS`（54件）の移行**：全54件が人手指定の `source_url` を持つが `source_provenance` は0件。
  そのまま「URL だけでは explicit にしない」を適用すると unknown に落ちる。→ **移行時に静的 `CURATED_TOPICS` へ
  `source_provenance:'explicit'` を付与**（`topic-pool.js`）。`resolveSourceForTopic` は topic が持つ explicit を尊重する。
  回帰テストで「静的 curated topic が unknown にならない」ことを担保。
- **URL があるだけで explicit にしない**。`provenance='explicit'` は **topic が明示的に `source_provenance:'explicit'` を
  伴って持つ場合のみ**。単に `source_url` が非空なだけ（auto/fallback 由来）では explicit にしない。
- **再生成時は既存 provenance を保持**：全文/部分/タイトルのみ いずれの再生成でも、**frontmatter の既存
  `source_provenance`/`source_confidence` を読み取り、そのまま引き継ぐ**（auto→explicit などへ**自動昇格させない**）。
  - 再生成テンプレート（`regenerateWithOpenAI` 等）は現状 `source_url`/`source_title` しか引き継がない →
    **`source_provenance`/`source_confidence` も引き継ぐ**よう変更。
- **provenance 欠落＝`unknown`** として扱い、**保留対象**にする（レガシー記事や取りこぼしを事故にしない）。
- **後方互換**：curated マップ・明示 source は挙動不変（matcher は穴埋めのみ・優先度は下）。

### 4.3 ガードレール（選定は緩め／承認・公開・validate は厳格）＋再判定（P1・必須）

**2 段階に分ける**（選定で殺すと何も作れない・§3）:
- **選定（`evaluateTopicFit`→`topic-selector`）は緩め**：source の provenance が auto/fallback でも**生成はさせる**。
- **承認・公開・validate は厳格（provenance ゲート）**：`provenance ∈ {auto, domain-fallback, ultimate, unknown}`
  なら **`needs_source_review`** として**止める**。`{explicit, curated}` かつ URL が期待出典（§4.2）と一致した時だけ通す。

**選定を通すための契約（P1・必須の実装対象追加）**：現行は `topic-selector` が `decision==='approve'` **だけ**通し、
`evaluateTopicFit` は source_alignment が soft／score≤3 だと **`revise`** を返す＝**auto は生成前に除外**される。
- **`scripts/lib/customer-relevance.js`（`evaluateTopicFit`）** と **`scripts/lib/topic-selector.js`（品質ゲート）** を実装対象に追加。
- 契約：**「顧客適合・検索意図は合格（≥4）で、唯一の保留理由が source（needs_source_review／provenance=auto・fallback）」の
  topic だけ、選定を許可**する（例：`decision='approve'` かつ `source_hold=true` を返す、または専用の許可フラグ）。
- **他の revise 理由（顧客不適合 customer_fit≤3・検索意図不足 search_intent≤3 等）は従来どおり除外**（生成対象に戻さない）。
- 生成された記事は provenance=auto/fallback を frontmatter に持つので、下流の承認/公開/validate ゲートで確実に保留される。

#### 既存記事との両立：`source_guard_version`（P1・レガシー移行）
main は記事166件中 **`source_provenance` 0件・published 多数**。provenance 欠落を一律ブロックすると既存が壊れるため、
**`source_guard_version`（整数・現行 v1）** を導入して段階適用する：
- **新規生成・再生成**：`source_guard_version: 1` を**必須**付与。provenance 欠落は**ブロック**（unknown＝保留）。
- **既存 published（version なし＝レガシー）**：**警告のみ**（validate も published は従来どおり通す）。**再判定しない**。
- **未承認・公開予約中（draft/needs_review/approved で version なし）**：**承認・公開を止め**、再生成 or 移行を要求。
→ これで既存 published を壊さず、新規の同型事故だけを止める。`validate.js`／承認・公開ゲートは version の有無で分岐する。

**`checkSourceAlignment` の是正**：現状の「期待==実際==6501 → score 5」を**やめる**。`expectedSourceFor` に
**「curated 由来か」** を持たせ、**curated 個別出典と一致した時だけ aligned=5**。curated でない（auto/fallback/unknown）は
`needs_source_review`（severity 'soft'）を**返せる**ようにする（呼び出し側が段階で使い分ける）。

**承認・公開・生成での再判定（必須変更）**：保存済み `source_alignment_score` を信用せず、**現在の frontmatter
（`source_url`/`source_provenance`/`pain_point`/`tax_domain`）から再判定**する。
- **`netlify/functions/review-approve-background.js`**（承認）：再判定し `needs_source_review`／score≤3 なら **400 でブロック**。
- **`scripts/publish-due.js`**（公開・※パス修正）：公開直前に同じ再判定を行い、該当なら**公開しない**（スキップ＋通知）。
- **`scripts/validate.js`**（生成/CI）：現状 provenance を渡していない。**`source_provenance` を `checkSourceAlignment` に渡し**、
  auto/fallback/unknown を warning ではなく**明示の保留シグナル**として出す（approved/scheduled/published 段階では従来どおり厳格）。
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
  - `scripts/lib/tax-authority-refs.js`：**`resolveSourceForTopic(topic)`** 新設（§3 の優先順・provenance/confidence・
    `rankSources`/`selectSource` を利用）。
  - `scripts/topic-pool.js`（or 呼び出し元）：**`expandAll` 後・`selectDailyTopics` の前**に `resolveSourceForTopic` を一括適用（§4.2）。
  - `scripts/lib/scenario-deep-dive.js`／`scenario-expansion.js`／`scenario-new-segments.js`：早期の url/title 焼き込みをやめる。
  - `scripts/lib/draft-normalizer.js`：frontmatter に `source_provenance`/`source_confidence` を保持（欠落は unknown/0）。
  - `scripts/generate-draft.js`：`ensureSourceOnTopic` を `resolveSourceForTopic` 経由に。**再生成（`regenerateWithOpenAI` 等）で
    既存 `source_provenance`/`source_confidence` を引き継ぐ**（explicit へ自動昇格しない）。
  - `scripts/lib/source-alignment.js`：`expectedSourceFor`（curated/explicit 由来かを返す）／`checkSourceAlignment` を provenance 対応。
  - **`scripts/lib/customer-relevance.js`（`evaluateTopicFit`）**：唯一の保留理由が source の時だけ生成を許可（`source_hold` 契約・§4.3）。
  - **`scripts/lib/topic-selector.js`**：品質ゲートで「source_hold のみの approve」を通す（他の revise は除外のまま）。
  - **`scripts/topic-pool.js`**：既存 `CURATED_TOPICS`(54件) に `source_provenance:'explicit'` を付与（§4.2 移行）。
  - `scripts/lib/draft-normalizer.js`：`source_provenance`/`source_confidence` に加え **`source_guard_version:1`** を付与。
  - `netlify/functions/review-approve-background.js`：**承認時に再判定**（保存 score を信用しない・version なしは §4.3 で分岐）。
  - **`scripts/publish-due.js`**（※`netlify/functions/` ではない）：**公開時に再判定**（保留該当は公開しない）。
  - **`scripts/validate.js`**：`checkSourceAlignment` に **`source_provenance` を渡す**＋**`source_guard_version` で
    レガシー(published) と新規を分岐**（§4.3）。

## 8. テスト計画

- **rankSources / selectSource（分離）**：`rankSources` は**採用可否に関わらず常に**上位候補・score・margin を返す。
  `selectSource` は採用条件（score≥0.45 かつ margin≥0.12）を満たす時だけ結果、他は `null`。`confidence==top1.score`。
- **matcher（既知解）**：`high-value-asset-3year-restriction`→6502、`simplified-tax-business-category`→6509、
  `consumption-tax-judgement`→6501/6505 圏 が妥当な**消費税(shohi)**に当たる（他税目に飛ばない）。
  僅差・曖昧・カテゴリ0件・JSON破損は `selectSource`=`null`（`rankSources` は候補を返す）。
- **title 非依存**：title を空にしても matcher の結果が変わらない（照合は search_intent/primary_question 等）。
- **専用トークナイザ**：日本語2gramを含む・ストップワード除去・`topic-similarity.js` を変更しない。
- **税目フィルタ（1対多）**：`inheritance_tax` は `sozoku/zoyo/hyoka` を対象に含む。未対応 domain は `null`。
- **rankSources のカタログ障害**：`index.json` 欠損/破損時に **`{candidates:[], top1:null, margin:0,
  errorCode:'catalog_unavailable'}`** を返す（例外を投げない）。`selectSource`→`null`、resolver→fallback。
- **選定の source_hold 契約**：**顧客適合≥4・検索意図≥4 で唯一の保留が source** の topic は**選定を通る**（生成される）。
  一方、**顧客不適合（≤3）・検索意図不足（≤3）は除外のまま**（source が良くても生成対象に戻さない）。
- **既存 CURATED は explicit**：静的 `CURATED_TOPICS`(54件) が resolver 通過後も **`explicit`（unknown にならない）**。
- **レガシー両立（`source_guard_version`）**：version なしの **published はエラーにならず警告のみ**。version なしの
  **draft/needs_review/approved は承認・公開できない**。新規生成は **version 1** が付く。
- **解決タイミング**：`resolveSourceForTopic` 適用後に `selectDailyTopics` を通しても、**curated topic が
  "source 未設定"で除外されない**（選定は緩め）。
- **provenance 結合（E2E）**：topic → `resolveSourceForTopic` → `draft-normalizer` の frontmatter に
  `source_provenance`/`source_confidence` が**保持される**（curated/auto/domain-fallback/unknown 各ケース）。
- **再生成で provenance 不変**：**全文・部分・タイトルのみ**いずれの再生成後も `source_provenance` が変わらない
  （auto→explicit に昇格しない・欠落は unknown のまま）。
- **explicit 昇格の禁止**：`source_url` があるだけの記事を resolver に通しても explicit にならない。
- **承認・公開・validate の再判定（必須ケース）**：**`source_alignment_score: 5` を残したまま `source_url` を
  6501／fallback に書き換えた記事**、および **provenance が auto/fallback/unknown の記事**が、
  - `review-approve-background` で **承認できない（400 ブロック）**、
  - `scripts/publish-due.js` で **公開されない（スキップ）**、
  - `scripts/validate.js`（approved/scheduled/published 段階）で **保留/エラー** になることを確認。
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
  **"保留"は「選定除外」ではなく「承認/公開/validate で止める」**（生成はされる・§3）。
- **出典解決は `resolveSourceForTopic(topic)` に一本化**。**実行位置は「scenario 展開後・選定の前」**。
  **完成 topic は非LLMメタが揃った状態で title は任意（空）**＝ **matcher は title 非依存**。
- **URL があるだけで explicit にしない**。**再生成（全文/部分/タイトルのみ）後も provenance を保持**（自動昇格禁止・欠落は unknown）。
- **承認（`review-approve-background.js`）・公開（`scripts/publish-due.js`※パス）・生成/CI（`scripts/validate.js`）の3点で
  現在の frontmatter＋provenance から再判定**（保存 score を信用しない）。
- **matcher API を `rankSources`/`selectSource` に分離**（confidence=top1.score・margin は採用判定用）。
  カタログ障害は `errorCode:'catalog_unavailable'` の fail-closed 返却。
- **選定で auto を通すため `customer-relevance.js`/`topic-selector.js` を実装対象に追加**。
  「唯一の保留理由が source」の時だけ許可（顧客不適合・検索意図不足は除外のまま）。
- **`source_guard_version:1` を導入**：新規/再生成は必須、既存 published は警告のみ、未承認/予約中は version なしを止める。
- **既存 CURATED_TOPICS(54件) を移行時に `explicit` 付与**。explicit は人手指定URLを正本とする信頼済み override。
- **税目フィルタは 1対多**、未対応/欠損/破損は `null`→保留。
- **matcher 専用トークナイザを新設**（`topic-similarity.js` は変更しない）。

**未決（実装時に確定）**
- 採用閾値 `0.45` と 1-2位差 `0.12`、重み `0.6/0.3/0.1` の初期値チューニング（既知解セットで調整）。
- ストップワード一覧の確定。
- `tax_domain → tax_category_code[]` の最終確認（`bookkeeping_expenses`/`withholding` の割当など）。
- 既存記事（公開済み）は**再判定しない**（本仕様は新規生成・再生成のみ対象。既存の source は不変更）。
- **カタログの鮮度**：改正で古くなる → 月次クロール運用（#242 系）に依存。改正直後は curated 優先が安全。
