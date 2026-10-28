'use strict';

// コード部分を残し、同じ行で対になる太字だけを HTML に確定する。
function normalizeLine(line) {
  const markers = /`+|\*{2,}/g;
  let opening = null;
  let output = '';
  let copied = 0;
  let marker;
  while ((marker = markers.exec(line)) !== null) {
    if (marker[0][0] === '`') {
      // バッククォートの個数が同じ閉じ記号までを行内コードとして保護する。
      const ticks = /`+/g;
      ticks.lastIndex = markers.lastIndex;
      let closing;
      while ((closing = ticks.exec(line)) !== null) {
        if (closing[0].length === marker[0].length) {
          markers.lastIndex = ticks.lastIndex;
          break;
        }
      }
      continue;
    }

    if (!opening) {
      opening = marker;
      continue;
    }

    const inner = line.slice(opening.index + opening[0].length, marker.index);
    // 3 個以上の星を含む対や、空白で始まる・終わる対は元のまま残す。
    if (opening[0].length === 2 && marker[0].length === 2 && inner &&
        !/^[ \t\u3000]|[ \t\u3000]$/.test(inner)) {
      output += line.slice(copied, opening.index) + `<strong>${inner}</strong>`;
      copied = markers.lastIndex;
    }
    opening = null;
  }
  return output + line.slice(copied);
}

function normalizeBold(markdown) {
  if (typeof markdown !== 'string') return '';
  // 区切りも保持し、LF と CRLF を置き換えずに戻す。
  const lines = markdown.split(/(\r\n|\n|\r)/);
  let fence = null;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          /^[ \t]*$/.test(marker[2])) {
        fence = null;
      }
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    lines[i] = normalizeLine(line);
  }
  return lines.join('');
}

module.exports = { normalizeBold };
