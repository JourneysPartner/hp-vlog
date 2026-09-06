'use strict';

/**
 * 国税庁 Q&A の添付が、記事の論点と無関係な資料に流れないことのテスト。
 *   node scripts/lib/__tests__/test-nta-qa-scope.js
 *
 * 背景（2026-09-06）: 土地の一部譲渡の記事に「暗号資産取引で損失が生じた場合」が
 *   添付された。income_tax の資料が暗号資産 FAQ しか無く、税目でしか絞っていなかった。
 *   資料レベル（scope）と文書レベル（見出し一致）の 2 段で止める。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const qa = require(path.join(ROOT, 'scripts/lib/nta-qa'));
const qaSources = require(path.join(ROOT, 'scripts/lib/nta-qa-sources'));
const { SOURCES } = require(path.join(ROOT, 'scripts/crawl-nta-qa'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else      { console.error(`  NG ${label}`); failed++; }
}

const split = text => text.split(/[ 、。？?・／/]+/).filter(w => w.length >= 2);

console.log('=== 資料レベル: scope に当たらない資料は候補にしない ===');

const land = '一括して購入した土地の一部を譲渡した場合の取得費 譲渡所得 取得費 面積按分 時価按分';
const landDocs = qa.findQaByKeywords(split(land), { taxDomain: 'income_tax', maxDocs: 3, scopeText: land });
assert(landDocs.length === 0, '土地の一部譲渡（所得税）に暗号資産 FAQ が付かない');
assert(qaSources.eligibleSourceKeys(land).size === 0, 'この記事メタに当たる資料は 1 つも無い');

const crypto = 'ビットコインを売却したときの所得区分と損失の取扱い 暗号資産 雑所得';
const cryptoDocs = qa.findQaByKeywords(split(crypto), { taxDomain: 'income_tax', maxDocs: 3, scopeText: crypto });
assert(cryptoDocs.length > 0 && cryptoDocs.every(d => d.source_label.includes('暗号資産')),
  '暗号資産の記事には暗号資産 FAQ が付く');

const expenses = 'Amazonセラーが経費にできるもの 仕入 送料 手数料 帳簿';
const expDocs = qa.findQaByKeywords(split(expenses), { taxDomain: 'bookkeeping_expenses', maxDocs: 3, scopeText: expenses });
assert(expDocs.length === 0, '経費の記事に電子帳簿保存法の一問一答が付かない');

const denshi = '電子取引 電子帳簿保存法 保存方法 請求書をPDFでメール受領したときの電子データの保存';
const denshiDocs = qa.findQaByKeywords(split(denshi), { taxDomain: 'bookkeeping_expenses', maxDocs: 3, scopeText: denshi });
assert(denshiDocs.length > 0 && denshiDocs.every(d => d.source_label.includes('電子帳簿保存法')),
  '電子取引の記事には電子帳簿保存法の一問一答が付く');

console.log('');
console.log('=== 文書レベル: 見出しに検索語が当たらない問は渡さない ===');

const eatin = 'イートインとテイクアウトで消費税率は変わる 軽減税率 意思確認 飲食料品';
const eatinDocs = qa.findQaByKeywords(split(eatin), { taxDomain: 'consumption_tax', maxDocs: 3, scopeText: eatin });
assert(eatinDocs.length > 0, '軽減税率の記事には軽減税率 Q&A が付く');
assert(eatinDocs.every(d => d.titleHits > 0), '付いた問はすべて見出しに検索語が当たっている');

console.log('');
console.log('=== 運用: 資料の定義と scope の整合 ===');

const missing = qaSources.sourceKeysWithoutScope(Object.keys(SOURCES));
assert(missing.length === 0, `crawl-nta-qa.js の全資料に scope がある（未定義: ${missing.join(', ') || 'なし'}）`);
assert(qaSources.eligibleSourceKeys('').size === 0, '空のメタには何も当たらない');
assert(qaSources.eligibleSourceKeys('インボイスの２割特例').has('invoice'), '全角の数字も同一視する');
assert(!qaSources.eligibleSourceKeys('何も関係ない文', { new_source: [] }).has('new_source'),
  'scope が空の資料は候補にならない（安全側）');

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
