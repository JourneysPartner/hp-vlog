'use strict';

// 防衛特別法人税は令和8年4月1日以後に開始する事業年度に課される
// （我が国の防衛力の抜本的な強化等のために必要な財源の確保に関する特別措置法 11条・13条・14条）。
// 第1版は計算に含めず、該当する事業年度の結果に除外項目として明記する。
const DEFENSE_CORPORATE_TAX_START = '2026-04-01';

function defenseCorporateTaxExcludedItem(fiscalPeriod) {
  const from = fiscalPeriod && fiscalPeriod.from;
  if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      Number.isNaN(Date.parse(`${from}T00:00:00Z`)) ||
      new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from) {
    throw new TypeError('法人の事業年度の開始日はYYYY-MM-DDで指定してください');
  }
  if (from < DEFENSE_CORPORATE_TAX_START) return null;
  return {
    code: 'CORP_DEFENSE_SPECIAL_TAX_EXCLUDED',
    label: '防衛特別法人税は含めていない',
    reason: '令和8年4月1日以後に開始する事業年度には、防衛特別法人税（法人税額から年500万円を差し引いた額の4%。事業年度が1年未満なら500万円を月数で按分）が課されますが、この結果には含めていません。法人税額が年500万円以下なら0円です。',
    isAmountUnknown: true,
  };
}

module.exports = Object.freeze({ defenseCorporateTaxExcludedItem });
