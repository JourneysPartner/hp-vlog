'use strict';

const { el } = require('./dom.js');

// 税制上の上限ではなく、巨大入力による資源消費を防ぐWire表現上の上限。
const MAX_MONEY_DIGITS = 30;
const MONEY_WIRE_PATTERN = /^-?[0-9]+$/;
const FULL_WIDTH_DIGITS = '０１２３４５６７８９';

function error(code) {
  return Object.freeze({ ok: false, code });
}

function normalizeMoneyText(text) {
  return String(text).replace(/[０-９]/g, digit => String(FULL_WIDTH_DIGITS.indexOf(digit)))
    .replaceAll('，', ',')
    .replaceAll('．', '.')
    .replaceAll('－', '-')
    .replaceAll('−', '-')
    .replace(/[\s\u3000]/g, '')
    .replace(/円$/, '');
}

function parseMoneyInput(text) {
  if (typeof text !== 'string') return error('MONEY_INVALID_TYPE');
  let normalized = normalizeMoneyText(text);
  if (normalized.length === 0) return error('MONEY_EMPTY');
  if (normalized.startsWith('-')) return error('MONEY_NEGATIVE');
  if (normalized.includes('.')) return error('MONEY_FRACTIONAL_YEN');

  let multiplier = 1n;
  if (normalized.endsWith('億')) {
    multiplier = 100000000n;
    normalized = normalized.slice(0, -1);
  } else if (normalized.endsWith('万')) {
    multiplier = 10000n;
    normalized = normalized.slice(0, -1);
  }
  if (normalized.includes('万') || normalized.includes('億')) return error('MONEY_INVALID_FORMAT');
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(normalized)) {
    return error('MONEY_INVALID_FORMAT');
  }

  const digits = normalized.replaceAll(',', '').replace(/^0+(?=[0-9])/, '');
  const value = (BigInt(digits) * multiplier).toString(10);
  if (value.length > MAX_MONEY_DIGITS) return error('MONEY_OVERFLOW');
  return Object.freeze({ ok: true, value });
}

function assertMoneyWire(wire) {
  if (typeof wire !== 'string' || !MONEY_WIRE_PATTERN.test(wire)) {
    throw new TypeError('金額は指数表記・桁区切り・小数点を含まないWire文字列で指定してください');
  }
  return BigInt(wire);
}

function formatDisplayMoney(wire) {
  const value = assertMoneyWire(wire);
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString(10);
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function formatJapaneseUnit(value) {
  if (value !== 0n && value % 100000000n === 0n) {
    return `${(value / 100000000n).toLocaleString('ja-JP')}億円`;
  }
  if (value !== 0n && value % 10000n === 0n) {
    return `${(value / 10000n).toLocaleString('ja-JP')}万円`;
  }
  return null;
}

function formatMoneyConfirmation(wire) {
  const value = assertMoneyWire(wire);
  const unit = formatJapaneseUnit(value);
  const yen = `${formatDisplayMoney(wire)}円`;
  return unit === null ? yen : `${yen}（${unit}）`;
}

/**
 * 金額欄と確認表示を一体で作る。入力文字列自体は変更せず、IME確定後だけ解釈を更新する。
 */
function createMoneyInput(options = {}) {
  const inputId = options.id || `money-input-${createMoneyInput.nextId++}`;
  const confirmationId = `${inputId}-confirmation`;
  const descriptionId = options.description ? `${inputId}-description` : null;
  const describedBy = [descriptionId, confirmationId].filter(Boolean).join(' ');
  const input = el('input', {
    id: inputId,
    name: options.name || inputId,
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    'aria-describedby': describedBy,
  });
  const confirmation = el('p', { id: confirmationId, 'aria-live': 'off' }, '');
  let composing = false;
  let parsed = error('MONEY_EMPTY');

  function update() {
    if (composing) return parsed;
    parsed = parseMoneyInput(input.value);
    confirmation.textContent = parsed.ok ? formatMoneyConfirmation(parsed.value) : '';
    if (typeof options.onChange === 'function') options.onChange(parsed);
    return parsed;
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('input', update);
  input.addEventListener('change', update);

  const children = [];
  if (options.label) children.push(el('label', { for: inputId }, options.label));
  if (options.description) children.push(el('p', { id: descriptionId }, options.description));
  children.push(input, confirmation);
  return Object.freeze({
    element: el('div', { className: 'money-input' }, children),
    input,
    confirmation,
    read: () => parsed,
    clear() {
      input.value = '';
      parsed = error('MONEY_EMPTY');
      confirmation.textContent = '';
    },
  });
}
createMoneyInput.nextId = 1;

module.exports = Object.freeze({
  parseMoneyInput,
  formatMoneyConfirmation,
  formatDisplayMoney,
  createMoneyInput,
  MAX_MONEY_DIGITS,
});
