'use strict';

/**
 * 読みやすい日本語の決まりと、新規生成・全文再生成・部分修正への適用範囲を検証する。
 *   node scripts/lib/__tests__/test-readability-rules.js
 * AI は偽の関数に置き換え、通信も禁止する。ファイルは作成しない。
 */
const { READABILITY_RULES, STATIC_RULES } = require('../article-prompt-static');
const { buildGenerationPrompt } = require('../article-prompt-builder');
const contentModel = require('../content-model');
const generation = require('../../generate-draft');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function checkPlacement(system, label) {
  const tone = system.indexOf('═══ 文体・トーン ═══');
  const rules = system.indexOf(READABILITY_RULES);
  const prohibitions = system.indexOf('═══ 禁止事項 ═══', tone);
  assert(system.split(READABILITY_RULES).length - 1 === 1, `${label}: 決まりはちょうど1回`);
  assert(tone >= 0 && rules > tone, `${label}: 文体・トーンの後に置く`);
  assert(prohibitions > rules, `${label}: その後の最初の禁止事項より前に置く`);
  assert(system.includes(`\n\n${READABILITY_RULES}\n\n═══ 禁止事項 ═══`),
    `${label}: 前後に空行を1つ置く`);
}

const body = '導入文です。\n\n## 書類\n\n必要な書類を確認します。\n\n## まとめ\n\n手順を確認します。';
const article = `---
title: "必要な書類の確認"
slug: "readability-test"
category: "その他"
primary_persona: "test"
article_type: "basic_explainer"
review_status: "needs_revision"
---

${body}`;

async function capturePrompts(response, run) {
  const originalGenerate = contentModel.generateSimple;
  const originalFetch = global.fetch;
  const requests = [];
  let networkCalls = 0;
  contentModel.generateSimple = async request => {
    requests.push(request);
    return { text: response, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' };
  };
  global.fetch = async () => {
    networkCalls++;
    throw new Error('この試験では通信を許可しません');
  };
  try {
    await run(requests);
    assert(networkCalls === 0, '通信を使わない');
  } finally {
    contentModel.generateSimple = originalGenerate;
    global.fetch = originalFetch;
  }
}

async function main() {
  console.log('\n=== R1: 決まりの定数 ===');
  assert(typeof READABILITY_RULES === 'string', '決まりは文字列');
  assert(READABILITY_RULES.startsWith('═══ 読みやすい日本語'), '所定の見出しで始まる');
  for (const keyword of ['正確性のルール', '30〜45字', '0〜2個', 'ダッシュ（——、―）',
    '重要なのは', 'と言えるでしょう', '課税標準']) {
    assert(READABILITY_RULES.includes(keyword), `決まりに「${keyword}」を含む`);
  }

  console.log('\n=== R2: 固定ルールへの挿入 ===');
  checkPlacement(STATIC_RULES, '固定ルール');

  console.log('\n=== R3: リード文の例 ===');
  const withoutReadability = STATIC_RULES.replace(READABILITY_RULES, '');
  assert(!withoutReadability.includes('——'), '決まりの外に「——」を含まない');
  assert(!withoutReadability.includes('―'), '決まりの外に「―」を含まない');
  assert(withoutReadability.includes('   例:「レジ横に置いた自販機の売上は、レシートも出ないので帳簿への書き方に迷いがちです。\n' +
    '      決算の直前になって手が止まる方は少なくありません。」'), '変更後の例を空白も含めて維持する');

  console.log('\n=== R5-5: 新規生成では固定部分にだけ置く ===');
  const prompt = buildGenerationPrompt({
    topic: { title: '必要な書類の確認', slug: 'readability-test', category: 'その他', persona: 'test' },
    persona: { label: '読者' }, cta: 'C', articleType: 'basic_explainer', articleRole: 'main',
    now: '2026-10-26T00:00:00Z',
  });
  assert(prompt.staticSystem.includes(READABILITY_RULES), 'staticSystem に決まりを含む');
  assert(!prompt.dynamicSystem.includes(READABILITY_RULES), 'dynamicSystem に決まりを含まない');
  assert(!prompt.user.includes(READABILITY_RULES), 'user に決まりを含まない');

  console.log('\n=== R4・R5-6: 全文書き直しに同じ決まりを渡す ===');
  await capturePrompts(article, async requests => {
    await generation.regenerateWithContentModel(article, '全体を読みやすくしてください');
    assert(requests.length === 1, '全文書き直しのAIを1回呼ぶ');
    checkPlacement(requests[0].system, '全文書き直し');
  });

  console.log('\n=== R5-7: 部分の書き直しには渡さない ===');
  const routes = [
    ['既存節の修正', '## 書類\n\n必要な書類を確認します。', () =>
      generation.regenerateSection(article, '書類を確認してください', { type: 'section_rewrite', sectionHint: '書類' })],
    ['節の追加', '## 補足\n\n保管方法を確認します。', () =>
      generation.regenerateSection(article, '補足を追加してください', { type: 'add_section' })],
    ['本文の最小修正', body, () => generation.regenerateTargeted(article, '書類を確認してください')],
  ];
  for (const [label, response, run] of routes) {
    await capturePrompts(response, async requests => {
      await run();
      assert(requests.length === 1, `${label}: AIを1回呼ぶ`);
      assert(requests.every(request => !request.system.includes(READABILITY_RULES)),
        `${label}: system に決まりを含まない`);
      assert(requests.every(request => !request.user.includes(READABILITY_RULES)),
        `${label}: user に決まりを含まない`);
    });
  }
}

main().catch(error => {
  failed++;
  console.error(`  ✗ 試験中に例外: ${error.stack}`);
}).finally(() => {
  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
});
