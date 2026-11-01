# 台帳 C-18 — ②の画面で、経過措置の割合が変わる日の前後に分けてインボイスなしの仕入れを入力する

根拠: 台帳 C-18、平成28年法律第15号 附則52条・53条、`src/tax-engine/consumption/consumption-tax.js` の `invoiceTransitionRecord`。

## 背景

エンジンは、取引日が無いインボイスなしの仕入れを、課税期間の初日と末日の割合が同じときだけ計算する。計算年を 2026 年にすると、課税期間（2026-01-01〜2026-12-31）が割合の変更日 2026-10-01 をまたぐので、そうした仕入れがある人の一般課税は `CT_INVOICE_PERIOD_SPLIT_REQUIRED` で止まる。②の画面は取引日を送らず、分ける入力も無い。

エンジンは `transactionDate` を持つ行を 1 行ずつ計算できる。画面と入力の組み立てだけを直す。計算年は変えない（`SUPPORTED_YEAR = 2025` のまま）。2025 年の画面も入力も変わらない。

## 決めたこと（Claude の設計判断。変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | 取引ごとの日付ではなく、変更日の前後の 2 欄に分ける | ①〜④の画面は年間の合計で入力する作り。割合は変更日の前後で決まるので 2 欄で足りる |
| D2 | 課税期間が変更日をまたぐときだけ 2 欄にする。またがないときは今の 1 欄・`transactionDate` なし | 2025 年の画面と入力を 1 文字も変えない |
| D3 | 変更日は `src/ui/shohizei/context-builder.js` の定数 `INVOICE_TRANSITION_CHANGE_DATE = '2026-10-01'`。マスターの `INV-TRANS-02` の `applies_to_transaction_from` と一致することを試験で確かめる | 画面の組み立てはマスターを読まない。ずれたら試験で気づく |
| D4 | `transactionDate` は、変更日以後の行が `2026-10-01`、変更日より前の行が前日の `2026-09-30` | エンジンはこの日付で割合と税率の記録を引く |
| D5 | 配列の 0 番を「変更日以後」、1 番を「変更日より前」にする | 既存の欄と `fieldPath`（`taxableWithoutInvoice[0]…`）を変えずに済む |
| D6 | 税率区分・相手先の年間の合計・帳簿の保存は 2 行で共通（1 組の入力） | 今の画面が 1 相手先・1 税率の作り。広げない |
| D7 | 課税期間の開始日は `options.consumptionTaxPeriod` で差し替えられるようにする（既定は `CONSUMPTION_TAX_PERIOD`） | `SUPPORTED_YEAR` を変えずに 2026 年の形を試験するため。公開の画面からは渡さない |
| D8 | 2 欄の金額はどちらも必須。無ければ 0 を入れてもらう | 分けたことを利用者が確かめた入力にする |

## R1. `src/ui/shohizei/context-builder.js`

```js
const INVOICE_TRANSITION_CHANGE_DATE = '2026-10-01';

function invoiceTransitionSplit(period) {
  if (!(period.from < INVOICE_TRANSITION_CHANGE_DATE && INVOICE_TRANSITION_CHANGE_DATE <= period.to)) {
    return null;
  }
  return { beforeDate: '2026-09-30', afterDate: INVOICE_TRANSITION_CHANGE_DATE };
}
```

`module.exports` に足す。`beforeDate` は定数の前日（日付の計算は入れず、この 1 か所の文字列で持つ。試験で前日であることを確かめる）。

## R2. `src/ui/shohizei/input-builder.js`

1. `transactions(formState, errors, period)`。`period` は `options.consumptionTaxPeriod || CONSUMPTION_TAX_PERIOD`。`sales`・`purchases` の `period` もこの値にする。
2. `invoiceTransitionSplit(period)` が `null` のときは今のまま。
3. 値があるとき、`taxableWithoutInvoice` に次の 2 行を入れる。

   | 配列の番号 | 金額の項目 | `transactionDate` |
   | --- | --- | --- |
   | 0 | `purchasesWithoutInvoice`・`purchasesWithoutInvoiceBasis` | `afterDate` |
   | 1 | `purchasesWithoutInvoiceBeforeChange`・`purchasesWithoutInvoiceBeforeChangeBasis` | `beforeDate` |

   どちらの行も `band`・`counterpartyAnnualTotal`・`hasRequiredRecords` は今の項目から作る。1 番の行の `fieldPath` は `$.purchases[0].value.taxableWithoutInvoice[1]…`。`counterpartyAnnualTotal` と `hasRequiredRecords` のエラーは 0 番の行の分だけ出す（同じ項目のエラーを 2 回出さない）。

## R3. `src/ui/shohizei/app.js`

1. `mountShohizeiApp` の引数に `consumptionTaxPeriod`（省略時は `CONSUMPTION_TAX_PERIOD`）を足し、`buildShohizeiInput` へ渡す。文脈の組み立て（`buildCalculationContext`）は変えない。試験では `calculate` を差し替えるか、画面の出力だけを確かめる。
2. 既定値 `purchasesWithoutInvoiceBeforeChange: ''`、`purchasesWithoutInvoiceBeforeChangeBasis: 'inclusive'`。
3. エラーの対応表に `'$.purchases[0].value.taxableWithoutInvoice[1].amount.amount.value': 'sz-without-invoice-amount-before'` を足す。
4. `invoiceTransitionSplit(期間)` があるとき、インボイスなし仕入れの入力を次の 2 欄にする。ないときは今のまま。

   | 欄の id | 見出し | 項目 |
   | --- | --- | --- |
   | `sz-without-invoice-amount-before` | `インボイスなし課税仕入（2026年9月30日まで・80%控除）` | `purchasesWithoutInvoiceBeforeChange` |
   | `sz-without-invoice-amount` | `インボイスなし課税仕入（2026年10月1日以後・70%控除）` | `purchasesWithoutInvoice` |

   2 欄の下に説明を足す: `経過措置の控除割合が2026年10月1日に変わるので、取引日で分けて入力してください。どちらかが無ければ0を入力してください。`

## R4. 試験

### `scripts/lib/__tests__/test-shohizei-ui.js`（または入力の組み立ての試験があるファイル）

1. 2025 年の期間（既定）: 今の 1 行のまま。`transactionDate` が無い。
2. 2026 年の期間（`options.consumptionTaxPeriod`）: 2 行。0 番 `2026-10-01`・1 番 `2026-09-30`。金額・`band`・`counterpartyAnnualTotal`・`hasRequiredRecords` が正しい。
3. 2026 年で `purchasesWithoutInvoiceBeforeChange` が空欄だとエラーで、`fieldPath` が `[1]` の行。`sz-without-invoice-amount-before` に結びつく。
4. 画面: 2026 年の期間で 2 欄と説明が出る。2025 年は出ない。
5. `INVOICE_TRANSITION_CHANGE_DATE` が `INV-TRANS-02` の `applies_to_transaction_from` と一致し、`beforeDate` が `INV-TRANS-01` の `applies_to_transaction_to` と一致する。

### `scripts/lib/__tests__/test-shohizei-service.js`

6. `buildShohizeiInput` で作った 2026 年の入力を `service.simulate` に渡す（`src/ui/shohizei/input-builder.js` を `require`）。`CT_INVOICE_PERIOD_SPLIT_REQUIRED` が出ない。一般課税の結果がある。

   手計算: 10%・税込。変更日より前 1,100,000 円、以後 1,100,000 円。国税分の仕入税額は 1,100,000 × 7.8/110 ＝ 78,000 円。80% で 62,400 円、70% で 54,600 円、計 117,000 円（`transitionDetails` か、結果の仕入控除の内訳で確かめる。端数処理の前の段で確かめられる項目を使う）。

7. 1 行で `transactionDate` なしの 2026 年の入力は、今までどおり `CT_INVOICE_PERIOD_SPLIT_REQUIRED` で止まる。

## 変えてはいけないもの

- エンジン（`src/tax-engine/`）・サービス（`src/simulators/`）のコード。必要に見えたら変えずに【要判断】で報告する。
- マスターの JSON。
- `SUPPORTED_YEAR`・`CONSUMPTION_TAX_PERIOD`・`versions.js`、公開用のまとめファイル。
- 文書（台帳・README・仕様書）。Claude が直す。

## 確かめること

1. `node scripts/lib/__tests__/test-shohizei-ui.js`
2. `node scripts/lib/__tests__/test-shohizei-service.js`
3. `npm run masters:validate`
4. `git status` で指示書に無いファイルが変わっていないこと。`assets/` が試験で書き換わったら元に戻す。

`npm run masters:test` は Claude が隔離の外で流す。
