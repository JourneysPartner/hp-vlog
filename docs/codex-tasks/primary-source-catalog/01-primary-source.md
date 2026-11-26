# 段 1: 正本の選び方・ログ・通知の文面

## 変えてよいファイル

- `scripts/lib/topic-sources.js`
- `scripts/generate-draft.js`（`enrichSourceWithLLM` のログ 1 行だけ）
- `netlify/functions/lib/notify/message.js`（`source_blocked` の最後の 1 文だけ）
- `scripts/lib/__tests__/test-topic-sources.js`
- `scripts/lib/__tests__/test-notify-message.js`（文面の試験を足す場合だけ）

これ以外は変えない。特に `scripts/lib/source-alignment.js`・`scripts/lib/source-guard.js`・`data/`・`content/` は触らない。

## R1. `splitPrimaryAndSupplements(results, options = {})`

1. 今までと同じく、確信度の高い順（同点は入力順）に並べる。
2. 正本の資格の判定 `isEligiblePrimary(item)`:
   - `options.isEligiblePrimary` が関数ならそれを使う（試験用）。
   - 無ければ既定として、`require('./source-alignment').evaluateLlmAutoSource({ source_url: item.url, source_confidence: item.confidence }).ok` を使う。
   - 判定が例外を投げたら、その候補は資格なし（false）として扱う。生成は止めない。
3. 並べた順で最初に資格のある候補を正本にする。
4. 資格のある候補が 1 つも無ければ、並べた先頭（最高確信度）を正本にする（今までの動き）。
5. 補助出典は、並べた順から正本を除いたものの先頭 3 件。並び順は確信度順のまま。
6. 戻り値の形は今までどおり `{ primary, supplements }`。空配列・配列でない入力は `{ primary: null, supplements: [] }`。
7. `source-alignment.js` を読み込むのは関数の中（遅延 require）にする。読み込みで循環しないことを確かめる（`source-alignment.js` は `tax-authority-refs`・`law-sources` を読む。`topic-sources.js` は読まれていない）。

関数の上のコメント（JSDoc）に、なぜ資格を見るか（#806、カタログ外の段 D が正本になると承認で必ず止まる）を 2〜3 行で書く。

## R2. ログ（`scripts/generate-draft.js` の `enrichSourceWithLLM`）

正本が最高確信度の候補と違うとき（R1 の 3 で先頭を飛ばしたとき）だけ、今の `[source] 正本: …` の行の前に 1 行出す:

```
[source] 正本: カタログ外または確信度不足の No.<先頭の no>「<先頭の term>」を補助に回した
```

判定のために `splitPrimaryAndSupplements` の戻り値へ `skipped`（飛ばした候補の配列。飛ばしていなければ空配列）を足してよい。足すなら試験でも確かめる。

## R3. 通知の文面（`message.js` の `source_blocked`）

最後の 1 文

```
レビュー画面から出典を修正した上で、再度「そのまま公開」を押してください。
```

を次に変える:

```
レビュー画面では出典を変更できません。下書きの PR で出典の欄を直してから（担当者に依頼してください）、再度「そのまま公開」を押してください。
```

件名・他の行・他の種類の通知は変えない。

## 試験（`test-topic-sources.js` に Test 4 以降として足す）

既存の Test 1〜3 は変えずに通ること（URL の無い候補は資格なしになり、今までの動きに戻る）。

1. **11/23 の再現（実カタログ）**: 次の 4 件を `splitPrimaryAndSupplements` に渡す（`options` なし＝本物の判定）。
   - `{ term: '延滞税', no: '9205', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/osirase/9205.htm', confidence: 1 }`
   - `{ term: '法定調書', no: 'N/A', url: 'https://www.nta.go.jp/publication/pamph/hotei/tebiki2024/index.htm', confidence: 0.99 }`
   - `{ term: '無申告加算税', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.93 }`
   - `{ term: '重加算税', no: '2026', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2026.htm', confidence: 0.68 }`
   - 正本が No.2024、補助が 9205・N/A・2026 の順（確信度順）で 3 件。
   - その正本・補助で frontmatter 相当の meta（`source_provenance: 'llm-auto'`・`source_guard_version: 1`・`review_status: 'draft'`・`tax_domain: 'income_tax'`・`source_2_*`〜`source_4_*`）を作り、`evaluateSourceGuard(meta, { stage: 'approve' })` が `blocked === false` になる。
   - 比較として、正本を No.9205 にした meta では `blocked === true` のまま（ガードの判定を変えていないことの確認）。
2. **資格のある候補が無い**: `isEligiblePrimary: () => false` で、最高確信度が正本になる（今までの動き）。
3. **資格はあるが確信度 0.9 未満**: 本物の判定で、カタログ収録の No.2024 を確信度 0.85、カタログ外の No.9205 を 1 で渡すと、資格のある候補が無いので No.9205 が正本になる。
4. **同点**: 資格のある 2 件が同点なら入力順の先が正本。
5. **判定が例外**: `isEligiblePrimary` が例外を投げる候補は飛ばされ、次の資格のある候補が正本になる。全部が例外なら最高確信度が正本。
6. **補助の件数**: 候補 6 件で、正本が 3 番目に来ても補助は 3 件で、正本を含まない。
7. R2 で `skipped` を足した場合は、その中身。
8. R3 の文面を `test-notify-message.js` で確かめる（新しい文が入り、古い「レビュー画面から出典を修正」が無い）。

## 実行する試験（すべて `sbx` で）

```
node scripts/lib/__tests__/test-topic-sources.js
node scripts/lib/__tests__/test-notify-message.js
node scripts/lib/__tests__/test-multi-source-guard.js
node scripts/lib/__tests__/test-multi-source-frontmatter.js
node scripts/lib/__tests__/test-llm-auto-trust.js
node scripts/lib/__tests__/test-source-alignment.js
node --check scripts/generate-draft.js
```

## 変えてはいけないもの

- 出典ガードの判定（`source-alignment.js`・`source-guard.js`）と、その閾値 `LLM_AUTO_MIN_CONFIDENCE`。
- 段 A〜D の選定（`llm-source-selector.js`）と `selectSourcesPerTerm`。
- 補助出典の上限 3 件。
- 既存記事（`content/`）・データ（`data/`）。
