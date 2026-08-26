/**
 * このファイルは scripts/lib/input-types/definitions.js から自動生成しています。
 * 直接編集せず、npm run input-types:generate を実行してください。
 */

export type Decimal = string & { readonly __decimal: unique symbol };

// メモリ内表現。正確な値は bigint で保持する。

export type LocalDate = string & { readonly __localDate: unique symbol };

export type PrefectureCode = string & { readonly __jisX0401: unique symbol };

export type DateRange = {
  from: LocalDate;
  to: LocalDate;
};

export type TriState = "yes" | "no" | "unknown";

export type Money = {
  unit: "JPY";
  value: bigint;
};

export type Exact = {
  unit: "JPY";
  num: bigint;
  den: bigint;
};

export type Rate = {
  num: bigint;
  den: bigint;
};

export type TaxIncl = {
  basis: "inclusive" | "exclusive";
  amount: Money;
};

export type Area = {
  unit: "SQM";
  num: bigint;
  den: bigint;
};

export type PeriodSegment<T> = {
  period: DateRange;
  value: T;
};

export type IncomeCategory = "business" | "real_estate" | "salary" | "dividend" | "interest" | "misc" | "capital_gain" | "occasional" | "forestry" | "retirement" | "unknown";

export type TaxationMethod = "aggregate" | "separate_declared" | "separate_withheld" | "separate_retirement" | "unknown";

export type IncomeItem = {
  category: IncomeCategory;
  taxationMethod: TaxationMethod;
  amount: Money;
  label?: string;
};

export type DeductionOverride = {
  forIncomeTax: Money;
  forResidentTax: Money;
  reason: string;
};

export type SocialInsuranceDeductionInput = {
  kind: "total";
  annualTotal: Money;
} | {
  kind: "itemized";
  nationalHealthInsurance?: Money;
  nationalPension?: Money;
  nationalPensionFund?: Money;
  employeeShareOfSocialInsurance?: Money;
  other?: Money;
};

export type IndividualBusinessTaxCategory = "type1" | "type2" | "type3_standard" | "type3_reduced" | "not_listed" | "unknown";

export type DisabilityCategory = "none" | "general" | "special" | "special_cohabiting";

export type PersonFacts = {
  ageAtYearEnd?: number;
  disability?: DisabilityCategory;
  isNonResident?: boolean;
};

export type SpouseFacts = PersonFacts & {
  exists: boolean;
  livesTogether?: boolean;
  totalIncome?: Money;
  isFullTimeHomemaker?: TriState;
};

export type DependentRelation = "child" | "parent" | "grandparent" | "sibling" | "other_relative";

export type DependentFacts = PersonFacts & {
  id: string;
  relation: DependentRelation;
  livesTogether?: boolean;
  isLivingApartAndSupported?: boolean;
  totalIncome?: Money;
};

export type LifeInsuranceContractGeneration = "new" | "old";

export type LifeInsurancePremiumInput = {
  generation: LifeInsuranceContractGeneration;
  category: "life" | "nursing_medical" | "annuity";
  annualPremium: Money;
};

export type EarthquakeInsurancePremiumInput = {
  category: "earthquake" | "old_long_term";
  annualPremium: Money;
};

export type MedicalExpenseInput = {
  mode: "medical" | "self_medication";
  paidAmount: Money;
  insuranceReimbursement?: Money;
};

export type DonationInput = {
  kind: "furusato" | "designated" | "political" | "other";
  amount: Money;
};

export type PersonalDeductionFacts = {
  socialInsurance?: SocialInsuranceDeductionInput;
  smallEnterpriseMutualAid?: Money;
  lifeInsurance?: Array<LifeInsurancePremiumInput>;
  earthquakeInsurance?: Array<EarthquakeInsurancePremiumInput>;
  medical?: MedicalExpenseInput;
  donations?: Array<DonationInput>;
  casualtyLoss?: Money;
  isWorkingStudent?: boolean;
  widowOrSingleParent?: "none" | "widow" | "single_parent";
  overrides?: Array<DeductionOverride>;
};

export type BusinessPeriodFacts = {
  openedOn?: LocalDate;
  closedOn?: LocalDate;
};

export type CompensationPlan = {
  monthlySegments: Array<PeriodSegment<{
      monthlyAmount: Money;
    }>>;
  revisions?: Array<CompensationRevision>;
  bonuses?: Array<PredeterminedBonus>;
  appointedOn?: LocalDate;
  resignedOn?: LocalDate;
};

export type RevisionReason = "ordinary" | "extraordinary" | "performance_decline" | "other";

export type CompensationRevision = {
  effectiveOn: LocalDate;
  reason: RevisionReason;
  newMonthlyAmount: Money;
};

export type PredeterminedBonus = {
  payOn: LocalDate;
  amount: Money;
  hasFiling: TriState;
  filedOn?: LocalDate;
  paidAsFiled?: TriState;
};

export type HealthInsurerInput = {
  kind: "kyokai_kenpo";
  prefectureCode: PrefectureCode;
} | {
  kind: "kenpo_kumiai";
  insurerCode: string;
} | {
  kind: "none";
} | {
  kind: "unknown";
};

export type Share = Rate;

export type SpecialistChecks = Partial<Record<string, TriState>>;

export type HojinnariInput = {
  precision: "simple" | "detailed";
  comparisonBasis: "steady_state" | "transition_year";
  individual: HojinnariIndividualInput;
  corporate: HojinnariCorporateInput;
  consumptionTax: {
      include: false;
    } | {
      include: true;
      individualPeriodInput: ShohizeiInput;
      corporatePeriodInput: ShohizeiInput;
    };
  specialistChecks: SpecialistChecks;
  setupAndMaintenanceCosts?: CorporateCostInput;
};

export type HojinnariIndividualInput = {
  business: {
      revenue: Array<PeriodSegment<Money>>;
      expenses: Array<PeriodSegment<Money>>;
      periodFacts: BusinessPeriodFacts;
      expensesExcludeSocialInsuranceAndMutualAid?: TriState;
      businessTaxCategory?: IndividualBusinessTaxCategory;
    };
  blueReturn: {
      status: "blue" | "white" | "unknown";
      specialDeductionCategory?: "e_tax_650k" | "bookkeeping_550k" | "simple_100k" | "none";
    };
  self: PersonFacts;
  residentTaxBasis: "steady_state" | "actual_year";
  otherIncomes?: Array<IncomeItem>;
  deductions?: PersonalDeductionFacts;
  spouse?: SpouseFacts;
  dependents?: Array<DependentFacts>;
  nationalHealthInsurance?: NationalHealthInsuranceInput;
  nationalPension?: NationalPensionInput;
  taxCredits?: {
      housingLoan?: Money;
      other?: Array<{
            code: string;
            amount: Money;
          }>;
    };
};

export type NationalHealthInsuranceInput = {
  kind: "actual";
  annualAmount: Money;
} | {
  kind: "estimate_accepted";
} | {
  kind: "unknown";
};

export type NationalPensionInput = {
  kind: "actual";
  annualAmount: Money;
} | {
  kind: "standard";
  months: number;
  hasAdditionalPremium?: boolean;
} | {
  kind: "exempted";
} | {
  kind: "unknown";
};

export type HojinnariCorporateInput = {
  locationSameAsResidence: TriState;
  capital: Money;
  officerCompensation: CompensationPlan;
  healthInsurer: HealthInsurerInput;
  revenue: Array<PeriodSegment<Money>>;
  expenses: Array<PeriodSegment<Money>>;
  employeeCount?: number;
  establishedOn?: LocalDate;
  spouseOfficer?: {
      isOfficer: boolean;
      compensation?: CompensationPlan;
      facts?: PersonFacts;
    };
  taxAdjustments?: CorporateTaxAdjustmentInput;
  lossCarryforward?: LossCarryforwardInput;
};

export type CorporateTaxAdjustmentItem = {
  code: "entertainment" | "donation" | "depreciation" | "allowance" | "taxes_and_dues" | "officer_salary" | "dividend_received" | "other";
  applies: TriState;
  amount?: Money;
  direction?: "add" | "subtract";
};

export type CorporateTaxAdjustmentInput = {
  items: Array<CorporateTaxAdjustmentItem>;
  treatUnansweredAsZero?: boolean;
};

export type LossCarryforwardInput = {
  hasBlueReturnForLossYears?: TriState;
  losses?: Array<{
      fiscalYearStartedOn: LocalDate;
      amount: Money;
    }>;
};

export type CorporateCostInput = {
  incorporationCost?: Money;
  annualAccountingFee?: Money;
  annualLaborConsultantFee?: Money;
  otherAnnualCost?: Money;
};

export type ShohizeiInput = {
  precision: "simple" | "detailed";
  taxpayerType: "individual" | "corporation";
  eligibility: ShohizeiEligibilityInput;
  sales: Array<PeriodSegment<SalesInput>>;
  purchases: Array<PeriodSegment<PurchaseInput>>;
  specialistChecks: SpecialistChecks;
  simplified?: SimplifiedTaxationInput;
};

export type ShohizeiEligibilityInput = {
  invoiceRegistration: {
      registered: TriState;
      registeredOn?: LocalDate;
      becameTaxableByRegistration?: TriState;
    };
  filings: Array<ShohizeiFilingStatus>;
  basePeriod?: {
      exists: boolean;
      taxableSales?: Money;
      lengthInMonths?: number;
    };
  specifiedPeriod?: {
      taxableSales?: Money;
      salaryPayments?: Money;
    };
  newCompany?: {
      isNewlyEstablished?: TriState;
      isSpecifiedNewlyEstablished?: TriState;
    };
  events?: {
      inheritance?: TriState;
      merger?: TriState;
      corporateSplit?: TriState;
      highValueAssetAcquisition?: TriState;
      adjustableFixedAssetAcquisition?: TriState;
    };
  taxablePeriodShortened?: TriState;
};

export type ShohizeiFilingKind = "taxable_person_election" | "taxable_person_election_cancel" | "simplified_election" | "simplified_election_cancel";

export type ShohizeiFilingStatus = {
  kind: ShohizeiFilingKind;
  filed: TriState;
  filedOn?: LocalDate;
  effectiveFromPeriodStart?: LocalDate;
};

export type ConsumptionTaxRateBand = "standard_10" | "reduced_8" | "old_8";

export type BandAmount = {
  band: ConsumptionTaxRateBand;
  amount: TaxIncl;
};

export type SimpleSalesInput = {
  kind: "simple";
  taxableTotal: TaxIncl;
  standardRatio: Rate;
  reducedRatio: Rate;
  exportExempt?: TaxIncl;
  primaryCategory?: SimplifiedBusinessCategory;
};

export type DetailedSalesInput = {
  kind: "detailed";
  taxable: Array<BandAmount>;
  exportExempt?: TaxIncl;
  nonTaxable?: TaxIncl;
  outOfScope?: TaxIncl;
  returnsAndDiscounts?: Array<BandAmount>;
  badDebts?: Array<BandAmount>;
  simplifiedCategoryBreakdown?: Array<SimplifiedCategorySales>;
};

export type SalesInput = SimpleSalesInput | DetailedSalesInput;

export type SimplePurchaseInput = {
  kind: "simple";
  taxableTotal: TaxIncl;
  hasPurchasesFromNonRegistered: TriState;
};

export type DetailedPurchaseInput = {
  kind: "detailed";
  taxableWithInvoice: Array<BandAmount>;
  taxableWithoutInvoice: Array<TransitionalPurchase>;
  nonTaxable?: TaxIncl;
  outOfScope?: TaxIncl;
  personnelCost?: Money;
  returns?: Array<BandAmount>;
};

export type PurchaseInput = SimplePurchaseInput | DetailedPurchaseInput;

export type TransitionalPurchase = {
  band: ConsumptionTaxRateBand;
  amount: TaxIncl;
  counterpartyId?: string;
  counterpartyAnnualTotal?: TaxIncl;
  hasRequiredRecords?: TriState;
};

export type SimplifiedBusinessCategory = "type1" | "type2" | "type3" | "type4" | "type5" | "type6" | "unclassifiable";

export type SimplifiedCategorySales = {
  category: SimplifiedBusinessCategory;
  amount: TaxIncl;
  band: ConsumptionTaxRateBand;
};

export type SimplifiedTaxationInput = {
  categorySelectedByUser: true;
  primaryCategory?: SimplifiedBusinessCategory;
};

export type SozokuInput = {
  level: 1 | 2 | 3;
  precision: "simple" | "detailed";
  decedent: DecedentInput;
  heirs: Array<HeirInput>;
  assets: EstateInput;
  debts: Array<DebtInput>;
  specialistChecks: SpecialistChecks;
  division?: DivisionInput;
  smallResidentialLand?: Array<SmallResidentialLandInput>;
  secondaryInheritance?: SecondaryInheritanceInput;
};

export type DecedentInput = {
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
};

export type HeirRelation = "spouse" | "child" | "adopted_child" | "special_adopted_child" | "grandchild" | "parent" | "grandparent" | "sibling_full" | "sibling_half" | "nephew_niece" | "other";

export type HeirInput = {
  id: string;
  relation: HeirRelation;
  isAlive: boolean;
  diedOn?: LocalDate;
  renounced?: TriState;
  disqualifiedOrExcluded?: TriState;
  substitutedFor?: string;
  adoptionFacts?: {
      isSpecialAdoption?: boolean;
      isStepChildOfSpouse?: boolean;
      isSubstituteForDescendant?: boolean;
    };
  isMinor?: boolean;
  ageAtInheritance?: number;
  disability?: DisabilityCategory;
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
  previousInheritanceWithin10Years?: {
      occurredOn: LocalDate;
      taxPaid: Money;
      netEstateReceived: Money;
    };
};

export type EstateInput = {
  cash?: Money;
  securities?: Money;
  businessAssets?: Money;
  otherAssets?: Money;
  realEstate?: Array<RealEstateInput>;
  lifeInsurance?: Array<BeneficiaryAmount>;
  retirementAllowance?: Array<BeneficiaryAmount>;
  giftAddback?: Array<GiftAddbackInput>;
  settlementTaxationGifts?: Money;
};

export type BeneficiaryAmount = {
  isHeir: boolean;
  amount: Money;
  beneficiaryHeirId?: string;
};

export type GiftAddbackInput = {
  giftedOn: LocalDate;
  recipientHeirId: string;
  amount: Money;
  giftTaxPaid?: Money;
};

export type RealEstateInput = {
  kind: "appraised";
  category: "land" | "building";
  value: Money;
  ownershipShare?: Share;
} | {
  kind: "screening_land";
  roadsideValuePerSqm: Money;
  areaSqm: Area;
  isMultiplierArea?: TriState;
  hasLeaseholdOrRented?: TriState;
  ownershipShare?: Share;
} | {
  kind: "screening_building";
  fixedAssetTaxValue: Money;
  ownershipShare?: Share;
};

export type DebtInput = {
  kind: "loan" | "unpaid" | "funeral" | "other";
  amount: Money;
  bearerHeirId?: string;
};

export type DivisionInput = {
  isDivided: TriState;
  acquisitions: Array<{
      heirId: string;
      share: Share;
    }>;
  dividedAfterFilingDeadline?: TriState;
  spouseAcquisitionAmount?: Money;
};

export type SmallResidentialLandCategory = "specified_residential" | "specified_business" | "specified_same_business" | "rental_business";

export type SmallResidentialLandInput = {
  realEstateIndex: number;
  category: SmallResidentialLandCategory;
  areaSqm: Area;
  acquirerHeirId: string;
  acquirerRelation: "spouse" | "cohabiting_relative" | "separate_household_relative" | "other";
  intendedAppliedAreaSqm?: Area;
  useAtInheritance?: string;
  acquirerResidesAndOwns?: TriState;
  willHoldUntilFilingDeadline?: TriState;
};

export type SecondaryInheritanceInput = {
  spouseOwnAssets: Money;
  spouseAcquisitionRatios: Array<Share>;
  expectedHeirs: Array<HeirInput>;
  yearsUntilSecondary?: number;
  annualLivingCost?: Money;
  annualAssetChangeRate?: Rate;
};

export type YakuinHoshuInput = {
  mode: "A";
} & YakuinHoshuCommonInput & ModeAInput | {
  mode: "B";
} & YakuinHoshuCommonInput & ModeBInput | {
  mode: "C";
} & YakuinHoshuCommonInput & ModeCInput;

export type YakuinHoshuCommonInput = {
  precision: "simple" | "detailed";
  officerResidenceSameAsCompany: TriState;
  capital: Money;
  healthInsurer: HealthInsurerInput;
  officer: PersonFacts;
  specialistChecks: SpecialistChecks;
  employeeCount?: number;
  spouse?: SpouseFacts;
  dependents?: Array<DependentFacts>;
  otherIncomes?: Array<IncomeItem>;
  deductions?: PersonalDeductionFacts;
  taxCredits?: {
      housingLoan?: Money;
      other?: Array<{
            code: string;
            amount: Money;
          }>;
    };
  appointedOn?: LocalDate;
  previousMonthlyAmount?: Money;
  standardRemunerationDecisionKind?: "on_qualification" | "regular" | "occasional";
};

export type ModeAInput = {
  profitBeforeOfficerCompensation: Money;
  searchStep: "10000" | "50000";
  optimizationCriterion: "min_burden" | "max_total_retained" | "max_corporate_with_floor";
  searchUpperBound?: Money;
  constraints?: {
      minPersonalNetIncome?: Money;
      minCorporateRetained?: Money;
      officerCompensationCeilingByResolution?: Money;
    };
  bonusPlan?: Array<PredeterminedBonus>;
};

export type ModeBInput = {
  desiredMonthlyNetIncome: Money;
  searchStep: "10000" | "50000";
  assumedBonusPlan?: Array<PredeterminedBonus>;
};

export type ModeCInput = {
  plan: CompensationPlan;
};

// 外部形式。bigint に対応する値は Decimal で保持する。

export type LocalDateWire = string & { readonly __localDateWire: unique symbol };

export type PrefectureCodeWire = string & { readonly __jisX0401Wire: unique symbol };

export type DateRangeWire = {
  from: LocalDateWire;
  to: LocalDateWire;
};

export type TriStateWire = "yes" | "no" | "unknown";

export type MoneyWire = {
  unit: "JPY";
  value: Decimal;
};

export type ExactWire = {
  unit: "JPY";
  num: Decimal;
  den: Decimal;
};

export type RateWire = {
  num: Decimal;
  den: Decimal;
};

export type TaxInclWire = {
  basis: "inclusive" | "exclusive";
  amount: MoneyWire;
};

export type AreaWire = {
  unit: "SQM";
  num: Decimal;
  den: Decimal;
};

export type PeriodSegmentWire<T> = {
  period: DateRangeWire;
  value: T;
};

export type IncomeCategoryWire = "business" | "real_estate" | "salary" | "dividend" | "interest" | "misc" | "capital_gain" | "occasional" | "forestry" | "retirement" | "unknown";

export type TaxationMethodWire = "aggregate" | "separate_declared" | "separate_withheld" | "separate_retirement" | "unknown";

export type IncomeItemWire = {
  category: IncomeCategoryWire;
  taxationMethod: TaxationMethodWire;
  amount: MoneyWire;
  label?: string;
};

export type DeductionOverrideWire = {
  forIncomeTax: MoneyWire;
  forResidentTax: MoneyWire;
  reason: string;
};

export type SocialInsuranceDeductionInputWire = {
  kind: "total";
  annualTotal: MoneyWire;
} | {
  kind: "itemized";
  nationalHealthInsurance?: MoneyWire;
  nationalPension?: MoneyWire;
  nationalPensionFund?: MoneyWire;
  employeeShareOfSocialInsurance?: MoneyWire;
  other?: MoneyWire;
};

export type IndividualBusinessTaxCategoryWire = "type1" | "type2" | "type3_standard" | "type3_reduced" | "not_listed" | "unknown";

export type DisabilityCategoryWire = "none" | "general" | "special" | "special_cohabiting";

export type PersonFactsWire = {
  ageAtYearEnd?: number;
  disability?: DisabilityCategoryWire;
  isNonResident?: boolean;
};

export type SpouseFactsWire = PersonFactsWire & {
  exists: boolean;
  livesTogether?: boolean;
  totalIncome?: MoneyWire;
  isFullTimeHomemaker?: TriStateWire;
};

export type DependentRelationWire = "child" | "parent" | "grandparent" | "sibling" | "other_relative";

export type DependentFactsWire = PersonFactsWire & {
  id: string;
  relation: DependentRelationWire;
  livesTogether?: boolean;
  isLivingApartAndSupported?: boolean;
  totalIncome?: MoneyWire;
};

export type LifeInsuranceContractGenerationWire = "new" | "old";

export type LifeInsurancePremiumInputWire = {
  generation: LifeInsuranceContractGenerationWire;
  category: "life" | "nursing_medical" | "annuity";
  annualPremium: MoneyWire;
};

export type EarthquakeInsurancePremiumInputWire = {
  category: "earthquake" | "old_long_term";
  annualPremium: MoneyWire;
};

export type MedicalExpenseInputWire = {
  mode: "medical" | "self_medication";
  paidAmount: MoneyWire;
  insuranceReimbursement?: MoneyWire;
};

export type DonationInputWire = {
  kind: "furusato" | "designated" | "political" | "other";
  amount: MoneyWire;
};

export type PersonalDeductionFactsWire = {
  socialInsurance?: SocialInsuranceDeductionInputWire;
  smallEnterpriseMutualAid?: MoneyWire;
  lifeInsurance?: Array<LifeInsurancePremiumInputWire>;
  earthquakeInsurance?: Array<EarthquakeInsurancePremiumInputWire>;
  medical?: MedicalExpenseInputWire;
  donations?: Array<DonationInputWire>;
  casualtyLoss?: MoneyWire;
  isWorkingStudent?: boolean;
  widowOrSingleParent?: "none" | "widow" | "single_parent";
  overrides?: Array<DeductionOverrideWire>;
};

export type BusinessPeriodFactsWire = {
  openedOn?: LocalDateWire;
  closedOn?: LocalDateWire;
};

export type CompensationPlanWire = {
  monthlySegments: Array<PeriodSegmentWire<{
      monthlyAmount: MoneyWire;
    }>>;
  revisions?: Array<CompensationRevisionWire>;
  bonuses?: Array<PredeterminedBonusWire>;
  appointedOn?: LocalDateWire;
  resignedOn?: LocalDateWire;
};

export type RevisionReasonWire = "ordinary" | "extraordinary" | "performance_decline" | "other";

export type CompensationRevisionWire = {
  effectiveOn: LocalDateWire;
  reason: RevisionReasonWire;
  newMonthlyAmount: MoneyWire;
};

export type PredeterminedBonusWire = {
  payOn: LocalDateWire;
  amount: MoneyWire;
  hasFiling: TriStateWire;
  filedOn?: LocalDateWire;
  paidAsFiled?: TriStateWire;
};

export type HealthInsurerInputWire = {
  kind: "kyokai_kenpo";
  prefectureCode: PrefectureCodeWire;
} | {
  kind: "kenpo_kumiai";
  insurerCode: string;
} | {
  kind: "none";
} | {
  kind: "unknown";
};

export type ShareWire = RateWire;

export type SpecialistChecksWire = Partial<Record<string, TriStateWire>>;

export type HojinnariInputWire = {
  precision: "simple" | "detailed";
  comparisonBasis: "steady_state" | "transition_year";
  individual: HojinnariIndividualInputWire;
  corporate: HojinnariCorporateInputWire;
  consumptionTax: {
      include: false;
    } | {
      include: true;
      individualPeriodInput: ShohizeiInputWire;
      corporatePeriodInput: ShohizeiInputWire;
    };
  specialistChecks: SpecialistChecksWire;
  setupAndMaintenanceCosts?: CorporateCostInputWire;
};

export type HojinnariIndividualInputWire = {
  business: {
      revenue: Array<PeriodSegmentWire<MoneyWire>>;
      expenses: Array<PeriodSegmentWire<MoneyWire>>;
      periodFacts: BusinessPeriodFactsWire;
      expensesExcludeSocialInsuranceAndMutualAid?: TriStateWire;
      businessTaxCategory?: IndividualBusinessTaxCategoryWire;
    };
  blueReturn: {
      status: "blue" | "white" | "unknown";
      specialDeductionCategory?: "e_tax_650k" | "bookkeeping_550k" | "simple_100k" | "none";
    };
  self: PersonFactsWire;
  residentTaxBasis: "steady_state" | "actual_year";
  otherIncomes?: Array<IncomeItemWire>;
  deductions?: PersonalDeductionFactsWire;
  spouse?: SpouseFactsWire;
  dependents?: Array<DependentFactsWire>;
  nationalHealthInsurance?: NationalHealthInsuranceInputWire;
  nationalPension?: NationalPensionInputWire;
  taxCredits?: {
      housingLoan?: MoneyWire;
      other?: Array<{
            code: string;
            amount: MoneyWire;
          }>;
    };
};

export type NationalHealthInsuranceInputWire = {
  kind: "actual";
  annualAmount: MoneyWire;
} | {
  kind: "estimate_accepted";
} | {
  kind: "unknown";
};

export type NationalPensionInputWire = {
  kind: "actual";
  annualAmount: MoneyWire;
} | {
  kind: "standard";
  months: number;
  hasAdditionalPremium?: boolean;
} | {
  kind: "exempted";
} | {
  kind: "unknown";
};

export type HojinnariCorporateInputWire = {
  locationSameAsResidence: TriStateWire;
  capital: MoneyWire;
  officerCompensation: CompensationPlanWire;
  healthInsurer: HealthInsurerInputWire;
  revenue: Array<PeriodSegmentWire<MoneyWire>>;
  expenses: Array<PeriodSegmentWire<MoneyWire>>;
  employeeCount?: number;
  establishedOn?: LocalDateWire;
  spouseOfficer?: {
      isOfficer: boolean;
      compensation?: CompensationPlanWire;
      facts?: PersonFactsWire;
    };
  taxAdjustments?: CorporateTaxAdjustmentInputWire;
  lossCarryforward?: LossCarryforwardInputWire;
};

export type CorporateTaxAdjustmentItemWire = {
  code: "entertainment" | "donation" | "depreciation" | "allowance" | "taxes_and_dues" | "officer_salary" | "dividend_received" | "other";
  applies: TriStateWire;
  amount?: MoneyWire;
  direction?: "add" | "subtract";
};

export type CorporateTaxAdjustmentInputWire = {
  items: Array<CorporateTaxAdjustmentItemWire>;
  treatUnansweredAsZero?: boolean;
};

export type LossCarryforwardInputWire = {
  hasBlueReturnForLossYears?: TriStateWire;
  losses?: Array<{
      fiscalYearStartedOn: LocalDateWire;
      amount: MoneyWire;
    }>;
};

export type CorporateCostInputWire = {
  incorporationCost?: MoneyWire;
  annualAccountingFee?: MoneyWire;
  annualLaborConsultantFee?: MoneyWire;
  otherAnnualCost?: MoneyWire;
};

export type ShohizeiInputWire = {
  precision: "simple" | "detailed";
  taxpayerType: "individual" | "corporation";
  eligibility: ShohizeiEligibilityInputWire;
  sales: Array<PeriodSegmentWire<SalesInputWire>>;
  purchases: Array<PeriodSegmentWire<PurchaseInputWire>>;
  specialistChecks: SpecialistChecksWire;
  simplified?: SimplifiedTaxationInputWire;
};

export type ShohizeiEligibilityInputWire = {
  invoiceRegistration: {
      registered: TriStateWire;
      registeredOn?: LocalDateWire;
      becameTaxableByRegistration?: TriStateWire;
    };
  filings: Array<ShohizeiFilingStatusWire>;
  basePeriod?: {
      exists: boolean;
      taxableSales?: MoneyWire;
      lengthInMonths?: number;
    };
  specifiedPeriod?: {
      taxableSales?: MoneyWire;
      salaryPayments?: MoneyWire;
    };
  newCompany?: {
      isNewlyEstablished?: TriStateWire;
      isSpecifiedNewlyEstablished?: TriStateWire;
    };
  events?: {
      inheritance?: TriStateWire;
      merger?: TriStateWire;
      corporateSplit?: TriStateWire;
      highValueAssetAcquisition?: TriStateWire;
      adjustableFixedAssetAcquisition?: TriStateWire;
    };
  taxablePeriodShortened?: TriStateWire;
};

export type ShohizeiFilingKindWire = "taxable_person_election" | "taxable_person_election_cancel" | "simplified_election" | "simplified_election_cancel";

export type ShohizeiFilingStatusWire = {
  kind: ShohizeiFilingKindWire;
  filed: TriStateWire;
  filedOn?: LocalDateWire;
  effectiveFromPeriodStart?: LocalDateWire;
};

export type ConsumptionTaxRateBandWire = "standard_10" | "reduced_8" | "old_8";

export type BandAmountWire = {
  band: ConsumptionTaxRateBandWire;
  amount: TaxInclWire;
};

export type SimpleSalesInputWire = {
  kind: "simple";
  taxableTotal: TaxInclWire;
  standardRatio: RateWire;
  reducedRatio: RateWire;
  exportExempt?: TaxInclWire;
  primaryCategory?: SimplifiedBusinessCategoryWire;
};

export type DetailedSalesInputWire = {
  kind: "detailed";
  taxable: Array<BandAmountWire>;
  exportExempt?: TaxInclWire;
  nonTaxable?: TaxInclWire;
  outOfScope?: TaxInclWire;
  returnsAndDiscounts?: Array<BandAmountWire>;
  badDebts?: Array<BandAmountWire>;
  simplifiedCategoryBreakdown?: Array<SimplifiedCategorySalesWire>;
};

export type SalesInputWire = SimpleSalesInputWire | DetailedSalesInputWire;

export type SimplePurchaseInputWire = {
  kind: "simple";
  taxableTotal: TaxInclWire;
  hasPurchasesFromNonRegistered: TriStateWire;
};

export type DetailedPurchaseInputWire = {
  kind: "detailed";
  taxableWithInvoice: Array<BandAmountWire>;
  taxableWithoutInvoice: Array<TransitionalPurchaseWire>;
  nonTaxable?: TaxInclWire;
  outOfScope?: TaxInclWire;
  personnelCost?: MoneyWire;
  returns?: Array<BandAmountWire>;
};

export type PurchaseInputWire = SimplePurchaseInputWire | DetailedPurchaseInputWire;

export type TransitionalPurchaseWire = {
  band: ConsumptionTaxRateBandWire;
  amount: TaxInclWire;
  counterpartyId?: string;
  counterpartyAnnualTotal?: TaxInclWire;
  hasRequiredRecords?: TriStateWire;
};

export type SimplifiedBusinessCategoryWire = "type1" | "type2" | "type3" | "type4" | "type5" | "type6" | "unclassifiable";

export type SimplifiedCategorySalesWire = {
  category: SimplifiedBusinessCategoryWire;
  amount: TaxInclWire;
  band: ConsumptionTaxRateBandWire;
};

export type SimplifiedTaxationInputWire = {
  categorySelectedByUser: true;
  primaryCategory?: SimplifiedBusinessCategoryWire;
};

export type SozokuInputWire = {
  level: 1 | 2 | 3;
  precision: "simple" | "detailed";
  decedent: DecedentInputWire;
  heirs: Array<HeirInputWire>;
  assets: EstateInputWire;
  debts: Array<DebtInputWire>;
  specialistChecks: SpecialistChecksWire;
  division?: DivisionInputWire;
  smallResidentialLand?: Array<SmallResidentialLandInputWire>;
  secondaryInheritance?: SecondaryInheritanceInputWire;
};

export type DecedentInputWire = {
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
};

export type HeirRelationWire = "spouse" | "child" | "adopted_child" | "special_adopted_child" | "grandchild" | "parent" | "grandparent" | "sibling_full" | "sibling_half" | "nephew_niece" | "other";

export type HeirInputWire = {
  id: string;
  relation: HeirRelationWire;
  isAlive: boolean;
  diedOn?: LocalDateWire;
  renounced?: TriStateWire;
  disqualifiedOrExcluded?: TriStateWire;
  substitutedFor?: string;
  adoptionFacts?: {
      isSpecialAdoption?: boolean;
      isStepChildOfSpouse?: boolean;
      isSubstituteForDescendant?: boolean;
    };
  isMinor?: boolean;
  ageAtInheritance?: number;
  disability?: DisabilityCategoryWire;
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
  previousInheritanceWithin10Years?: {
      occurredOn: LocalDateWire;
      taxPaid: MoneyWire;
      netEstateReceived: MoneyWire;
    };
};

export type EstateInputWire = {
  cash?: MoneyWire;
  securities?: MoneyWire;
  businessAssets?: MoneyWire;
  otherAssets?: MoneyWire;
  realEstate?: Array<RealEstateInputWire>;
  lifeInsurance?: Array<BeneficiaryAmountWire>;
  retirementAllowance?: Array<BeneficiaryAmountWire>;
  giftAddback?: Array<GiftAddbackInputWire>;
  settlementTaxationGifts?: MoneyWire;
};

export type BeneficiaryAmountWire = {
  isHeir: boolean;
  amount: MoneyWire;
  beneficiaryHeirId?: string;
};

export type GiftAddbackInputWire = {
  giftedOn: LocalDateWire;
  recipientHeirId: string;
  amount: MoneyWire;
  giftTaxPaid?: MoneyWire;
};

export type RealEstateInputWire = {
  kind: "appraised";
  category: "land" | "building";
  value: MoneyWire;
  ownershipShare?: ShareWire;
} | {
  kind: "screening_land";
  roadsideValuePerSqm: MoneyWire;
  areaSqm: AreaWire;
  isMultiplierArea?: TriStateWire;
  hasLeaseholdOrRented?: TriStateWire;
  ownershipShare?: ShareWire;
} | {
  kind: "screening_building";
  fixedAssetTaxValue: MoneyWire;
  ownershipShare?: ShareWire;
};

export type DebtInputWire = {
  kind: "loan" | "unpaid" | "funeral" | "other";
  amount: MoneyWire;
  bearerHeirId?: string;
};

export type DivisionInputWire = {
  isDivided: TriStateWire;
  acquisitions: Array<{
      heirId: string;
      share: ShareWire;
    }>;
  dividedAfterFilingDeadline?: TriStateWire;
  spouseAcquisitionAmount?: MoneyWire;
};

export type SmallResidentialLandCategoryWire = "specified_residential" | "specified_business" | "specified_same_business" | "rental_business";

export type SmallResidentialLandInputWire = {
  realEstateIndex: number;
  category: SmallResidentialLandCategoryWire;
  areaSqm: AreaWire;
  acquirerHeirId: string;
  acquirerRelation: "spouse" | "cohabiting_relative" | "separate_household_relative" | "other";
  intendedAppliedAreaSqm?: AreaWire;
  useAtInheritance?: string;
  acquirerResidesAndOwns?: TriStateWire;
  willHoldUntilFilingDeadline?: TriStateWire;
};

export type SecondaryInheritanceInputWire = {
  spouseOwnAssets: MoneyWire;
  spouseAcquisitionRatios: Array<ShareWire>;
  expectedHeirs: Array<HeirInputWire>;
  yearsUntilSecondary?: number;
  annualLivingCost?: MoneyWire;
  annualAssetChangeRate?: RateWire;
};

export type YakuinHoshuInputWire = {
  mode: "A";
} & YakuinHoshuCommonInputWire & ModeAInputWire | {
  mode: "B";
} & YakuinHoshuCommonInputWire & ModeBInputWire | {
  mode: "C";
} & YakuinHoshuCommonInputWire & ModeCInputWire;

export type YakuinHoshuCommonInputWire = {
  precision: "simple" | "detailed";
  officerResidenceSameAsCompany: TriStateWire;
  capital: MoneyWire;
  healthInsurer: HealthInsurerInputWire;
  officer: PersonFactsWire;
  specialistChecks: SpecialistChecksWire;
  employeeCount?: number;
  spouse?: SpouseFactsWire;
  dependents?: Array<DependentFactsWire>;
  otherIncomes?: Array<IncomeItemWire>;
  deductions?: PersonalDeductionFactsWire;
  taxCredits?: {
      housingLoan?: MoneyWire;
      other?: Array<{
            code: string;
            amount: MoneyWire;
          }>;
    };
  appointedOn?: LocalDateWire;
  previousMonthlyAmount?: MoneyWire;
  standardRemunerationDecisionKind?: "on_qualification" | "regular" | "occasional";
};

export type ModeAInputWire = {
  profitBeforeOfficerCompensation: MoneyWire;
  searchStep: "10000" | "50000";
  optimizationCriterion: "min_burden" | "max_total_retained" | "max_corporate_with_floor";
  searchUpperBound?: MoneyWire;
  constraints?: {
      minPersonalNetIncome?: MoneyWire;
      minCorporateRetained?: MoneyWire;
      officerCompensationCeilingByResolution?: MoneyWire;
    };
  bonusPlan?: Array<PredeterminedBonusWire>;
};

export type ModeBInputWire = {
  desiredMonthlyNetIncome: MoneyWire;
  searchStep: "10000" | "50000";
  assumedBonusPlan?: Array<PredeterminedBonusWire>;
};

export type ModeCInputWire = {
  plan: CompensationPlanWire;
};
