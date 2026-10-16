'use strict';

const { escapeHtml } = require('./review-auth');

// CSP に加える二重の守り。認めたタグと属性だけで HTML を組み直す。
// id/name も引き継がず、本文から操作ボタンやスクリプトの参照先を差し替えさせない。
const tags = new Set('p br hr h1 h2 h3 h4 h5 h6 ul ol li strong em b i u s del blockquote pre code table thead tbody tfoot tr th td a img span sup sub details summary dl dt dd'.split(' '));
const rawText = new Set('script style textarea title xmp iframe noembed noframes plaintext svg math'.split(' '));
const voidTags = new Set(['br', 'hr', 'img']);
const closesParagraph = new Set('p ul ol li dt dd table blockquote pre h1 h2 h3 h4 h5 h6 hr dl details summary'.split(' '));

function decodeUrl(value) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, number) => {
    const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  }).replace(/&(colon|tab|newline|amp|quot|apos);/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'" }[name.toLowerCase()]));
}

function sanitizeReviewHtml(html) {
  const source = String(html || '');
  let output = '';
  let index = 0;
  const openTags = [];
  let nestedTables = 0;
  const closeThrough = position => {
    while (openTags.length > position) {
      const tag = openTags.pop();
      output += `</${tag}>`;
      if (tag === 'table') { output += '</div>'; nestedTables = 0; }
    }
  };
  const closePrevious = (names, boundaries = []) => {
    for (let i = openTags.length - 1; i >= 0; i--) {
      if (boundaries.includes(openTags[i])) return;
      if (names.includes(openTags[i])) { closeThrough(i); return; }
    }
  };
  while (index < source.length) {
    if (source[index] !== '<') {
      const end = source.indexOf('<', index);
      output += source.slice(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    const match = source.slice(index).match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i);
    if (!match) { output += '&lt;'; index++; continue; }
    index += match[0].length;
    const closing = !!match[1];
    const tag = match[2].toLowerCase();
    if (!closing && rawText.has(tag)) {
      const end = new RegExp(`<\\/\\s*${tag}\\s*>`, 'gi');
      end.lastIndex = index;
      const close = end.exec(source);
      index = close ? end.lastIndex : source.length;
      continue;
    }
    if (!tags.has(tag)) continue;
    if (tag === 'table') {
      if (!closing && openTags.includes('table')) { nestedTables++; continue; }
      if (closing && nestedTables > 0) { nestedTables--; continue; }
    }
    if (closing) {
      const position = openTags.lastIndexOf(tag);
      if (position >= 0) closeThrough(position);
      continue;
    }
    // ブラウザによる暗黙の閉鎖と、出力する閉じタグがずれないようにする。
    if (closesParagraph.has(tag)) closePrevious(['p']);
    if (tag === 'li') closePrevious(['li'], ['ul', 'ol']);
    if (tag === 'dt' || tag === 'dd') closePrevious(['dt', 'dd'], ['dl']);
    const attrs = [];
    const seen = new Set();
    let href = '';
    let localImage = false;
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attr of match[3].matchAll(attrPattern)) {
      const name = attr[1].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      let value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
        value = decodeUrl(value);
        if (/[\x00-\x20\x7f\\]/.test(value) || !/^(?:https?:|mailto:|#|\/)/i.test(value)) continue;
        if (tag === 'img') {
          if (!/^\/(?!\/)/.test(value)) continue;
          localImage = true;
        } else href = value;
      } else if (name === 'title' || (tag === 'img' && name === 'alt')) {
        // 文字列は下で属性用にエスケープする。
      } else if (['th', 'td'].includes(tag) && name === 'align' && /^(?:left|center|right)$/.test(value)) {
        // GFM の表の列揃えも残す。
      } else if (['colspan', 'rowspan', 'width', 'height', 'start'].includes(name) && /^\d{1,4}$/.test(value)) {
        // 表や箇条書きなどの普通の書式を残す。
      } else continue;
      attrs.push(`${name}="${escapeHtml(value)}"`);
    }
    if (tag === 'img' && !localImage) continue;
    if (tag === 'a' && href && !href.startsWith('#')) attrs.push('target="_blank"', 'rel="noopener noreferrer"');
    // 本文のdivは認めず、表の開閉と必ず対になる包みだけをここで作る。
    if (tag === 'table') output += '<div class="table-wrapper">';
    output += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (!voidTags.has(tag)) openTags.push(tag);
  }
  // 本文の枠を抜けたり、後ろの操作欄までリンクが広がったりしないよう閉じる。
  closeThrough(0);
  return output;
}

// HTML の script 要素では JSON の文字列内でも </script> が閉じタグになる。
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function httpsLink(value, label = value) {
  const text = escapeHtml(label);
  return /^https:\/\//.test(value || '')
    ? `<a href="${escapeHtml(value)}" target="_blank" rel="noopener">${text} <i class="bi bi-box-arrow-up-right"></i></a>`
    : text;
}

module.exports = { sanitizeReviewHtml, scriptJson, httpsLink };
