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
    { no: '6502', title: '高額特定資産を取得した場合等の納税義務の免除等の特例', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6502.htm' },
    { no: '6505', title: '簡易課税制度',                     url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm' },
    { no: '6509', title: '簡易課税制度の事業区分',           url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6509.htm' },
    { no: '6551', title: '輸出取引の免税',                   url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
    { no: '6253', title: '免税事業者からの仕入れに係る経過措置', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6253.htm' },
    { no: '6102', title: '消費税の軽減税率制度',             url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6102.htm' },
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
    { no: '6498', title: '適格請求書等保存方式（インボイス制度）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm' },
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
 * tax_domain と任意の cluster / category / pain_point / subcluster から、
 * 関連するレファレンスを返す。記事が cross-domain な内容（例: 所得税の
 * 確定申告で消費税課税事業者判定にも触れる）の場合でも、本文中で具体数値が
 * 必要になる税目の refs を漏れなく渡すことを目的とする。
 *
 * 上限件数を持たせてプロンプト肥大化を防ぐ（既定 4 件）。
 */
function getRefsForTopic(topic, limit = 4) {
  const taxDomain = topic.tax_domain;
  // 優先順位ごとに別配列に積み、最後にマージして dedup + limit を適用する。
  // 上位ほど「この記事の本文で具体数値が必要になりやすい」refs を入れる。
  const priorityHigh = [];   // cross-domain で本文が触れそうな税目の refs（ハルシネーション対策）
  const priorityMid  = [];   // taxDomain の代表 refs
  const priorityLow  = [];   // taxDomain の補足 refs + その他サジェスト

  // ── ① Cross-domain refs（pain_point / cluster / subcluster から推定）─────
  // ハルシネーション事故の真因対策: 記事の本筋 tax_domain と違う税目の
  // 具体数値（みなし仕入率など）に本文で触れる場合、その税目の refs が
  // 渡らないと LLM が記憶頼りで誤った数値を書く。pain_point 等のシグナルから
  // 「触れそうな税目」を推定し、該当 refs を **最優先** で渡す。
  const xd = collectCrossDomainSignals(topic);

  if (xd.touchesConsumptionTax && taxDomain !== 'consumption_tax' && REFS.consumption_tax) {
    priorityHigh.push(
      REFS.consumption_tax.find(r => r.no === '6501'),  // 納税義務の免除
      REFS.consumption_tax.find(r => r.no === '6505'),  // 簡易課税制度（みなし仕入率）
    );
  }
  if (xd.touchesInvoice && taxDomain !== 'invoice_system' && REFS.invoice_system) {
    priorityHigh.push(REFS.invoice_system[0]);
  }
  if (xd.touchesIncomeTax && taxDomain !== 'income_tax' && REFS.income_tax) {
    priorityHigh.push(
      REFS.income_tax.find(r => r.no === '2070'),  // 青色申告制度
      REFS.income_tax.find(r => r.no === '1350'),  // 事業所得
    );
  }
  if (xd.touchesBookkeeping && taxDomain !== 'bookkeeping_expenses' && REFS.bookkeeping_expenses) {
    priorityHigh.push(REFS.bookkeeping_expenses[0]);
  }

  // ── ①' 簡易課税・事業区分ブースト ───────────────────────────
  // 「簡易課税の事業区分（第1〜6種）」を扱う記事では、事業区分を明示列挙した
  // No.6509 と制度概要 No.6505 を最優先で渡す。REFS 先頭2件[6451,6501]に
  // 押し出されて事業区分の正解ソースが落ち、LLM が記憶頼りで業種→種を誤る
  // （例: 理容・旅館を第4種と誤記）事故を防ぐ。
  if (REFS.consumption_tax) {
    const blob = [topic.pain_point, topic.subcluster, topic.cluster].filter(Boolean).join(' ');
    const ja   = [topic.title, topic.search_intent, topic.primary_question, topic.reader_problem].filter(Boolean).join(' ');
    if (/simplified-tax|business-category/.test(blob) || /簡易課税|みなし仕入率|事業区分/.test(ja)) {
      priorityHigh.push(
        REFS.consumption_tax.find(r => r.no === '6509'),  // 簡易課税制度の事業区分
        REFS.consumption_tax.find(r => r.no === '6505'),  // 簡易課税制度
      );
    }
    // 高額特定資産の3年縛りを扱う記事では、特例を定めた No.6502 を最優先で渡す
    // （No.6501 の一般免除規定に押し出されて期間の起点を誤る事故を防ぐ）。
    if (/high-value-asset/.test(blob) || /高額特定資産|3年縛り|調整対象固定資産/.test(ja)) {
      priorityHigh.push(
        REFS.consumption_tax.find(r => r.no === '6502'),  // 高額特定資産の特例
      );
    }
  }

  // ── ② taxDomain refs ────────────────────────────────────────
  if (taxDomain && REFS[taxDomain]) {
    // 先頭 2 件を mid、それ以降は low（多すぎる ref で cross-domain を弾かないため）
    priorityMid.push(...REFS[taxDomain].slice(0, 2));
    priorityLow.push(...REFS[taxDomain].slice(2));
  }

  // ── ③ 既存の補足サジェスト ──────────────────────────────────
  if (topic.category === '消費税' && taxDomain !== 'invoice_system' && REFS.invoice_system) {
    priorityLow.push(...REFS.invoice_system.slice(0, 1));
  }
  if (taxDomain === 'overseas_transactions' && REFS.consumption_tax) {
    priorityLow.push(REFS.consumption_tax.find(r => r.no === '6551'));
  }

  // マージ + dedup（URL ベース）
  const merged = [...priorityHigh, ...priorityMid, ...priorityLow];
  const unique = [];
  const seen = new Set();
  for (const r of merged) {
    if (!r || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    unique.push(r);
    if (unique.length >= limit) break;
  }

  return unique;
}

/**
 * topic の pain_point / cluster / subcluster / primary_question などから、
 * 本文中で「触れそうな税目領域」のシグナルを集める。
 * 完全網羅ではなく、ハルシネーション事故が起きやすい cross-domain
 * パターンに絞って判定する。
 */
function collectCrossDomainSignals(topic) {
  const blob = [
    topic.pain_point, topic.cluster, topic.subcluster, topic.procedure_stage,
    topic.primary_question, topic.search_intent, topic.reader_problem,
  ].filter(Boolean).join(' ').toLowerCase();

  const ja = [
    topic.primary_question, topic.search_intent, topic.reader_problem,
    topic.success_outcome, topic.title,
  ].filter(Boolean).join(' ');

  return {
    // consumption_tax: 課税事業者判定/免除/みなし仕入率/簡易課税/法人化売上ライン
    touchesConsumptionTax:
      /consumption-tax|simplified-tax|incorporation-threshold|tax-refund|kanpu|shouhi/.test(blob) ||
      /消費税|課税事業者|免税事業者|納税義務|簡易課税|みなし仕入率|法人化/.test(ja),
    // invoice_system: インボイス/適格請求書
    touchesInvoice:
      /invoice/.test(blob) ||
      /インボイス|適格請求書/.test(ja),
    // income_tax: 青色/白色/事業所得/必要経費（本文の事業所得・帳簿説明）
    touchesIncomeTax:
      /income-tax|blue-return|sole-proprietor|business-income/.test(blob) ||
      /所得税|事業所得|青色申告|必要経費/.test(ja),
    // bookkeeping_expenses
    touchesBookkeeping:
      /bookkeeping|expense|kicho|electronic-book/.test(blob) ||
      /帳簿|経費|記帳|電子帳簿/.test(ja),
  };
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
  invoice_system:         { no: '6498', title: '国税庁タックスアンサー No.6498 適格請求書等保存方式（インボイス制度）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm' },
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
  // 簡易課税の事業区分（第1〜6種の判定）は「納税義務の免除(No.6501)」ではなく
  // 事業区分を明示列挙した No.6509 を主出典にする（No.6505 は制度概要）。
  'simplified-tax-business-category': { no: '6509', title: '国税庁タックスアンサー No.6509 簡易課税制度の事業区分', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6509.htm' },
  // 高額特定資産の3年縛りは「納税義務の免除(No.6501)」ではなく、特例を定めた No.6502 を主出典にする。
  'high-value-asset-3year-restriction': { no: '6502', title: '国税庁タックスアンサー No.6502 高額特定資産を取得した場合等の納税義務の免除等の特例', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6502.htm' },
  'invoice-judgement':         { no: '6498', title: '国税庁タックスアンサー No.6498 適格請求書等保存方式（インボイス制度）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm' },
  'tax-refund-eligibility':    { no: '6551', title: '国税庁タックスアンサー No.6551 輸出取引の免税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
  'overseas-tax-uncertain':    { no: '6551', title: '国税庁タックスアンサー No.6551 輸出取引の免税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm' },
  'incorporation-threshold':   { no: '2260', title: '国税庁タックスアンサー No.2260 所得税の税率', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm' },
  'income-classification':     { no: '1350', title: '国税庁タックスアンサー No.1350 事業所得の課税のしくみ', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
  'family-employment':         { no: '2075', title: '国税庁タックスアンサー No.2075 専従者給与と専従者控除', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm' },
  'withholding-treatment':     { no: '2792', title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm' },
  // 国外プラットフォーム手数料・海外取引（電気通信利用役務／リバースチャージ）は
  // 「納税義務の免除(No.6501)」ではなく、国境を越えた役務提供の消費税を主出典にする。
  'platform-fee-treatment':           { title: '国税庁 国境を越えた役務の提供に係る消費税の課税関係について', url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm' },
  'foreign-business-consumption-tax': { title: '国税庁 国境を越えた役務の提供に係る消費税の課税関係について', url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm' },
  'b2b-electronic-services':          { title: '国税庁 国境を越えた役務の提供に係る消費税の課税関係について', url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm' },
  'b2c-electronic-services':          { title: '国税庁 国境を越えた役務の提供に係る消費税の課税関係について', url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm' },
  // 住宅取得等資金の贈与（贈与税。相続の申告期限などと混同しないよう明示）
  'housing-fund-gift':                { no: '4508', title: '国税庁タックスアンサー No.4508 直系尊属から住宅取得等資金の贈与を受けた場合の非課税', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4508.htm' },
};

// ── 新カテゴリ（Phase 4）の pain_point 別 個別出典 ─────────────────
// 「tax_domain 汎用フォールバックで false な score=5」を防ぐため、新カテゴリの
// pain は全て明示的にここで扱う。検証済みカタログ内の出典だけを使い、番号は捏造しない。
const _NS = {
  revenue:      { no: '2200', title: '国税庁タックスアンサー No.2200 収入金額とその計算', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm' },
  business_inc: { no: '1350', title: '国税庁タックスアンサー No.1350 事業所得の課税のしくみ', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm' },
  filing_need:  { no: '1900', title: '国税庁タックスアンサー No.1900 給与所得者で確定申告が必要な人', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm' },
  side_income:  { no: '1906', title: '国税庁タックスアンサー No.1906 給与所得者がネットオークション等で得た所得', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1906.htm' },
  expense:      { no: '2210', title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm' },
  depreciation: { no: '2100', title: '国税庁タックスアンサー No.2100 減価償却のあらまし', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm' },
  bookkeeping:  { no: '2080', title: '国税庁タックスアンサー No.2080 白色申告者の記帳・帳簿等の保存', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2080.htm' },
  withholding:  { no: '2792', title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm' },
  invoice:      { no: '6498', title: '国税庁タックスアンサー No.6498 適格請求書等保存方式（インボイス制度）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm' },
  reduced_rate: { no: '6102', title: '国税庁タックスアンサー No.6102 消費税の軽減税率制度', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6102.htm' },
  input_credit: { no: '6451', title: '国税庁タックスアンサー No.6451 仕入税額控除の対象範囲', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6451.htm' },
};
const NEW_SEGMENT_PAIN_SOURCE = {
  // YouTuber
  'youtube-adsense-revenue': _NS.revenue,      'youtube-superchat': _NS.business_inc,
  'youtube-equipment-expense': _NS.depreciation, 'youtube-editing-outsource': _NS.withholding,
  'youtube-sponsorship-withholding': _NS.withholding, 'youtube-home-office': _NS.expense,
  'youtube-invoice': _NS.invoice, 'youtube-gaming-hardware': _NS.depreciation,
  'youtube-gaming-capture': _NS.depreciation, 'youtube-review-product-received': _NS.revenue,
  'youtube-review-purchase': _NS.expense, 'youtube-live-costume': _NS.expense,
  'youtube-edu-material': _NS.expense, 'youtube-vlog-vehicle': _NS.expense,
  'youtube-tax-return-need': _NS.filing_need, 'youtube-income-classification': _NS.business_inc,
  // コンテンツ販売
  'content-note-revenue': _NS.revenue, 'content-online-course': _NS.revenue,
  'content-subscription-revenue': _NS.revenue, 'content-platform-fee': _NS.input_credit,
  'content-refund-handling': _NS.revenue, 'content-invoice': _NS.invoice,
  'content-membership-tiers': _NS.revenue, 'content-ebook-royalty': _NS.revenue,
  'content-license-revenue': _NS.revenue, 'content-tax-return-need': _NS.filing_need,
  'content-income-classification': _NS.business_inc,
  // 1人親方
  'construction-labor-cost': _NS.withholding, 'construction-material-cost': _NS.expense,
  'construction-tools-expense': _NS.expense, 'construction-invoice': _NS.invoice,
  'construction-withholding-received': _NS.withholding, 'construction-vehicle-expense': _NS.expense,
  'construction-bookkeeping': _NS.bookkeeping, 'construction-qualification-cost': _NS.expense,
  'construction-consumables': _NS.expense, 'construction-power-tools': _NS.depreciation,
  'construction-workform-judgment': _NS.withholding,
  // 小売
  'retail-register-sales': _NS.revenue, 'retail-reduced-tax-rate': _NS.reduced_rate,
  'retail-inventory-count': _NS.expense, 'retail-qr-payment': _NS.revenue,
  'retail-invoice': _NS.invoice, 'retail-food-eatin': _NS.reduced_rate,
  'retail-apparel-season-inventory': _NS.expense, 'retail-consignment-sales': _NS.revenue,
  // 卸売
  'wholesale-accounts-receivable': _NS.revenue, 'wholesale-inventory-valuation': _NS.expense,
  'wholesale-invoice': _NS.invoice, 'wholesale-closing-date-sales': _NS.revenue,
  'wholesale-billing-omission': _NS.revenue, 'wholesale-food-loss': _NS.expense,
  'wholesale-consignment': _NS.revenue,
};
Object.assign(DEFAULT_SOURCE_BY_PAIN, NEW_SEGMENT_PAIN_SOURCE);

// 人が matcher の提案を確認して curated へ昇格した追加分。
// 生成スクリプトと Netlify Functions の双方で同じ信頼済みマップを参照する。
// ファイルが無い環境（regenerate の部分チェックアウト・Netlify のバンドル漏れ等）でも
// モジュール読込ごとクラッシュしないよう、防御的に読み込む（未配置なら空で継続）。
let PROMOTED_SOURCE_BY_PAIN = {};
try {
  PROMOTED_SOURCE_BY_PAIN = require('../../data/curated-source-promotions.json');
} catch (e) {
  console.warn('[tax-authority-refs] curated-source-promotions.json を読めませんでした（未配置として続行）:', e.message);
}
Object.assign(DEFAULT_SOURCE_BY_PAIN, PROMOTED_SOURCE_BY_PAIN);

// 個別出典を確定できない pain。これらは source_alignment_score を 5 にせず
// revise 扱いにする（消費税の課税区分・時期など、検証済みカタログに適切な
// 個別ページが無いもの。捏造しない）。source-alignment.js が参照する。
const NEEDS_SOURCE_REVIEW = new Set([
  // デジタルコンテンツ/オンライン講座の消費税は論点が分かれる（電気通信利用役務・
  // 課税/非課税判定等）ため、個別出典が確定するまで保留のまま。
  'content-digital-consumption-tax', 'content-course-bundle',
  // ↓ 値引き・返品・割戻し・商品券は curated 化済み（data/curated-source-promotions.json）:
  //   retail-point-discount / retail-return-handling / wholesale-return-rebate /
  //   wholesale-apparel-return → No.6359（売上げに係る対価の返還等）
  //   retail-gift-certificate → No.6229（商品券・物品切手等）
]);

// ── 使用禁止の出典 ──────────────────────────────────────────────
// 「制度の入口ページ」は論点を特定できず、記事の主張を裏付けられない。
// 2026-08-16: インボイス制度の概要ページを出典にした記事で、
// プラットフォーム課税の対象（国外事業者限定）を誤った記述が発生した。
// 概要ページには論点の記載がないため、LLM が記憶で補ってしまう。
// → 論点に対応するタックスアンサー（No.6498 等）を使うこと。
const DENIED_SOURCE_URLS = new Set([
  'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
]);

// 参考にはするが主出典にはしない資料（nta-reference-pages.js）。
// タックスアンサー未収録の国税庁資料をプロンプトに渡すようになったため、
// それが source_url として選ばれないよう、ここでも弾く。
// 循環 require を避けるため遅延読み込みする。
let _referenceOnly = null;
function isReferenceOnlySource(url) {
  if (_referenceOnly === null) {
    try {
      _referenceOnly = require('./nta-reference-pages').isReferenceOnlyUrl;
    } catch (_error) {
      _referenceOnly = () => false;
    }
  }
  return _referenceOnly(url);
}

function isDeniedSource(url) {
  const u = String(url || '').trim();
  return DENIED_SOURCE_URLS.has(u) || isReferenceOnlySource(u);
}

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
function resolveSourceForTopic(topic = {}) {
  const painId    = topic.pain_point || topic.pain || '';
  const taxDomain = topic.tax_domain || '';

  // 明示指定は provenance を伴う場合だけ信頼する。URL があるだけでは explicit にしない。
  // ただし使用禁止の出典（制度の入口ページ等）は明示指定でも採用しない。
  if (topic.source_provenance === 'explicit' && topic.source_url && !isDeniedSource(topic.source_url)) {
    return {
      url: topic.source_url,
      title: topic.source_title || topic.source_url,
      provenance: 'explicit',
      confidence: Number.isFinite(Number(topic.source_confidence)) ? Number(topic.source_confidence) : 1,
    };
  }

  if (painId && DEFAULT_SOURCE_BY_PAIN[painId]) {
    const r = DEFAULT_SOURCE_BY_PAIN[painId];
    return { url: r.url, title: r.title, provenance: 'curated', confidence: 1 };
  }

  // matcher はこの経路でだけ遅延ロードする。承認/公開時の source-alignment は
  // ローカルカタログを必要とせず、Netlify bundle でも軽量なまま動く。
  try {
    const { rankSources, selectSource } = require('./nta-source-matcher');
    const selected = selectSource(rankSources(topic));
    if (selected) {
      return {
        url: selected.url,
        title: selected.title,
        provenance: 'auto',
        confidence: selected.confidence,
        margin: selected.margin,
      };
    }
  } catch (_error) {
    // カタログ障害は下の domain fallback に倒す。
  }

  if (taxDomain && DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain]) {
    const r = DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain];
    return { url: r.url, title: r.title, provenance: 'domain-fallback', confidence: 0 };
  }
  return {
    url: ULTIMATE_FALLBACK.url,
    title: ULTIMATE_FALLBACK.title,
    provenance: 'ultimate',
    confidence: 0,
  };
}

function getDefaultSourceForTopic(topic) {
  return resolveSourceForTopic(topic);
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
  resolveSourceForTopic,
  DEFAULT_SOURCE_BY_TAX_DOMAIN,
  DEFAULT_SOURCE_BY_PAIN,
  PROMOTED_SOURCE_BY_PAIN,
  NEEDS_SOURCE_REVIEW,
  DENIED_SOURCE_URLS,
  isDeniedSource,
  resolveNtaUrlByNumber,
  NTA_URL_PREFIX_RULES,
};
