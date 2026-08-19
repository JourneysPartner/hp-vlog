'use strict';

/**
 * 国税庁の「タックスアンサー以外」の公式資料カタログ。
 *
 * 背景（2026-08-18）:
 *   令和8年度税制改正で新設された「3割特例」は、国税庁の
 *   「令和8年度 税制改正特集」で公表されているが、タックスアンサーには
 *   まだ収録されていない。そのためタックスアンサー・カタログ
 *   （data/nta-sources）だけを見ている生成プロンプトからは存在が見えず、
 *   「2割特例が終わったら簡易課税」という古い整理の記事が生成された。
 *
 * 位置づけ:
 *   タックスアンサーと同等に「参考にしてよい」国税庁の資料として扱う。
 *   ただし記事の主出典（frontmatter の source_url）にはしない。
 *   主出典はタックスアンサーに揃える運用のため。
 *   → REFERENCE_ONLY_URLS で source_url への採用を機械的に禁止する。
 *
 * 安全原則:
 *   - nta.go.jp のみ。
 *   - notes は原文で確認した内容だけを書く。要約でニュアンスを変えない。
 *   - 実在確認した URL だけを登録する。
 */

// __body は本文ベースの再判定時にだけ載る（findReferencePagesFromBody）。
// 生成時のトピックには存在しないので、通常の判定結果は変わらない。
const _kwText = (topic) => [
  topic.title, topic.search_intent, topic.primary_question,
  topic.reader_problem, topic.subcluster, topic.slug,
  topic.pain_point, topic.summary, topic.tax_domain, topic.category,
  topic.__body,
].filter(Boolean).join(' ');

const kw = (topic, terms) => {
  const text = _kwText(topic);
  return terms.some(t => text.includes(t));
};

const NTA_REFERENCE_PAGES = {
  // 2026-08-18 に原文で確認
  invoice_tax_reform_2026: {
    label: 'インボイス制度の令和8年度税制改正',
    title: '国税庁 令和8年度 税制改正特集（インボイス制度）',
    url: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm',
    verified_at: '2026-08-18',
    notes: [
      '3割特例（新設）: インボイス発行事業者の登録を受けたことにより免税事業者から'
        + '課税事業者となった個人事業者に係る、令和9年分・令和10年分の消費税の確定申告において'
        + '納付税額を売上税額の3割とすることができる特例。法人は適用不可。',
      '3割特例の計算: 売上げの消費税額 − 売上げの消費税額×70% ＝ 納付する税額。'
        + '仕入れの消費税額の実額計算もインボイスの保存も不要。',
      '3割特例の主な適用要件: 個人事業者であること／インボイス発行事業者の登録を受けていること／'
        + '1月1日の時点で恒久的施設を有しない国外事業者ではないこと／'
        + '基準期間（適用を受ける年の2年前）の課税売上高と特定期間（前年1月〜6月）の課税売上高が'
        + 'いずれも1,000万円以下であること（特定期間は給与等支払額の合計額による判定も可）／'
        + '課税期間を短縮していない・相続により課税事業者となる課税期間ではない・'
        + '高額な資産を仕入れたことにより課税事業者となる年ではない 等。',
      '3割特例の手続: 事前の届出等は不要。申告書の所定欄に適用を受ける旨を記載するだけで適用可能。',
      '3割特例の留意点: 卸売業（みなし仕入率90%）や小売業・農林水産業等（80%）は'
        + '簡易課税制度の方が納付税額が少なくなる場合がある。'
        + 'また多額の設備投資等で仕入れの消費税額が売上げの消費税額を上回る場合、'
        + '一般課税なら還付税額が生じるが、3割特例では通常還付は生じない。',
      '2割特例: 令和5年10月1日から令和8年9月30日までの日の属する課税期間まで。'
        + '個人事業者は令和8年分が最後になる。',
      '簡易課税への円滑な移行措置: 2割特例・3割特例の適用を受けた翌課税期間に'
        + '簡易課税制度の適用を受けようとする場合、原則の事前提出ではなく、'
        + 'その課税期間の申告期限までに「消費税簡易課税制度選択届出書」を提出すればよい。'
        + '（2割特例の適用を受けた課税期間の翌課税期間が令和8年9月30日以前に終了する'
        + '課税期間である場合は、その課税期間の末日まで）',
      '7・5・3割控除: 免税事業者等からの課税仕入れに係る経過措置は適用期限が2年延長され、'
        + '控除可能割合が見直された。一のインボイス発行事業者以外の者からの課税仕入れの'
        + '合計額（税込み）がその年または事業年度で1億円（改正前10億円）を超える場合、'
        + 'その超えた部分については適用できない（令和8年10月1日以後に開始する課税期間から）。',
    ],
    match: (t) => String(t.tax_domain || '') === 'invoice_system'
      || ['invoice-judgement', 'invoice-registration', 'invoice-transition-80-50'].includes(String(t.pain_point || ''))
      || kw(t, ['インボイス', '2割特例', '２割特例', '3割特例', '３割特例', '適格請求書']),
  },

  // 2026-08-18 に原文で確認。
  // タックスアンサー No.2100 / No.5408 はいずれも「令和7年4月1日現在法令等」のままで、
  // 令和8年度税制改正（40万円未満・3年延長）が反映されていない。
  // 出典どおりに書くと「令和8年3月31日まで」という失効済みの記述になる。
  small_depreciable_assets_2026: {
    label: '少額減価償却資産の特例の令和8年度税制改正',
    title: '国税庁 令和8年度 法人税関係法令の改正の概要（主な中小企業税制の見直し）',
    url: 'https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2026/pdf/G.pdf',
    verified_at: '2026-08-18',
    notes: [
      '原文: 「中小企業者等の少額減価償却資産の取得価額の損金算入の特例について、'
        + '令和8年4月1日以後に取得等（取得、製作又は建設をいいます。）をする減価償却資産の'
        + '取得価額基準が30万円未満のものから40万円未満のものに引き上げられ、'
        + 'その適用期限が3年延長されました（措法67の5①、改正法附則65）。」',
      '取得価額基準は「取得等をする日」で判定する。'
        + '令和8年4月1日より前に取得等したものは30万円未満が対象、'
        + '令和8年4月1日以後に取得等するものは40万円未満が対象。',
      '年間の上限は変わらない。原文: 「本制度の対象となる取得価額の合計額については、'
        + '引き続き年300万円が上限とされています（措法67の5①）。」',
      '対象法人の要件も取得等をする日で判定する。令和8年4月1日より前は'
        + '常時使用する従業員数が500人超の法人が対象外、同日以後は400人超の法人が対象外。',
      '個人事業者にも同様の措置が講じられる。令和8年度税制改正の大綱に'
        + '「（5）中小企業者等の少額減価償却資産の取得価額の損金算入の特例について、'
        + '次の措置を講じた上、その適用期限を3年延長する（所得税についても同様とする。）」'
        + 'と明記されている（個人事業者は措法28の2「中小事業者の少額減価償却資産の'
        + '取得価額の必要経費算入の特例」）。',
      '注意: タックスアンサー No.2100「減価償却のあらまし」および No.5408 は'
        + '2026年8月18日時点で「令和7年4月1日現在法令等」のままであり、'
        + '「令和8年3月31日まで」「30万円未満」と記載されている。'
        + 'この改正はまだ反映されていないので、タックスアンサーの記載をそのまま'
        + '書き写すと失効済みの内容になる。',
      '関連する同時改正: 中小企業経営強化税制の工具及び器具備品の取得価額要件が'
        + '30万円以上から40万円以上に引き上げられた。'
        + '中小企業投資促進税制の工具の要件も「1台又は1基の取得価額が30万円以上」から'
        + '「40万円以上」に引き上げられた（いずれも令和8年4月1日以後に取得等するもの）。',
    ],
    match: (t) => ['bookkeeping_expenses'].includes(String(t.tax_domain || ''))
      && kw(t, ['減価償却', '少額', '固定資産', '機材', 'パソコン', 'PC', '備品', '設備'])
      || kw(t, ['少額減価償却資産', '一括償却資産', '減価償却', '耐用年数', '30万円未満', '40万円未満']),
  },
};

// 主出典（source_url）に採用してはいけない URL。
// ここに載るのは「参考にはするが主出典にはしない」資料。
const REFERENCE_ONLY_URLS = new Set(
  Object.values(NTA_REFERENCE_PAGES).map(p => p.url),
);

function isReferenceOnlyUrl(url) {
  return REFERENCE_ONLY_URLS.has(String(url || '').trim());
}

/** topic に該当する参考資料を返す（該当なしなら空配列） */
function findReferencePages(topic = {}) {
  const hits = [];
  for (const [key, def] of Object.entries(NTA_REFERENCE_PAGES)) {
    try {
      if (def.match(topic)) hits.push({ key, ...def });
    } catch (_error) { /* match の失敗は該当なし扱い */ }
  }
  return hits;
}

/**
 * 生成プロンプトに差し込む「参考資料」ブロックを組み立てる。
 * 該当しなければ空文字。
 */
function buildReferencePagesBlock(topic = {}, pagesOverride = null) {
  const pages = pagesOverride || findReferencePages(topic);
  if (pages.length === 0) return '';

  const body = pages.map(p => {
    const notes = p.notes.map(n => `  ・${n}`).join('\n');
    return `【${p.title}】\n${p.url}\n（${p.verified_at} に原文で確認）\n${notes}`;
  }).join('\n\n');

  return `

═══ 参考資料（タックスアンサーと同等に参照してよい国税庁の資料）═══
タックスアンサーにまだ収録されていないが、国税庁が公表している内容です。
制度改正の直後はタックスアンサーへの反映が遅れるため、ここに載せています。
タックスアンサーと同じ重みで参照し、記事の内容を最新の制度に合わせてください。

${body}

【厳守】
1. ここに書かれている内容は、記事本文で根拠として使ってよい。
2. ただし<strong>この資料を記事の主出典（frontmatter の source_url）にはしない</strong>。
   主出典はタックスアンサーのままにすること。
3. ここに<strong>書かれていないこと</strong>を、この資料に書いてあるかのように書かない。
   記憶で数値・要件・適用範囲を補わない。
4. 本文で言及するときは「国税庁『令和8年度 税制改正特集』」のように資料名で示す。
   タックスアンサー番号を割り当てない（番号は存在しない）。`;
}

/**
 * 書き上がった本文を根拠に、該当する参考資料を検出する。
 *
 * 2026-08-19: 企画メタの語句一致だけで判定していたため、企画段階で予測
 * できなかった論点が本文に出てきても参考資料が渡らなかった。
 * 「電気工事の資格更新費や専用工具」の記事は、企画メタに「減価償却」が
 * 一度も出てこないが、本文は当然に減価償却の閾値表を書いていた。
 */
function findReferencePagesFromBody(topic = {}, body = '') {
  return findReferencePages({ ...topic, __body: body });
}

/** 本文を見て初めて該当する（＝生成時に渡っていなかった）参考資料 */
function findUnappliedReferencePages(topic = {}, body = '') {
  const applied = new Set(findReferencePages(topic).map(p => p.key));
  return findReferencePagesFromBody(topic, body).filter(p => !applied.has(p.key));
}

/** 参考資料の配列からプロンプト用ブロックを組む（buildReferencePagesBlock の下請け） */
function formatReferencePages(pages) {
  if (!pages || pages.length === 0) return '';
  return buildReferencePagesBlock({}, pages);
}

module.exports = {
  NTA_REFERENCE_PAGES,
  REFERENCE_ONLY_URLS,
  isReferenceOnlyUrl,
  findReferencePages,
  buildReferencePagesBlock,
  findReferencePagesFromBody,
  findUnappliedReferencePages,
  formatReferencePages,
};
