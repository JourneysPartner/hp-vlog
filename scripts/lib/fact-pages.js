'use strict';

const { loadEvidenceText } = require('./fact-evidence');
const { splitUnits, renderUnits } = require('./fact-units');

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
function buildPages(claims, evidence, options = {}, startNumber = 1) {
  const grouped = new Map();
  for (const c of claims) for (const ref of evidence[c.id] || []) {
    if (!grouped.has(ref.id)) grouped.set(ref.id, { ref, excerpts: [] });
    grouped.get(ref.id).excerpts.push({ ref, claim: c.id });
  }
  const pages = [];
  for (const { ref, excerpts } of grouped.values()) {
    const original = (options.loadEvidenceText || loadEvidenceText)(ref);
    let source = original;
    if (typeof source !== 'string') throw new Error('資料の原文を読めませんでした');
    if (ref.kind === 'taxanswer') {
      const at = source.indexOf('関連リンク');
      if (at >= 0) source = source.slice(0, at);
    }
    const spans = excerpts.flatMap(({ ref: part, claim }) => {
      const texts = part.text_ranges ? part.text_ranges.map(([a, b]) => part.text.slice(a, b)) : [part.text];
      return texts.map(text => {
        const at = Number.isInteger(part.text_start) && original.slice(part.text_start, part.text_start + text.length) === text
          ? part.text_start : original.indexOf(text);
        // 関連リンクだけの抜粋は資料表に載せない。
        if (at < 0) {
          throw new Error('資料の抜粋が原文に見つかりません');
        }
        return at < source.length ? { start: at, end: Math.min(at + text.length, source.length), claim } : null;
      }).filter(Boolean);
    });
    // 長いページは全主張の抜粋を必ず含める（字数の上限で削らない）。量は判定の呼び出しの 10 万字の組分けで抑える。
    const ranges = source.length <= 6000 ? [[0, source.length]] : mergeRanges(spans.map(p => [p.start, p.end]));
    const units = splitUnits(source, { material: true, ranges });
    const number = startNumber + pages.length;
    const text = ranges.map(([a, b]) => source.slice(a, b)).join('\n……\n');
    const packedRef = { ...ref, text, text_ranges: [], text_start: undefined };
    let at = 0;
    for (const [a, b] of ranges) { packedRef.text_ranges.push([at, at + b - a]); at += b - a + 4; }
    const rendered = units.map((u, i) => (i && u.segment !== units[i - 1].segment ? '……\n' : '') + renderUnits([u])).join('\n');
    pages.push({ number, id: ref.id, source, ranges, units, ref: packedRef,
      block: `[資料 ${number}] ${ref.title || ''} / ${ref.url || ''} / ${ref.law_version || ''}\n${rendered}` });
  }
  return { pages, block: pages.map(p => p.block).join('\n\n') };
}

// 件数では分けない。資料が上限を超えるときだけ制度単位で組を作る。
function pageGroups(claims, evidence, options = {}) {
  const all = buildPages(claims, evidence, options);
  if (all.block.length <= 100000) return [{ claims, pack: all }];
  const subjects = new Map();
  for (const c of claims) { if (!subjects.has(c.subject)) subjects.set(c.subject, []); subjects.get(c.subject).push(c); }
  const groups = [];
  let current = [];
  const append = items => {
    const combined = [...current, ...items], pack = buildPages(combined, evidence, options);
    if (pack.block.length <= 100000) { current = combined; return; }
    if (current.length) { groups.push({ claims: current, pack: buildPages(current, evidence, options) }); current = []; }
    const own = buildPages(items, evidence, options);
    if (own.block.length <= 100000) current = items;
    else if (items.length > 1) for (const c of items) append([c]);
    else throw new Error('1主張の資料が判定の上限を超えました');
  };
  for (const items of subjects.values()) append(items);
  if (current.length) groups.push({ claims: current, pack: buildPages(current, evidence, options) });
  return groups;
}
module.exports = { buildPages, pageGroups, mergeRanges };
