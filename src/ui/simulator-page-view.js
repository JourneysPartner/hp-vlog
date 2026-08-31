'use strict';

const { focusResultHeading } = require('./a11y.js');

const COMPACT_CLASS = 'simulator-intro--compact';

function defaultScrollToAppTop(rootElement) {
  const documentObject = rootElement && rootElement.ownerDocument;
  const windowObject = documentObject && documentObject.defaultView;
  if (!windowObject || typeof windowObject.scrollTo !== 'function' ||
      typeof rootElement.getBoundingClientRect !== 'function') return;
  const top = rootElement.getBoundingClientRect().top + (windowObject.scrollY || 0);
  windowObject.scrollTo({ top, behavior: 'auto' });
}

function viewChanged(state, previous) {
  return Boolean(previous) && (state.screen !== previous.screen || state.step !== previous.step);
}

function createSimulatorPageView(rootElement, {
  isFirstView,
  scrollToAppTop = defaultScrollToAppTop,
  focusHeading = focusResultHeading,
  introElement,
} = {}) {
  if (typeof isFirstView !== 'function') throw new TypeError('最初の画面の判定関数が必要です');
  const documentObject = rootElement && rootElement.ownerDocument;
  const intro = introElement || (documentObject && typeof documentObject.querySelector === 'function'
    ? documentObject.querySelector('.simulator-intro') : null);

  function afterRender(state, previous) {
    if (intro && intro.classList) intro.classList.toggle(COMPACT_CLASS, !isFirstView(state));
    if (!viewChanged(state, previous) || (state.errors && state.errors.length > 0)) return;

    // フォーカスによるブラウザの自動スクロールを抑え、必ずアプリ先頭→見出しの順にする。
    scrollToAppTop(rootElement);
    const heading = typeof rootElement.querySelector === 'function'
      ? rootElement.querySelector('main h1') : null;
    if (heading) void focusHeading(heading);
  }

  function destroy() {
    if (intro && intro.classList) intro.classList.remove(COMPACT_CLASS);
  }

  return Object.freeze({ afterRender, destroy });
}

module.exports = Object.freeze({
  COMPACT_CLASS,
  createSimulatorPageView,
  defaultScrollToAppTop,
  viewChanged,
});
