# 台帳 C-16 — ①の国民健康保険料の概算を、前年度の料率で計算して結果に明記する

根拠: 台帳 `docs/tax-simulator/deferred-items.md` の C-16、仕様書 `docs/tax-simulator/tax-simulator-spec-reviewed-final.md` §5・§7・§9、画面仕様 `docs/tax-simulator/hojinnari-ui-spec.md`。

## 背景

①法人成りの国保の概算は、所得年の翌年度の料率を使う（`src/simulators/hojinnari/service.js` の `fiscalYear = incomeYearFrom(context) + 1`）。2026 年の所得には令和9年度の料率が要るが、登録は令和8年度まで（`nhi-municipal-rates.json`）で、各自治体の公表は例年 4〜6 月。今は `NHI_MUNICIPAL_RATE_NOT_REGISTERED` で止まる。このまま計算年を 2026 年にすると、①で「選んだ自治体の料率で概算する」を選ぶ人は全員止まる。

**決定（利用者 2026-11-01）: 令和8年度の料率で概算し、その旨を結果に明記する。**

計算年は変えない（`SUPPORTED_YEAR = 2025` のまま）。2025 年の計算は令和8年度の料率がそのまま当たるので、代用は起きない。公開中の金額・状態・警告はひとつも変わらない。

## 決めたこと（Claude の設計判断。変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | エンジンの既定は今のまま止まる。`allowPriorFiscalYearRate: true`（厳密に `true`）を渡したときだけ代用する。渡すのは①のサービスだけ | 別の呼び出し元が増えたときに、黙って前年度の料率を使わないため（止まる側に倒す） |
| D2 | 代用するのは、その自治体の対象年度の記録が **0 件** で、**ちょうど 1 年度前** の記録があるときだけ。2 年度以上は遡らない。前年度も 0 件なら今の `NHI_MUNICIPAL_RATE_NOT_REGISTERED` で止める | 登録外の自治体が通ってはいけない。古い料率を重ねて使わない |
| D3 | 区分の欠け（1〜3 件）は今までどおり例外。代用しない | 登録の誤りを隠さない |
| D4 | 代用するのは自治体の記録だけ。国共通の基礎控除・軽減判定は賦課年度（2027-04-01）で引く | 国の規則は賦課年度のものが正しい。今は終わりの無い記録なので値は令和8年度と同じ |
| D5 | 賦課限度額は自治体の記録の `cap_amount` なので、一緒に令和8年度の値になる。文言にも書く | 上限の年度も利用者に分かるようにする |
| D6 | 代用した結果は `complete` を返さない。サービスの本体で `partial` にする | 仕様書 §7（未確定があれば `complete` にしない）。2026-12-01 以後に `enacted`→`effective` で施行前の注記が消えても、この `partial` は残す |
| D7 | 明記は 3 か所。警告 `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED`、前提（`assumptions`）、結果画面の見出しの直後の注記 | 利用者の指示「その旨を結果に明記する」。警告の一覧は画面の下のほうにあるので、金額より上にも出す。結果画面の `hojinnari-print` の中なので印刷にも載る |
| D8 | 実額入力では代用が起きないので、注記も付けない | 実額は料率を使わない |
| D9 | 令和9年度の料率を登録すれば、コードを直さなくてもその自治体の代用は自動で止まる | 自治体ごとに判定するので、登録の途中でも正しく動く |
| D10 | 文言は下の R1 のとおり。「国民健康保険料を概算」という語を入れない | `result-view-model.js` の `calculationRange` が `text.includes('国民健康保険料を概算')` で分類している。文言で分類が動かないようにする |

## R1. `src/tax-engine/social-insurance/nhi-premium.js`

1. `readInput` の戻り値に `allowPriorFiscalYearRate: input.allowPriorFiscalYearRate === true` を足す。
2. `calculateNhiPremium` の冒頭の自治体の記録の引き方を、内部の関数 `municipalRateRecords(taxYear, municipalityCode)` にまとめる（`onDate` の作り方・絞り込み・並べ替えは今と同じ）。国の規則用の `criterion` は今のまま賦課年度で残す。
3. 次のようにする。

   ```js
   let rateFiscalYear = values.taxYear;
   let municipalRecords = municipalRateRecords(rateFiscalYear, values.municipalityCode);
   if (municipalRecords.length === 0 && values.allowPriorFiscalYearRate) {
     rateFiscalYear = values.taxYear - 1;
     municipalRecords = municipalRateRecords(rateFiscalYear, values.municipalityCode);
   }
   ```

4. 記録が 0 件のときの `blocked`（コード・文・`taxYear: values.taxYear`）と、4 件でないときの例外は**変えない**。
5. `complete` の戻り値に `rateFiscalYear` を足す。`taxYear` は賦課年度のまま。
6. `rateFiscalYear !== values.taxYear` のときだけ、`notes` の**先頭**に次の注記を足す。年度の文字は内部の関数 `fiscalYearLabel(year)`（`令和${year - 2018}年度`）で作る。

   ```js
   {
     code: 'NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED',
     message: `国民健康保険料は、${levy}の料率がまだ登録されていないため、${rate}の料率（所得割率・均等割額・平等割額・賦課限度額）で計算した概算です。軽減判定の所得基準も${levy}の改定を反映していない場合があり、${levy}の実際の保険料とは異なることがあります。`,
   }
   ```

   2027 年度なら本文はこのとおりになる: 「国民健康保険料は、令和9年度の料率がまだ登録されていないため、令和8年度の料率（所得割率・均等割額・平等割額・賦課限度額）で計算した概算です。軽減判定の所得基準も令和9年度の改定を反映していない場合があり、令和9年度の実際の保険料とは異なることがあります。」

## R2. `src/simulators/core/result-builder.js`

`WARNING_MAP` の `NHI_SELECTED_MUNICIPALITY_ESTIMATE` の次に足す。

| コード | level | canContinue | userAction |
| --- | --- | --- | --- |
| `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` | `attention` | `true` | `対象自治体の最新の料率を確認し、実額が分かる場合は実額を入力してください` |

## R3. `src/simulators/hojinnari/service.js`

1. `calculateNationalHealthInsurance` の `socialInsurance.calculateNhiPremium` の呼び出しに `allowPriorFiscalYearRate: true` を足す。注記は `result.notes` を通して、平年度・移行年度の両方の `warnings` と `assumptions` に載る（今のコードのまま）。
2. 内部の関数 `usesPriorFiscalYearNhiRate(...calculations)` を足す。各 `calculation.warnings` に `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` があれば `true`。
3. `calculate` と `calculateTransitionYear` の `isPartial` に、`usesPriorFiscalYearNhiRate(soleProprietor, corporation)` を「または」で足す。

## R4. 画面

1. `src/ui/hojinnari/result-view-model.js`: `buildResultViewModel` の戻り値に `nhiPriorRateNotice` を足す。警告 `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` の `basis`、無ければ `undefined`。`blocked` の表示用データには足さない。
2. `src/ui/hojinnari/app.js` の `renderResult`: `pendingLawNotice` の行の直後に足す。class は `hojinnari-pending-law-notice hojinnari-nhi-prior-rate-notice` の 2 つ（見た目は施行前の注記と同じ。試験は後ろの class で探す）。CSS は足さない。
3. `src/ui/hojinnari/app.js` の入力画面の説明（今は `自治体の登録年度料率による概算です。`）を次に変える。仕様書 §5 の「推定値はユーザーが明示選択する」のため、選ぶ時点でも分かるようにする。

   `自治体の登録年度料率による概算です。対象年度の料率が未登録のときは前年度の料率で計算し、結果に明記します。`

## R5. 試験

金額は手計算で固定する。渋谷区（13113）・所得 500 万円・45 歳・単身（令和8年度の料率）の検算:

| 区分 | 賦課基礎 457 万円 × 所得割率 | 均等割 | 合計 |
| --- | --- | --- | --- |
| 医療分 | 343,207（751/10000） | 47,600 | 390,807 |
| 支援金分 | 127,960（280/10000） | 17,600 | 145,560 |
| 子ども分 | 12,339（27/10000） | 1,873 | 14,212 |
| 介護分 | 111,051（243/10000） | 17,800 | 128,851 |
| 計 | | | **679,430** |

### `scripts/lib/__tests__/test-small-engines.js`

1. 指定なしで `taxYear: 2027` は `blocked`（`NHI_MUNICIPAL_RATE_NOT_REGISTERED`）。
2. `allowPriorFiscalYearRate: 'yes'` や `1` でも `blocked`（厳密に `true` だけ）。
3. `allowPriorFiscalYearRate: true`・`taxYear: 2027` は `complete`。`taxYear` 2027・`rateFiscalYear` 2026。上の検算どおり 4 区分と合計 679,430 円。`notes` の先頭が上の本文と完全に一致する。
4. 指定ありで `taxYear: 2026` は注記なし・`rateFiscalYear` 2026・金額は指定なしと同じ。
5. 指定ありで `taxYear: 2028`（2 年度前は遡らない）・`2025`（前年度の記録も無い）・`municipalityCode: '99999'`（`taxYear: 2027`）は、どれも `blocked`。
6. 代用時の軽減の判定が今と同じ（所得 43 万円・`taxYear: 2027`・指定ありで 7割軽減、医療分の均等割の残りが 14,280 円）。

### `scripts/lib/__tests__/test-hojinnari-service.js`

末尾の `R9-10` の中の「翌年度の料率不足で停止」の試験を、この決定に合わせて書き換える（消すのではなく、決定どおりの期待に変える。上のコメントも直す）。

7. 平年度・移行年度の 2026 年の概算は `partial`。警告 `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` がちょうど 1 件で、`level: 'attention'`・`canContinue: true`、本文が R1 と完全に一致する。`assumptions` にも同じ文が 1 回だけある。`breakdown` がある。
8. 2026 年の平年度の国保の金額が、同じ入力の 2025 年の平年度の金額と一致する（どちらも令和8年度の料率で所得が同じ）。
9. 登録の 6 自治体（13113・14100・23100・27100・40130・01100）すべてで、2026 年の概算が止まらず、`usedMasterRecords` にその自治体の 4 件の記録（`NHI-RATE-<コード>-*`）が載る。都道府県コードは `context` に合わせて渡す。
10. 2026 年でも `municipalityCode: '99999'` の概算は `blocked`（`HJ_NHI_NHI_MUNICIPAL_RATE_NOT_REGISTERED`）で `breakdown` なし。
11. 2026 年の実額入力には警告も前提の文も付かない。
12. 2025 年の概算には警告も前提の文も付かず、`complete` のまま（今の試験の金額は変えない）。
13. D6 の確認: 施行前の注記が無くても `partial` になること。`buildSimulationResult` に渡る `resultStatus` が `partial` であることを、require のキャッシュで `result-builder.js` を差し替えて確かめる方法でよい（平年度・移行年度の両方。実額入力は `complete` のままであることも確かめる）。

### `scripts/lib/__tests__/test-hojinnari-ui.js`

14. 警告を含む結果を渡すと `nhiPriorRateNotice` に本文が入り、`.hojinnari-nhi-prior-rate-notice` が見出し（`h1`）の後で判定サマリーより前に描かれる。施行前の注記があるときはその次。
15. 警告が無い結果では `undefined`・描かれない。`blocked` でも描かれない。
16. 入力画面で「選んだ自治体の料率で概算する」を選ぶと、R4 の 3 の文が出る。
17. `calculationRange` の分類が変わらない（2026 年の結果で国保が `estimates` に入る）。

## 変えてはいけないもの

- マスターの JSON（`nhi-municipal-rates.json`・`national-health-insurance.json` の注記も含む）。スナップショットが変わるため。
- `SUPPORTED_YEAR`・`src/simulators/core/versions.js`・公開用のまとめファイル（`assets/js/tax-simulator.*.js`・`tax-simulator-manifest.json`・`tax-simulator-boot.js`）。
- `NHI_MUNICIPAL_RATE_NOT_REGISTERED` の文、`question-catalog.js`。
- ②③④のコード。国保のエンジンを呼ぶのは①だけ。
- 文書（台帳・README・仕様書）。Claude が直す。

## 確かめること

1. `node scripts/lib/__tests__/test-small-engines.js`
2. `node scripts/lib/__tests__/test-hojinnari-service.js`
3. `node scripts/lib/__tests__/test-hojinnari-ui.js`
4. `npm run masters:validate`
5. `git status` で指示書に無いファイルが変わっていないこと。`assets/` が試験で書き換わったら元に戻す（`git show HEAD:<file> > <file>`、新しくできたまとめファイルは消す）。

`npm run masters:test` は Claude が隔離の外で流す。

## レビュー後の修正（Opus 5.5 xhigh レビュー 2026-11-01）

上の R1 の本文はこの修正を反映済み。Critical・High は 0 件。

### F1. 注記に比較への影響を足す（Medium 3。仕様書 §5 の結論逆転条件）

`src/simulators/hojinnari/service.js` に定数を足す。

```js
const NHI_PRIOR_RATE_COMPARISON_NOTE = '料率や賦課限度額が上がると、通常は個人事業の手取りが減り、比較は法人化に有利な方向へ動きます。';
```

`calculateNationalHealthInsurance` で、`calculateNhiPremium` の結果の `notes` のうち `NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` の `message` の末尾にこの文を足した配列を作り、`assumptions` と `warnings` はその配列から作る。平年度・移行年度の両方に効かせる。注記のコードは変えない。エンジンの本文には足さない（比較はサービスの話なので）。

### F2. 試験の期待文を直す

- `test-small-engines.js`: R1 の本文に合わせる。
- `test-hojinnari-service.js`・`test-hojinnari-ui.js`: R1 の本文＋F1 の文に合わせる。完全一致で確かめる。警告・前提が 1 回だけなのも今のまま確かめる。

### F3. 自治体の取り違えを検出する（Medium 5）

使用記録は自治体で絞る前に載るので、`NHI-RATE-<コード>-*` の確認は必ず通る。金額で確かめる。

`test-small-engines.js` に、`taxYear: 2027`・`allowPriorFiscalYearRate: true`・所得 500 万円・45 歳・単身の手計算を足す。

| コード | 医療分 | 支援金分 | 子ども分 | 介護分 | 計 |
| --- | --- | --- | --- | --- | --- |
| 13113 | 390,807 | 145,560 | 14,212 | 128,851 | 679,430 |
| 14100 | 421,551 | 133,114 | 17,308 | 145,988 | 717,961 |
| 23100 | 454,122 | 133,690 | 13,653 | 123,058 | 724,523 |
| 27100 | 503,048 | 161,878 | 14,541 | 137,502 | 816,969 |
| 40130 | 293,477 | 163,777 | 14,746 | 137,188 | 609,188 |
| 01100 | 446,567 | 133,332 | 15,353 | 120,051 | 715,303 |

`test-hojinnari-service.js` の 6 自治体の試験は、所得 500 万円（売上と経費を調整。青色 65 万円を引いた後）・45 歳で国保の金額が上の「計」と一致することを確かめる形に直す。

### F4. 必ず真の条件を消す（Low 7）

「施行前注記がなくてもビルダーへpartialを渡す」の中の、施行前の警告が無いという条件を消す。その警告は差し替えた `result-builder.js` の中でしか作られない。`partial` の確認は残す。

### F5. 移行年度の金額と分類を固定する（Low 8）

`transitionInput()` を 2026 年にした入力（渋谷区・45 歳・個人期間の売上 900 万円・経費 300 万円・青色 65 万円・7 月 1 日設立）の手計算を足す。

- 賦課基礎 492 万円: 医療分 417,092・支援金分 155,360・子ども分 15,157・介護分 137,356、年額 724,965 円。6 か月分は 362,482 円（円未満切り捨て）。
- 個人のままの側は 1,130,000 円（賦課限度額 67 万・26 万・3 万・17 万の合計）。

`test-hojinnari-ui.js` に、代用した移行年度の実際の結果で `calculationRange` の国保が `estimates` に入る試験を足す。

### F6. 登録の途中の状態（Low 9）

「2027年度料率を登録すれば自動で前年度代用を止める」の試験で、差し替えの中で 14100 も計算し、14100 は代用と注記が続くことを確かめる。
