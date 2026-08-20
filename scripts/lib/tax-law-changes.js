'use strict';

/**
 * 近年の税法改正・制度変更の論点カタログ。
 *
 * 位置づけ:
 *   - 「ニュース性だけで記事化しない」が大原則
 *   - ただし、各分野で読者の実務に影響する近年の改正論点は記事候補として持っておく
 *   - generate-draft.js から getChangesForTopic() で参照し、税目とペルソナが
 *     一致する改正論点をプロンプトに渡す（通常生成・差し戻し再生成の両方）
 *   - 以前は topic.freshness_sensitive が真のトピックにしか渡していなかったが、
 *     フラグが立っているのは 1,800 件中 10 件（1%）だけで、99% のトピックでは
 *     この経路が機能していなかったため、2026-08-18 にフラグ判定を廃止した
 *   - プロンプトに渡し、執筆時に「現在の制度」「近年の変更点」が混同されないよう案内する
 *
 * 各エントリは:
 *   key:       内部識別子
 *   title:     プロンプトに渡す論点名
 *   summary:   何が変わったか（プロンプト用の短い説明）
 *   tax_domain: 影響を受ける税目
 *   personas:  影響を受けるペルソナ
 *   reference: 主たる根拠 URL
 */

/**
 * 各エントリの活性度メタ:
 *   status:
 *     'active'              — 現役で検索価値が高い（プロンプトに含めてよい）
 *     'transitional'        — 経過措置中で実務影響あり（含めてよい）
 *     'historical_reference' — 過去の重要論点だが通常記事には不要（含めない）
 *     'expired'              — 期限切れ（通常記事から完全除外）
 *   valid_to: 期限がある場合の終了日（ISO）。current date > valid_to なら参照対象から外す。
 *
 * 注: status='historical_reference' / 'expired' のものは getChangesForTopic で返さない。
 *     定額減税は令和6年（2024年）限定 → expired 扱い。
 */
const CHANGES = [
  // ── 令和8年度税制改正（令和7年12月26日閣議決定の大綱／国税庁の改正の概要）──
  // 2026-08-20 に大綱・改正の概要の原文で確認して一括登録した。
  // 国税庁のタックスアンサーは672件中665件が「令和7年4月1日現在法令等」のままで、
  // 令和8年度改正がほとんど反映されていない。出典どおりに書くと古い内容になるため、
  // 改正論点として明示的に持っておく。
  {
    key: 'r8_basic_deduction_and_dependent_threshold',
    status: 'active',
    title: '基礎控除の引上げと、扶養・同一生計配偶者の所得要件の引上げ（令和8年分以後）',
    summary: '令和8年度税制改正で、合計所得金額2,350万円以下の個人の基礎控除が62万円に引き上げられた'
      + '（大綱「合計所得金額が2,350万円以下である個人 62万円」）。'
      + 'これに伴い「同一生計配偶者及び扶養親族の合計所得金額要件を62万円以下（現行：58万円以下）に引き上げる」'
      + 'とされ、令和8年分以後の所得税について適用される。'
      + '扶養に入れるかどうかの所得ラインは、令和7年分は58万円、令和8年分以後は62万円になる。'
      + '「令和7年分以後は58万円」とだけ書くと令和8年分について誤りになるので注意すること。'
      + 'なお配偶者特別控除の範囲（58万円超133万円以下）については大綱に記載が無いため、'
      + '確認できない範囲を推測で書かないこと。',
    tax_domain: 'income_tax',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator',
      'beauty_salon_owner', 'ebay_export_seller'],
    reference: 'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_01.htm',
  },
  {
    key: 'r8_employment_income_deduction',
    status: 'active',
    title: '給与所得控除の最低保障額の引上げ（65万円→69万円・令和8年分以後）',
    summary: '大綱「給与所得控除について、65万円の最低保障額を69万円に引き上げる」。令和8年分以後の所得税について適用。'
      + 'さらに「令和8年及び令和9年における給与所得控除の最低保障額を5万円引き上げる特例」が創設された。'
      + '給与所得者のいわゆる「103万円の壁」の計算根拠（給与所得控除の最低保障額＋基礎控除）が変わるため、'
      + '古い数値のまま壁の金額を書かないこと。個人事業主は給与所得控除の対象外である点は従来どおり。',
    tax_domain: 'income_tax',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator',
      'beauty_salon_owner', 'ebay_export_seller'],
    reference: 'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_01.htm',
  },
  {
    key: 'r8_small_depreciable_assets',
    status: 'active',
    title: '少額減価償却資産の特例の拡充・延長（30万円未満→40万円未満・3年延長）',
    summary: '国税庁の改正の概要「令和8年4月1日以後に取得等をする減価償却資産の取得価額基準が30万円未満のものから'
      + '40万円未満のものに引き上げられ、その適用期限が3年延長されました（措法67の5①、改正法附則65）」。'
      + '取得価額基準は「取得等をする日」で判定する（令和8年3月31日以前は30万円未満、同年4月1日以後は40万円未満）。'
      + '年300万円の上限は据え置き。大綱に「（所得税についても同様とする。）」とあり個人事業者にも適用される。'
      + 'タックスアンサー No.2100 / No.5408 は令和7年4月1日現在法令等のままで未反映のため、'
      + 'その記載をそのまま書き写すと「令和8年3月31日まで・30万円未満」という失効済みの内容になる。',
    tax_domain: 'bookkeeping_expenses',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator',
      'beauty_salon_owner', 'ebay_export_seller'],
    reference: 'https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2026/pdf/G.pdf',
  },
  {
    key: 'r8_invoice_30pct_special',
    status: 'active',
    title: 'インボイスの3割特例の創設（個人事業者・令和9年分と令和10年分）',
    summary: '令和8年度税制改正で、インボイス発行事業者の登録により免税事業者から課税事業者となった個人事業者について、'
      + '令和9年分・令和10年分の消費税の納付税額を売上税額の3割とできる特例が創設された。法人は適用不可。'
      + '2割特例は令和8年9月30日までの日の属する課税期間で終了する（個人事業者は令和8年分が最後）。'
      + '「2割特例が終わったら簡易課税か本則課税だけ」と書かないこと。'
      + '3割特例は事前の届出不要で、申告書の所定欄に適用を受ける旨を記載するだけで適用できる。',
    tax_domain: 'invoice_system',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator',
      'beauty_salon_owner', 'ebay_export_seller'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm',
  },
  {
    key: 'r8_education_fund_gift_end',
    status: 'transitional',
    valid_to: '2026-03-31',
    title: '教育資金の一括贈与の非課税措置が令和8年3月31日で終了（延長されない）',
    summary: '大綱「直系尊属から教育資金の一括贈与を受けた場合の贈与税の非課税措置について、'
      + '令和8年3月31日までとされている教育資金管理契約に基づく信託等可能期間を延長せずに終了することとし、'
      + '同日までに拠出された金銭等については、引き続き本措置を適用できることとする」。'
      + '新たに契約して非課税の適用を受けることはできなくなるが、同日までに拠出済みのものは引き続き適用される。'
      + '「今から使える制度」として書かないこと。',
    tax_domain: 'inheritance_tax',
    personas: ['inheritance_client'],
    reference: 'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_02.htm',
  },
  {
    key: 'invoice_transitional_measures',
    status: 'transitional',
    valid_to: '2031-09-30',
    title: 'インボイス制度の経過措置（80%→70%→50%→30%→0%の縮小スケジュール・令和8年改正で延長）',
    summary: '免税事業者からの仕入れに係る経過措置は令和8年度税制改正で2年延長され、70%区分が新設された。80%(2023.10〜2026.9)／70%(2026.10〜2028.9)／50%(2028.10〜2030.9)／30%(2030.10〜2031.9)／0%(2031.10〜)。旧「50%(2026.10〜2029.9)」は誤り。読者の事業区分・取引相手によって影響時期が異なる。',
    tax_domain: 'invoice_system',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6253.htm',
  },
  {
    key: 'invoice_2wari_special',
    status: 'transitional',
    valid_to: '2026-09-30',
    title: 'インボイス登録した小規模事業者向けの 2 割特例',
    summary: '免税事業者がインボイス登録した場合、納税額を売上税額の2割にできる特例。期間限定（令和5年10月1日〜令和8年9月30日属する課税期間まで）。対象は基準期間の課税売上1000万円以下等。',
    tax_domain: 'invoice_system',
    personas: ['reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner', 'domestic_ec_seller'],
    reference: 'https://www.nta.go.jp/publication/pamph/shohi/01.htm',
  },
  {
    key: 'electronic_bookkeeping_law',
    status: 'active',
    valid_to: '',
    title: '電子帳簿保存法（電子取引データの保存義務）',
    summary: '2024年1月から、電子取引（メール添付請求書・ECモール明細等）で受領したデータは電子保存が義務化。改ざん防止要件・検索要件を満たす必要がある。猶予措置はあるが整備が前提。',
    tax_domain: 'bookkeeping_expenses',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'beauty_salon_owner', 'ebay_export_seller', 'influencer_creator'],
    reference: 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/index.htm',
  },
  {
    key: 'gift_tax_seven_year_addback',
    status: 'active',
    valid_to: '',
    title: '生前贈与の相続財産加算が 3 年→ 7 年に拡大',
    summary: '令和6年（2024年）以降の贈与から、相続開始前 7 年以内の暦年贈与が相続財産に加算される（段階適用）。延長分の100万円控除はあるが、暦年贈与プランは見直しが必要。',
    tax_domain: 'inheritance_tax',
    personas: ['inheritance_client'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
  },
  {
    key: 'inheritance_settlement_basic_deduction',
    status: 'active',
    valid_to: '',
    title: '相続時精算課税制度の基礎控除（年110万円）創設',
    summary: '令和6年から、相続時精算課税を選択していても年110万円までの贈与は申告不要・相続時加算なし。暦年贈与との併用設計が変わった。',
    tax_domain: 'inheritance_tax',
    personas: ['inheritance_client'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm',
  },
  {
    key: 'fixed_amount_tax_reduction',
    status: 'expired',
    valid_to: '2024-12-31',
    title: '定額減税（令和6年分の所得税・住民税）',
    summary: '令和6年分限定の単年制度。2025年以降は通常記事として扱わない（過去制度の振り返り記事を書く場合のみ historical_reference として参照可能）。',
    tax_domain: 'income_tax',
    personas: ['beauty_salon_owner', 'influencer_creator', 'domestic_ec_seller'],
    reference: 'https://www.nta.go.jp/users/gensen/teigakugenzei/index.htm',
  },
];

function isChangeStillRelevant(change, now = new Date()) {
  if (change.status === 'expired' || change.status === 'historical_reference') return false;
  if (change.valid_to) {
    const vt = new Date(change.valid_to);
    if (!isNaN(vt) && vt < now) return false;
  }
  return true;
}

// このカタログが知っているペルソナの語彙。
// CHANGES の personas に一度も出てこないペルソナは「未知」とみなす。
const KNOWN_PERSONAS = new Set(CHANGES.flatMap(c => c.personas || []));

/**
 * 候補トピックに該当する改正論点を返す（ペルソナ × tax_domain で照合）。
 * status='expired' / 'historical_reference' のものは自動的に除外する。
 *
 * ペルソナ照合は「知っているペルソナのときだけ」効かせる。
 *
 * 2026-08-18: 新セグメント（youtuber / content_seller / construction_solo /
 * retail_store / wholesale）のペルソナ名が、このカタログの語彙
 * （domestic_ec_seller / influencer_creator / beauty_salon_owner 等）と
 * 全く重なっておらず、新セグメントの記事には改正論点が1件も渡っていなかった。
 * ペルソナを厳格に照合すると、カタログ側に追記し忘れた瞬間に
 * 「黙って何も出ない」状態になり、それに気付けない。
 * → 未知のペルソナのときは tax_domain だけで照合する。
 *   税目が一致していれば、その改正はそのテーマに関係があるため。
 */
function getChangesForTopic(topic, limit = 2, now = new Date()) {
  const persona  = topic.persona || topic.primary_persona;
  const taxDomain = topic.tax_domain;
  const personaKnown = persona ? KNOWN_PERSONAS.has(persona) : false;
  const matches = CHANGES.filter(c => {
    if (!isChangeStillRelevant(c, now)) return false;
    const personaMatch = personaKnown ? c.personas.includes(persona) : true;
    const domainMatch  = taxDomain ? c.tax_domain === taxDomain : true;
    return personaMatch && domainMatch;
  });
  return matches.slice(0, limit);
}

function formatChangesForPrompt(changes) {
  if (!changes || changes.length === 0) return '';
  return changes.map(c => `- ${c.title}\n  概要: ${c.summary}\n  根拠: ${c.reference}`).join('\n');
}

module.exports = {
  CHANGES,
  getChangesForTopic,
  formatChangesForPrompt,
  isChangeStillRelevant,
};
