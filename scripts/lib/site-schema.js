'use strict';

/**
 * サイト全体の構造化データ（JSON-LD）
 *
 * なぜ必要か（2026-09-03）:
 *   記事以外のページ（トップ・事務所紹介・取扱業務・お客様の声・お問い合わせ）に
 *   検索エンジンが機械的に読む情報が一切無かった。記事側も「記事」型だけで、
 *   パンくず・FAQ・執筆者が無い。税務のような分野では「誰が書いたか」が順位に
 *   直結するため、事務所と代表を @id で一元化し、全ページから参照する。
 *
 * 方針:
 *   - 住所（address）は入れない（決定事項: 住所は出さず「対応地域」ページで受ける）
 *   - sameAs・税理士登録番号など裏付けが要る値は入れない（空配列・未設定のまま）
 *   - 日付は変わる値なので、ここには持たせない（呼び出し側が渡す）
 */

const BASE_URL = 'https://mori-zeirishi.net';
const ORG_ID = `${BASE_URL}/#organization`;
const PERSON_ID = `${BASE_URL}/#person`;
const WEBSITE_ID = `${BASE_URL}/#website`;
const OG_IMAGE = `${BASE_URL}/assets/images/og-default.png`;
const LOGO_IMAGE = `${BASE_URL}/assets/images/logo.png`;
const AUTHOR_IMAGE = `${BASE_URL}/assets/images/author-mori.png`;

const ORG_NAME = '毛利順活税理士事務所';
const ORG_DESCRIPTION = '国税局出身の税理士による、ネット販売・個人事業主・相続に強い税理士事務所。eBay輸出・越境ECの消費税還付にも対応。全国オンライン対応・初回相談無料。';

function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': ['Organization', 'AccountingService'],
    '@id': ORG_ID,
    name: ORG_NAME,
    alternateName: 'Mori Yoshiiku Tax Accountant Office',
    url: `${BASE_URL}/`,
    logo: LOGO_IMAGE,
    image: OG_IMAGE,
    description: ORG_DESCRIPTION,
    areaServed: { '@type': 'Country', name: 'JP' },
    availableLanguage: 'ja',
    openingHoursSpecification: [{
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      opens: '09:00',
      closes: '18:00',
    }],
    founder: { '@id': PERSON_ID },
    knowsAbout: ['税務', '所得税', '消費税', 'インボイス制度', '相続税', '税務調査', 'eBay輸出', '越境EC', 'ネット販売', '記帳代行'],
    // 事務所の公式アカウント。追跡用の引数（?igsh= など）は付けない。
    // 税理士会名簿などは裏付けが来たら足す（2026-09-03 毛利より Instagram のみ）
    sameAs: ['https://www.instagram.com/guardian_tax_ac/'],
  };
}

function personSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': PERSON_ID,
    name: '毛利 順活',
    alternateName: 'Mori Yoshiiku',
    jobTitle: '税理士',
    worksFor: { '@id': ORG_ID },
    url: `${BASE_URL}/about.html`,
    image: AUTHOR_IMAGE,
    description: '国税局での勤務経験を経て税理士として独立。ネット販売・個人事業主・相続の税務を全国オンラインで支援。',
    knowsAbout: ['所得税', '消費税', '相続税', '税務調査', 'eBay輸出', '越境EC'],
  };
}

/** トップページだけに出す */
function websiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: `${BASE_URL}/`,
    name: ORG_NAME,
    publisher: { '@id': ORG_ID },
    inLanguage: 'ja',
  };
}

/**
 * パンくず。items は [{ name, url }] の順（先頭がホーム）。
 * 最後の要素は現在ページなので url を省略してよい。
 */
function breadcrumbSchema(items) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && i.name);
  if (list.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: list.map((item, i) => {
      const el = { '@type': 'ListItem', position: i + 1, name: item.name };
      if (item.url) el.item = item.url.startsWith('http') ? item.url : `${BASE_URL}${item.url}`;
      return el;
    }),
  };
}

/** FAQ。items は [{ question, answer }]。answer はプレーンテキスト前提。 */
function faqSchema(items) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && i.question && i.answer);
  if (list.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: list.map(i => ({
      '@type': 'Question',
      name: i.question,
      acceptedAnswer: { '@type': 'Answer', text: i.answer },
    })),
  };
}

/** 記事。publisher / author は @id で事務所・代表を参照する。 */
function articleSchema({ title, description, url, datePublished, dateModified }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: description || '',
    image: OG_IMAGE,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: datePublished || '',
    dateModified: dateModified || datePublished || '',
    author: { '@id': PERSON_ID },
    publisher: { '@id': ORG_ID },
    inLanguage: 'ja',
  };
}

/** <script type="application/ld+json"> を作る。null は空文字。 */
function jsonLdScript(obj) {
  if (!obj) return '';
  // </script> で閉じられないよう "<" をエスケープする
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

function jsonLdScripts(list) {
  return (Array.isArray(list) ? list : []).map(jsonLdScript).filter(Boolean).join('\n  ');
}

module.exports = Object.freeze({
  BASE_URL, ORG_ID, PERSON_ID, WEBSITE_ID, OG_IMAGE, LOGO_IMAGE, AUTHOR_IMAGE,
  organizationSchema, personSchema, websiteSchema,
  breadcrumbSchema, faqSchema, articleSchema,
  jsonLdScript, jsonLdScripts,
});
