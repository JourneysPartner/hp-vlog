'use strict';

const matter = require('gray-matter');
const { checkSourceAlignment } = require('./source-alignment');

const SOURCE_GUARD_VERSION = 1;
const GUARDED_SOURCE_FIELDS = Object.freeze([
  'source_url',
  'source_title',
  'source_provenance',
  'source_confidence',
  'source_guard_version',
  'pain_point',
  'tax_domain',
]);
const LIVE_STATUSES = new Set(['approved', 'scheduled', 'published']);
const DRAFT_STATUSES = new Set(['draft', 'needs_review', 'needs_revision']);

function parseFrontmatterMeta(raw) {
  try {
    return matter(String(raw || '')).data || {};
  } catch (_error) {
    return {};
  }
}

function hasGuardVersion(meta) {
  return meta.source_guard_version !== undefined
    && meta.source_guard_version !== null
    && meta.source_guard_version !== '';
}

function isCurrentGuardVersion(meta) {
  return hasGuardVersion(meta) && Number(meta.source_guard_version) === SOURCE_GUARD_VERSION
    && /^1$/.test(String(meta.source_guard_version));
}

/**
 * source guard の共通判定。
 * stage: validate | approve | publish
 */
function evaluateSourceGuard(meta = {}, options = {}) {
  const stage = options.stage || 'validate';
  const status = meta.review_status || '';
  const versionPresent = hasGuardVersion(meta);

  if (!versionPresent) {
    if (status === 'published') {
      return {
        allowed: true,
        blocked: false,
        legacy: true,
        level: 'warning',
        reasons: ['source_guard_version 未設定のレガシー公開記事（再判定対象外）'],
        alignment: null,
      };
    }
    const reason = 'source_guard_version 未設定のため、再生成または移行が必要';
    return {
      allowed: stage === 'validate' && DRAFT_STATUSES.has(status),
      blocked: !(stage === 'validate' && DRAFT_STATUSES.has(status)),
      legacy: true,
      level: LIVE_STATUSES.has(status) || stage !== 'validate' ? 'error' : 'warning',
      reasons: [reason],
      alignment: null,
    };
  }

  if (!isCurrentGuardVersion(meta)) {
    return {
      allowed: false,
      blocked: true,
      legacy: false,
      level: 'error',
      reasons: [`source_guard_version が未対応: ${String(meta.source_guard_version)}`],
      alignment: null,
    };
  }

  const alignment = checkSourceAlignment({
    source_url: meta.source_url || '',
    source_title: meta.source_title || '',
    source_provenance: meta.source_provenance || 'unknown',
    // llm-auto の判定に確信度が要る。渡し忘れると「確信度が不明」として
    // 必ずブロックされる（2026-08-20 に発生）。GUARDED_SOURCE_FIELDS に
    // 含まれている項目は漏れなく渡すこと。
    source_confidence: meta.source_confidence,
    pain_point: meta.pain_point || '',
    tax_domain: meta.tax_domain || '',
  });
  if (alignment.needs_source_review || !alignment.aligned || alignment.score <= 3) {
    const reason = alignment.reason || '出典の人手確認が必要';
    // 出典が未確定の記事は「承認・公開はさせない」が、生成/CI(validate)段階の
    // 未承認ドラフト（draft/needs_review/needs_revision）は "保留したまま生成する"
    // 設計なので警告に留める（version 未設定の分岐と同じ扱い）。
    // これにより、ペアの片方が出典保留でも daily-draft のバッチ全体が落ちて
    // 何も生成されない事故を防ぐ。承認(approve)・公開(publish)段階では従来どおりブロック。
    const draftOk = stage === 'validate' && DRAFT_STATUSES.has(status);
    return {
      allowed: draftOk,
      blocked: !draftOk,
      legacy: false,
      level: draftOk ? 'warning' : 'error',
      reasons: [`needs_source_review: ${reason}`],
      alignment,
    };
  }

  return { allowed: true, blocked: false, legacy: false, level: 'ok', reasons: [], alignment };
}

function escapeDoubleQuoted(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t');
}

function scalarLine(key, value) {
  if (key === 'source_guard_version') return `${key}: ${Number(value) || SOURCE_GUARD_VERSION}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `${key}: ${value}`;
  return `${key}: "${escapeDoubleQuoted(value)}"`;
}

function setFrontmatterFields(raw, updates) {
  const match = String(raw || '').match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  let fm = match[2];
  for (const [key, value] of Object.entries(updates)) {
    const replacement = scalarLine(key, value);
    const regex = new RegExp(`^${key}:\\s*.*$`, 'm');
    if (regex.test(fm)) fm = fm.replace(regex, replacement);
    else fm += `\n${replacement}`;
  }
  return match[1] + fm + match[3] + match[4];
}

/** 再生成後、LLM出力ではなく再生成前のガード項目を正本として復元する。 */
function restoreSourceGuardFields(beforeRaw, afterRaw, options = {}) {
  const before = parseFrontmatterMeta(beforeRaw);
  let resolved = null;
  if ((!before.source_url || !before.source_provenance) && typeof options.resolveSource === 'function') {
    resolved = options.resolveSource(before);
  }
  const updates = {
    source_url: before.source_url || (resolved && resolved.url) || '',
    source_title: before.source_title || (resolved && resolved.title) || '',
    source_provenance: before.source_provenance || (resolved && resolved.provenance) || 'unknown',
    source_confidence: before.source_confidence != null && before.source_confidence !== ''
      ? Number(before.source_confidence) : Number((resolved && resolved.confidence) || 0),
    source_guard_version: SOURCE_GUARD_VERSION,
    pain_point: before.pain_point || '',
    tax_domain: before.tax_domain || '',
  };
  if (updates.source_provenance === 'explicit' && before.source_provenance !== 'explicit') {
    updates.source_provenance = 'unknown';
    updates.source_confidence = 0;
  }
  return setFrontmatterFields(afterRaw, updates);
}

module.exports = {
  SOURCE_GUARD_VERSION,
  GUARDED_SOURCE_FIELDS,
  LIVE_STATUSES,
  DRAFT_STATUSES,
  parseFrontmatterMeta,
  evaluateSourceGuard,
  setFrontmatterFields,
  restoreSourceGuardFields,
};
