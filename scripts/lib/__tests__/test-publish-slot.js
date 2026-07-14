'use strict';

/**
 * 公開枠の決定（article_role ベース）のテスト。
 *   node scripts/lib/__tests__/test-publish-slot.js
 *
 * 本命(main)+補強(support)を短時間に承認したとき、レースで両方 morning になって
 * 同時公開されないこと（ペアは必ず別枠）を検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { decidePublishSlot } = require(path.join(ROOT, 'netlify/functions/review-approve-background'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== Test: decidePublishSlot ===');
// 役割ベースの既定
assert(decidePublishSlot('main', false, false) === 'morning', '本命は morning が既定');
assert(decidePublishSlot('support', false, false) === 'evening', '補強は evening が既定');

// レース: 補強承認時に本命(main)がまだ main に反映されていない（hasMorning=false）でも evening
assert(decidePublishSlot('support', false, false) === 'evening', 'レース時でも補強は evening（両方morningにならない）');

// ペアが確実に別枠に分かれる
const mainSlot = decidePublishSlot('main', false, false);
const supportSlot = decidePublishSlot('support', mainSlot === 'morning', mainSlot === 'evening');
assert(mainSlot !== supportSlot, 'ペア（本命+補強）は別枠になる');
assert(mainSlot === 'morning' && supportSlot === 'evening', '本命=morning / 補強=evening');

// 逆枠が空いていて同枠が埋まっていればバランスを取る
assert(decidePublishSlot('main', true, false) === 'evening', '本命: morning既存・evening空 → evening に回す');
assert(decidePublishSlot('support', false, true) === 'morning', '補強: evening既存・morning空 → morning に回す');

// 両枠埋まりなら既定を維持
assert(decidePublishSlot('main', true, true) === 'morning', '本命: 両枠埋まりでも morning 既定');
assert(decidePublishSlot('support', true, true) === 'evening', '補強: 両枠埋まりでも evening 既定');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
