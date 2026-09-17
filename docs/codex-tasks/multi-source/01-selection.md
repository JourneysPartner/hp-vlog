# 01 — 論点ごとの出典選定と frontmatter への記録

## A. 論点ごとに出典を選ぶ（新規ライブラリ）

新しく `scripts/lib/topic-sources.js` を作る。LLM 呼び出しは注入して受け取り、テストできる形にする（`llm-source-selector.js` と同じ流儀）。

### A-1. 論点1つに絞ったトピックを作る

`resolveSourceWithLLM` に渡すトピックを、論点1語に絞った形に加工する関数を書く。

絞る理由は、候補の並べ替え（`nta-source-matcher.js` の `rankSources`）が次の項目を**連結した文字列**で類似度を測っているため。記事全体の語をそのまま渡すと、肝心の論点語が薄まる。

```js
// scripts/lib/nta-source-matcher.js:57
const TOPIC_TEXT_FIELDS = [
  'search_intent', 'primary_question', 'reader_problem', 'topic', 'pain_point', 'subcluster',
  'tax_terms',
];
```

作る関数:

```js
/**
 * 論点1語に絞ったトピックを作る。
 * 記事全体の語（検索意図・読者の悩み）は1論点の問いを薄めるので落とす。
 * 税目と顧客カテゴリは候補プールの決定に要るので残す。
 */
function narrowTopicToTerm(topic, term) {
  return {
    ...topic,
    tax_terms: term,
    pain_point: term,      // rankSources の painKeywords / topicText が見る
    title: term,           // llm-source-selector の topicSummary が Luna に見せる要約
    search_intent: '',
    reader_problem: '',
    primary_question: '',
    subcluster: '',        // slug 由来で分解すると雑音にしかならない
  };
}
```

**`topic` 自体は書き換えないこと。** 返り値は選定のためだけに使う一時オブジェクトで、記事の frontmatter には元の `topic` の値が入る。

### A-2. 論点ごとに選定して結果をまとめる

```js
/**
 * 論点語ごとに出典を選ぶ。
 * @param {Object} topic
 * @param {string[]} terms 論点語（tax-terms.js の返り値。最大4語）
 * @param {Function} resolveSource (narrowedTopic) => Promise<picked|null>
 * @returns {Promise<Array>} [{ term, url, title, no, confidence, tier, reason }]
 */
async function selectSourcesPerTerm(topic, terms, resolveSource) { ... }
```

守ること:

- **1論点でも失敗したら全体を止める、ということはしない。** 失敗した論点は結果から落として続ける（`resolveSource` が `null` を返す場合も同じ）
- **URL が重複したら、確信度が高いほうだけ残す。** 別々の論点が同じページに当たることは普通にある
- 結果は**確信度の降順**に並べて返す
- 例外は握り潰して `console.warn` に出す。生成そのものは止めない（`enrichSourceWithLLM` の既存の作りに合わせる）

### A-3. 正本を決める

```js
/**
 * 論点ごとの結果から、frontmatter の正本（source_url）と補助出典を分ける。
 * @returns {{ primary: Object|null, supplements: Array }}
 */
function splitPrimaryAndSupplements(results) { ... }
```

- `primary` = 確信度が最も高いもの。同点なら `terms` の順（論点語は LLM が重要な順に返す）
- `supplements` = 残り。**最大3件**（frontmatter の連番キーが `source_2` 〜 `source_4` の3枠のため）

## B. 日次生成に組み込む

`scripts/generate-draft.js` の `enrichSourceWithLLM`（55行目）を書き換える。

### B-1. 分岐

```
論点語（topic.tax_terms）がある  → 論点ごとに選定する（新しい経路）
論点語が無い / 空               → 今までどおり1回だけ選定する（既存の経路をそのまま）
```

論点語は `enrichTaxTerms`（84行目）が `topic.tax_terms` に**空白区切りの文字列**として入れている。`split(/\s+/)` で配列に戻して使う。

```js
// generate-draft.js:90
topic.tax_terms = terms.join(' ');
```

**呼び出し順に注意。** `enrichTaxTerms` が `enrichSourceWithLLM` より先に走っていることを確認してから書くこと。順序が逆だと論点語が空のままになり、常に既存の経路に落ちる。

### B-2. 既存のガード条件は変えない

`enrichSourceWithLLM` の冒頭にある3つの早期 return は**そのまま残す**。

```js
if (process.env.ENABLE_LLM_SOURCE_SELECT !== 'true') return;
if (!process.env.OPENAI_API_KEY) return;
if (!LLM_SOURCE_WEAK_PROVENANCE.has(topic.source_provenance)) return;
```

### B-3. `resolveSourceWithLLM` の中身は変えない

閾値（`DEFAULT_MIN_CONFIDENCE = 0.5`）も Tier A→B→C→D の打ち切り条件も**現状のまま**。今回やるのは「この関数を論点ごとに呼び分ける」ことだけ。関数の中には一切触らない。

### B-4. トピックに書き戻す

```js
topic.source_url        = primary.url;
topic.source_title      = primary.title;
topic.source_provenance = 'llm-auto';
topic.source_confidence = primary.confidence;
topic.source_term       = primary.term;          // 新規
topic.source_supplements = supplements;          // 新規（配列のまま持つ）
```

ログは既存の書式に合わせて、論点ごとに1行出す。

```
[source] 論点別選定: 不動産の贈与税評価額 → No.4602 conf=0.95 (A)
[source] 論点別選定: 相続時精算課税 → No.4103 conf=0.97 (A)
[source] 論点別選定: 暦年課税 → No.4408 conf=0.96 (A)
[source] 論点別選定: 登録免許税 → No.7191 conf=0.93 (B)
[source] 正本: No.4103 conf=0.97「相続時精算課税」/ 補助3件
```

## C. frontmatter に書く

`scripts/lib/draft-normalizer.js` の `buildCanonicalFrontmatter`（187行目）を変える。

### C-1. 連番の平坦キーで書く

**ネストした YAML リストは使えない。** 理由は `README.md` の「決まっている設計判断 1」を読むこと。

`source_guard_version: 1` の直後に差し込む:

```yaml
source_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm"
source_title: "相続時精算課税の選択"
source_provenance: "llm-auto"
source_confidence: 0.97
source_term: "相続時精算課税"
source_guard_version: 1
source_2_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4602.htm"
source_2_title: "土地家屋の評価"
source_2_term: "不動産の贈与税評価額"
source_2_confidence: 0.95
source_3_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm"
source_3_title: "贈与税の計算と税率（暦年課税）"
source_3_term: "暦年課税"
source_3_confidence: 0.96
```

守ること:

- **1キー1行。** 値は必ずダブルクォートで囲む（確信度だけは数値でクォート無し。既存の `source_confidence` に合わせる）
- **使わない枠は行ごと出さない。** 論点が2つなら `source_3_*` / `source_4_*` は書かない。空文字の枠を3組ぶん常に出すと、論点1つの記事で12行の無意味な行が増える
- **`source_term` は正本がどの論点に対応するかを示す。** 論点語が無い経路（既存）では空文字 `""` を書く
- 値に含まれる `"` は既存の `escFm` でエスケープする

### C-2. 既存記事を変えない

連番キーが無い記事（既存265本）は今までと同じに読める必要がある。**マイグレーションはしない。** 既存記事の `.md` には一切触れないこと。

## D. 差し戻し再生成で消えないようにする

`scripts/lib/source-guard.js` の2つの配列に新しいキーを足す。

### D-1. `GUARDED_SOURCE_FIELDS`（7行目）

出典の同一性を表す項目。LLM が再生成で書き換えてはいけないもの。

```js
const GUARDED_SOURCE_FIELDS = Object.freeze([
  'source_url', 'source_title', 'source_provenance', 'source_confidence',
  'source_guard_version', 'pain_point', 'tax_domain',
  // ここに source_term / source_2_* 〜 source_4_* を足す
]);
```

### D-2. `SYSTEM_MANAGED_FIELDS`（148行目）

再生成で欠け落ちたら元記事から補う項目。ここにも足す。

### D-3. `restoreSourceGuardFields`（188行目）

`updates` オブジェクトに新キーを足す。ただし**元記事に無かったキーを空文字で作らないこと。** 既存265本を再生成したときに `source_2_url: ""` のような空行が生える。元に無ければ何も書かない。

### D-4. 復元は行単位である前提を壊さない

`restoreMissingSystemFields`（163行目）は**1行を正規表現で抜き出して末尾に足し直す**実装になっている。

```js
const line = (beforeFm.match(new RegExp('^' + key + ':.*$', 'm')) || [])[0];
```

連番キーはすべて1行なのでこのままで動く。**この関数を複数行対応に書き換える必要は無い。** 書き換えないこと。

## E. 生成プロンプトに補助出典を渡す

`generate-draft.js` の 953〜962行目で、出典が未確定だと本文に根拠を書かせない指示が入る。

```js
const sourceUnconfirmed = isSourceUnconfirmed(topic);
```

補助出典がある場合は、それらの**タイトルと番号も**プロンプトの出典欄に載せる。本文が `No.XXXX` の形で引けば `citation-linker.js` がビルド時にリンク化する（既存の仕組み。ここは変更不要）。

正本が未確定（`sourceUnconfirmed === true`）のときの扱いは**今までと同じ**にすること。補助出典があるからといって、未確定の正本を根拠として書かせる方向に緩めない。
