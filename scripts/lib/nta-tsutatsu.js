'use strict';

/**
 * 通達カタログ（data/nta-tsutatsu）の参照。
 *
 * 用途:
 *   1. 記事が引いた通達番号が実在するかの照合（捏造・番号違いの検出）
 *   2. 該当条文の原文をプロンプトに渡す
 *
 * 記事の主出典（source_url）には使わない。主出典はタックスアンサーに揃える。
 *
 * 背景（2026-08-20〜21）:
 *   所基通37-14 を「按分が必要」と書いた（実際は継続適用が条件の任意の取扱い）
 *   商品券の「発行」を非課税と書いた（実際は不課税。消基通6-4-5）
 *   タックスアンサー番号は照合できたが、通達番号は照合できなかった。
 */

const fs = require('fs');
const path = require('path');
const { normalizeProvisionNo } = require('./tsutatsu-parser');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'nta-tsutatsu');

// 記事中の通達の書き方 → カタログのキー
const SHORT_TO_CIRCULAR = {
  所基通: 'shotoku',
  所得税基本通達: 'shotoku',
  消基通: 'shohi',
  消費税法基本通達: 'shohi',
  法基通: 'hojin',
  法人税基本通達: 'hojin',
  相基通: 'sozoku',
  相続税法基本通達: 'sozoku',
};

let _catalog = null;

function loadCatalog() {
  if (_catalog !== null) return _catalog;
  _catalog = {};
  try {
    const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
    for (const entry of index) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, entry.file), 'utf8'));
        _catalog[entry.circular] = { ...entry, provisions: data.provisions || {} };
      } catch (_error) { /* 1つ読めなくても他は使う */ }
    }
  } catch (_error) {
    // カタログ未配置の環境（部分チェックアウト等）では空で動く
  }
  return _catalog;
}

/** 条文を引く。circular 省略時は全通達から探す。 */
function findProvision(no, circular) {
  const key = normalizeProvisionNo(no);
  if (!key) return null;
  // 「36-40～43」のような条文範囲は、引用されている左端の通達を従来どおり引く。
  // 「181～223共-6」の左端は単独の 181 なので、181-6 等へは寄せない。
  const rangeStart = key.match(/^(.+?)[～〜~]/)?.[1];
  const cat = loadCatalog();
  const targets = circular ? [circular] : Object.keys(cat);
  for (const c of targets) {
    const provisions = cat[c] && cat[c].provisions;
    const p = provisions && (provisions[key] || (rangeStart && provisions[rangeStart]));
    if (p) return { ...p, circular: c, label: cat[c].label, short: cat[c].short };
  }
  return null;
}

/** その番号がカタログに存在するか */
function isKnownProvision(no, circular) {
  return findProvision(no, circular) !== null;
}

// 本文から通達の引用を拾う。「所基通37-14」「消費税法基本通達6-4-5」
// 「相基通1の3・1の4共-1」など。相続税は「・」「共」を含む。
const PROVISION_ELEMENT = '[0-9０-９]{1,3}(?:の[0-9０-９]{1,2})?(?:・[0-9０-９]{1,3}(?:の[0-9０-９]{1,2})?)*共?';
const PROVISION_RANGE_ELEMENT = `${PROVISION_ELEMENT}(?:[～〜~]${PROVISION_ELEMENT})?`;
const PROVISION_NO_PATTERN = `${PROVISION_RANGE_ELEMENT}(?:[-－‐‑–—―−]${PROVISION_RANGE_ELEMENT}){1,3}`;
const CITATION_RE = new RegExp(
  `(${Object.keys(SHORT_TO_CIRCULAR).join('|')})\\s*(${PROVISION_NO_PATTERN})`,
  'g',
);
const CONTINUATION_RE = new RegExp(`^\\s*、\\s*(${PROVISION_NO_PATTERN})`);

/**
 * 本文中の通達引用を洗い出し、カタログに無いものを返す。
 * @returns {{citations: Array, unknown: Array}}
 */
function checkCitations(body) {
  const s = String(body || '');
  const citations = [];
  const unknown = [];
  const addCitation = (matched, circular, rawNo) => {
    const no = normalizeProvisionNo(rawNo);
    const found = findProvision(no, circular);
    const item = { matched, circular, no, found: !!found };
    citations.push(item);
    if (!found) unknown.push(item);
  };
  CITATION_RE.lastIndex = 0;
  let m;
  while ((m = CITATION_RE.exec(s)) !== null) {
    const circular = SHORT_TO_CIRCULAR[m[1]];
    addCitation(m[0], circular, m[2]);

    // 読点を越えて無条件に探すと後続の法令条文まで通達扱いになるため、直後の番号だけを引き継ぐ。
    let continuationAt = CITATION_RE.lastIndex;
    for (;;) {
      const next = s.slice(continuationAt).match(CONTINUATION_RE);
      if (!next) break;
      addCitation(`${m[1]}${next[1]}`, circular, next[1]);
      continuationAt += next[0].length;
    }
    CITATION_RE.lastIndex = continuationAt;
  }
  return { citations, unknown };
}

/**
 * 指定した条文の原文をプロンプト用ブロックにする。
 * @param {Array<{circular?: string, no: string}>|Array<string>} refs
 */
function buildProvisionBlock(refs) {
  const list = (refs || []).map(r => (typeof r === 'string' ? { no: r } : r));
  const found = list
    .map(r => findProvision(r.no, r.circular))
    .filter(Boolean);
  if (found.length === 0) return '';

  const body = found.map(p => `【${p.label} ${p.no}${p.title ? ` ${p.title}` : ''}】\n${p.url}\n${p.body}`)
    .join('\n\n');

  return `

═══ 法令解釈通達の原文 ═══
記事が触れている論点に対応する通達の原文です。

${body}

【厳守】
1. ここに<strong>原文がある通達だけ</strong>を条番号つきで引くこと。
2. 記憶で条番号を書かない。原文が無い通達は番号を書かず、内容だけ書くか触れない。
3. 「〜することができる」「〜を認めるものとする」は<strong>任意の取扱い</strong>であって
   義務ではない。「〜が必要です」と書き換えない。継続適用が条件ならその条件も書く。
4. ここに書かれていないことを、この通達に書いてあるかのように書かない。`;
}

/** カタログの規模（テスト・ログ用） */
function catalogStats() {
  const cat = loadCatalog();
  return Object.entries(cat).map(([k, v]) => ({
    circular: k, label: v.label, provisions: Object.keys(v.provisions).length,
  }));
}

module.exports = {
  SHORT_TO_CIRCULAR,
  CITATION_RE,
  loadCatalog,
  findProvision,
  isKnownProvision,
  checkCitations,
  buildProvisionBlock,
  catalogStats,
};
