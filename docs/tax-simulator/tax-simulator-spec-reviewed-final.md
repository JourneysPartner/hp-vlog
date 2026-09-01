# 税務シミュレーター共通基盤・4ツール開発仕様書

**バージョン：** 1.1-review.10
**基準日：** 2026年8月23日
**法令確認範囲：** 2026年8月23日までに成立・公布され、適用関係を公的資料で確認できた制度
**文書状態：** 5往復レビュー完了（実装前。未承認マスター値を含む計算は公開不可）
**対象：**

1. 法人成り・法人化損得シミュレーター
2. 消費税 最適方式比較シミュレーター
3. 相続税「かかる？いくら？」シミュレーター
4. 役員報酬最適化シミュレーター

---

# 1. 開発目的

税理士事務所HPへの自然検索流入を増やすとともに、単なる税額計算機ではなく、

**「ユーザーの条件を入力すると、税理士が実務で確認する論点をある程度自動判定してくれるツール」**

を構築する。

目的は以下の4点。

* SEO流入の獲得
* 税理士事務所としての専門性の訴求
* 記事→シミュレーター→相談への導線形成
* 将来的な他シミュレーター追加のための共通計算基盤構築

---

# 2. 基本方針

## 2-1. 4シミュレーターを別々に作らない

以下の共通計算エンジンを作成する。

```text
Tax Calculation Engine
│
├─ 個人所得税計算
├─ 給与所得計算
├─ 所得控除計算
├─ 住民税計算
├─ 個人事業税計算
├─ 社会保険計算
├─ 法人税等計算
├─ 消費税計算
├─ 相続税計算
├─ 税制適用可否判定
└─ 年度・料率マスター
```

①法人成りと④役員報酬は同じ給与・法人税・社会保険モジュールを利用する。

---

# 3. 重要設計原則

## 3-1. 税率をコードへ直接書かない

以下はすべて年度別マスターとして管理する。

```text
tax_year_master
income_tax_master
salary_income_deduction_master
basic_deduction_master
resident_tax_master
corporate_tax_master
local_corporate_tax_master
social_insurance_master
consumption_tax_master
simplified_tax_master
inheritance_tax_master
```

各レコードには最低限、

```text
valid_from
valid_to
tax_year
value
source_name
source_url
verified_at
```

を持たせる。

`tax_year` だけで適用レコードを選択してはいけない。税目ごとに暦年、事業年度、課税期間、賦課年度、保険料適用月が異なるため、最低限次も保持する。

```text
jurisdiction
tax_or_insurance_type
effective_from
effective_to
applies_to_period_start_from
applies_to_period_start_to
applies_to_transaction_from
applies_to_transaction_to
promulgated_at
as_of_date
calculation_order
rounding_rule_id
source_document_id
source_locator     # 条・項・ページ・表番号等
source_hash
verified_by
legal_status       # 値集合は §48
data_review_status # 値集合は §48
```

`legal_status` と `data_review_status` の値集合は §48 に一本化し、節ごとに別の列挙を書かない。未来の税制改正大綱・法案・未公布資料を、適用中の制度と同じ扱いにしてはいけない。マスター選択に失敗した場合は前年値へ黙ってフォールバックせず、`resultStatus: "blocked"` と専門家確認を求める `critical` 警告を返す。

## 3-2. 計算コンテキスト

すべての計算関数は暗黙の現在日時を参照せず、次のコンテキストを明示的に受け取る。

```ts
type LocalDate = string & { readonly __localDate: unique symbol }; // YYYY-MM-DDを検証済み

interface DateRange {
  from: LocalDate; // 両端を含む
  to: LocalDate;
}

type PrefectureCode   = string & { readonly __jisX0401: unique symbol }; // 都道府県コード2桁
type MunicipalityCode = string & { readonly __jisX0402: unique symbol }; // JIS X 0402の市区町村コード5桁（検査数字を含まない）

interface Jurisdiction {
  country: "JP";
  codeSystemVersion: string;        // 団体コード表の版
  asOfForCodes: LocalDate;          // どの時点の団体コードとして解釈するか
  prefectureCode?: PrefectureCode;
  municipalityCode?: MunicipalityCode;
  healthInsurerCode?: string;       // 保険者番号。協会けんぽ支部と健保組合を同一体系で扱わない
}

interface CalculationContext {
  asOfDate: LocalDate;            // 根拠確認日
  calculatedAt: Instant;          // 実行時刻。計算関数が取得せず呼び出し側が渡す（§7-1）
  incomeTaxYear?: number;         // 暦年
  residentTaxFiscalYear?: number; // 賦課年度
  fiscalPeriod?: DateRange;       // 法人事業年度
  consumptionTaxPeriod?: DateRange;
  inheritanceOpenDate?: LocalDate;
  socialInsuranceMonths?: string[]; // YYYY-MM
  jurisdiction: Jurisdiction;
  masterSnapshotId: string;
  masterSnapshotHash: string;
}
```

`DateRange` は `from <= to` の閉区間とする。課税期間等で終端排他が必要な内部処理は、境界変換関数を1箇所に限定し、画面・マスター・結果APIでは閉区間へ統一する。

`CalculationContext` 内の期間は互いに独立ではない。法人の `consumptionTaxPeriod` は `fiscalPeriod` に含まれ（課税期間短縮時はそれを分割した各期間）、個人の `consumptionTaxPeriod` は `incomeTaxYear` の暦年に含まれる。`socialInsuranceMonths` は対象期間に含まれる連続した月とする。これらを満たさない組合せは計算関数の入口で拒否し、後段で辻褄を合わせない。

市区町村コードの桁数を取り違えない。JIS X 0402 の市区町村コードは5桁で検査数字を含まない（例: 横浜市 14100）。総務省の全国地方公共団体コードはこれに検査数字1桁を加えた6桁である（例: 横浜市 141003）。`MunicipalityCode` は前者の5桁とする。桁数の違う値が混在すると、文字列一致による照合が黙って0件を返す。外部資料から取り込むときは桁数を確認し、6桁のものは検査数字を落としてから使う。（2026-08-26 訂正。初版は「全国地方公共団体コード5桁（検査数字を含む）」としていたが、5桁のコードに検査数字は含まれず、記述が矛盾していた）

団体コードは合併・分割・政令指定都市への移行で変わる。過去の相続開始日や過年度の事業年度を扱うため、マスターとの照合を文字列一致で行わず、`codeSystemVersion` と `asOfForCodes` を用いる解決関数を1箇所に置き、廃止コードと後継コードの対応表を保持する。対応表に無いコードを近隣自治体や都道府県平均で代替せず `blocked` とする。`asOfDate`（根拠確認日）と `asOfForCodes`（制度適用時点の団体コード）は一致しないことがあるため、同一視しない。

必要な地域粒度は税目ごとに異なる。粒度が欠けたまま全国一律値へ代替しない。

| 税目・保険 | 必要な粒度 | 欠落時 |
| --- | --- | --- |
| 住民税（所得割・均等割） | `municipalityCode` | `blocked` |
| 個人事業税 | `prefectureCode` | `blocked` |
| 法人住民税・法人事業税等 | `prefectureCode` と `municipalityCode` | §46 の `rate_source_status: missing` と同じく標準税率概算とし `partial` |
| 健康保険・介護保険 | `healthInsurerCode`（協会けんぽは `prefectureCode`） | `blocked` |
| 厚生年金・子ども・子育て支援金 | `country` のみ | ― |

サーバー・ブラウザのタイムゾーンにより境界日が変わらないよう、制度判定は原則として日本時間の日付（時刻を持たない日付型）で行う。`calculatedAt` は表示・印刷・訂正照合のための実行時刻であり、制度判定へ使わない。`asOfDate`（根拠確認日）と混同しない。

## 3-3. 金額・端数・計算順序

- 金額は整数円または十進固定小数で保持し、IEEE 754の浮動小数を税額計算に直接使わない。
- 税込・税抜変換、課税標準、税率別税額、100円・1,000円未満切捨て等は税目別の法定順序で行う。
- 表示時の丸めと計算時の丸めを分離する。
- 負数、欠損値、上限超過、桁あふれを型・スキーマで拒否または明示処理する。
- 全関数は同じ入力、同じマスタースナップショットから同じ結果を返す純粋関数を基本とする。

型は次を基本とする。

```ts
type Money   = { unit: "JPY"; value: bigint };            // 確定金額。円単位の整数。小数円は入力段階で拒否
type Exact   = { unit: "JPY"; num: bigint; den: bigint }; // 丸め前の中間金額。有理数のまま保持
type Rate    = { num: bigint; den: bigint };              // 率。den > 0、既約形へ正規化、den = 0 は構築時に拒否
type TaxIncl = { basis: "inclusive" | "exclusive"; amount: Money }; // 消費税の税込・税抜区分を型で保持

// 外部形式（保存・受け渡し・PDF・フィクスチャ）専用の型
type Decimal = string & { readonly __decimal: unique symbol }; // 10進文字列。符号と小数点のみ。指数表記・桁区切りを許さない
type Instant = string & { readonly __instant: unique symbol }; // RFC 3339のオフセット付き日時。オフセット無しの表記を許さない

type MoneyWire = { unit: "JPY"; value: Decimal };
type RateWire  = { num: Decimal; den: Decimal };
type ExactWire = { unit: "JPY"; num: Decimal; den: Decimal };
```

- 率と金額の乗算は `Rate × Money → Exact`、中間の加減算は `Exact ± Exact → Exact` とし、`Exact → Money` の変換は `rounding_rule_id` を引数に取る関数だけが行う。中間段階で `Money` へ戻す実装を禁止する。`Money` しか型が無い状態では「除算は最後に1回」を満たせない。
- 率をマスター・設定・JSONへ小数リテラル（例 `0.0023`）で持たない。二進浮動小数へ丸められるため、分子・分母の整数対で記述する。
- `bigint` はJSONへ直接直列化できない。保存、テストフィクスチャ、PDF出力など、値がプロセス外へ出る形式には `Wire` 接尾辞の型だけを用い、相互変換を1箇所の境界関数に限定する。ツール間受け渡し（§13-1）は直列化せずメモリ内で行うため `Wire` 型を使わない。往復変換で元の値と一致することを検証し、外部形式にJavaScriptの `number` と指数表記を使わない。日時は `Instant`、日付は `LocalDate` とし、新規フィールドを素の `string` で定義しない。
- 税込・税抜は変数名ではなく `TaxIncl.basis` で保持し、区分の異なる金額の加算・比較を型で拒否する。

丸めはコードへ直接書かず、`rounding_rule_id` で規則表を参照する。初期版で必要な規則は最低限次のとおり。

```text
R-TRUNC-1000-BASE   課税標準の1,000円未満切捨
R-TRUNC-100-TAX     年税額の100円未満切捨
R-TRUNC-1-YEN       円未満切捨
R-ROUND-HALF-UP-1   円未満四捨五入（保険者規則で指定される場合）
R-SHARE-REMAINDER   労使折半等の端数負担規則（保険者別に個別定義）
```

- 丸めは規則表が定める段階でのみ1回行い、中間値を丸めた後に再度丸める二重丸めを禁止する。
- 銀行丸め（偶数丸め）は法定根拠がある場合を除き使用しない。
- `calculation_order` は同一課税段階内での適用順序を示す整数とし、控除・特例・税額控除の順序が法令で定まる箇所に必ず付与する。順序が未定義のレコードを計算へ投入しない。
- 率と金額の乗算は分数のまま行い、除算は最後に1回だけ実施する。
- 端数処理の単位・方向・適用段階をテスト名に含め、境界の±1円を検証する。

## 3-4. シミュレーターの法的位置付け

本ツールは概算と論点整理を目的とし、申告書作成、税務代理、個別案件への適用保証を行わない。結果画面では「概算」の語だけでなく、含めた項目、含めていない項目、判定不能項目、基準日を表示する。

---

# 4. 共通UI

すべてのシミュレーターでデザインを統一する。

基本構成：

```text
H1
↓
30秒程度の説明
↓
かんたん計算 / 詳細計算
↓
STEP形式入力
↓
計算する
↓
結論
↓
グラフ
↓
詳細内訳
↓
計算前提
↓
注意すべき税務ポイント
↓
税理士コメント
↓
公式根拠
↓
相談CTA
↓
関連記事
```

---

# 5. 入力モード

原則として、

### かんたん計算

一般ユーザー向け。

入力項目を最小限とする。

### 詳細計算

税額精度を上げたいユーザー向け。

追加情報を入力することで精度を上げる。

結果画面で「概算精度：標準」のような根拠のない一語評価を表示しない。代わりに次を表示する。

```text
計算範囲: 計算済み項目数 / 対象項目数
直接入力: ユーザーが入力した値
制度既定値: 確認済みマスターから採用した値
推定値: 推定方法と幅
除外項目: 理由と金額既知/不明
結果状態: complete / partial / blocked
```

「対象項目数」はシミュレーターごとに固定した項目カタログの件数とし、入力内容で増減させない。除外した項目を分母から外すと、除外が増えるほど比率が改善する。除外項目は分母に残したまま分子から外す。カタログは §7 の `ExcludedItem.code` と同じ体系で定義し、結果に現れない項目を分子へ数えない。

簡易モードでも、未入力を暗黙に0円・全国平均・前年値へ置換しない。不足時は次の判定順で処理する。番号は優先順位であり、上位で確定した段階を下位で覆さない。

1. 結論（有利不利、方式の順位、申告要否）が逆転し得る欠落は `blocked` とする。範囲表示・推定値で代替しない。
2. 1に当たらない欠落のうち、ユーザーの追加入力で解消できるものは追加質問を提示する。
3. 追加入力で解消せず、法的に妥当な上下限を計算でき、その範囲内で結論が変わらないものは範囲として表示する。
4. 影響部分を他の項目から分離できるものは `partial` とし、除外項目へ記載する。

追加質問の上限は固定の3問とせず、各シミュレーターの離脱率・完了時間・誤答率を用いたユーザビリティテストで決め、設定として版管理する。上限を超える不足が残る場合は詳細計算への切替を促し、質問を1問ずつ足してSTEPを際限なく伸ばさない。追加質問で総STEP数が変わる場合は §61-1 の進捗表示を「現在のSTEP / 現時点の総STEP数」とし、増加した旨を通知する。既に入力済みの値を追加質問で再入力させない（WCAG 3.3.7）。

推定値を使う場合はユーザーが明示選択し、根拠・幅・結論逆転条件を表示する。範囲として表示する結果は §7 の `summary.range` を用い、範囲の中央値・下限・上限のいずれかを単一の確定額として表示しない。

---

# 6. 共通結果画面

結果の最上部には必ず「結論カード」を表示する。

例：

```text
今回の条件では

法人化した場合
年間 約482,000円 手残りが増える試算です。

個人事業　5,320,000円
法人　　　5,802,000円

差額　　　+482,000円
```

ただし断定表現は禁止。

「法人化した方が絶対に得です」

ではなく、

> 本シミュレーションの入力条件では法人の方が約48万円有利となりました。

とする。

---

# 7. 共通結果データ

全シミュレーターは共通形式で結果を返す。

```ts
interface SimulationResult {
  simulatorType: "hojinnari" | "shohizei" | "sozoku" | "yakuin_hoshu";
  periodLabel: string;             // 表示専用。"2026年分" "2026-04-01～2027-03-31" 等
  comparisonBasis: "steady_state" | "transition_year";
  resultStatus: "complete" | "partial" | "blocked";

  summary: {
    title: string;
    amount?: Money;
    comparison?: Money;
    range?: AmountRange;  // §5 の範囲表示。amount と併用しない
  };

  breakdown?: SimulatorBreakdown;

  assumptions: string[];
  warnings: Warning[];

  applicableMethods?: MethodEligibility[];

  sources: SourceReference[];

  calculationVersion: string;

  inputSchemaVersion: string;
  supportedProfileVersion: string;  // §68-1 の対応プロフィール版
  calculationContext: CalculationContext;  // 実行時刻は calculatedAt をこの中だけに持つ
  usedMasterRecords: MasterRecordRef[];
  precision: "simple" | "detailed";
  excludedItems: ExcludedItem[];
}
```

```ts
type DataReviewStatus =
  | "unverified"
  | "single_checked"
  | "double_checked"
  | "approved"
  | "blocked";

type EligibilityStatus =
  | "eligible"    // 要件を満たすことを確認した
  | "ineligible"  // 要件を満たさないことを確認した
  | "unknown"     // 入力不足。ユーザーの追加入力で判定できる
  | "blocked";    // マスター未登録・未承認。ユーザー入力では解消しない

interface AlternativeControlRefs {
  crossReferenceLocators: string[]; // §50-1 の18(b) 相互参照・新旧対照表の該当箇所
  officialExampleCaseIds: string[]; // §50-1 の18(c) 再計算に用いた公式様式・公的計算例のケースID
  approvedBy: string;               // §50-1 の18(d) 監修税理士
  approvedAt: Instant;
}

interface MasterRecordRef {
  masterName: string;   // §3-1 の年度別マスター名
  recordId: string;
  reviewStatus: DataReviewStatus;
  sourceIds: string[];
  verificationMode: "two_primary_sources" | "single_primary_with_alternative_controls";
  alternativeControlRefs?: AlternativeControlRefs; // single_primary_… では必須
}

interface MethodEligibility {
  methodCode: string;
  status: EligibilityStatus;
  reasonCodes: string[];
  sourceIds: string[];
}

interface ExcludedItem {
  code: string;
  label: string;
  reason: string;
  amount?: Money;
  isAmountUnknown: boolean;
}

interface AmountRange {
  low: Money;              // 法的に妥当な下限。推定の幅ではない
  high: Money;             // 同上限。low <= high
  causeFieldPaths: string[]; // 幅を生んでいる未入力項目
  basisSourceIds: string[];  // 上下限の根拠
}

type SimulatorBreakdown =
  | { kind: "hojinnari"; data: HojinnariBreakdown }
  | { kind: "shohizei"; data: ShohizeiBreakdown }
  | { kind: "sozoku"; data: SozokuBreakdown }
  | { kind: "yakuin_hoshu"; data: YakuinHoshuBreakdown };

// 金額フィールドの省略は「制度上該当しない（§11 の ―）」または「除外項目として分離した」を意味する。
// 0円は省略ではなく value: 0 で表す。省略した項目を0円として合計・差額へ含めない。
interface TaxAndInsuranceTotals {
  incomeTax?: Money;
  reconstructionIncomeTax?: Money;
  residentTax?: Money;
  soleProprietorEnterpriseTax?: Money;  // 個人事業税。法人側では省略
  socialInsuranceEmployee?: Money;
  socialInsuranceEmployer?: Money;      // §11 の「内訳表示のみ」。合計行へ再加算しない
  corporateTaxes?: Money;
  consumptionTax?: Money;
}

interface HojinnariScenario {
  scenario: "sole_proprietor" | "corporation";
  personalDisposableCash?: Money;
  corporateRetainedCash?: Money;
  setupAndMaintenanceCosts?: Money;     // §11 により未入力時は省略。0円としない
  burdens: TaxAndInsuranceTotals;
}

interface HojinnariBreakdown {
  soleProprietor: HojinnariScenario;
  corporation: HojinnariScenario;
  personalDisposableDifference?: Money;
  combinedReferenceDifference?: Money;
}

interface ConsumptionMethodResult {
  methodCode: "general" | "simplified" | "twenty_percent_special" | "thirty_percent_special";
  eligibility: EligibilityStatus;
  taxPayable?: Money;
  refundReceivable?: Money;
  reasonCodes: string[];
}

interface ShohizeiBreakdown {
  period: DateRange;
  methodResults: ConsumptionMethodResult[];
  recommendedMethodCode?: ConsumptionMethodResult["methodCode"];
}

interface HeirTaxAllocation {
  heirId: string; // 画面内だけのランダムID。氏名を入れない
  acquiredAmount: Money;
  allocatedTaxBeforeCredits: Money;
  credits: Money;
  finalTax: Money;
}

interface SozokuBreakdown {
  grossEstate?: Money;
  nonTaxableAmounts?: Money;
  deductibleDebtsAndFuneralCosts?: Money;
  taxablePriceTotal?: Money;
  basicDeduction: Money;   // 法定相続人数から必ず算出できる
  taxableEstate?: Money;
  totalInheritanceTax?: Money;
  filingNeed: "not_required" | "possibly_required" | "required_for_special_rule" | "blocked";
  allocations: HeirTaxAllocation[];
}

interface CompensationCandidate {
  planId: string;
  annualCompensation: Money;
  personalNetCash: Money;
  corporateRetainedCash: Money;
  totalTaxAndInsurance: Money;
  deductibleStatus: EligibilityStatus;
}

interface YakuinHoshuBreakdown {
  objective: "minimize_burden" | "maximize_combined_cash" | "maximize_corporate_cash_with_personal_floor";
  selectedPlanId?: string;
  candidates: CompensationCandidate[];
  searchRange: { low: Money; high: Money };
}

// 内訳の税額・負担額・資金額は原則0円以上とし、差額フィールドだけ負数を許す。
// 還付は負の納税額で表さず refundReceivable に正数で保持する。
// combinedReferenceDifference は §11 の注意を必ず伴う。
// 合計・差額フィールドは、その算出に必要な項目が1つでも省略・除外されている場合に省略する。

interface Warning {
  code: string;
  level: WarningLevel;
  fieldPaths: string[];
  message: string;
  rationale: string;
  recommendedAction: string;
  blocksCalculation: boolean;
  sourceIds: string[];
}

interface SourceArtifact {
  artifactId: string;
  role: "raw_body" | "response_headers" | "pdf_image" | "extracted_text" | "inspection_copy";
  mediaType: string;
  byteSize: Decimal;       // 非負整数
  sha256: string;          // 保存したバイト列そのもの。正規化・改行変換の後に取らない
  storedAt: Instant;
  immutable: boolean;
  ledgerSeq: Decimal;      // 追記専用台帳の連番
  prevEntrySha256: string; // 直前の台帳エントリのハッシュ（§50-1 の14）
  quotable: boolean;       // 引用原文として表示してよいか。extracted_text と inspection_copy は false
}

interface SourceReview {
  retrievedBy: string;
  transcribedBy: string[];        // §50-1 の11の二者。同一の担当者・抽出器を2回並べない
  collatedBy: string;
  independenceBasis: string;      // 二者が独立である根拠（§50-1 の20）
  confusableTableVersion: string; // §50-1 の16の混同容易文字対応表の版
  normalizationDiff: "none" | "whitespace_only" | "material"; // §50-1 の17
  reviewedAt: Instant;
}

interface SourceReference {
  sourceId: string;
  authority: string;
  title: string;
  documentNumber?: string;
  url: string;
  publishedAt?: LocalDate;
  updatedAt?: LocalDate;
  retrievedAt: Instant;
  locator: string;       // 条・項・ページ・行・表番号等
  artifacts: SourceArtifact[];
  review: SourceReview;
  reviewStatus: DataReviewStatus;
  supersededBy?: string; // 再取得で差分を検知した場合の新原本の sourceId（§50-1 の19）
}
```

`resultStatus: "blocked"` の結果は結論額・有利不利・ランキングを持たず、停止理由と次の行動だけを表示する。`partial` は計算済み部分と除外部分を金額・ラベルの両方で分離し、除外部分を0円として合計しない。

各内訳型を自由な `Record<string, unknown>` へ後退させない。`blocked` の結果は `breakdown` を省略でき、金額を含む内訳を返さない。`partial` / `complete` は該当する判別可能な内訳型を必須とする。内訳型の金額フィールドを省略可能としているのはこのためであり、`partial` を返すために必須フィールドへ0円を埋めることを禁止する。`complete` の結果では、当該シナリオに制度上該当する項目をすべて持つ。

`taxYear` のような単一年度キーを結果型に持たせない。適用レコードの選択と再現は `calculationContext` と `masterSnapshotId` のみで行い、`periodLabel` は表示専用とする。`comparisonBasis` は制度が定常状態の平年度か、設立・廃業・就任・改定を含む移行年度かを示し、両者を同じ表・同じグラフへ混在させない。

型の不変条件は次のとおり。

- 本番結果の `sources` に載せられるのは `reviewStatus: "approved"` の資料だけとする。承認されていない資料は `sources` から落として計算を続けるのではなく、その資料に依拠する値を使った計算自体を停止する。`usedMasterRecords` に `approved` 以外のレコードが1件でもあれば `blocksCalculation: true` の `critical` 警告を付し `resultStatus` を `blocked` とする。根拠が表示できない数値を結論として返さない。
- `calculationContext.masterSnapshotId` と `masterSnapshotHash` をスナップショットの唯一の真実源とし、結果直下にも `handoff` にも重複保持しない。`usedMasterRecords` はそのスナップショット内で実際に選択されたレコードの列挙であり、スナップショットIDの代替ではない。
- `blocksCalculation: true` の警告が1件でもあれば `resultStatus` は `blocked`。`level` と `blocksCalculation` は直交し、`level: "critical"` かつ `blocksCalculation: false`（結論は出せるが専門家確認を要する）を許す。`info`・`attention` に `blocksCalculation: true` を許さない。
- `precision` は入力モードだけを表し、`resultStatus`・警告・除外項目のいずれも決めない。`simple` でも除外が無ければ `complete`、`detailed` でも除外があれば `partial` とする。
- `excludedItems` が空でない結果、`applicableMethods` に `unknown` または `blocked` を含む結果、標準税率等による概算を含む結果（§46）は `complete` を返さない。`complete` は「入力条件の範囲で除外・未確定が無い」ことを意味する。
- `EligibilityStatus: "unknown"` は不足入力の `fieldPaths` を持つ `attention` 警告を伴う。`"blocked"` は `blocksCalculation: false` の `critical` 警告を伴い、当該方式を比較・推奨から除外する（1方式の `blocked` は結果全体を停止させない）。
- `resultStatus`、`EligibilityStatus`、`DataReviewStatus` の `blocked` は同名だが対象が異なる。伝播は「マスターの審査状態 → 方式の適用可否 → 結果状態」の一方向に限り、結果状態から審査状態を推定しない。
- `Warning.sourceIds` と `MethodEligibility.sourceIds` は同じ結果の `sources[].sourceId` に存在するIDだけを指す。`MasterRecordRef.sourceIds` も同様とする。
- `excludedItems[].isAmountUnknown` が `true` の項目は `amount` を持たず、0円と表示・集計しない。
- `summary.range` を持つ結果は `summary.amount` を持たず、`resultStatus` は `partial` とする。範囲が生じている以上 `complete` にはならず、範囲内で結論が逆転する場合は §5 の1により範囲ではなく `blocked` を返す。`range.causeFieldPaths` は不足入力を示す `attention` 警告の `fieldPaths` と一致させる。
- `reviewStatus: "approved"` の `SourceReference` は `role: "raw_body"` と `"response_headers"` の artifact を最低1件ずつ持ち、すべての artifact が `immutable: true` であること。`review.normalizationDiff: "material"` の資料、`supersededBy` を持つ資料、`review.independenceBasis` が空の資料を `approved` にしない。
- `quotable: false` の artifact に由来する文字列を引用原文として画面・PDFへ表示しない。
- 内訳型の金額フィールドの省略は「制度上該当しない」か「除外項目として分離した」のいずれかを意味する。後者は `excludedItems` に対応する `code` を持つ。省略した項目を0円として合計・差額・グラフ・比較表へ含めない。`TaxAndInsuranceTotals.socialInsuranceEmployer` は §11 の内訳表示のみの項目であり、値を持つ場合も合計行へ加算しない。
- 適用できない選択肢に金額を持たせない。`ConsumptionMethodResult` は `eligibility: "eligible"` 以外のとき `taxPayable`・`refundReceivable` を持たず、`recommendedMethodCode` は `eligible` かつ届出期限内に選択できる方式だけを指す（§22）。`YakuinHoshuBreakdown.selectedPlanId` は `deductibleStatus: "eligible"` の候補だけを指す。`SozokuBreakdown.filingNeed: "blocked"` のとき `totalInheritanceTax` を持たず、`allocations` を空とする。
- マスター値の交差検証は資料単位ではなく値単位で記録する。`MasterRecordRef.verificationMode` が `"single_primary_with_alternative_controls"` のレコードは `alternativeControlRefs` を必須とし、いずれかの要素が空のレコードを `approved` にしない（§50-1 の18）。同じ `SourceReference` を根拠とする複数のマスター値が異なる `verificationMode` を持つことを許す。

## 7-1. シミュレーターサービス契約

```ts
interface NormalizationSuggestion {
  fieldPath: string;
  originalText: string;
  proposedText: string;
  reasonCode: string;
}

interface InputValidationError {
  code: string;
  fieldPath: string;
  message: string;
}

type ValidationResult<T> =
  | { ok: true; value: T; normalizationSuggestions: NormalizationSuggestion[] }
  | { ok: false; errors: InputValidationError[]; normalizationSuggestions: NormalizationSuggestion[] };

// 検証済みマスタースナップショットの読取専用ビュー。取込・照合は §50 の工程で完了しており、
// simulate はここから値を引くだけとする。索引の形は実装に委ねる。
interface MasterSnapshot {
  snapshotId: string;
  snapshotHash: string;
  legalStatusAsOf: LocalDate;   // どの時点の法的状態として固定したか（§48）
}

interface SimulatorService<I> {
  validate(input: unknown): ValidationResult<I>;
  simulate(input: I, context: CalculationContext, masters: MasterSnapshot): SimulationResult;
}

declare const hojinnariSimulator: SimulatorService<HojinnariInput>;
declare const shohizeiSimulator: SimulatorService<ShohizeiInput>;
declare const sozokuSimulator: SimulatorService<SozokuInput>;
declare const yakuinHoshuSimulator: SimulatorService<YakuinHoshuInput>;
```

- `simulate` はネットワーク、時刻取得、乱数、DOM、ストレージへアクセスしない。同じ入力・コンテキスト・スナップショットから同じ結果を返す。実行時刻が要る箇所は `context.calculatedAt` を使い、関数内で現在時刻を取得しない。
- 税率・閾値・適用日は第3引数の `masters` からのみ引く。モジュール内のグローバル変数や `import` した定数から参照しない。差し替え可能なグローバルを経由すると、コンテキストが同じでも結果が変わり、§64 の回帰テストと §48 の「公開済みスナップショットは不変」が保証されない。
- `simulate` は入口で `masters.snapshotId` / `snapshotHash` と `context.masterSnapshotId` / `masterSnapshotHash` の一致を検証する。不一致はプログラム不変条件違反として例外とし、`blocked` の結果で返さない（呼び出し側の組立て誤りであり、ユーザーが解消できないため）。
- 想定される入力不足・適用外・未承認マスターを例外として投げず、型付き警告と `resultStatus` で返す。プログラム不変条件違反だけを例外とし、UIはその場合に結果を破棄して一般的な障害表示を出す。
- UIは税額を再計算・補正せず、サービス結果を表示形式へ変換するだけとする。
- `validate` は入力値を変更せず、正規化候補とエラーを返す。ユーザー確認前に全角数字変換、単位換算、月額年額変換を確定しない。
- `validate` が `ok: false` を返すのは、値が型・書式・範囲として受け付けられない場合（桁あふれ、負数、小数円、日付として不正、期間の前後逆転など）に限る。値が入力されていないこと自体をエラーにしない。不足値は `I` の欠損として `simulate` へ渡し、§5 の判定順（`blocked` → 追加質問 → 範囲 → `partial`）と警告で表現する。`validate` で不足を先に弾くと、§5 が要求する `blocked` の結果も追加質問も発生しない。
- 入力型・内訳型・Wire型はJSON Schema等の実行時スキーマと同じソースから生成し、TypeScript型だけが更新される状態を禁止する。

---

# 8. ① 法人成り・法人化損得シミュレーター

## 8-1. URL

```text
/tools/hojinnari-simulator/
```

## 8-2. メイン検索意図

* 法人化 シミュレーション
* 法人成り シミュレーション
* 個人事業主 法人 どっちが得
* 法人化 節税
* 法人化 タイミング
* 個人事業主 法人 税金 比較

---

# 9. ① 入力項目

## かんたん計算

### 事業情報

* 年間売上高
* 年間経費
* 青色申告の有無
* 法人化後の希望役員報酬
* 年齢
* 所在都道府県
* 計算対象年

経費については、

> 「役員報酬を除いた事業経費」

であることを明記する。

---

## 詳細計算

追加項目：

### 個人側

* 青色申告特別控除額
* その他所得
* 所得控除の内訳（所得税用・住民税用を共通額とみなさない）
* 配偶者
* 扶養人数
* 現在の年間国民健康保険料
* 国民年金保険料
* 個人事業税対象業種
* 事業主控除の月割り判定に必要な開廃業日
* 住民税の計算対象（平年度ベース / 実際の対象年）

所得控除と税額控除を同じ入力へ入れない。社会保険料控除、配偶者・扶養関係等は合計額入力と内訳入力を排他的にし、二重控除を防ぐ。住宅ローン控除等の税額控除は課税所得の前ではなく、税率適用後の専用モジュールで扱う。所得税と住民税で控除額・要件が異なるものは税目別マスターを選択する。

国民健康保険については全国の市区町村計算を最初から完全実装しない。

優先順位：

1. ユーザーが実際の年間国保額を入力
2. 未入力の場合のみ概算値
3. 将来、市区町村別国保計算を追加

とする。

---

### 法人側

* 法人所在地
* 資本金
* 従業員数
* 役員報酬
* 役員年齢
* 配偶者役員の有無
* 配偶者役員報酬
* 法人の事業年度開始日・終了日
* 設立予定日
* 役員就任日・報酬改定予定日
* 加入する健康保険者（協会けんぽ / 健保組合等）
* 賞与の有無と支給予定

---

# 10. ① 計算ロジック

## 個人事業主

```text
売上
－必要経費
＝青色申告控除前所得

－青色申告特別控除
＝事業所得

＋その他所得
－所得控除
＝課税所得
```

ここから、

* 所得税
* 復興特別所得税
* 住民税
* 個人事業税
* 国民健康保険
* 国民年金

を算出。

上の式は課税標準までの略記であり、そのまま実装しない。次の段階を独立した関数と `calculation_order` に分ける。

1. 所得区分ごとの各種所得の金額（事業・不動産・給与・雑・譲渡・一時等）
2. 青色申告特別控除（不動産所得・事業所得の順に、控除前所得を限度として充当。控除額の区分と要件はマスターで判定し、要件を確認しないまま最大額を適用しない）
3. 損益通算
4. 純損失・雑損失の繰越控除
5. 総所得金額等の確定（総合課税と分離課税を別集計）
6. 所得控除（雑損控除を先に適用し、以降の順序も `calculation_order` で固定）
7. 課税総所得金額等（端数規則を `rounding_rule_id` で指定）
8. 税率適用、税額控除、付加税

「その他所得」を単一の金額として総所得へ加算しない。分離課税の所得を総合課税の課税標準へ混入させると、税率、住民税、付加税の基数が同時に壊れる。入力は所得区分と課税方式を必須項目とし、区分不明の所得がある場合は `resultStatus: "blocked"` とする。

「合計所得金額」「総所得金額等」「課税総所得金額」を同一変数で扱わない。配偶者・扶養・基礎控除の適用判定は合計所得金額、税率適用は課税総所得金額であり、取り違えると控除の可否と税額が同時に誤る。

国民健康保険料・国民年金保険料は事業の必要経費ではなく社会保険料控除の対象である。§9 の入力値が必要経費と所得控除の双方へ流れないよう、入力フィールドの用途を型で固定し、必要経費の内訳に社会保険料・掛金が含まれていないことを確認する質問を置く。小規模企業共済・iDeCo等の掛金も、必要経費と小規模企業共済等掛金控除の二重計上を禁止する。個人事業者と法人役員では加入資格と拠出限度額が変わるため、法人化後の掛金を個人事業時の金額のまま引き継がない。

住民税は所得税と控除額、非課税限度額、調整控除が異なる。所得税の課税所得へ住民税率を乗じる実装を禁止し、住民税用の所得控除で課税標準を作り直す。人的控除差に基づく調整控除、均等割、定額で賦課される税目は所得割と分離し、未登録の自治体項目は標準税率・標準額による概算である旨を結果へ表示する。

所得税と住民税は同じ年に同時確定するものとして扱わない。住民税は原則として前年所得に基づくため、「平年度比較」と「設立初年度・翌年度の年次キャッシュフロー比較」を分ける。予定納税、中間納付、納付時期は税額そのものと別レイヤーで扱う。

法人成りの年は個人事業期間と法人事業年度が同一暦年に併存する。売上・経費は年額を月割按分せず、期間帰属で分けて入力させ、同一金額を個人側と法人側の双方へ計上しない。個人事業の廃止日、法人設立日、役員就任日、社会保険の資格取得月、住民税の賦課年度がそれぞれずれることを前提とし、出力には `comparisonBasis` と各期間の開始日・終了日を必ず含める。

---

## 法人

```text
売上
－事業経費
－損金算入できる役員報酬
－損金算入できる会社負担社会保険
＝会計上の税引前利益（概算）

＋加算調整
－減算調整
－繰越欠損金の当期控除額
＝法人税の課税所得（概算）
```

会計利益をそのまま法人所得として扱わない。交際費、寄附金、減価償却、引当金、租税公課、役員給与、受取配当等の申告調整を初期版で扱えない場合は、該当有無を質問し、税額へ影響する金額が不明なら `blocked`、影響範囲を分離して示せる場合だけ `partial` とする。未入力の調整額を0円とみなす場合は、その前提を結果へ表示する。

繰越欠損金の当期控除額を申告調整と同じ段階へ置かない。所得金額は「会計上の税引前当期純利益＋加算調整－減算調整」で確定させ、繰越欠損金はその所得金額に対して、法人区分ごとの控除限度割合、繰越期間、古い事業年度から順に充当する規則で計算する。控除限度割合・繰越期間・青色申告要件はマスター化し、未登録の間は欠損金を全額控除できるものとして計算しない。

法人事業税・特別法人事業税は原則として納付した事業年度の損金であり、当期の税額を当期の損金へ算入すると循環参照と二重控除が生じる。損金算入する事業年度を明示し、平年度比較（`steady_state`）では定常状態の前提を、移行年度比較（`transition_year`）では実際の期ズレを表示する。会社負担社会保険料についても、損金算入の対象月と未払計上の有無を計算前提として表示する。

税目の列挙を「その他現行法人課税」で締めない。適用し得る法人課税を列挙型で固定し、法人税額等を課税標準とする付加税を含め、事業年度開始日で適用が切り替わる税目の有無を基準日時点の一次資料で確認する。未確認の税目が残る事業年度について `resultStatus: "complete"` を返さない。

ここから、

* 法人税
* 地方法人税
* 法人住民税
* 法人事業税等
* その他現行法人課税

を計算。

法人住民税均等割は赤字でも発生し得るため、所得連動部分と分離する。法人事業税・特別法人事業税を含む範囲、欠損金、事業年度月数、設立初年度の月数按分、法人税等の損金算入可否を明示的に実装する。初期版で扱わない税額控除、留保金課税、外形標準課税等は適用条件を検知して専門判定へ送る。

別途役員個人について、

```text
役員報酬
↓
給与所得
↓
所得控除
↓
所得税
住民税
社会保険本人負担
↓
個人手取り
```

を計算。

---

# 11. ① 最終比較

最低限次を表示する。

| 項目       | 個人事業 | 法人化 |
| -------- | ---: | --: |
| 所得税      |      |     |
| 住民税      |      |     |
| 個人事業税    |      |   ― |
| 法人税等     |    ― |     |
| 本人社会保険   |      |     |
| 会社社会保険   |    ― |     |
| 個人手取り    |      |     |
| 法人税引後利益  |    ― |     |
| 法人＋個人手残り |      |     |

重要：

「法人＋個人手残り」は、

> 法人内部に残る資金は社長個人が自由に使える資金ではありません。

と明記する。

「法人＋個人手残り」は帰属の異なる資金を足した参考指標である。結論カードでは、少なくとも次を併記し、単一指標だけで法人化を推奨しない。

```text
個人が当年中に自由に使える概算資金
法人に留保される概算資金
税・社会保険の合計負担
設立・維持コスト控除前後
```

法人設立費用、税理士・社労士費用、会計・登記等の維持費は任意入力とし、未入力時は比較対象外として金額を仮定しない。

表の各行は帰属主体と控除段階を持つ。会社負担社会保険は法人の損金として「法人税引後利益」へ既に反映されているため、「会社社会保険」行を合計行へ再度加算しない。合計対象と内訳表示のみの区別は §7 の `TaxAndInsuranceTotals` の定義に従い、合計行はその区分から機械的に算出する。表の `―` は §7 の該当フィールドの省略として表し、0円と区別する。0円と表示してよいのは、制度上該当したうえで税額が0円になる場合に限る。

---

# 12. ① 消費税との連携

初期状態では、

> 消費税を比較に含めない

とする。

結果欄に明示：

```text
消費税：比較対象外
```

詳細モードでは、

```text
□ 消費税も含めて比較する
```

を用意。

ONの場合は②消費税エンジンを呼び出す。

---

# 13. ① 役員報酬との連携

役員報酬入力欄付近に、

> 「役員報酬をいくらにすればいいか分からない」

という導線を設置。

クリック：

```text
→ 役員報酬最適化シミュレーター
```

④の結果を①へ渡せる設計にする。

---

# 13-1. ツール間受け渡し契約

①②③④は同一エンジンを共有するため、画面間の値渡しを自由形式にしない。

受け渡しは `SimulationResult` と、送信元が明示した次の型に限る。自由形式のオブジェクトを渡さない。

```ts
interface HandoffField {
  path: string;                                  // 受け側の入力スキーマ上のパス
  label: string;
  value: Money | Rate | LocalDate | string;      // メモリ内表現。Wire型へ変換しない（§3-3）
}

interface Handoff {
  handoffSchemaVersion: string;
  sourceSimulator: SimulationResult["simulatorType"];
  sourceResultStatus: SimulationResult["resultStatus"];
  calculationContext: CalculationContext;        // スナップショットID・ハッシュはこの中だけに持つ
  inputSchemaVersion: string;
  calculationVersion: string;
  fields: HandoffField[];
  warnings: Warning[];
  excludedItems: ExcludedItem[];
}
```

* 受け側は `calculationContext` 内のスナップショットID・ハッシュ、期間、`Jurisdiction`（`codeSystemVersion` と `asOfForCodes` を含む）、保険者の一致を検証する。一致しない場合は自動変換せず、受け側のコンテキストで再計算するか `blocked` を返す。
* `sourceResultStatus: "blocked"` の結果を `Handoff` の材料にしない。`"partial"` を渡す場合は `warnings` と `excludedItems` をそのまま同梱し、受け側は自らの結果を `complete` にできない。送信元の除外項目を受け側で0円として扱わない。
* 受け側は渡された値を再計算の入力としてのみ用い、送信元が算出した税額・手取り・有利不利を自らの結果へ転記しない。同じ数値を二つのツールが別々に確定したかのように表示しない。
* ④→①では役員報酬月額だけでなく、事業年度、役員就任日、報酬改定日、標準報酬の決定方法、賞与の有無を併せて渡す。月額のみの引継ぎを禁止する。
* ①→②では税抜・税込区分と税率別内訳を渡す。①の税抜金額と②の課税売上を突合し、差異があれば警告する。
* ②を①の比較へ含める場合、消費税を経費側と納税額側の双方へ二重計上しない。控除対象外消費税額等の扱いを計算前提として表示する。
* 受け渡しは同意なしにサーバーを経由せず、ブラウザ内の明示的な遷移で行う（§57）。`Handoff` は §57-1 のメモリ内オブジェクトのまま渡し、外部形式へ直列化してURL・ストレージ・`postMessage` へ載せない。直列化しないため金額は `Money` のまま扱い、`fields` だけを `Wire` 型にするような混在をしない。

---

# 14. ② 消費税 最適方式比較シミュレーター

## URL

```text
/tools/shohizei-simulator/
```

## 目的

利用可能な方式をまず判定し、その後、

* 一般課税（原則課税）
* 簡易課税
* 2割特例
* 3割特例

について比較する。

単に4方式を全部表示してはいけない。

基準日現在、3割特例は個人事業者の令和9年分・令和10年分を対象とする制度であり、2026年（令和8年）の課税期間には適用しない。方式名を固定表示せず、課税期間と事業者区分から候補を生成する。

---

# 15. ② STEP1 適用可否判定

質問例：

### 基本

* 個人事業者 / 法人
* 課税期間
* インボイス登録済みか
* インボイス登録日
* インボイス登録を機に免税→課税になったか
* 基準期間課税売上高
* 簡易課税選択届出書の状況
* 基準期間だけでなく特定期間の課税売上高・給与等支払額
* 新設法人・特定新設法人等の該当可能性
* 課税事業者選択届出書と不適用届出書の状況
* 相続・合併・会社分割・高額資産取得等の該当可能性
* 課税期間の開始日・終了日・短縮特例の有無

判定例：

```text
一般課税　　○ 利用可能
簡易課税　　○ 利用可能
2割特例　　 ○ 利用可能
3割特例　　 × 対象外
```

対象外の場合、

> 法人のため3割特例の対象外です。

など理由も表示する。

適用可否は単なる真偽値ではなく、`eligible`、`ineligible`、`unknown`、`blocked` と理由コードを返す。各値の意味と伴う警告は §7 の定義に従い、入力不足による `unknown` とマスター側の不足による `blocked` を同じ扱いにしない。届出期限、継続適用期間、強制適用期間も判定し、「税額が小さい方式」と「実際に選択できる方式」を混同しない。

判定は課税期間全体を単位とする1つの真偽ではなく、期間ごとの状態として持つ。少なくとも次を分解する。

- インボイス登録日が課税期間の中途にある場合、登録日の前日までと登録日以後で納税義務が変わる。売上・仕入れを登録日で分割入力させ、年額を按分しない。§18 の仕入側の期間分割だけでは足りない。
- 課税事業者選択届出書、簡易課税選択届出書、各不適用届出書について、提出期限、効力が生じる課税期間、継続適用（強制適用）期間、調整対象固定資産・高額特定資産の取得による強制適用の延長を、課税期間ごとの状態として判定する。
- 2割特例・3割特例の適用対象課税期間を `invoice_transition_master` とは別レコードとしてマスター化し、未登録の課税期間について `eligible` を返さない。（2026-08-26 更新。初版は「終期がマスターに無い」としていたが、その後 `small_business_special_deduction` として登録済み。2割特例は令和5年10月1日から令和8年9月30日まで、3割特例は令和9年分・令和10年分）
- 適用対象課税期間の判定は、**課税期間がその期間のいずれかの日を含むか**で行う。2割特例は「令和5年10月1日から令和8年9月30日までの日の属する各課税期間」（平成28年改正法附則51条の2）であり、課税期間の開始日だけ、あるいは終了日だけで判定してはいけない。個人事業者の令和8年分（令和8年12月31日終了）は、終了日が令和8年9月30日より後でも対象になる。この判定規則はレコードの `period_match_rule` に持たせ、`effective_from` / `effective_to` を単一の日付と突き合わせる通常の判定と区別する。
- 2割特例の適用を受けた課税期間の翌課税期間に簡易課税を選択する場合の届出時期の特例を、通常の届出期限と別レコードで判定する。
- 基準期間が無い、または基準期間が1年でない場合の課税売上高の扱いを、期間の長さから機械的に判定する。

---

# 16. ② かんたん計算

入力：

* 年間課税売上
* 年間課税仕入・経費
* 主な業種
* 10%売上割合
* 8%売上割合
* 輸出売上
* 免税事業者等からの仕入れの有無

入力金額について、

```text
税込
税抜
```

切替を付ける。

内部ではすべて統一フォーマットへ変換する。

税込・税抜の選択は入力全体で一括推定せず、税率・取引区分ごとに保持する。売上返品・値引き・貸倒れ、仕入返品、課税売上割合、個別対応方式・一括比例配分方式を扱わない簡易モードでは、その影響を除外項目に表示する。

---

# 17. ② 詳細計算

## 売上

* 10%課税売上
* 8%課税売上
* 輸出免税売上
* 非課税売上
* 不課税売上

## 仕入・経費

* 10%課税仕入
* 8%課税仕入
* インボイスあり
* インボイスなし
* 非課税仕入
* 不課税
* 人件費等

---

# 18. ② インボイス経過措置

インボイス未登録事業者からの仕入れについては、

```text
invoice_transition_master
```

で日付ごとの控除割合を管理。

課税期間の途中で割合が変更される場合、

```text
2026/1～9
2026/10～12
```

のように入力欄を自動分割する。

年間金額を単純按分してはいけない。

2026年度改正後は、免税事業者等からの課税仕入れに係る控除割合を取引日・課税期間開始日・相手先別上限で判定する。少なくとも次の期間をマスター化する。

```text
2023-10-01～2026-09-30  80%
2026-10-01～2028-09-30  70%
2028-10-01～2030-09-30  50%
2030-10-01～2031-09-30  30%
2031-10-01以後          0%
```

ただし2026年度改正の相手先別上限等には「2026年10月1日以後に開始する課税期間」の条件があるため、取引日だけで判定しない。証憑・帳簿保存要件を満たすか不明な場合は控除可能と断定しない。

相手先別上限は、2026年10月1日以後に開始する課税期間について、同一のインボイス発行事業者以外の者から行う経過措置対象の課税仕入れの税込合計額が、その年または事業年度で1億円を超える場合、その超過部分に経過措置を適用しない。控除割合の期間表とは別レコードとして次を管理する。

```text
counterparty_annual_cap_amount   100000000   # Money型・税込。§3-3 の TaxIncl で区分を保持
counterparty_aggregation_unit    同一のインボイス発行事業者以外の者
cap_period_basis                 個人は年、法人は事業年度
cap_excess_treatment             1億円を超える部分のみ経過措置対象外
applies_to_period_start_from     # 2026-10-01以後に開始する課税期間
```

相手先を法的に同一と名寄せできない、相手先別年間仕入額を入力できない、または期中に組織変更等がある場合は、上限未満と推定せず `blocked` を返す。かんたん計算で相手先別内訳がない場合も、該当課税期間について一般課税の最終額を `complete` として表示しない。

`cap_period_basis` の「年または事業年度」は課税期間と一致するとは限らない。課税期間の短縮、設立初年度、年の中途の開廃業では上限判定の期間と控除計算の課税期間がずれるため、両者を別の期間軸として保持する。ずれる場合に上限未満と推定せず `blocked` とする。

---

# 19. ② 簡易課税

主業種だけではなく、詳細モードでは複数事業区分に対応する。

```text
第1種
第2種
第3種
第4種
第5種
第6種
```

それぞれの売上を入力可能とする。

例：

```text
Amazon物販　　　第2種　1,500万円
コンサル　　　　第5種　300万円
```

複数事業を営んでいる場合の簡易課税計算ルールもエンジン化する。

事業区分は表示例から自動確定せず、ユーザー選択と注意喚起を基本とする。複数事業の特例計算、事業区分不能売上、売上返品等を含む国税庁の計算順序をテストケース化する。

---

# 20. ② 輸出対応

eBay等の輸出事業者を想定し、

```text
輸出免税売上
```

を必ず別入力にする。

一般課税の場合の還付可能性と、

簡易課税・特例を利用した場合の違いが可視化できるようにする。

結果がマイナスの場合、

```text
概算還付額
```

として表示する。

簡易課税および2割・3割特例では仕入税額から直接算出する還付と同じ構造にならないため、「還付可能性」の比較理由を方式ごとに説明する。輸出免税と国外取引（不課税）を混同しない。

---

# 21. ② 初期版対象外

以下は初期バージョンでは「専門判定」とする。

* リバースチャージ
* 特定課税仕入れ
* 課税売上割合が複雑な事業
* 調整対象固定資産
* 高額特定資産
* 課税期間短縮
* 合併・分割
* 特殊な免税点判定

該当チェックがONの場合、

> このシミュレーターだけでは正確な判定ができない可能性があります。

を表示する。

将来拡張する。

---

# 22. ② 結果画面

例：

```text
あなたが利用可能な方式

○ 一般課税
○ 簡易課税
○ 2割特例
× 3割特例
```

続いて、

```text
年間納税額

2割特例　　 420,000円
簡易課税　　 610,000円
一般課税　　 830,000円
```

そして、

> 今回の入力条件では、2割特例が最も納税額の少ない試算となりました。

と表示。

差額：

```text
一般課税との差額
▲410,000円
```

方式一覧を固定の4行にしない。表示する行は §15 の適用可否判定が返した候補だけとし、`ineligible`・`unknown`・`blocked` の方式に納税額を並べて比較しない。推奨表示は `eligible` かつ届出期限内に選択できる方式に限り、納税額が最小でも選択できない方式を結論カードへ出さない。§18 により一般課税を `complete` にできない課税期間では、一般課税との差額を確定額として表示しない。

---

# 23. ③ 相続税「かかる？いくら？」シミュレーター

## URL

```text
/tools/sozokuzei-simulator/
```

## 入口

最初に、

```text
あなたの場合
相続税申告が必要か
1分で簡易診断
```

を表示する。

---

# 24. ③ 2段階構造

## LEVEL 1

「相続税がかかりそうか」

## LEVEL 2

「相続税はいくらか」

## LEVEL 3

「一次＋二次相続をどう分けるか」

と段階的に進む。

---

# 25. ③ 法定相続人入力

質問形式。

* 配偶者
* 実子人数
* 養子人数
* 子が死亡しているか
* 父母
* 兄弟姉妹
* 被相続人との続柄と各人の生死・死亡日
* 相続開始日
* 各取得者・被相続人の住所地および国籍に関する専門判定項目

複雑ケース：

* 代襲相続
* 相続放棄
* 複数養子
* 半血兄弟
* 特別養子等

については詳細入力または専門相談へ誘導。

養子については税法上の法定相続人数制限を計算ロジックへ反映する。

民法上の相続人、法定相続分、相続税の基礎控除等に用いる「法定相続人の数」を別データとして保持する。相続放棄があっても税法上は放棄がなかったものとして法定相続人の数を数える場面があるため、単純に人数から除外しない。特別養子等の実子扱い、代襲原因、欠格・廃除は理由コード付きで判定する。

---

# 26. ③ 財産入力

基本項目：

```text
現預金
有価証券
土地
建物
死亡保険金
死亡退職金
事業用資産
その他財産
生前贈与加算対象財産
相続時精算課税適用財産
```

控除：

```text
借入金
未払金
葬式費用
その他債務
```

死亡保険金・死亡退職金は総額だけでなく受取人別に入力し、相続人が取得した場合の非課税限度額を別計算する。債務・葬式費用は負担者と控除可否を分ける。名義預金、国外財産、未分割財産、生命保険契約に関する権利等は専門判定項目とする。

---

# 27. ③ 不動産入力

ユーザーに最初に、

> 相続税評価額が分かりますか？

と質問する。

### 分かる

評価額を直接入力。

### 分からない

簡易計算：

土地：

```text
路線価 × 面積
```

建物：

```text
固定資産税評価額
```

ただし、

* 奥行価格補正
* 不整形地
* 貸家建付地
* 借地権
* その他土地評価補正

は初期簡易計算には含めない。

必ず、

> 実際の相続税評価額とは異なる場合があります。

と表示する。

路線価方式には地積以外の補正が通常必要になり得るため、「路線価×面積」は申告用評価ではなく一次スクリーニング専用とする。倍率地域、共有持分、借地権等を検知した場合は直接入力または専門判定へ切り替える。

---

# 28. ③ 基本計算

```text
課税価格合計
－基礎控除
＝課税遺産総額
```

法定相続分にいったん配分。

各法定相続分に税率を適用。

合計して相続税総額を算出。

実際の取得割合に応じて税額を配分。

## 28-1. 計算順序と適用段階

上の略記を次の段階へ分解し、各段階に `calculation_order` と `rounding_rule_id` を付与する。段階を入れ替えると税額が変わるため、順序を実装の裁量に委ねない。

1. 各人の取得財産（本来の財産＋みなし相続財産）
2. 死亡保険金・死亡退職金の非課税限度額を、相続人が取得した金額の比で各人へ配分する（相続を放棄した者は非課税の適用対象としない）
3. 非課税財産の除外
4. 各人の債務・葬式費用の控除（実際に負担する者から控除し、負担者以外から控除しない。控除しきれない額を他の相続人へ回さない）
5. 相続時精算課税適用財産の加算
6. 生前贈与加算（加算対象期間は相続開始日と贈与日の組合せで判定する。経過措置を含む対象期間と控除額はマスター化し、未登録の間は `blocked` とする）
7. 各人の課税価格（法定の端数処理を適用）
8. 課税価格の合計額
9. 基礎控除額の控除（法定相続人の数は §25 の税法上の人数を使う）
10. 課税遺産総額
11. 法定相続分に応ずる各取得金額（法定の端数処理を適用）
12. 税率適用
13. 相続税の総額
14. 各人の課税価格の比による按分（按分割合の端数調整規則を定め、各人の税額の合計が総額と一致することを検証する）
15. 各人の算出税額
16. 相続税額の加算（配偶者および一親等の血族以外が取得した場合。代襲相続人となる直系卑属等の例外を理由コード付きで判定する。加算は税額控除より前）
17. 税額控除（贈与税額控除、配偶者の税額軽減、未成年者控除、障害者控除、相次相続控除、外国税額控除、相続時精算課税分の贈与税額控除の順に適用する。未成年者控除・障害者控除の控除不足額を扶養義務者から控除する処理を含める）
18. 各人の納付税額（法定の端数処理を適用。相続時精算課税分の贈与税額控除により還付が生じる場合と、控除しきれずに0円となる場合を区別する）

小規模宅地等の特例（§31）は7の課税価格の段階、配偶者の税額軽減（§30）は17の税額控除の段階であり、両者を「特例適用後」として同じ行に合算表示しない。各段階の端数処理の単位・方向・金額の刻みは一次資料で確認するまで `blocked` とし、推定値で計算しない。

---

# 29. ③ 申告要否判定

重要。

### A

正味遺産額 ≤ 基礎控除

```text
原則として相続税申告不要
```

### B

基礎控除超

```text
相続税申告が必要となる可能性があります
```

配偶者税額軽減や小規模宅地等の特例によって最終納付額0円になっても、

特例利用のため申告が必要なケースがあるため、

```text
税額0円
≠
申告不要
```

をロジック・表示とも区別する。

---

# 30. ③ 配偶者の税額軽減

配偶者取得額を入力。

配偶者税額軽減を適用した、

```text
適用前税額
適用後税額
軽減額
```

を表示する。

配偶者の税額軽減は実際の分割・取得額と申告を前提とする。未分割、申告期限後の分割、隠蔽・仮装財産等を簡易計算の対象外として警告する。

---

# 31. ③ 小規模宅地等の特例

初期対応：

```text
特定居住用宅地等
```

入力：

* 土地評価額
* 面積
* 取得者
* 配偶者
* 同居親族等
* 適用予定面積
* 相続開始直前の利用状況
* 取得者の居住・所有状況
* 申告期限までの保有・居住見込み

ただし、

> 適用可能性の簡易判定

とし、

「必ず適用できる」と断定しない。

LEVEL 1の申告要否判定では、小規模宅地等の特例適用前の課税価格と、申告を要件とする特例適用後の納付税額を別々に表示する。

限度面積と減額割合は宅地等の区分ごとにマスター化し、複数の宅地等がある場合の限度面積の調整計算を実装する。区分判定に必要な情報が揃わない場合、適用可能面積を最大として計算しない。

---

# 32. ③ 二次相続

配偶者がいる場合のみ表示。

入力：

```text
配偶者固有財産
一次相続で配偶者が取得する割合
二次相続時の想定法定相続人
二次相続までの想定年数
年間生活費・財産増減率（任意）
```

比較：

```text
0%
10%
20%
…
100%
```

各割合について、

```text
一次相続税
二次相続税
合計税額
```

を計算。

各割合は遺産分割可能性・遺留分・換価性を保証しない。一次相続で取得した財産だけを二次相続財産とせず、配偶者固有財産、一次相続後の税・費用、設定した増減仮定を反映する。

---

# 33. ③ 二次相続の注意

二次相続については、

* 配偶者の財産増減
* 生活費消費
* 生前贈与
* 資産価格変動
* 二次相続までの期間
* 相次相続控除

等によって結果が変わる。

したがって、

> 現在の財産額がそのまま二次相続時まで続くと仮定した概算

と明記する。

---

# 34. ③ 結果画面

最上部：

```text
相続税申告
必要となる可能性があります
```

次：

```text
遺産総額　　　72,000,000円
基礎控除　　　48,000,000円
課税対象概算　24,000,000円
```

次：

```text
概算相続税　○○円
```

さらに：

```text
一次＋二次相続比較
```

グラフ表示。

---

# 35. ④ 役員報酬最適化シミュレーター

## URL

```text
/tools/yakuin-hoshu-simulator/
```

---

# 36. ④ 3モードを実装

### MODE A

```text
最適な役員報酬を探す
```

### MODE B

```text
欲しい手取りから逆算
```

### MODE C

```text
役員報酬から手取り計算
```

---

# 37. MODE A 入力

* 役員報酬控除前利益
* 法人所在地
* 資本金
* 従業員数
* 役員年齢
* 配偶者
* 扶養親族
* その他所得
* その他所得控除

詳細：

* iDeCo
* 小規模企業共済
* 生命保険料控除
* 住宅ローン控除等
* 計算対象事業年度
* 役員就任日・直前の報酬・改定理由と改定日
* 健康保険者、標準報酬の決定方法、賞与
* 会社の必要運転資金・最低留保額

第1弾の①・④画面では、本人・配偶者・16歳以上の扶養親族に係る障害者控除と、小規模企業共済等掛金控除だけを追加対応する。扶養親族の同居特別障害者は同居扶養から先に割り当て、人数の包含関係を入力組立時に検証する。①の掛金は個人事業時と法人化後を別入力とし、一方の金額を他方へ引き継がない。掛金は税・社会保険ではなく本人に残る積立資産であるため、所得控除には反映するが手取りから支出として差し引かない。生命保険料控除・地震保険料控除・寄附金控除・住宅ローン控除、および16歳未満の扶養親族に係る障害者控除は第2弾以降とする。

---

# 38. MODE A 探索

役員報酬を、

```text
100,000円
110,000円
120,000円
…
```

のように一定刻みで走査。

刻み幅：

```text
1万円
5万円
```

を選択可能にする。

上限は設定ファイル化。

各候補が税務上損金算入可能な定期同額給与等の要件を満たすとは限らない。期中改定、就任初年度、事前確定届出給与、過大役員給与等に該当し得る場合は自動最適化の対象外または専門判定とする。探索範囲外に最適点がある場合は「上限付近」と明示し、最適値と断定しない。

探索の候補は「支給月額」ではなく「事業年度を通じた支給計画」とする。候補ごとに次を判定し、要件を満たさない候補を最適解として提示しない。

- 定期同額給与の要件（支給時期が1月以下の一定期間ごとで、各支給時期の支給額が同額）。改定が認められる時期・事由（事業年度開始から一定期間内の通常改定、臨時改定事由、業績悪化改定事由）はマスターで判定し、期限が未登録の間は改定を伴う候補を `blocked` とする。
- 期中改定を含む事業年度で年額を月額×12として計算しない。改定日で期間を分割し、改定前後それぞれの支給額と月数で年額を積み上げる。就任初年度・設立初年度も在任月数・事業年度月数で計算する。損金不算入となる差額は法人所得へ加算する。
- 事前確定届出給与による賞与は、届出の有無、届出期限、届出どおりの支給を前提条件として入力させる。届出の無い賞与を損金算入したまま探索しない。
- 過大役員給与に該当し得る水準（職務内容、同業種同規模との比較、定款・株主総会の決議による支給限度額）を探索の上限制約として入力させる。上限が未入力のまま探索上限に達した候補は「上限付近」と表示し、最適とラベルしない。
- 使用人兼務役員、非常勤役員、複数役員間の配分は初期版の探索対象外とし、該当時は `blocked` とする。

社会保険料は報酬額から即時には決まらない。候補ごとに標準報酬月額の等級、資格取得時決定・定時決定・随時改定の適用月、賞与の標準賞与額と年間上限を計算し、報酬改定月と保険料変更月のずれを反映する。会社負担分を法人側の損金へ入れる事業年度も候補間で揃える。

---

# 39. ④ 「最適」の定義

単に「最適役員報酬」と呼ばない。

ユーザーに最適化基準を表示する。

### 基準A

```text
税金＋社会保険負担が最小
```

### 基準B

```text
法人＋個人の手残り最大
```

### 基準C

```text
個人手取りを確保しつつ会社に最も多く残す
```

初期デフォルト：

```text
法人＋個人の年間手残り最大
```

とする。

基準Bでも法人留保と個人可処分所得を同価値とみなす仮定を明示する。法人資金を個人へ移す将来課税、退職金、配当、資金繰り、借入契約、年金給付への影響を含まない。基準Cでは最低個人手取りと最低法人留保を制約条件として入力させる。

---

# 40. ④ 各報酬額で計算するもの

## 個人

```text
役員報酬
給与所得
社会保険本人負担
所得税
復興特別所得税
住民税
個人手取り
```

## 法人

```text
役員報酬
社会保険会社負担
法人所得
法人税等
税引後利益
```

§37 の「役員報酬控除前利益」は、会計上の税引前当期純利益から役員報酬と会社負担社会保険料を除いた金額とし、申告調整前・繰越欠損金控除前であることを入力欄に明示する。ここから §10 の法人所得の段階（申告調整 → 所得金額 → 繰越欠損金控除）を経由して法人税等を計算し、④が①の申告調整規定を迂回しないようにする。会社負担社会保険料をこの利益に含めるか否かの解釈を利用者に委ねない。

---

# 41. ④ 結果

例：

```text
今回の条件では

月額役員報酬
520,000円前後

で法人＋個人の年間手残りが
最大となる試算です。
```

ただし、

> 税・社会保険上の数値比較であり、会社の資金繰りや生活費、将来の年金額等まで含めた「最適」を意味するものではありません。

と明示する。

---

# 42. ④ グラフ

横軸：

```text
役員報酬月額
```

縦軸：

```text
法人＋個人手残り
```

さらに切替：

* 個人手取り
* 会社手残り
* 税負担
* 社会保険負担

を表示。

---

# 43. MODE B 手取り逆算

入力：

```text
希望手取り月額
```

例：

```text
手取り40万円欲しい
```

結果：

```text
必要役員報酬
約508,000円/月

会社負担社会保険
約○円

会社年間総コスト
約○円
```

逆算結果も §38 と同じ損金算入要件の判定を通す。手取りは標準報酬の等級と税率区分により階段状に変化するため、単調性を仮定した解析解ではなく順算関数を用いた探索で求め、解が存在しない場合と複数存在する場合は範囲として表示する。月額と賞与の配分によっても手取りは変わるため、支給計画を指定せずに単一の必要報酬額を断定しない。

---

# 44. MODE C 順算

入力：

```text
役員報酬月額500,000円
```

結果：

```text
額面　　　　500,000円
社会保険　▲○円
所得税　　▲○円
住民税　　▲○円

月手取り　約○円
```

---

# 45. 社会保険計算共通モジュール

以下を年度マスターで管理。

```text
健康保険
介護保険
厚生年金
子ども・子育て支援関連
事業主のみ負担するもの
```

健康保険：

```text
年度
都道府県
```

で管理。

標準報酬月額等級を必ず使用。

単純に、

```text
給与×○%
```

としてはいけない。

標準報酬月額は資格取得時決定、定時決定、随時改定等を区別し、報酬変更が直ちに同月の保険料を変えるものとして扱わない。賞与は標準賞与額で別計算する。介護保険は年齢到達月等、健康保険は保険者・都道府県、保険料徴収は適用月で判定する。

2026年度からの「子ども・子育て支援金」と、事業主のみが負担する「子ども・子育て拠出金」を別項目にする。支援金は基準日時点で次を確定値としてマスター化する。

```text
support_levy_rate            23/10000    # Rate型（num=23, den=10000）。0.0023 等の小数で保持しない
applies_from_premium_month   2026-04     # 令和8年4月分保険料から
share_rule                   half_each   # 被用者保険は原則労使折半
base                         標準報酬月額・標準賞与額
```

折半の端数処理は保険者規則に従うため、`rounding_rule_id` と `employee_share_rule` を保険者別に保持する。国民健康保険・後期高齢者医療の支援金率は被用者保険と同一ではないため、確定値を確認するまで推定せず、該当者は `blocked` とする。子ども・子育て拠出金率は別レコードとし、確認前に支援金率で代用しない。労災保険・雇用保険は役員の加入可否が個別事情で異なるため、初期版では自動加算せず専門判定または明示的な追加費用とする。

---

# 46. 法人税共通モジュール

最低限、

```text
法人区分
資本金
所得
事業年度
所在地
```

を受け取る。

地方税率について、自治体が条例で定める「超過税率」と、マスターに税率が登録・承認済みかというシステム状態を区別する。

```text
standard_rate
excess_rate
rate_source_status: registered / missing
```

未登録の場合：

```text
標準税率による概算
```

として計算し、結果に、

> 法人地方税は標準税率による概算です。

と表示する。

---

# 47. 税制年度

URLまたは入力画面に、

```text
計算年度：2026年
```

を表示。

将来的には、

```text
2026
2027
2028
```

を切り替えられる構造にする。

---

# 48. 法令改正管理

管理画面または設定ファイルでは、制度の法的状態とデータ審査状態を別フィールドで管理し、汎用の `status` フィールドを設けない。

```text
legal_status: draft / announced / enacted / effective / expired / repealed
data_review_status: unverified / single_checked / double_checked / approved / blocked
```

`legal_status` は制度そのものの状態を表す。`draft` は未公表の案、`announced` は大綱・法案として公表されたが未成立、`enacted` は成立・公布済みで適用開始前、`effective` は対象期間に適用中、`expired` は適用終了、`repealed` は廃止とする。本番計算へ投入できるのは、対象期間について `effective`、または対象期間に適用されることが公布済み法令から確認できる `enacted` のレコードだけとし、`draft`・`announced` を適用中の制度と同じ扱いにしない。この値集合は §3-1 のマスター項目と共通であり、他の節で別の列挙を定義しない。

本番で使用できるのは、成立・公布を確認し、適用日を二者確認したスナップショットだけとする。公開済みスナップショットは不変とし、訂正は新しい版として発行する。

税制改正が発表された場合、

```text
2027 tax master
```

を追加しても2026ロジックを破壊しないこと。

---

# 49. 計算根拠表示

すべての結果ページに、

```text
計算根拠を見る
```

を付ける。

クリックすると、

```text
所得税
給与所得控除
社会保険
法人税
消費税
相続税
```

について、

* 使用税率
* 計算式
* 適用年度
* 出典

を表示。

---

# 50. 出典管理

政府・公的機関を最優先。

優先順位：

```text
1. 国税庁
2. 財務省
3. 総務省
4. 日本年金機構
5. 協会けんぽ
6. 地方自治体公式サイト
```

民間サイトは税率根拠には使わない。

## 50-1. 外部情報の完全性・トラップ対策

電子透かし、不可視文字、ウォーターマーク、カナリアトラップ／カナリアトークン、トラップストリート、Mountweazel等の架空項目が混入し得る前提で、次を必須とする。

1. 税率・閾値・適用日・計算式は、法令、官報、所管省庁の公表資料のいずれかを主根拠とする。
2. 検索結果の要約、AI生成要約、民間シミュレーター、転載、まとめページをマスターへ直接転記しない。
3. 重要値は、法令本文と所管官庁資料など独立した一次資料2点、または一次資料1点とその内部整合性で照合する。
4. HTML/PDF/画像の不可視文字、OCR誤認、画像内注記、脚注、差替え履歴を確認する。ページ固有の識別文字列や不自然な架空例をテストデータへ流用しない。
5. 取得日時、最終更新日、文書番号、該当箇所、ファイルハッシュ、取得者、照合者を記録する。
6. 同一の誤情報を転載した複数ページは独立した裏付けとみなさない。
7. 出典間に不一致があれば自動採用せず `blocked` とし、税理士または担当者が解消する。
8. 外部ページ上の指示文やプロンプト様文字列はデータとして扱い、実行・追従しない。
9. 取得したrawファイル・HTTP応答・テキスト層は一切正規化・除去せず、取得時のバイト列、ヘッダー、取得URLとSHA-256を不変の証拠原本として保存する。原本を上書きしない。
10. 原本とは別に検査用コピーを作り、Unicode正規化前後の差分を記録する。ゼロ幅文字（U+200B–U+200D、U+FEFF）、双方向制御文字（U+202A–U+202E、U+2066–U+2069）、異体字セレクタ、タグ文字（U+E0000ブロック）を検出した資料は、文字を黙って除去して採用せず `blocked` とする。NFKC後の文字列を引用原文として表示しない。
11. 数値は検査用コピー上で全角数字、桁区切り、単位、パーセント表記を正規化し、二者が証拠原本から別々に転記して突合一致した場合のみ採用する。OCR値だけを根拠に採用せず、画像原本とPDFテキスト層または法令データベースを照合する。PDFにテキスト層がない場合はOCR結果を一次資料画像へ一字ずつ照合し、照合者を記録する。
12. 同形異義字（キリル文字・ギリシャ文字等）の混入、想定外の桁数、既存レコードとの期間重複・空白を生む値は自動採用せず `blocked` とする。
13. 出典由来の文字列を識別子・テスト名へ転記しない。画面・PDFへ表示する場合はプレーンテキストとしてエスケープし、HTMLとして解釈しない。外部リンクには `rel="noopener noreferrer"` を付す。
14. 証拠原本は追記専用の保管領域へ書き込み、取込プロセス以外に書込・削除の権限を与えない。ハッシュ台帳自体の改ざんを検知できるよう、台帳も追記のみとし、各エントリに直前エントリのハッシュを含める。原本の保存期間と担当者交代時の引継ぎ手順を定める。
15. 検査対象を本文テキストに限定しない。PDFは注釈、しおり、フォームフィールド、添付ファイル、文書プロパティ、埋込フォントの文字対応表を、HTMLは `display:none`・`visibility:hidden`・不透明度0・背景同色・`aria-hidden`・CSSの `content`・属性値・コメント・スクリプト内文字列を検査する。本文に無い数値が隠し要素側だけに存在する資料を採用しない。
16. 同形異義字の検出を目視に委ねない。文字列内のUnicodeスクリプト混在と混同容易文字の対応表による機械判定とし、判定に用いた対応表の版を記録する。
17. 50-1-10 の正規化前後の差分は記録するだけでなく合否規則を持つ。数値・単位・日付・条番号を含む箇所に差分がある資料は `blocked` とし、差分が空白類の表記ゆれのみである場合に限り採用を検討する。
18. 二者による独立転記は転記誤りを防ぐが、資料側に仕込まれた架空値は防げない。税率・閾値・適用日・計算順序は、原則として法令・官報等の規範資料と所管官庁の解説・様式・計算例を照合する。独立した一次資料が実在しない値は、資料数を水増しせず、(a) 証拠原本の独立二者照合、(b) 条文内の相互参照・新旧対照表との整合、(c) 公式様式または公的計算例による再計算、(d) 監修税理士の承認をすべて満たした場合に限り `approved` とできる。一次資料が1点しかないことだけを理由に永久に `blocked` とせず、代替統制と単一資料である事実を記録する。この判定は資料単位ではなく値単位である。同じ資料に載る値でも、法令本文と突合できる値と、その資料にしか存在しない値とで統制が異なる。記録先は §7 の `MasterRecordRef.verificationMode` と `alternativeControlRefs` とし、(b)(c)(d) のいずれかを記録できない値を `approved` にしない。民間転載2点や同一資料の複製を独立根拠として数えない。架空項目・カナリアの疑いを1箇所でも検出した資料は資料単位で隔離し、その資料に依拠する既存マスター値を再検証対象とする。
19. 出典ページの内容は変わる。同一 `sourceId` について定期的に再取得してハッシュを比較し、差分があれば旧原本を残したまま新原本を追加登録し、依拠するマスターレコードの `verified_at` を失効させて再確認まで `blocked` とする。旧レコードには新原本の `sourceId` を `supersededBy` として記録する。リンク切れ時にキャッシュ、転載、アーカイブサービスを一次資料へ格上げしない。取得時のリダイレクト履歴、応答ヘッダー、TLS検証結果、`Accept-Language` 等の要求条件も原本と併せて保存する。
20. 「二者」の独立性を定義しないまま11・18の交差検証を満たしたとみなさない。同一人物による再確認、同一のOCRエンジン・抽出ライブラリ・自動要約・同一の言語モデルによる2回の読取りは1者と数える。転記者と照合者を同一人物にしない。独立の根拠（別人・別手段・別の発行系統）を `SourceReference.review.independenceBasis` へ記録し、記録できない値は `blocked` とする。自動抽出を用いる場合は少なくとも一方を人による原本照合とする。相関した読み違いは6が禁じる「同一の誤情報の転載」と同じ構造であり、資料側に仕込まれた架空値・カナリアはこの独立性が崩れた時点で素通りする。

## 50-2. 基準日現在の重要根拠台帳

最低限、次の一次資料を `SourceReference` として登録し、取得原本のハッシュと該当箇所を実データへ記録する。ここに示すURLだけを根拠値として自動採用するのではなく、取込・二者確認フローを通す。

| sourceId | 確認対象 | 一次資料 |
| --- | --- | --- |
| `NTA-INVOICE-R8` | 3割特例、7・5・3割控除、相手先別1億円上限 | 国税庁「令和8年度 税制改正特集」 `https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm` |
| `MOF-R8-LAW` | 令和8年法律第12号と関係政令の公布 | 財務省「令和8年度税制改正 政令」 `https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/seirei/index.html` |
| `NTA-INCOME-R8` | 令和8年分所得税の基礎控除・給与所得控除・年末調整時期 | 国税庁「源泉所得税の改正のあらまし」 `https://www.nta.go.jp/publication/pamph/gensen/2026kaisei.pdf` |
| `MHLW-SUPPORT-R8` | 子ども・子育て支援金の開始月・率・負担区分 | 厚生労働省「子ども・子育て支援金の保険料（令和8年度）」 `https://www.mhlw.go.jp/hourei/doc/tsuchi/T260305S0022.pdf` |

2026年分所得税では基礎控除・給与所得控除等に改正があるため、2025年分の控除マスターを流用しない。年税額計算と月次源泉徴収の適用時期も同一とみなさず、本シミュレーターの年税額と給与明細の源泉徴収額を混同しない。

参考UIの分析では、画面構造や一般的な操作パターンのみを抽象化し、文言・具体例・隠し識別子・独自データを複製しない。

---

# 51. 参考UI・競合

## 法人成り

参考：

* 弥生「法人化と個人事業主どっちが得？」
* プロゴ税理士事務所「法人成りシミュレーター」

参考ポイント：

```text
弥生
→入力項目が少なく分かりやすい

プロゴ
→税金＋社保＋手取り＋相談導線
```

---

## 消費税

参考：

* freee 消費税納税額シミュレーション
* でらくらうど 消費税シミュレーター
* 国税庁2割・3割特例判定

参考：

```text
freee
→簡単入力

でらくらうど
→方式比較

国税庁
→適用可否ロジック
```

---

## 相続税

参考：

* 国税庁 相続税申告要否判定
* 木村会計
* 鎌倉鑑定

参考：

```text
国税庁
→申告要否フロー

木村会計
→一次・二次相続

鎌倉鑑定
→小規模宅地＋二次相続＋比較UI
```

---

## 役員報酬

参考：

* 林税理士社労士事務所
* CloudPartners
* プロゴ税理士事務所

参考：

```text
林税理士
→最適報酬自動探索

CloudPartners
→グラフ・視覚比較

プロゴ
→手取りから逆算
```

---

# 52. SEOページ構成

各シミュレーターページは、

「入力フォームだけ」

にしてはいけない。

ページ構成：

```text
H1
導入
シミュレーター

↓結果

このシミュレーターで分かること
計算方法
制度説明
具体例
よくある間違い
利用上の注意
公式出典
監修税理士
関連記事
相談CTA
```

## 52-1. 税務YMYLページの信頼性

- 各ページに監修税理士の氏名、資格、所属、監修範囲、初回公開日、最終制度確認日、最終本文更新日を表示する。資格・所属は公開前に本人確認する。
- 「誰が、どのように、なぜ作成したか」を説明し、計算ロジックと出典へ到達できるようにする。SEO目的だけの大量類似ページ、他サイトの言い換え、根拠のない体験談・権威付けを作らない。
- 免責文だけで信頼性を代替しない。誤り報告窓口、訂正履歴、影響を受けた計算バージョン、再計算案内を用意する。
- 制度確認期限を過ぎた、マスターが `blocked`、監修が失効、重大な既知不具合がある場合は計算機能を停止し、古い結果を新規生成しない。静的な制度説明にも更新警告を出す。

## 52-2. インデックス・URL・構造化データ

- 開発、ステージング、未承認版はHTTPヘッダーまたはmeta robotsで `noindex` とし、robots.txtだけに依存しない。税理士承認、マスター承認、ゴールデンテスト、プライバシー検査、アクセシビリティ検査を通過した本番URLだけから `noindex` を外す。
- 各本番ページは入力状態に依存しない自己参照の絶対URL canonicalをHTMLの`head`へ静的に出す。JavaScriptでcanonicalを入力値・結果値に合わせて変更しない。
- 入力値、結果、方式順位、警告コードをクエリ、フラグメント、パス、ページタイトル、meta description、canonical、OGP、JSON-LD、サイト内検索URLへ入れない。結果状態を個別URLとしてクロール可能にしない。
- 制度説明、監修者、更新日、利用上の注意、公式出典は初期HTMLまたは検索エンジンが確実にレンダリングできる本文として提供し、計算実行後だけ現れる内容へ依存しない。
- 構造化データは画面に見える静的内容と一致させ、ユーザー入力・計算結果から生成しない。導入する型は公開時点のGoogle公式対応状況を確認し、Rich Results TestとURL Inspectionで検証する。
- sitemapと内部リンクはcanonical URLだけを列挙する。印刷用表示、パラメータ違い、プレビュー、旧版をsitemapへ含めない。

上記SEO方針は、Google Search Centralのpeople-first content、canonical、`noindex`、JavaScript SEOに関する公式文書を参照して実装時に再確認する。検索順位を保証する要件ではない。

## 52-3. 公開・緊急停止ゲート

本番公開は機能フラグでシミュレーターごと・マスタースナップショットごとに停止できるようにする。停止操作は新規計算を即時禁止するが、静的説明ページを誤った結果表示へフォールバックさせない。ロールバック時は旧マスターを自動再有効化せず、最後に承認済みで対象期間が一致するスナップショットだけを明示選択する。

計算は §57 によりユーザー端末で動くため、機能フラグは配布された時点から古くなる。停止操作が実際に効くための条件を次のとおり定める。

- 停止状態の判定材料（フラグとマスタースナップショットのハッシュ）を計算エンジンの起動前に取得し、取得・検証に失敗した場合は計算を実行しない。停止側へ倒す既定とし、前回取得した値で続行しない。取得要求は入力に依存しない静的な内容に限り、金額・入力値・結果を含めない（§57・§58）。
- ページHTMLと判定材料は短い `max-age` と `must-revalidate` で配信し、JSバンドルとマスターは内容に応じた別URLで配信する。停止後に旧バンドルがブラウザキャッシュ・CDNから実行され続けないよう、キャッシュの無効化を停止手順の一部として文書化する。Service Workerは §57-2 により登録しないため、対象をブラウザキャッシュとCDNに限定できる。
- 停止中は計算UIを描画せず、無効化した入力欄を残さない。停止理由の区分（制度確認期限切れ、マスター `blocked`、監修失効、既知不具合）と、再開見込みまたは相談窓口を表示する。

停止・訂正時のインデックス状態も定める。

- 停止中のページを削除せず、`noindex` へ戻すかどうかを停止理由で分ける。誤った結果を表示していた場合は当該シミュレーターページを `noindex` とし、sitemapから外す。制度確認待ちのみで本文の説明が正しい場合はインデックスを維持し、計算機能の停止を本文の先頭で示す。いずれの場合もcanonicalは変更しない。
- 停止中に本文から取り除いた記述を構造化データへ残さない。構造化データは §52-2 により静的本文と一致させるため、停止・再開のたびに両者を同時に更新する。
- 訂正は §52-1 の訂正履歴へ、影響した計算バージョン、マスタースナップショットID、影響期間、再計算の要否を記載する。訂正履歴は入力状態に依存しない静的URLで公開し、シミュレーターページと印刷物（§59）の双方から到達できるようにする。

---

# 53. 関連記事との自動内部リンク

現在の記事生成システムから、

```text
法人化
法人成り
役員報酬
消費税
簡易課税
2割特例
3割特例
相続税
```

等を検出。

該当するシミュレーターへのCTAを記事内に自動挿入する。

例：

```text
あなたの場合の消費税を計算してみる
→ 消費税シミュレーター
```

---

# 54. シミュレーターから記事へ

逆方向にもリンク。

例えば②の結果が、

```text
簡易課税 第2種
```

なら、

```text
関連記事

・小売業の簡易課税
・Amazon販売の消費税
・簡易課税制度選択届出書
```

を動的表示する。

---

# 55. CTA設計

結果の直後に営業CTAを置きすぎない。

順番：

```text
結果
↓
理由
↓
内訳
↓
注意点
↓
税理士コメント
↓
相談CTA
```

CTA例：

```text
この計算結果について税理士に相談する
```

サブ：

```text
オンライン相談対応
全国対応
```

---

# 56. 相談時の入力引継ぎ

ボタン：

```text
この結果を相談内容に引き継ぐ
```

クリック時に初めて、

> 入力した数値を問い合わせフォームへ送信しますか？

と確認する。

ユーザー同意なしで財務データをサーバーへ送信してはいけない。

同意画面には送信先、送信項目、利用目的、保存期間、取消方法を表示する。同意前は問い合わせ本文をブラウザ内で生成し、明示操作後にのみ送信する。

---

# 57. 個人情報・財務情報

原則：

```text
計算はブラウザ内で完結
```

する。

サーバーへ、

* 売上
* 所得
* 財産額
* 相続財産
* 手取り

等を自動送信しない。

アクセス解析にも金額を送らない。

URL、クエリ文字列、画面タイトル、DOM、フォーム自動収集、セッションリプレイ、エラー監視、ログ、CDN・WAF、クラッシュレポート、A/Bテストにも金額や入力値を送らない。財務情報をURL、Cookie、`localStorage`、解析用data属性へ格納しない。保存機能を設ける場合は明示オプトイン、保存先、暗号化、削除方法、保持期間を別仕様とする。

サードパーティスクリプトは許可リスト方式とし、シミュレーター入力領域から隔離する。CSP、Subresource Integrity（適用可能な場合）、依存関係固定、脆弱性検査、ログの構造的リダクションを実装する。

## 57-1. ブラウザ内データライフサイクル

- 既定では入力値と結果をJavaScriptのメモリ内だけに保持し、再読込・タブ終了で破棄する。
- `localStorage`、`sessionStorage`、IndexedDB、Cache API、Service Workerキャッシュ、Cookie、URL、`history.state`、DOM属性、`window.name`、`document.title` へ財務データを保存しない。`window.name` はオリジンをまたいで残る。
- ブラウザのフォーム自動補完を財務金額欄で無効化し、BFCache・ページ復元時は金額状態をクリアする。別タブ・別ウィンドウへ `postMessage` しない。
- ①②④の画面間引継ぎは同一SPAランタイムのメモリ内オブジェクトで行う。再読込時は引継ぎを失うことをUIで説明し、永続化へ暗黙フォールバックしない。
- 明示的な「入力をクリア」操作を全STEPと結果画面に設け、メモリ、印刷プレビュー用DOM、クリップボード用一時値を破棄する。
- ブラウザ拡張による読取りを完全には防げない旨を利用上の注意に記載し、共用端末での利用、画面共有、印刷物の管理へ注意を促す。

## 57-2. 実行時セキュリティ

- シミュレーター画面ではセッションリプレイ、広告タグ、ヒートマップ、外部チャット、フォーム自動収集SDKを読み込まない。
- 外部由来テキストに `innerHTML`、`dangerouslySetInnerHTML`、`eval`、動的コード生成を使わない。CSPでは `script-src` のnonce/hash方式、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors` を設定し、可能な環境ではTrusted Typesを有効化する。
- CSPは `default-src 'none'` からの明示許可で構成し、XSS対策の指示子だけで終えない。金額の持ち出しを実際に止めるのは送信先の許可リストであり、`connect-src`、`form-action`、`img-src`、`frame-src 'none'`、`worker-src`、`manifest-src`、`style-src`、`font-src` を必ず明示する。`connect-src` と `form-action` には自社オリジンだけを列挙し、解析・広告・CDN・エラー監視のドメインを含めない。
- `connect-src` で塞げない送出経路を個別に禁止する。`navigator.sendBeacon`、`fetch` の `keepalive`、WebSocket、`RTCPeerConnection`、`<a ping>`、`<img>` や `<link rel="preconnect|prefetch|dns-prefetch">` のURLへ値を埋め込む送信、`window.open` のクエリを、シミュレーター画面で使わない。CSP違反レポートとReporting APIの送信先も自社オリジンに限る。違反レポートは `script-sample` を含み得るため、第三者の収集エンドポイントへ向けない。
- シミュレーターを配信するパススコープにService Workerを登録しない。サイト全体で既存のService Workerがある場合は、当該パスをキャッシュ対象と `navigationPreload` から除外し、リクエストボディを保持しない。
- 相談送信（§56・§57-3）の送信先は自社オリジンのエンドポイントに限る。第三者フォームSaaS、埋め込みiframe、外部スクリプト経由の送信を使わない。`Referrer-Policy: no-referrer` と `Permissions-Policy` による不要APIの無効化を併せて指定する。
- 本番ビルドのソースマップ公開、例外オブジェクトへのフォーム状態添付、開発用デバッグログを禁止する。
- 依存ライブラリとマスター配信物はバージョン・ハッシュを固定し、検証失敗時は計算エンジンを起動しない。

## 57-3. 相談フォームへ送る場合

送信は結果画面の明示操作後に、項目ごとの選択画面を挟んで行う。既定選択はすべてOFFとし、送信直前に平文でプレビューする。CSRF対策、TLS、レート制限、保存時暗号化、アクセス権限、保存期間、自動削除、削除依頼窓口を問い合わせ機能の別仕様で定義し、その仕様が承認されるまで財務項目の送信機能を公開しない。

---

# 58. Analytics

取得可：

```text
simulator_view
simulator_start
simulator_complete
simulator_mode
simulator_cta_click
```

取得禁止：

```text
売上金額
所得
財産額
税額
役員報酬額
```

自由記述、エラーメッセージ、丸めた金額帯、結果順位との組合せから入力値を再推定できるイベントも送らない。イベントペイロードを型とテストで許可リスト化する。

---

# 59. PDF・印刷

4シミュレーターすべてに、

```text
結果を印刷 / PDF保存
```

を付ける。

ブラウザ印刷CSSを使用。

サーバー側PDF生成は初期版では不要。

印刷物にも計算基準日、入力前提、除外項目、警告、計算版、マスタースナップショットID、ページ番号を出す。印刷時に入力フォームや相談用個人情報を意図せず含めない。

ブラウザの印刷ヘッダー・フッターにはURLとページタイトルが入るため、そのいずれにも金額・入力値を含めない（§57・§57-1）。印刷とPDF保存は仮想プリンタやクラウド印刷サービスを経由し得るため、ブラウザ内完結の原則が及ばない旨を印刷前の注意書きで示す。

印刷は `Ctrl+P`、OSのメニュー、共有機能からも実行され、アプリの印刷ボタンを経由するとは限らない。ボタン押下時にだけ印刷用の整形を行う方式にせず、結果表示中は常に印刷可能な状態を保つ。

- 印刷に出す領域と出さない領域を `@media print` の表示切替ではなく描画位置で分ける。入力フォーム、相談フォーム、下書きの問い合わせ本文は印刷対象コンテナの外へ置き、印刷時に隠すのではなく最初から含めない。`@media print { display: none }` による秘匿は、`beforeprint` を経由しない印刷経路とDOM検査の双方で破れる。
- 印刷前の注意書きは画面上のダイアログだけに置かず、印刷物自体の先頭にも出す。注意書きに §57-1 の「入力をクリア」の案内を含める。
- 印刷後の一時DOMとクリップボード用の値は §57-1 の破棄操作の対象とし、印刷ダイアログを取り消した場合も残さない。

印刷物は画面の文脈を失ったまま第三者へ渡る。次を各ページに出す。

- 結果状態（`complete` / `partial` / `blocked`）を語として明示する。`partial` は除外部分がある旨、`blocked` は結論額を持たない旨をページ内で読み取れるようにし、`blocked` の結果から結論額・有利不利・方式順位を印刷しない（§7）。
- 申告・届出に使用できない旨（§3-4）と、訂正履歴を確認できる静的URL（§52-3）。計算版・マスタースナップショットIDだけを載せ、その照会先を載せない状態にしない。
- 色に依存せず有利不利と警告レベルを読み取れること。モノクロ印刷での判別を受入条件に含める。

---

# 60. エラー処理

例：

```text
年間経費が売上を超えています。
赤字事業として計算します。
```

```text
基準期間課税売上高が5,000万円を超えるため
簡易課税の対象外です。
```

```text
この条件では簡易シミュレーションの対象外です。
```

単なる「エラー」ではなく理由を表示する。

---

# 61. Warning体系

```ts
type WarningLevel =
  | "info"
  | "attention"
  | "critical";
```

警告には安定した `code`、対象フィールド、根拠、ユーザーが取れる行動、計算継続可否を持たせる。同じ重大条件を閉じられるトーストだけで表示しない。

# 61-1. アクセシビリティ

- WCAG 2.2 AAおよびJIS X 8341-3:2016を目標とする。
- キーボードのみで入力・計算・戻る・印刷が可能であること。
- STEP遷移時のフォーカス移動、エラー要約と入力欄の関連付け、読み上げ順をテストする。
- 色だけで有利・不利、可・不可、警告レベルを表現しない。
- グラフと同じ情報を表形式で提供し、スクリーンリーダー向け要約を付ける。
- 金額入力は日本語の単位、桁区切り、符号、全角入力、モバイルキーボードを考慮する。
- 計算結果全体を `aria-live` にしない。計算開始・完了・停止だけを短い専用の `role="status"` 領域で通知し、ユーザーが「計算する」を実行した後は結果見出し（`tabindex="-1"`）へフォーカスを移す。フォーカス移動と同じ全文をライブ領域で二重に読み上げない。入力エラー時は結果へ移動せずエラー要約へ移す。
- ライブ領域への挿入とフォーカス移動を同一の描画で行わない。同時に起きると多くの読み上げ環境で先の通知が破棄され、「二重読み上げを避けたのに何も読まれない」状態になる。完了時は結果見出しへのフォーカス移動を主たる通知手段とし、見出しの読み上げ内容に結果状態（`complete` / `partial` / `blocked`）と対象期間を含める。ライブ領域は計算中と停止の通知に用い、両方を使う場合は挿入と移動を別の描画へ分ける。
- 通知の緊急度を使い分ける。処理中と完了は `role="status"`、停止（`blocked`）と送信時の入力エラーは `role="alert"` とし、`alert` は同一操作につき1回だけ発火させる。入力途中の逐次検証を `alert` で読み上げない。
- 即座に終わらない計算を無応答にしない。§38 の候補走査、§43 の逆算探索、§32 の割合別再計算は候補数に比例して時間がかかる。実行中は実行ボタンを `aria-disabled` とし、処理中である旨と可能なら進捗を `role="status"` で通知し、キーボードで操作できる中止手段を置く。走査をUIスレッドで同期実行してフォーカス移動と読み上げを止めない。中止時は途中結果を結論として残さず、中止した旨を表示する。
- 入力を変えて再計算する場合も同じ結果見出しへフォーカスを戻す。ただし同じ位置・同じ文言のままでは更新されたことが伝わらないため、再計算の開始時に旧結果を破棄し、見出しの文言を新しい結果状態と対象期間で更新する。前回結果を画面に残したまま新しい結果を併記しない。
- エラーはページ上部の要約（該当欄へのリンク付き）と各入力欄の `aria-describedby` の両方で示す（WCAG 3.3.1・3.3.3）。
- WCAG 2.2の追加達成基準を個別に確認する。2.4.11 フォーカスの非隠蔽、2.5.7 ドラッグ動作（グラフ・スライダーはクリックまたはキー操作の代替を必須とする）、2.5.8 ターゲットサイズ、3.2.6 一貫したヘルプ、3.3.7 冗長な入力（STEP間で同じ値を再入力させない）。
- 印刷CSSでもコントラスト比と情報の非色依存を維持する。
- 自動チェックのみで合格としない。キーボードのみ、スクリーンリーダー1種以上、200%拡大、幅320px相当のリフローでの手動確認を受入条件とする。
- STEPは見た目だけの進捗バーにせず、現在位置、総STEP数、完了状態をテキストとプログラム上の両方で示す。「戻る」で入力値を失わず、ブラウザの戻る操作で意図せず財務値をURL・履歴へ保存しない。§5 の追加質問や §15・§18 の期間分割で総STEP数が増える場合は、増加後の総数へ更新したうえで増えた旨を通知し、完了済みSTEPを未完了へ戻さない。
- 金額入力は可視ラベルと円・月額/年額・税込/税抜を明示し、`inputmode="numeric"` と文字列入力を用いて桁区切りを表示上だけ付ける。`type="number"` の指数表記や暗黙丸めへ依存しない。全角数字は入力時に変換候補を示し、変換後の値をユーザーが確認できるようにする。
- 桁区切りは読み上げを壊す。区切り付きの文字列をそのまま読み上げさせず、入力欄の直後に確定値を「1,000,000円（100万円）」の形で文字として表示し、`aria-describedby` で入力欄と関連付ける。「万」「億」を含む入力を受け付ける場合も、解釈した円単位の値を同じ確認表示で示してから採用する。
- 入力中に桁区切りを差し込む実装ではキャレット位置と選択範囲を保持し、整形途中の値を計算へ渡さない。IME変換中（`compositionstart` から `compositionend` まで）は整形しない。
- 各金額欄に、§3-3 が拒否する桁あふれ・負数・小数円の条件を入力前に伝える。上限・下限・入力可能な刻みをラベルまたは補足テキストへ書き、上限超過を送信後のエラーだけで知らせない。
- グラフは表と同じ値を用い、軸の単位・基準線・対象期間・負数を明示する。省略軸で差を誇張せず、色・形・線種・テキストを併用する。アニメーションは `prefers-reduced-motion` で無効化する。
- グラフの代替表に全走査点をそのまま並べない。§38 の刻み幅では候補が数百点になり得る。既定の行は結論に必要な点（最適点、その前後の刻み、税率・標準報酬等級・制度の境界、符号が変わる点、探索の上下限）に限り、全点は展開操作または別ファイルで取得できるようにする。行の選定規則を実装の裁量に委ねず、選定に用いた境界の一覧を表の前に文章で示す。
- §42 の系列切替はグラフと代替表の両方へ同時に適用し、現在の系列をプログラム上判別できるようにする。表だけが前の系列のまま残る状態を作らず、切替結果を `role="status"` で短く通知する。
- 強制色モード（`forced-colors: active`）とハイコントラストを受入テストの項目としてだけ扱わない。グラフの系列は色以外（線種、マーカー形状、直接ラベル）で識別でき、系列の識別に必要な描画へ `forced-color-adjust: none` を使わない。背景画像・グラデーション・影に情報を持たせず、凡例は色見本だけにせず系列名を文字で持つ。canvasで描画する場合は強制色が適用されないため、同じ情報を持つ表とテキストを常に併置する。
- 400%拡大と幅320px相当のリフローで、グラフは横スクロールを伴ってよいが、結論カード、結果状態、警告、代替表は二方向スクロールを要求しない（WCAG 1.4.10）。グラフを横スクロールさせる場合はスクロール領域をキーボードで操作でき、代替表へのリンクをスクロール領域の前に置く。
- 400%拡大、縦横表示、タッチターゲット、音声入力、ハイコントラスト/強制色モードも受入テストに含める。

例えば、

```text
critical

複数の簡易課税事業区分があります。
実際の事業区分は取引内容による判定が必要です。
```

---

# 62. テスト

税務計算なので通常Webサイトより厳格に行う。

## Unit Test

各計算関数。

```text
incomeTax()
salaryIncome()
socialInsurance()
corporateTax()
consumptionTax()
inheritanceTax()
```

---

## Boundary Test

必須。

例：

```text
課税所得
1,949,000
1,950,000
3,299,000
3,300,000
```

など税率境界。

---

## 制度境界

消費税：

```text
基準期間売上
9,999,999
10,000,000
10,000,001
```

```text
49,999,999
50,000,000
50,000,001
```

日付：

```text
2026/9/30
2026/10/1
```

等。

税率境界だけでなく、控除逓減、標準報酬等級、年齢到達月、事業年度月数、相続人数、土地面積上限、届出期限、課税期間開始日を網羅する。境界値の直前・当日・直後をテストする。

## Property / Metamorphic Test

- 同じ税率区分内で課税標準が増えたとき、税額が不合理に減少しないこと（制度上の例外は明示）。
- 表示形式や税込・税抜入力の等価変換で、法定丸めの範囲を超える差が出ないこと。
- 詳細モードで追加項目をゼロ入力した結果が、同じ前提の簡易モードと整合すること。
- マスターの適用期間に重複・空白がないこと。
- 不明条件を「適用可」と推定しないこと。

## 決定性・受入基準

- テストはタイムゾーン `Asia/Tokyo`、ロケール固定で実行し、システム時刻・システムロケールの書式・`Intl` の実行環境差に依存しない。日付は時刻を持たない日付型の値としてテストへ渡す。
- 税額の期待値との許容誤差は0円とする。丸め差を許容する比較を書かない。
- マスターはテスト専用スナップショットを固定し、本番マスターの更新でテスト結果が黙って追随しない構成にする。スナップショットは `simulate` の引数として渡し、グローバル参照で差し替わらないことを検証する。実行時刻は `context.calculatedAt` から与え、同じ入力・コンテキスト・スナップショットで結果が完全に一致することを検証する。
- 各シミュレーターについて、公的計算例と税理士署名済みゴールデンケースを合わせて最低20件、うち境界値ケースを10件以上登録し、二者レビュー記録を残す。
- 不明・対象外条件で `blocked` と専門家確認を促す `critical` 警告を返すことを、正常系と同じ厳格さで検証する。
- テストデータに実在の個人・法人の情報、出典ページ固有の識別文字列、架空項目（Mountweazel等）を使わない。
- `SimulationResult` の全金額フィールドにJavaScriptの `number` が混入しないことをスキーマテストする。
- `resultStatus: "blocked"` のとき結論額・有利不利・方式ランキングが存在しないことを検証する。
- 相手先別仕入額99,999,999円、100,000,000円、100,000,001円と、課税期間開始日2026-09-30、2026-10-01の組合せを検証する。
- 出典原本の保存前後でSHA-256が一致し、正規化コピーの生成が原本を変更しないことを検証する。制御文字検出時は除去後の値を採用せず `blocked` となることを検証する。
- JSON Schemaまたは同等のランタイム検証で、`CalculationContext` のスナップショットID・ハッシュが唯一であること、出典・警告の参照IDが解決できること、`bigint` が外部JSONへ直接出ないことを検証する。
- `blocksCalculation: true` の警告を含む任意の結果が必ず `resultStatus: "blocked"` となり、summaryの金額を持たないことをプロパティテストする。
- 入力・結果を含む操作後に、Storage API、Cookie、URL、History、Cache API、Service Worker、解析リクエスト、例外監視ペイロードへ金額が残らないことをE2Eで検証する。再読込・BFCache復元・タブ終了相当操作後も確認する。
- CSP違反レポート、ソースマップ、console出力に入力値が含まれないことを検証する。
- 計算成功時、停止時、入力エラー時をスクリーンリーダーで確認し、結果全文の二重読み上げ、フォーカス喪失、通知漏れがないことを検証する。
- 簡易モードで未入力値が0円・全国平均・前年値へ暗黙補完されないこと、結論が逆転し得る欠落時に `complete` を返さないことを検証する。
- canonical、title、meta、OGP、JSON-LD、URL、解析イベントに入力値・計算結果が入らないことをE2Eで検査する。
- 未承認、期限切れ、`blocked` のマスターで公開ゲートが開かず、計算機能に `noindex` 解除や旧マスター自動復帰が起きないことを検証する。
- 公開候補URLをRich Results Test相当、URL Inspection、レンダリング済みHTML、sitemapの観点で確認し、静的本文と構造化データが一致することを確認する。
- 期中改定・期中就任のある事業年度について、年額を月額×12で求めた値と期間分割で積み上げた値が一致しないことを検証し、前者を採用する実装を異常として検出する。
- 同一の社会保険料・掛金が必要経費と所得控除の双方へ計上されないこと、会社負担社会保険が法人側の損金と比較表の合計行で二重に控除されないことを検証する。
- 相続税は §28-1 の段階順序で計算され、各人の税額の合計が相続税の総額と一致すること、相続税額の加算が税額控除より前に適用されることを検証する。
- インボイス登録日が課税期間の中途にあるケースで、登録日前後の分割入力なしに `complete` を返さないことを検証する。
- `Exact` から `Money` への変換が `rounding_rule_id` を経由しない実装、および外部形式に `number` または `bigint` の直列化が現れることを、静的検査で検出する。
- `blocksCalculation: true` の警告を含む結果が `blocked` 以外にならないこと、`Warning.sourceIds` が同じ結果の `sources` に存在することを検証する。
- 隠し要素・PDF注釈・添付に本文と異なる数値を持つ検体で `blocked` となること、同一 `sourceId` の再取得でハッシュ差分を検知し依存マスターが失効することを検証する。
- `Wire` 形式との往復変換で全金額・率が元の値と一致し、外部形式に指数表記・桁区切り・オフセット無し日時が現れないことを検証する。
- `usedMasterRecords` に `approved` 以外のレコードを含む結果が必ず `blocked` となり、当該レコードを `sources` から除いて `complete` を返す実装を異常として検出する。
- `excludedItems` が空でない結果、`applicableMethods` に `unknown`・`blocked` を含む結果が `complete` にならないこと、`precision` の値が `resultStatus` を変えないことを検証する。除外項目に依存する内訳の合計・差額が省略され、省略項目が0円として合計・差額・グラフへ入らないこと、`eligible` 以外の方式・候補が金額を持たず推奨・選定されないことを併せて検証する。
- `resultStatus: "blocked"` の結果を `Handoff` の入力にできないこと、`partial` の `Handoff` を受けた結果が `complete` にならず、送信元の `excludedItems` が0円として合計されないことを検証する。
- 合併等で廃止された `municipalityCode` を含む `Jurisdiction` で、近隣自治体・都道府県平均へ代替せず `blocked` となること、`asOfForCodes` が異なると別レコードが選択されることを検証する。
- `approved` の `SourceReference` が `raw_body` と `response_headers` を備えること、`quotable: false` の文字列が画面・PDFへ出ないこと、`independenceBasis` が空または転記者と照合者が同一の資料を `approved` にできないことを検証する。`verificationMode: "single_primary_with_alternative_controls"` のマスターレコードが `alternativeControlRefs` を欠くとき `approved` にできないこと、同一資料に依拠する複数のマスター値が別々の `verificationMode` を持てることも検証する。
- `connect-src`・`form-action` の許可先以外への送信、`sendBeacon`・WebSocket・`RTCPeerConnection`・`<a ping>`・`window.name` 経由の値の残存が無いことをE2Eで検証する。
- 結論が逆転し得る欠落で `summary.range` を返さず `blocked` となること、`summary.range` を持つ結果が `amount` を持たず `complete` にならないこと、「計算範囲」の分母が除外項目の増加で減らないことを検証する。簡易モードの追加質問が、そのシミュレーターと版に設定された質問予算を超えないことも検証する。
- 完了通知とフォーカス移動が同一の描画で発生しないこと、`blocked` と送信時入力エラーが `role="alert"` で1回だけ通知されること、走査中にUIスレッドが占有されず中止操作が効くこと、再計算時に旧結果が破棄されることを、スクリーンリーダーを用いた手動確認を含めて検証する。
- グラフの代替表が既定で境界・最適点・探索上下限を含み、系列切替がグラフと表へ同時に反映されることを検証する。強制色モードで系列が色以外の手段で識別でき、`forced-color-adjust: none` が系列の識別に使われていないことを確認する。
- 判定材料の取得に失敗したとき計算エンジンが起動しないこと（停止側へ倒れること）、停止後に旧バンドルがキャッシュから実行されないこと、停止・再開で本文と構造化データが同時に更新されることを検証する。
- 入力フォーム・相談フォームが印刷対象コンテナの外に描画され、`@media print` の表示切替に依存せず印刷物へ現れないことを、印刷ボタンを経由しない印刷経路で検証する。`blocked` の結果を印刷しても結論額・方式順位が現れないこと、訂正履歴の静的URLが各ページに出ることを確認する。

---

# 63. 公的計算例との照合

可能なものについて、

```text
国税庁公式計算例
```

をテストケースとして登録する。

例えば相続税について、

```text
公式例
↓
当サイト
↓
一致
```

をCIで検証する。

公式例を転載する場合は出典・取得日・利用範囲を記録し、固有の架空名称や識別文字列を内部テスト名へそのまま流用しない。公式例がない領域は税理士が署名したゴールデンケースを二者レビューする。

---

# 64. Regression Test

税率マスター変更時、

以前年度の結果が変わっていないことを検証。

例えば、

```text
2026 master
2027 master
```

追加後も2026計算結果を維持する。

---

# 65. 計算バージョン

結果に、

```text
計算基準：2026年度
Calculation Engine: 1.0.0
最終税制確認：2026-08-23
```

を表示できるようにする。

「税制確認日」は制度全体で1日とせず、使用した各マスターの確認日とソースを展開表示できるようにする。

---

# 66. 推奨ディレクトリ設計

一例：

```text
src/
├─ tax-engine/
│  ├─ income/
│  │  ├─ incomeTax.ts
│  │  ├─ salaryIncome.ts
│  │  └─ deductions.ts
│  │
│  ├─ social-insurance/
│  │  ├─ healthInsurance.ts
│  │  └─ pension.ts
│  │
│  ├─ corporation/
│  │  └─ corporateTax.ts
│  │
│  ├─ consumption/
│  │  ├─ generalTax.ts
│  │  ├─ simplifiedTax.ts
│  │  └─ eligibility.ts
│  │
│  ├─ inheritance/
│  │  ├─ heirs.ts
│  │  ├─ inheritanceTax.ts
│  │  ├─ spouseRelief.ts
│  │  └─ secondaryInheritance.ts
│  │
│  ├─ common/
│  │  ├─ rounding.ts
│  │  └─ money.ts
│  │
│  └─ masters/
│
├─ simulators/
│  ├─ hojinnari/
│  ├─ shohizei/
│  ├─ sozoku/
│  └─ yakuin-hoshu/
```

---

# 67. 最重要ルール

計算ロジックをReact/Vue等のUIコンポーネント内部に直接記述してはいけない。

必ず、

```text
UI
↓
Simulator Service
↓
Tax Engine
↓
Tax Master
```

と分離する。

---

# 68. 将来的なシミュレーター追加

この設計により今後、

```text
個人事業主手取り
社宅
贈与税
所得税
簡易課税事業区分
インボイス
減価償却
小規模企業共済
iDeCo
ふるさと納税
```

等を同じエンジンから作れるようにする。

## 68-1. 初期公開の対応プロフィール

初期版の「対応」と「専門判定」を明確にし、対応外ケースを概算値で通さない。公開時の実プロフィールは税理士承認済み設定として版管理する。最低限の初期候補は次のとおり。

| ツール | 初期対応候補 | `blocked` または専門判定へ送る代表例 |
| --- | --- | --- |
| ① 法人成り | 国内居住の個人事業者から国内普通法人への比較、本人役員1名、平年度比較、消費税は既定OFF | 国外関係、複数法人、現物出資、組織再編、複数役員配分、特殊な申告調整 |
| ② 消費税 | 国内の通常課税期間、一般/簡易/確認済み特例、税率別・取引日別入力が可能 | §21の全項目、相手先別上限を判定できない場合、課税期間短縮、特殊免税点 |
| ③ 相続税 | 国内財産・国内居住者、基本的な相続順位、評価額直接入力、確認済み特例だけ | 国外・非居住、事業承継税制、農地等、未分割の複雑事案、土地評価補正が必要な場合 |
| ④ 役員報酬 | 国内普通法人、常勤役員1名、事業年度開始時に決める定期同額給与、確認済み保険者 | 期中改定、事前確定届出給与、使用人兼務役員、非常勤・複数役員、特殊法人 |

この表は税法要件そのものではなく製品の対応境界である。§7 の `supportedProfileVersion` として結果へ含め、対応範囲を拡張するときは入力スキーマ、ゴールデンケース、警告、説明本文を同時に更新する。

---

# 69. 開発順序

画面上の①②③④の順番と、技術的な実装順序は分ける。

推奨：

### Phase 1

共通基盤

```text
年度マスター
所得税
給与所得
社会保険
法人税
丸め処理
```

### Phase 2

④役員報酬エンジン

理由：

①法人成りがこのエンジンを利用するため。

### Phase 3

①法人成り

### Phase 4

②消費税

### Phase 5

③相続税

---

# 70. 公開順序

技術的な開発順とは別に、SEO・集客上は、

```text
② 消費税
↓
① 法人成り
↓
③ 相続税
↓
④ 役員報酬
```

を推奨する。

ただし④の内部エンジンは①より先に完成させる。

---

# 71. Definition of Done

「コード完成」「マスター承認」「シミュレーター個別承認」「本番公開承認」を分離する。コードのテスト合格だけで税額を公開しない。

```text
共通エンジン承認
  → 対象期間のマスタースナップショット承認
    → 対応プロフィール内のシミュレーター個別承認
      → コンテンツ・監修・プライバシー・アクセシビリティ承認
        → 本番公開承認
```

各承認には、対象コミット、入力スキーマ版、計算エンジン版、対応プロフィール版、マスタースナップショットID/ハッシュ、テスト結果、承認者、承認日時を記録する。いずれかが変われば影響範囲の承認をやり直す。

各シミュレーターは、§68-1の対応プロフィール内について以下をすべて満たした時点で完成とする。対応外ケースをすべて実装することを完成条件にせず、確実に検知して安全側へ停止することを完成条件に含める。

* スマートフォン対応
* PC対応
* かんたん入力
* 詳細入力
* 計算結果
* 詳細内訳
* 注意事項
* 計算根拠
* 公的出典
* 適用年度表示
* 税理士監修表示
* PDF/印刷
* CTA
* 関連記事
* Analyticsイベント
* 財務データ非送信
* Unit Test
* Boundary Test
* 公的計算例照合
* Lighthouse等の基本性能確認
* WCAG 2.2 AA主要達成基準の確認
* 対応ブラウザでJavaScript無効・途中失敗時に誤った結果を表示しない
* マスタースナップショットの二者承認・ハッシュ検証（単一一次資料に依拠する値は §50-1 の18の代替統制記録の確認を含む）
* 金額が解析・ログ・URL・エラー監視へ送信されない自動テスト
* 対象外・不明条件で安全側に停止するテスト
* 税理士によるゴールデンケース承認
* 監修税理士の本人確認・監修範囲・最終確認日の表示
* 未承認環境のnoindexと本番canonical・sitemapの検証
* 緊急停止・訂正告知・影響バージョン特定・安全な再有効化の訓練
* 結果通知、フォーカス、グラフ代替表、400%拡大、強制色の手動確認
* 簡易モードの不足値処理（追加質問の上限、範囲表示、`blocked` への切替）の確認
* 停止操作が配布済みクライアントへ及ぶことと、停止・訂正時のインデックス操作の訓練
* 印刷物の結果状態表示、訂正履歴URL、モノクロ判別の確認

---

# 72. このプロジェクトで目指す最終形

単なる、

```text
数字を入力
↓
税額○円
```

ではなく、

```text
入力
↓
制度適用可否判定
↓
税額計算
↓
複数制度比較
↓
どこが有利か
↓
なぜそうなるか
↓
注意すべき税務論点
↓
関連する税務記事
↓
税理士相談
```

までを一つのサービスとして提供する。

特に、

**「税理士の判断ロジックの一部をWeb上で体験できること」**

を、このシミュレーター群の最大の差別化要素とする。
