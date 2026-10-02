'use strict';

const api = require('../../../netlify/functions/lib/github-api');
const skip = require('../../../netlify/functions/review-skip');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const source = [
  '---',
  'title: "更新案の記事"',
  'review_status: "draft"',
  '---',
  '更新本文',
  '',
].join('\n');

function setup({ ref, openPR = true } = {}) {
  const state = { calls: [], writes: [], notifications: [] };
  const dependencies = {
    getFile: async () => ({ content: source, sha: 'branch-sha' }),
    putFile: async (...args) => { state.writes.push(args); },
    updateFrontmatter: api.updateFrontmatter,
    nowJST: () => '2026-10-02T12:00:00+09:00',
    findPR: async branch => {
      state.calls.push(['find', branch]);
      return openPR ? { number: 12 } : null;
    },
    closePR: async number => { state.calls.push(['close', number]); },
    deleteBranch: async branch => { state.calls.push(['delete', branch]); },
    extractFmField: api.extractFmField,
    readjustPublishSlots: async () => null,
    sendNotification: async event => { state.notifications.push(event); },
  };
  return {
    state,
    run: () => skip._handler({
      httpMethod: 'POST',
      body: JSON.stringify({ filename: 'refresh-skip.md', ref }),
    }, dependencies),
  };
}

async function main() {
  const refresh = setup({ ref: 'draft/refresh-sample' });
  const refreshResult = await refresh.run();
  assert(refreshResult.statusCode === 200
    && JSON.stringify(refresh.state.calls) === JSON.stringify([
      ['find', 'draft/refresh-sample'], ['close', 12], ['delete', 'draft/refresh-sample'],
    ]),
  '更新案の見送りはPRを閉じた後に枝を削除');

  const ordinary = setup({ ref: 'draft/ordinary-sample' });
  const ordinaryResult = await ordinary.run();
  assert(ordinaryResult.statusCode === 200
    && JSON.stringify(ordinary.state.calls) === JSON.stringify([
      ['find', 'draft/ordinary-sample'], ['close', 12],
    ]),
  '通常下書きの見送りでは枝を削除しない');

  const refreshWithoutPR = setup({ ref: 'draft/refresh-no-pr', openPR: false });
  const noPrResult = await refreshWithoutPR.run();
  assert(noPrResult.statusCode === 200
    && JSON.stringify(refreshWithoutPR.state.calls) === JSON.stringify([
      ['find', 'draft/refresh-no-pr'], ['delete', 'draft/refresh-no-pr'],
    ]),
  '開いているPRがなくても更新案の枝を削除');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
