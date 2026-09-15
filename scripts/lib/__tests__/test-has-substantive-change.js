'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const {
  TIMESTAMP_KEY_RE,
  stripTimestamps,
  isSameContent,
} = require(path.join(ROOT, 'scripts/has-substantive-change'));

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

console.log('\n=== has-substantive-change ===');

test('浅い時刻キーを取り除く', () => {
  assert.deepStrictEqual(stripTimestamps({ a: 1, fetched_at: 'x' }), { a: 1 });
});

test('入れ子の時刻キーを再帰的に取り除く', () => {
  assert.deepStrictEqual(
    stripTimestamps({ meta: { generated_at: 'x', n: 3 } }),
    { meta: { n: 3 } },
  );
});

test('配列内の時刻キーを取り除き、配列順は保つ', () => {
  assert.deepStrictEqual(
    stripTimestamps([{ fetched_at: 'x', n: 2 }, { n: 1 }]),
    [{ n: 2 }, { n: 1 }],
  );
});

test('last_crawl_duration_seconds を取り除く', () => {
  assert.deepStrictEqual(stripTimestamps({ last_crawl_duration_seconds: 12, n: 1 }), { n: 1 });
});

test('_at で終わらない普通のキーは残す', () => {
  const value = { format: 'json', treat: true, at_home: 2 };
  assert.deepStrictEqual(stripTimestamps(value), value);
  assert(!TIMESTAMP_KEY_RE.test('format'));
  assert(!TIMESTAMP_KEY_RE.test('treat'));
  assert(!TIMESTAMP_KEY_RE.test('at_home'));
});

test('値の形式を見ず、_at で終わるキー名だけで取り除く', () => {
  assert.deepStrictEqual(stripTimestamps({ checked_at: 123, nested: { odd_at: false } }), { nested: {} });
});

test('null・数値・文字列はそのまま返す', () => {
  assert.strictEqual(stripTimestamps(null), null);
  assert.strictEqual(stripTimestamps(42), 42);
  assert.strictEqual(stripTimestamps('text'), 'text');
});

test('時刻だけ違う内容は同じと判定する', () => {
  assert(isSameContent({ n: 1, fetched_at: 'old' }, { n: 1, fetched_at: 'new' }));
});

test('本文が1文字違えば変更と判定する', () => {
  assert(!isSameContent({ title: 'abc' }, { title: 'abd' }));
});

test('オブジェクトのキー順だけ違う内容は同じと判定する', () => {
  assert(isSameContent({ a: 1, b: 2 }, { b: 2, a: 1 }));
});

test('配列の要素順が違えば変更と判定する', () => {
  assert(!isSameContent([{ n: 1 }, { n: 2 }], [{ n: 2 }, { n: 1 }]));
});

test('片方に新しいキーが増えれば変更と判定する', () => {
  assert(!isSameContent({ a: 1 }, { a: 1, b: 2 }));
});

test('deleted: true は時刻だけの変化と同時でも必ず拾う', () => {
  assert(!isSameContent(
    { n: 1, checked_at: 'old' },
    { n: 1, checked_at: 'new', deleted: true },
  ));
});

test('実データで同一・時刻のみ・本文変更を区別する', () => {
  const filename = path.join(ROOT, 'data/nta-tsutatsu/shotoku.json');
  const actual = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const timestampOnly = JSON.parse(JSON.stringify(actual));
  timestampOnly.fetched_at = '値の形式は問わない';
  const substantive = JSON.parse(JSON.stringify(actual));
  const firstProvision = Object.keys(substantive.provisions)[0];
  substantive.provisions[firstProvision].title += '変更';

  assert(isSameContent(actual, actual));
  assert(isSameContent(actual, timestampOnly));
  assert(!isSameContent(actual, substantive));
});

console.log(`\n${passed} tests passed`);
