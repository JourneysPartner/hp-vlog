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
    { no: '1350', title: '事業所得の課税のしくみ',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
    { no: '1900', title: '給与所得者で確定申告が必要な人',   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm' },
    { no: '1906', title: '給与所得者がネットオークション等で副収入', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1906.htm' },
    { no: '2070', title: '青色申告制度',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm' },
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
    { no: '4503', title: '相続時精算課税の選択',             url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm' },
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

module.exports = {
  REFS,
  getRefsForTopic,
  formatRefsForPrompt,
};
