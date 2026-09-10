'use strict';

/**
 * 法令カタログ（e-Gov 法令API v2 由来）の定義と読み出し。
 *
 * 背景（2026-09-08）:
 *   相続の記事は税務だけでなく民法（相続人・法定相続分・相続放棄・遺産分割・遺言・遺留分）、
 *   戸籍法（死亡届）、不動産登記法（相続登記の義務化）に根拠がある。これまで出典は国税庁に
 *   限っていたため、逝去直後の手続きの記事は出典が確定せず（確信度0.55）、法令の条番号は
 *   捏造を避けるためリンク化もしていなかった（citation-linker.js）。
 *   e-Gov 法令API は条文を条単位・最終改正日つきで返すので、国税庁カタログと同じ形で持つ。
 *
 * 収録対象は LAWS に定義する。elms（部・章）や articles（条番号）で範囲を絞れる。
 * 取得は scripts/crawl-law-sources.js。保存先は data/law-sources/<key>.json。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LAW_DIR = path.join(ROOT, 'data', 'law-sources');
const EGOV_API = 'https://laws.e-gov.go.jp/api/2/law_data/';

// ── 収録する法令 ─────────────────────────────────────────────
//   key      : カタログ内の識別子
//   law_id   : e-Gov の法令ID（2026-09-08 に law_data で実在と題名を確認済み）
//   short    : 記事中の表記（「民法第915条」の「民法」）。引用検出に使う
//   elms     : 取得する範囲。e-Gov の elm パラメータ
//   articles : 保存する条番号の絞り込み（省略時は取得範囲の全条）
const LAWS = {
  minpo: {
    law_id: '129AC0000000089', title: '民法', short: '民法',
    // 第四編 親族 第一章 総則（親族の範囲・親等の計算：財産評価の同族関係者判定で使う）
    // 第五編 相続（総則〜特別の寄与）
    elms: ['MainProvision-Part_4-Chapter_1', 'MainProvision-Part_5'],
  },
  koseki: {
    law_id: '322AC0000000224', title: '戸籍法', short: '戸籍法',
    elms: ['MainProvision'],
  },
  fudosan_toki: {
    law_id: '416AC0000000123', title: '不動産登記法', short: '不動産登記法',
    elms: ['MainProvision'],
  },
  fudosan_toki_kisoku: {
    law_id: '417M60000010018', title: '不動産登記規則', short: '不動産登記規則',
    elms: ['MainProvision'],
    // 法定相続情報証明制度（247条・248条）だけ持つ。他は登記実務の細則で記事には使わない。
    articles: ['247', '248'],
  },
  sozokuzei: {
    law_id: '325AC0000000073', title: '相続税法', short: '相続税法',
    elms: ['MainProvision'],
  },
  kaji: {
    law_id: '423AC0000000052', title: '家事事件手続法', short: '家事事件手続法',
    // 相続放棄の申述・遺産分割の調停審判・遺言関係。条単位で保存するので本則全体を持つ。
    elms: ['MainProvision'],
  },
  bochi: {
    law_id: '323AC0000000048', title: '墓地、埋葬等に関する法律', short: '墓地埋葬法',
    elms: ['MainProvision'],
  },
  // 租税特別措置法（2026-09-10 追加）
  //   タックスアンサーは要約なので、条文の要件が落ちることがある。実例:
  //   No.5265 の「計算方法」欄は 50% 特例の対象を「飲食費」とだけ書いており、
  //   措法61条の4第6項が求める「その旨につき財務省令で定めるところにより
  //   明らかにされているもの（＝帳簿書類に接待飲食費である旨の記載）」が抜けている。
  //   これをそのまま記事にすると要件を1つ落とした記事になる（2026-09-10 に発生）。
  //   本則は巨大なので、ブログが実際に引く条だけを articles で絞って持つ。
  sozeki_hou: {
    law_id: '332AC0000000026', title: '租税特別措置法', short: '租税特別措置法',
    aliases: ['租税特別措置法', '措法'],
    // 第2章 所得税法の特例 / 第3章 法人税法の特例 / 第4章 相続税法の特例
    elms: ['MainProvision-Chapter_2', 'MainProvision-Chapter_3', 'MainProvision-Chapter_4'],
    articles: [
      '9_7',    // 相続財産に係る株式を発行会社に譲渡した場合のみなし配当課税の特例
      '25_2',   // 青色申告特別控除
      '28_2',   // 中小企業者の少額減価償却資産の必要経費算入の特例（個人）
      '35',     // 居住用財産の譲渡所得の特別控除
      '39',     // 相続財産に係る譲渡所得の課税の特例（取得費加算）
      '40',     // 国等に対して財産を寄附した場合の譲渡所得等の非課税
      '61_4',   // 交際費等の損金不算入
      '67_5',   // 中小企業者等の少額減価償却資産の損金算入の特例（法人）
      '69_4',   // 小規模宅地等についての相続税の課税価格の計算の特例
      '70',     // 国等に対して相続財産を贈与した場合等の相続税の非課税
      '70_2',   // 直系尊属から住宅取得等資金の贈与を受けた場合の非課税
      '70_2_2', // 直系尊属から教育資金の一括贈与を受けた場合の非課税
      '70_3',   // 住宅取得等資金の贈与を受けた場合の相続時精算課税の特例
    ],
  },
  sozeki_rei: {
    law_id: '332CO0000000043', title: '租税特別措置法施行令', short: '租税特別措置法施行令',
    aliases: ['租税特別措置法施行令', '措令'],
    elms: ['MainProvision-Chapter_3'],
    articles: [
      '37_5',   // 交際費等の範囲（1人1万円の基準はここ）
      '39_28',  // 中小企業者等の少額減価償却資産の損金算入の特例
    ],
  },
};

// ── 手続き機関の公式ページ ────────────────────────────────────
// 2026-09-08 に HTTP 200 とタイトルを確認済み。市区町村の個別ページは載せない
// （特定の自治体の運用を記事にしないため）。死亡届は法務省の全国共通ページを使う。
const AGENCY_PAGES = {
  nenkin_shibou:        { agency: '日本年金機構', title: '身近な方が亡くなったとき', url: 'https://www.nenkin.go.jp/service/scenebetsu/shibou.html' },
  nenkin_jukyu_shibou:  { agency: '日本年金機構', title: '年金を受けている方が亡くなったとき', url: 'https://www.nenkin.go.jp/service/jukyu/tetsuduki/kyotsu/jukyu/20140731-01.html' },
  nenkin_mishikyu:      { agency: '日本年金機構', title: '亡くなった方の未支給年金を受け取れるとき', url: 'https://www.nenkin.go.jp/shinsei/jukyu/kyotsu/20140731-02.html' },
  nenkin_izoku:         { agency: '日本年金機構', title: '遺族年金', url: 'https://www.nenkin.go.jp/service/jukyu/izokunenkin/jukyu-yoken/20150401-03.html' },
  moj_shibou_todoke:    { agency: '法務省', title: '死亡届', url: 'https://www.moj.go.jp/ONLINE/FAMILYREGISTER/5-4.html' },
  moj_koseki:           { agency: '法務省', title: '戸籍', url: 'https://www.moj.go.jp/MINJI/koseki.html' },
  moj_souzoku_touki:    { agency: '法務省', title: '相続登記の申請義務化特設ページ', url: 'https://www.moj.go.jp/MINJI/minji05_00590.html' },
  moj_souzoku_touki_qa: { agency: '法務省', title: '相続登記の申請義務化に関するQ＆A', url: 'https://www.moj.go.jp/MINJI/minji05_00565.html' },
  moj_souzokunin_shinkoku: { agency: '法務省', title: '相続人申告登記について', url: 'https://www.moj.go.jp/MINJI/minji05_00602.html' },
  moj_fudosan_souzoku:  { agency: '法務省', title: '不動産を相続した方へ ～相続登記・遺産分割を進めましょう～', url: 'https://www.moj.go.jp/MINJI/minji05_00435.html' },
  moj_houtei_souzoku:   { agency: '法務省', title: '「法定相続情報証明制度」について', url: 'https://www.moj.go.jp/MINJI/minji05_00284.html' },
  houmukyoku_houtei:    { agency: '法務局', title: '「法定相続情報証明制度」について', url: 'https://houmukyoku.moj.go.jp/homu/page7_000013.html' },
  houmukyoku_houtei_tetsuzuki: { agency: '法務局', title: '法定相続情報証明制度の具体的な手続について', url: 'https://houmukyoku.moj.go.jp/homu/page7_000014.html' },
};

// ── 相続の手続き段階 → 根拠条文・手続き機関ページ ───────────────
// 記事の procedure_stage（無ければ life_stage）から、渡すべき条文と機関ページを引く。
// 条文は法令カタログから原文を添付し、機関ページはリンクと題名を添える。
// ここに無い段階は従来どおり国税庁出典だけで生成する。
// 条番号は e-Gov の Num 表記（「909条の2」は '909_2'）。
const STAGE_REFS = {
  // 逝去直後の初動: 死亡届（戸籍法86・87）、火葬許可（墓地埋葬法5）、相続開始（民法882）、
  // 熟慮期間（民法915）、年金の死亡届・未支給年金
  'initial-immediate': {
    laws: [['koseki', ['86', '87']], ['bochi', ['5']], ['minpo', ['882', '915']]],
    pages: ['moj_shibou_todoke', 'nenkin_shibou', 'nenkin_jukyu_shibou', 'nenkin_mishikyu'],
  },
  // 銀行口座: 相続財産の共有（898・899）、遺産分割前の処分（906の2）、預貯金の仮払い（909の2）
  'bank-procedure': {
    laws: [['minpo', ['898', '899', '906_2', '909_2']]],
    pages: ['houmukyoku_houtei'],
  },
  // 書類収集: 戸籍の交付（戸籍法10・10の2）、相続人（民法887・889・890）、法定相続情報（規則247）
  'document-collection': {
    laws: [['koseki', ['10', '10_2']], ['minpo', ['887', '889', '890']], ['fudosan_toki_kisoku', ['247']]],
    pages: ['moj_koseki', 'houmukyoku_houtei', 'houmukyoku_houtei_tetsuzuki'],
  },
  // 遺産分割: 法定相続分（900・901）、特別受益（903）、寄与分（904の2）、分割（906・907・909）
  'estate-division': {
    laws: [['minpo', ['900', '901', '903', '904_2', '906', '907', '909']]],
    pages: ['moj_fudosan_souzoku'],
  },
  // 相続登記: 単独申請（63条）、義務化（76の2）、相続人申告登記（76の3）、過料（164）
  'real-estate-registration': {
    laws: [['fudosan_toki', ['63', '76_2', '76_3', '164']]],
    pages: ['moj_souzoku_touki', 'moj_souzoku_touki_qa', 'moj_souzokunin_shinkoku', 'houmukyoku_houtei'],
  },
  // 相続税申告: 申告（相続税法27）、納付（33）。相続人・相続分は民法が前提
  'inheritance-filing': {
    laws: [['sozokuzei', ['27', '33']], ['minpo', ['900', '915']]],
    pages: [],
  },
  // 準確定申告は所得税法の領域（国税庁出典で足りる）
  'quasi-final-return': { laws: [], pages: [] },
  // 財産評価: 法定相続分が前提
  'valuation-check': { laws: [['minpo', ['900']]], pages: [] },
  // 二次相続の見直し: 配偶者の税額軽減（相続税法19の2）、配偶者居住権（民法1028）
  'second-inheritance-review': { laws: [['sozokuzei', ['19_2']], ['minpo', ['1028']]], pages: [] },
  // 修正申告・更正の請求: 相続税法31・32
  'amendment-return': { laws: [['sozokuzei', ['31', '32']]], pages: [] },
};

// 論点（pain_point）で決まる根拠。procedure_stage を持たない深掘り論点はこちらで引く。
// 先頭の条が主出典の候補になる（国税庁出典が未確定のときだけ差し替わる）。
// 出典が domain-fallback で入っている論点（family-dispute / heir-confirmation / bank-frozen /
// what-first / amendment-needed 等）を優先して埋めた。
const PAIN_REFS = {
  // 逝去直後に何をするか: 死亡届・火葬許可・相続開始・熟慮期間
  'what-first':            { laws: [['koseki', ['86', '87']], ['bochi', ['5']], ['minpo', ['882', '915']]], pages: ['moj_shibou_todoke', 'nenkin_shibou', 'nenkin_jukyu_shibou'] },
  // 相続人の確定: 子・直系尊属・兄弟姉妹・配偶者、戸籍の交付
  'heir-confirmation':     { laws: [['minpo', ['887', '889', '890', '900']], ['koseki', ['10', '10_2']]], pages: ['moj_koseki', 'houmukyoku_houtei'] },
  // 口座凍結: 相続財産の共有、遺産分割前の処分、預貯金の仮払い
  'bank-frozen':           { laws: [['minpo', ['909_2', '898', '899', '906_2']]], pages: ['houmukyoku_houtei'] },
  // 家族の争い: 遺産分割の基準・協議・審判、法定相続分、遺留分
  'family-dispute':        { laws: [['minpo', ['906', '907', '900', '1042']]], pages: ['moj_fudosan_souzoku'] },
  // 事業承継: 誰が承継するかは遺産分割（税制は措置法で国税庁出典）
  'business-succession':   { laws: [['minpo', ['906', '907', '902']]], pages: [] },
  // 名義預金: 課税財産の範囲、相続の一般的効力
  'name-deposits-concern': { laws: [['sozokuzei', ['2']], ['minpo', ['896']]], pages: [] },
  // 申告後の誤り: 修正申告・更正の請求
  'amendment-needed':      { laws: [['sozokuzei', ['31', '32']]], pages: [] },
  // 空き家: 相続登記の義務、遺産分割
  'vacant-house-handling': { laws: [['fudosan_toki', ['76_2', '76_3']], ['minpo', ['906', '907']]], pages: ['moj_souzoku_touki'] },
  'real-estate-registration-pain': { laws: [['fudosan_toki', ['63', '76_2', '76_3', '164']]], pages: ['moj_souzoku_touki', 'moj_souzoku_touki_qa', 'moj_souzokunin_shinkoku', 'houmukyoku_houtei'] },
  // 以下は curated の出典を持つ論点。主出典は差し替わらず、条文を原文として添えるだけ。
  'deadline-pressure':     { laws: [['sozokuzei', ['27', '33']], ['minpo', ['915']]], pages: [] },
  'funeral-debt-deduction': { laws: [['sozokuzei', ['13', '14']]], pages: [] },
  'spouse-reduction':      { laws: [['sozokuzei', ['19_2']]], pages: [] },
  'tax-applicable-or-not': { laws: [['sozokuzei', ['15']]], pages: [] },
  'life-insurance-exemption': { laws: [['sozokuzei', ['3', '12']]], pages: [] },
  'lifetime-gift-addback': { laws: [['sozokuzei', ['19', '21_9']]], pages: [] },
  'second-inheritance-loss': { laws: [['sozokuzei', ['19_2']], ['minpo', ['1028']]], pages: [] },
  'real-estate-valuation': { laws: [['sozokuzei', ['22']]], pages: [] },
  // 交際費（2026-09-10 追加）。措法61条の4と措令37条の5をセットで渡す。
  // 1人1万円の基準は政令、50%特例の帳簿記載要件は法の第6項にあり、
  // タックスアンサーの要約だけでは要件が落ちる。
  'entertainment-expense-deduction': { laws: [['sozeki_hou', ['61_4']], ['sozeki_rei', ['37_5']]], pages: [] },
  'expense-golf-entertainment':      { laws: [['sozeki_hou', ['61_4']], ['sozeki_rei', ['37_5']]], pages: [] },
  // 小規模宅地等の特例は措法69条の4が本体
  'small-residential-land':          { laws: [['sozeki_hou', ['69_4']]], pages: [] },
};

// life_stage だけで決まる根拠（procedure_stage も pain_point も無い候補向け）
const LIFE_STAGE_REFS = {
  'pre-planning':       { laws: [['minpo', ['960', '968', '1042']]], pages: [] },   // 遺言・遺留分
  'cognitive-decline':  { laws: [['minpo', ['960', '968']]], pages: [] },           // 遺言の方式
  'critical-immediate': { laws: [['koseki', ['86', '87']], ['minpo', ['882', '915']]], pages: ['moj_shibou_todoke', 'nenkin_shibou'] },
  'within-7days':       { laws: [['koseki', ['86', '87']], ['minpo', ['882', '915']]], pages: ['moj_shibou_todoke', 'nenkin_shibou'] },
  'within-4months':     { laws: [['minpo', ['915']], ['sozokuzei', ['27']]], pages: [] },   // 熟慮期間・申告
  'within-10months':    { laws: [['sozokuzei', ['27', '33']], ['minpo', ['906', '907']]], pages: [] },
  'after-filing':       { laws: [['sozokuzei', ['31', '32']]], pages: [] },          // 修正申告・更正の請求
  'second-inheritance': { laws: [['sozokuzei', ['19_2']], ['minpo', ['1028']]], pages: [] },
  'multi-year-review':  { laws: [['sozokuzei', ['31', '32']]], pages: [] },
};
// ── 読み出し ─────────────────────────────────────────────────
const _cache = new Map();
function loadLaw(key) {
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(LAW_DIR, `${key}.json`);
  let data = null;
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { data = null; }
  _cache.set(key, data);
  return data;
}
function resetCacheForTest() { _cache.clear(); }

const KANJI_DIGITS = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const KANJI_UNITS = { '十': 10, '百': 100, '千': 1000 };

/** 漢数字・全角数字を算用数字に（「九百九条の二」→「909条の2」。算用数字はそのまま） */
function kanjiToArabic(text) {
  return String(text || '')
    .replace(/[〇零一二三四五六七八九十百千]+/g, (seg) => {
      let total = 0, cur = 0;
      for (const ch of seg) {
        if (ch in KANJI_DIGITS) cur = KANJI_DIGITS[ch];
        else if (ch in KANJI_UNITS) { total += (cur || 1) * KANJI_UNITS[ch]; cur = 0; }
      }
      return String(total + cur);
    })
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
}

/** 条番号の表記ゆれを吸収（「第九百九条の二」「909の2」「909-2」→ '909_2'） */
function normalizeArticleNum(num) {
  let s = kanjiToArabic(String(num || '').trim());
  s = s.replace(/^第/, '').replace(/条/g, '');
  s = s.replace(/の/g, '_').replace(/-/g, '_').replace(/\s+/g, '');
  return s;
}

/** 表示用: '909_2' → '909条の2' */
function articleLabel(num) {
  const parts = String(num || '').split('_');
  return parts[0] + '条' + parts.slice(1).map(p => 'の' + p).join('');
}

/** 条を 1 つ取り出す。無ければ null */
function getArticle(key, num) {
  const law = loadLaw(key);
  if (!law || !Array.isArray(law.articles)) return null;
  const n = normalizeArticleNum(num);
  return law.articles.find(a => a.num === n) || null;
}

/** 記事本文から法令の引用（民法第915条 / 民法915条 / 民法909条の2 等）を抜き、カタログと照合する */
function findLawCitations(body) {
  // 記事は「租税特別措置法第61条の4」とも「措法61条の4」とも書く。aliases で両方拾う。
  // 長い名前から先に当てる（「租税特別措置法施行令」を「租税特別措置法」より先に判定する）。
  const shorts = Object.entries(LAWS)
    .flatMap(([key, l]) => (l.aliases || [l.short]).map(a => [key, a]))
    .sort((a, b) => b[1].length - a[1].length);
  const alt = shorts.map(([, s]) => s).join('|');
  const re = new RegExp('(' + alt + ')(?:第)?([0-9０-９〇零一二三四五六七八九十百千]+)条(?:の([0-9０-９〇零一二三四五六七八九十]+))?', 'g');
  const found = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const key = shorts.find(([, s]) => s === m[1])[0];
    const num = normalizeArticleNum(m[2] + (m[3] ? 'の' + m[3] : ''));
    const id = `${key}:${num}`;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ key, law: LAWS[key].title, num, matched: m[0], found: !!getArticle(key, num) });
  }
  return found;
}

/** 段階から渡すべき根拠を引く（条文の実体と機関ページ） */
function refsForTopic(topic = {}) {
  // 手続き段階 → 論点 → 時期 の順で、最初に見つかった対応表を使う
  const src = (topic.procedure_stage && STAGE_REFS[topic.procedure_stage])
    || (topic.pain_point && PAIN_REFS[topic.pain_point])
    || (topic.life_stage && LIFE_STAGE_REFS[topic.life_stage])
    || null;
  if (!src) return { articles: [], pages: [] };
  const articles = [];
  for (const [key, nums] of src.laws) {
    const law = loadLaw(key) || {};
    for (const n of nums) {
      const a = getArticle(key, n);
      if (a) articles.push({ key, law: LAWS[key].title, law_num: law.law_num || '', amended: law.amendment_enforcement_date || '', ...a });
    }
  }
  const pages = src.pages.map(k => AGENCY_PAGES[k]).filter(Boolean);
  return { articles, pages };
}

/** 引用された条（findLawCitations の found=true）の原文を集める */
function articlesForCitations(citations) {
  const out = [];
  for (const c of citations || []) {
    if (!c.found) continue;
    const law = loadLaw(c.key) || {};
    const a = getArticle(c.key, c.num);
    if (a) out.push({ key: c.key, law: LAWS[c.key].title, law_num: law.law_num || '', amended: law.amendment_enforcement_date || '', ...a });
  }
  return out;
}

// 1 条あたりの上限。不動産登記規則247条（法定相続情報一覧図）のように長い条をそのまま
// 入れるとプロンプトが膨らむ。要件は条の前半に集まっているので先頭から切る。
const MAX_CHARS_PER_ARTICLE = 1200;

/** プロンプトに差し込む「法令の原文」ブロック。該当なしなら空文字 */
function buildLawProvisionBlock(articles, options = {}) {
  if (!articles || articles.length === 0) return '';
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_CHARS_PER_ARTICLE;
  const sections = articles.map(a => {
    const head = `【${a.law}】第${articleLabel(a.num)}${a.caption ? ' ' + a.caption : ''}`;
    const meta = a.amended ? `（${a.law_num}・最終改正施行 ${a.amended}）` : '';
    const text = String(a.text || '');
    const body = text.length > maxChars ? text.slice(0, maxChars) + '\n（※条文が長いため冒頭のみ抜粋）' : text;
    return `${head}${meta}\n${body}`;
  }).join('\n\n');
  return `

═══ 法令の原文（条文はこれだけを根拠にする。ここに無い条番号を書かない）═══
以下は e-Gov 法令検索から取得した現行条文です。期限・順位・要件は条文どおりに書き、
条番号を引くときはここにある条だけを引いてください。

${sections}`;
}

/** プロンプトに差し込む「手続き機関のページ」ブロック */
function buildAgencyPagesBlock(pages) {
  if (!pages || pages.length === 0) return '';
  const lines = pages.map(p => `- ${p.agency}「${p.title}」 ${p.url}`);
  return `

═══ 手続き機関の公式ページ（税務以外の手続きの根拠）═══
死亡届・年金・登記などの手続きは、次の公式ページを根拠として案内してください。
特定の市区町村の運用は書かず、全国共通の手続きとして説明してください。
${lines.join('\n')}`;
}

// e-Gov 法令検索の公開ページ（2026-09-08 に HTTP 200 を確認）。条へのアンカーは #Mp-At_<条番号>
const LAW_PAGE_BASE = 'https://laws.e-gov.go.jp/law/';
function lawPageUrl(key, num) {
  const def = LAWS[key];
  if (!def) return '';
  return LAW_PAGE_BASE + def.law_id + (num ? `#Mp-At_${normalizeArticleNum(num)}` : '');
}

/**
 * 国税庁に該当ページが無い論点（逝去直後の手続き等）で、記事の主出典に据える法令。
 * 段階の根拠のうち最初の条の法令を主出典にする（対応表の並びが優先順）。
 * 主出典に据えられる根拠が無ければ null（従来どおり国税庁出典のまま）。
 *
 * @returns {{url:string, title:string, provenance:'law-catalog', confidence:1, key:string, num:string}|null}
 */
function primarySourceFor(topic = {}) {
  const { articles } = refsForTopic(topic);
  const a = articles[0];
  if (!a) return null;
  const law = loadLaw(a.key) || {};
  return {
    url: lawPageUrl(a.key, a.num),
    title: `${LAWS[a.key].title} 第${articleLabel(a.num)}${a.caption ? '（' + a.caption + '）' : ''}｜e-Gov法令検索`,
    provenance: 'law-catalog',
    confidence: 1,
    key: a.key,
    num: a.num,
    amended: law.amendment_enforcement_date || '',
  };
}

module.exports = {
  LAWS, AGENCY_PAGES, STAGE_REFS, PAIN_REFS, LIFE_STAGE_REFS, LAW_DIR, EGOV_API, LAW_PAGE_BASE,
  loadLaw, getArticle, findLawCitations, refsForTopic, articlesForCitations,
  buildLawProvisionBlock, buildAgencyPagesBlock, lawPageUrl, primarySourceFor,
  normalizeArticleNum, kanjiToArabic, articleLabel, resetCacheForTest,
};
