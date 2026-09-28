'use strict';

const { locateQuery } = require('../query-placement');
const fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log('=== 検索語の所在判定 ===');

assert(locateQuery('塗料 勘定科目', {
  title: '塗料の勘定科目と仕訳',
  headings: ['経費の考え方'],
  body: '本文です。',
}) === 'title', '題名に全トークンがあれば title');

assert(locateQuery('簡易 インボイス', {
  title: '適格請求書の解説',
  headings: ['簡易インボイスの必要事項'],
  body: '本文です。',
}) === 'h2', '見出しに全トークンがあれば h2');

assert(locateQuery('人工代 仕訳', {
  title: '建設業の外注費',
  headings: ['外注費の基本'],
  body: '人工代の仕訳例も確認します。',
}) === 'body', '本文に全トークンがあれば body');

assert(locateQuery('相続税 申告', {
  title: '贈与税の解説', headings: ['必要書類'], body: '申告の流れ。',
}) === 'none', '全トークンが同じ場所に無ければ none');

assert(locateQuery('相続税 申告', {
  title: '', headings: ['相続税の基本', '申告の手順'], body: '別の本文です。',
}) === 'none', '別々の h2 に分かれたトークンは h2 一致にしない');

assert(locateQuery('インボイス 制度', {
  title: 'インボイス制度の実務', headings: [], body: '',
}) === 'title', 'トークンは連続する文字列にも部分一致する');

assert(locateQuery('EBAY TAX', {
  title: 'eBay Tax Guide', headings: [], body: '',
}) === 'title', '英字の大文字小文字を区別しない');

assert(locateQuery('簡易インボイス', { title: '適格簡易請求書の書き方' }) === 'title', '正式名称を通称と同じ語として扱う');
assert(locateQuery('別の語', { title: '別の語の解説' }, { synonyms: [] }) === 'title', '同義語を指定しない語は従来どおり');
const originalRead = fs.readFileSync;
const modulePath = require.resolve('../query-placement');
try {
  fs.readFileSync = function(file, ...args) {
    if (String(file).endsWith('query-synonyms.json')) throw Object.assign(new Error('見つかりません'), { code: 'ENOENT' });
    return originalRead.call(this, file, ...args);
  };
  delete require.cache[modulePath];
  const withoutFile = require('../query-placement').locateQuery;
  assert(withoutFile('簡易インボイス', { title: '簡易インボイスの説明' }) === 'title', '同義語ファイルが無くても判定する');
} finally {
  fs.readFileSync = originalRead;
  delete require.cache[modulePath];
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
