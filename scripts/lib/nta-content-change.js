'use strict';

function normalizedBody(entry) {
  const value = entry && (entry.body ?? entry.body_combined);
  return value == null ? null : String(value).normalize('NFKC').replace(/\s+/gu, '');
}

function detectContentChange(existing, next, fetchedAt) {
  const first_fetched_at = existing
    ? (existing.first_fetched_at || existing.fetched_at || fetchedAt)
    : fetchedAt;
  if (!existing) {
    return { first_fetched_at, content_changed_at: null, content_change_kind: null };
  }
  if (existing.html_hash && next.html_hash && existing.html_hash === next.html_hash) {
    return {
      first_fetched_at,
      content_changed_at: existing.content_changed_at || null,
      content_change_kind: existing.content_change_kind || null,
    };
  }
  const oldLaw = String(existing.law_version || '');
  const newLaw = String(next.law_version || '');
  const lawChanged = Boolean(oldLaw && newLaw && oldLaw !== newLaw);
  const oldBody = normalizedBody(existing);
  const newBody = normalizedBody(next);
  const bodyChanged = oldBody !== null && newBody !== null && oldBody !== newBody;
  const kind = lawChanged ? 'law_version' : bodyChanged ? 'body' : null;
  return {
    first_fetched_at,
    content_changed_at: kind ? fetchedAt : (existing.content_changed_at || null),
    content_change_kind: kind || existing.content_change_kind || null,
  };
}

module.exports = { detectContentChange };
