'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const sourceBody = require('./nta-source-body');
const laws = require('./law-sources');
const tsutatsu = require('./nta-tsutatsu');
const { positiveLimit } = require('./source-excerpt');
const { LAW_SCOPE_RULE } = require('./grounding-rules');
const { getRefsForTopic, resolveSourceForTopic } = require('./tax-authority-refs');
const { selectSourcesPerTerm } = require('./topic-sources');
const ROOT = path.join(__dirname, '..', '..');

function relationText(url) {
  const file = sourceBody.resolveSourceFile(url);
  if (!file || !fs.existsSync(file)) return '';
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (e.deleted) return '';
    return [e.kankei_hourei, ...Object.entries(e.sections || {})
      .filter(([key]) => /根拠法令|関係法令|法令通達/.test(key)).map(([, value]) => value)].filter(Boolean).join('、');
  } catch (_) { return ''; }
}

/** 略称・条を省略した関係法令欄を展開する。既存の番号照合は変更しない。 */
function relationReferences(text, options = {}) {
  const aliases = new Map(Object.entries(laws.LAWS).flatMap(([key, def]) =>
    (def.aliases || [def.short]).map(alias => [alias, key])));
  aliases.set('相法', 'sozokuzei');
  // 未収録の法令も「解決できない」と記録する。
  for (const alias of ['措規', '郵政民営化法', '所得税法施行令', '所得税法', '法人税法施行令', '法人税法', '消費税法施行令', '消費税法']) {
    if (!aliases.has(alias)) aliases.set(alias, null);
  }
  const circulars = { ...tsutatsu.SHORT_TO_CIRCULAR };
  const names = [...aliases.keys(), ...Object.keys(circulars)].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${names.join('|')})\\s*(?:第)?([0-9]+(?:条)?(?:の[0-9]+)*(?:\\([0-9]+\\))?(?:[-－][0-9]+(?:の[0-9]+)*)*(?:[～〜][0-9]+)?)`, 'g');
  const normalized = laws.kanjiToArabic(String(text || '').replace(/[①-⑳]/g, c => `第${c.charCodeAt(0) - 0x245f}項`).normalize('NFKC'));
  const out = [];
  const add = (alias, rawNum) => {
    const range = rawNum.match(/^(.+?)[～〜]([0-9]+)$/);
    if (range) {
      const first = range[1].match(/([0-9]+)$/);
      if (first && Number(range[2]) >= Number(first[1]) && Number(range[2]) - Number(first[1]) <= 100) {
        for (let n = Number(first[1]); n <= Number(range[2]); n++) add(alias, range[1].slice(0, -first[1].length) + n);
        return;
      }
    }
    if (circulars[alias]) {
      const no = rawNum.replace(/条/g, '').replace(/－/g, '-');
      const candidates = circulars[alias] === 'sochi' ? tsutatsu.resolveSochi(no, options) : [circulars[alias]];
      for (const circular of candidates) out.push({ kind: 'tsutatsu', circular, no, label: alias + no });
    } else {
      if (alias === '法令' && !rawNum.includes('条')) return;
      const num = laws.normalizeArticleNum(rawNum.split(/[～〜]/)[0]);
      out.push({ kind: 'law', key: aliases.get(alias), num, label: alias + rawNum });
    }
  };
  let m;
  while ((m = re.exec(normalized))) {
    add(m[1], m[2]);
    let tail = normalized.slice(re.lastIndex);
    let next;
    let previous = m[2];
    while ((next = tail.match(/^\s*、\s*([0-9]+(?:条)?(?:の[0-9]+)*(?:[-－][0-9]+)*(?:[～〜][0-9]+)?)/))) {
      let num = next[1];
      if (circulars[m[1]] && !num.includes('-') && previous.includes('-')) num = previous.replace(/[-－][^-－]+$/, '-' + num);
      add(m[1], num);
      previous = num;
      re.lastIndex += next[0].length;
      tail = normalized.slice(re.lastIndex);
    }
  }
  for (const clause of normalized.split('、')) {
    const unknown = clause.match(/^(.+(?:附則|法|令|規|通|告示))第?([0-9]+(?:条)?(?:の[0-9]+)*)/);
    if (unknown && !names.some(name => unknown[1].endsWith(name))) {
      out.push({ kind: 'law', key: null, num: laws.normalizeArticleNum(unknown[2]), label: unknown[1] + unknown[2] });
    }
  }
  return out;
}

function buildLawChain(sources, options = {}) {
  const maxArticles = positiveLimit(options.maxArticles ?? process.env.LAW_CHAIN_MAX_ARTICLES, 8);
  const maxChars = positiveLimit(options.maxLawChars ?? process.env.LAW_CHAIN_MAX_CHARS, 12000);
  const log = options.log || console.log;
  const seen = new Set(), attached = [], unresolved = [], dropped = [];
  let total = 0;
  for (const s of sources) {
    for (const ref of relationReferences(relationText(s.url), options)) {
      const id = ref.kind === 'law' ? `law:${ref.key || ref.label}:${ref.num}` : `tsutatsu:${ref.circular}:${ref.no}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = ref.kind === 'law' ? (ref.key && laws.getArticle(ref.key, ref.num)) : tsutatsu.findProvision(ref.no, ref.circular);
      const text = entry && (entry.text || entry.body);
      if (!text) {
        unresolved.push(ref);
        log(`[source] カタログに無い条: ${ref.label}`);
        continue;
      }
      // 項指定でも条全体を渡す。全文が入らなければ、その条を落とす。
      if (attached.length >= maxArticles || total + text.length > maxChars) {
        dropped.push(ref);
        log(`[source] 法令予算で除外: ${ref.label} ${text.length}文字`);
        continue;
      }
      const url = ref.kind === 'law' ? laws.lawPageUrl(ref.key, ref.num) : entry.url;
      attached.push({ ...ref, url, text });
      total += text.length;
      log(`[source] 資料: ${ref.kind} ${ref.label} ${text.length}文字 全文`);
    }
  }
  const block = attached.length ? `\n\n═══ 出典の関係法令・通達の原文 ═══\n${LAW_SCOPE_RULE}\n\n` +
    attached.map(a => `【${a.label}】\n${a.url}\n${a.text}`).join('\n\n') : '';
  return { block, attached, unresolved, dropped, totalChars: total };
}

function buildMaterialsBundle(topic = {}, refs = getRefsForTopic(topic, 4), options = {}) {
  const pages = sourceBody.buildSourceBodyBundle(topic, refs, options);
  const chain = buildLawChain(pages.sources, options);
  const sourceBundle = [...new Set([...pages.sources.map(s => s.url), ...chain.attached.map(a =>
    a.kind === 'law' ? `${laws.LAWS[a.key].short}${laws.articleLabel(a.num)}` : a.label)])].slice(0, 20).join(';');
  topic.source_bundle = sourceBundle;
  return { sourceBody: pages.block, chainBlock: chain.block, sourceBundle, pages, chain, combined: pages.block + chain.block };
}

function topicFromMeta(meta) {
  return { ...meta, source_supplements: [2, 3, 4].filter(n => meta[`source_${n}_url`]).map(n => ({
    url: meta[`source_${n}_url`], title: meta[`source_${n}_title`], term: meta[`source_${n}_term`], confidence: Number(meta[`source_${n}_confidence`]),
  })) };
}

let usageCounts;
function sourceUsageCounts(postsDir = path.join(ROOT, 'content', 'posts')) {
  if (usageCounts && postsDir === path.join(ROOT, 'content', 'posts')) return usageCounts;
  const counts = new Map();
  for (const file of fs.existsSync(postsDir) ? fs.readdirSync(postsDir).filter(f => f.endsWith('.md')) : []) {
    const { data } = matter(fs.readFileSync(path.join(postsDir, file), 'utf8'));
    if (data.review_status !== 'published' || !data.source_url) continue;
    counts.set(data.source_url, (counts.get(data.source_url) || 0) + 1);
  }
  if (postsDir === path.join(ROOT, 'content', 'posts')) usageCounts = counts;
  return counts;
}

function isGenericSource(topic, options = {}) {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'generic-source-pages.json'), 'utf8'));
  const no = sourceBody.parseTaxanswerUrl(topic.source_url)?.no;
  return list.some(e => e.id === no || (e.id === 'invoice_about' && /invoice.*about/.test(topic.source_url || ''))) ||
    (sourceUsageCounts(options.postsDir).get(topic.source_url) || 0) >= positiveLimit(options.genericThreshold ?? process.env.GENERIC_SOURCE_MIN_POSTS, 10);
}

async function supplementGenericSource(topic, options = {}) {
  if (!isGenericSource(topic, options)) return false;
  await options.enrichTaxTerms?.(topic);
  const terms = String(topic.tax_terms || topic.source_term || topic.title || '').split(/\s+/).filter(Boolean);
  const picked = await selectSourcesPerTerm(topic, terms, options.resolveSource || (t => {
    // 明示指定は主出典を固定するため、補助資料の検索からだけ外す。
    const result = resolveSourceForTopic({ ...t, source_url: '', source_provenance: '' });
    return result && !['domain-fallback', 'ultimate', 'unknown'].includes(result.provenance) ? result : null;
  }));
  const seen = new Set([topic.source_url]);
  const supplements = [...(topic.source_supplements || []), ...picked]
    .filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 3);
  topic.source_supplements = supplements;
  if (!supplements.length) topic.materials_warning = '主出典が汎用ページで、論点に合う資料が見つからない';
  return true;
}

module.exports = { buildMaterialsBundle, buildLawChain, relationText, relationReferences, topicFromMeta, supplementGenericSource, isGenericSource, sourceUsageCounts };
