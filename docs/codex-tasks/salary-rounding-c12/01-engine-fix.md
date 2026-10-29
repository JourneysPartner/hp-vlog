# 段 1 — 給与所得を計算してから 1円未満を切り捨てる

根拠と背景: 同じフォルダの `README.md`、台帳 `docs/tax-simulator/deferred-items.md` の C-12。

## R1. `src/tax-engine/income/salary-income.js`

1. 算式表（`salary_income_deduction_table`）から給与所得控除額を求める処理（今の `calculateDeductionFromTable`）は、**丸めずに正確な値（Exact）のまま**返す形にする。どの記録を使ったか（`rounding_rule_id` を読むため）も呼び出し側で分かるようにする。
   - `deduction_type: 'fixed'` は固定額をそのまま Exact にする。
   - `deduction_type: 'formula'` は `収入 × rate + rate_addition` を丸めない。
   - それ以外の `deduction_type` は今と同じ例外。該当行が無いときの例外の文言も今のまま。
2. 660万円以上（今の `deduction_table` の経路）:
   - 給与所得 ＝ `applyRounding(収入 − 正確な控除額, 使った記録の rounding_rule_id)`
   - 給与所得控除額（`salaryIncomeDeduction`）＝ 収入 − 給与所得（整数）
   - 例: 8,499,999円 → 正確な控除額 1,949,999.9円 → 給与所得 6,549,999.1円 → 6,549,999円。控除額は 1,950,000円と返る。
3. 別表第五の帯規則（`floor_to_band_then_deduction_table`）の経路も同じ形にする: 給与所得 ＝ `applyRounding(帯の下端 − 正確な控除額, 使った算式表の記録の rounding_rule_id)`。帯の下端は 4,000円の倍数なので、今の記録では結果は変わらない（試験で確かめる）。
4. 別表第五の他の方式（`fixed_result`・`subtract_fixed`・`rate_minus_fixed`）は変えない。
5. 返す項目（`salaryRevenue`・`salaryIncomeDeduction`・`salaryIncome`・`calculationMethod`・`bandLower`・`masterRecordId`）と、`calculateSalaryIncomeDeduction` の公開は変えない。
6. 修正箇所に短いコメントを入れる:「給与所得の金額を計算してから1円未満を切り捨てる（国税庁『年末調整のしかた』電子計算機等による年末調整（注）2、所得税法別表第五の備考、確定申告の手引きの給与所得金額の計算表）。給与所得控除額を先に切り捨てると給与所得が1円多くなる（台帳 C-12）。」

## R2. 試験 `scripts/lib/__tests__/test-income-tax-engine.js`（令和7年分＝`taxYear: 2025`）

今ある試験は変えない。次を足す。期待値は下の表（国税庁の算式から手で計算した値）から取り、マスターの記録から作らない。

### R2-1. 給与所得の期待値

| 収入 | 給与所得 | 給与所得控除額 | 計算方式 | 備考 |
| --- | --- | --- | --- | --- |
| 6,599,999 | 4,836,800 | 1,763,199 | appendix5 | 別表第五（変わらない） |
| 6,600,000 | 4,840,000 | 1,760,000 | deduction_table | 端数なし |
| 6,600,001 | 4,840,000 | 1,760,001 | deduction_table | 4,840,000.9 を切り捨て（今は 4,840,001） |
| 6,655,556 | 4,890,000 | 1,765,556 | deduction_table | 4,890,000.4 を切り捨て（今は 4,890,001） |
| 7,000,000 | 5,200,000 | 1,800,000 | deduction_table | 端数なし |
| 7,234,567 | 5,411,110 | 1,823,457 | deduction_table | 5,411,110.3 を切り捨て（今は 5,411,111） |
| 8,499,999 | 6,549,999 | 1,950,000 | deduction_table | 6,549,999.1 を切り捨て（今は 6,550,000） |
| 8,500,000 | 6,550,000 | 1,950,000 | deduction_table | 上限 |
| 10,000,000 | 8,050,000 | 1,950,000 | deduction_table | 上限 |

### R2-2. 国税庁の算式との全面的な照合

収入 6,600,000〜8,499,999 の範囲で、両端と、997円刻みの全点（6,600,000 + 997 × k）について、エンジンの給与所得が `floor((収入 × 9 − 11,000,000) / 10)`（＝ A×90%−1,100,000円 の 1円未満切り捨て。BigInt で計算）と一致すること。不一致は件数と最初の 3 件を出す。

### R2-3. 税額への影響（基礎控除の段の境目）

`incomeTaxEngine.calculate({ taxYear: 2025, salaryRevenue: 6,655,556円, deductions: {} }, { taxYear: 2025 })` で:
- `totalIncome` が 4,890,000
- 基礎控除が 680,000（結果の `incomeDeductions` か `deductionDetails` の基礎控除。今の結果の形に合わせて読む）
- `payableIncomeTax` が 423,200

（今のエンジンでは 4,890,001・630,000・433,400 になる。）

### R2-4. 住民税

`scripts/lib/__tests__/test-resident-tax-engine.js` に、給与 8,499,999円（ほかの所得なし）で、住民税の計算に使う給与所得が 6,549,999 になることの確かめを 1 つ足す（結果に給与所得が出る項目を探して使う）。給与所得が結果から読めない作りなら、足さずに【要判断】で報告する。

## R3. 変えてはいけないもの

- `data/` 以下すべて（マスター・端数規則・検算表・国税庁のデータ）、`docs/`、`.github/`、`package.json`。
- `src/` のうち `src/tax-engine/income/salary-income.js` 以外。
- 今ある試験の期待値。
- `assets/js/` は試験を流すと書き換わる。**戻さなくてよいので、書き換わったファイルを最終報告に列挙する**（まとめファイルの作り直しは Claude が行う）。

## 確かめること

1. `node scripts/lib/__tests__/test-income-tax-engine.js` が通る（R2 の追加分を含む）。
2. `node scripts/lib/__tests__/test-appendix5-rule.js` が通る。
3. `node scripts/lib/__tests__/test-resident-tax-engine.js` が通る。
4. `npm run masters:test` を流す。落ちた試験があれば名前とエラーの 1 行目を報告する（子プロセスの EPERM で落ちるものは環境のせいとして分けて書く）。**今ある試験が、この修正で期待値の違いにより落ちた場合は、期待値を書き換えずに、その試験名・入力・旧い値・新しい値を報告する**（正しい値か Claude が判断する）。
5. 変えたファイルが `src/tax-engine/income/salary-income.js`・`scripts/lib/__tests__/test-income-tax-engine.js`・`scripts/lib/__tests__/test-resident-tax-engine.js`（＋試験で書き換わった `assets/js/`）だけであること。
