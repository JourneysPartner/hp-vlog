'use strict';

// 見出しから Markdown / HTML の装飾を除き、ページ内リンク用の id を作る。
function headingPlainText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\\([\\`*_[\]{}()#+\-.!])/g, '$1');
}

function slugifyHeading(text, used = new Set()) {
  const plain = headingPlainText(text).toLowerCase();
  const chars = [];
  for (const char of plain) {
    if (/^[\p{L}\p{Nd}\s]$/u.test(char)) chars.push(char);
  }

  let base = chars.join('').trim().replace(/\s+/gu, '-');
  if (!base) base = 'section';
  if (/^\p{Nd}/u.test(base)) base = `s-${base}`;

  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  used.add(id);
  return id;
}

function createHeadingState() {
  return {
    used: new Set(),
    reset() {
      this.used.clear();
    },
  };
}

function applyHeadingIdRenderer(markedInstance, state) {
  if (!markedInstance || typeof markedInstance.use !== 'function') {
    throw new TypeError('marked のインスタンスが必要です');
  }
  if (!state || !(state.used instanceof Set) || typeof state.reset !== 'function') {
    throw new TypeError('見出し id の状態には used と reset() が必要です');
  }

  markedInstance.use({
    renderer: {
      heading(text, level, raw) {
        if (level !== 2 && level !== 3) return `<h${level}>${text}</h${level}>\n`;
        const id = slugifyHeading(raw, state.used);
        return `<h${level} id="${id}">${text}</h${level}>\n`;
      },
    },
  });
}

function decodeHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildTocHtml(htmlBody, { minH2 = 4 } = {}) {
  const headings = [];
  const headingRe = /<h2\s+[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
  let match;
  while ((match = headingRe.exec(String(htmlBody || ''))) !== null) {
    headings.push({ id: match[1], text: decodeHtmlText(match[2]).trim() });
  }
  if (headings.length < minH2) return '';

  const items = headings
    .map(({ id, text }) => `      <li><a href="#${id}">${escapeHtml(text)}</a></li>`)
    .join('\n');
  return `<nav class="blog-toc" aria-label="目次">
  <details open>
    <summary>目次</summary>
    <ol>
${items}
    </ol>
  </details>
</nav>`;
}

module.exports = Object.freeze({
  slugifyHeading,
  createHeadingState,
  applyHeadingIdRenderer,
  buildTocHtml,
});
