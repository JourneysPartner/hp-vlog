'use strict';

function pendingLawNoticeFrom(result) {
  const warning = (result.warnings || []).find(item => item.code === 'MASTER_PENDING_LAW_APPLIED');
  return warning ? warning.basis : undefined;
}

module.exports = Object.freeze({ pendingLawNoticeFrom });
