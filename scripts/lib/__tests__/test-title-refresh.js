'use strict';
/**
 * 検索結果向けの題名・説明文差し替え（クロール改善 09）で対象にした 10 本について、
 * 公開した後に変わってはいけない 11 項目（PINNED_FIELDS）だけを固定する。
 *
 * 差し替えのときは題名・説明文・本文も固定していたが、その後の正しい変更で 3 回落ちた。
 * - 2026-10-08 鮮度更新の更新案（#663）でサブスク記事の本文と更新日が変わった
 * - 2026-11-06 毛利承認の手作業 PR（#751 など）で題名・説明文・本文が変わった
 * - 2026-11-10 承認画面の手直し PR（#762）で塗装工の記事の本文が 1 行変わった
 * 本文と題名・説明文は、鮮度更新（/admin/freshness）と手直し PR（#759）の承認で
 * 人が確かめてから入るので、この試験では固定しない。
 * 題名の形は test-title-lint.js・test-seo-lint.js が見ている。
 *
 * 固定する 11 項目の値は、2026-11-11 に 10 本とも「題名・説明文・更新日・確認日を
 * 除いた frontmatter」が差し替えのときの指紋と一致することを確かめたうえで、
 * 記事から写した。落ちたときに、どの記事のどの項目が変わったかが出るよう、
 * 指紋ではなく値をそのまま書いている。
 *
 * 点数・推奨・関連記事・検索の意図などは、あとの照合・内部リンクの更新・鮮度更新で
 * 正しく変わりうるので固定しない。項目が足されても落とさない。
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const normalizeLf = (value) => String(value || '').replace(/\r\n?/g, '\n');

// 公開した後に変わってはいけない 11 項目。
const PINNED_FIELDS = [
  'slug',
  'category',
  'article_type',
  'customer_segment',
  'source_url',
  'source_title',
  'source_provenance',
  'created_at',
  'publish_at',
  'published_at',
  'pr_number',
];

const EXPECTED = [
  {
    file: '2026-08-26-newseg-construction_solo-construction-consumables-painting-guide.md',
    slug: 'newseg-construction_solo-construction-consumables-painting-guide',
    updated_at: '2026-08-27T12:00:59.141+09:00',
    pinned: {
      slug: 'newseg-construction_solo-construction-consumables-painting-guide',
      category: '帳簿・経費',
      article_type: 'basic_explainer',
      customer_segment: 'construction_solo',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm',
      source_title: '国税庁タックスアンサー No.2210 やさしい必要経費の知識',
      source_provenance: 'curated',
      created_at: '2026-08-26T00:05:52.154Z',
      publish_at: '2026-08-27T11:28:00.000+09:00',
      published_at: '2026-08-27T12:00:59.141+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-07-09-newseg-retail_store-retail-register-sales-guide.md',
    slug: 'newseg-retail_store-retail-register-sales-guide',
    // 2026-11-06 毛利承認で題名・説明文を差し替え（冒頭の答え・商品券の行と現金主義の例外の訂正、reviewed_at 付き）。
    updated_at: '2026-11-06T21:40:00.000+09:00',
    pinned: {
      slug: 'newseg-retail_store-retail-register-sales-guide',
      category: '帳簿・経費',
      article_type: 'basic_explainer',
      customer_segment: 'retail_store',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm',
      source_title: '国税庁タックスアンサー No.2200 収入金額とその計算',
      created_at: '2026-07-09T00:06:47.294Z',
      publish_at: '2026-07-10T11:25:00.000+09:00',
      published_at: '2026-07-10T12:08:53.765+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-06-01-youtube-side-business-withholding-treatment-guide.md',
    slug: 'youtube-side-business-withholding-treatment-guide',
    updated_at: '2026-09-27',
    pinned: {
      slug: 'youtube-side-business-withholding-treatment-guide',
      category: '所得税',
      article_type: 'comparison_decision',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm',
      source_title: '国税庁タックスアンサー No.2792 源泉徴収が必要な報酬・料金',
      created_at: '2026-06-01T00:42:37.042Z',
      publish_at: '2026-06-02T11:05:00.000+09:00',
      published_at: '2026-06-02T11:29:48.556+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-07-23-newseg-content_seller-content-subscription-revenue-guide.md',
    slug: 'newseg-content_seller-content-subscription-revenue-guide',
    updated_at: '2026-10-05T13:45:43.544+09:00',
    pinned: {
      slug: 'newseg-content_seller-content-subscription-revenue-guide',
      category: '所得税',
      article_type: 'basic_explainer',
      customer_segment: 'content_seller',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm',
      source_title: '国税庁タックスアンサー No.2200 収入金額とその計算',
      source_provenance: 'curated',
      created_at: '2026-07-23T00:07:26.372Z',
      publish_at: '2026-07-24T11:54:00.000+09:00',
      published_at: '2026-07-24T12:03:38.662+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-09-10-deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide.md',
    slug: 'deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide',
    updated_at: '2026-09-11T12:00:53.487+09:00',
    pinned: {
      slug: 'deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide',
      category: '消費税',
      article_type: 'basic_explainer',
      customer_segment: 'beauty_salon',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm',
      source_title: '国税庁タックスアンサー No.6505 簡易課税制度',
      source_provenance: 'curated',
      created_at: '2026-09-10T00:05:57.577Z',
      publish_at: '2026-09-11T11:16:00.000+09:00',
      published_at: '2026-09-11T12:00:53.487+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-08-20-deepdive-general_individual_proprietor-lease-transaction-guide.md',
    slug: 'deepdive-general_individual_proprietor-lease-transaction-guide',
    updated_at: '2026-08-21T12:00:57.736+09:00',
    pinned: {
      slug: 'deepdive-general_individual_proprietor-lease-transaction-guide',
      category: '帳簿・経費',
      article_type: 'basic_explainer',
      customer_segment: 'general_business',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5702.htm',
      source_title: 'リース取引についての取扱いの概要(平成20年4月1日以後契約分)',
      source_provenance: 'llm-auto',
      created_at: '2026-08-20T00:06:06.571Z',
      publish_at: '2026-08-21T11:17:00.000+09:00',
      published_at: '2026-08-21T12:00:57.736+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-08-25-newseg-youtuber-youtube-gaming-capture-gaming-guide.md',
    slug: 'newseg-youtuber-youtube-gaming-capture-gaming-guide',
    updated_at: '2026-08-26T12:00:56.199+09:00',
    pinned: {
      slug: 'newseg-youtuber-youtube-gaming-capture-gaming-guide',
      category: '帳簿・経費',
      article_type: 'basic_explainer',
      customer_segment: 'youtuber',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm',
      source_title: '国税庁タックスアンサー No.2100 減価償却のあらまし',
      source_provenance: 'curated',
      created_at: '2026-08-25T00:05:48.995Z',
      publish_at: '2026-08-26T11:34:00.000+09:00',
      published_at: '2026-08-26T12:00:56.199+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-08-21-newseg-retail_store-retail-gift-certificate-practice.md',
    slug: 'newseg-retail_store-retail-gift-certificate-practice',
    // 2026-11-06 毛利承認で題名・説明文を差し替え（冒頭の答え・仕訳例①の金額の訂正、reviewed_at 付き）。
    updated_at: '2026-11-06T18:50:00.000+09:00',
    pinned: {
      slug: 'newseg-retail_store-retail-gift-certificate-practice',
      category: '消費税',
      article_type: 'industry_example',
      customer_segment: 'retail_store',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6229.htm',
      source_title: '国税庁タックスアンサー No.6229 商品券やプリペイドカードなど',
      source_provenance: 'curated',
      created_at: '2026-08-21T00:08:41.038Z',
      publish_at: '2026-08-22T17:23:00.000+09:00',
      published_at: '2026-08-22T18:00:53.975+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-07-30-shopify-growth-overseas-tax-uncertain-practice.md',
    slug: 'shopify-growth-overseas-tax-uncertain-practice',
    updated_at: '2026-09-27',
    pinned: {
      slug: 'shopify-growth-overseas-tax-uncertain-practice',
      category: '消費税',
      article_type: 'industry_example',
      customer_segment: 'ec_seller',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm',
      source_title: '国税庁タックスアンサー No.6551 輸出取引の免税',
      source_provenance: 'curated',
      created_at: '2026-07-30T00:08:55.678Z',
      publish_at: '2026-07-31T17:21:00.000+09:00',
      published_at: '2026-07-31T18:13:59.025+09:00',
      pr_number: '',
    },
  },
  {
    file: '2026-09-12-shitsugi-shohi-26-01.md',
    slug: 'shitsugi-shohi-26-01',
    // 2026-11-06 毛利承認で題名・説明文を差し替え（冒頭に定義を追加、reviewed_at 付き）。
    updated_at: '2026-11-06T18:50:00.000+09:00',
    pinned: {
      slug: 'shitsugi-shohi-26-01',
      category: '消費税',
      article_type: 'case_study',
      customer_segment: 'ec_seller',
      source_url: 'https://www.nta.go.jp/law/shitsugi/shohi/26/01.htm',
      source_title: '特定課税仕入れがある場合の納税義務の判定',
      source_provenance: 'explicit',
      created_at: '2026-09-12T00:05:57.701Z',
      publish_at: '2026-09-13T17:25:00.000+09:00',
      published_at: '2026-09-14T12:00:58.567+09:00',
      pr_number: '',
    },
  },
];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// 記事ごと・項目ごとに、固定の 11 項目が pinned と同じかを返す。
// pinned に無い項目は、記事にも無いこと（足されていないこと）を確かめる。
function checkPinnedFields(data, expected) {
  return PINNED_FIELDS.map(field => {
    if (hasOwn(expected.pinned, field)) {
      return {
        field,
        label: `${expected.slug}: ${field} は差し替えのときから不変`,
        ok: hasOwn(data, field) && data[field] === expected.pinned[field],
      };
    }
    return {
      field,
      label: `${expected.slug}: ${field} は差し替えのときと同じく無い`,
      ok: !hasOwn(data, field),
    };
  });
}

// 更新日は「差し替えのときより前に戻っていない」だけを確かめる。
// 読めない日付（Date.parse が NaN）は落とす。
function updatedNotBefore(data, expected) {
  const actual = Date.parse(data.updated_at);
  const base = Date.parse(expected.updated_at);
  return Number.isFinite(actual) && Number.isFinite(base) && actual >= base;
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const allFiles = fs.readdirSync(POSTS_DIR).filter(file => file.endsWith('.md'));
const parsedByFile = new Map(allFiles.map(file => {
  const source = normalizeLf(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
  return [file, matter(source)];
}));

console.log('=== 1. 対象 ===');
for (const expected of EXPECTED) {
  const hits = [...parsedByFile.entries()].filter(([, parsed]) => parsed.data.slug === expected.slug && parsed.data.review_status === 'published');
  assert(hits.length === 1 && hits[0][0] === expected.file, `${expected.slug}: 公開記事が1本だけ`);
  if (hits.length !== 1) continue;

  const data = hits[0][1].data;
  assert([...String(data.summary || '')].length <= 120, `${expected.slug}: summary が120文字以内`);
  assert(updatedNotBefore(data, expected), `${expected.slug}: 更新日が差し替えのときより前でない`);
}

console.log('');
console.log('=== 2. 公開の後に変わってはいけない項目 ===');
for (const expected of EXPECTED) {
  const parsed = parsedByFile.get(expected.file);
  if (!parsed) {
    assert(false, `${expected.slug}: ${expected.file} がある`);
    continue;
  }
  for (const result of checkPinnedFields(parsed.data, expected)) {
    assert(result.ok, result.label);
  }
}

console.log('\n=== 3. 偽データで変更の検出を確かめる ===');
// 実際の記事に頼らず、固定の 11 項目を全部持つ偽の記事 1 本で確かめる。
const FIXTURE_UPDATED_AT = '2026-09-02T12:00:00.000+09:00';
const fixturePinned = {
  slug: 'fixture-ordinary',
  category: '帳簿・経費',
  article_type: 'basic_explainer',
  customer_segment: 'construction_solo',
  source_url: 'https://example.com/source',
  source_title: '偽の出典',
  source_provenance: 'curated',
  created_at: '2026-09-01T00:00:00.000Z',
  publish_at: '2026-09-02T11:00:00.000+09:00',
  published_at: FIXTURE_UPDATED_AT,
  pr_number: '',
};
const fixtureExpected = {
  file: 'fixture-ordinary.md',
  slug: fixturePinned.slug,
  updated_at: FIXTURE_UPDATED_AT,
  pinned: fixturePinned,
};
function fixtureArticle(overrides) {
  return {
    data: {
      title: '偽の題名',
      summary: '偽の説明文',
      ...fixturePinned,
      customer_fit_score: 4,
      related_slug: 'fixture-related',
      updated_at: FIXTURE_UPDATED_AT,
      ...overrides,
    },
    content: '偽の本文',
  };
}
const failingFields = (parsed, expected = fixtureExpected) => checkPinnedFields(parsed.data, expected)
  .filter(result => !result.ok).map(result => result.field);
const fixtureOk = (parsed, expected = fixtureExpected) => (
  failingFields(parsed, expected).length === 0 && updatedNotBefore(parsed.data, expected)
);

const fixtureBase = fixtureArticle();
assert(fixtureOk(fixtureBase), '偽の記事: そのままなら通る');

const bodyChanged = fixtureArticle();
bodyChanged.content += '変';
assert(fixtureOk(bodyChanged), '偽の記事: 本文を変えても通る');

const titleChanged = fixtureArticle({ title: '別の題名', summary: '別の説明文' });
assert(fixtureOk(titleChanged), '偽の記事: 題名・説明文を変えても通る');

const freshnessAdvanced = fixtureArticle({
  updated_at: '2026-10-05T09:00:00+09:00',
  reviewed_at: '2026-10-05T09:00:00+09:00',
});
assert(fixtureOk(freshnessAdvanced), '偽の記事: 更新日・確認日を進めても通る');

const unpinnedChanged = fixtureArticle({
  customer_fit_score: 1,
  related_slug: 'fixture-other',
  search_intent: '足した項目',
});
assert(fixtureOk(unpinnedChanged), '偽の記事: 固定でない項目を変えても足しても通る');

for (const field of PINNED_FIELDS) {
  const changed = fixtureArticle({ [field]: `${fixturePinned[field]}変更` });
  const failing = failingFields(changed);
  assert(failing.length === 1 && failing[0] === field, `偽の記事: ${field} を変えると落ちる`);
}

for (const field of PINNED_FIELDS) {
  const deleted = fixtureArticle();
  delete deleted.data[field];
  const failing = failingFields(deleted);
  assert(failing.length === 1 && failing[0] === field, `偽の記事: ${field} を消すと落ちる`);
}

const pinnedWithoutProvenance = { ...fixturePinned };
delete pinnedWithoutProvenance.source_provenance;
const addedPinnedField = fixtureArticle();
const addedFailing = failingFields(addedPinnedField, { ...fixtureExpected, pinned: pinnedWithoutProvenance });
assert(addedFailing.length === 1 && addedFailing[0] === 'source_provenance', '偽の記事: pinned に無い固定の項目を足すと落ちる');

const olderUpdate = fixtureArticle({ updated_at: '2026-08-01T12:00:00+09:00' });
assert(!updatedNotBefore(olderUpdate.data, fixtureExpected), '偽の記事: 更新日を基準より前に戻すと落ちる');

const unreadableUpdate = fixtureArticle({ updated_at: '不正' });
assert(!updatedNotBefore(unreadableUpdate.data, fixtureExpected), '偽の記事: 読めない更新日は落ちる');

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
