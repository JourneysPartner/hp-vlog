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
