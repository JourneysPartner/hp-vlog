'use strict';
/**
 * 検索結果向けの題名・説明文差し替え（クロール改善 09）
 *
 * 対象10本の title / summary と、それ以外の frontmatter・本文が
 * 変更されていないことを確認する。
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
  },
  {
    file: '2026-07-09-newseg-retail_store-retail-register-sales-guide.md',
    slug: 'newseg-retail_store-retail-register-sales-guide',
    title: 'レジの現金過不足の仕訳と勘定科目｜小売店のレジ売上（現金・カード・電子マネー）の計上方法',
    summary: 'レジの現金過不足は原因を確認したうえで雑収入・雑損失で処理します。レジ売上は販売時点で計上し、現金・クレジットカード・電子マネーで仕訳が変わります。仕訳例で解説。',
    updated_at: '2026-07-10T12:08:53.765+09:00',
  },
  {
    file: '2026-06-01-youtube-side-business-withholding-treatment-guide.md',
    slug: 'youtube-side-business-withholding-treatment-guide',
    title: 'YouTubeの収入に源泉徴収はある？AdSenseは原則なし・PR案件はあり｜副業の確定申告での処理',
    summary: 'YouTubeの広告収入（AdSense）は原則源泉徴収なし、PR案件の報酬は支払者が源泉徴収する場合があります。副業の確定申告でどう精算するかを整理します。',
    updated_at: '2026-09-27',
  },
  {
    file: '2026-07-23-newseg-content_seller-content-subscription-revenue-guide.md',
    slug: 'newseg-content_seller-content-subscription-revenue-guide',
    title: 'オンラインサロン・サブスク収入の勘定科目と経費｜確定申告での所得区分と計上時期',
    summary: 'オンラインサロンやサブスクの会費収入は受取月ごとに計上。勘定科目、経費にできる範囲、事業所得か雑所得かの判断を、運営者の側から整理します。',
    updated_at: '2026-07-24T12:03:38.662+09:00',
  },
  {
    file: '2026-09-10-deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide.md',
    slug: 'deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide',
    title: '美容室の簡易課税は第何種？みなし仕入率50%と原則課税の有利判定',
    summary: '美容室・美容サロンは簡易課税の第5種（みなし仕入率50%）。課税仕入れの割合が50%を下回るなら簡易課税が有利、大型の設備投資がある年は原則課税で還付になることも。判定の手順を解説。',
    updated_at: '2026-09-11T12:00:53.487+09:00',
  },
  {
    file: '2026-08-20-deepdive-general_individual_proprietor-lease-transaction-guide.md',
    slug: 'deepdive-general_individual_proprietor-lease-transaction-guide',
    title: 'リース料の勘定科目と経費処理｜売買処理か賃貸借処理かの判断基準（フルペイアウト・中途解約不可）',
    summary: 'リース契約の経理処理は「売買処理」か「賃貸借処理」かで大きく異なります。中途解約不可・フルペイアウトの2要件を満たすと資産計上が必要になります。判断基準と仕訳の考え方を解説します。',
    updated_at: '2026-08-21T12:00:57.736+09:00',
  },
  {
    file: '2026-08-25-newseg-youtuber-youtube-gaming-capture-gaming-guide.md',
    slug: 'newseg-youtuber-youtube-gaming-capture-gaming-guide',
    title: 'ゲーム機・配信機材は経費にできる？ゲーム実況をする個人事業主の減価償却と少額特例',
    summary: 'ゲーム機・キャプチャボード・配信用PCは、業務に使う分が経費。10万円未満は全額その年の経費、10万円以上は少額特例・一括償却・減価償却の3通りに分かれます。',
    updated_at: '2026-08-26T12:00:56.199+09:00',
  },
  {
    file: '2026-08-21-newseg-retail_store-retail-gift-certificate-practice.md',
    slug: 'newseg-retail_store-retail-gift-certificate-practice',
    title: '商品券・ギフトカードの消費税はどうなる？発行・譲渡・使用時の扱いと売上計上の仕訳',
    summary: '商品券・ギフトカードで代金を受け取ったとき、売上は「商品を渡した時点」で計上し、消費税も同じタイミングで発生します。商品券の発行は不課税（課税対象外）、譲渡は非課税と扱いが異なる点にも注意が必要です。',
    updated_at: '2026-08-22T18:00:53.975+09:00',
  },
  {
    file: '2026-07-30-shopify-growth-overseas-tax-uncertain-practice.md',
    slug: 'shopify-growth-overseas-tax-uncertain-practice',
    title: 'Shopifyの海外販売と消費税｜売上は輸出免税でゼロ、仕入や手数料の控除はどうなる？具体例で解説',
    summary: 'Shopifyで海外の消費者に販売した売上は輸出免税で消費税がかかりません。ただし帳簿と証拠書類の保存が条件で、仕入や手数料の消費税を控除し損ねる記帳ミスが多い点を具体例で解説。',
    updated_at: '2026-09-27',
  },
  {
    file: '2026-09-12-shitsugi-shohi-26-01.md',
    slug: 'shitsugi-shohi-26-01',
    title: '特定課税仕入れとは？リバースチャージで申告した支払いは課税売上高に入るのか（納税義務判定の落とし穴）',
    summary: '国外事業者からの特定課税仕入れ（リバースチャージ）の支払対価は、納税義務判定の基準期間における課税売上高に含まれない。消費税の申告・納税を行っていても、判定上は「仕入れ」であり「売上」ではないため。',
    updated_at: '2026-09-14T12:00:58.567+09:00',
  },
];

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
  assert(data.updated_at === expected.updated_at, `${expected.slug}: updated_at が不変`);
  assert([...String(data.summary || '')].length <= 120, `${expected.slug}: summary が120文字以内`);
}

console.log('');
console.log('=== 2. 本文とその他の frontmatter ===');
{
  const stable = EXPECTED.map(expected => {
    const parsed = parsedByFile.get(expected.file);
    const data = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key !== 'title' && key !== 'summary') data[key] = value;
    }
    return { file: expected.file, data, body: parsed.content };
  });
  const hash = crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  assert(hash === '900dc84b898805101cf0b66e5ff1cfdec43871577cc549fdb0f5faf2181d8f0e', '本文・slug・日付・出典など title / summary 以外が不変');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
