'use strict';

/**
 * 法令カタログ（e-Gov 由来）の読み出しと、相続の手続き段階 → 根拠の対応表のテスト。
 *   node scripts/lib/__tests__/test-law-sources.js
 *
 * 背景（2026-09-08）: 逝去直後の手続きの記事は国税庁に出典が無く確信度0.55で止まった。
 *   民法・戸籍法・不動産登記法などを e-Gov から条単位で持ち、段階ごとに根拠条文と
 *   手続き機関ページを渡せるようにした。ここでは「対応表が指す条が実在すること」を固定する
 *   （条番号の書き間違いは、そのまま捏造した出典になる）。
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const law = require(path.join(ROOT, 'scripts/lib/law-sources'));
const { collectArticles } = require(path.join(ROOT, 'scripts/crawl-law-sources'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else      { console.error(`  NG ${label}`); failed++; }
}

console.log('=== 条番号の表記ゆれ ===');
assert(law.normalizeArticleNum('第九百九条の二') === '909_2', '漢数字「第九百九条の二」→ 909_2');
assert(law.normalizeArticleNum('909の2') === '909_2' && law.normalizeArticleNum('７６条の２') === '76_2', '算用数字・全角も同じ鍵');
assert(law.kanjiToArabic('千四十二') === '1042' && law.kanjiToArabic('十') === '10', '千・十の位を正しく読む');
assert(law.articleLabel('909_2') === '909条の2' && law.articleLabel('86') === '86条', '表示は「909条の2」');

console.log('');
console.log('=== e-Gov 応答の木から条を取り出す（固定データ）===');
const tree = {
  tag: 'Chapter', attr: { Num: '1' }, children: [
    { tag: 'ChapterTitle', attr: {}, children: ['第一章　総則'] },
    { tag: 'Article', attr: { Num: '882' }, children: [
      { tag: 'ArticleCaption', attr: {}, children: ['（相続開始の原因）'] },
      { tag: 'ArticleTitle', attr: {}, children: ['第八百八十二条'] },
      { tag: 'Paragraph', attr: { Num: '1' }, children: [
        { tag: 'ParagraphNum', attr: {}, children: [] },
        { tag: 'ParagraphSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['相続は、死亡によって開始する。'] }] },
      ] },
    ] },
    { tag: 'Article', attr: { Num: '887' }, children: [
      { tag: 'ArticleTitle', attr: {}, children: ['第八百八十七条'] },
      { tag: 'Paragraph', attr: { Num: '1' }, children: [
        { tag: 'ParagraphSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['被相続人の子は、相続人となる。'] }] },
        { tag: 'Item', attr: { Num: '1' }, children: [
          { tag: 'ItemTitle', attr: {}, children: ['一'] },
          { tag: 'ItemSentence', attr: {}, children: [{ tag: 'Sentence', attr: {}, children: ['六親等内の血族'] }] },
        ] },
      ] },
    ] },
  ],
};
const arts = collectArticles(tree);
assert(arts.length === 2 && arts[0].num === '882' && arts[1].num === '887', '条番号を attr.Num から取る');
assert(arts[0].caption === '相続開始の原因' && arts[0].text === '相続は、死亡によって開始する。', '見出しの括弧を外し、本文は文だけ');
assert(arts[1].text.includes('一　六親等内の血族'), '号は番号と本文を並べる');
assert(arts[0].path === '第一章　総則', '編・章の見出しを path に持つ');

console.log('');
console.log('=== カタログの実体 ===');
for (const [key, def] of Object.entries(law.LAWS)) {
  const data = law.loadLaw(key);
  assert(data && data.title === def.title && data.article_count > 0 && data.amendment_enforcement_date,
    `${def.title}: カタログにあり、最終改正施行日を持つ（${data ? data.article_count : 0} 条）`);
}
const a = law.getArticle('minpo', '第九百十五条');
assert(a && a.text.includes('三箇月以内'), '民法915条（熟慮期間 3か月）が引ける');
assert(law.getArticle('koseki', '86') && law.getArticle('koseki', '86').text.includes('七日以内'), '戸籍法86条（死亡届 7日以内）が引ける');
assert(law.getArticle('minpo', '725') && law.getArticle('minpo', '725').text.includes('六親等内の血族'), '民法725条（親族の範囲）が引ける');
assert(law.getArticle('minpo', '9999') === null, '存在しない条は null');

console.log('');
console.log('=== 対応表が指す条と機関ページが実在する ===');
const allRefs = { ...law.STAGE_REFS, ...law.PAIN_REFS, ...law.LIFE_STAGE_REFS };
assert(Object.keys(law.LIFE_STAGE_REFS).length === 9, '相続の9つの時期すべてに根拠がある');
for (const [stage, ref] of Object.entries(allRefs)) {
  const missing = [];
  for (const [key, nums] of ref.laws) for (const n of nums) if (!law.getArticle(key, n)) missing.push(`${key}:${n}`);
  const badPages = ref.pages.filter(p => !law.AGENCY_PAGES[p]);
  assert(missing.length === 0 && badPages.length === 0,
    `${stage}: 条 ${ref.laws.reduce((s, [, ns]) => s + ns.length, 0)} 件・ページ ${ref.pages.length} 件がすべて実在` +
    (missing.length ? `（無い条: ${missing.join(', ')}）` : '') + (badPages.length ? `（無いページ: ${badPages.join(', ')}）` : ''));
}
for (const [k, p] of Object.entries(law.AGENCY_PAGES)) {
  assert(/^https:\/\/(www\.nenkin\.go\.jp|www\.moj\.go\.jp|houmukyoku\.moj\.go\.jp)\//.test(p.url) && p.agency && p.title,
    `${k}: 公的ドメインで agency/title を持つ`);
}

console.log('');
console.log('=== 段階から根拠を引く ===');
const r = law.refsForTopic({ procedure_stage: 'initial-immediate' });
assert(r.articles.some(x => x.key === 'koseki' && x.num === '86') && r.articles.some(x => x.key === 'minpo' && x.num === '915'),
  '初動: 戸籍法86条と民法915条が付く');
assert(r.pages.some(p => p.agency === '法務省') && r.pages.some(p => p.agency === '日本年金機構'), '初動: 法務省と年金機構のページが付く');
const life = law.refsForTopic({ life_stage: 'pre-planning' });
assert(life.articles.some(x => x.num === '1042'), 'procedure_stage が無ければ life_stage で引く（生前準備 → 遺留分1042条）');
assert(law.refsForTopic({ procedure_stage: 'quasi-final-return' }).articles.length === 0, '準確定申告は法令を付けない（国税庁出典で足りる）');
assert(law.refsForTopic({}).articles.length === 0, '段階が無ければ何も付けない');

const block = law.buildLawProvisionBlock(r.articles);
assert(block.includes('【戸籍法】第86条') && block.includes('最終改正施行') && block.includes('ここに無い条番号を書かない'),
  '条文ブロックは法令名・条・改正日・捏造禁止を含む');
const pagesBlock = law.buildAgencyPagesBlock(r.pages);
assert(pagesBlock.includes('特定の市区町村の運用は書かず') && pagesBlock.includes('nenkin.go.jp'), '機関ページのブロックは市区町村固有の運用を書かせない');
assert(law.buildLawProvisionBlock([]) === '' && law.buildAgencyPagesBlock([]) === '', '該当なしなら空文字');

console.log('');
console.log('=== 本文の引用をカタログと照合 ===');
const cites = law.findLawCitations('民法第915条により3か月以内。民法909条の2で仮払い。戸籍法86条。不動産登記法第76条の2。民法第9999条は存在しない。');
const byId = Object.fromEntries(cites.map(c => [`${c.key}:${c.num}`, c.found]));
assert(byId['minpo:915'] === true && byId['minpo:909_2'] === true && byId['koseki:86'] === true && byId['fudosan_toki:76_2'] === true,
  '実在する条は found=true');
assert(byId['minpo:9999'] === false, '存在しない条番号は found=false（捏造検出）');
assert(law.articlesForCitations(cites).length === 4, '実在する引用だけ原文を集める');

console.log('');
console.log('=== 国税庁に該当ページが無い論点の主出典 ===');
const primary = law.primarySourceFor({ procedure_stage: 'initial-immediate' });
assert(primary && primary.url === 'https://laws.e-gov.go.jp/law/322AC0000000224#Mp-At_86' && primary.provenance === 'law-catalog' && primary.confidence === 1,
  '初動の主出典は戸籍法86条の e-Gov ページ（provenance=law-catalog・確信度1）');
assert(primary.title.includes('戸籍法') && primary.title.includes('第86条') && primary.title.includes('e-Gov'), '出典名は法令名・条・e-Gov を含む');
assert(law.primarySourceFor({ procedure_stage: 'quasi-final-return' }) === null && law.primarySourceFor({}) === null,
  '根拠条文の無い段階は差し替えない（null）');
assert(law.lawPageUrl('minpo', '909の2') === 'https://laws.e-gov.go.jp/law/129AC0000000089#Mp-At_909_2', '条へのアンカーは #Mp-At_<番号>');

const sa = require(path.join(ROOT, 'scripts/lib/source-alignment'));
const ok = sa.checkSourceAlignment({ source_url: primary.url, source_title: primary.title, source_provenance: 'law-catalog', tax_domain: 'inheritance_tax' });
assert(ok.needs_source_review === false && ok.aligned === true, '法令カタログの出典は「人の確認が必要」にならない');
const notCatalogued = sa.checkSourceAlignment({ source_url: 'https://laws.e-gov.go.jp/law/999AC9999999999', source_provenance: 'law-catalog', tax_domain: 'inheritance_tax' });
assert(notCatalogued.needs_source_review === true, 'カタログ未収録の法令 URL は従来どおり確認が要る');
const { isOfficialDomain } = require(path.join(ROOT, 'scripts/lib/official-sources'));
assert(isOfficialDomain(primary.url), 'e-Gov は公的ドメインとして扱う');

console.log('');
console.log('=== 選定時の適合判定: 法令に根拠がある段階は「出典未確定」で保留しない ===');
const { evaluateTopicFit } = require(path.join(ROOT, 'scripts/lib/customer-relevance'));
const gridTopic = {
  slug: 'inheritance-after-filing-rental-property-amendment-needed-guide',
  persona: 'inheritance_client', category: '相続', tax_domain: 'inheritance_tax', macro: '相続贈与',
  cluster: 'inheritance', subcluster: 'after-filing-amendment-return', customer_segment: 'inheritance_gift',
  life_stage: 'after-filing', procedure_stage: 'amendment-return', pain_point: '',
  article_type: 'basic_explainer',
  search_intent: '相続税の申告後に賃貸物件の評価誤りが分かったとき、修正申告が必要かを整理したい',
  reader_problem: '申告後に評価の誤りに気づいたが、修正申告・更正の請求のどちらが必要か分からない',
  primary_question: '相続税の申告後に賃貸物件の評価誤りが分かったら修正申告は必要？',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm',
  source_title: '国税庁タックスアンサー No.4152 相続税の計算',
  source_provenance: 'domain-fallback', source_confidence: 0,
};
const fitLaw = evaluateTopicFit(gridTopic);
assert(fitLaw.decision !== 'revise' || !/出典/.test(fitLaw.reason || ''),
  `根拠条文（相続税法31・32条）がある段階は出典未確定を理由に revise にしない（decision=${fitLaw.decision}）`);
assert(/法令カタログに根拠条文あり/.test(fitLaw.source_alignment_reason || ''), '理由に法令カタログの根拠が示される');
const fitNoLaw = evaluateTopicFit({ ...gridTopic, procedure_stage: 'quasi-final-return', life_stage: '' });
assert(fitNoLaw.decision === 'revise' && /出典/.test(fitNoLaw.reason || ''),
  '根拠条文の無い段階は従来どおり出典未確定で revise');

console.log('');
console.log('=== 租税特別措置法: タックスアンサーの要約で落ちる要件が条文で拾えること ===');

// 2026-09-10: 交際費の記事で、タックスアンサー No.5265 の「計算方法」欄が
// 50% 特例の対象を「飲食費」とだけ書いており、条文が求める帳簿記載要件が落ちた。
// 条文をカタログに持ち、原文をプロンプトに渡せることを固定する。
const a614 = law.getArticle('sozeki_hou', '61_4');
assert(a614 && a614.caption === '交際費等の損金不算入', '措法61条の4が引ける');
assert(a614 && /その旨につき財務省令で定めるところにより明らかにされているもの/.test(a614.text),
  '50%特例の対象（接待飲食費）の帳簿記載要件が条文に含まれる');
assert(a614 && /財務省令で定める書類を保存している場合に限り/.test(a614.text),
  '1人1万円以下の除外に必要な書類保存要件（8項）が条文に含まれる');

const a375 = law.getArticle('sozeki_rei', '37_5');
assert(a375 && /一万円/.test(a375.text), '措令37条の5に1人1万円の基準がある');
assert(a375 && (a375.text.match(/通常要する費用/g) || []).length === 3,
  '措令37条の5第2項の3項目とも「通常要する費用」で限定されている');

for (const n of ['25_2', '28_2', '39', '40', '67_5', '69_4', '70', '70_2_2']) {
  assert(!!law.getArticle('sozeki_hou', n), `措法第${law.articleLabel(n)}がカタログにある`);
}

console.log('');
console.log('=== 略称でも正式名称でも引用を照合できる ===');

const citeMap = (text) => Object.fromEntries(law.findLawCitations(text).map(c => [`${c.key}:${c.num}`, c.found]));
assert(citeMap('措法61条の4により')['sozeki_hou:61_4'] === true, '略称「措法61条の4」を拾う');
assert(citeMap('租税特別措置法第61条の4により')['sozeki_hou:61_4'] === true, '正式名称「租税特別措置法第61条の4」を拾う');
assert(citeMap('措令37条の5')['sozeki_rei:37_5'] === true, '略称「措令37条の5」を拾う');
// 「租税特別措置法施行令」を「租税特別措置法」より先に判定しないと、施行令の条が法の条として誤判定される
const full = citeMap('租税特別措置法施行令第37条の5');
assert(full['sozeki_rei:37_5'] === true && full['sozeki_hou:37_5'] === undefined,
  '「租税特別措置法施行令」は施行令として判定される（法と取り違えない）');
assert(citeMap('措法99条の9')['sozeki_hou:99_9'] === false, 'カタログに無い措法の条番号は found=false（捏造検出）');

console.log('');
console.log('=== 交際費の論点から条文が渡ること ===');

const ent = law.refsForTopic({ pain_point: 'entertainment-expense-deduction' });
assert(ent.articles.some(a => a.key === 'sozeki_hou' && a.num === '61_4')
  && ent.articles.some(a => a.key === 'sozeki_rei' && a.num === '37_5'),
  '交際費の論点には措法61条の4と措令37条の5がセットで付く');
assert(law.refsForTopic({ pain_point: 'expense-golf-entertainment' }).articles.length === 2,
  'ゴルフ接待の論点にも同じ根拠が付く');
assert(law.refsForTopic({ pain_point: 'small-residential-land' }).articles.some(a => a.num === '69_4'),
  '小規模宅地等の論点には措法69条の4が付く');

// 交際費の出典は curated（No.5265）なので、法令への主出典差し替えは起きない
const saEnt = require(path.join(ROOT, 'scripts/lib/source-alignment')).checkSourceAlignment({
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5265.htm',
  source_provenance: 'curated', source_confidence: 1,
  tax_domain: 'bookkeeping_expenses', pain_point: 'entertainment-expense-deduction',
});
assert(saEnt.needs_source_review === false,
  '人が確定した出典がある論点は、法令が根拠にあっても主出典を差し替えない');

console.log('');
console.log('=== index.json は一部だけ取得しても他の法令を落とさない ===');
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/law-sources/index.json'), 'utf8'));
const idxKeys = (idx.laws || []).map(l => l.key);
for (const key of Object.keys(law.LAWS)) {
  assert(idxKeys.includes(key), `index.json に ${key} が載っている`);
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
