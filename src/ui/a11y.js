'use strict';

let statusRegion = null;
let alertRegion = null;
let alertPending = false;

function nextFrame(action) {
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : callback => setTimeout(callback, 16);
  return new Promise(resolve => schedule(() => {
    action();
    resolve();
  }));
}

function liveRegion(role) {
  if (typeof document === 'undefined') throw new Error('DOMを利用できない環境です');
  const current = role === 'status' ? statusRegion : alertRegion;
  if (current && current.isConnected) return current;
  const region = document.createElement('div');
  region.setAttribute('role', role);
  region.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.className = 'simulator-live-region';
  document.body.appendChild(region);
  if (role === 'status') statusRegion = region;
  else alertRegion = region;
  return region;
}

function announceStatus(text) {
  const region = liveRegion('status');
  return nextFrame(() => { region.textContent = String(text); }).then(() => region);
}

function announceAlert(text) {
  const region = liveRegion('alert');
  // 同一イベントループ内を1操作とし、alertの多重発火を抑止する。
  if (alertPending) return Promise.resolve(region);
  alertPending = true;
  return nextFrame(() => { region.textContent = String(text); }).then(() => {
    alertPending = false;
    return region;
  });
}

function focusResultHeading(element) {
  if (!element || typeof element.focus !== 'function') {
    return Promise.reject(new TypeError('結果見出しの要素を指定してください'));
  }
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  // 通知挿入とは必ず別描画にするため、フォーカスは2フレーム後へ送る。
  return nextFrame(() => {}).then(() => nextFrame(() => element.focus()));
}

module.exports = Object.freeze({ announceStatus, announceAlert, focusResultHeading });
