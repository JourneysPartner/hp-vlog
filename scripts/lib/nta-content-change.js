'use strict';

function normalizedBody(entry) {
  const value = entry && (entry.body ?? entry.body_combined);
  return value == null ? null : String(value).normalize('NFKC').replace(/\s+/gu, '');
}

function substantiveBody(entry, lawVersions = []) {
  let body = normalizedBody(entry);
  if (body === null) return null;
  for (const version of lawVersions) {
    const law = String(version || '').normalize('NFKC').replace(/\s+/gu, '');
    if (law) body = body.split(`[${law}]`).join('').split(law).join('');
  }
  body = body.replace(/\[?(?:令和|平成)(?:元|\d+)年\d+月\d+日現在(?:の)?法令(?:・通達)?等\]?/gu, '');
  const contact = body.lastIndexOf('お問い合わせ先');
  const footer = contact >= 0 ? contact : body.indexOf('このコンテンツはお役にたちましたか');
  return footer >= 0 ? body.slice(0, footer) : body;
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
  const oldLaw = String(existing.law_version || '');
  const newLaw = String(next.law_version || '');
  const lawChanged = Boolean(oldLaw && newLaw && oldLaw !== newLaw);
  const oldBody = normalizedBody(existing);
  const newBody = normalizedBody(next);
  // 本文が欠ける場合は基準日だけと断定せず、未除去の本文と法令基準日の差を使う。
  const bodyChanged = oldBody === null || newBody === null
    ? lawChanged || oldBody !== newBody
    : substantiveBody(existing, [oldLaw, newLaw]) !== substantiveBody(next, [oldLaw, newLaw]);
  const kind = bodyChanged ? (lawChanged ? 'law_version' : 'body') : null;
  return {
    first_fetched_at,
    content_changed_at: kind ? fetchedAt : (existing.content_changed_at || null),
    content_change_kind: kind || existing.content_change_kind || null,
    as_of_changed_at: !bodyChanged && lawChanged ? fetchedAt : (existing.as_of_changed_at || null),
  };
}

module.exports = { detectContentChange, substantiveBody };
