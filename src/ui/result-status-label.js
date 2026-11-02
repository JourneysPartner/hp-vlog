'use strict';

const RESULT_STATUS_LABELS = Object.freeze({
  complete: '計算完了',
  partial: '一部概算',
  blocked: '停止',
});

function resultStatusLabel(status) {
  if (!Object.prototype.hasOwnProperty.call(RESULT_STATUS_LABELS, status)) {
    throw new TypeError(`未知の結果状態です: ${status}`);
  }
  return RESULT_STATUS_LABELS[status];
}

module.exports = Object.freeze({ RESULT_STATUS_LABELS, resultStatusLabel });
