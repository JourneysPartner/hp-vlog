'use strict';

/**
 * 国税庁以外の公的出典カタログ。
 *
 * 背景（2026-08-17）:
 *   「社会保険の扶養と税の扶養の違い」というテーマの記事が生成されたが、
 *   社会保険は厚生労働省・日本年金機構の所管で、国税庁のタックスアンサーには
 *   該当ページが存在しない。LLM は税側の No.1191（配偶者控除）を選んだものの、
 *   記事の主題である社会保険側は裏付けのないまま書かれていた。
 *
 *   税以外の論点は、その論点を所管する官庁の出典を参照する必要がある。
 *
 * 安全原則:
 *   - 政府機関ドメイン（go.jp）のみ。民間サイトは登録しない。
 *   - URL は実在確認したものだけを登録する（2026-08-17 に HTTP 200 とタイトルを確認）。
 *   - 制度の数値（130万円等）が実際にそのページに記載されていることも確認済み。
 *   - 記事の主たる出典（source_url）は従来どおり国税庁。ここは
 *     「税以外の論点に触れるときの補助出典」として渡す。
 */

// 公的機関として認めるドメイン。これ以外は出典に使わない。
const OFFICIAL_DOMAINS = [
  'nta.go.jp',          // 国税庁
  'nenkin.go.jp',       // 日本年金機構
  'mhlw.go.jp',         // 厚生労働省
  'chusho.meti.go.jp',  // 中小企業庁
  'meti.go.jp',         // 経済産業省
  'moj.go.jp',          // 法務省
];

function isOfficialDomain(url) {
  try {
    const host = new URL(String(url)).hostname;
    return OFFICIAL_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (_error) {
    return false;
  }
}

/**
 * 論点（pain_point / キーワード）→ 所管官庁の出典。
 * 全て 2026-08-17 に実在確認済み（HTTP 200・タイトル取得・要件記載を確認）。
 */
const NON_TAX_SOURCES = {
  social_insurance_dependent: {
    label: '社会保険の被扶養者',
    agency: '日本年金機構',
    entries: [
      {
        title: '日本年金機構 従業員が家族を被扶養者にするとき、被扶養者に異動があったときの手続き',
        url: 'https://www.nenkin.go.jp/service/kounen/tekiyo/hihokensha1/20141202.html',
        note: '被扶養者の範囲・収入要件（年間130万円未満、60歳以上または障害者は180万円未満）',
      },
      {
        title: '厚生労働省 「年収の壁」への対応',
        url: 'https://www.mhlw.go.jp/stf/taiou_001_00002.html',
        note: '106万円・130万円の壁と支援強化パッケージ',
      },
    ],
    // 記事のどこに現れたら適用するか
    match: (t) => /social-insurance|shakai-hoken/.test(String(t.pain_point || ''))
      || kw(t, ['社会保険の扶養', '被扶養者', '130万円の壁', '106万円の壁', '年収の壁', '扶養から外れ']),
  },
};

function kw(topic, terms) {
  const text = [
    topic.title, topic.search_intent, topic.primary_question,
    topic.reader_problem, topic.subcluster, topic.slug, topic.pain_point, topic.summary,
  ].filter(Boolean).join(' ');
  return terms.some(t => text.includes(t));
}

/** topic に該当する非税出典のグループを返す（該当なしなら null） */
function findNonTaxSource(topic = {}) {
  for (const [key, def] of Object.entries(NON_TAX_SOURCES)) {
    try {
      if (def.match(topic)) return { key, ...def };
    } catch (_error) { /* match の失敗は該当なし扱い */ }
  }
  return null;
}

/**
 * 生成プロンプトに差し込む「税以外の論点の出典」ブロックを組み立てる。
 * 該当しなければ空文字。
 */
function buildNonTaxSourceBlock(topic = {}) {
  const found = findNonTaxSource(topic);
  if (!found) return '';

  const list = found.entries
    .map(e => `- ${e.title}\n  ${e.url}\n  （${e.note}）`)
    .join('\n');

  return `

═══ 税以外の論点の出典（${found.label}／所管: ${found.agency}）═══
この記事は<strong>税以外の制度（${found.label}）</strong>にも触れるテーマです。
国税庁のタックスアンサーはこの論点を扱っていないため、下記の所管官庁の
ページを出典として使ってください。

${list}

【厳守】
1. <strong>税の制度と ${found.label} を混同しない</strong>。判定基準・所管官庁・
   手続き先がそれぞれ異なることを、読者が区別できるように書く。
2. ${found.label} の話をするときに<strong>国税庁タックスアンサーを根拠として引かない</strong>
   （国税庁は所管外であり、該当する記載がない）。
3. 上記ページに書かれていない数値・要件は書かない。曖昧な場合は
   「詳細は${found.agency}のページで確認を」と案内に留める。
4. 制度改正が頻繁な分野のため、断定的な将来予測は書かない。`;
}

module.exports = {
  OFFICIAL_DOMAINS,
  isOfficialDomain,
  NON_TAX_SOURCES,
  findNonTaxSource,
  buildNonTaxSourceBlock,
};
