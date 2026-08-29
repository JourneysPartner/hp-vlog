'use strict';

/** 安全なDOM生成の最小入口。文字列は必ずtextContentとして追加する。 */
function el(tag, attrs = {}, children = []) {
  if (typeof document === 'undefined') throw new Error('DOMを利用できない環境です');
  const element = document.createElement(tag);

  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'className') {
      element.className = String(value);
    } else if (name === 'textContent') {
      element.textContent = String(value);
    } else if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(name, '');
    } else {
      element.setAttribute(name, String(value));
    }
  }

  const values = Array.isArray(children) ? children : [children];
  for (const child of values.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      const text = document.createTextNode('');
      text.textContent = String(child);
      element.appendChild(text);
    } else {
      element.appendChild(child);
    }
  }
  return element;
}

module.exports = Object.freeze({ el });
