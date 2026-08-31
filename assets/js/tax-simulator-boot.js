'use strict';

/**
 * 配信後にも停止操作を効かせるためのランタイムゲート。
 * CommonJS では純関数をテストでき、ブラウザでは同じファイルが boot を開始する。
 */
(function exposeRuntimeGate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.TaxSimulatorRuntimeGate = api;
    const start = () => api.bootSimulator();
    const currentScript = root.document.currentScript;
    if (!currentScript || !currentScript.hasAttribute('data-manual-boot')) {
      if (root.document.readyState === 'loading') {
        root.document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
    }
  }
})(typeof window === 'object' ? window : null, function createRuntimeGate() {
  const STOP_REASONS = Object.freeze({
    STATUS_FETCH_FAILED: Object.freeze({
      category: 'マスター blocked',
      detail: '公開状態を取得できないため、安全のため停止しました。',
    }),
    STATUS_INVALID: Object.freeze({
      category: 'マスター blocked',
      detail: '公開状態を検証できないため、安全のため停止しました。',
    }),
    TOOL_DISABLED: Object.freeze({
      category: '公開設定による停止',
      detail: '制度確認期限切れ、マスター blocked、監修失効、既知不具合のいずれかを確認しています。',
    }),
    SNAPSHOT_MISMATCH: Object.freeze({
      category: 'マスター blocked',
      detail: 'ページの計算基準と公開中のマスタースナップショットが一致しません。',
    }),
    VERIFY_FAILED: Object.freeze({
      category: 'マスター blocked',
      detail: '計算基準の整合性を検証できないため、安全のため停止しました。',
    }),
    MOUNT_FAILED: Object.freeze({
      category: '既知不具合',
      detail: '計算画面を安全に起動できませんでした。',
    }),
  });

  function stopped(code) {
    const reason = STOP_REASONS[code] || STOP_REASONS.STATUS_INVALID;
    return Object.freeze({ allowed: false, code, category: reason.category, detail: reason.detail });
  }

  /** 入出力に副作用を持たない、停止側既定の判定関数。 */
  function evaluateRuntimeGate({
    status = null,
    statusError = null,
    simulatorType,
    expectedSnapshotId,
    devStatusOverride,
  } = {}) {
    if (devStatusOverride !== undefined) status = devStatusOverride;
    else if (statusError) return stopped('STATUS_FETCH_FAILED');

    if (!status || typeof status !== 'object' || Array.isArray(status) ||
        typeof status.snapshotId !== 'string' ||
        !status.tools || typeof status.tools !== 'object' || Array.isArray(status.tools) ||
        typeof simulatorType !== 'string' || typeof expectedSnapshotId !== 'string') {
      return stopped('STATUS_INVALID');
    }
    const toolStatus = status.tools[simulatorType];
    if (!toolStatus || typeof toolStatus !== 'object' || toolStatus.enabled !== true) {
      return stopped('TOOL_DISABLED');
    }
    if (status.snapshotId !== expectedSnapshotId) return stopped('SNAPSHOT_MISMATCH');
    return Object.freeze({ allowed: true, code: 'CONTINUE', category: null, detail: null });
  }

  function renderStop(rootElement, result) {
    const documentObject = rootElement.ownerDocument;
    const section = documentObject.createElement('section');
    section.className = 'simulator-stop';
    section.setAttribute('role', 'alert');

    const heading = documentObject.createElement('h2');
    heading.textContent = 'このシミュレーターは現在停止しています';
    const category = documentObject.createElement('p');
    category.className = 'simulator-stop-category';
    category.textContent = `停止理由の区分：${result.category}`;
    const detail = documentObject.createElement('p');
    detail.textContent = result.detail;
    const guidance = documentObject.createElement('p');
    guidance.append('お急ぎの場合は');
    const link = documentObject.createElement('a');
    link.href = '/contact.html';
    link.textContent = 'お問い合わせ窓口';
    guidance.append(link, 'からご相談ください。');
    section.append(heading, category, detail, guidance);
    rootElement.replaceChildren(section);
  }

  function mountForType(api, simulatorType, rootElement) {
    const methods = {
      hojinnari: 'mountHojinnari',
      shohizei: 'mountShohizei',
      sozoku: 'mountSozoku',
      yakuin_hoshu: 'mountYakuinHoshu',
    };
    const method = methods[simulatorType];
    if (!method || typeof api[method] !== 'function') throw new Error('未対応のシミュレーターです');
    return api[method](rootElement);
  }

  /**
   * devStatusOverride は file:// の明示的な開発プレビュー専用。
   * 本番の自動起動は引数なしで呼ぶため、前回値や暗黙の迂回は存在しない。
   */
  async function bootSimulator(options = {}) {
    if (typeof document !== 'object') return null;
    const rootElement = options.rootElement || document.querySelector('[data-simulator]');
    if (!rootElement) return null;
    const simulatorType = options.simulatorType || rootElement.getAttribute('data-simulator');
    const api = options.api || (typeof window === 'object' ? window.TaxSimulator : null);
    if (!api || !api.snapshotInfo || typeof api.verify !== 'function') {
      const result = stopped('VERIFY_FAILED');
      renderStop(rootElement, result);
      return result;
    }

    let status = null;
    let statusError = null;
    if (options.devStatusOverride !== undefined) {
      status = options.devStatusOverride;
    } else {
      try {
        const response = await fetch('/tools/simulator-status.json', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        status = await response.json();
      } catch (error) {
        statusError = error;
      }
    }

    const decision = evaluateRuntimeGate({
      status,
      statusError,
      simulatorType,
      expectedSnapshotId: api.snapshotInfo.snapshotId,
      devStatusOverride: options.devStatusOverride,
    });
    if (!decision.allowed) {
      renderStop(rootElement, decision);
      return decision;
    }

    try {
      await api.verify();
    } catch (error) {
      const result = stopped('VERIFY_FAILED');
      renderStop(rootElement, result);
      return result;
    }
    try {
      mountForType(api, simulatorType, rootElement);
      return decision;
    } catch (error) {
      const result = stopped('MOUNT_FAILED');
      renderStop(rootElement, result);
      return result;
    }
  }

  return Object.freeze({ evaluateRuntimeGate, bootSimulator });
});
