'use strict';

/**
 * 近年の税法改正・制度変更の論点カタログ。
 *
 * 位置づけ:
 *   - 「ニュース性だけで記事化しない」が大原則
 *   - ただし、各分野で読者の実務に影響する近年の改正論点は記事候補として持っておく
 *   - generate-draft.js の選定時に freshness_sensitive 判定の元情報として参照
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

const CHANGES = [
  {
    key: 'invoice_transitional_measures',
    title: 'インボイス制度の経過措置（80%・50%控除の縮小スケジュール）',
    summary: '2023年10月開始のインボイス制度では、免税事業者からの仕入につき経過措置（80%控除：2023.10〜2026.9 / 50%控除：2026.10〜2029.9）が設けられている。読者の事業区分・取引相手によって影響時期が異なる。',
    tax_domain: 'invoice_system',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6253.htm',
  },
  {
    key: 'invoice_2wari_special',
    title: 'インボイス登録した小規模事業者向けの 2 割特例',
    summary: '免税事業者がインボイス登録した場合、納税額を売上税額の2割にできる特例。期間限定（令和5年10月1日〜令和8年9月30日属する課税期間まで）。対象は基準期間の課税売上1000万円以下等。',
    tax_domain: 'invoice_system',
    personas: ['reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner', 'domestic_ec_seller'],
    reference: 'https://www.nta.go.jp/publication/pamph/shohi/01.htm',
  },
  {
    key: 'electronic_bookkeeping_law',
    title: '電子帳簿保存法（電子取引データの保存義務）',
    summary: '2024年1月から、電子取引（メール添付請求書・ECモール明細等）で受領したデータは電子保存が義務化。改ざん防止要件・検索要件を満たす必要がある。猶予措置はあるが整備が前提。',
    tax_domain: 'bookkeeping_expenses',
    personas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'beauty_salon_owner', 'ebay_export_seller', 'influencer_creator'],
    reference: 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/index.htm',
  },
  {
    key: 'gift_tax_seven_year_addback',
    title: '生前贈与の相続財産加算が 3 年→ 7 年に拡大',
    summary: '令和6年（2024年）以降の贈与から、相続開始前 7 年以内の暦年贈与が相続財産に加算される（段階適用）。延長分の100万円控除はあるが、暦年贈与プランは見直しが必要。',
    tax_domain: 'inheritance_tax',
    personas: ['inheritance_client'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
  },
  {
    key: 'inheritance_settlement_basic_deduction',
    title: '相続時精算課税制度の基礎控除（年110万円）創設',
    summary: '令和6年から、相続時精算課税を選択していても年110万円までの贈与は申告不要・相続時加算なし。暦年贈与との併用設計が変わった。',
    tax_domain: 'inheritance_tax',
    personas: ['inheritance_client'],
    reference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm',
  },
  {
    key: 'fixed_amount_tax_reduction',
    title: '定額減税（令和6年分の所得税・住民税）',
    summary: '令和6年分について、本人および同一生計配偶者・扶養親族 1 人につき所得税3万円・住民税1万円の定額減税。給与・年金・事業所得で扱いが異なる。事業者は従業員の月次減税事務にも影響。',
    tax_domain: 'income_tax',
    personas: ['beauty_salon_owner', 'influencer_creator', 'domestic_ec_seller'],
    reference: 'https://www.nta.go.jp/users/gensen/teigakugenzei/index.htm',
  },
];

/**
 * 候補トピックに該当する改正論点を返す（ペルソナ × tax_domain で照合）。
 */
function getChangesForTopic(topic, limit = 2) {
  const persona  = topic.persona || topic.primary_persona;
  const taxDomain = topic.tax_domain;
  const matches = CHANGES.filter(c => {
    const personaMatch = persona ? c.personas.includes(persona) : true;
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
};
