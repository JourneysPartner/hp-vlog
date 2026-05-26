'use strict';

/**
 * 国税庁タックスアンサー / 公式情報の参照カタログ。
 *
 * 位置づけ:
 *   - 「必ず使う」ではなく「必要な場合に優先して参考にする」
 *   - generate-draft.js のプロンプトに `relevantRefs` として渡され、
 *     LLM がトピックに応じて適切なものを引用できるようにする
 *   - tax_domain ごとに整理し、テーマの cluster / category と紐付ける
 *
 * URL は変更されにくい代表的なタックスアンサー番号と国税庁のセクションのみ。
 * 不確かな番号は登録しない（捏造防止）。
 */

const REFS = {
  consumption_tax: [
    { no: '6451', title: '仕入税額控除の対象範囲',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6451.htm' },
    { no: '6501', title: '納税義務の免除',                   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm' },
    { no: '6505', title: '簡易課税制度',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm' },
    { no: '6551', title: '輸出取引の免税',                   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
    { no: '6253', title: '免税事業者からの仕入れに係る経過措置', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6253.htm' },
  ],

  income_tax: [
    { no: '1191', title: '配偶者控除',                       url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm' },
    { no: '1350', title: '事業所得の課税のしくみ',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
    { no: '1900', title: '給与所得者で確定申告が必要な人',   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm' },
    { no: '1906', title: '給与所得者がネットオークション等で副収入', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1906.htm' },
    { no: '2070', title: '青色申告制度',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm' },
    { no: '2075', title: '専従者給与と専従者控除',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm' },
    { no: '2080', title: '白色申告者の記帳・帳簿等の保存',   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2080.htm' },
    { no: '2200', title: '収入金額とその計算',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm' },
    { no: '2210', title: 'やさしい必要経費の知識',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm' },
    { no: '2100', title: '減価償却のあらまし',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm' },
    { no: '2260', title: '所得税の税率',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm' },
  ],

  invoice_system: [
    { title: 'インボイス制度の概要',           url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm' },
    { title: '適格請求書発行事業者公表サイト', url: 'https://www.invoice-kohyo.nta.go.jp/' },
    { no: '6253', title: '免税事業者からの仕入れに係る経過措置', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6253.htm' },
  ],

  bookkeeping_expenses: [
    { no: '2080', title: '白色申告者の記帳・帳簿等の保存',   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2080.htm' },
    { no: '2210', title: 'やさしい必要経費の知識',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm' },
    { title: '電子帳簿保存法の概要',                         url: 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/index.htm' },
  ],

  inheritance_tax: [
    { no: '4152', title: '相続税の計算',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm' },
    { no: '4124', title: '小規模宅地等の特例',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm' },
    { no: '4158', title: '配偶者の税額の軽減',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4158.htm' },
    { no: '4205', title: '相続税の申告と納税',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm' },
    { no: '4408', title: '贈与税の計算と税率',               url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm' },
    { no: '4508', title: '直系尊属から住宅取得等資金の贈与を受けた場合の非課税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4508.htm' },
    { no: '4103', title: '相続時精算課税の選択',             url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm' },
  ],

  overseas_transactions: [
    { no: '6551', title: '輸出取引の免税',                   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
    { no: '1920', title: '海外転勤と所得税',                 url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1920.htm' },
  ],

  withholding: [
    { no: '2792', title: '源泉徴収が必要な報酬・料金',       url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm' },
  ],
};

/**
 * tax_domain と任意の cluster / category から、関連するレファレンスを返す。
 * 上限件数を持たせて、プロンプトの肥大化を防ぐ。
 */
function getRefsForTopic(topic, limit = 4) {
  const taxDomain = topic.tax_domain;
  const refs = [];

  if (taxDomain && REFS[taxDomain]) {
    refs.push(...REFS[taxDomain]);
  }

  // インボイスは消費税まわりとも関連性が高いので追加サジェスト
  if (topic.category === '消費税' && taxDomain !== 'invoice_system' && REFS.invoice_system) {
    refs.push(...REFS.invoice_system.slice(0, 1));
  }
  // 海外取引と消費税の還付論点は併用されやすい
  if (taxDomain === 'overseas_transactions' && REFS.consumption_tax) {
    refs.push(REFS.consumption_tax.find(r => r.no === '6551'));
  }

  // 重複除去
  const unique = [];
  const seen = new Set();
  for (const r of refs) {
    if (!r || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    unique.push(r);
    if (unique.length >= limit) break;
  }

  return unique;
}

function formatRefsForPrompt(refs) {
  if (!refs || refs.length === 0) return '';
  return refs.map(r => {
    if (r.no) return `- 国税庁タックスアンサー No.${r.no}「${r.title}」（${r.url}）`;
    return `- ${r.title}（${r.url}）`;
  }).join('\n');
}

// ── tax_domain / pain_point → 自動 source mapping ─────────────────
// シナリオ展開で source_url 未指定のトピックに「最低限の出典」を必ず付ける。
// validate.js は approved/scheduled/published で source_url 空欄を ERROR にするため、
// 生成記事が必ず source_url を持つようにここで fallback を提供する。
const DEFAULT_SOURCE_BY_TAX_DOMAIN = {
  consumption_tax:        { no: '6501', title: '国税庁タックスアンサー No.6501 納税義務の免除',  url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm' },
  income_tax:             { no: '1350', title: '国税庁タックスアンサー No.1350 事業所得の課税のしくみ', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
  invoice_system:         {              title: '国税庁 インボイス制度の概要',                       url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm' },
  bookkeeping_expenses:   { no: '2210', title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm' },
  inheritance_tax:        { no: '4152', title: '国税庁タックスアンサー No.4152 相続税の計算',         url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm' },
  overseas_transactions:  { no: '6551', title: '国税庁タックスアンサー No.6551 輸出取引の免税',       url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
  withholding:            { no: '2792', title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm' },
};

// pain_point 別の優先 source（より具体的に出典を当てたい場合）
const DEFAULT_SOURCE_BY_PAIN = {
  'small-residential-land':    { no: '4124', title: '国税庁タックスアンサー No.4124 相続した事業の用や居住の用の宅地等の価額の特例', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm' },
  'spouse-reduction':          { no: '4158', title: '国税庁タックスアンサー No.4158 配偶者の税額の軽減', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4158.htm' },
  'second-inheritance-loss':   { no: '4158', title: '国税庁タックスアンサー No.4158 配偶者の税額の軽減', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4158.htm' },
  'deadline-pressure':         { no: '4205', title: '国税庁タックスアンサー No.4205 相続税の申告と納税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm' },
  'tax-applicable-or-not':     { no: '4152', title: '国税庁タックスアンサー No.4152 相続税の計算', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm' },
  'lifetime-gift-addback':     { no: '4408', title: '国税庁タックスアンサー No.4408 贈与税の計算と税率', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm' },
  'life-insurance-exemption':  { no: '4114', title: '国税庁タックスアンサー No.4114 相続税の課税対象になる死亡保険金', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4114.htm' },
  'funeral-debt-deduction':    { no: '4129', title: '国税庁タックスアンサー No.4129 相続財産から控除できる債務', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4129.htm' },
  'real-estate-valuation':     { no: '4602', title: '国税庁タックスアンサー No.4602 土地家屋の評価', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4602.htm' },
  'rental-property-treatment': { no: '4614', title: '国税庁タックスアンサー No.4614 貸家建付地の評価', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4614.htm' },
  'company-shares-valuation':  { no: '4638', title: '国税庁タックスアンサー No.4638 取引相場のない株式の評価', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm' },
  'consumption-tax-judgement': { no: '6501', title: '国税庁タックスアンサー No.6501 納税義務の免除',  url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm' },
  'invoice-judgement':         {              title: '国税庁 インボイス制度の概要',                       url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm' },
  'tax-refund-eligibility':    { no: '6551', title: '国税庁タックスアンサー No.6551 輸出取引の免税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
  'overseas-tax-uncertain':    { no: '6551', title: '国税庁タックスアンサー No.6551 輸出取引の免税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
  'incorporation-threshold':   { no: '2260', title: '国税庁タックスアンサー No.2260 所得税の税率', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm' },
  'income-classification':     { no: '1350', title: '国税庁タックスアンサー No.1350 事業所得の課税のしくみ', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
  'family-employment':         { no: '2075', title: '国税庁タックスアンサー No.2075 専従者給与と専従者控除', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm' },
  'withholding-treatment':     { no: '2792', title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm' },
};

// ── 最終フォールバック（どこにもマッチしなかった場合）
const ULTIMATE_FALLBACK = {
  title: '国税庁ホームページ',
  url:   'https://www.nta.go.jp/',
};

/**
 * トピックに source_url / source_title が未設定の場合に、
 * tax_domain → pain_point の順で適切なデフォルト出典を返す。
 * 必ず非空の { url, title } を返す（最終フォールバックは国税庁トップ）。
 */
function getDefaultSourceForTopic(topic) {
  const painId    = topic.pain_point || topic.pain || '';
  const taxDomain = topic.tax_domain || '';

  if (painId && DEFAULT_SOURCE_BY_PAIN[painId]) {
    const r = DEFAULT_SOURCE_BY_PAIN[painId];
    return { url: r.url, title: r.title };
  }
  if (taxDomain && DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain]) {
    const r = DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain];
    return { url: r.url, title: r.title };
  }
  return { url: ULTIMATE_FALLBACK.url, title: ULTIMATE_FALLBACK.title };
}

// ── 番号 → URL 解決（カタログ優先 / 未収録は番号レンジから推定）─────
// 国税庁タックスアンサーの URL 構造は番号レンジでセクションがほぼ決まるため、
// カタログ未収録の番号もベストエフォートで URL を構築する。
// 後で人手でカタログに追加すれば、以降の記事では確定マッピングで使われる。
const NTA_URL_PREFIX_RULES = [
  // gensen（源泉徴収）— 27xx の一部（279x など）
  { match: /^(2790|2791|2792|2793|2794|2795|2796|2797|2798|2799)$/, section: 'gensen' },
  // hyoka（財産評価）— 46xx
  { match: /^46\d\d$/, section: 'hyoka' },
  // sozoku（相続税）— 41xx / 42xx / 43xx
  { match: /^4[123]\d\d$/, section: 'sozoku' },
  // zoyo（贈与税）— 44xx / 45xx
  { match: /^4[45]\d\d$/, section: 'zoyo' },
  // shotoku（所得税）— 1xxx / 20xx-26xx / 28xx-29xx 等
  { match: /^1\d{3}$/, section: 'shotoku' },
  { match: /^2[0-6]\d\d$/, section: 'shotoku' },
  { match: /^2[89]\d\d$/, section: 'shotoku' },
  // shohi（消費税）— 64xx / 65xx / 66xx
  { match: /^6[456]\d\d$/, section: 'shohi' },
  // hojin（法人税）— 54xx 等
  { match: /^54\d\d$/, section: 'hojin' },
];

function buildCatalogIndex() {
  const idx = {};  // number(string) → { url, title, section }
  for (const list of Object.values(REFS)) {
    for (const r of list) {
      if (r.no && r.url) idx[r.no] = { url: r.url, title: r.title, fromCatalog: true };
    }
  }
  return idx;
}
let _catalogIdxCache = null;
function catalogIndex() {
  if (!_catalogIdxCache) _catalogIdxCache = buildCatalogIndex();
  return _catalogIdxCache;
}

/**
 * 国税庁タックスアンサー番号 → URL を解決する。
 * 戻り値: { url, title?, fromCatalog: boolean, guessed: boolean } or null
 * - カタログ収録の番号: 確定 URL + title を返す
 * - 未収録だがレンジ推定できる番号: 推定 URL を返す（title 無し）
 * - レンジ外: null
 */
function resolveNtaUrlByNumber(no) {
  const n = String(no);
  const cat = catalogIndex();
  if (cat[n]) {
    return { url: cat[n].url, title: cat[n].title, fromCatalog: true, guessed: false };
  }
  for (const rule of NTA_URL_PREFIX_RULES) {
    if (rule.match.test(n)) {
      return {
        url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${rule.section}/${n}.htm`,
        fromCatalog: false,
        guessed: true,
      };
    }
  }
  return null;
}

module.exports = {
  REFS,
  getRefsForTopic,
  formatRefsForPrompt,
  getDefaultSourceForTopic,
  DEFAULT_SOURCE_BY_TAX_DOMAIN,
  DEFAULT_SOURCE_BY_PAIN,
  resolveNtaUrlByNumber,
  NTA_URL_PREFIX_RULES,
};
