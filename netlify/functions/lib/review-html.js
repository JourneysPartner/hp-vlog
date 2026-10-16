'use strict';

const { escapeHtml } = require('./review-auth');

// CSP に加える二重の守り。認めたタグと属性だけで HTML を組み直す。
// id/name も引き継がず、本文から操作ボタンやスクリプトの参照先を差し替えさせない。
const tags = new Set('p br hr h1 h2 h3 h4 h5 h6 ul ol li strong em b i u s del blockquote pre code table thead tbody tfoot tr th td a img div span sup sub details summary dl dt dd'.split(' '));
const rawText = new Set('script style textarea title xmp iframe noembed noframes plaintext svg math'.split(' '));

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
    if (closing) { output += `</${tag}>`; continue; }
    const attrs = [];
    const seen = new Set();
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attr of match[3].matchAll(attrPattern)) {
      const name = attr[1].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      let value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
        value = decodeUrl(value);
        if (/[\x00-\x20\x7f\\]/.test(value) || !/^(?:https?:|mailto:|#|\/)/i.test(value)) continue;
      } else if (name === 'title' || (tag === 'img' && name === 'alt')) {
        // 文字列は下で属性用にエスケープする。
      } else if (['th', 'td'].includes(tag) && name === 'align' && /^(?:left|center|right)$/.test(value)) {
        // GFM の表の列揃えも残す。
      } else if (['colspan', 'rowspan', 'width', 'height', 'start'].includes(name) && /^\d{1,4}$/.test(value)) {
        // 表や箇条書きなどの普通の書式を残す。
      } else continue;
      attrs.push(`${name}="${escapeHtml(value)}"`);
    }
    output += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  }
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
