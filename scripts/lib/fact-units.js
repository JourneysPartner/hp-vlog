'use strict';

// 原文の位置を保持する。括弧内の句点・読点では切らない。
const OPEN = { '（': '）', '(': ')', '「': '」', '『': '』', '【': '】' };
function splitUnits(source, { material = false, ranges = [[0, source.length]] } = {}) {
  const units = [];
  const add = (start, end, heading, segment) => {
    const raw = source.slice(start, end), left = raw.length - raw.trimStart().length;
    start += left; end -= raw.length - raw.trimEnd().length;
    if (end > start) units.push({ s: units.length + 1, text: source.slice(start, end), start, end, heading, segment });
  };
  for (const [segment, [from, to]] of ranges.entries()) {
    const stack = [];
    const bracket = ch => {
      if (OPEN[ch]) stack.push(OPEN[ch]);
      else if (ch === stack.at(-1)) stack.pop();
    };
    for (const ch of source.slice(0, from)) bracket(ch);
    let lineStart = from;
    for (const line of source.slice(from, to).split(/\n/)) {
      const lineEnd = lineStart + line.length;
      const heading = /^\s*#{1,6}\s/.test(line);
      if (heading && !material) add(lineStart, lineEnd, true, segment);
      else {
        let start = lineStart, commas = [];
        const flush = end => {
          if (material) while (end - start > 300) {
            const cut = commas.filter(at => at > start && at <= start + 300).at(-1) || start + 300;
            add(start, cut, heading, segment); start = cut;
          }
          add(start, end, heading, segment); start = end; commas = [];
        };
        for (let at = lineStart; at < lineEnd; at++) {
          const ch = source[at];
          bracket(ch);
          if (!stack.length && ch === '、') commas.push(at + 1);
          if (!stack.length && ch === '。') flush(at + 1);
        }
        flush(lineEnd);
      }
      lineStart = lineEnd + 1;
    }
  }
  return units;
}
function renderUnits(units) { return units.map(u => `[${u.s}] ${u.text}`).join('\n'); }
// AI は番号を数値・全角・「12〜14」の形でも返すため、形だけ揃えてから範囲を確かめる。
function unitNumber(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.normalize('NFKC').replace(/[\s[\]]/g, '') : '';
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}
function rangeText(source, units, rawBasis, maxUnits = 4) {
  const basis = typeof rawBasis === 'number' ? String(rawBasis)
    : typeof rawBasis === 'string' ? rawBasis.normalize('NFKC').replace(/[\s[\]]/g, '').replace(/[–—~〜ー−]/g, '-') : '';
  if (!/^[1-9]\d*(?:-[1-9]\d*)?$/.test(basis)) return null;
  const [first, last = first] = basis.split('-').map(Number);
  if (last < first || last - first >= maxUnits) return null;
  const selected = units.filter(u => u.s >= first && u.s <= last);
  if (selected.length !== last - first + 1 || selected.some(u => u.segment !== selected[0].segment)) return null;
  const start = selected[0].start, end = selected.at(-1).end;
  return { text: source.slice(start, end), start, end };
}
module.exports = { splitUnits, renderUnits, rangeText, unitNumber };
