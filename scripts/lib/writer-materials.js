'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const evidence = require('./fact-evidence');
const qa = require('./nta-qa');
const { CHANGES } = require('./tax-law-changes');
const { tokenizeForMatcher } = require('./nta-source-matcher');

let questions;
function qaCatalog() {
  if (!questions) questions = JSON.parse(fs.readFileSync(qa.INDEX_PATH, 'utf8')).entries.map(e => {
    const body = JSON.parse(fs.readFileSync(path.join(qa.QA_DIR, e.file_path), 'utf8')).body;
    if (typeof body !== 'string') throw new Error('Q&A の本文を読めませんでした');
    return { ...e, id: e.url, kind: 'qa', title: `${e.source_label} ${e.title}`, text: body,
      material_id: `qa:${e.source_key}/${e.id}` };
  });
  return questions;
}

function materialId(ref) {
  if (!ref) return '';
  if (ref.material_id) return ref.material_id;
  if (/^(?:law|tsutatsu|qa|change|ta):/.test(ref.id || '')) return ref.id;
  if (ref.kind === 'qa' || ref.source_key) {
    if (ref.source_key && ref.id && !String(ref.id).startsWith('http')) return `qa:${ref.source_key}/${ref.id}`;
    return qaCatalog().find(e => e.url === ref.url)?.material_id || '';
  }
  if (ref.kind === 'change' || (ref.key && !ref.num && !ref.no && ref.summary)) return `change:${ref.key}`;
  if (ref.kind === 'law' || (ref.key && ref.num)) return `law:${ref.key}:${ref.num || ref.no}`;
  if (ref.kind === 'tsutatsu' || ref.circular) return `tsutatsu:${ref.circular}:${ref.no}`;
  const url = ref.url || ref.id || '';
  const number = url.match(/\/taxanswer\/[^/]+\/(\d+)\.htm(?:[?#]|$)/)?.[1];
  if (number) return `ta:${number}`;
  const entry = evidence.evidenceCatalog().entries.find(e => e.id === url || e.url === url);
  if (entry) return entry.id;
  const question = qa.loadIndex().find(e => e.url === url && (!ref.id || ref.id === url || ref.id === e.id));
  return question ? `qa:${question.source_key}/${question.id}` : '';
}

function resolveMaterial(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('change:')) {
    const change = CHANGES.find(c => `change:${c.key}` === id);
    return change ? { id, kind: 'change', title: change.title, url: change.reference_url || change.url || '',
      text: [change.title, change.summary, change.reference].filter(Boolean).join('\n') } : null;
  }
  if (id.startsWith('qa:')) {
    const question = qaCatalog().find(e => e.material_id === id);
    // 同じPDF内の別の問を、照合の資料表で1ページに混ぜない。
    return question ? { ...question, id } : null;
  }
  const entry = evidence.evidenceCatalog().entries.find(e => id.startsWith('ta:')
    ? e.kind === 'taxanswer' && e.no === id.slice(3) : e.id === id);
  if (!entry) return null;
  const { tokens, titleTokens, lazy, ...ref } = entry;
  return { ...ref, text: evidence.loadEvidenceText(entry) };
}

function materialIds(refs) {
  return [...new Set(refs.map(materialId).filter(Boolean))];
}
function writerMaterials(options = {}) {
  return process.env.FACT_CHECK_WRITER_MATERIALS !== 'false' && options.writerMaterials !== false && Array.isArray(options.writer_materials)
    ? [...new Set(options.writer_materials.filter(id => typeof id === 'string' && id))] : [];
}
function materialFingerprint(ids) {
  return { count: ids.length, fingerprint: createHash('sha256').update([...ids].sort().join(';')).digest('hex').slice(0, 16) };
}

/** 書き手に渡した資料だけに、既存の検索と同じ点を付ける。 */
function searchWriterEvidence(claim, options = {}) {
  const entries = writerMaterials(options).map(resolveMaterial).filter(Boolean).map(e => ({ ...e,
    tokens: new Set(tokenizeForMatcher(`${e.title} ${e.text}`)), titleTokens: new Set(tokenizeForMatcher(e.title)) }));
  const catalog = evidence.evidenceCatalog();
  const { scored, query, focus } = evidence.scoreEvidence(claim, { ...options,
    catalog: { entries, df: catalog.df }, scorePopulation: catalog.entries.length });
  return scored.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id)).slice(0, 4).map(({ e, score }) => {
    const { tokens, titleTokens, ...ref } = e;
    const text = evidence.contiguousExcerpt(e.text, query, 2000, focus);
    return { ...ref, text, text_start: e.text.indexOf(text), score: Math.round(score * 100) / 100 };
  });
}

module.exports = { qaCatalog, materialId, materialIds, resolveMaterial, writerMaterials, materialFingerprint, searchWriterEvidence };
