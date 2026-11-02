'use strict';

function incomeTaxLawChangeNotice(year) {
  if (year !== 2026) return undefined;
  return '令和8年分の所得税は、令和8年12月1日施行の改正（基礎控除と給与所得控除の引上げ、配偶者・扶養親族などの所得要件の62万円への引上げなど）を反映しています。住民税は令和9年度分として計算し、同じ62万円の所得要件（令和9年1月1日施行）を反映しています。施行日より前は、結果に「施行前・概算」と表示します。';
}

module.exports = Object.freeze({ incomeTaxLawChangeNotice });
