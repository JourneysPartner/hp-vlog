# 入力型設計書

税務シミュレーター共通基盤・4ツールの入力型（`HojinnariInput` / `ShohizeiInput` / `SozokuInput` / `YakuinHoshuInput`）を定義する。

作成日: 2026-08-25
対象仕様: `tax-simulator-spec-reviewed-final.md`（全72節）
対象マスター: `data/tax-simulator/masters/`（506レコード / 28ファイル / 95 `value_key`）

---

## 1. この文書の位置付け

### 1-1. なぜ別文書にするか

仕様書 §7-1 は次の4つを宣言している。

```ts
declare const hojinnariSimulator: SimulatorService<HojinnariInput>;
declare const shohizeiSimulator: SimulatorService<ShohizeiInput>;
declare const sozokuSimulator: SimulatorService<SozokuInput>;
declare const yakuinHoshuSimulator: SimulatorService<YakuinHoshuInput>;
```

この4つの型は仕様書のどこにも定義されていない。入力項目は §9・§15-20・§25-32・§37/43/44 に日本語の箇条書きで書かれているだけで、型としては空白のままになっている。

仕様書本体は5ラウンドの相互レビューを経て確定しているため、本体を書き換えずに済むよう別文書とする。本書が確定した後、仕様書 §7-1 から本書への参照を1行追加する。

### 1-2. 本書が決めること

- 4つの入力型の完全な構造
- 未入力・該当なし・0円・判定不能をそれぞれどう表すか
- 仕様書が禁じている入力（年額の月割按分、税込税抜の一括推定、所得区分不明の合算、所得税と住民税の控除額の共通化）を型で防ぐ方法
- 入力フィールドとマスター `value_key` の対応表（§52-3 の公開ゲートの絞り込みに使う）
- `validate` と `simulate` の責務境界

### 1-3. 本書が決めないこと

- 画面のSTEP分割・ウィザードの順序（§4・§61-1 の領域）
- 出力型（仕様書 §7 で確定済み）
- 計算アルゴリズム（仕様書 §10・§28-1・§38 の領域）
- マスターの索引構造（§7-1 が「実装に委ねる」としている）

---

## 2. 設計原則

### 2-1. 欠損は `undefined`、`null` を使わない

未入力は省略可能プロパティ（`?:`）で表す。`null` は使わない。

理由。仕様書 §5 は不足値を「`blocked` → 追加質問 → 範囲 → `partial`」の順で扱うと定めており、`simulate` は欠損を受け取れなければならない（§7-1「不足値は `I` の欠損として `simulate` へ渡し」）。`null` と `undefined` の両方を許すと「未入力」の表現が2通りになり、判定分岐が二重になる。

3つの状態を型で区別する。

| 状態 | 表現 | 意味 |
| --- | --- | --- |
| 未入力 | プロパティ省略 | ユーザーがまだ答えていない |
| 該当なし | `TriState = "no"` | 質問に「無い」と答えた |
| 分からない | `TriState = "unknown"` | 質問に「分からない」と答えた |
| 0円 | `{ unit: "JPY", value: 0n }` | 金額として0円 |

```ts
type TriState = "yes" | "no" | "unknown";
```

`TriState` 自体を省略可能にすることで4状態（未回答 / yes / no / unknown）を持つ。「未回答」と「分からないと回答」は追加質問の出し分けで意味が違うため、統合しない。

### 2-2. 金額は `Money`、税込税抜は `TaxIncl`

仕様書 §3-3 の型をそのまま使う。入力型に `number` を持たせない。

```ts
type Money   = { unit: "JPY"; value: bigint };
type TaxIncl = { basis: "inclusive" | "exclusive"; amount: Money };
```

消費税シミュレーターの売上・仕入は必ず `TaxIncl` とする。§16 が「税込・税抜の選択は入力全体で一括推定せず、税率・取引区分ごとに保持する」と定めているため、金額1件ごとに `basis` を持たせる。入力フォーム全体に1個の税込/税抜トグルを置いて内部で全項目へ適用する実装は、この型では書けない。

### 2-3. 期間で分かれる金額は配列にし、年額を持たせない

年額フィールドを持つと按分実装を誘発する。仕様書は3箇所で年額按分を明示的に禁じている。

- §10「売上・経費は年額を月割按分せず、期間帰属で分けて入力させ、同一金額を個人側と法人側の双方へ計上しない」
- §18「年間金額を単純按分してはいけない」
- §38「期中改定を含む事業年度で年額を月額×12として計算しない」

期間で割れうる金額は、単一の `Money` ではなく次の型の配列で持つ。

```ts
interface PeriodSegment<T> {
  period: DateRange;   // 閉区間（§3-2）
  value: T;
}
```

配列の各要素は重ならず、隙間なく対象期間を覆うこと。この不変条件は `validate` で検査する（§9-2）。年額しか分からないユーザーには、UIが分割を促すか、`blocked` とする。

### 2-4. 所得は区分と課税方式を必ず持つ

仕様書 §10 が明示している。

> 「その他所得」を単一の金額として総所得へ加算しない。分離課税の所得を総合課税の課税標準へ混入させると、税率、住民税、付加税の基数が同時に壊れる。入力は所得区分と課税方式を必須項目とし、区分不明の所得がある場合は `resultStatus: "blocked"` とする。

```ts
type IncomeCategory =
  | "business"        // 事業所得
  | "real_estate"     // 不動産所得
  | "salary"          // 給与所得
  | "dividend"        // 配当所得
  | "interest"        // 利子所得
  | "misc"            // 雑所得
  | "capital_gain"    // 譲渡所得
  | "occasional"      // 一時所得
  | "forestry"        // 山林所得
  | "retirement"      // 退職所得
  | "unknown";        // 区分が分からない → simulate が blocked にする

type TaxationMethod =
  | "aggregate"            // 総合課税
  | "separate_declared"    // 申告分離課税
  | "separate_withheld"    // 源泉分離課税
  | "separate_retirement"  // 退職所得の分離課税
  | "unknown";

interface IncomeItem {
  label?: string;
  category: IncomeCategory;       // 必須。省略できない
  taxationMethod: TaxationMethod; // 必須。省略できない
  amount: Money;                  // 所得金額。収入金額を入れない（§11-3 の決定）
}
```

`amount` は必ず**所得金額**（必要経費・給与所得控除・公的年金等控除を引いた後）とする。収入金額を受け取れる余地を型に残さない。確定申告書・源泉徴収票から転記できる数字に統一し、収入金額から所得金額を求める計算をシミュレーター側に持たせない。

UIには「必要経費を引いた後の金額を入れてください」と明示し、給与・公的年金の欄では源泉徴収票のどの欄を見ればよいかを示す。書類が手元に無いユーザーは §5 の判定順に従い、追加質問または `blocked` で扱う。推定した所得金額を暗黙に代入しない。

`"unknown"` を型から排除しない。排除するとUIに「分からない」の選択肢を置けず、ユーザーが当てずっぽうで区分を選ぶ。`simulate` が `"unknown"` を見て `blocked` を返す設計にする（§9-1）。

### 2-5. 所得控除は「控除額」ではなく「事実」を入力する

仕様書 §9 が「所得控除の内訳（所得税用・住民税用を共通額とみなさない）」、§10 が「所得税と住民税で控除額・要件が異なるものは税目別マスターを選択する」と定めている。

控除額そのものを入力させると、その1つの数字が所得税と住民税の両方へ流れ、必ず「共通額とみなす」実装になる。したがって入力するのは事実（同居の有無、年齢、支払保険料額、障害の区分）とし、控除額はマスターから税目別に引く。

マスターは既にこの構造で用意してある。

| 事実 | 所得税の `value_key` | 住民税の `value_key` |
| --- | --- | --- |
| 配偶者（合計所得48万以下） | `income_deduction_spouse` | `resident_tax_deduction_spouse` |
| 配偶者（48万超133万以下） | `income_deduction_spouse_special` | `resident_tax_deduction_spouse_special` |
| 扶養親族 | `income_deduction_dependent` | `resident_tax_deduction_dependent` |
| 特定親族 | `income_deduction_specific_relative_special` | `resident_tax_deduction_specific_relative_special` |
| 障害者 | `income_deduction_disability` | `resident_tax_deduction_disability` |
| 寡婦 | `income_deduction_widow` | `resident_tax_deduction_widow` |
| ひとり親 | `income_deduction_single_parent` | `resident_tax_deduction_single_parent` |
| 勤労学生 | `income_deduction_working_student` | `resident_tax_deduction_working_student` |
| 基礎控除 | `basic_deduction_table` | `resident_tax_basic_deduction_table` |

例外として、源泉徴収票や確定申告書から控除額を転記したいユーザーのために直接入力を許す場合は、**所得税用と住民税用を必須ペアの2フィールド**にする。片方だけの入力を型で拒否する。

```ts
interface DeductionOverride {
  forIncomeTax: Money;
  forResidentTax: Money;   // 省略可能にしない
  reason: string;
}
```

### 2-6. 合計入力と内訳入力は判別可能ユニオンで排他にする

仕様書 §9 が「社会保険料控除、配偶者・扶養関係等は合計額入力と内訳入力を排他的にし、二重控除を防ぐ」と定めている。省略可能プロパティを並べる方式では、両方入力された状態が型として成立してしまう。

```ts
type SocialInsuranceDeductionInput =
  | { kind: "total"; annualTotal: Money }
  | {
      kind: "itemized";
      nationalHealthInsurance?: Money;
      nationalPension?: Money;
      nationalPensionFund?: Money;
      employeeShareOfSocialInsurance?: Money;
      other?: Money;
    };
```

### 2-7. 列挙型を「その他」で締めない

仕様書 §10 が「税目の列挙を『その他現行法人課税』で締めない。適用し得る法人課税を列挙型で固定し」と定めている。入力側の業種区分・事業区分も同様に扱う。

個人事業税の業種区分は、マスターの `business_category` と**同じ文字列**にする。入力値とマスターの区分値が別体系だと変換表が必要になり、変換表が古くなったときに黙って誤った税率を引く。

```ts
// data/tax-simulator/masters/data/business-tax/individual-business-tax.json の
// business_category と同じ値集合にする
type IndividualBusinessTaxCategory =
  | "type1"           // 第1種事業 5%
  | "type2"           // 第2種事業 4%
  | "type3_standard"  // 第3種事業（一般）5%
  | "type3_reduced"   // 第3種事業（あん摩等・装蹄師業）3%
  | "not_listed"      // 法定業種でない → 課税されない
  | "unknown";        // 判定できない → blocked
```

`"not_listed"`（課税されない）と `"unknown"`（判定できない）を統合しない。前者は税額0円で `complete`、後者は `blocked` であり、結果が正反対になる。

### 2-8. 対応プロフィール外の検知項目を入力に持つ

仕様書 §68-1 は各ツールの「専門判定へ送る代表例」を表で定めている。これを検知するには、該当有無を尋ねる入力が要る。検知フラグは全ツール共通の形にする。

```ts
// キーは §7 の ExcludedItem.code と同じ体系。
// キーが無い＝未回答。§2-1 の「欠損はプロパティの省略で表す」と同じ方式に揃える
type SpecialistChecks = Partial<Record<string, TriState>>;
```

カタログ（対象コードの全件）はシミュレーターごとの定数として固定し、入力内容で増減させない（§5「対象項目数はシミュレーターごとに固定した項目カタログの件数とし、入力内容で増減させない」）。入力型はカタログを持たず、回答だけを持つ。カタログに無いキーが入力に現れた場合は `validate` で拒否する。

### 2-9. 入力型に結果・PIIを持たせない

- 氏名、住所（番地）、生年月日、マイナンバー、口座情報を入力型に持たない。年齢は満年齢の整数、住所は `Jurisdiction` のコードだけで足りる。相続シミュレーターの相続人も、氏名ではなく識別子と続柄だけを持つ。
- 送信元シミュレーターが算出した税額・手取り・有利不利を入力型へ受け取らない（§13-1「受け側は渡された値を再計算の入力としてのみ用い、送信元が算出した税額・手取り・有利不利を自らの結果へ転記しない」）。`Handoff.fields` から入力型へ写せるのは事実値だけとする。

---

## 3. 共通部品型

4つの入力型が共有する部品。

```ts
// ---- 人 ------------------------------------------------------------------

type DisabilityCategory = "none" | "general" | "special" | "special_cohabiting";
// special_cohabiting は同居特別障害者。所得税・住民税とも控除額が別レコード

interface PersonFacts {
  ageAtYearEnd?: number;             // その年12月31日時点の満年齢
  disability?: DisabilityCategory;
  isNonResident?: boolean;           // 非居住者 → §68-1 により専門判定
}

interface SpouseFacts extends PersonFacts {
  exists: boolean;
  livesTogether?: boolean;
  totalIncome?: Money;               // 配偶者の合計所得金額。配偶者控除・配偶者特別控除の判定に使う
  isFullTimeHomemaker?: TriState;
}

type DependentRelation = "child" | "parent" | "grandparent" | "sibling" | "other_relative";

interface DependentFacts extends PersonFacts {
  id: string;                        // 画面内で一意。氏名を入れない
  relation: DependentRelation;
  livesTogether?: boolean;
  isLivingApartAndSupported?: boolean; // 老人扶養親族の同居老親等の判定に使う
  totalIncome?: Money;               // 特定親族特別控除の判定に使う
}

// ---- 所得控除 -------------------------------------------------------------

type LifeInsuranceContractGeneration = "new" | "old";   // 新契約=H24.1.1以後

interface LifeInsurancePremiumInput {
  generation: LifeInsuranceContractGeneration;
  category: "life" | "nursing_medical" | "annuity";
  annualPremium: Money;
}
// nursing_medical は新契約にのみ存在する。旧契約と組み合わせた入力は validate で拒否する

interface EarthquakeInsurancePremiumInput {
  category: "earthquake" | "old_long_term";
  annualPremium: Money;
}

interface MedicalExpenseInput {
  mode: "medical" | "self_medication";  // 併用できない。選択制
  paidAmount: Money;
  insuranceReimbursement?: Money;
}

interface PersonalDeductionFacts {
  socialInsurance?: SocialInsuranceDeductionInput;   // §2-6
  smallEnterpriseMutualAid?: Money;                  // 小規模企業共済・iDeCo等
  lifeInsurance?: LifeInsurancePremiumInput[];
  earthquakeInsurance?: EarthquakeInsurancePremiumInput[];
  medical?: MedicalExpenseInput;
  donations?: DonationInput[];
  casualtyLoss?: Money;                              // 雑損控除
  isWorkingStudent?: boolean;
  widowOrSingleParent?: "none" | "widow" | "single_parent";
  overrides?: DeductionOverride[];                   // §2-5
}

interface DonationInput {
  kind: "furusato" | "designated" | "political" | "other";
  amount: Money;
}

// ---- 事業の期間 -----------------------------------------------------------

interface BusinessPeriodFacts {
  openedOn?: LocalDate;      // 開業日
  closedOn?: LocalDate;      // 廃業日。個人事業税の事業主控除の月割に使う
}

// ---- 役員報酬の支給計画 ---------------------------------------------------

// §38「探索の候補は『支給月額』ではなく『事業年度を通じた支給計画』とする」
interface CompensationPlan {
  monthlySegments: PeriodSegment<{ monthlyAmount: Money }>[];  // §2-3
  revisions?: CompensationRevision[];
  bonuses?: PredeterminedBonus[];
  appointedOn?: LocalDate;      // 役員就任日
  resignedOn?: LocalDate;
}

type RevisionReason =
  | "ordinary"            // 通常改定（事業年度開始から一定期間内）
  | "extraordinary"       // 臨時改定事由
  | "performance_decline" // 業績悪化改定事由
  | "other";              // その他 → 損金不算入の可能性。blocked または専門判定

interface CompensationRevision {
  effectiveOn: LocalDate;
  reason: RevisionReason;
  newMonthlyAmount: Money;
}

interface PredeterminedBonus {
  payOn: LocalDate;
  amount: Money;
  hasFiling: TriState;        // 事前確定届出給与の届出の有無
  filedOn?: LocalDate;
  paidAsFiled?: TriState;     // 届出どおりに支給する予定か
}

// ---- 保険者 ---------------------------------------------------------------

type HealthInsurerInput =
  | { kind: "kyokai_kenpo"; prefectureCode: PrefectureCode }
  | { kind: "kenpo_kumiai"; insurerCode: string }   // 料率は未登録 → blocked
  | { kind: "none" }                                 // 国民健康保険
  | { kind: "unknown" };

// ---- 持分・割合 -----------------------------------------------------------

// §3-3「外部形式にJavaScriptの number と指数表記を使わない」。
// 持分・取得割合は独自の { num: number; den: number } を作らず Rate を使う
type Share = Rate;   // { num: bigint; den: bigint }

// ---- 専門判定 -------------------------------------------------------------

type SpecialistChecks = Partial<Record<string, TriState>>;
```

---

## 4. ① `HojinnariInput`（法人成り・法人化損得）

対象: 仕様書 §9・§10・§11・§12・§13

```ts
interface HojinnariInput {
  precision: "simple" | "detailed";              // §7 の SimulationResult.precision と同じ値集合
  comparisonBasis: "steady_state" | "transition_year";  // §7 と同じ

  individual: HojinnariIndividualInput;
  corporate: HojinnariCorporateInput;

  // §12 既定 OFF。ON のとき ② のエンジンを呼ぶ
  consumptionTax:
    | { include: false }
    | {
        include: true;
        individualPeriodInput: ShohizeiInput;   // 個人事業期間の課税期間
        corporatePeriodInput: ShohizeiInput;    // 法人の課税期間
      };
  // 法人成り年は個人と法人で課税期間が別々に立つため、②の入力も2本必要になる。
  // ①の simulate が ②を呼ぶときは、CalculationContext を課税期間ごとに組み直す
  // （§13-1「受け側は calculationContext 内の…期間の一致を検証する」）。
  // 呼び出し規則は §11-7 で未決。

  setupAndMaintenanceCosts?: CorporateCostInput; // §11 未入力時は比較対象外。金額を仮定しない
  specialistChecks: SpecialistChecks;           // §68-1
}
```

### 4-1. 個人側

```ts
interface HojinnariIndividualInput {
  // 自治体は CalculationContext.jurisdiction を使う。入力型に持たない（§11-1 の決定）
  business: {
    revenue: PeriodSegment<Money>[];        // §2-3。法人成り年は個人期間だけを入れる
    expenses: PeriodSegment<Money>[];
    expensesExcludeSocialInsuranceAndMutualAid?: TriState;
    // ↑ §10「必要経費の内訳に社会保険料・掛金が含まれていないことを確認する質問を置く」
    periodFacts: BusinessPeriodFacts;
    businessTaxCategory?: IndividualBusinessTaxCategory;   // §2-7
  };

  blueReturn: {
    status: "blue" | "white" | "unknown";
    specialDeductionCategory?: "e_tax_650k" | "bookkeeping_550k" | "simple_100k" | "none";
    // 要件を確認せずに最大額を適用しない（§10）。unknown のときは none として計算せず追加質問
  };

  otherIncomes?: IncomeItem[];               // §2-4
  deductions?: PersonalDeductionFacts;       // §2-5
  spouse?: SpouseFacts;
  dependents?: DependentFacts[];

  self: PersonFacts;
  // 省略可能にしない。§9 のかんたん計算に「年齢」が入っており、年齢は
  // 介護保険（40歳到達月）、厚生年金（70歳）、健康保険（75歳で後期高齢者へ移行）の
  // 判定を変える。省略可能にすると「未入力＝40歳未満」として計算する実装を誘発する。
  // ageAtYearEnd 自体は PersonFacts で省略可能とし、未入力は §5 の判定順で扱う

  nationalHealthInsurance?: NationalHealthInsuranceInput;
  nationalPension?: NationalPensionInput;

  residentTaxBasis: "steady_state" | "actual_year";
  // §9「住民税の計算対象（平年度ベース / 実際の対象年）」
  // §10「住民税は原則として前年所得に基づくため、平年度比較と年次キャッシュフロー比較を分ける」

  taxCredits?: {
    housingLoan?: Money;      // §9「税額控除は課税所得の前ではなく、税率適用後の専用モジュールで扱う」
    other?: { code: string; amount: Money }[];
  };
}

// §9 の優先順位（1. 実額入力 2. 未入力なら概算 3. 将来 市区町村別計算）を型で表す
type NationalHealthInsuranceInput =
  | { kind: "actual"; annualAmount: Money }
  | { kind: "estimate_accepted" }   // ユーザーが概算の使用を明示選択した（§5「推定値を使う場合はユーザーが明示選択し」）
  | { kind: "unknown" };

type NationalPensionInput =
  | { kind: "actual"; annualAmount: Money }
  | { kind: "standard"; months: number; hasAdditionalPremium?: boolean }  // 定額保険料 × 月数
  | { kind: "exempted" }
  | { kind: "unknown" };
```

### 4-2. 法人側

```ts
interface HojinnariCorporateInput {
  // 自治体は CalculationContext.jurisdiction（＝個人の住所地）を共用する。
  // 本店所在地が住所地と違う場合はこのフラグで検知し、法人の地方税を
  // 標準税率による概算へ切り替えて partial とする（§11-1 の決定）
  locationSameAsResidence: TriState;

  capital: Money;
  employeeCount?: number;
  establishedOn?: LocalDate;     // 設立予定日
  // 事業年度は CalculationContext.fiscalPeriod を使う。入力型に重複して持たない

  officerCompensation: CompensationPlan;         // 本人
  spouseOfficer?: {
    isOfficer: boolean;
    compensation?: CompensationPlan;
    facts?: PersonFacts;
  };

  healthInsurer: HealthInsurerInput;

  revenue: PeriodSegment<Money>[];
  expenses: PeriodSegment<Money>[];   // 役員報酬・会社負担社会保険を含まない

  taxAdjustments?: CorporateTaxAdjustmentInput;
  lossCarryforward?: LossCarryforwardInput;
}

// §10「会計利益をそのまま法人所得として扱わない。…該当有無を質問し、
//      税額へ影響する金額が不明なら blocked、影響範囲を分離して示せる場合だけ partial」
interface CorporateTaxAdjustmentItem {
  code: "entertainment" | "donation" | "depreciation" | "allowance"
      | "taxes_and_dues" | "officer_salary" | "dividend_received" | "other";
  applies: TriState;
  amount?: Money;               // applies="yes" で amount 未入力 → blocked
  direction?: "add" | "subtract";
}

interface CorporateTaxAdjustmentInput {
  items: CorporateTaxAdjustmentItem[];
  treatUnansweredAsZero?: boolean;
  // §10「未入力の調整額を0円とみなす場合は、その前提を結果へ表示する」。既定は false
}

interface LossCarryforwardInput {
  hasBlueReturnForLossYears?: TriState;   // 法57条10項・58条の要件
  losses?: { fiscalYearStartedOn: LocalDate; amount: Money }[];
  // 古い事業年度から順に充当する（法57条1項）ため、発生事業年度を必ず持つ
}

interface CorporateCostInput {
  incorporationCost?: Money;
  annualAccountingFee?: Money;
  annualLaborConsultantFee?: Money;
  otherAnnualCost?: Money;
  // §11「未入力時は比較対象外として金額を仮定しない」
}
```

---

## 5. ② `ShohizeiInput`（消費税 最適方式比較）

対象: 仕様書 §15-§22

```ts
interface ShohizeiInput {
  precision: "simple" | "detailed";
  taxpayerType: "individual" | "corporation";

  eligibility: ShohizeiEligibilityInput;    // STEP1（§15）
  sales: PeriodSegment<SalesInput>[];       // §2-3
  purchases: PeriodSegment<PurchaseInput>[];
  simplified?: SimplifiedTaxationInput;     // §19
  specialistChecks: SpecialistChecks;      // §21
}
```

### 5-1. 適用可否判定の入力（§15）

```ts
interface ShohizeiEligibilityInput {
  invoiceRegistration: {
    registered: TriState;
    registeredOn?: LocalDate;
    becameTaxableByRegistration?: TriState;   // 登録を機に免税→課税になったか
  };

  basePeriod?: {
    taxableSales?: Money;
    lengthInMonths?: number;      // 12でない場合の年換算判定に使う（§15）
    exists: boolean;              // 基準期間が無い場合がある
  };

  specifiedPeriod?: {
    taxableSales?: Money;
    salaryPayments?: Money;       // 給与等支払額による判定
  };

  filings: ShohizeiFilingStatus[];

  newCompany?: {
    isNewlyEstablished?: TriState;
    isSpecifiedNewlyEstablished?: TriState;   // 特定新設法人
  };

  events?: {
    inheritance?: TriState;
    merger?: TriState;
    corporateSplit?: TriState;
    highValueAssetAcquisition?: TriState;      // 高額特定資産
    adjustableFixedAssetAcquisition?: TriState; // 調整対象固定資産
  };

  taxablePeriodShortened?: TriState;   // §21 により初期版は専門判定
}

type ShohizeiFilingKind =
  | "taxable_person_election"          // 課税事業者選択届出書
  | "taxable_person_election_cancel"   // 同 不適用届出書
  | "simplified_election"              // 簡易課税選択届出書
  | "simplified_election_cancel";      // 同 不適用届出書

interface ShohizeiFilingStatus {
  kind: ShohizeiFilingKind;
  filed: TriState;
  filedOn?: LocalDate;
  effectiveFromPeriodStart?: LocalDate;   // 効力が生じる課税期間の開始日
}
```

### 5-2. 売上・仕入

かんたん計算（§16）と詳細計算（§17）で入力の粒度が違う。§16 は「年間課税売上＋10%売上割合＋8%売上割合」という割合入力、§17 は税率別の実額入力である。両者を1つの型で受けると、割合入力を内部で実額へ展開した結果を実額入力と区別できなくなる。判別可能ユニオンで分ける。

```ts
type ConsumptionTaxRateBand = "standard_10" | "reduced_8" | "old_8";
// マスター consumption_tax_rate_standard / _reduced / _old_transitional に対応。
// 旧税率5%はマスターに無く、supported_tax_year も令和7年以後のため値集合へ入れない

interface BandAmount {
  band: ConsumptionTaxRateBand;
  amount: TaxIncl;
}

// §16 かんたん計算
interface SimpleSalesInput {
  kind: "simple";
  taxableTotal: TaxIncl;
  standardRatio: Rate;         // 10%売上割合。小数リテラルを使わない（§3-3）
  reducedRatio: Rate;          // 8%売上割合
  exportExempt?: TaxIncl;      // §20 必ず別入力
  primaryCategory?: SimplifiedBusinessCategory;   // 主な業種
}

// §17 詳細計算
interface DetailedSalesInput {
  kind: "detailed";
  taxable: BandAmount[];
  exportExempt?: TaxIncl;
  nonTaxable?: TaxIncl;        // 非課税売上
  outOfScope?: TaxIncl;        // 不課税売上。輸出免税と混同しない（§20）
  returnsAndDiscounts?: BandAmount[];
  badDebts?: BandAmount[];
  simplifiedCategoryBreakdown?: SimplifiedCategorySales[];   // §19
}

type SalesInput = SimpleSalesInput | DetailedSalesInput;

// §16 は免税事業者等からの仕入れを「有無」だけで尋ねる。金額の内訳を持たない
interface SimplePurchaseInput {
  kind: "simple";
  taxableTotal: TaxIncl;
  hasPurchasesFromNonRegistered: TriState;
}

interface DetailedPurchaseInput {
  kind: "detailed";
  taxableWithInvoice: BandAmount[];
  taxableWithoutInvoice: TransitionalPurchase[];   // 免税事業者等からの仕入れ
  nonTaxable?: TaxIncl;
  outOfScope?: TaxIncl;
  personnelCost?: Money;       // 不課税。課税仕入と分けて持つ
  returns?: BandAmount[];
}

type PurchaseInput = SimplePurchaseInput | DetailedPurchaseInput;
```

`kind: "simple"` の入力から一般課税の税額を `complete` として返さない。割合による展開は推定であり、§5 の「推定値を使う場合はユーザーが明示選択し、根拠・幅・結論逆転条件を表示する」に該当する。また `SimplePurchaseInput` は相手先別の内訳を持たないため、§18 の相手先別上限を判定できず、当該課税期間の一般課税は `complete` にできない（§18 の末尾が明示している）。

```ts

// §18 の相手先別上限（1億円）の判定に必要
interface TransitionalPurchase {
  band: ConsumptionTaxRateBand;
  amount: TaxIncl;
  counterpartyId?: string;              // 画面内で一意。名寄せできない場合は省略
  counterpartyAnnualTotal?: TaxIncl;    // その年・事業年度の相手先別合計（税込）
  hasRequiredRecords?: TriState;        // 帳簿・証憑の保存要件を満たすか
}

// §18「相手先を法的に同一と名寄せできない、相手先別年間仕入額を入力できない、
//      または期中に組織変更等がある場合は、上限未満と推定せず blocked を返す」
```

### 5-3. 簡易課税（§19）

```ts
type SimplifiedBusinessCategory =
  | "type1" | "type2" | "type3" | "type4" | "type5" | "type6" | "unclassifiable";
// マスター simplified_deemed_purchase_rates（6区分）に対応。
// unclassifiable は事業区分不能売上。0円扱いにせず、特例計算の対象として持つ

interface SimplifiedCategorySales {
  category: SimplifiedBusinessCategory;
  amount: TaxIncl;
  band: ConsumptionTaxRateBand;
}

interface SimplifiedTaxationInput {
  categorySelectedByUser: true;
  // §19「事業区分は表示例から自動確定せず、ユーザー選択と注意喚起を基本とする」
  // 自動推定した区分をこの型で渡せないよう、リテラル true を必須にする
  primaryCategory?: SimplifiedBusinessCategory;   // かんたん計算の「主な業種」
}
```

---

## 6. ③ `SozokuInput`（相続税）

対象: 仕様書 §24-§33

```ts
interface SozokuInput {
  level: 1 | 2 | 3;                 // §24 の LEVEL
  precision: "simple" | "detailed";

  decedent: DecedentInput;
  heirs: HeirInput[];               // §25
  assets: EstateInput;              // §26・§27
  debts: DebtInput[];
  division?: DivisionInput;         // §30 の配偶者取得額を含む
  smallResidentialLand?: SmallResidentialLandInput[];   // §31
  secondaryInheritance?: SecondaryInheritanceInput;     // §32
  specialistChecks: SpecialistChecks;                  // §68-1
}

interface DecedentInput {
  // 相続開始日は CalculationContext.inheritanceOpenDate を使う
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
  // §68-1「国外・非居住」は専門判定
}
```

### 6-1. 相続人（§25）

```ts
type HeirRelation =
  | "spouse" | "child" | "adopted_child" | "special_adopted_child"
  | "grandchild" | "parent" | "grandparent"
  | "sibling_full" | "sibling_half" | "nephew_niece" | "other";

interface HeirInput {
  id: string;                       // 氏名を入れない
  relation: HeirRelation;
  isAlive: boolean;
  diedOn?: LocalDate;               // 代襲原因の判定に使う
  renounced?: TriState;             // 相続放棄
  // §25「相続放棄があっても税法上は放棄がなかったものとして数える場面がある」
  // 入力は事実だけを持ち、民法上の相続人と税法上の法定相続人の数は計算側で分けて算出する
  disqualifiedOrExcluded?: TriState; // 欠格・廃除
  substitutedFor?: string;           // 代襲元の heir id

  // 養子を法定相続人の数へ算入する制限（実子あり1人・実子なし2人）の判定材料。
  // 相法15条3項は次を「実子とみなす」としており、relation="adopted_child" だけでは
  // 区別できない。省略すると養子の算入数を誤り、基礎控除・保険金非課税・
  // 相続税の総額がまとめて狂う
  adoptionFacts?: {
    isSpecialAdoption?: boolean;        // 特別養子（relation でも表せるが明示する）
    isStepChildOfSpouse?: boolean;      // 配偶者の実子で被相続人の養子となった者
    isSubstituteForDescendant?: boolean; // 代襲相続人であり かつ 被相続人の養子である者
  };
  isMinor?: boolean;
  ageAtInheritance?: number;         // 未成年者控除・障害者控除の年数計算に使う
  disability?: DisabilityCategory;
  residencyStatus?: "domestic_resident" | "non_resident" | "unknown";
  previousInheritanceWithin10Years?: {   // 相次相続控除
    occurredOn: LocalDate;
    taxPaid: Money;
    netEstateReceived: Money;
  };
}
```

### 6-2. 財産（§26・§27）

```ts
interface EstateInput {
  cash?: Money;
  securities?: Money;
  businessAssets?: Money;
  otherAssets?: Money;

  realEstate?: RealEstateInput[];        // §27
  lifeInsurance?: BeneficiaryAmount[];   // §26 受取人別
  retirementAllowance?: BeneficiaryAmount[];

  giftAddback?: GiftAddbackInput[];      // 生前贈与加算
  settlementTaxationGifts?: Money;       // 相続時精算課税適用財産
}

interface BeneficiaryAmount {
  beneficiaryHeirId?: string;   // 相続人以外が受け取る場合は省略
  isHeir: boolean;              // 非課税限度額の配分対象かどうか
  amount: Money;
}

interface GiftAddbackInput {
  giftedOn: LocalDate;          // 加算対象期間は相続開始日と贈与日の組合せで判定（§28-1 の6）
  recipientHeirId: string;
  amount: Money;
  giftTaxPaid?: Money;
}

// §27 路線価×面積は「申告用評価ではなく一次スクリーニング専用」
type RealEstateInput =
  | {
      kind: "appraised";                 // 相続税評価額が分かる
      category: "land" | "building";
      value: Money;
      ownershipShare?: Share;
    }
  | {
      kind: "screening_land";            // 路線価×面積。LEVEL 1 専用
      roadsideValuePerSqm: Money;
      areaSqm: string;                   // 十進文字列。number を使わない（§3-3）
      isMultiplierArea?: TriState;       // 倍率地域なら直接入力へ切り替える
      hasLeaseholdOrRented?: TriState;   // 借地権・貸家建付地なら専門判定
      ownershipShare?: Share;
    }
  | {
      kind: "screening_building";
      fixedAssetTaxValue: Money;
      ownershipShare?: Share;
    };

interface DebtInput {
  kind: "loan" | "unpaid" | "funeral" | "other";
  amount: Money;
  bearerHeirId?: string;
  // §28-1 の4「実際に負担する者から控除し、負担者以外から控除しない」
}
```

### 6-3. 分割・特例・二次相続

```ts
interface DivisionInput {
  isDivided: TriState;              // 未分割は §30 により簡易計算の対象外
  dividedAfterFilingDeadline?: TriState;
  acquisitions: { heirId: string; share: Share }[];
  spouseAcquisitionAmount?: Money;  // §30
}

// §31 マスター small_residential_land_category（4区分）に対応
type SmallResidentialLandCategory =
  | "specified_residential"    // 特定居住用宅地等（初期対応）
  | "specified_business"
  | "specified_same_business"
  | "rental_business";

interface SmallResidentialLandInput {
  realEstateIndex: number;                 // EstateInput.realEstate の添字
  category: SmallResidentialLandCategory;
  areaSqm: string;
  intendedAppliedAreaSqm?: string;
  acquirerHeirId: string;
  acquirerRelation: "spouse" | "cohabiting_relative" | "separate_household_relative" | "other";
  useAtInheritance?: string;               // 相続開始直前の利用状況
  acquirerResidesAndOwns?: TriState;
  willHoldUntilFilingDeadline?: TriState;
  // §31「区分判定に必要な情報が揃わない場合、適用可能面積を最大として計算しない」
}

interface SecondaryInheritanceInput {
  spouseOwnAssets: Money;                       // 配偶者固有財産
  spouseAcquisitionRatios: Share[];              // 0%〜100%の走査対象
  expectedHeirs: HeirInput[];                   // 二次相続時の想定法定相続人
  yearsUntilSecondary?: number;
  annualLivingCost?: Money;
  annualAssetChangeRate?: Rate;
  // §32「一次相続で取得した財産だけを二次相続財産とせず、配偶者固有財産、
  //      一次相続後の税・費用、設定した増減仮定を反映する」
}
```

---

## 7. ④ `YakuinHoshuInput`（役員報酬最適化）

対象: 仕様書 §36-§44

3モードは判別可能ユニオンにする。MODE B の「希望手取り月額」を MODE A の入力に紛れ込ませない。

```ts
type YakuinHoshuInput =
  | ({ mode: "A" } & YakuinHoshuCommonInput & ModeAInput)
  | ({ mode: "B" } & YakuinHoshuCommonInput & ModeBInput)
  | ({ mode: "C" } & YakuinHoshuCommonInput & ModeCInput);

interface YakuinHoshuCommonInput {
  precision: "simple" | "detailed";
  // 自治体は CalculationContext.jurisdiction を使う。①と同じ扱い（§11-1 の決定）
  officerResidenceSameAsCompany: TriState;

  capital: Money;
  employeeCount?: number;
  healthInsurer: HealthInsurerInput;

  officer: PersonFacts;
  spouse?: SpouseFacts;
  dependents?: DependentFacts[];
  otherIncomes?: IncomeItem[];
  deductions?: PersonalDeductionFacts;
  taxCredits?: { housingLoan?: Money; other?: { code: string; amount: Money }[] };

  appointedOn?: LocalDate;
  previousMonthlyAmount?: Money;       // 直前の報酬
  standardRemunerationDecisionKind?:
    | "on_qualification"   // 資格取得時決定
    | "regular"            // 定時決定
    | "occasional";        // 随時改定

  specialistChecks: SpecialistChecks;  // §38 の使用人兼務役員・非常勤・複数役員など
}

interface ModeAInput {
  profitBeforeOfficerCompensation: Money;   // 役員報酬控除前利益
  searchStep: "10000" | "50000";            // §38 刻み幅
  searchUpperBound?: Money;                 // 設定ファイル既定。上限付近の扱いは §38
  optimizationCriterion: "min_burden" | "max_total_retained" | "max_corporate_with_floor";
  // §39 基準A / 基準B / 基準C。既定は max_total_retained
  constraints?: {
    minPersonalNetIncome?: Money;   // 基準C の制約
    minCorporateRetained?: Money;   // §37「会社の必要運転資金・最低留保額」
    officerCompensationCeilingByResolution?: Money;  // 定款・株主総会の支給限度額（§38）
  };
  bonusPlan?: PredeterminedBonus[];
}

interface ModeBInput {
  desiredMonthlyNetIncome: Money;
  // §43「月額と賞与の配分によっても手取りは変わるため、
  //      支給計画を指定せずに単一の必要報酬額を断定しない」
  assumedBonusPlan?: PredeterminedBonus[];
  searchStep: "10000" | "50000";
}

interface ModeCInput {
  plan: CompensationPlan;    // 単一の月額ではなく支給計画で受ける（§38・§43）
}
```

---

## 8. 入力 → `value_key` 依存表

§52-3 の公開ゲートは当初マスター全体を単位としており、無関係なマスターの未承認で全ツールの公開が止まっていた。本表をゲートの絞り込みに使う。

**2026-08-26 追記。** 本表を機械可読な形に落とし、`data/tax-simulator/masters/simulator-dependencies.json` を正とした。公開ゲートはそちらを読む。本節の表は人が読むための対応表であり、両者がずれると `npm run masters:validate` が検出する（どのシミュレーターにも属さない `value_key` を警告し、実在しない `value_key` をエラーにする）。

依存表では `value_key` ごとに**必須**と**任意**を区別する。

| 区分 | 意味 | 未承認だったときのゲート |
| --- | --- | --- |
| 必須 | 無いとそのシミュレーターの主要な結果が出せない | 公開不可 |
| 任意 | 特定の入力があるときだけ引く | 警告のみ（公開は可） |

現在の集計は次のとおり。

| シミュレーター | 必須 | 任意 |
| --- | ---: | ---: |
| ① 法人成り | 48 | 57 |
| ② 消費税 | 4 | 5 |
| ③ 相続税 | 8 | 18 |
| ④ 役員報酬 | 42 | 39 |

①の任意に②の全キーが入っているのは、§12 の「消費税も含めて比較する」をONにしたときに②を呼ぶため。既定はOFFなので任意とし、②が `blocked` でも①全体は止めない（§11-7 の決定）。

以下の 8-1 〜 8-4 は初版の表で、そのあと追加したマスターを含まない。追加分は 8-6 にまとめた。両方を合わせたものが `simulator-dependencies.json` に入っている。

### 8-1. ① 法人成り

| 入力 | 引く `value_key` |
| --- | --- |
| `individual.business.revenue` / `.expenses` | ― |
| `blueReturn.specialDeductionCategory` | `blue_return_special_deduction` |
| `otherIncomes[].category="salary"` | `salary_income_deduction_table`, `salary_income_after_deduction_appendix5`（給与収入660万円未満は別表第五） |
| `deductions`（人的控除の事実） | `income_deduction_spouse`, `income_deduction_spouse_special`, `income_deduction_dependent`, `income_deduction_specific_relative_special`, `income_deduction_disability`, `income_deduction_widow`, `income_deduction_single_parent`, `income_deduction_working_student` |
| `deductions.lifeInsurance` | `life_insurance_deduction_new`, `life_insurance_deduction_old` |
| `deductions.earthquakeInsurance` | `earthquake_insurance_deduction` |
| `deductions.medical` | `medical_expense_deduction_floor`, `medical_expense_deduction_cap`, `self_medication_deduction_floor`, `self_medication_deduction_cap` |
| （課税所得の確定） | `basic_deduction_table`, `income_tax_brackets`, `reconstruction_income_surtax`, `income_tax_highearner_surcharge` |
| `residentTaxBasis` / `individual.jurisdiction` | `resident_tax_income_rate`, `resident_tax_per_capita_municipal`, `resident_tax_per_capita_prefectural`, `forest_environment_tax`, `resident_tax_basic_deduction_table`, `resident_tax_deduction_*`, `resident_tax_adjustment_deduction_rate`, `resident_tax_adjustment_difference`, `resident_tax_exemption_attribute`, `resident_tax_per_capita_exemption_base`, `resident_tax_per_capita_exemption_addition`, `resident_tax_per_capita_exemption_flat` |
| `business.businessTaxCategory` / `periodFacts` | `individual_business_tax_rate`, `individual_business_tax_owner_deduction` |
| `nationalPension.kind="standard"` | `national_pension_monthly_premium`, `national_pension_additional_premium` |
| `corporate.capital` / 所得 | `corporate_tax_sme_brackets`, `corporate_tax_ordinary_rate`, `local_corporate_tax_rate` |
| `corporate.jurisdiction` | `corporate_inhabitant_income_rate_prefectural`, `corporate_inhabitant_income_rate_municipal`, `corporate_inhabitant_per_capita`, `enterprise_tax_income_brackets`, `special_enterprise_tax_rate` |
| `lossCarryforward` | `loss_carryforward_period`, `loss_carryforward_deduction_limit`, `loss_carryforward_blue_return_requirement` |
| `corporate.officerCompensation`（役員個人の給与所得） | `salary_income_deduction_table`, `salary_income_after_deduction_appendix5`, `basic_deduction_table`, `income_tax_brackets`, `reconstruction_income_surtax`, `resident_tax_income_rate` ほか個人側と同じ人的控除一式 |
| `officerCompensation` / `healthInsurer` | `health_insurance_standard_remuneration_grades`, `employees_pension_standard_remuneration_grades`, `health_insurance_rate_total`, `nursing_care_insurance_rate_total`, `employees_pension_rate_employee`, `employees_pension_rate_employer`, `employees_pension_rate_total`, `health_insurance_bonus_cap`, `employees_pension_bonus_cap`, `child_support_levy_rate`, `child_rearing_support_rate` |
| `corporate.employeeCount` | `employment_insurance_rate_employee`, `employment_insurance_rate_employer_benefit`, `employment_insurance_rate_employer_two_businesses` |
| （全体） | `supported_tax_year`, `tax_period_basis`, `era_definition` |

### 8-2. ② 消費税

| 入力 | 引く `value_key` |
| --- | --- |
| `sales[].taxable[].band` | `consumption_tax_rate_standard`, `consumption_tax_rate_reduced`, `consumption_tax_rate_old_transitional` |
| `eligibility.basePeriod.taxableSales` | `taxable_sales_exemption_threshold`, `simplified_taxation_ceiling` |
| `simplified.categorySelectedByUser` | `simplified_deemed_purchase_rates` |
| `purchases[].taxableWithoutInvoice` | `invoice_transition_deduction_rate`, `invoice_counterparty_annual_cap` |
| `eligibility.invoiceRegistration.becameTaxableByRegistration` | `small_business_special_deduction`（2割特例） |

### 8-3. ③ 相続税

| 入力 | 引く `value_key` |
| --- | --- |
| `heirs`（法定相続人の数） | `inheritance_basic_deduction` |
| `assets.lifeInsurance` | `life_insurance_exemption` |
| `assets.retirementAllowance` | `retirement_allowance_exemption` |
| （課税遺産総額） | `inheritance_tax_brackets` |
| `heirs[].relation`（配偶者・一親等以外） | `inheritance_two_tenths_surcharge` |
| `division.spouseAcquisitionAmount` | `spouse_tax_relief_threshold`（**単独では不足**。§8-5 を参照） |
| `heirs[].ageAtInheritance` | `inheritance_minor_credit` |
| `heirs[].disability` | `inheritance_disability_credit` |
| `heirs[].previousInheritanceWithin10Years` | `inheritance_successive_credit` |
| `assets.giftAddback[].giftedOn` | `inheritance_gift_addback_period`, `inheritance_gift_addback_extra_deduction` |
| `smallResidentialLand` | `small_residential_land_category`, `small_residential_land_area_limit_rule` |

### 8-4. ④ 役員報酬

①の個人給与側（`salary_income_deduction_table` ほか）＋ 社会保険 ＋ 法人税・地方税の全項目を引く。①の依存集合の部分集合であり、①に無い `value_key` は無い。

### 8-5. 現時点でどの入力からも引けない項目

入力型は定義できるが、対応するマスターが無いため計算できないもの。`blocked` の原因になる。

| 入力フィールド | 必要なマスター | 現状 |
| --- | --- | --- |
| `deductions.donations`（ふるさと納税） | 寄附金控除・住民税の寄附金税額控除（特例控除の上限） | 未登録 |
| `taxCredits.housingLoan` | 住宅借入金等特別控除 | 未登録 |
| `deductions.casualtyLoss` | 雑損控除の計算式 | 未登録 |
| `nationalHealthInsurance.kind="estimate_accepted"` | 国民健康保険料の概算根拠 | 未登録 |
| `taxAdjustments.items[].code="entertainment"` | 交際費等の損金不算入（定額控除限度額） | 未登録 |
| `officerCompensation.revisions[].reason="ordinary"` | 定期同額給与の通常改定の期限 | 未登録（§38 が「マスターで判定」を要求） |
| `heirs[]`（法定相続分） | 民法900条の相続分 | 未登録。**②相続税の総額の計算（§28-1 の11）と ③配偶者の税額軽減の両方が止まる** |
| `division.spouseAcquisitionAmount` | 配偶者の税額軽減の上限 | `spouse_tax_relief_threshold` は「法定相続分または1億6,000万円のいずれか大きい方」と記述するが、法定相続分が未登録のため単独では計算できない |
| `assets.settlementTaxationGifts` | 相続時精算課税の特別控除・基礎控除 | 未登録 |
| `heirs[].residencyStatus="non_resident"` | 外国税額控除 | 未登録（§68-1 により専門判定でも可） |
| `heirs[].adoptionFacts` | 相法15条2項・3項（養子の算入制限と実子とみなす者） | 未登録。入力は用意したが判定規則がマスターに無い |

この表は §5 の「対象項目カタログ」の分母と直結する。入力できるが計算できない項目を分母から外さない。

---

### 8-6. 初版のあとに追加したマスターの割り当て（2026-08-26）

8-1 〜 8-4 を書いたのは §8-5 の未登録マスターを作る前だった。そのあと追加した36個の `value_key` を次のとおり割り当てた。公開ゲートの未分類検出がこの漏れを捕まえた。

| `value_key` | 割り当て | 区分 | 根拠 |
| --- | --- | --- | --- |
| `statutory_heir_rank`, `statutory_share_by_combination`, `statutory_share_equal_division` | ③ | **必須** | §28-1 の11〜13。課税遺産総額を法定相続分で按分してから税率を適用するため、無いと相続税の総額が計算できない |
| `statutory_heir_count_renunciation_rule`, `statutory_heir_count_adopted_limit`, `statutory_heir_count_deemed_real_child` | ③ | **必須** | 相法15条2項・3項。基礎控除・保険金非課税・退職金非課税・相続税の総額がすべて法定相続人の数に依存する |
| `statutory_share_substitution` | ③ | 任意 | 民法901条。代襲相続人がいる場合だけ |
| `settlement_taxation_*`（5件） | ③ | 任意 | §26 の財産入力に相続時精算課税適用財産がある場合だけ |
| `inheritance_foreign_tax_credit` | ③ | 任意 | 国外財産がある場合だけ。§68-1 は専門判定へ送るとしている |
| `national_health_insurance_*`（4件） | ① | **必須** | §10 の個人事業主側の国民健康保険。0円扱いにすると個人側を大きく過小にし、有利判定が逆転しうる |
| `officer_compensation_*`（3件） | ①④ | **必須** | 法34条1項1号・法令69条。①は損金算入の可否が法人所得を左右する。④は §38 が「期限が未登録の間は改定を伴う候補を `blocked` とする」と明示 |
| `casualty_loss_*`（4件） | ①④ | 任意 | 雑損失の入力があるときだけ |
| `donation_*`, `furusato_*`（7件） | ①④ | 任意 | 寄附（ふるさと納税を含む）の入力があるときだけ |
| `resident_tax_housing_loan_credit_*`（2件） | ①④ | 任意 | 住宅ローン控除の入力があるときだけ |
| `entertainment_expense_*`（3件） | ① | 任意 | 交際費の入力があるときだけ。ただし未入力を0円とみなす場合はその前提を結果へ表示する（§10） |

割り当ての判断基準は「無いと主要な結果が出せないか」。迷ったものは必須側へ倒した。止まる方が安全なためである。

④役員報酬に国民健康保険を割り当てていないのは、役員は健康保険（協会けんぽ等）の被保険者であり国保に加入しないため。

---

## 9. `validate` と `simulate` の責務分担

仕様書 §7-1 の規定を入力型の観点で具体化する。

### 9-1. `validate` が `ok: false` を返す条件

値が型・書式・範囲として受け付けられない場合に限る。

- `Money.value` が負数（金額として負を許すフィールドを除く）、小数、桁あふれ
- `LocalDate` が日付として不正
- `DateRange.from > to`
- `Rate.den <= 0`
- `PeriodSegment[]` の期間が重なる、対象期間を覆わない、順序が逆転している
- 判別可能ユニオンの `kind` が値集合外
- `LifeInsurancePremiumInput` で `generation="old"` かつ `category="nursing_medical"`（旧契約に介護医療保険料区分は存在しない）
- `DeductionOverride` の片側だけの入力
- `SimplifiedTaxationInput.categorySelectedByUser` が `true` 以外

**値が入力されていないこと自体をエラーにしない。** §7-1 が明示している。未入力を `validate` で弾くと、§5 が要求する `blocked` の結果も追加質問も発生しない。

### 9-2. `simulate` が `blocked` を返す条件（入力起因）

| 条件 | 根拠 |
| --- | --- |
| `IncomeItem.category="unknown"` または `taxationMethod="unknown"` | §10 |
| `IndividualBusinessTaxCategory="unknown"` | §2-7・個人事業税マスターの `_not_taxable_note` |
| `individual.jurisdiction.municipalityCode` 未設定で住民税を計算 | §3-2 の粒度表 |
| `healthInsurer.kind="kenpo_kumiai"` または `"unknown"` | §3-2 の粒度表（料率未登録） |
| `taxAdjustments.items[].applies="yes"` かつ `amount` 未入力 | §10 |
| `TransitionalPurchase.counterpartyId` を名寄せできない | §18 |
| `cap_period_basis` の期間と課税期間がずれる | §18 |
| `lossCarryforward.hasBlueReturnForLossYears` が `"yes"` 以外 | 法57条10項・§10 |
| `division.isDivided` が `"yes"` 以外で配偶者の税額軽減を適用 | §30 |
| §8-5 の未登録マスターを要する入力があった | §3-1 |

### 9-3. `simulate` が `partial` を返す条件

- `corporate.locationSameAsResidence` が `"yes"` 以外 → 法人の地方税を標準税率概算（§11-1）
- 自治体の税率が未登録 → 標準税率概算（§3-2 の粒度表・§46）
- `consumptionTax.include=true` で②が `blocked` → 消費税を `ExcludedItem` へ落とす（§11-7）
- `nationalHealthInsurance.kind="estimate_accepted"` → 概算である旨を表示（§5・§9）
- 住民税の非課税限度額が自治体固有の額でない → 標準額による概算（住民税マスターの `_simulator_rule`）
- `setupAndMaintenanceCosts` 未入力 → 比較対象外として `ExcludedItem` に記載（§11）

---

## 10. スキーマの単一ソースとバージョニング

### 10-1. 単一ソース

仕様書 §7-1 が定めている。

> 入力型・内訳型・Wire型はJSON Schema等の実行時スキーマと同じソースから生成し、TypeScript型だけが更新される状態を禁止する。

本書の型定義は**設計であって成果物ではない**。実装時は次の順序とする。

1. JSON Schema を `data/tax-simulator/schemas/input/*.schema.json` に置く（マスターの `schemas/` と同じ流儀）
2. TypeScript 型を JSON Schema から生成する
3. 生成物を手で編集しない。CI で「生成し直して差分が出ないこと」を検査する

ただし `bigint`（`Money.value`）と分岐条件付きの制約（旧契約に介護医療区分を許さない等）は JSON Schema で表現しきれない。`Wire` 型（`MoneyWire` は `Decimal` 文字列）を JSON Schema の対象とし、`Money` との相互変換を §3-3 が定める境界関数1箇所に閉じる。入力型のメモリ内表現は `Money`、スキーマ検証の対象は `Wire` 表現とする。

### 10-2. `inputSchemaVersion`

§7 の `SimulationResult.inputSchemaVersion`、§13-1 の `Handoff.inputSchemaVersion` に載る。

- 形式は `<simulator>-<major>.<minor>`（例 `hojinnari-1.0`）
- 必須フィールドの追加、値集合からの値の削除、意味の変更は major を上げる
- 省略可能フィールドの追加、値集合への値の追加は minor を上げる
- §68-1 の対応プロフィールを拡張するときは、`supportedProfileVersion` と同時に更新する（§68-1 が「対応範囲を拡張するときは入力スキーマ、ゴールデンケース、警告、説明本文を同時に更新する」と定めている）
- §64 の回帰テストのゴールデンケースは `inputSchemaVersion` ごとに保持し、版を上げたときに旧版のケースを消さない

---

## 11. 仕様書との差分・未決事項

本書を書く過程で、仕様書の記述だけでは決まらなかった点。レビューの対象とする。

### 11-1. 自治体は1つとし、違う場合は概算＋注意書きとする（決定済み・2026-08-25）

§3-2 の `CalculationContext` は `jurisdiction` を1個だけ持つ。しかし法人成りシミュレーターは、個人の住所地（住民税・個人事業税）と法人の所在地（法人住民税・法人事業税）を同時に必要とし、両者が一致するとは限らない。役員報酬シミュレーターも同じである。

**決定**: `CalculationContext.jurisdiction` を1つのまま使い、仕様書本体は変更しない。入力型には自治体を持たせず、「本店所在地が住所地と同じか」を尋ねるフラグだけを持つ。

| フラグ | 挙動 |
| --- | --- |
| `"yes"` | `CalculationContext.jurisdiction` で個人側・法人側とも計算する |
| `"no"` | 法人の地方税（法人住民税・法人事業税・特別法人事業税）を**標準税率による概算**へ切り替え、`resultStatus: "partial"` とし、`ExcludedItem` に「法人所在地の自治体独自の税率は反映していない」と記載する |
| `"unknown"` / 未回答 | 同上（`"no"` と同じ扱い） |

`"no"` のときに住所地の自治体の超過税率を法人側へ適用しない。未登録の自治体を標準税率で概算するのは §3-2 の粒度表が認める扱いだが、**別の自治体の税率を当てはめるのは誤った数値を出すことになる**ため、区別する。

個人側（住民税・個人事業税）は住所地で計算するため影響を受けない。

将来、法人所在地の入力に対応する場合は `CalculationContext` に `jurisdictions` を追加する案（仕様書 §3-2 の変更）へ移行する。そのときは `inputSchemaVersion` の major を上げる。

### 11-2. 「かんたん計算」を型で表すか実行時で表すか

§5 は「かんたん計算」と「詳細計算」で入力項目数が違うとする。本書は `precision: "simple" | "detailed"` の1フィールドで区別し、詳細専用の項目はすべて省略可能にした。

別案として `HojinnariSimpleInput` と `HojinnariDetailedInput` を別型にする方法がある。型で必須項目を強制できる利点があるが、`SimulatorService<I>` の `I` が1つである以上ユニオンになり、`validate` の戻り値が複雑になる。また §5 が「追加質問」でモードをまたぐ入力補完を想定しているため、簡易→詳細の遷移で型が変わると入力値の持ち回しが煩雑になる。本書はトップレベルでは前者を採った。

ただし②の売上・仕入だけは例外として `simple` / `detailed` の判別可能ユニオンにしている（§5-2）。かんたん計算の入力が「年間課税売上＋10%割合＋8%割合」という**別の単位**であり、省略可能フィールドの有無では表せないためである。「詳細の項目が省略されている」のではなく「入力の意味が違う」場合はユニオンにする、という基準で使い分ける。この基準を他の箇所へ適用すべきか（例: ③の不動産評価は既に `appraised` / `screening_*` のユニオンになっている）は、実装時に再確認する。

### 11-3. `IncomeItem` は所得金額のみを受ける（決定済み・2026-08-25）

初稿は `isAmountRevenue` フラグで収入金額も受けられる形にしていた。

**決定**: 所得金額のみとし、収入金額を受け取れる余地を型に残さない。

理由。収入金額から所得金額を求める式は所得区分ごとに全く違い（給与は給与所得控除、公的年金等は公的年金等控除、譲渡は取得費・譲渡費用、不動産は必要経費）、区分ごとに別の型と別の計算経路を持つことになる。実装量と検証コストに対して、得られるのは「確定申告書が手元に無いユーザーが概算を入れられる」という利得だけであり、その概算は §5 が明示選択を求める推定値になる。

書類が手元に無いユーザーは §5 の判定順（追加質問 → 範囲 → `blocked`）で扱う。UIには源泉徴収票・確定申告書のどの欄を見るかを示す。

役員報酬から給与所得を求める計算は別経路であり、この決定の影響を受けない（`salary_income_deduction_table` と `salary_income_after_deduction_appendix5` を使う）。

### 11-4-1. 市区町村コードの桁数（決着済み・2026-08-26）

初版で「仕様書 §3-2 の記述が不正確」と指摘した件（`_municipality_code_note` として国保の市町村別料率マスターにも記録した）。仕様書 §3-2 を訂正した。

| コード体系 | 桁数 | 検査数字 | 例（横浜市） |
| --- | ---: | --- | --- |
| JIS X 0402 の市区町村コード | 5 | 含まない | `14100` |
| 総務省の全国地方公共団体コード | 6 | 含む | `141003` |

`MunicipalityCode` は**5桁**とする。型の目印が `__jisX0402` である以上、5桁が本来の意図であり、初版の「全国地方公共団体コード5桁（検査数字を含む）」は2つの体系を混ぜた記述だった。

桁数の違う値が混ざると、文字列一致の照合が黙って0件を返す。外部資料から取り込むときは桁数を確認し、6桁のものは検査数字を落としてから使う。国保の市町村別料率マスターは5桁で登録済み。

### 11-4. 面積を文字列で持つ理由

`areaSqm` を `number` ではなく十進文字列にした。§3-3 が「外部形式にJavaScriptの `number` と指数表記を使わない」としており、`330.58` のような小数を扱うため。ただし §3-3 の型体系には面積に相当する型が無い（`Money` と `Rate` だけ）。`Decimal` 型を面積へ流用してよいか、面積専用の型を足すべきかが未決。

### 11-5. `PeriodSegment[]` の被覆条件を誰が持つか

「重ならず、隙間なく対象期間を覆う」という不変条件を `validate` で検査するとしたが、対象期間は `CalculationContext` 側にある。`validate(input: unknown)` は §7-1 の署名上 `CalculationContext` を受け取らない。したがって `validate` は「重なりが無いこと」までしか検査できず、「対象期間を覆うこと」は `simulate` の入口で検査することになる。署名を変えずに済ませるなら、後者を `simulate` のプログラム不変条件ではなく `blocked` として扱う必要がある（§7-1 は不変条件違反を例外、ユーザー起因を `blocked` としており、この検査は後者に当たる）。

### 11-6. 2割特例の適用対象期間は登録済み。ただし期間軸が他と違う

§15 は「2割特例の適用対象課税期間の終期がマスターに無い」と書いているが、その後マスターが整備され、現在は登録されている。

| レコード | 期間 | `legal_status` |
| --- | --- | --- |
| `CT-SPECIAL-2WARI` | `effective_from: 2023-10-01` / `effective_to: 2026-09-30` | `effective` |
| `CT-SPECIAL-3WARI` | `effective_from: 2027-01-01` / `effective_to: 2028-12-31` | `enacted` |

したがって §15 のこの記述は解消済みとして扱ってよい。

ただし残る論点がある。2割特例の適用対象は「令和8年9月30日までの日の属する**課税期間**」であり、取引日ではなく課税期間を単位とする条件である。それを `effective_to` で表しているが、`applies_to_period_start_from` / `applies_to_period_start_to` は両方 `null` になっている。他のレコードで `effective_to` は取引日・暦日の軸を意味するため、同じフィールドが2つの軸で使われている。

**2026-08-26 訂正・決着。** 初版は「マスター側で `applies_to_period_start_to: "2026-09-30"` を設定するのが本来の形」と書いたが、**これは誤りだった**。

2割特例の条文は「令和五年十月一日から令和八年九月三十日までの日の属する各課税期間」（平成28年改正法附則51条の2）であり、判定は**課税期間がその期間のいずれかの日を含むか**で行う。開始日の上限だけでは表せない。

- 課税期間 2023-04-01〜2024-03-31 は、開始日が 2023-10-01 より前だが 2023-10-01 を含むので対象になる
- 個人事業者の令和8年分（2026-01-01〜2026-12-31）は、終了日が 2026-09-30 より後だが 2026-09-30 を含むので対象になる

`applies_to_period_start_to` だけを設定すると前者を取りこぼす。逆に終了日で判定すると後者を取りこぼす。

決着として、レコードに `period_match_rule: "taxable_period_intersects"` を追加し、`effective_from` / `effective_to` を単一の日付と突き合わせる通常の判定と区別できるようにした。仕様書 §15 にも同じ判定規則を追記した。

### 11-7. ①が②を呼ぶときの `CalculationContext` の組み立て

§12 は「ONの場合は②消費税エンジンを呼び出す」とするだけで、呼び出し規約を定めていない。次が未決。

- ①の `CalculationContext` は `consumptionTaxPeriod` を1つしか持てない。法人成り年は個人の課税期間と法人の課税期間が両方立つため、②を2回呼ぶことになる。その2回分の `CalculationContext` を誰が組み立てるか。
- §13-1 は画面間の受け渡しを `Handoff` に限定しているが、①の内部から②のエンジンを呼ぶのは画面間の受け渡しではない。`Handoff` を経由すべきか、`SimulatorService.simulate` を直接呼んでよいか。
**②の結果が `blocked` のときの①の扱いは決定済み（2026-08-25）。** ①全体を `blocked` にせず、消費税だけを `ExcludedItem` へ落として `resultStatus: "partial"` とする。所得税・住民税・法人税・社会保険の比較は表示する。これは §11「法人設立費用等は未入力時は比較対象外として金額を仮定しない」と同じ考え方であり、消費税額を0円として比較へ混ぜないことが要点となる。

結論カード（§6）には、消費税を含めない比較である旨を併記する。§12 の「消費税：比較対象外」の表示をそのまま使う。

残りの2点（`CalculationContext` を誰が組み立てるか、`Handoff` を経由するか）は未決。

---

## 12. 次のアクション

2026-08-25 に §11-1・§11-3・§11-7（一部）が決着し、着手順も決まった。

1. **§8-5 の未登録マスターの作成**（着手中）。相続税シミュレーターを止めている3件（法定相続分・養子の算入制限・相続時精算課税）を先に埋める
2. §52-3 の公開ゲートを §8 の依存表で絞り込む
3. §11-6 のマスター修正（`applies_to_period_start_to` の設定）
4. JSON Schema の作成と TypeScript 型生成の整備（§10-1）
5. 残る未決事項（§11-2 の使い分け基準、§11-4 の面積の型、§11-5 の被覆条件の検査場所、§11-7 の残り2点）

---

## 13. レビュー記録（2026-08-25）

初稿を自己レビューし、11件の指摘を反映した。

### 反映した指摘

| # | 指摘 | 対応 |
| --- | --- | --- |
| 1 | ②のかんたん計算（割合入力・有無だけの入力）を型で表せていなかった | `SalesInput` / `PurchaseInput` を `simple` / `detailed` の判別可能ユニオンへ分けた（§5-2） |
| 2 | §8-1 の依存表に役員個人の給与所得側が無く、`salary_income_deduction_table` が漏れていた | 行を追加。この表を公開ゲートに使うと給与所得控除マスター未承認のまま①を公開してしまうため、影響が大きい |
| 3 | `HojinnariInput.consumptionTax?: ShohizeiInput` が法人成り年の2課税期間を表せず、呼び出し規約も未定義だった | 2本持つユニオンへ変更し、未決事項を §11-7 として明記 |
| 4 | `self?: PersonFacts` を省略可能にしていた。年齢は介護保険・厚生年金・後期高齢者の判定を変える | 必須へ変更 |
| 5 | `ConsumptionTaxRateBand` に `"old_5"` を入れていたが対応マスターが無い | 値集合から削除（`supported_tax_year` は令和7年以後） |
| 6 | 養子の「実子とみなす者」（連れ子養子・代襲相続人である養子）の判定材料が無く、法定相続人の数を誤る | `HeirInput.adoptionFacts` を追加。判定規則が未登録であることを §8-5 に記載 |
| 7 | 配偶者の税額軽減が法定相続分未登録で計算できないことを §8-5 に書いていなかった | 追記。あわせて §8-3 の表に「単独では不足」と明記 |
| 8 | 持分・取得割合に `{ num: number; den: number }` を新設し、§3-3 の「number を使わない」に触れていた | `Share = Rate` を定義して統一 |
| 9 | `SpecialistCheck[]`（配列に無い＝未回答）が §2-1 の欠損表現と別方式だった | `Partial<Record<string, TriState>>` へ変更 |
| 10 | `PeriodSegment<T>.data` が意味を持たない名前だった | `value` へ変更 |
| 11 | §11-6 が「2割特例の終期がマスターに無い」としていたが、実際には登録済みだった | マスターを確認して記述を差し替え。残る論点（期間軸の表し方）を新たに記載 |

### 反映しなかった指摘

**上場株式の配当・譲渡で所得税と住民税の課税方式が別々になる場合**

`IncomeItem.taxationMethod` は1つしか持たない。令和4年分以前は所得税と住民税で別の課税方式を選択できたため、過去年分を扱うなら2つ必要になる。しかし `supported_tax_year` は令和7年・8年・9年の3年分であり、対象外。型を複雑にする利得が無いため変更しない。対応年を過去へ広げる場合は再検討する。

### 決着した未決事項（2026-08-25）

| 項目 | 決定 |
| --- | --- |
| §11-1 自治体を2つ持つか | **持たない。** `CalculationContext.jurisdiction` を1つのまま使い、本店所在地が住所地と違う場合は法人の地方税を標準税率概算にして `partial` とし、注意書きを表示する。仕様書本体は変更しない |
| §11-3 収入金額を受けるか | **受けない。** `IncomeItem.amount` は所得金額のみ。`isAmountRevenue` と `expenses` を削除した |
| §11-7 ②が `blocked` のときの①の扱い | **①全体を止めない。** 消費税だけ `ExcludedItem` へ落として `partial` とし、他の税目の比較は表示する |

§11-1 の決定で、法人の所在地が住所地と違うときに**住所地の超過税率を法人側へ当てはめない**点が要になる。未登録の自治体を標準税率で概算するのは §3-2 の粒度表が認める扱いだが、別の自治体の税率を当てはめるのは誤った数値を出すことになるため、両者を区別して実装する。

### レビューで確認できたこと

- §2-5（所得控除は事実を入力しマスターから税目別に引く）は、マスター側に `income_deduction_*` と `resident_tax_deduction_*` が対になって揃っていることを確認した。8組すべて存在する
- §2-7 の `IndividualBusinessTaxCategory` は、マスターの `business_category`（`type1` / `type2` / `type3_standard` / `type3_reduced`）と文字列が一致している
- §8 の依存表に挙げた `value_key` は、`data/tax-simulator/masters/` に実在する95件の範囲内であることを機械的に照合した
