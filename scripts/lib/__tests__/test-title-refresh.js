'use strict';
/**
 * 検索結果向けの題名・説明文差し替え（クロール改善 09）
 *
 * 対象10本の title / summary と、それ以外の frontmatter・本文が
 * 変更されていないことを確認する。鮮度更新済みの記事は更新日と本文の変更を許容する。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const normalizeLf = (value) => String(value || '').replace(/\r\n?/g, '\n');

const EXPECTED = [
  {
    file: '2026-08-26-newseg-construction_solo-construction-consumables-painting-guide.md',
    slug: 'newseg-construction_solo-construction-consumables-painting-guide',
    title: '塗料・ペンキの勘定科目は？塗装工の消耗品費・材料費の分け方と年末在庫の処理',
    summary: '塗料・ペンキ・シンナー・刷毛の勘定科目は消耗品費か材料費か。使い切った分だけが経費で、年末に残った分は棚卸資産にして翌年へ繰り越します。仕訳例つき。',
    updated_at: '2026-08-27T12:00:59.141+09:00',
    fullHash: 'f7048ea7bf36039891ce793c0fd0e59cb41ea3f04660e194c9f0de05281e7278',
    freshHash: 'b67505bf3fe3f1ce7e46fce888499661e48a6f35977c669cf20e4eee4302dc17',
  },
  {
    file: '2026-07-09-newseg-retail_store-retail-register-sales-guide.md',
    slug: 'newseg-retail_store-retail-register-sales-guide',
    title: 'レジの現金過不足の仕訳と勘定科目｜小売店のレジ売上（現金・カード・電子マネー）の計上方法',
    summary: 'レジの現金過不足は原因を確認したうえで雑収入・雑損失で処理します。レジ売上は販売時点で計上し、現金・クレジットカード・電子マネーで仕訳が変わります。仕訳例で解説。',
    updated_at: '2026-07-10T12:08:53.765+09:00',
    fullHash: '2fbd5773edc71ebf36613f5021f6b8fc2364650fafe1c1bf79165ebe54f67af9',
    freshHash: '87eda08d69ccc1ada36ae7f5b9446c41c4f4805d9b6dca73c8b10503a0d16190',
  },
  {
    file: '2026-06-01-youtube-side-business-withholding-treatment-guide.md',
    slug: 'youtube-side-business-withholding-treatment-guide',
    title: 'YouTubeの収入に源泉徴収はある？AdSenseは原則なし・PR案件はあり｜副業の確定申告での処理',
    summary: 'YouTubeの広告収入（AdSense）は原則源泉徴収なし、PR案件の報酬は支払者が源泉徴収する場合があります。副業の確定申告でどう精算するかを整理します。',
    updated_at: '2026-09-27',
    fullHash: 'a209d5a6339d583d8eaba0f96fa10a4f078cd3b921d8829c7c2978336b4f99b3',
    freshHash: '702e17fb287bd3036b8cfe4280b17f8caf540d510a3dac5f72fc39948ef1afbe',
  },
  {
    file: '2026-07-23-newseg-content_seller-content-subscription-revenue-guide.md',
    slug: 'newseg-content_seller-content-subscription-revenue-guide',
    title: 'オンラインサロン・サブスク収入の勘定科目と経費｜確定申告での所得区分と計上時期',
    summary: 'オンラインサロンやサブスクの会費収入は受取月ごとに計上。勘定科目、経費にできる範囲、事業所得か雑所得かの判断を、運営者の側から整理します。',
    updated_at: '2026-07-24T12:03:38.662+09:00',
    fullHash: '621c572c182c4b39b330bd03e5410d68fa21ba48274c65a4266cf39d65a47eb6',
    freshHash: 'bdfacfba6e72f035193d34cd14c7278a9f5f66c80724641c7597458cf45889a5',
  },
  {
    file: '2026-09-10-deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide.md',
    slug: 'deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide',
    title: '美容室の簡易課税は第何種？みなし仕入率50%と原則課税の有利判定',
    summary: '美容室・美容サロンは簡易課税の第5種（みなし仕入率50%）。課税仕入れの割合が50%を下回るなら簡易課税が有利、大型の設備投資がある年は原則課税で還付になることも。判定の手順を解説。',
    updated_at: '2026-09-11T12:00:53.487+09:00',
    fullHash: '13d06d1919bfca5dd9c6fca26597c9ca65870f6319623f98ccfc9898e464aa1b',
    freshHash: 'c68ac26bdf9dd9c829e540e98393b808cebac5b9bb9cdb385c99ec6c8e58864d',
  },
  {
    file: '2026-08-20-deepdive-general_individual_proprietor-lease-transaction-guide.md',
    slug: 'deepdive-general_individual_proprietor-lease-transaction-guide',
    title: 'リース料の勘定科目と経費処理｜売買処理か賃貸借処理かの判断基準（フルペイアウト・中途解約不可）',
    summary: 'リース契約の経理処理は「売買処理」か「賃貸借処理」かで大きく異なります。中途解約不可・フルペイアウトの2要件を満たすと資産計上が必要になります。判断基準と仕訳の考え方を解説します。',
    updated_at: '2026-08-21T12:00:57.736+09:00',
    fullHash: '426b8a46954abc80036f724a49e33105e2a041009690f4498927ac21e88742bf',
    freshHash: 'c56fc52dfd266784f31ed5a9808e462447cb76a1519ba583224d269e3ad5ab51',
  },
  {
    file: '2026-08-25-newseg-youtuber-youtube-gaming-capture-gaming-guide.md',
    slug: 'newseg-youtuber-youtube-gaming-capture-gaming-guide',
    title: 'ゲーム機・配信機材は経費にできる？ゲーム実況をする個人事業主の減価償却と少額特例',
    summary: 'ゲーム機・キャプチャボード・配信用PCは、業務に使う分が経費。10万円未満は全額その年の経費、10万円以上は少額特例・一括償却・減価償却の3通りに分かれます。',
    updated_at: '2026-08-26T12:00:56.199+09:00',
    fullHash: '0a97740972a27fc6b55a07268419c50cea6f0bac2b4c346916abccd9b70ca794',
    freshHash: '4b873b0276f7a2b9e5fa2e4fd461e3707ec77585e9030264877337b612071e71',
  },
  {
    file: '2026-08-21-newseg-retail_store-retail-gift-certificate-practice.md',
    slug: 'newseg-retail_store-retail-gift-certificate-practice',
    title: '商品券・ギフトカードの消費税はどうなる？発行・譲渡・使用時の扱いと売上計上の仕訳',
    summary: '商品券・ギフトカードで代金を受け取ったとき、売上は「商品を渡した時点」で計上し、消費税も同じタイミングで発生します。商品券の発行は不課税（課税対象外）、譲渡は非課税と扱いが異なる点にも注意が必要です。',
    updated_at: '2026-08-22T18:00:53.975+09:00',
    fullHash: '5a3b36f39caabcdbe9a5924ef17436130daefc1ffc1c8599de9f94603ac378b5',
    freshHash: '37341fe8439efa8f91c7cefba60b97c89a2b644476907b50e50f35994af63347',
  },
  {
    file: '2026-07-30-shopify-growth-overseas-tax-uncertain-practice.md',
    slug: 'shopify-growth-overseas-tax-uncertain-practice',
    title: 'Shopifyの海外販売と消費税｜売上は輸出免税でゼロ、仕入や手数料の控除はどうなる？具体例で解説',
    summary: 'Shopifyで海外の消費者に販売した売上は輸出免税で消費税がかかりません。ただし帳簿と証拠書類の保存が条件で、仕入や手数料の消費税を控除し損ねる記帳ミスが多い点を具体例で解説。',
    updated_at: '2026-09-27',
    fullHash: 'c21c166f1d441ee383fef540abbf1d5648c804e7198fc1a76815e0b88e432672',
    freshHash: '2abdad1a3101d53dec56d1f07ca9000ea428df3c145abba37234da97769dfffd',
  },
  {
    file: '2026-09-12-shitsugi-shohi-26-01.md',
    slug: 'shitsugi-shohi-26-01',
    title: '特定課税仕入れとは？リバースチャージで申告した支払いは課税売上高に入るのか（納税義務判定の落とし穴）',
    summary: '国外事業者からの特定課税仕入れ（リバースチャージ）の支払対価は、納税義務判定の基準期間における課税売上高に含まれない。消費税の申告・納税を行っていても、判定上は「仕入れ」であり「売上」ではないため。',
    updated_at: '2026-09-14T12:00:58.567+09:00',
    fullHash: '77790532f371f739022ccc11f8e0a3ee8d5c6ea42f744dda221e0a2698b03b5c',
    freshHash: '33fb6c37a51984fa98bf0fd6b953a6452b9e303ca9daf89dcad7876f07a2758c',
  },
];

// 基準 700de4ab。旧まとめハッシュの一致を確認したうえで 1 本ずつ計算。
// CRLF/CR を LF に正規化して gray-matter で読み、キーの挿入順を保って
// title・summary を除いた { file, data, body } を JSON 化し SHA-256 にする。
// 鮮度更新用は updated_at・reviewed_at も除き、{ file, data } を同様にハッシュ化。
function isFreshnessUpdated(data) {
  return !!data.reviewed_at && data.updated_at === data.reviewed_at
    && Date.parse(data.reviewed_at) >= Date.parse('2026-09-28T00:00:00+09:00');
}

function stableHash(parsed, file, fresh) {
  const data = {};
  const omitted = fresh ? ['title', 'summary', 'updated_at', 'reviewed_at'] : ['title', 'summary'];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!omitted.includes(key)) data[key] = value;
  }
  const stable = fresh ? { file, data } : { file, data, body: normalizeLf(parsed.content) };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function checkStableArticle(parsed, expected) {
  const fresh = isFreshnessUpdated(parsed.data);
  return {
    fresh,
    updatedOk: fresh ? Date.parse(parsed.data.updated_at) > Date.parse(expected.updated_at)
      : parsed.data.updated_at === expected.updated_at,
    stableOk: stableHash(parsed, expected.file, fresh) === (fresh ? expected.freshHash : expected.fullHash),
  };
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

console.log('=== 1. 対象と frontmatter ===');
for (const expected of EXPECTED) {
  const hits = [...parsedByFile.entries()].filter(([, parsed]) => parsed.data.slug === expected.slug && parsed.data.review_status === 'published');
  assert(hits.length === 1 && hits[0][0] === expected.file, `${expected.slug}: 公開記事が1本だけ`);
  if (hits.length !== 1) continue;

  const data = hits[0][1].data;
  assert(data.title === expected.title, `${expected.slug}: title が指定値`);
  assert(data.summary === expected.summary, `${expected.slug}: summary が指定どおり`);
  const stable = checkStableArticle(hits[0][1], expected);
  assert(stable.updatedOk, `${expected.slug}: 更新日が不変または鮮度更新で新しくなった`);
  assert([...String(data.summary || '')].length <= 120, `${expected.slug}: summary が120文字以内`);
}

console.log('');
console.log('=== 2. 本文とその他の frontmatter ===');
for (const expected of EXPECTED) {
  const stable = checkStableArticle(parsedByFile.get(expected.file), expected);
  assert(stable.stableOk, expected.slug + ': ' + (stable.fresh
    ? '鮮度更新でも slug・日付・出典・公開日時などは不変' : '本文と title / summary 以外は不変'));
}

console.log('\n=== 3. 偽データで変更検出を確認 ===');
const fixturePassed = passed, fixtureFailed = failed;
const clone = parsed => ({ data: { ...parsed.data }, content: parsed.content });
function chooseOrdinaryArticle(expectedArticles, articles) {
  const expected = expectedArticles.find(item => !isFreshnessUpdated(articles.get(item.file).data));
  if (expected) return { expected, parsed: clone(articles.get(expected.file)) };
  // 対象がすべて更新された後も、未更新記事の変更検出を偽データで確かめる。
  const file = 'fixture-ordinary.md';
  const parsed = { data: { slug: 'fixture-ordinary', updated_at: '2026-09-01', source_url: 'https://example.com/source', published_at: '2026-09-01' }, content: '偽の未更新本文' };
  return { parsed, expected: { file, updated_at: parsed.data.updated_at,
    fullHash: stableHash(parsed, file, false), freshHash: stableHash(parsed, file, true) } };
}
const { expected: ordinary, parsed: base } = chooseOrdinaryArticle(EXPECTED, parsedByFile);
assert(!isFreshnessUpdated(base.data) && checkStableArticle(base, ordinary).stableOk, '未更新記事を探し、無ければ偽の未更新記事を使う');
const sampleFiles = new Map(['first.md', 'second.md'].map(file => [file, clone(base)]));
sampleFiles.get('first.md').data.updated_at = sampleFiles.get('first.md').data.reviewed_at = '2026-10-05T09:00:00+09:00';
assert(chooseOrdinaryArticle([{ file: 'first.md' }, { file: 'second.md' }], sampleFiles).expected.file === 'second.md', '先頭記事が更新済みなら後ろの未更新記事を選ぶ');
sampleFiles.get('second.md').data.updated_at = sampleFiles.get('second.md').data.reviewed_at = '2026-10-05T09:00:00+09:00';
const synthetic = chooseOrdinaryArticle([{ file: 'first.md' }, { file: 'second.md' }], sampleFiles);
assert(!isFreshnessUpdated(synthetic.parsed.data) && checkStableArticle(synthetic.parsed, synthetic.expected).stableOk, '全記事が更新済みでも偽の未更新記事で検証できる');
const syntheticChanged = clone(synthetic.parsed);
syntheticChanged.content += '変';
assert(!checkStableArticle(syntheticChanged, synthetic.expected).stableOk, '全記事更新後の偽記事でも本文 1 文字の変更を検出');
const syntheticFresh = clone(synthetic.parsed);
syntheticFresh.data.updated_at = syntheticFresh.data.reviewed_at = '2026-10-05T09:00:00+09:00';
syntheticFresh.content += '更新本文';
assert(checkStableArticle(syntheticFresh, synthetic.expected).stableOk && checkStableArticle(syntheticFresh, synthetic.expected).updatedOk, '全記事更新後の偽記事でも鮮度更新を許容');
const changed = clone(base);
changed.content += '変';
assert(!checkStableArticle(changed, ordinary).stableOk, '未更新記事の本文 1 文字の変更は失敗');
const fresh = clone(base);
fresh.data.updated_at = fresh.data.reviewed_at = '2026-10-05T09:00:00+09:00';
fresh.content += '更新本文';
assert(checkStableArticle(fresh, ordinary).stableOk && checkStableArticle(fresh, ordinary).updatedOk, '鮮度更新済みの本文変更は成功');
for (const field of ['source_url', 'published_at']) {
  const altered = clone(fresh);
  altered.data[field] = '変更';
  assert(!checkStableArticle(altered, ordinary).stableOk, '鮮度更新済みでも ' + field + ' の変更は失敗');
}
const reviewed = clone(base);
reviewed.data.reviewed_at = '2026-10-05T09:00:00+09:00';
const reviewedExpected = { ...ordinary, fullHash: stableHash(reviewed, ordinary.file, false) };
assert(!isFreshnessUpdated(reviewed.data) && checkStableArticle(reviewed, reviewedExpected).stableOk, '更新日と異なる確認日は全体の検証対象');
reviewed.content += '変';
assert(!checkStableArticle(reviewed, reviewedExpected).stableOk, '確認日だけある記事の本文変更は失敗');
assert(!isFreshnessUpdated({ updated_at: '2026-09-27', reviewed_at: '2026-09-27' }), '差し替えより前の確認日は鮮度更新扱いしない');
assert(!isFreshnessUpdated({ updated_at: '不正', reviewed_at: '不正' }), '不正な日時は鮮度更新扱いしない');
const oldUpdate = clone(fresh);
const sameDateExpected = { ...ordinary, updated_at: oldUpdate.data.updated_at };
assert(!checkStableArticle(oldUpdate, sameDateExpected).updatedOk, '鮮度更新の更新日は基準より新しい必要がある');
console.log(`F5: PASS: ${passed - fixturePassed} / FAIL: ${failed - fixtureFailed}`);

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
