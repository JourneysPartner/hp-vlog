'use strict';

const { buildContextMetadata } = require('../context-builder.js');

const SUPPORTED_YEAR = 2025;

const MUNICIPALITIES = Object.freeze([
  Object.freeze({ key: 'shibuya', label: '渋谷区', municipalityCode: '13113', prefectureCode: '13', isDesignatedCity: false }),
  Object.freeze({ key: 'yokohama', label: '横浜市', municipalityCode: '14100', prefectureCode: '14', isDesignatedCity: true }),
  Object.freeze({ key: 'nagoya', label: '名古屋市', municipalityCode: '23100', prefectureCode: '23', isDesignatedCity: true }),
  Object.freeze({ key: 'osaka', label: '大阪市', municipalityCode: '27100', prefectureCode: '27', isDesignatedCity: true }),
  Object.freeze({ key: 'fukuoka', label: '福岡市', municipalityCode: '40130', prefectureCode: '40', isDesignatedCity: true }),
  Object.freeze({ key: 'sapporo', label: '札幌市', municipalityCode: '01100', prefectureCode: '01', isDesignatedCity: true }),
]);

const MUNICIPALITY_BY_KEY = Object.freeze(Object.fromEntries(
  MUNICIPALITIES.map(municipality => [municipality.key, municipality])
));

function jurisdictionFor(formState) {
  const selected = MUNICIPALITY_BY_KEY[formState.municipalityKey];
  if (selected) return selected;

  // 「その他」は国保実額を使う場合のみ、呼び出し側が団体コードを渡せる。
  if (formState.municipalityKey === 'other' &&
      /^\d{2}$/.test(formState.otherPrefectureCode || '') &&
      /^\d{5}$/.test(formState.otherMunicipalityCode || '')) {
    return Object.freeze({
      key: 'other',
      label: 'その他',
      prefectureCode: formState.otherPrefectureCode,
      municipalityCode: formState.otherMunicipalityCode,
      isDesignatedCity: formState.otherIsDesignatedCity === true,
    });
  }
  throw new RangeError('対応する市区町村を選択してください');
}

function buildCalculationContext(formState, snapshotInfo, calculatedAt) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  const metadata = buildContextMetadata(snapshotInfo, calculatedAt);
  const year = formState.incomeTaxYear === undefined
    ? SUPPORTED_YEAR
    : Number(formState.incomeTaxYear);
  if (year !== SUPPORTED_YEAR) throw new RangeError('第1版の計算対象年は2025年だけです');
  const municipality = jurisdictionFor(formState);
  const isTransition = formState.comparisonBasis === 'transition_year';
  const establishedOn = formState.establishedOn;
  if (isTransition && (typeof establishedOn !== 'string' ||
      !new RegExp(`^${year}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$`).test(establishedOn) ||
      establishedOn === `${year}-01-01` || Number.isNaN(Date.parse(`${establishedOn}T00:00:00Z`)))) {
    throw new RangeError(`法人設立日は${year}年1月2日から12月31日までで入力してください`);
  }

  return {
    ...metadata,
    incomeTaxYear: year,
    residentTaxFiscalYear: year,
    fiscalPeriod: {
      from: isTransition ? establishedOn : `${year}-01-01`,
      to: `${year}-12-31`,
    },
    // 協会けんぽの年間計算に使う、当年度の登録済み料率の参照月。
    socialInsuranceMonths: [`${year}-04`],
    jurisdiction: {
      country: 'JP',
      codeSystemVersion: `${year}-01`,
      asOfForCodes: `${year}-01-01`,
      prefectureCode: municipality.prefectureCode,
      municipalityCode: municipality.municipalityCode,
      isDesignatedCity: municipality.isDesignatedCity,
    },
  };
}

module.exports = Object.freeze({
  SUPPORTED_YEAR,
  MUNICIPALITIES,
  buildCalculationContext,
});
