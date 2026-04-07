'use strict';

/**
 * 承認済み記事テーマプール（本番生成対象）
 *
 * - 日次の記事生成（generate-draft.js）はこのプールからのみ選択する
 * - 新規テーマの追加は propose-topics.js で候補を生成 → 人間が承認 → ここに追加
 * - 各テーマは実際に検索されるキーワード・疑問をベースに設計
 * - persona / category は既存の validate.js と整合していること
 *
 * quality:
 *   'standard' — Sonnet 4.6 で生成（デフォルト）
 *   'high'     — Opus 4.6 で生成（税制度の複雑な論点・相続・特例等）
 *
 * source_url:
 *   公的根拠が明確な場合のみ設定する。根拠が弱い場合は空文字で可。
 *   validate.js は draft/needs_review では source_url 未設定を警告扱いにする。
 */

const TOPICS = [

  // ────────────────────────────────────────────
  //  eBay輸出セラー × 消費税
  // ────────────────────────────────────────────
  { persona: 'ebay_export_seller', category: '消費税', quality: 'high',
    title: 'eBay輸出の消費税還付とは？仕組み・条件・申請手順をわかりやすく解説',
    slug: 'ebay-export-consumption-tax-refund-guide',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm',
    source_title: '国税庁タックスアンサー No.6551 輸出取引の免税',
    hint: '輸出免税の要件・証拠書類・課税事業者届出の手順を解説' },

  { persona: 'ebay_export_seller', category: '消費税', quality: 'high',
    title: 'eBay輸出で課税事業者になるべき？免税事業者との違いとメリット・デメリット',
    slug: 'ebay-taxable-vs-exempt-business',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
    source_title: '国税庁タックスアンサー No.6501 納税義務の免除',
    hint: '基準期間の売上判定・課税事業者届出のタイミングを解説' },

  { persona: 'ebay_export_seller', category: '消費税', quality: 'standard',
    title: 'eBayセラーが消費税還付申告で必要な書類一覧と準備のコツ',
    slug: 'ebay-tax-refund-required-documents',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm',
    source_title: '国税庁タックスアンサー No.6551 輸出取引の免税',
    hint: '輸出証明書・通関書類・PayPalレポートの整理方法' },

  { persona: 'ebay_export_seller', category: 'インボイス', quality: 'standard',
    title: 'eBay輸出セラーにインボイス制度は関係ある？対応すべきケースを解説',
    slug: 'ebay-export-invoice-system-impact',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: '輸出免税と仕入税額控除の関係、国内仕入先との取引への影響' },

  { persona: 'ebay_export_seller', category: '海外取引', quality: 'standard',
    title: 'eBay輸出の売上はどう計上する？為替レートの選び方と仕訳例',
    slug: 'ebay-export-exchange-rate-accounting',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1920.htm',
    source_title: '国税庁タックスアンサー No.1920 海外転勤と所得税',
    hint: 'TTB/TTS/TTMの使い分け・PayPal入金日基準の処理' },

  { persona: 'ebay_export_seller', category: '海外取引', quality: 'standard',
    title: 'eBay輸出の送料・関税・手数料は経費にできる？仕訳と注意点',
    slug: 'ebay-export-shipping-customs-expenses',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '国際送料・eBay手数料・PayPal手数料・関税の勘定科目' },

  // ────────────────────────────────────────────
  //  国内EC物販セラー × 消費税・インボイス
  // ────────────────────────────────────────────
  { persona: 'domestic_ec_seller', category: '消費税', quality: 'standard',
    title: 'Amazon物販の消費税はどうなる？FBA手数料の仕入税額控除と注意点',
    slug: 'amazon-fba-consumption-tax-deduction',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6451.htm',
    source_title: '国税庁タックスアンサー No.6451 仕入税額控除の対象範囲',
    hint: 'FBA手数料・広告費・配送代行費の課税仕入処理' },

  { persona: 'domestic_ec_seller', category: 'インボイス', quality: 'standard',
    title: 'Amazon・楽天出店者のインボイス対応ガイド｜登録しないとどうなる？',
    slug: 'ec-seller-invoice-registration-guide',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: '適格請求書発行事業者登録の判断基準・BtoB/BtoC別の影響' },

  { persona: 'domestic_ec_seller', category: 'インボイス', quality: 'high',
    title: 'EC物販の仕入先がインボイス未登録だったら？経過措置と実務対応',
    slug: 'ec-purchase-non-invoice-supplier-measures',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: '80%→50%控除の経過措置・仕入先への確認方法' },

  { persona: 'domestic_ec_seller', category: '帳簿・経費', quality: 'standard',
    title: 'せどり・物販の在庫管理と棚卸のやり方｜確定申告で失敗しないために',
    slug: 'ec-inventory-stocktaking-tax-return',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '期末棚卸の評価方法・売上原価の計算・帳簿のつけ方' },

  { persona: 'domestic_ec_seller', category: '帳簿・経費', quality: 'standard',
    title: 'Amazon物販の経費はどこまで認められる？仕入・梱包・広告費の仕訳ガイド',
    slug: 'amazon-seller-deductible-expenses-guide',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '仕入原価・FBA保管料・広告費・梱包資材費の勘定科目' },

  { persona: 'domestic_ec_seller', category: '消費税', quality: 'high',
    title: 'ネットショップ運営者の消費税申告｜簡易課税と本則課税どちらが有利？',
    slug: 'ec-shop-simplified-vs-standard-tax',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm',
    source_title: '国税庁タックスアンサー No.6505 簡易課税制度',
    hint: '第1種〜第6種の事業区分・みなし仕入率の比較' },

  // ────────────────────────────────────────────
  //  フリマ・転売セラー × 所得税
  // ────────────────────────────────────────────
  { persona: 'reseller_marketplace_seller', category: '所得税', quality: 'standard',
    title: 'メルカリ・ヤフオクの売上に税金はかかる？確定申告が必要なラインを解説',
    slug: 'mercari-yahoo-auction-tax-filing-threshold',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1906.htm',
    source_title: '国税庁タックスアンサー No.1906 給与所得者がネットオークション等で副収入',
    hint: '生活用動産の非課税範囲・20万円ルール・事業所得との線引き' },

  { persona: 'reseller_marketplace_seller', category: '所得税', quality: 'standard',
    title: '副業せどりの確定申告ガイド｜会社にバレない方法と経費の考え方',
    slug: 'side-job-reselling-tax-return-guide',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm',
    source_title: '国税庁タックスアンサー No.1900 給与所得者で確定申告が必要な人',
    hint: '住民税の普通徴収切替・雑所得vs事業所得の判断基準' },

  { persona: 'reseller_marketplace_seller', category: '帳簿・経費', quality: 'standard',
    title: 'せどり転売の利益計算と帳簿の付け方｜初心者でもわかる記帳入門',
    slug: 'reselling-profit-bookkeeping-beginners',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2080.htm',
    source_title: '国税庁タックスアンサー No.2080 白色申告者の記帳・帳簿等の保存',
    hint: '売上台帳・仕入台帳のテンプレート・レシート保存ルール' },

  { persona: 'reseller_marketplace_seller', category: '所得税', quality: 'standard',
    title: 'フリマアプリの送料負担は経費になる？せどり特有の経費と落とし穴',
    slug: 'flea-market-app-shipping-cost-deduction',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '送料・梱包材・販売手数料・仕入交通費の計上可否' },

  { persona: 'reseller_marketplace_seller', category: 'インボイス', quality: 'standard',
    title: 'せどり・転売業者もインボイス登録すべき？免税事業者が考える判断基準',
    slug: 'reseller-invoice-registration-decision',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: 'BtoC中心なら不要？古物商特例・2割特例の活用' },

  // ────────────────────────────────────────────
  //  インフルエンサー・クリエイター × 所得税・経費
  // ────────────────────────────────────────────
  { persona: 'influencer_creator', category: '所得税', quality: 'standard',
    title: 'YouTuber・インフルエンサーの確定申告入門｜広告収入の申告方法と節税ポイント',
    slug: 'youtuber-influencer-tax-return-basics',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm',
    source_title: '国税庁タックスアンサー No.1350 事業所得の課税のしくみ',
    hint: 'Google AdSense収入の所得区分・青色申告の特典' },

  { persona: 'influencer_creator', category: '帳簿・経費', quality: 'standard',
    title: 'インフルエンサーの経費はどこまでOK？撮影機材・衣装・美容代の判断基準',
    slug: 'influencer-deductible-expenses-criteria',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '家事按分・衣装費・美容院代・旅行費用のグレーゾーン' },

  { persona: 'influencer_creator', category: '帳簿・経費', quality: 'high',
    title: 'SNS運用の外注費・案件報酬の源泉徴収｜クリエイターが知るべき税務処理',
    slug: 'creator-outsourcing-withholding-tax',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm',
    source_title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金',
    hint: '企業案件の源泉徴収・支払調書の確認・外注時の源泉義務' },

  { persona: 'influencer_creator', category: 'インボイス', quality: 'standard',
    title: 'インフルエンサー・配信者のインボイス対応｜企業案件への影響と対策',
    slug: 'influencer-invoice-system-corporate-deals',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: '企業がインボイスを求める理由・2割特例の活用・登録判断' },

  { persona: 'influencer_creator', category: '所得税', quality: 'standard',
    title: 'アフィリエイト・PR案件の収入はいつ計上する？発生主義と入金ベースの違い',
    slug: 'affiliate-pr-income-recognition-timing',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm',
    source_title: '国税庁タックスアンサー No.2200 収入金額とその計算',
    hint: '発生主義・確定日基準・ASP報酬の未払計上' },

  { persona: 'influencer_creator', category: '所得税', quality: 'standard',
    title: '副業YouTuber・ブロガーが開業届を出すべきタイミングと青色申告の始め方',
    slug: 'side-youtuber-opening-notification-blue-return',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm',
    source_title: '国税庁タックスアンサー No.2070 青色申告制度',
    hint: '開業届の提出期限・青色申告承認申請書・65万円控除の条件' },

  // ────────────────────────────────────────────
  //  美容サロンオーナー × 消費税・所得税・経費
  // ────────────────────────────────────────────
  { persona: 'beauty_salon_owner', category: '消費税', quality: 'high',
    title: '美容室・サロンの消費税申告｜簡易課税と本則課税の有利判定シミュレーション',
    slug: 'beauty-salon-consumption-tax-simulation',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm',
    source_title: '国税庁タックスアンサー No.6505 簡易課税制度',
    hint: 'サービス業（第5種）のみなし仕入率50%・物販併設時の注意' },

  { persona: 'beauty_salon_owner', category: '所得税', quality: 'standard',
    title: '美容室を個人で開業したときの税金の基本｜届出・青色申告・経費の全体像',
    slug: 'beauty-salon-sole-proprietor-tax-basics',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm',
    source_title: '国税庁タックスアンサー No.2070 青色申告制度',
    hint: '開業届・青色申告・事業開始後に必要な届出一覧' },

  { persona: 'beauty_salon_owner', category: '帳簿・経費', quality: 'standard',
    title: 'エステ・脱毛サロンの経費はどこまで落とせる？美容機器・消耗品・研修費の仕訳',
    slug: 'esthetic-salon-deductible-expenses-entries',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
    source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
    hint: '美容機器の減価償却・消耗品費・技術研修費・ユニフォーム代' },

  { persona: 'beauty_salon_owner', category: '帳簿・経費', quality: 'standard',
    title: 'ネイルサロン開業の初期費用と税務処理｜開業費の償却と仕訳例',
    slug: 'nail-salon-startup-costs-tax-treatment',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm',
    source_title: '国税庁タックスアンサー No.2100 減価償却のあらまし',
    hint: '内装工事・設備投資の資産計上基準と開業費の5年任意償却' },

  { persona: 'beauty_salon_owner', category: '消費税', quality: 'standard',
    title: '美容サロンでインボイス登録は必要？お客様がほぼ個人の場合の判断基準',
    slug: 'beauty-salon-invoice-btoc-decision',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
    source_title: '国税庁 インボイス制度の概要',
    hint: 'BtoC中心でも登録が必要になるケース・法人顧客の有無' },

  { persona: 'beauty_salon_owner', category: '所得税', quality: 'high',
    title: '美容室オーナーが法人化すべき売上の目安と法人化のメリット・デメリット',
    slug: 'beauty-salon-incorporation-threshold',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm',
    source_title: '国税庁タックスアンサー No.2260 所得税の税率',
    hint: '所得税率との比較・社会保険料負担・法人設立届出' },

  // ────────────────────────────────────────────
  //  相続・贈与の依頼者 × 相続税・贈与税
  // ────────────────────────────────────────────
  { persona: 'inheritance_client', category: '相続', quality: 'high',
    title: '相続税の基礎控除とは？計算方法と「うちは相続税がかかるのか」の判断基準',
    slug: 'inheritance-tax-basic-deduction-guide',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm',
    source_title: '国税庁タックスアンサー No.4152 相続税の計算',
    hint: '3000万円+600万円×法定相続人数の基礎控除・速算表の使い方' },

  { persona: 'inheritance_client', category: '相続', quality: 'high',
    title: '生前贈与で相続税対策｜暦年贈与と相続時精算課税制度の違いと選び方',
    slug: 'lifetime-gift-inheritance-tax-planning',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
    source_title: '国税庁タックスアンサー No.4408 贈与税の計算と税率',
    hint: '年110万円非課税枠・相続時精算課税2500万円枠・7年加算ルール' },

  { persona: 'inheritance_client', category: '相続', quality: 'high',
    title: '自宅の相続で使える小規模宅地等の特例とは？最大80%減額の条件を解説',
    slug: 'small-residential-land-special-provision',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm',
    source_title: '国税庁タックスアンサー No.4124 相続した事業の用や居住の用の宅地等の価額の特例',
    hint: '特定居住用宅地330㎡まで80%減額・同居要件・家なき子特例' },

  { persona: 'inheritance_client', category: '相続', quality: 'standard',
    title: '相続税の申告期限と手続きの流れ｜10ヶ月以内にやるべきことチェックリスト',
    slug: 'inheritance-tax-filing-deadline-checklist',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm',
    source_title: '国税庁タックスアンサー No.4205 相続税の申告と納税',
    hint: '死亡日から10ヶ月・準確定申告4ヶ月・遺産分割協議の期限' },

  { persona: 'inheritance_client', category: '相続', quality: 'high',
    title: '相続税の配偶者控除（配偶者の税額軽減）とは？1億6千万円まで非課税の条件',
    slug: 'inheritance-spouse-tax-reduction',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4158.htm',
    source_title: '国税庁タックスアンサー No.4158 配偶者の税額の軽減',
    hint: '法定相続分or1億6000万円の大きい方まで非課税・申告要件' },

  { persona: 'inheritance_client', category: '相続', quality: 'high',
    title: '親から子への住宅資金贈与で非課税になる条件｜贈与税の特例を活用する方法',
    slug: 'housing-fund-gift-tax-exemption',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4508.htm',
    source_title: '国税庁タックスアンサー No.4508 直系尊属から住宅取得等資金の贈与を受けた場合の非課税',
    hint: '省エネ住宅1000万円・一般住宅500万円の非課税枠・適用条件' },
];

module.exports = { TOPICS };
