'use strict';

const ALLOWED_EVENTS = Object.freeze([
  'simulator_view',
  'simulator_start',
  'simulator_complete',
  'simulator_mode',
  'simulator_cta_click',
]);
const TOOLS = Object.freeze(['hojinnari', 'shohizei', 'sozoku', 'yakuinHoshu']);
const MODES = Object.freeze(['simple', 'detailed', 'A', 'B', 'C', 'level1', 'level2']);
const RESULT_STATUSES = Object.freeze(['complete', 'partial', 'blocked']);
const queue = [];

const EVENT_SHAPES = Object.freeze({
  simulator_view: Object.freeze({ required: ['tool'], allowed: ['tool'] }),
  simulator_start: Object.freeze({ required: ['tool'], allowed: ['tool'] }),
  simulator_complete: Object.freeze({ required: ['tool', 'resultStatus'], allowed: ['tool', 'resultStatus'] }),
  simulator_mode: Object.freeze({ required: ['tool', 'mode'], allowed: ['tool', 'mode'] }),
  simulator_cta_click: Object.freeze({ required: ['tool'], allowed: ['tool'] }),
});

function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new RangeError(`${name}が許可リスト外です`);
}

function queueEvent(eventName, payload) {
  if (!ALLOWED_EVENTS.includes(eventName)) throw new RangeError('許可されていないAnalyticsイベントです');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Analyticsペイロードはオブジェクトで指定してください');
  }
  const shape = EVENT_SHAPES[eventName];
  const keys = Object.keys(payload);
  if (shape.required.some(key => !keys.includes(key)) || keys.some(key => !shape.allowed.includes(key))) {
    throw new TypeError(`${eventName}のAnalyticsペイロード項目が許可リストと一致しません`);
  }
  assertEnum(payload.tool, TOOLS, 'tool');
  if (Object.hasOwn(payload, 'mode')) assertEnum(payload.mode, MODES, 'mode');
  if (Object.hasOwn(payload, 'resultStatus')) {
    assertEnum(payload.resultStatus, RESULT_STATUSES, 'resultStatus');
  }
  const event = Object.freeze({ eventName, payload: Object.freeze({ ...payload }) });
  queue.push(event);
  return event;
}

function simulatorView(tool) { return queueEvent('simulator_view', { tool }); }
function simulatorStart(tool) { return queueEvent('simulator_start', { tool }); }
function simulatorComplete(tool, resultStatus) {
  return queueEvent('simulator_complete', { tool, resultStatus });
}
function simulatorMode(tool, mode) { return queueEvent('simulator_mode', { tool, mode }); }
function simulatorCtaClick(tool) { return queueEvent('simulator_cta_click', { tool }); }
function getQueuedEvents() { return Object.freeze([...queue]); }
function clearQueue() { queue.length = 0; }

module.exports = Object.freeze({
  queueEvent,
  simulatorView,
  simulatorStart,
  simulatorComplete,
  simulatorMode,
  simulatorCtaClick,
  getQueuedEvents,
  clearQueue,
});
