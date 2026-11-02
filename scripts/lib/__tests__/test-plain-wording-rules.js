'use strict';

/**
 * やわらかい言葉の決まりと、新規生成・全文再生成・部分修正への適用範囲を検証する。
 *   node scripts/lib/__tests__/test-plain-wording-rules.js
 * AI は偽の関数に置き換え、通信も禁止する。ファイルは作成しない。
 */
const { READABILITY_RULES, PLAIN_WORDING_RULES, STATIC_RULES } = require('../article-prompt-static');
const { buildGenerationPrompt } = require('../article-prompt-builder');
const bannedPhrases = require('../banned-phrases');
const contentModel = require('../content-model');
const generation = require('../../generate-draft');

const EXPECTED_RULES = `═══ やわらかい言葉と、書きすぎない細かさ ═══
この節より、正確性のルール（出典・数値・条件・例外）と穏当な表現のルールを優先する。
- 気取った言い回しや文学的な言い回しを使わず、読者がふだん使う言葉で書く
  （❌「ふと手が止まるのが税金の扱いです」→ ⭕「気になるのが税金です」）
- 見出し（h2・h3）は、読者がふだん使う言葉で短く書く。読者が自分の状況を確かめる節は、読者の問いの形にする
  （❌「判断の分岐：自分はどこに当てはまるか」→ ⭕「自分はどれに当てはまるか」）
- 見出しに「判断の分岐」「〜の整理」のような漢字の名詞を重ねた言い方を使わない。「：」で前後に分けた見出しも使わない
- 判断のための表・箇条書き・チェックリストには、読者が判断するのに要ることだけを書く。確認先・参照先（タックスアンサーの番号など）の列や項目を足さない
  （❌ 表の列が「状況｜判断｜確認先」→ ⭕「状況｜判断」）
- 問い合わせ先や参照先は、読者が実際にそこへ問い合わせたり調べたりする場面でだけ書く
- 制度・控除・経費などの種類を紹介するときは、全部を並べない。その記事の読者に関係する代表的なものを数個挙げ、「など」で終える
  （❌ 所得控除を16種類すべて並べる → ⭕「所得控除には、医療費控除、社会保険料控除、生命保険料控除、扶養控除、基礎控除などがあります」）
- ただし、対象になるかどうかを決める列挙（源泉徴収の対象になる報酬、特例の対象者・対象資産など）は、資料のとおり削らずに書く`;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function checkPlacement(system, label) {
  assert(system.split(PLAIN_WORDING_RULES).length - 1 === 1, `${label}: 決まりはちょうど1回`);
  assert(system.includes(`\n\n${READABILITY_RULES}\n\n${PLAIN_WORDING_RULES}\n\n═══ 禁止事項 ═══`),
    `${label}: 読みやすさの決まりと禁止事項の間に空行を1つずつ置く`);
}

const body = '導入文です。\n\n## 書類\n\n必要な書類を確認します。\n\n## まとめ\n\n手順を確認します。';
const article = `---
title: "必要な書類の確認"
slug: "plain-wording-test"
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
    const text = typeof response === 'function' ? response(request, requests.length) : response;
    return { text, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' };
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
  assert(typeof PLAIN_WORDING_RULES === 'string', '決まりは文字列');
  assert(PLAIN_WORDING_RULES.startsWith('═══ やわらかい言葉と、書きすぎない細かさ ═══'),
    '所定の見出しで始まる');
  assert(PLAIN_WORDING_RULES === EXPECTED_RULES, 'R1 の本文と空白・改行も含めて完全に一致する');

  console.log('\n=== R2: 固定ルールへの挿入 ===');
  checkPlacement(STATIC_RULES, '固定ルール');

  console.log('\n=== R3: 新規生成では固定部分にだけ置く ===');
  const prompt = buildGenerationPrompt({
    topic: { title: '必要な書類の確認', slug: 'plain-wording-test', category: 'その他', persona: 'test' },
    persona: { label: '読者' }, cta: 'C', articleType: 'basic_explainer', articleRole: 'main',
    now: '2026-11-02T00:00:00Z',
  });
  assert(prompt.staticSystem.includes(PLAIN_WORDING_RULES), 'staticSystem に決まりを含む');
  assert(!prompt.dynamicSystem.includes(PLAIN_WORDING_RULES), 'dynamicSystem に決まりを含まない');
  assert(!prompt.user.includes(PLAIN_WORDING_RULES), 'user に決まりを含まない');

  console.log('\n=== R3: 全文書き直しに同じ決まりを渡す ===');
  await capturePrompts(article, async requests => {
    await generation.regenerateWithContentModel(article, '全体を読みやすくしてください');
    assert(requests.length === 1, '全文書き直しのAIを1回呼ぶ');
    checkPlacement(requests[0].system, '全文書き直し');
  });

  console.log('\n=== R3: 部分の書き直しには渡さない ===');
  const multiPointComment = '1. 「書類」の章を直してください\n2. 「まとめ」の章を直してください';
  const multiPointPlan = {
    steps: [
      { kind: 'section', points: [1], heading: '書類', sectionIndex: 0,
        instruction: '「書類」の章を直してください',
        classification: { type: 'section_rewrite', sectionHint: '書類' } },
      { kind: 'section', points: [2], heading: 'まとめ', sectionIndex: 1,
        instruction: '「まとめ」の章を直してください',
        classification: { type: 'section_rewrite', sectionHint: 'まとめ' } },
    ],
  };
  const routes = [
    ['既存節の修正', '## 書類\n\n必要な書類を確認します。', 1, () =>
      generation.regenerateSection(article, '書類を確認してください', { type: 'section_rewrite', sectionHint: '書類' })],
    ['節の追加', '## 補足\n\n保管方法を確認します。', 1, () =>
      generation.regenerateSection(article, '補足を追加してください', { type: 'add_section' })],
    ['本文の最小修正', body, 1, () => generation.regenerateTargeted(article, '書類を確認してください')],
    ['複数箇所の修正', (_request, call) => call === 1
      ? '## 書類\n\n必要な書類を順番に確認します。'
      : '## まとめ\n\n確認した手順をもう一度確かめます。', 2, async () => {
      const result = await generation.regenerateMultiPoint(article, multiPointComment, multiPointPlan,
        { sourceBlocks: { combined: '', figures: [] } });
      assert(generation.parseFrontmatter(result).meta.review_status === 'draft', '複数箇所の修正を採用する');
      assert(result.includes('必要な書類を順番に確認します。'), '書類の節を修正する');
      assert(result.includes('確認した手順をもう一度確かめます。'), 'まとめの節を修正する');
    }],
  ];
  for (const [label, response, expectedCalls, run] of routes) {
    await capturePrompts(response, async requests => {
      await run();
      assert(requests.length === expectedCalls, `${label}: AIを${expectedCalls}回呼ぶ`);
      assert(requests.every(request => !request.system.includes(PLAIN_WORDING_RULES)),
        `${label}: system に決まりを含まない`);
      assert(requests.every(request => !request.user.includes(PLAIN_WORDING_RULES)),
        `${label}: user に決まりを含まない`);
    });
  }

  console.log('\n=== R4: リード文の例 ===');
  const withoutPlainWording = STATIC_RULES.replace(PLAIN_WORDING_RULES, '');
  assert(STATIC_RULES.includes('   例:「レジ横に置いた自販機の売上は、レシートも出ないので帳簿への書き方に迷いがちです。\n' +
    '      決算が近づくと気になる方も多いはずです。」'), 'R4 の例と空白も含めて一致する');
  assert(!withoutPlainWording.includes('手が止ま'), '決まりの外に「手が止ま」を含まない');

  console.log('\n=== R5: 構成テンプレートの注記 ===');
  assert(STATIC_RULES.includes('11. まとめ（結論の再整理）\n' +
    '→ 上の番号の項目名は節の役割を表す。見出しの言葉は「やわらかい言葉と、書きすぎない細かさ」の見出しの決まりに従い、読者の言葉で書く。\n' +
    '→ 文字数上限に収まらない場合は'), 'まとめの直後に R5 の注記を置く');

  console.log('\n=== R6: 禁止表現は警告だけ出す ===');
  const entries = bannedPhrases.loadBannedPhrases().phrases.filter(entry => entry.id === 'no-te-ga-tomaru');
  assert(entries.length === 1, 'no-te-ga-tomaru を1件だけ登録する');
  assert(entries[0] && entries[0].replacement === null, 'replacement は null');
  assert(entries[0] && JSON.stringify(entries[0].appliesTo) === '["body"]', 'appliesTo は body のみ');
  assert(bannedPhrases.formatForPrompt().includes('手が止まる'), '書き手への禁止表現に「手が止まる」を含む');
  const before = '決算の前に手が止まる方もいます。';
  const { text, applied } = bannedPhrases.applyBannedPhrasesToBody(before);
  assert(text === before, '本文を自動置換しない');
  assert(applied.length === 1 && applied[0].id === 'no-te-ga-tomaru', '禁止表現の警告を1件記録する');
  assert(applied[0] && applied[0].hasReplacement === false, '置換なしとして記録する');
}

main().catch(error => {
  failed++;
  console.error(`  ✗ 試験中に例外: ${error.stack}`);
}).finally(() => {
  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
});
