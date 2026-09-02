'use strict';

/**
 * 税務シミュレーター入力型の唯一の定義元。
 *
 * ここでは設計書 §3〜§7 の構造だけを、生成器が解釈する素のデータとして表す。
 * 生成物である JSON Schema と型宣言は直接編集しない。
 */

const string = { kind: 'string' };
const boolean = { kind: 'boolean' };
const integer = { kind: 'integer' };
const bigint = { kind: 'bigint' };

const ref = (name) => ({ kind: 'ref', name });
const array = (items) => ({ kind: 'array', items });
const literal = (value) => ({ kind: 'literal', value });
const enumeration = (...values) => ({ kind: 'enum', values });
const object = (required = {}, optional = {}, bases = []) => ({
  kind: 'object',
  required,
  optional,
  bases,
});
const union = (...variants) => ({ kind: 'union', variants });
const intersection = (...parts) => ({ kind: 'intersection', parts });
const record = (values) => ({ kind: 'record', values });
const genericRef = (name, ...arguments_) => ({ kind: 'genericRef', name, arguments: arguments_ });

const definitions = {
  LocalDate: {
    kind: 'brandedString',
    brand: '__localDate',
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    description: '検証済みの日付。YYYY-MM-DD形式。',
  },
  PrefectureCode: {
    kind: 'brandedString',
    brand: '__jisX0401',
    pattern: '^[0-9]{2}$',
    description: 'JIS X 0401の都道府県コード2桁。',
  },
  Decimal: {
    kind: 'brandedString',
    brand: '__decimal',
    pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
    description: '十進文字列。指数表記と桁区切りは許可しない。',
    wireOnly: true,
  },
  DateRange: object({ from: ref('LocalDate'), to: ref('LocalDate') }),
  TriState: enumeration('yes', 'no', 'unknown'),
  Money: object({ unit: literal('JPY'), value: bigint }),
  Exact: object({ unit: literal('JPY'), num: bigint, den: { kind: 'bigint', positive: true } }),
  Rate: object({ num: bigint, den: { kind: 'bigint', positive: true } }),
  TaxIncl: object({ basis: enumeration('inclusive', 'exclusive'), amount: ref('Money') }),
  Area: object({ unit: literal('SQM'), num: bigint, den: { kind: 'bigint', positive: true } }),
  PeriodSegment: {
    ...object({ period: ref('DateRange'), value: ref('T') }),
    parameters: ['T'],
  },

  IncomeCategory: enumeration(
    'business', 'real_estate', 'salary', 'dividend', 'interest', 'misc',
    'capital_gain', 'occasional', 'forestry', 'retirement', 'unknown'
  ),
  TaxationMethod: enumeration(
    'aggregate', 'separate_declared', 'separate_withheld', 'separate_retirement', 'unknown'
  ),
  IncomeItem: object(
    {
      category: ref('IncomeCategory'),
      taxationMethod: ref('TaxationMethod'),
      amount: ref('Money'),
    },
    { label: string }
  ),
  DeductionOverride: object({
    forIncomeTax: ref('Money'),
    forResidentTax: ref('Money'),
    reason: string,
  }),
  SocialInsuranceDeductionInput: union(
    object({ kind: literal('total'), annualTotal: ref('Money') }),
    object(
      { kind: literal('itemized') },
      {
        nationalHealthInsurance: ref('Money'),
        nationalPension: ref('Money'),
        nationalPensionFund: ref('Money'),
        employeeShareOfSocialInsurance: ref('Money'),
        other: ref('Money'),
      }
    )
  ),
  IndividualBusinessTaxCategory: enumeration(
    'type1', 'type2', 'type3_standard', 'type3_reduced', 'not_listed', 'unknown'
  ),
  DisabilityCategory: enumeration('none', 'general', 'special', 'special_cohabiting'),
  PersonFacts: object({}, {
    ageAtYearEnd: integer,
    disability: ref('DisabilityCategory'),
    isNonResident: boolean,
  }),
  SpouseFacts: object(
    { exists: boolean },
    {
      livesTogether: boolean,
      totalIncome: ref('Money'),
      isFullTimeHomemaker: ref('TriState'),
    },
    ['PersonFacts']
  ),
  DependentRelation: enumeration('child', 'parent', 'grandparent', 'sibling', 'other_relative'),
  DependentFacts: object(
    { id: string, relation: ref('DependentRelation') },
    {
      livesTogether: boolean,
      isLivingApartAndSupported: boolean,
      totalIncome: ref('Money'),
    },
    ['PersonFacts']
  ),
  LifeInsuranceContractGeneration: enumeration('new', 'old'),
  LifeInsurancePremiumInput: object({
    generation: ref('LifeInsuranceContractGeneration'),
    category: enumeration('life', 'nursing_medical', 'annuity'),
    annualPremium: ref('Money'),
  }),
  EarthquakeInsurancePremiumInput: object({
    category: enumeration('earthquake', 'old_long_term'),
    annualPremium: ref('Money'),
  }),
  MedicalExpenseInput: object(
    { mode: enumeration('medical', 'self_medication'), paidAmount: ref('Money') },
    { insuranceReimbursement: ref('Money') }
  ),
  DonationInput: object({
    kind: enumeration('furusato', 'designated', 'political', 'other'),
    amount: ref('Money'),
  }),
  PersonalDeductionFacts: object({}, {
    socialInsurance: ref('SocialInsuranceDeductionInput'),
    smallEnterpriseMutualAid: ref('Money'),
    lifeInsurance: array(ref('LifeInsurancePremiumInput')),
    earthquakeInsurance: array(ref('EarthquakeInsurancePremiumInput')),
    medical: ref('MedicalExpenseInput'),
    donations: array(ref('DonationInput')),
    casualtyLoss: ref('Money'),
    isWorkingStudent: boolean,
    widowOrSingleParent: enumeration('none', 'widow', 'single_parent'),
    overrides: array(ref('DeductionOverride')),
  }),
  BusinessPeriodFacts: object({}, {
    openedOn: ref('LocalDate'),
    closedOn: ref('LocalDate'),
  }),
  CompensationPlan: object(
    {
      monthlySegments: array(genericRef(
        'PeriodSegment',
        object({ monthlyAmount: ref('Money') })
      )),
    },
    {
      revisions: array(ref('CompensationRevision')),
      bonuses: array(ref('PredeterminedBonus')),
      appointedOn: ref('LocalDate'),
      resignedOn: ref('LocalDate'),
    }
  ),
  RevisionReason: enumeration('ordinary', 'extraordinary', 'performance_decline', 'other'),
  CompensationRevision: object({
    effectiveOn: ref('LocalDate'),
    reason: ref('RevisionReason'),
    newMonthlyAmount: ref('Money'),
  }),
  PredeterminedBonus: object(
    { payOn: ref('LocalDate'), amount: ref('Money'), hasFiling: ref('TriState') },
    { filedOn: ref('LocalDate'), paidAsFiled: ref('TriState') }
  ),
  HealthInsurerInput: union(
    object({ kind: literal('kyokai_kenpo'), prefectureCode: ref('PrefectureCode') }),
    object({ kind: literal('kenpo_kumiai'), insurerCode: string }),
    object({ kind: literal('none') }),
    object({ kind: literal('unknown') })
  ),
  Share: ref('Rate'),
  SpecialistChecks: record(ref('TriState')),

  HojinnariInput: object({
    precision: enumeration('simple', 'detailed'),
    comparisonBasis: enumeration('steady_state', 'transition_year'),
    individual: ref('HojinnariIndividualInput'),
    corporate: ref('HojinnariCorporateInput'),
    consumptionTax: union(
      object({ include: literal(false) }),
      object({
        include: literal(true),
        individualPeriodInput: ref('ShohizeiInput'),
        corporatePeriodInput: ref('ShohizeiInput'),
      })
    ),
    specialistChecks: ref('SpecialistChecks'),
  }, {
    setupAndMaintenanceCosts: ref('CorporateCostInput'),
  }),
  HojinnariIndividualInput: object({
    business: object({
      revenue: array(genericRef('PeriodSegment', ref('Money'))),
      expenses: array(genericRef('PeriodSegment', ref('Money'))),
      periodFacts: ref('BusinessPeriodFacts'),
    }, {
      expensesExcludeSocialInsuranceAndMutualAid: ref('TriState'),
      businessTaxCategory: ref('IndividualBusinessTaxCategory'),
    }),
    blueReturn: object({ status: enumeration('blue', 'white', 'unknown') }, {
      specialDeductionCategory: enumeration('e_tax_650k', 'bookkeeping_550k', 'simple_100k', 'none'),
    }),
    self: ref('PersonFacts'),
    residentTaxBasis: enumeration('steady_state', 'actual_year'),
  }, {
    otherIncomes: array(ref('IncomeItem')),
    deductions: ref('PersonalDeductionFacts'),
    spouse: ref('SpouseFacts'),
    dependents: array(ref('DependentFacts')),
    nationalHealthInsurance: ref('NationalHealthInsuranceInput'),
    nationalPension: ref('NationalPensionInput'),
    taxCredits: object({}, {
      housingLoan: ref('Money'),
      other: array(object({ code: string, amount: ref('Money') })),
    }),
  }),
  NationalHealthInsuranceInput: union(
    object({ kind: literal('actual'), annualAmount: ref('Money') }),
    object({ kind: literal('estimate_accepted') }),
    object({ kind: literal('unknown') })
  ),
  NationalPensionInput: union(
    object({ kind: literal('actual'), annualAmount: ref('Money') }),
    object({ kind: literal('standard'), months: integer }, { hasAdditionalPremium: boolean }),
    object({ kind: literal('exempted') }),
    object({ kind: literal('unknown') })
  ),
  HojinnariCorporateInput: object({
    locationSameAsResidence: ref('TriState'),
    capital: ref('Money'),
    officerCompensation: ref('CompensationPlan'),
    healthInsurer: ref('HealthInsurerInput'),
    revenue: array(genericRef('PeriodSegment', ref('Money'))),
    expenses: array(genericRef('PeriodSegment', ref('Money'))),
  }, {
    employeeCount: integer,
    establishedOn: ref('LocalDate'),
    deductions: object({}, { smallEnterpriseMutualAid: ref('Money') }),
    spouseOfficer: object({ isOfficer: boolean }, {
      compensation: ref('CompensationPlan'),
      facts: ref('PersonFacts'),
    }),
    taxAdjustments: ref('CorporateTaxAdjustmentInput'),
    lossCarryforward: ref('LossCarryforwardInput'),
  }),
  CorporateTaxAdjustmentItem: object({
    code: enumeration(
      'entertainment', 'donation', 'depreciation', 'allowance',
      'taxes_and_dues', 'officer_salary', 'dividend_received', 'other'
    ),
    applies: ref('TriState'),
  }, {
    amount: ref('Money'),
    direction: enumeration('add', 'subtract'),
  }),
  CorporateTaxAdjustmentInput: object({ items: array(ref('CorporateTaxAdjustmentItem')) }, {
    treatUnansweredAsZero: boolean,
  }),
  LossCarryforwardInput: object({}, {
    hasBlueReturnForLossYears: ref('TriState'),
    losses: array(object({ fiscalYearStartedOn: ref('LocalDate'), amount: ref('Money') })),
  }),
  CorporateCostInput: object({}, {
    incorporationCost: ref('Money'),
    annualAccountingFee: ref('Money'),
    annualLaborConsultantFee: ref('Money'),
    otherAnnualCost: ref('Money'),
  }),

  ShohizeiInput: object({
    precision: enumeration('simple', 'detailed'),
    taxpayerType: enumeration('individual', 'corporation'),
    eligibility: ref('ShohizeiEligibilityInput'),
    sales: array(genericRef('PeriodSegment', ref('SalesInput'))),
    purchases: array(genericRef('PeriodSegment', ref('PurchaseInput'))),
    specialistChecks: ref('SpecialistChecks'),
  }, {
    simplified: ref('SimplifiedTaxationInput'),
  }),
  ShohizeiEligibilityInput: object({
    invoiceRegistration: object({ registered: ref('TriState') }, {
      registeredOn: ref('LocalDate'),
      becameTaxableByRegistration: ref('TriState'),
    }),
    filings: array(ref('ShohizeiFilingStatus')),
  }, {
    basePeriod: object({ exists: boolean }, {
      taxableSales: ref('Money'),
      lengthInMonths: integer,
    }),
    specifiedPeriod: object({}, {
      taxableSales: ref('Money'),
      salaryPayments: ref('Money'),
    }),
    newCompany: object({}, {
      isNewlyEstablished: ref('TriState'),
      isSpecifiedNewlyEstablished: ref('TriState'),
    }),
    events: object({}, {
      inheritance: ref('TriState'),
      merger: ref('TriState'),
      corporateSplit: ref('TriState'),
      highValueAssetAcquisition: ref('TriState'),
      adjustableFixedAssetAcquisition: ref('TriState'),
    }),
    taxablePeriodShortened: ref('TriState'),
  }),
  ShohizeiFilingKind: enumeration(
    'taxable_person_election', 'taxable_person_election_cancel',
    'simplified_election', 'simplified_election_cancel'
  ),
  ShohizeiFilingStatus: object({
    kind: ref('ShohizeiFilingKind'),
    filed: ref('TriState'),
  }, {
    filedOn: ref('LocalDate'),
    effectiveFromPeriodStart: ref('LocalDate'),
  }),
  ConsumptionTaxRateBand: enumeration('standard_10', 'reduced_8', 'old_8'),
  BandAmount: object({
    band: ref('ConsumptionTaxRateBand'),
    amount: ref('TaxIncl'),
  }),
  SimpleSalesInput: object({
    kind: literal('simple'),
    taxableTotal: ref('TaxIncl'),
    standardRatio: ref('Rate'),
    reducedRatio: ref('Rate'),
  }, {
    exportExempt: ref('TaxIncl'),
    primaryCategory: ref('SimplifiedBusinessCategory'),
  }),
  DetailedSalesInput: object({
    kind: literal('detailed'),
    taxable: array(ref('BandAmount')),
  }, {
    exportExempt: ref('TaxIncl'),
    nonTaxable: ref('TaxIncl'),
    outOfScope: ref('TaxIncl'),
    returnsAndDiscounts: array(ref('BandAmount')),
    badDebts: array(ref('BandAmount')),
    simplifiedCategoryBreakdown: array(ref('SimplifiedCategorySales')),
  }),
  SalesInput: union(ref('SimpleSalesInput'), ref('DetailedSalesInput')),
  SimplePurchaseInput: object({
    kind: literal('simple'),
    taxableTotal: ref('TaxIncl'),
    hasPurchasesFromNonRegistered: ref('TriState'),
  }),
  DetailedPurchaseInput: object({
    kind: literal('detailed'),
    taxableWithInvoice: array(ref('BandAmount')),
    taxableWithoutInvoice: array(ref('TransitionalPurchase')),
  }, {
    nonTaxable: ref('TaxIncl'),
    outOfScope: ref('TaxIncl'),
    personnelCost: ref('Money'),
    returns: array(ref('BandAmount')),
  }),
  PurchaseInput: union(ref('SimplePurchaseInput'), ref('DetailedPurchaseInput')),
  TransitionalPurchase: object({
    band: ref('ConsumptionTaxRateBand'),
    amount: ref('TaxIncl'),
  }, {
    counterpartyId: string,
    counterpartyAnnualTotal: ref('TaxIncl'),
    hasRequiredRecords: ref('TriState'),
  }),
  SimplifiedBusinessCategory: enumeration(
    'type1', 'type2', 'type3', 'type4', 'type5', 'type6', 'unclassifiable'
  ),
  SimplifiedCategorySales: object({
    category: ref('SimplifiedBusinessCategory'),
    amount: ref('TaxIncl'),
    band: ref('ConsumptionTaxRateBand'),
  }),
  SimplifiedTaxationInput: object({ categorySelectedByUser: literal(true) }, {
    primaryCategory: ref('SimplifiedBusinessCategory'),
  }),

  SozokuInput: object({
    level: enumeration(1, 2, 3),
    precision: enumeration('simple', 'detailed'),
    decedent: ref('DecedentInput'),
    heirs: array(ref('HeirInput')),
    assets: ref('EstateInput'),
    debts: array(ref('DebtInput')),
    specialistChecks: ref('SpecialistChecks'),
  }, {
    division: ref('DivisionInput'),
    smallResidentialLand: array(ref('SmallResidentialLandInput')),
    secondaryInheritance: ref('SecondaryInheritanceInput'),
  }),
  DecedentInput: object({}, {
    residencyStatus: enumeration('domestic_resident', 'non_resident', 'unknown'),
  }),
  HeirRelation: enumeration(
    'spouse', 'child', 'adopted_child', 'special_adopted_child', 'grandchild',
    'parent', 'grandparent', 'sibling_full', 'sibling_half', 'nephew_niece', 'other'
  ),
  HeirInput: object({
    id: string,
    relation: ref('HeirRelation'),
    isAlive: boolean,
  }, {
    diedOn: ref('LocalDate'),
    renounced: ref('TriState'),
    disqualifiedOrExcluded: ref('TriState'),
    substitutedFor: string,
    adoptionFacts: object({}, {
      isSpecialAdoption: boolean,
      isStepChildOfSpouse: boolean,
      isSubstituteForDescendant: boolean,
    }),
    isMinor: boolean,
    ageAtInheritance: integer,
    disability: ref('DisabilityCategory'),
    residencyStatus: enumeration('domestic_resident', 'non_resident', 'unknown'),
    previousInheritanceWithin10Years: object({
      occurredOn: ref('LocalDate'),
      taxPaid: ref('Money'),
      netEstateReceived: ref('Money'),
    }),
  }),
  EstateInput: object({}, {
    cash: ref('Money'),
    securities: ref('Money'),
    businessAssets: ref('Money'),
    otherAssets: ref('Money'),
    realEstate: array(ref('RealEstateInput')),
    lifeInsurance: array(ref('BeneficiaryAmount')),
    retirementAllowance: array(ref('BeneficiaryAmount')),
    giftAddback: array(ref('GiftAddbackInput')),
    settlementTaxationGifts: ref('Money'),
  }),
  BeneficiaryAmount: object({ isHeir: boolean, amount: ref('Money') }, {
    beneficiaryHeirId: string,
  }),
  GiftAddbackInput: object({
    giftedOn: ref('LocalDate'),
    recipientHeirId: string,
    amount: ref('Money'),
  }, {
    giftTaxPaid: ref('Money'),
  }),
  RealEstateInput: union(
    object({
      kind: literal('appraised'),
      category: enumeration('land', 'building'),
      value: ref('Money'),
    }, { ownershipShare: ref('Share') }),
    object({
      kind: literal('screening_land'),
      roadsideValuePerSqm: ref('Money'),
      areaSqm: ref('Area'),
    }, {
      isMultiplierArea: ref('TriState'),
      hasLeaseholdOrRented: ref('TriState'),
      ownershipShare: ref('Share'),
    }),
    object({
      kind: literal('screening_building'),
      fixedAssetTaxValue: ref('Money'),
    }, { ownershipShare: ref('Share') })
  ),
  DebtInput: object({
    kind: enumeration('loan', 'unpaid', 'funeral', 'other'),
    amount: ref('Money'),
  }, { bearerHeirId: string }),
  DivisionInput: object({
    isDivided: ref('TriState'),
    acquisitions: array(object({ heirId: string, share: ref('Share') })),
  }, {
    dividedAfterFilingDeadline: ref('TriState'),
    spouseAcquisitionAmount: ref('Money'),
  }),
  SmallResidentialLandCategory: enumeration(
    'specified_residential', 'specified_business', 'specified_same_business', 'rental_business'
  ),
  SmallResidentialLandInput: object({
    realEstateIndex: integer,
    category: ref('SmallResidentialLandCategory'),
    areaSqm: ref('Area'),
    acquirerHeirId: string,
    acquirerRelation: enumeration('spouse', 'cohabiting_relative', 'separate_household_relative', 'other'),
  }, {
    intendedAppliedAreaSqm: ref('Area'),
    useAtInheritance: string,
    acquirerResidesAndOwns: ref('TriState'),
    willHoldUntilFilingDeadline: ref('TriState'),
  }),
  SecondaryInheritanceInput: object({
    spouseOwnAssets: ref('Money'),
    spouseAcquisitionRatios: array(ref('Share')),
    expectedHeirs: array(ref('HeirInput')),
  }, {
    yearsUntilSecondary: integer,
    annualLivingCost: ref('Money'),
    annualAssetChangeRate: ref('Rate'),
  }),

  YakuinHoshuInput: union(
    intersection(object({ mode: literal('A') }), ref('YakuinHoshuCommonInput'), ref('ModeAInput')),
    intersection(object({ mode: literal('B') }), ref('YakuinHoshuCommonInput'), ref('ModeBInput')),
    intersection(object({ mode: literal('C') }), ref('YakuinHoshuCommonInput'), ref('ModeCInput'))
  ),
  YakuinHoshuCommonInput: object({
    precision: enumeration('simple', 'detailed'),
    officerResidenceSameAsCompany: ref('TriState'),
    capital: ref('Money'),
    healthInsurer: ref('HealthInsurerInput'),
    officer: ref('PersonFacts'),
    specialistChecks: ref('SpecialistChecks'),
  }, {
    employeeCount: integer,
    spouse: ref('SpouseFacts'),
    dependents: array(ref('DependentFacts')),
    otherIncomes: array(ref('IncomeItem')),
    deductions: ref('PersonalDeductionFacts'),
    taxCredits: object({}, {
      housingLoan: ref('Money'),
      other: array(object({ code: string, amount: ref('Money') })),
    }),
    appointedOn: ref('LocalDate'),
    previousMonthlyAmount: ref('Money'),
    standardRemunerationDecisionKind: enumeration('on_qualification', 'regular', 'occasional'),
  }),
  ModeAInput: object({
    profitBeforeOfficerCompensation: ref('Money'),
    searchStep: enumeration('10000', '50000'),
    optimizationCriterion: enumeration('min_burden', 'max_total_retained', 'max_corporate_with_floor'),
  }, {
    searchUpperBound: ref('Money'),
    constraints: object({}, {
      minPersonalNetIncome: ref('Money'),
      minCorporateRetained: ref('Money'),
      officerCompensationCeilingByResolution: ref('Money'),
    }),
    bonusPlan: array(ref('PredeterminedBonus')),
  }),
  ModeBInput: object({
    desiredMonthlyNetIncome: ref('Money'),
    searchStep: enumeration('10000', '50000'),
  }, {
    assumedBonusPlan: array(ref('PredeterminedBonus')),
    profitBeforeOfficerCompensation: ref('Money'),
  }),
  // profitBeforeOfficerCompensation は法人側も合成する場合の役員報酬控除前利益。
  // 型としては省略可（個人側だけの順算＝§44 の表示例）だが、④第1版のサービスは
  // 省略を blocked（YH_PROFIT_BEFORE_COMPENSATION_REQUIRED）にする。個人側だけの
  // 順算は将来版で対応。①法人成りが④のMODE Cを部品として使うときは必須。
  // CalculationContext へ入力データを流さないための追加（§3-2）
  ModeCInput: object({ plan: ref('CompensationPlan') }, { profitBeforeOfficerCompensation: ref('Money') }),
};

const roots = [
  { name: 'HojinnariInput', file: 'hojinnari-input.schema.json', title: '法人成りシミュレーター入力' },
  { name: 'ShohizeiInput', file: 'shohizei-input.schema.json', title: '消費税シミュレーター入力' },
  { name: 'SozokuInput', file: 'sozoku-input.schema.json', title: '相続税シミュレーター入力' },
  { name: 'YakuinHoshuInput', file: 'yakuin-hoshu-input.schema.json', title: '役員報酬シミュレーター入力' },
];

module.exports = { definitions, roots };
