'use strict';

const crypto = require('crypto');
const matter = require('gray-matter');
const { findInternalProcessWords } = require('./partial-revise');

const WARNING_MARKERS = ['自動再生成の警告', '自動反映は一部のみ'];
const REFRESH_REGEN_WARNING = '自動再生成の警告: 更新案では章の追加・見出しの変更はできません。本文の中で補う形の指示にして差し戻してください。';
const REFRESH_REGEN_FAILED = '自動再生成の警告: 再生成処理に失敗しました。時間をおいて差し戻し直してください。';

function isRefreshArticle(meta) {
  return Boolean(meta && meta.refresh_of === 'published');
}

function shouldCheckRegenerateDenylist(meta) {
  return !isRefreshArticle(meta);
}

function isExpiredRefreshTheme(meta, now = new Date()) {
  if (!meta) return false;
  if (meta.historical_only === true || String(meta.historical_only || '').toLowerCase() === 'true') return true;
  if (!meta.valid_to) return false;
  const validTo = new Date(meta.valid_to);
  return !Number.isNaN(validTo.getTime()) && validTo < now;
}

function splitDocument(raw) {
  const match = String(raw || '').match(/^(---\r?\n[\s\S]+?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  return { frontmatter: match[1], body: match[2] };
}

function reasonText(reasons) {
  return (reasons || []).map(reason => `${reason.detail}（${reason.where}）`).join('／');
}

function resolveReasonTarget(body, where) {
  const value = String(where || '').trim();
  const match = value.match(/^(#{2,6})\s+(.+?)\s*$/);
  if (!match) return { scope: 'targeted', label: '本文', whereHeading: '' };
  const depth = match[1].length;
  const label = match[2].trim();
  const headings = [...String(body || '').matchAll(/^(#{2,6})\s+(.+?)\s*$/gm)];
  const found = headings.find(item => item[1].length === depth && item[2].trim() === label);
  if (depth === 2 && found) return { scope: 'section', heading: label, label, whereHeading: label };
  if (depth >= 3 && found) {
    const parent = headings.slice(0, headings.indexOf(found)).reverse().find(item => item[1].length === 2);
    if (parent) return { scope: 'section', heading: parent[2].trim(), label: parent[2].trim(), whereHeading: label };
  }
  return { scope: 'targeted', label, whereHeading: label };
}

function buildRefreshPlan(post, reasons, { taxYear } = {}) {
  const plan = [];
  const seenTargets = new Set();
  const body = String(post && post.body || '');
  for (const reason of reasons || []) {
    if (!reason || !['fiscal_year', 'tax_reform'].includes(reason.kind)) continue;
    const target = resolveReasonTarget(body, reason.where);
    const key = target.scope === 'section' ? `section:${target.heading}` : `targeted:${target.label}`;
    if (seenTargets.has(key) || plan.filter(step => step.kind !== 'source_updated').length >= 3) continue;
    seenTargets.add(key);
    const prefix = target.label === '本文'
      ? '本文'
      : `「${target.label}」の節`;
    const rangeLabel = target.scope === 'section' ? 'この節' : '本文';
    if (reason.kind === 'fiscal_year') {
      const year = Number(taxYear) || 0;
      plan.push({
        kind: reason.kind,
        scope: target.scope,
        ...(target.scope === 'section' ? { heading: target.heading } : {}),
        reason,
        instruction: `${prefix}には年分の記述があります（${reason.detail}）。いまは ${year} 年分（令和 ${year - 2018} 年分）を基準に読まれます。過去の年分の事実として正しい記述（改正の経緯・適用開始の時期など）はそのまま残し、読者が今年の手続きに当てはめると誤解する記述だけを直してください。直す数字・期限は添付の出典本文に書かれているものだけを使い、根拠が無ければ変えないでください。直す所が無ければ、${rangeLabel}をそのまま返してください。`,
      });
    } else {
      plan.push({
        kind: reason.kind,
        scope: target.scope,
        ...(target.scope === 'section' ? { heading: target.heading } : {}),
        reason,
        instruction: `${prefix}の制度に関係する税制改正があります（${reason.detail}）。添付の改正論点に照らして、改正後の扱いと食い違う記述だけを直してください。改正前の扱いがまだ当てはまる読者がいる場合は、「◯年◯月◯日以後は…」のように適用時期を明記して両方を残してください。直す所が無ければ、${rangeLabel}をそのまま返してください。`,
      });
    }
  }

  const sourceReason = (reasons || []).find(reason => reason && reason.kind === 'source_updated');
  if (sourceReason) {
    plan.push({
      kind: 'source_updated',
      scope: 'targeted',
      reason: sourceReason,
      instruction: `${sourceReason.detail}。添付の出典本文が最新版です。本文のうち、添付の出典本文と食い違う記述（金額・税率・期限・要件・適用範囲・年分）だけを、出典本文に合わせて直してください。食い違いの無い箇所は一字も変えないでください。食い違いが見つからなければ、本文をそのまま返してください。`,
    });
  }
  return plan;
}

function splitH2Sections(body) {
  const text = String(body || '');
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = [];
  const introEnd = headings.length ? headings[0].index : text.length;
  sections.push({ heading: '（導入）', content: text.slice(0, introEnd) });
  for (let index = 0; index < headings.length; index++) {
    const match = headings[index];
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    sections.push({ heading: match[1].trim(), content: text.slice(match.index, end) });
  }
  return sections;
}

function sectionSpans(body) {
  const text = String(body || '');
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const spans = [];
  const introEnd = headings.length ? headings[0].index : text.length;
  spans.push({ heading: '（導入）', start: 0, end: introEnd, content: text.slice(0, introEnd) });
  for (let index = 0; index < headings.length; index++) {
    const match = headings[index];
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    spans.push({ heading: match[1].trim(), start: match.index, end, content: text.slice(match.index, end) });
  }
  return spans;
}

function paragraphs(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^##[^\n]*(?:\n|$)/, '')
    .trim()
    .split(/\n\s*\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function sameParagraphSequence(left, right) {
  const a = paragraphs(left);
  const b = paragraphs(right);
  return a.length === b.length && a.every((paragraph, index) => paragraph === b[index]);
}

function spliceChangedSections(baseBody, generatedBody) {
  const base = sectionSpans(baseBody);
  const generated = sectionSpans(generatedBody);
  if (base.length !== generated.length || base.some((section, index) => section.heading !== generated[index].heading)) {
    return { ok: false, body: String(baseBody || '') };
  }
  const selected = base.map((section, index) => sameParagraphSequence(section.content, generated[index].content)
    ? section.content
    : generated[index].content);
  return { ok: true, body: selected.join('') };
}

function diffSections(beforeBody, afterBody) {
  const before = splitH2Sections(beforeBody);
  const after = splitH2Sections(afterBody);
  const beforeByHeading = new Map(before.map(section => [section.heading, section.content]));
  const afterByHeading = new Map(after.map(section => [section.heading, section.content]));
  const orderedHeadings = [...before.map(section => section.heading)];
  for (const section of after) if (!beforeByHeading.has(section.heading)) orderedHeadings.push(section.heading);

  return orderedHeadings.filter(heading => !sameParagraphSequence(beforeByHeading.get(heading) || '', afterByHeading.get(heading) || ''))
    .map(heading => {
      const beforeText = beforeByHeading.get(heading) || '';
      const afterText = afterByHeading.get(heading) || '';
      const beforeParagraphs = paragraphs(beforeText);
      const afterParagraphs = paragraphs(afterText);
      const afterSet = new Set(afterParagraphs);
      const beforeSet = new Set(beforeParagraphs);
      return {
        heading,
        before: beforeText,
        after: afterText,
        changedParagraphs: {
          before: beforeParagraphs.map(text => ({ text, changed: !afterSet.has(text) })),
          after: afterParagraphs.map(text => ({ text, changed: !beforeSet.has(text) })),
        },
      };
    });
}

function normalizeForNoChange(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '');
}

function refreshBaseHash(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function occurrenceCount(text, word) {
  if (!word) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = String(text || '').indexOf(word, offset)) !== -1) {
    count++;
    offset += String(word).length;
  }
  return count;
}

function setRefreshFrontmatter(frontmatter, updates) {
  const match = String(frontmatter || '').match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  const nl = match[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const safe = String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
    const index = lines.findIndex(line => new RegExp(`^${key}:\\s*`).test(line));
    const line = `${key}: "${safe}"`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  return match[1] + lines.join(nl) + match[3];
}

function rebuildRefreshRegeneration(originalRaw, regeneratedRaw) {
  const original = splitDocument(originalRaw);
  const regenerated = splitDocument(regeneratedRaw);
  const spliced = spliceChangedSections(original.body, regenerated.body);
  if (!spliced.ok) {
    const error = new Error('h2 見出しの並びが変わりました');
    error.code = 'REFRESH_STRUCTURE_CHANGED';
    throw error;
  }
  const matter = require('gray-matter');
  const originalMeta = matter(originalRaw).data || {};
  const regeneratedMeta = matter(regeneratedRaw).data || {};
  const frontmatter = setRefreshFrontmatter(original.frontmatter, {
    review_status: regeneratedMeta.review_status == null ? originalMeta.review_status || 'needs_revision' : regeneratedMeta.review_status,
    review_comment: regeneratedMeta.review_comment == null ? originalMeta.review_comment || '' : regeneratedMeta.review_comment,
  });
  return frontmatter + spliced.body;
}

async function regenerateRefreshDraft({
  existing,
  comment,
  classification,
  partialEnabled = true,
  regenerateSection,
  regenerateTargeted,
}) {
  const original = splitDocument(existing);
  const requestedScope = classification && classification.scope || 'targeted';
  if (requestedScope === 'frontmatter' || requestedScope === 'title_only') {
    const message = '更新案では題名・要約は変えられません。題名の変更は別の作業で行います。';
    const content = setRefreshFrontmatter(original.frontmatter, {
      review_status: 'needs_revision',
      review_comment: `自動再生成の警告: ${message}`,
    }) + original.body;
    return { content, scope: 'frontmatter', warning: message };
  }

  const scope = !partialEnabled || requestedScope === 'full' || (classification && classification.type === 'add_section')
    ? 'targeted'
    : requestedScope;
  try {
    let regenerated;
    if (scope === 'section') {
      regenerated = await regenerateSection(existing, comment, { ...(classification || {}), preserveTitle: true });
    } else {
      regenerated = await regenerateTargeted(existing, comment, { preserveTitle: true });
    }
    return {
      content: rebuildRefreshRegeneration(existing, regenerated),
      scope,
      warning: '',
    };
  } catch (error) {
    const structureChanged = error && error.code === 'REFRESH_STRUCTURE_CHANGED';
    const warning = structureChanged ? REFRESH_REGEN_WARNING : REFRESH_REGEN_FAILED;
    if (!structureChanged) {
      // 本文や認証情報は出さず、原因の切り分けに要る種類と状態だけを残す。
      const status = error && (error.status || error.statusCode || (error.response && error.response.status));
      console.error(`[regenerate] 更新案の再生成に失敗: ${(error && error.name) || 'Error'}${status ? ` (status ${status})` : ''}`);
    }
    const content = setRefreshFrontmatter(original.frontmatter, {
      review_status: 'needs_revision',
      review_comment: warning,
    }) + original.body;
    return { content, scope, warning };
  }
}

function editFrontmatterLines(raw, edit) {
  const match = String(raw || '').match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  const nl = match[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const nextLines = edit(lines);
  return match[1] + nextLines.join(nl) + match[3] + match[4];
}

function removeFrontmatterFields(raw, fields) {
  const names = new Set((Array.isArray(fields) ? fields : [fields]).map(String));
  return editFrontmatterLines(raw, lines => lines.filter(line => {
    for (const key of names) if (new RegExp(`^${key}:\\s*`).test(line)) return false;
    return true;
  }));
}

function restoreRefreshMarkers(originalRaw, regeneratedRaw) {
  const original = splitDocument(originalRaw).frontmatter;
  const regenerated = splitDocument(regeneratedRaw).frontmatter;
  const markerKeys = ['refresh_of', 'refresh_requested_at', 'refresh_note', 'refresh_base_hash'];
  const originalLines = original.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n$/)[1].split(/\r?\n/);
  const markerLines = markerKeys.map(key => originalLines.find(line => new RegExp(`^${key}:\\s*`).test(line))).filter(Boolean);
  return editFrontmatterLines(regenerated, lines => {
    for (const markerLine of markerLines) {
      const key = markerLine.slice(0, markerLine.indexOf(':'));
      const index = lines.findIndex(line => new RegExp(`^${key}:\\s*`).test(line));
      if (index >= 0) lines[index] = markerLine;
      else lines.push(markerLine);
    }
    return lines;
  });
}

function jstTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().replace(/(?:\.000)?Z$/, '+09:00');
}

function hasRefreshWarning(raw) {
  const match = String(raw || '').match(/^review_comment:\s*(.*)$/m);
  return Boolean(match && WARNING_MARKERS.some(marker => match[1].includes(marker)));
}

async function runRefresh({
  content,
  reasons,
  taxYear,
  now = new Date(),
  regenerateSection,
  regenerateTargeted,
  findInternalProcessWords: findWords = findInternalProcessWords,
}) {
  const original = splitDocument(content);
  const originalBody = original.body;
  const plan = buildRefreshPlan({ body: originalBody }, reasons, { taxYear });
  if (!plan.length) return { status: 'failed', reason: '更新の対象になる理由がありません。', plan };

  let body = originalBody;
  for (const step of plan) {
    const source = original.frontmatter + body;
    const output = step.scope === 'section'
      ? await regenerateSection(source, step.instruction, {
        type: 'section_only', scope: 'section', sectionHint: step.heading, preserveTitle: true,
      })
      : await regenerateTargeted(source, step.instruction, { preserveTitle: true });
    let generatedMeta;
    try { generatedMeta = matter(output).data || {}; }
    catch (_) { return { status: 'failed', reason: '再生成結果を読み取れませんでした。', plan }; }
    if (generatedMeta.review_status === 'needs_revision') {
      return { status: 'failed', reason: '再生成側が手動確認を必要としています。', plan };
    }
    if (hasRefreshWarning(output)) {
      return { status: 'failed', reason: '再生成側が警告を付けました。', plan };
    }
    const generatedBody = splitDocument(output).body;
    const spliced = spliceChangedSections(body, generatedBody);
    if (!spliced.ok) return { status: 'failed', reason: 'h2 見出しの並びが変わりました。', plan };
    body = spliced.body;
  }

  if (normalizeForNoChange(originalBody) === normalizeForNoChange(body)) {
    return { status: 'no_change', reason: '本文に変更はありませんでした。', plan };
  }
  const originalHeadings = splitH2Sections(originalBody).slice(1).map(section => section.heading);
  const nextHeadings = splitH2Sections(body).slice(1).map(section => section.heading);
  if (JSON.stringify(originalHeadings) !== JSON.stringify(nextHeadings)) {
    return { status: 'failed', reason: 'h2 見出しの並びが変わりました。', plan };
  }
  const beforeLength = originalBody.trim().length;
  const afterLength = body.trim().length;
  if (beforeLength > 0 && afterLength < beforeLength * 0.85) {
    return { status: 'failed', reason: '本文が元の 85% 未満に短くなりました。', plan };
  }
  if (beforeLength > 0 && afterLength > beforeLength * 1.3) {
    return { status: 'failed', reason: '本文が元の 130% を超えて長くなりました。', plan };
  }
  const getWords = value => {
    const result = findWords(value) || [];
    return Array.isArray(result) ? result : (result.words || []);
  };
  const internalWords = [...new Set([...getWords(originalBody), ...getWords(body)])]
    .filter(word => occurrenceCount(body, word) > occurrenceCount(originalBody, word));
  if (internalWords.length) {
    return { status: 'failed', reason: `作業語が混ざっています: ${internalWords.join('、')}`, plan };
  }

  const reasonSummary = reasonText(reasons);
  const frontmatter = setRefreshFrontmatter(original.frontmatter, {
    review_status: 'draft',
    review_comment: '',
    refresh_of: 'published',
    refresh_requested_at: jstTimestamp(now),
    refresh_note: reasonSummary,
    refresh_base_hash: refreshBaseHash(originalBody),
  });
  return {
    status: 'changed',
    reason: reasonSummary,
    content: frontmatter + body,
    diff: diffSections(originalBody, body),
    plan,
  };
}

module.exports = {
  WARNING_MARKERS,
  isRefreshArticle,
  shouldCheckRegenerateDenylist,
  isExpiredRefreshTheme,
  splitDocument,
  reasonText,
  resolveReasonTarget,
  buildRefreshPlan,
  splitH2Sections,
  sectionSpans,
  sameParagraphSequence,
  spliceChangedSections,
  diffSections,
  normalizeForNoChange,
  refreshBaseHash,
  occurrenceCount,
  setRefreshFrontmatter,
  rebuildRefreshRegeneration,
  regenerateRefreshDraft,
  removeFrontmatterFields,
  restoreRefreshMarkers,
  jstTimestamp,
  runRefresh,
};
