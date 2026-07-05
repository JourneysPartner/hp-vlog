'use strict';

/**
 * 新カテゴリ（Phase 4）のトピック生成
 *
 * YouTuber / コンテンツ販売 / 1人親方 / 小売 / 卸売 の「実際の取引・生活実務」
 * を起点に、優先テーマを本命+補強のペアで展開する。
 *
 * 設計方針:
 *   - 1 テーマ = 1 実務の悩み。税目起点ではなく読者の実務起点。
 *   - 各 topic に customer_segment と allowed_customer_segments=[そのカテゴリ] を
 *     付与し、関連性ゲート（customer-relevance）で他業種に流用されないようにする。
 *   - 出典は tax_domain ベースの確実なもの（getDefaultSourceForTopic）を割り当て、
 *     出典一致ゲート（source-alignment）に通る形にする。番号を捏造しない。
 */

const { getDefaultSourceForTopic } = require('./tax-authority-refs');

// category（日本語表示）は税目から素直に導く
const CATEGORY_BY_DOMAIN = {
  income_tax: '所得税',
  consumption_tax: '消費税',
  bookkeeping_expenses: '帳簿・経費',
  invoice_system: 'インボイス',
  withholding: '所得税',
};

// ── カテゴリ別の優先テーマ ─────────────────────────────────────
// theme: { id(=pain_point), tax_domain, topic, q, intent, reader, success }
const SEGMENTS = {
  youtuber: {
    persona: 'youtuber', macro: 'YouTube',
    themes: [
      { id: 'youtube-adsense-revenue', tax_domain: 'income_tax',
        topic: 'YouTube広告（AdSense）収益の売上計上と確定申告',
        q: 'YouTubeのAdSense収益はいつ・どう売上計上して確定申告する？',
        intent: 'YouTube AdSense 収益 確定申告 売上計上 タイミング',
        reader: 'AdSense収益の計上時期と確定申告の要否が分からない',
        success: 'AdSense収益の計上時期と申告の進め方が具体的に分かる' },
      { id: 'youtube-superchat', tax_domain: 'income_tax',
        topic: 'スーパーチャット・メンバーシップ収益の税務処理',
        q: 'スーパーチャットやメンバーシップ収益はどう申告する？',
        intent: 'YouTube スーパーチャット メンバーシップ 収入 確定申告',
        reader: '投げ銭・会員収入の所得区分と計上方法が不安',
        success: '投げ銭・会員収入の所得区分と計上方法が分かる' },
      { id: 'youtube-equipment-expense', tax_domain: 'bookkeeping_expenses',
        topic: 'YouTuberの機材費（カメラ・PC・マイク等）の経費と減価償却',
        q: 'YouTuberの機材費は経費になる？減価償却は必要？',
        intent: 'YouTuber 機材費 経費 カメラ パソコン 減価償却',
        reader: '高額機材が一括経費か減価償却か分からない',
        success: '機材費の経費計上と減価償却の判断ができる' },
      { id: 'youtube-editing-outsource', tax_domain: 'withholding',
        topic: '動画編集の外注費の仕訳と源泉徴収',
        q: '動画編集を外注したときの仕訳と源泉徴収はどうする？',
        intent: 'YouTube 動画編集 外注費 源泉徴収 仕訳',
        reader: '編集外注費の勘定科目と源泉の要否が分からない',
        success: '編集外注費の仕訳と源泉徴収の要否が判断できる' },
      { id: 'youtube-sponsorship-withholding', tax_domain: 'withholding',
        topic: '企業案件（タイアップ）の源泉徴収と確定申告',
        q: 'YouTubeの企業案件で源泉徴収されている場合の確定申告は？',
        intent: 'YouTube 企業案件 源泉徴収 確定申告',
        reader: '源泉済みの企業案件報酬の申告方法が分からない',
        success: '源泉済み報酬の申告と精算の流れが分かる' },
      { id: 'youtube-travel-expense', tax_domain: 'bookkeeping_expenses',
        topic: '撮影旅行・ロケ費用の経費判断',
        q: 'YouTuberの撮影旅行は経費になる？旅費交通費の考え方',
        intent: 'YouTuber 撮影旅行 経費 旅費交通費',
        reader: 'プライベートと兼ねる撮影旅行の経費範囲が不安',
        success: '撮影旅行の経費範囲と証拠の残し方が分かる' },
      { id: 'youtube-home-office', tax_domain: 'bookkeeping_expenses',
        topic: '自宅兼スタジオの家賃・光熱費の家事按分',
        q: 'YouTuberの自宅家賃・光熱費はどこまで経費にできる？',
        intent: 'YouTuber 自宅 家賃 光熱費 家事按分 経費',
        reader: '自宅撮影の家賃・光熱費の按分方法が分からない',
        success: '家事按分の考え方と合理的な割合の出し方が分かる' },
      { id: 'youtube-invoice', tax_domain: 'invoice_system',
        topic: 'YouTuberのインボイス登録判断',
        q: 'YouTuberはインボイス登録すべき？判断のポイント',
        intent: 'YouTuber インボイス 登録 すべきか',
        reader: '企業案件先との関係でインボイス登録が必要か迷う',
        success: 'インボイス登録の要否を自分のケースで判断できる' },
    ],
  },

  content_seller: {
    persona: 'content_seller', macro: 'コンテンツ販売',
    themes: [
      { id: 'content-note-revenue', tax_domain: 'income_tax',
        topic: 'note・Brain・Tips 収益の売上計上と確定申告',
        q: 'noteやBrainの収益は確定申告が必要？売上計上はいつ？',
        intent: 'note Brain 収益 確定申告 売上計上',
        reader: 'デジタルコンテンツ収益の計上時期と申告要否が不安',
        success: 'コンテンツ収益の計上時期と申告の要否が分かる' },
      { id: 'content-online-course', tax_domain: 'income_tax',
        topic: 'オンライン講座の売上計上',
        q: 'オンライン講座の売上はいつ計上する？前受金の扱いは？',
        intent: 'オンライン講座 売上計上 前受金 税務',
        reader: '講座の入金時期と提供時期がずれる場合の処理が不安',
        success: '講座売上の計上時期と前受金の処理が分かる' },
      { id: 'content-subscription-revenue', tax_domain: 'income_tax',
        topic: 'サブスク型コンテンツ・オンラインサロン収入の税務処理',
        q: 'サブスク収入やオンラインサロン収入はどう申告する？',
        intent: 'サブスク コンテンツ オンラインサロン 収入 確定申告',
        reader: '継続課金収入の計上単位と経費が分からない',
        success: 'サブスク収入の計上と関連経費の考え方が分かる' },
      { id: 'content-platform-fee', tax_domain: 'consumption_tax',
        topic: 'プラットフォーム手数料・決済手数料の仕訳と消費税',
        q: 'コンテンツ販売の決済手数料はどう仕訳する？消費税は？',
        intent: 'コンテンツ販売 決済手数料 プラットフォーム手数料 仕訳',
        reader: '手数料差引後の入金の総額処理と消費税区分が不安',
        success: '手数料の総額計上と消費税区分の処理が分かる' },
      { id: 'content-digital-consumption-tax', tax_domain: 'consumption_tax',
        topic: 'デジタルコンテンツ販売の消費税',
        q: 'PDF教材やデジタルコンテンツ販売に消費税はかかる？',
        intent: 'デジタルコンテンツ PDF教材 消費税',
        reader: 'デジタル販売の消費税課税・免税の判断が分からない',
        success: 'デジタル販売の消費税の扱いが判断できる' },
      { id: 'content-refund-handling', tax_domain: 'income_tax',
        topic: 'コンテンツ販売で返金があった場合の処理',
        q: 'コンテンツ販売で返金したときの売上・仕訳はどうする？',
        intent: 'コンテンツ販売 返金 売上 仕訳 処理',
        reader: '返金時の売上取消と記帳方法が分からない',
        success: '返金時の売上調整と記帳の方法が分かる' },
      { id: 'content-invoice', tax_domain: 'invoice_system',
        topic: 'コンテンツ販売のインボイス対応',
        q: 'コンテンツ販売でインボイス登録は必要？',
        intent: 'コンテンツ販売 インボイス 登録 必要',
        reader: '個人向け販売中心でインボイス登録が必要か迷う',
        success: 'インボイス登録の要否を自分のケースで判断できる' },
    ],
  },

  construction_solo: {
    persona: 'construction_solo', macro: '建設',
    themes: [
      { id: 'construction-labor-cost', tax_domain: 'withholding',
        topic: '人工代は外注費か給与か（判定）',
        q: '1人親方の人工代は外注費？給与？判断のポイントは？',
        intent: '1人親方 人工代 外注費 給与 判定',
        reader: '応援人工への支払いが外注費か給与か分からない',
        success: '人工代の外注費・給与判定と源泉の要否が分かる' },
      { id: 'construction-material-cost', tax_domain: 'bookkeeping_expenses',
        topic: '材料費を立て替えた場合の仕訳',
        q: '材料費を立て替えたときの仕訳・請求はどうする？',
        intent: '建設 材料費 立替 仕訳 請求',
        reader: '材料立替と外注費・売上の区別が分からない',
        success: '材料費立替の仕訳と請求時の処理が分かる' },
      { id: 'construction-tools-expense', tax_domain: 'bookkeeping_expenses',
        topic: '工具・作業着・ガソリン代の経費判断',
        q: '工具・作業着・ガソリン代は経費になる？',
        intent: '1人親方 工具 作業着 ガソリン代 経費',
        reader: '現場で使う道具や消耗品の経費範囲が不安',
        success: '工具・作業着・燃料費の経費計上の判断ができる' },
      { id: 'construction-invoice', tax_domain: 'invoice_system',
        topic: '1人親方とインボイス制度',
        q: '1人親方はインボイス登録すべき？元請けとの関係は？',
        intent: '1人親方 インボイス 登録 元請け',
        reader: '元請けからの要請でインボイス登録が必要か迷う',
        success: 'インボイス登録の要否と経過措置の影響が分かる' },
      { id: 'construction-withholding-received', tax_domain: 'withholding',
        topic: '元請けから源泉徴収された場合の処理',
        q: '元請けから源泉徴収されたときの確定申告はどうする？',
        intent: '1人親方 元請け 源泉徴収 確定申告',
        reader: '源泉された報酬の申告・精算の方法が分からない',
        success: '源泉済み報酬の申告と還付の流れが分かる' },
      { id: 'construction-vehicle-expense', tax_domain: 'bookkeeping_expenses',
        topic: '車両費・ガソリン代の家事按分',
        q: '1人親方の車両費・ガソリン代はどこまで経費にできる？',
        intent: '1人親方 車両費 ガソリン代 家事按分',
        reader: '事業用とプライベート兼用の車の按分が分からない',
        success: '車両費の家事按分の考え方が分かる' },
      { id: 'construction-bookkeeping', tax_domain: 'bookkeeping_expenses',
        topic: '1人親方の確定申告で必要な帳簿',
        q: '1人親方の確定申告に必要な帳簿・書類は？',
        intent: '1人親方 確定申告 帳簿 必要書類',
        reader: '記帳や保存書類の準備が分からない',
        success: '必要な帳簿・保存書類と記帳の基本が分かる' },
    ],
  },

  retail_store: {
    persona: 'retail_store', macro: '小売',
    themes: [
      { id: 'retail-register-sales', tax_domain: 'bookkeeping_expenses',
        topic: 'レジ売上の仕訳と現金管理',
        q: '小売店のレジ売上はどう仕訳する？現金過不足の処理は？',
        intent: '小売店 レジ売上 仕訳 現金管理 現金過不足',
        reader: '現金売上・クレカ売上の記帳とレジ締めが不安',
        success: 'レジ売上の仕訳と現金過不足の処理が分かる' },
      { id: 'retail-reduced-tax-rate', tax_domain: 'consumption_tax',
        topic: '食品小売の軽減税率と消費税区分',
        q: '食品小売の軽減税率（8%/10%）はどう区分する？',
        intent: '小売店 食品 軽減税率 消費税 区分',
        reader: 'イートイン・テイクアウトの税率区分が分からない',
        success: '軽減税率の区分と帳簿・レシートの要件が分かる' },
      { id: 'retail-inventory-count', tax_domain: 'bookkeeping_expenses',
        topic: '棚卸をしないとどうなる？在庫と売上原価',
        q: '小売店で棚卸をしないと税務上どうなる？',
        intent: '小売店 棚卸 在庫 売上原価 しない',
        reader: '棚卸の要否と売上原価への影響が分からない',
        success: '棚卸の必要性と売上原価計算の基本が分かる' },
      { id: 'retail-point-discount', tax_domain: 'consumption_tax',
        topic: 'ポイント利用・値引きがある場合の仕訳',
        q: 'ポイント利用や値引きがある売上はどう仕訳する？',
        intent: '小売店 ポイント 値引き 仕訳 消費税',
        reader: 'ポイント値引き時の売上・消費税の扱いが不安',
        success: 'ポイント・値引きの売上計上と消費税区分が分かる' },
      { id: 'retail-return-handling', tax_domain: 'consumption_tax',
        topic: '仕入返品・売上返品の処理',
        q: '仕入返品・売上返品があったときの処理は？',
        intent: '小売店 仕入返品 売上返品 処理 消費税',
        reader: '返品時の売上・仕入と消費税の調整が分からない',
        success: '返品時の売上・仕入調整と消費税の処理が分かる' },
      { id: 'retail-qr-payment', tax_domain: 'bookkeeping_expenses',
        topic: 'QR決済売上の入金ズレの記帳',
        q: 'QR決済売上の入金が後日になる場合、どう記帳する？',
        intent: '小売店 QR決済 入金ズレ 記帳 売掛金',
        reader: '決済日と入金日がずれる売上の記帳が不安',
        success: 'キャッシュレス売上の売掛計上と入金消込が分かる' },
      { id: 'retail-invoice', tax_domain: 'invoice_system',
        topic: '小売店のインボイス制度で注意すべきこと',
        q: '小売店がインボイス制度で注意すべき点は？',
        intent: '小売店 インボイス 制度 注意点 適格簡易請求書',
        reader: 'レシート（適格簡易請求書）の要件が分からない',
        success: '適格簡易請求書の要件と対応が分かる' },
    ],
  },

  wholesale: {
    persona: 'wholesale', macro: '卸売',
    themes: [
      { id: 'wholesale-accounts-receivable', tax_domain: 'bookkeeping_expenses',
        topic: '売掛金・買掛金の管理と入金消込',
        q: '卸売業の売掛金・買掛金はどう管理する？入金消込が合わないときは？',
        intent: '卸売業 売掛金 買掛金 入金消込 管理',
        reader: '掛取引の売掛・買掛の管理と消込が不安',
        success: '掛取引の管理と入金消込の基本が分かる' },
      { id: 'wholesale-inventory-valuation', tax_domain: 'bookkeeping_expenses',
        topic: '棚卸と在庫評価',
        q: '卸売業の棚卸と在庫評価はどうする？',
        intent: '卸売業 棚卸 在庫評価 方法',
        reader: '在庫評価方法と棚卸の実務が分からない',
        success: '在庫評価の考え方と棚卸の実務が分かる' },
      { id: 'wholesale-invoice', tax_domain: 'invoice_system',
        topic: '卸売業のインボイス制度の注意点',
        q: '卸売業がインボイス制度で注意すべき点は？',
        intent: '卸売業 インボイス 制度 注意点 記載事項',
        reader: '請求書の記載事項や取引先対応が分からない',
        success: '適格請求書の記載事項と取引先対応が分かる' },
      { id: 'wholesale-return-rebate', tax_domain: 'consumption_tax',
        topic: '返品・値引き・リベートの仕訳',
        q: '卸売業の返品・値引き・リベートはどう仕訳する？',
        intent: '卸売業 返品 値引き リベート 仕訳 消費税',
        reader: 'リベートや値引きの売上・消費税の扱いが不安',
        success: '返品・値引き・リベートの処理と消費税区分が分かる' },
      { id: 'wholesale-closing-date-sales', tax_domain: 'income_tax',
        topic: '締日と入金日が違う場合の売上計上',
        q: '締日と入金日が違う場合、売上はいつ計上する？',
        intent: '卸売業 締日 入金日 売上計上 時期',
        reader: '締め請求と売上計上時期の関係が分からない',
        success: '売上計上時期（実現主義）の基本が分かる' },
      { id: 'wholesale-billing-omission', tax_domain: 'income_tax',
        topic: '請求漏れが見つかった場合の処理',
        q: '過去の請求漏れが見つかったときの税務処理は？',
        intent: '卸売業 請求漏れ 売上計上漏れ 修正',
        reader: '売上計上漏れの発見時の対応が分からない',
        success: '計上漏れの修正と申告への影響が分かる' },
    ],
  },
};

// 記事タイプ別の関連リンク文言（draft-normalizer と整合）
const SUPPORT_LINK_TEXT = '業種別の具体例はこちら';

function expandNewSegments() {
  const out = [];
  for (const [segment, def] of Object.entries(SEGMENTS)) {
    for (const th of def.themes) {
      const category = CATEGORY_BY_DOMAIN[th.tax_domain] || '帳簿・経費';
      const baseSlug = `newseg-${def.persona}-${th.id}`;
      const cluster = `newseg-${def.persona}`;
      const subcluster = `${th.tax_domain.replace(/_/g, '-')}-${th.id}`;
      const src = getDefaultSourceForTopic({ tax_domain: th.tax_domain, pain_point: th.id });
      const source_url = (src && src.url) || '';
      const source_title = (src && src.title) || '';

      const common = {
        title: '',
        category,
        persona: def.persona,
        customer_segment: segment,
        allowed_customer_segments: [segment],
        macro: def.macro,
        cluster,
        tax_domain: th.tax_domain,
        business_stage: '',
        life_stage: '',
        pain_point: th.id,
        procedure_stage: '',
        pair_group: baseSlug,
        source_url, source_title,
        reader_problem: th.reader,
      };

      // 本命（基本解説）
      out.push({
        ...common,
        slug: `${baseSlug}-guide`,
        subcluster,
        article_type: 'basic_explainer',
        article_role: 'main',
        search_intent: th.intent,
        success_outcome: th.success,
        primary_question: th.q,
        related_slug: `${baseSlug}-practice`,
        related_link_text: SUPPORT_LINK_TEXT,
      });
      // 補強（業種別具体例）
      out.push({
        ...common,
        slug: `${baseSlug}-practice`,
        subcluster: `${subcluster}-support`,
        article_type: 'industry_example',
        article_role: 'support',
        search_intent: `${th.intent}（具体例・仕訳）`,
        success_outcome: `${th.success}。具体的な仕訳・手順が分かる`,
        primary_question: `${th.q}（具体例で解説）`,
        related_slug: `${baseSlug}-guide`,
        related_link_text: '基本から確認したい方はこちら',
      });
    }
  }
  return out;
}

module.exports = { expandNewSegments, SEGMENTS };
