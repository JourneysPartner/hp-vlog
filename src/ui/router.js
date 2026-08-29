'use strict';

const TOOL_PATHS = Object.freeze({
  hojinnari: '/tools/hojinnari-simulator/',
  shohizei: '/tools/shohizei-simulator/',
  sozoku: '/tools/sozokuzei-simulator/',
  yakuinHoshu: '/tools/yakuin-hoshu-simulator/',
});

function toolFromPath(pathname) {
  return Object.keys(TOOL_PATHS).find(tool => TOOL_PATHS[tool] === pathname) || null;
}

function createRouter(options = {}) {
  const browserWindow = options.windowObject || (typeof window === 'undefined' ? null : window);
  if (!browserWindow || !browserWindow.history || !browserWindow.location) {
    throw new Error('History APIを利用できない環境です');
  }
  const onNavigate = typeof options.onNavigate === 'function' ? options.onNavigate : () => {};

  function navigate(tool, replace = false) {
    if (!Object.hasOwn(TOOL_PATHS, tool)) throw new RangeError('未知のシミュレーターです');
    const method = replace ? 'replaceState' : 'pushState';
    // stateにはツール識別子だけを置き、入力値・結果・Handoffはメモリ内ストアに残す。
    browserWindow.history[method]({ tool }, '', TOOL_PATHS[tool]);
    onNavigate(tool);
    return tool;
  }

  function onPopState() {
    const tool = toolFromPath(browserWindow.location.pathname);
    if (tool !== null) onNavigate(tool);
  }

  browserWindow.addEventListener('popstate', onPopState);
  return Object.freeze({
    navigate,
    current: () => toolFromPath(browserWindow.location.pathname),
    destroy: () => browserWindow.removeEventListener('popstate', onPopState),
  });
}

module.exports = Object.freeze({ TOOL_PATHS, toolFromPath, createRouter });
