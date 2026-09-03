'use strict';

const assert = require('assert');
const { generateSimulatorCta } = require('../simulator-cta');

function config(enabled = true) {
  return {
    hojinnari: { enabled },
    shohizei: { enabled },
    sozoku: { enabled },
    yakuin_hoshu: { enabled },
  };
}

let passed = 0;
function check(label, action) {
  action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

process.stdout.write('\n=== 記事からシミュレーターCTAを選ぶ ===\n');

check('category 相続は③相続税CTAへ厳密にリンクする', () => {
  const html = generateSimulatorCta({ title: '遺産分割の基礎', category: '相続', _body: '' }, config());
  assert(html.includes('href="/tools/sozokuzei-simulator/"'));
  assert(!html.includes('/tools/shohizei-simulator/'));
  assert(html.includes('相続税がかかるかどうか試算してみる'));
});

check('category 消費税は②消費税CTAへリンクする', () => {
  const html = generateSimulatorCta({ title: '納税の基礎', category: '消費税', _body: '' }, config());
  assert(html.includes('href="/tools/shohizei-simulator/"'));
  assert(html.includes('あなたの場合の消費税を試算してみる'));
});

check('category外でも本文の簡易課税2回で②CTAを挿入する', () => {
  const html = generateSimulatorCta({
    title: '納税方式の届出手続き',
    category: '帳簿・経費',
    _body: '簡易課税を検討します。簡易課税には事前の届出が必要です。',
  }, config());
  assert(html.includes('href="/tools/shohizei-simulator/"'));
});

check('タイトルの法人成りが本文の消費税条件より優先される', () => {
  const html = generateSimulatorCta({
    title: '法人成りを考える',
    category: '所得税',
    _body: '簡易課税と簡易課税、インボイスとインボイスを比較します。',
  }, config());
  assert(html.includes('href="/tools/hojinnari-simulator/"'));
  assert(!html.includes('/tools/shohizei-simulator/'));
});

check('本文の役員報酬が1回だけなら挿入しない', () => {
  const html = generateSimulatorCta({ title: '会社運営の基礎', category: '所得税', _body: '役員報酬を説明します。' }, config());
  assert.strictEqual(html, '');
});

check('本文の役員報酬が2回なら④CTAを挿入する', () => {
  const html = generateSimulatorCta({ title: '会社運営の基礎', category: '所得税', _body: '役員報酬を決めます。役員報酬は定期同額が基本です。' }, config());
  assert(html.includes('href="/tools/yakuin-hoshu-simulator/"'));
  assert(html.includes('役員報酬をいくらにするのがよいか試算してみる'));
});

check('輸出と還付を含む消費税記事にも②CTAを付与する', () => {
  const html = generateSimulatorCta({ title: '輸出取引の消費税還付', category: '消費税', _body: 'インボイス。インボイス。' }, config());
  assert(html.includes('href="/tools/shohizei-simulator/"'));
  assert(html.includes('消費税シミュレーター'));
});

check('相続カテゴリは輸出還付を含むタイトルでも③を判定する', () => {
  const html = generateSimulatorCta({ title: '輸出取引の還付と遺産', category: '相続', _body: '' }, config());
  assert(html.includes('href="/tools/sozokuzei-simulator/"'));
});

check('該当ツールがenabled=falseなら挿入しない', () => {
  const publishConfig = config();
  publishConfig.hojinnari.enabled = false;
  const html = generateSimulatorCta({
    title: '法人成りと納税方式',
    category: '消費税',
    _body: '簡易課税を選びます。簡易課税には届出が必要です。',
  }, publishConfig);
  assert.strictEqual(html, '');
});

check('CTA HTMLはクラス・正しいURL・文言・プライバシー注記を含む', () => {
  const html = generateSimulatorCta({ title: '法人化の判断', category: '所得税', _body: '' }, config());
  assert(html.includes('class="blog-simulator-cta"'));
  assert(html.includes('href="/tools/hojinnari-simulator/"'));
  assert(html.includes('法人化でどれくらい変わるか、あなたの数字で試算してみる'));
  assert(html.includes('法人成りシミュレーター'));
  assert(html.includes('無料・登録不要・入力内容は保存されません'));
  assert(!html.includes('target="_blank"'));
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
