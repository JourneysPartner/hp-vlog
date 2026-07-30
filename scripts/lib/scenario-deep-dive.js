'use strict';

/**
 * 深堀り論点シナリオ
 *
 * 各税目の中の細かい論点を topic として展開する。
 * 既存の scenario-expansion（業種 × 軸の組み合わせ）と違い、
 * 「税目内の具体論点」をベースに記事を量産する。
 *
 * 例:
 *   - 消費税: 適格請求書の交付義務免除（公共交通機関・自販機 等）
 *   - 経費判断: スーツは経費にできるか？ジム代は？接待ゴルフは？
 *
 * 各論点は 1 つの subcluster として扱い、persona ごとに 1 ペア
 * （basic_explainer + edge_case の本命+補強）で展開する。
 */

const { SEGMENT_PERSONAS } = require('./customer-relevance');

// ── 論点 → 出稿してよい顧客カテゴリ（customer_segment）────────────
// 「税務論点をペルソナに一律展開する」のをやめ、論点ごとに現実的な
// 顧客カテゴリだけへ展開する。ここに無い論点は事業者向け全般を既定
// にする（相続贈与カテゴリには deep-dive 論点を一切出さない）。
const DEFAULT_DEEP_SEGMENTS = ['ec_seller', 'beauty_salon', 'creator', 'general_business'];
const DEEP_PAIN_SEGMENTS = {
  // 消費税・海外取引系（読者カテゴリを絞る）
  'b2b-electronic-services':           ['ec_seller', 'creator', 'beauty_salon', 'general_business'], // 海外広告/SaaS は広く自然
  'b2c-electronic-services':           ['ec_seller', 'creator', 'general_business'],
  'specified-services':                ['general_business'], // 海外アーティスト・選手：一般事業者のみ
  'foreign-business-consumption-tax':  ['ec_seller', 'general_business'],
  'import-tax-refund-detail':          ['ec_seller', 'general_business'],
  'customs-duty-treatment':            ['ec_seller', 'general_business'],
  'taxable-sales-ratio':               ['ec_seller', 'general_business'],
  'individual-vs-proportional-method': ['ec_seller', 'general_business'],
  'director-salary-fixed-amount':      ['general_business'],
  // 業種特化の会計論点
  'salon-prepayment-ticket':           ['beauty_salon'],
  'salon-product-service-distinction': ['beauty_salon'],
  'ec-inventory-fba-fbm':              ['ec_seller'],
  'influencer-pr-product-revenue':     ['creator'],
  'creator-royalty-income':            ['creator'],
  'affiliate-withholding-judgment':    ['creator'],
  'restaurant-cash-management':        ['general_business'],
  'construction-progress-method':      ['general_business'],
  'crowdfunding-tax-treatment':        ['ec_seller', 'creator', 'general_business'],
};

// deep-dive では 1 顧客カテゴリ = 1 代表 persona で展開する
// （同一論点を複数 persona に増殖させない）。
const SEGMENT_PRIMARY_PERSONA = {
  ec_seller: 'domestic_ec_seller',
  beauty_salon: 'beauty_salon_owner',
  creator: 'influencer_creator',
  general_business: 'general_individual_proprietor',
};

function allowedSegmentsForPain(pain) {
  return DEEP_PAIN_SEGMENTS[pain.id] || DEFAULT_DEEP_SEGMENTS;
}

// ── ユーティリティ ─────────────────────────────────────────
function kebab(s) {
  return String(s).toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── 深堀り論点リスト ───────────────────────────────────────
// 各論点は { id, category, topic, q, intent, reader, success, tax_domain }
// id: 論点の英字 ID（subcluster に使う）
// category: 表示用カテゴリ（消費税 / 帳簿・経費 等、frontmatter の category にも入る）
// topic: 論点の日本語（記事の中心テーマ）
// q: 中心疑問（primary_question）
// intent: 検索意図（search_intent）
// reader: 読者の課題（reader_problem）
// success: 読み終えたあとの成功状態（success_outcome）
// tax_domain: 税目

const DEEP_PAINS_CONSUMPTION_TAX = [
  {
    id: 'b2b-electronic-services',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '事業者向け電気通信利用役務の提供（リバースチャージ方式）',
    q: '事業者向け電気通信利用役務（B2B デジタルサービス）の消費税はどう処理する？',
    intent: '海外事業者からの広告・SaaS 利用料などのリバースチャージ方式の判定と申告方法を知りたい',
    reader: '海外プラットフォームへの広告費・SaaS 利用料の消費税処理が分からない',
    success: 'リバースチャージ方式の対象判定と申告手続きが具体的に分かる',
  },
  {
    id: 'b2c-electronic-services',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '消費者向け電気通信利用役務の提供（プラットフォーマー課税）',
    q: '消費者向け電気通信利用役務（B2C デジタルサービス）の消費税はどうなる？',
    intent: '海外プラットフォーム経由の B2C 取引の消費税が誰の納税義務になるか知りたい',
    reader: 'プラットフォーマー課税の対象と自社処理の区別が分からない',
    success: 'プラットフォーム課税の仕組みと自社申告の要否が判断できる',
  },
  {
    id: 'specified-services',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '特定役務の提供（外国法人のスポーツ・芸能等）',
    q: '外国アーティスト・スポーツ選手への支払で特定役務の提供はどう判定する？',
    intent: '海外タレント・選手への報酬支払時の消費税リバースチャージを正しく処理したい',
    reader: '海外アーティスト・選手起用時の消費税処理が不安',
    success: '特定役務の提供の判定と源泉・消費税の併用処理が分かる',
  },
  {
    id: 'foreign-business-consumption-tax',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '国外事業者の消費税（特定資産の譲渡等）',
    q: '国外事業者からの仕入れに消費税はかかる？',
    intent: '国外事業者との取引の消費税課税・非課税の判定方法を知りたい',
    reader: '海外取引相手からの仕入れに消費税が含まれるか分からない',
    success: '国外事業者取引の消費税判定が具体的にできる',
  },
  {
    id: 'import-tax-refund-detail',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '輸入消費税の還付（個別品目）',
    q: '輸入消費税はどう還付申告する？',
    intent: '通関時に納付した輸入消費税の還付手続きと書類を知りたい',
    reader: '輸入消費税還付の具体的な手続きが不明',
    success: '輸入消費税還付の準備書類と申告方法が分かる',
  },
  {
    id: 'simplified-tax-business-category',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '簡易課税の業種区分（第1〜第6種）の細かい判定',
    q: '簡易課税の業種区分は自社のどの活動でどう分かれる？',
    intent: '簡易課税のみなし仕入率の業種判定で迷わないようにしたい',
    reader: '兼業や複数事業の業種区分判定が分からない',
    success: '簡易課税の業種区分判定が自社のケースで行える',
  },
  {
    id: 'high-value-asset-3year-restriction',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '高額特定資産の取得（3年縛り）',
    q: '高額特定資産を取得した場合の3年縛りはどう適用される？',
    intent: '1,000万円超の建物・機械等を取得した時の消費税の3年縛りを正しく理解したい',
    reader: '高額資産取得後の課税方式・免税復帰の制限が分からない',
    success: '高額特定資産の3年縛りルールが分かり、計画的な投資判断ができる',
  },
  {
    id: 'residential-rental-input-tax-restriction',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '居住用賃貸建物の仕入税額控除制限',
    q: '居住用賃貸建物の取得は仕入税額控除できる？',
    intent: '居住用賃貸建物を取得したときの消費税の還付可否を知りたい',
    reader: '住居用と店舗用混在の不動産の消費税処理が不安',
    success: '居住用賃貸建物の控除制限の判定と例外パターンが分かる',
  },
  {
    id: 'vending-machine-special',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '自動販売機特例の適用判定',
    q: '自動販売機の売上はどう消費税処理する？',
    intent: '飲料自販機・コインパーキング等の特例の適用判定をしたい',
    reader: '自販機売上の消費税区分と帳簿の付け方が分からない',
    success: '自販機特例の適用範囲と帳簿要件が具体的に分かる',
  },
  {
    id: 'travel-expense-input-tax',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '旅費・交通費の課税仕入れ判定',
    q: '出張旅費・交通費は消費税の課税仕入れになる？',
    intent: '出張旅費・通勤費の消費税処理を正しく行いたい',
    reader: '旅費規程・宿泊費・新幹線等の課税仕入れ判定が不安',
    success: '旅費の消費税区分と帳簿要件が分かる',
  },
  // ── ユーザー追加 ──
  {
    id: 'invoice-issuance-exempt',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '適格請求書の交付義務が免除される取引',
    q: '適格請求書の交付義務が免除されるのはどんな取引？',
    intent: '公共交通機関・自販機・郵便・卸売市場・農協委託販売など適格請求書交付義務免除の対象を知りたい',
    reader: 'どの取引でインボイスを発行・受領しなくてもよいか分からない',
    success: '適格請求書交付義務免除の対象 6 類型がケース別に分かる',
  },
  {
    id: 'book-only-input-tax-credit',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '帳簿のみ保存で仕入税額控除が適用できる取引',
    q: '帳簿のみで仕入税額控除が適用できるのはどんな取引？',
    intent: '公共交通機関・古物商・質屋・宅建業者・再生資源・従業員の出張旅費通勤手当など、帳簿保存のみで控除可能なケースを知りたい',
    reader: 'インボイス無しでも仕入税額控除が認められる範囲を知りたい',
    success: '帳簿のみ保存で控除可能な 9 類型がケース別に分かり、適切な帳簿記載ができる',
  },
];

const DEEP_PAINS_DEPRECIATION = [
  {
    id: 'used-asset-useful-life',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '中古資産の耐用年数（簡便法）',
    q: '中古資産を買った場合の耐用年数はどう計算する？',
    intent: '中古車・中古機械等の取得時に簡便法で耐用年数を計算したい',
    reader: '中古資産の耐用年数計算が分からない',
    success: '中古資産の簡便法計算が自社のケースでできる',
  },
  {
    id: 'small-depreciation-special',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '少額減価償却資産の特例（30万円未満・年間300万円まで）',
    q: '少額減価償却資産の特例はどう活用する？',
    intent: '30万円未満の固定資産取得時の即時償却特例を活用したい',
    reader: '少額減価償却特例の対象判定と上限管理が不安',
    success: '少額減価償却特例の使い分けと節税効果が分かる',
  },
  {
    id: 'lump-sum-depreciation-asset',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '一括償却資産（20万円未満の3年均等償却）',
    q: '一括償却資産はどう処理する？',
    intent: '20万円未満の資産の一括償却を有効活用したい',
    reader: '一括償却と少額減価償却の使い分けが分からない',
    success: '一括償却資産の判定と帳簿処理が分かる',
  },
  {
    id: 'special-depreciation',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '特別償却・割増償却（中小企業投資促進税制等）',
    q: '中小企業向けの特別償却制度は何がある？',
    intent: '中小企業投資促進税制等の特別償却の対象資産と適用要件を知りたい',
    reader: '特別償却制度の選択と税効果が不明',
    success: '主要な特別償却制度の対象と適用判定ができる',
  },
  {
    id: 'industry-fixed-assets',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '業種別の主要固定資産と耐用年数',
    q: '業種ごとの主要固定資産の耐用年数は？',
    intent: '美容室の椅子・鏡台、飲食店の厨房、運送業のトラック等の耐用年数を知りたい',
    reader: '自社業種の主要設備の耐用年数表が見つからない',
    success: '業種別の主要固定資産耐用年数が一覧で分かる',
  },
  {
    id: 'software-depreciation',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: 'ソフトウェアの減価償却',
    q: '業務用ソフト・自社開発ソフトはどう減価償却する？',
    intent: '購入ソフト・SaaS・自社開発ソフトの会計処理を区分したい',
    reader: 'ソフトウェアの種類別の処理方法が分からない',
    success: 'ソフトウェアの種類別の減価償却・経費処理が分かる',
  },
  {
    id: 'lease-transaction',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: 'リース取引（所有権移転外ファイナンスリース）',
    q: 'リース料は経費にできる？売買処理が必要？',
    intent: 'リース取引の3区分（売買処理・賃貸借処理）と判定基準を知りたい',
    reader: 'リース契約の経理処理が判別できない',
    success: 'リース取引の3区分判定と適切な経理処理ができる',
  },
  {
    id: 'capital-expenditure-vs-repair',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '資本的支出と修繕費の区分',
    q: '修繕費にできるか、資産計上が必要かどう判断する？',
    intent: '事務所の改修・機械の修理等の経費 / 資産計上判定をしたい',
    reader: '修繕費と資本的支出の境界が分からない',
    success: '具体例で資本的支出と修繕費の判定基準が分かる',
  },
  {
    id: 'acquisition-cost-inclusion',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '取得価額に含めるべき付随費用',
    q: '固定資産の取得価額に何を含めるべき？',
    intent: '配送費・据付費・登録費用等の取得価額算入判定をしたい',
    reader: '取得価額に含めるべき項目の判別が不安',
    success: '取得価額の付随費用判定が項目別にできる',
  },
  {
    id: 'depreciation-method-change',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '減価償却方法の変更手続き',
    q: '減価償却方法（定額法・定率法）の変更はできる？',
    intent: '減価償却方法変更の届出と税務影響を知りたい',
    reader: '減価償却方法変更のメリット・デメリットと手続きが不明',
    success: '減価償却方法変更の判断と届出書の書き方が分かる',
  },
];

const DEEP_PAINS_INDIRECT_TAX = [
  {
    id: 'light-oil-tax',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: 'ガソリン代の軽油引取税の扱い',
    q: 'ガソリン代の軽油引取税は消費税の課税仕入れに含む？',
    intent: 'ガソリン代の領収書から消費税課税仕入額を正しく算出したい',
    reader: '軽油引取税・石油税の処理が分からない',
    success: 'ガソリン代の消費税課税仕入れ算出が正しくできる',
  },
  {
    id: 'golf-utility-tax',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: 'ゴルフ場利用税・入湯税の経理処理',
    q: 'ゴルフ場利用税・入湯税はどう経理する？',
    intent: '接待用のゴルフ・温泉での非課税分の経理処理を知りたい',
    reader: 'ゴルフ場利用税の消費税課税の有無が分からない',
    success: 'ゴルフ場利用税・入湯税の正しい区分処理ができる',
  },
  {
    id: 'stamp-tax-industry',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '印紙税の業種別判定',
    q: 'うちの契約書に印紙は必要？',
    intent: '契約書・領収書の印紙税の判定と金額を知りたい',
    reader: '印紙税の課税文書判定と金額表が分からない',
    success: '主要契約書の印紙税判定と金額が分かる',
  },
  {
    id: 'auto-tax-treatment',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '自動車税・自動車重量税の費用処理',
    q: '自動車税・重量税はどの勘定科目で処理する？',
    intent: '事業用自動車の各種税金の費用処理を正しく行いたい',
    reader: '自動車関連税の勘定科目が分からない',
    success: '自動車関連税の費用処理が分かる',
  },
  {
    id: 'fixed-asset-tax',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '固定資産税（業種別の課税対象）',
    q: '事業用の固定資産税は何にかかる？',
    intent: '事業用建物・償却資産の固定資産税の対象を知りたい',
    reader: '償却資産申告と固定資産税の関係が不明',
    success: '償却資産申告の対象と申告方法が分かる',
  },
  {
    id: 'real-estate-acquisition-tax',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '不動産取得税の経理タイミング',
    q: '不動産取得税はいつ経費にする？',
    intent: '不動産取得時の各種税金の経理処理タイミングを知りたい',
    reader: '不動産取得税の損金算入タイミングが不明',
    success: '不動産取得税の損金算入時期と科目が分かる',
  },
  {
    id: 'registration-license-tax',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '登録免許税の費用処理',
    q: '不動産登記の登録免許税はどう経理する？',
    intent: '会社設立・不動産取得時の登録免許税の処理を知りたい',
    reader: '登録免許税の費用処理が分からない',
    success: '登録免許税の科目と損金算入時期が分かる',
  },
  {
    id: 'customs-duty-treatment',
    category: '海外取引',
    tax_domain: 'overseas_transactions',
    topic: '関税・通関手数料の経理処理',
    q: '輸入時の関税・通関手数料はどう処理する？',
    intent: '輸入仕入時の関税・通関手数料の経理処理を知りたい',
    reader: '関税を仕入原価に含めるべきか経費にすべきか不明',
    success: '関税・通関手数料の経理処理が分かる',
  },
];

const DEEP_PAINS_INDUSTRY_ACCOUNTING = [
  {
    id: 'salon-prepayment-ticket',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '美容室の前受金（回数券・チケット）の収益認識',
    q: '回数券の売上はいつ計上する？',
    intent: '美容室の回数券・前受金の売上計上タイミングを知りたい',
    reader: '前受金の処理と未消化分の年末処理が不安',
    success: '回数券売上の正しい計上タイミングと未消化分の処理ができる',
  },
  {
    id: 'restaurant-cash-management',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '飲食店の現金商売の売上管理（釣銭・自販機等）',
    q: '飲食店の現金売上はどう管理する？',
    intent: '現金売上のレジ締め・つり銭管理・帳簿付けを正しく行いたい',
    reader: '現金売上の管理方法・記帳ルールが分からない',
    success: '現金売上管理の実務フローと帳簿付けが分かる',
  },
  {
    id: 'construction-progress-method',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '建設業・受託開発の進行基準',
    q: '長期請負契約の売上計上はどうする？',
    intent: '建設業・受託開発で工事進行基準の適用判定をしたい',
    reader: '長期請負の売上計上方法が分からない',
    success: '進行基準・完成基準の選択判定と計算ができる',
  },
  {
    id: 'salon-product-service-distinction',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '美容関連業の物販と役務の区分',
    q: 'シャンプー販売は物販？役務？',
    intent: '美容室・サロンの店販商品と施術の消費税区分を知りたい',
    reader: '物販と役務提供の混在時の処理が不明',
    success: '物販と役務の区分判定と消費税処理が分かる',
  },
  {
    id: 'ec-inventory-fba-fbm',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: 'EC物販の在庫管理と棚卸（FBA・FBM）',
    q: 'Amazon FBA・FBM の在庫はどう管理する？',
    intent: 'EC物販の在庫管理と棚卸計算の実務を知りたい',
    reader: 'プラットフォーム別の在庫処理が分からない',
    success: 'EC物販の在庫管理フローと棚卸計算ができる',
  },
  {
    id: 'influencer-pr-product-revenue',
    category: '所得税',
    tax_domain: 'income_tax',
    topic: 'インフルエンサーの物品提供（PR案件）の収益認識',
    q: 'PR案件で受け取った商品は売上計上が必要？',
    intent: '物品提供型 PR の売上認識と評価方法を知りたい',
    reader: '物品提供を売上にすべきか経費にすべきか不明',
    success: '物品提供型PRの収益認識と評価方法が分かる',
  },
  {
    id: 'creator-royalty-income',
    category: '所得税',
    tax_domain: 'income_tax',
    topic: 'クリエイターの版権収入・印税',
    q: '版権・印税収入はどう処理する？',
    intent: '版権・印税収入の所得区分と源泉徴収の扱いを知りたい',
    reader: '印税収入の確定申告での扱いが分からない',
    success: '版権・印税収入の所得区分と申告方法が分かる',
  },
  {
    id: 'affiliate-withholding-judgment',
    category: '所得税',
    tax_domain: 'income_tax',
    topic: 'アフィリエイト収入の源泉徴収判定',
    q: 'アフィリエイト報酬は源泉徴収される？',
    intent: 'ASP からの報酬の源泉徴収有無と確定申告での扱いを知りたい',
    reader: 'アフィリエイト報酬の確定申告での処理が不明',
    success: 'アフィリエイト報酬の源泉判定と申告方法が分かる',
  },
  {
    id: 'crowdfunding-tax-treatment',
    category: '所得税',
    tax_domain: 'income_tax',
    topic: 'クラウドファンディングの種類別税務（購入型・寄付型・投資型）',
    q: 'クラウドファンディングの収入はどう申告する？',
    intent: 'CF 3 種類の税務処理（売上 / 寄付 / 出資）を区分したい',
    reader: 'クラウドファンディングの収入の所得区分が分からない',
    success: 'CF 3種類の税務処理と申告方法が分かる',
  },
];

const DEEP_PAINS_TAX_PRACTICE = [
  {
    id: 'invoice-transition-80-50',
    category: 'インボイス',
    tax_domain: 'invoice_system',
    topic: 'インボイス未登録仕入の経過措置（80% / 50% 控除）',
    q: 'インボイス未登録の業者から仕入れた場合の控除はどうなる？',
    intent: 'インボイス制度の経過措置を活用したい',
    reader: '免税事業者からの仕入の控除割合と期間が分からない',
    success: '経過措置の80%/50%控除の活用判定と帳簿要件が分かる',
  },
  {
    id: 'book-retention-requirements',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '帳簿の保存要件（青色 7 年・白色 5 年・電子帳簿）',
    q: '帳簿はどれくらいの期間保存する必要がある？',
    intent: '青色・白色・電子帳簿それぞれの保存期間と方法を知りたい',
    reader: '帳簿の保存期間と保存方法が不明',
    success: '帳簿保存要件と電子帳簿保存法の対応が分かる',
  },
  {
    id: 'simplified-vs-standard-judgment',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '簡易課税と原則課税の有利不利判定',
    q: '簡易課税と原則課税はどちらが有利？',
    intent: '自社の状況で簡易課税と原則課税のどちらが有利か判定したい',
    reader: '簡易課税選択の損益判定基準が分からない',
    success: '自社のシミュレーションで簡易/原則を判定できる',
  },
  {
    id: 'taxable-sales-ratio',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '課税売上割合の計算と95%ルール',
    q: '課税売上割合はどう計算する？',
    intent: '非課税売上がある場合の課税売上割合と仕入税額控除制限を理解したい',
    reader: '課税売上割合の計算と95%ルールが分からない',
    success: '課税売上割合の計算と仕入税額控除の調整ができる',
  },
  {
    id: 'individual-vs-proportional-method',
    category: '消費税',
    tax_domain: 'consumption_tax',
    topic: '個別対応方式と一括比例配分方式',
    q: '個別対応方式と一括比例配分方式はどう選ぶ？',
    intent: '課税売上割合95%未満時の控除方式選択をしたい',
    reader: '個別対応方式・一括比例配分方式の判定が不明',
    success: '2 方式の選択判定とシミュレーション計算ができる',
  },
  {
    id: 'director-salary-fixed-amount',
    category: '所得税',
    tax_domain: 'income_tax',
    topic: '役員報酬の定期同額給与・事前確定届出給与',
    q: '役員報酬はどう設計すれば損金算入できる？',
    intent: '役員報酬の損金算入要件を満たす設計を知りたい',
    reader: '定期同額給与・事前確定届出の要件が分からない',
    success: '役員報酬の損金算入要件と届出方法が分かる',
  },
  {
    id: 'entertainment-expense-deduction',
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
    topic: '中小法人の交際費損金算入の特例',
    q: '中小法人の交際費はどこまで損金算入できる？',
    intent: '中小法人の交際費損金算入特例の活用方法を知りたい',
    reader: '交際費800万円特例・50%特例の選択が不明',
    success: '中小法人の交際費損金算入特例の選択判定ができる',
  },
];

// E. 経費判断シリーズ（25 項目）
// 経営者の検索ニーズが極めて高い領域。「○○は経費にできる？」の各状況別。
const DEEP_PAINS_EXPENSE_JUDGMENT = [
  {
    id: 'expense-suit-shoes',          q: 'スーツ・ビジネス靴は経費にできる？', topic: 'スーツ・ビジネス靴の経費判断',
    intent: '事業用としてのスーツ・革靴の経費計上可否を知りたい',
    reader: 'スーツ代を経費にしたいが認められる範囲が不明',
    success: 'スーツ・靴の経費判断基準と税務調査での主張ポイントが分かる',
  },
  {
    id: 'expense-glasses-contacts',     q: 'メガネ・コンタクトレンズは経費にできる？', topic: 'メガネ・コンタクトの経費判断',
    intent: '業務用メガネ・コンタクトの経費計上可否を知りたい',
    reader: '視力矯正のメガネ・コンタクト代の経費可否が不明',
    success: 'メガネ・コンタクトの経費判断と業務専用性の証明方法が分かる',
  },
  {
    id: 'expense-gym-fitness',          q: 'ジム代・フィットネス代は経費にできる？', topic: 'ジム・フィットネスの経費判断',
    intent: '個人事業主・社長のジム代の経費計上可否を知りたい',
    reader: 'ジム代を福利厚生費等で経費にできるか不明',
    success: 'ジム代の個人事業 / 法人での経費判断と適用条件が分かる',
  },
  {
    id: 'expense-health-checkup',       q: '健康診断・人間ドックは経費にできる？', topic: '健康診断の経費判断',
    intent: '個人事業主・社長の健康診断費の経費可否を知りたい',
    reader: '健康診断代を経費にできる条件が不明',
    success: '健康診断費の経費判断と福利厚生費としての要件が分かる',
  },
  {
    id: 'expense-seminar-books',        q: 'セミナー参加費・書籍代は経費にできる？', topic: 'セミナー・書籍代の経費判断',
    intent: '業務に関連するセミナー・書籍代の経費計上可否を知りたい',
    reader: 'セミナー代・書籍代の事業関連性の判定基準が不明',
    success: 'セミナー・書籍代の経費判断と事業関連性の証明方法が分かる',
  },
  {
    id: 'expense-home-office',          q: '自宅兼事務所の家賃・光熱費は経費にできる？', topic: '自宅兼事務所の按分経費',
    intent: '自宅兼事務所の家賃・光熱費・通信費の按分計算を知りたい',
    reader: '自宅オフィスの按分割合と計算根拠が分からない',
    success: '自宅兼事務所の経費按分の合理的計算方法が分かる',
  },
  {
    id: 'expense-solo-lunch',           q: '一人ランチ・カフェ作業代は経費にできる？', topic: '一人ランチ・カフェ代の経費判断',
    intent: '一人ランチや作業用カフェ代の経費計上可否を知りたい',
    reader: '一人での飲食代を経費にできる条件が不明',
    success: '一人ランチ・カフェ作業代の経費判断と帳簿記載方法が分かる',
  },
  {
    id: 'expense-family-meal',          q: '家族との食事は経費にできる？', topic: '家族との食事代の経費判断',
    intent: '家族との食事会の経費計上可否と条件を知りたい',
    reader: '家族との食事を経費にできる範囲が不明',
    success: '家族との食事代の経費判断と帳簿記載のポイントが分かる',
  },
  {
    id: 'expense-car-related',          q: '車の購入費・ガソリン代・駐車場代は経費にできる？', topic: '車関連費用の経費判断',
    intent: '事業用の車・ガソリン代・駐車場代の経費計上を知りたい',
    reader: '車関連費用の按分割合と帳簿記載が不安',
    success: '車関連費用の経費判断と按分計算ができる',
  },
  {
    id: 'expense-family-salary',        q: '配偶者・家族への給与は経費にできる？', topic: '家族への給与の経費判断',
    intent: '青色事業専従者給与・白色専従者控除の活用方法を知りたい',
    reader: '家族への給与を経費にできる条件と上限が不明',
    success: '専従者給与の届出と要件が分かり、節税効果を計算できる',
  },
  {
    id: 'expense-travel-companion',     q: '旅費・出張同伴者の費用は経費にできる？', topic: '出張同伴者の費用経費判断',
    intent: '出張に家族・配偶者を同伴した時の費用処理を知りたい',
    reader: '同伴者の旅費を経費にできる条件が不明',
    success: '同伴者の旅費の経費判断と税務リスクが分かる',
  },
  {
    id: 'expense-mobile-internet',      q: '携帯電話代・通信費は経費にできる？', topic: '携帯・通信費の経費判断',
    intent: '事業用と私用が混在する携帯・通信費の按分を知りたい',
    reader: '携帯・インターネット代の按分計算が不安',
    success: '通信費の按分計算と帳簿記載方法が分かる',
  },
  {
    id: 'expense-pc-smartphone',        q: 'パソコン・スマホ・タブレットは経費にできる？', topic: 'PC・スマホ等の経費判断',
    intent: '事業用 PC・スマホ・タブレットの経費計上と償却を知りたい',
    reader: 'PC・スマホ等の経費 / 減価償却の判定が分からない',
    success: 'PC・スマホ等の経費判断と償却方法の選択ができる',
  },
  {
    id: 'expense-beauty-cosmetics',     q: '美容室・化粧品代は経費にできる？', topic: '美容・化粧品代の経費判断',
    intent: 'インフルエンサー・営業職等の美容・化粧品代の経費計上を知りたい',
    reader: '美容代を経費にできる職種と条件が不明',
    success: '職種別の美容代経費判断と税務調査対策が分かる',
  },
  {
    id: 'expense-gift-condolence',      q: 'ご祝儀・香典・お見舞金は経費にできる？', topic: '慶弔費の経費判断',
    intent: '取引先への慶弔費の経費計上と上限を知りたい',
    reader: '慶弔費の判断基準と帳簿記載が不安',
    success: '慶弔費の経費判断と適切な帳簿記載ができる',
  },
  {
    id: 'expense-wedding-cost',         q: '結婚式の費用は経費にできる？', topic: '結婚式費用の経費判断',
    intent: '取引先関係者の結婚式関連費用の経費計上を知りたい',
    reader: '結婚式関連の経費にできる範囲が不明',
    success: '結婚式関連費用の経費判断とリスクが分かる',
  },
  {
    id: 'expense-celebration-business', q: 'お祝い金・お悔やみ金（取引先向け）は経費にできる？', topic: '取引先向け祝儀の経費判断',
    intent: '取引先向けの祝儀・弔慰金の経費計上と社内規程を知りたい',
    reader: '取引先慶弔費の上限と帳簿記載が不安',
    success: '取引先慶弔費の経費判断と社内規程の作り方が分かる',
  },
  {
    id: 'expense-meeting-cafe',         q: '飲食店・カフェでの打ち合わせ代は経費にできる？', topic: '打ち合わせ飲食代の経費判断',
    intent: '取引先との打ち合わせでの飲食代の経費区分を知りたい',
    reader: '会議費と交際費の区分が不明',
    success: '打ち合わせ飲食代の会議費 / 交際費の区分判定ができる',
  },
  {
    id: 'expense-golf-entertainment',   q: '接待のゴルフ・キャバクラ代は経費にできる？', topic: '接待のゴルフ・キャバクラの経費判断',
    intent: '接待ゴルフ・夜のお店の費用処理と税務調査対応を知りたい',
    reader: '接待費の経費計上と税務調査リスクが不安',
    success: '接待費の適切な処理と税務調査対策が分かる',
  },
  {
    id: 'expense-funeral',              q: '葬儀代は経費にできる？', topic: '葬儀代の経費判断',
    intent: '取引先関係者の葬儀代の経費計上を知りたい',
    reader: '葬儀代の経費可否と上限が不明',
    success: '葬儀関連費用の経費判断ができる',
  },
  {
    id: 'expense-office-supply-snacks', q: '会社の備品（コーヒー・お菓子・飲料）は経費にできる？', topic: '備品・嗜好品の経費判断',
    intent: 'オフィスのコーヒー・お菓子・飲料の経費計上を知りたい',
    reader: '会社の備品 / 嗜好品の経費判断が不明',
    success: '備品・嗜好品の経費判断と科目選択が分かる',
  },
  {
    id: 'expense-decoration-plants',    q: '観葉植物・絵画・装飾品は経費にできる？', topic: '装飾品の経費判断',
    intent: 'サロン・店舗・オフィスの装飾品の経費計上を知りたい',
    reader: '美術品・観葉植物の経費 / 償却判定が不明',
    success: '装飾品の経費判断と金額別の処理方法が分かる',
  },
  {
    id: 'expense-moving-cost',          q: '自宅・事務所の引越し代は経費にできる？', topic: '引越し代の経費判断',
    intent: '事業用に伴う引越し代の経費計上を知りたい',
    reader: '引越し代を経費にできる条件が不明',
    success: '引越し代の経費判断と按分計算ができる',
  },
  {
    id: 'expense-taxi-late-night',      q: 'タクシー代（深夜・接待後）は経費にできる？', topic: 'タクシー代の経費判断',
    intent: '深夜・接待後のタクシー代の経費計上を知りたい',
    reader: 'タクシー代の経費判断と帳簿記載が不安',
    success: 'タクシー代の経費区分と帳簿記載のポイントが分かる',
  },
  {
    id: 'expense-children-education',   q: '子供の習い事・教育費は経費にできる？', topic: '子供の教育費の経費判断',
    intent: '子供の習い事や教育費を経費にできる条件を知りたい',
    reader: '子供の教育費を経費にできるか不明',
    success: '子供関連費用の経費判断と所得控除との使い分けが分かる',
  },
  {
    id: 'expense-pet-cost',              q: 'ペット関連費用は経費にできる？', topic: 'ペット関連費の経費判断',
    intent: 'サロン看板犬・撮影用ペット等の費用の経費計上を知りたい',
    reader: 'ペット関連費を経費にできる条件が不明',
    success: 'ペット関連費用の経費判断ができる',
  },
  {
    id: 'expense-outsourcing-vs-salary', q: '業務委託と給与の判定（外注費にできる？）', topic: '業務委託 vs 給与の判定',
    intent: '業務委託費を給与認定されるリスクを避けたい',
    reader: '業務委託と給与の判定基準が不安',
    success: '外注費として処理する条件と契約書の要件が分かる',
  },
  {
    id: 'expense-clothing-cosmetics-sns', q: 'SNS投稿用の衣装・コスメは経費にできる？', topic: 'SNS投稿用衣装・コスメの経費判断',
    intent: 'インフルエンサーの衣装・コスメの経費計上を知りたい',
    reader: 'SNS用衣装と私用の区分が不明',
    success: 'SNS投稿用衣装・コスメの経費判断と業務専用性の証明方法が分かる',
  },
  {
    id: 'expense-security-camera',       q: '防犯カメラ・セキュリティ費用は経費にできる？', topic: '防犯設備の経費判断',
    intent: '店舗・事務所の防犯設備の経費計上と償却を知りたい',
    reader: '防犯設備の経費 / 償却の判定が不明',
    success: '防犯設備の経費判断と償却方法が分かる',
  },
  {
    id: 'expense-interview-location-fee', q: '取材費・場所代は経費にできる？', topic: '取材・場所代の経費判断',
    intent: 'メディア取材時の場所代・コンテンツ撮影費の経費計上を知りたい',
    reader: '取材・撮影関連費用の処理が不明',
    success: '取材費・場所代の経費判断ができる',
  },
  {
    id: 'expense-health-supplement',     q: '健康食品・サプリは経費にできる？', topic: '健康食品・サプリの経費判断',
    intent: '健康維持目的のサプリ・栄養剤の経費計上を知りたい',
    reader: '健康食品・サプリの経費可否が不明',
    success: '健康食品・サプリの経費判断と業務関連性の証明方法が分かる',
  },
  {
    id: 'expense-insurance-premium',     q: '損害保険・賠償責任保険料は経費にできる？', topic: '事業保険料の経費判断',
    intent: '事業用の損害保険・賠償責任保険の経費計上を知りたい',
    reader: '事業保険料の科目選択と按分が不明',
    success: '事業保険料の経費判断と科目選択ができる',
  },
  {
    id: 'expense-professional-fee',      q: '弁護士・税理士・コンサル料は経費にできる？', topic: '専門家報酬の経費判断',
    intent: '弁護士・税理士・各種コンサル料の経費計上と源泉徴収を知りたい',
    reader: '専門家報酬の科目と源泉判定が不明',
    success: '専門家報酬の経費処理と源泉徴収判定ができる',
  },
  {
    id: 'expense-corporate-conversion-consult', q: '法人化検討時のコンサル料は経費にできる？', topic: '法人化検討費の経費判断',
    intent: '法人成り検討時のコンサル料・調査費の経費計上を知りたい',
    reader: '法人化前後の費用処理が不明',
    success: '法人化検討費の経費 / 開業費の区分が分かる',
  },
  {
    id: 'expense-subsidy-application',   q: '補助金・助成金申請の代行費は経費にできる？', topic: '補助金申請代行費の経費判断',
    intent: '補助金申請の代行費と受給後の処理を知りたい',
    reader: '補助金申請代行費と補助金収入の処理が不明',
    success: '補助金申請代行費の経費判断と補助金受給時の処理が分かる',
  },
];

// 全 pain_point のフラットなリスト
function getAllDeepPains() {
  // 経費判断シリーズには共通項目を補完
  const expenseDefaults = {
    category: '帳簿・経費',
    tax_domain: 'bookkeeping_expenses',
  };
  const all = [
    ...DEEP_PAINS_CONSUMPTION_TAX,
    ...DEEP_PAINS_DEPRECIATION,
    ...DEEP_PAINS_INDIRECT_TAX,
    ...DEEP_PAINS_INDUSTRY_ACCOUNTING,
    ...DEEP_PAINS_TAX_PRACTICE,
    ...DEEP_PAINS_EXPENSE_JUDGMENT.map(e => ({ ...expenseDefaults, ...e })),
  ];
  // 各論点に「出稿してよい顧客カテゴリ」を付与
  return all.map(p => ({ ...p, allowed_segments: allowedSegmentsForPain(p) }));
}

// ── 各論点を topic として展開 ─────────────────────────────
// 各深堀り論点を、複数の persona で main+support のペア展開する。
// persona の選び方:
//   - 経費判断系 → 'general_business_owner', 'influencer_creator', 'beauty_salon_owner', 'domestic_ec_seller'（4 persona）
//   - その他 → 'general_business_owner' + tax_domain に応じた業種特化 persona
function expandDeepDive() {
  const out = [];
  const allPains = getAllDeepPains();

  for (const pain of allPains) {
    const personas = pickPersonasForPain(pain);
    for (const persona of personas) {
      // 本命 + 補強の 2 ペア
      const baseSlug = `deepdive-${persona.id}-${pain.id}`;
      const pairGroup = baseSlug;
      const macro = '税目実務';
      // cluster は persona ベースに（cooldown / similarity / (pain × type) クオータで
      // 多様性カウントが効くようにするため）。tax_domain は subcluster 内で表現。
      const cluster = `deepdive-${persona.id.replace(/_/g, '-')}`;
      const subcluster = `${pain.tax_domain.replace(/_/g, '-')}-${pain.id}`;

      // main 記事
      out.push({
        title: '',
        slug: `${baseSlug}-guide`,
        category: pain.category,
        persona: persona.id,
        customer_segment: persona.segment,
        allowed_customer_segments: pain.allowed_segments,
        macro, cluster, subcluster,
        tax_domain: pain.tax_domain,
        business_stage: '',
        life_stage: '',
        pain_point: pain.id,
        procedure_stage: '',
        article_type: 'basic_explainer',
        article_role: 'main',
        pair_group: pairGroup,
        search_intent: pain.intent,
        reader_problem: pain.reader,
        success_outcome: pain.success,
        primary_question: pain.q,
      });
      // support 記事（edge_case で具体ケースに踏み込む）
      out.push({
        title: '',
        slug: `${baseSlug}-practice`,
        category: pain.category,
        persona: persona.id,
        customer_segment: persona.segment,
        allowed_customer_segments: pain.allowed_segments,
        macro, cluster, subcluster: subcluster + '-support',
        tax_domain: pain.tax_domain,
        business_stage: '',
        life_stage: '',
        pain_point: pain.id,
        procedure_stage: '',
        article_type: 'edge_case',
        article_role: 'support',
        pair_group: pairGroup,
        search_intent: pain.intent + '（判断に迷うケース別）',
        reader_problem: pain.reader,
        success_outcome: pain.success + '。具体的なケース別の判断ができる',
        primary_question: pain.q + '（具体ケース別）',
      });
    }
  }

  return out;
}

// pain ごとに展開対象を決定する。
// 旧実装は「税目が一致すれば内容問わず複数 persona に一律展開」していたため、
// 美容サロン × 海外アーティスト報酬のような不自然な組み合わせを生んでいた。
// 現在は pain.allowed_segments（＝現実的な顧客カテゴリ）だけへ、
// 1 カテゴリ = 1 代表 persona で展開する。
// 返り値: [{ id: personaId, segment: customerSegment }, ...]
function pickPersonasForPain(pain) {
  const segs = pain.allowed_segments || allowedSegmentsForPain(pain);
  const out = [];
  const seen = new Set();
  for (const seg of segs) {
    const pid = SEGMENT_PRIMARY_PERSONA[seg];
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push({ id: pid, segment: seg });
  }
  return out;
}

module.exports = {
  expandDeepDive,
  getAllDeepPains,
  DEEP_PAINS_CONSUMPTION_TAX,
  DEEP_PAINS_DEPRECIATION,
  DEEP_PAINS_INDIRECT_TAX,
  DEEP_PAINS_INDUSTRY_ACCOUNTING,
  DEEP_PAINS_TAX_PRACTICE,
  DEEP_PAINS_EXPENSE_JUDGMENT,
};
