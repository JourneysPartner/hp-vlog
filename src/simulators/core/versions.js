'use strict';

/** シミュレーターサービスが結果へ載せる版番号の単一定義。 */
const calculationVersion = 'calc-2026.08.1';
const inputSchemaVersions = Object.freeze({
  hojinnari: 'hojinnari-1.0',
  shohizei: 'shohizei-1.0',
  sozoku: 'sozoku-1.0',
  yakuin_hoshu: 'yakuin-hoshu-1.0',
});
const supportedProfileVersion = 'initial-1';

module.exports = Object.freeze({
  calculationVersion,
  inputSchemaVersions,
  supportedProfileVersion,
});
