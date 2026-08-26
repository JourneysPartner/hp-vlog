# 実装指示書: 記事候補を「需要の証拠」ベースにする（段階1）

作成: 2026-08-26（設計・受け入れ確認: Claude ／ 実装: Codex）

## 背景と目的

毎日のブログ記事（mori-zeirishi.net）の一番の目的は HP からの集客である。
しかし現在の記事候補は「業種 × 論点」の機械的な掛け合わせ（約1,600件）で作られており、

- cooldown で787件が全滅する等、在庫が枯渇し始めている
- 「論点が同じで業種が違うだけ」の実質重複を量産している
- 毎日の選定順は**カテゴリのバランスのみ**で決まり、検索需要・季節・問い合わせへの近さを一切見ていない

段階1として、次の3点を実装する。

1. **国税庁 質疑応答事例ベースの候補を日次生成プールに接続する**（「実際に人が質問した論点」= 需要の証拠を持つ候補）
2. **税務カレンダーによる季節ブースト**（需要が立ち上がる時期の論点を前倒しで選ぶ）
3. **選定順を「需要の証拠 × 季節 × 問い合わせ近接度」の複合優先度に変える**（バランスは同点時の並びに格下げ）

## 変更してはいけないもの（厳守）

- **タイトル・本文の生成ルール**（出典本文をプロンプトに添付して書かせる方式、品質ゲート、禁止フレーズ、論点別ルール等）は一切変更しない
- **手動承認の運用**: 自動公開・自動承認を導入しない
- 既存の選定フィルタ（existing-slugs / time-limited / denylist / relevance / quality-fit / topic-identity / cooldown / similarity / AI重複判定）は**新候補にもすべて適用**する。バイパスを作らない
- 既存記事・既存 frontmatter 形式は変更しない（新しい frontmatter 項目を追加しない。需要の証拠は**選定時のみ**使い、記事ファイルには書き込まない)
- 秘密情報（環境変数の値）をログに出さない

## 使うデータ（すべてリポジトリ内に既存）

### A. 質疑応答事例の候補リスト `data/nta-shitsugi-topics-candidate.json`

構造: `{ version, generated_at, scoring_criteria, stats, candidates: [...] }`

candidates は 982件。使うのは **`adopted === true` の 276件のみ**。

各候補の項目（実物例）:

```json
{
  "shitsugi_url": "https://www.nta.go.jp/law/shitsugi/shohi/19/18.htm",
  "shitsugi_title": "土地付建物の仲介手数料の仕入税額控除",
  "tax_category": "消費税",
  "tax_category_code": "shohi",
  "section": "19",
  "id": "18",
  "file_path": "shitsugi/shohi/19/18.json",
  "score": 91,
  "score_breakdown": { "persona_match": 30, "search_need": 20, "freshness": 10,
                        "judgment_ambiguity": 6, "taxanswer_support": 25 },
  "proposed": { "persona": "domestic_ec_seller", "macro": "物販", "article_type": "case_study" },
  "kankei_hourei": "消費税法第30条第2項、…",
  "law_version": "令和7年8月1日現在の法令・通達等",
  "adopted": true,
  "target_segments": ["ec_seller"],
  "article_potential": "high"
}
```

### B. 質疑応答事例の本文 `data/nta-sources/shitsugi/{code}/{section}/{id}.json`

1,550件クロール済み。`data/nta-sources/index.json` の entries に `type: 'shitsugi'` で載っている。
本文の項目: `shokai_yoshi`（照会要旨 = 実際の質問文）, `kaitou_yoshi`（回答要旨）, `body_combined`, `kankei_hourei`, `law_version`, `url`, `title`。

### C. 新規作成するデータ `data/tax-calendar.json`

季節ブーストの定義。**内容は本指示書の付録1のとおりに作成すること**（中身を発明しない）。

## 実装要件

### R1. 質疑応答候補をトピック化する新モジュール `scripts/lib/shitsugi-topics.js`

`expandShitsugiTopics()` を公開し、`adopted === true` の候補を日次生成プールのトピック形式に変換する。

各トピックの組み立て:

| 項目 | 値 |
|---|---|
| slug | `shitsugi-{tax_category_code}-{section}-{id}`（例: `shitsugi-shohi-19-18`）。既存slugと衝突しない一意な形式であること |
| title | 空文字（現行方針: タイトルは本文生成時に LLM が決定する。Pattern C を変えない） |
| macro / persona / article_type | `proposed` の値をそのまま使う |
| category | tax_category から変換: 消費税→`消費税` / 所得税→`所得税` / 譲渡所得→`所得税` / 源泉所得税→`源泉徴収` / 相続税・贈与税→`相続` / 財産の評価→`相続` / 法人税→`法人税` |
| tax_domain | tax_category_code から変換: shohi→`consumption_tax` / shotoku・joto→`income_tax` / gensen→`withholding` / sozoku・hyoka→`inheritance_tax` / hojin→`bookkeeping_expenses`（法人税の tax_domain が既存に無い場合。既存に法人税向け tax_domain があればそちらを使う） |
| cluster / subcluster | cluster: `shitsugi-{tax_category_code}`、subcluster: slug と同じ一意値（cooldown・重複検知が正しく効く単位にする） |
| pain_point | slug と同じ一意値 |
| source_url / source_title | `shitsugi_url` / `shitsugi_title` |
| source_provenance / source_confidence | `explicit` / 1（実在の国税庁ページを人が採用済みのため） |
| search_intent | `shitsugi_title` ＋ tax_category ＋ target_segments から組み立てる（検索されそうな語の並び） |
| reader_problem / primary_question | 本文ファイル（B）の `shokai_yoshi`（照会要旨）から組み立てる。照会要旨は「実際の質問」なのでそのまま要約に使ってよい。本文ファイルが読めない候補は**スキップしてログに残す**（生成を止めない） |
| demand_evidence | `{ kind: 'nta-shitsugi', score, search_need: score_breakdown.search_need, judgment: score_breakdown.judgment_ambiguity }`（**選定時のみ**使用。frontmatter に書かない） |
| pair_group | なし（単発トピック。既存選定は pair_group 無しの main+support 組み合わせを既にサポートしている） |

注意:

- `article_potential: "high"` を優先し、次に score 降順で並べる
- 変換後のトピックが既存の関連性ゲート `isNaturalCombination`（scripts/lib/customer-relevance.js）を**通過することをテストで確認**する。通過しない候補は組み込まず、件数をログに出す（無理に通さない）
- 環境変数 `DISABLE_SHITSUGI_TOPICS=true` で全体を無効化できること（既存の `DISABLE_TAX_TERMS` と同じ流儀）

### R2. `scripts/topic-pool.js` への接続

TOPICS の末尾に `expandShitsugiTopics()` の結果を連結する。読み込み失敗時は空配列で続行（日次生成を止めない）。

### R3. 出典本文の添付を質疑応答事例に対応させる `scripts/lib/nta-source-body.js`

現在は taxanswer の URL（`taxanswer/{cat}/{番号}.htm`）しか本文を読めない。
`law/shitsugi/{cat}/{section}/{id}.htm` 形式の URL でも、`data/nta-sources/shitsugi/...` から本文（`body_combined`、無ければ `shokai_yoshi`＋`kaitou_yoshi` の結合）を読めるようにする。

これにより、質疑応答トピックの記事生成時にも**出典の実文がプロンプトに添付される**（現行の「出典を基に書く」ルールがそのまま効く）。既存の taxanswer の挙動は変えない。

### R4. 税務カレンダー `data/tax-calendar.json` と季節判定 `scripts/lib/tax-calendar.js`

付録1の内容で JSON を作成し、判定モジュールを作る。

公開関数: `seasonBoost(topic, now)` → 0 または 1。
判定: 現在の**日本時間の月**が entry の `boost_months` に含まれ、かつ

- topic.tax_domain が entry の `tax_domains` に含まれる、**または**
- topic の文字列（search_intent / primary_question / reader_problem / title の結合）に entry の `keywords` のどれかが含まれる

なら 1。`DISABLE_SEASON_BOOST=true` で常に 0。

### R5. 選定順を複合優先度に変える `scripts/lib/topic-selector.js`

現在の並び（`scripts/lib/topic-selector.js` 427行付近）:

```js
scored.sort((a, b) => (b.balance || 0) - (a.balance || 0));
```

これを次の複合優先度に変える:

```
demand  = topic.demand_evidence がある ? 1 : 0
season  = seasonBoost(topic, now)                     // 0 or 1
lead    = (scoreLeadValue(topic) - 2) / 3             // 0〜1 に正規化（customer-relevance.js の既存関数を使う）
priority = demand * 3 + season * 2 + lead * 1
並び: priority 降順 → 同点なら balance 降順（現行の並びを同点時の決着に残す）
```

重みの意図: 需要の証拠 ＞ 季節 ＞ 問い合わせ近接度 ＞ カテゴリバランス。

さらに:

- **1日の選定2件のうち、質疑応答由来は最大1件**とする（同一ソースへの偏り防止）。2件とも質疑応答になった場合は、優先度が低い方を非質疑応答の次点と入れ替える（既存の「2本目差し替え」の仕組みに合流させてよい）
- `--dry-run`（選定説明モード）の出力に、各 pick の `priority` の内訳（demand / season / lead / balance）を表示する
- 選定ログに理由を日本語で出す（例: `[select] 需要の証拠あり(nta-shitsugi score=91) + 季節(確定申告) で優先`）

### R6. テスト（新規 `scripts/lib/__tests__/test-demand-driven-selection.js` ほか）

最低限、次を検証すること:

1. **変換の正しさ**: adopted 候補がトピック形式に正しく変換される（slug 一意、explicit 出典、category/tax_domain の変換表どおり、照会要旨から reader_problem が入る）
2. **関連性ゲート通過率**: 276件の変換結果のうち `isNaturalCombination` を通過する件数を出力し、9割以上であること（下回る場合は変換表の見直しが必要 → 実装を止めて報告）
3. **出典本文の添付**: 質疑応答 URL のトピックで `buildSourceBodyBlock` 相当の経路が本文を返す
4. **季節判定**: 付録1の各 entry について、対象月に 1・対象外の月に 0（now を注入してテスト。`new Date()` 直呼びで月依存のテストにしない）
5. **選定順**: 合成トピックで「需要の証拠あり ＞ 季節一致のみ ＞ どちらも無し」の順に選ばれること。同点時は balance 順が保たれること
6. **1日1件の上限**: 質疑応答トピックだけを多数与えても picks に質疑応答は最大1件
7. **無効化フラグ**: `DISABLE_SHITSUGI_TOPICS` / `DISABLE_SEASON_BOOST` が効くこと
8. **既存の全テストが通ること**（`scripts/lib/__tests__/*.js` 全ファイル）、`npm run validate` と `npm run build` が exit 0

### R7. ログと運用

- 日次生成の冒頭で「質疑応答由来の候補: N件（変換スキップ M件）」を出す
- 失敗はすべて「ログを出して従来動作で続行」。新機能の不具合で日次生成が止まることがあってはならない

## 受け入れ確認（Claude が実施）

- 上記テスト・回帰・ビルドの全通過
- `--dry-run` を複数日付で実行し、優先度の内訳が妥当か目視確認
- 変換後トピックのサンプルを抜き取り、出典・照会要旨の対応関係を確認

## 付録1: `data/tax-calendar.json` の内容（このとおり作成）

boost_months は需要ピークの約1か月前から当月まで（記事は公開後に検索に載るまで時間がかかるため前倒し）。

```json
{
  "note": "季節ブーストの定義。月は日本時間。boost_months は需要ピークの約1か月前〜当月。",
  "entries": [
    {
      "id": "kakutei-shinkoku",
      "label": "確定申告",
      "boost_months": [1, 2, 3],
      "tax_domains": ["income_tax", "bookkeeping_expenses"],
      "keywords": ["確定申告", "青色申告", "収支内訳書", "決算書", "医療費控除", "ふるさと納税"]
    },
    {
      "id": "shohizei-kojin-shinkoku",
      "label": "個人事業者の消費税申告",
      "boost_months": [1, 2, 3],
      "tax_domains": ["consumption_tax", "invoice_system"],
      "keywords": ["消費税の申告", "簡易課税", "2割特例", "インボイス"]
    },
    {
      "id": "nenmatsu-chosei",
      "label": "年末調整",
      "boost_months": [10, 11, 12],
      "tax_domains": ["withholding"],
      "keywords": ["年末調整", "扶養控除", "保険料控除", "源泉徴収票"]
    },
    {
      "id": "zoyo-kakekomi",
      "label": "贈与の年内実行",
      "boost_months": [9, 10, 11, 12],
      "tax_domains": ["inheritance_tax"],
      "keywords": ["贈与", "暦年課税", "相続時精算課税", "教育資金", "住宅取得等資金"]
    },
    {
      "id": "shokyaku-shisan-chosho",
      "label": "償却資産申告・法定調書",
      "boost_months": [12, 1],
      "tax_domains": ["bookkeeping_expenses", "withholding"],
      "keywords": ["償却資産", "法定調書", "支払調書", "給与支払報告書"]
    },
    {
      "id": "kessan-3gatsu",
      "label": "3月決算法人の申告",
      "boost_months": [3, 4, 5],
      "tax_domains": ["bookkeeping_expenses"],
      "keywords": ["決算", "法人税の申告", "役員報酬", "決算賞与", "少額減価償却"]
    },
    {
      "id": "yotei-nozei",
      "label": "予定納税",
      "boost_months": [6, 7, 11],
      "tax_domains": ["income_tax"],
      "keywords": ["予定納税", "減額申請"]
    },
    {
      "id": "gensen-noki-tokurei",
      "label": "源泉所得税の納期の特例",
      "boost_months": [6, 7, 12, 1],
      "tax_domains": ["withholding"],
      "keywords": ["納期の特例", "源泉所得税の納付"]
    }
  ]
}
```

## 参考: 現在のコードの入口

| 場所 | 何があるか |
|---|---|
| `scripts/topic-pool.js` | TOPICS の組み立て（curated ＋ scenario-expansion の展開結果） |
| `scripts/lib/topic-selector.js` | 日次選定。フィルタ群と並び（427行付近の sort が R5 の対象） |
| `scripts/lib/customer-relevance.js` | `isNaturalCombination` / `scoreLeadValue` / `evaluateTopicFit` |
| `scripts/lib/nta-source-body.js` | 出典本文のプロンプト添付（R3 の対象） |
| `scripts/generate-draft.js` | 日次生成の本体。`--dry-run` の説明モードは 2160行付近 |
| `scripts/lib/scenario-expansion.js` | 既存の掛け算プール（変更しない。在庫として残す） |
