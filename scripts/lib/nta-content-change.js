'use strict';

function normalizedText(value) {
  return value == null ? null : String(value).normalize('NFKC').replace(/\s+/gu, '');
}

function normalizedBody(entry) {
  return normalizedText(entry && (entry.body ?? entry.body_combined));
}

function substantiveBody(entry) {
  let body = normalizedBody(entry);
  if (body === null) return null;
  body = body.replace(/^\[?(?:令和|平成)(?:元|\d+)年\d+月\d+日現在(?:の)?法令(?:・通達)?等\]?/u, '');
  const contact = body.lastIndexOf('お問い合わせ先');
  const feedback = body.indexOf('このコンテンツはお役にたちましたか', Math.max(0, contact));
  if (contact >= 0) return feedback > contact ? body.slice(0, contact) : body;
  return feedback >= 0 ? body.slice(0, feedback) : body;
}

function imageHashes(entry) {
  return JSON.stringify(Array.isArray(entry.images) ? entry.images.map(image => image && image.sha256 || null) : null);
}

function detectContentChange(existing, next, fetchedAt) {
  const first_fetched_at = existing
    ? (existing.first_fetched_at || existing.fetched_at || fetchedAt)
    : fetchedAt;
  if (!existing) {
    return { first_fetched_at, content_changed_at: null, content_change_kind: null, as_of_changed_at: null };
  }
  if (existing.html_hash && next.html_hash && existing.html_hash === next.html_hash) {
    return {
      first_fetched_at,
      content_changed_at: existing.content_changed_at || null,
      content_change_kind: existing.content_change_kind || null,
      as_of_changed_at: existing.as_of_changed_at || null,
    };
  }
  const oldLaw = normalizedText(existing.law_version) || '';
  const newLaw = normalizedText(next.law_version) || '';
  const lawChanged = Boolean(oldLaw && newLaw && oldLaw !== newLaw);
  const oldBody = normalizedBody(existing);
  const newBody = normalizedBody(next);
  // 本文が欠ける場合は基準日だけと断定せず、未除去の本文と法令基準日の差を使う。
  const bodyChanged = (oldBody === null || newBody === null
    ? lawChanged || oldBody !== newBody
    : substantiveBody(existing) !== substantiveBody(next))
    || normalizedText(existing.kankei_hourei) !== normalizedText(next.kankei_hourei)
    || normalizedText(existing.title) !== normalizedText(next.title)
    || imageHashes(existing) !== imageHashes(next);
  const kind = bodyChanged ? (lawChanged ? 'law_version' : 'body') : null;
  return {
    first_fetched_at,
    content_changed_at: kind ? fetchedAt : (existing.content_changed_at || null),
    content_change_kind: kind || existing.content_change_kind || null,
    as_of_changed_at: !bodyChanged && lawChanged ? fetchedAt : (existing.as_of_changed_at || null),
  };
}

module.exports = { detectContentChange, substantiveBody };
