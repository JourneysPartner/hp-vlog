'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../../../netlify/functions/lib/github-api');
const freshnessRefresh = require('../freshness-refresh');
const sourceGuard = require('../source-guard');
const { isPlaceholderTitle } = require('../draft-normalizer');
const approval = require('../../../netlify/functions/review-approve-background');

const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function rawArticle({
  status = 'draft', title = '記事の題名', body = '本文です。', slug = 'refresh-check', baseHash = null,
  refresh = true, version = true, sourceUrl = 'https://www.nta.go.jp/example',
  sourceProvenance = 'curated', recommendation = '',
} = {}) {
  return [
    '---',
    `title: "${title}"`,
    `slug: "${slug}"`,
    'summary: "公開用の要約"',
    'category: "消費税"',
    `review_status: "${status}"`,
    'review_comment: "更新案へのコメント"',
    'created_at: "2024-01-01T00:00:00+09:00"',
    'updated_at: "2025-01-01T00:00:00+09:00"',
    'reviewed_at: "2025-01-02T00:00:00+09:00"',
    'publish_at: "2024-02-01T17:15:00+09:00"',
    'published_at: "2024-02-01T17:15:00+09:00"',
    'publish_slot: "evening"',
    'approved_at: "2024-01-31T11:00:00+09:00"',
    `source_url: "${sourceUrl}"`,
    'source_title: "出典"',
    ...(version ? ['source_guard_version: 1', `source_provenance: "${sourceProvenance}"`, 'tax_domain: "consumption_tax"'] : []),
    ...(recommendation ? [`recommendation: "${recommendation}"`] : []),
    ...(refresh ? ['refresh_of: "published"', 'refresh_requested_at: "2026-10-01T10:00:00+09:00"', 'refresh_note: "制度改正（## 控除）"'] : []),
    ...((baseHash || refresh) ? [`refresh_base_hash: "${baseHash || freshnessRefresh.refreshBaseHash('本文です。')}"`] : []),
    '---',
    body,
    '',
  ].join('\n');
}

function setup(branch, main, options = {}) {
  let branchContent = branch;
  let mainContent = main;
  let mainReads = 0;
  const state = {
    gets: [], puts: [], notifications: [], closeCalls: [], deleteCalls: [],
    waitCalls: 0, mergeCalls: 0, slotLookups: 0,
  };
  const deps = {
    getFile: async (file, ref) => {
      state.gets.push({ file, ref });
      if (ref === 'main') {
        mainReads++;
        if (options.mainMissing) throw new Error('GitHub GET 404: not found');
        if (options.conflictLatest && mainReads > 1) mainContent = options.conflictLatest;
        return { content: mainContent, sha: `main-sha-${mainReads}` };
      }
      if (options.branchError) throw new Error(options.branchError);
      return { content: branchContent, sha: 'branch-sha' };
    },
    putFile: async (file, content, sha, message, ref) => {
      state.puts.push({ file, content, sha, message, ref });
      if (options.putError && state.puts.length <= (options.putErrorCount || 1)) throw new Error(options.putError);
      if (ref === 'main') mainContent = content;
      else branchContent = content;
      return {};
    },
    updateFrontmatter: api.updateFrontmatter,
    nowJST: () => '2026-10-02T12:34:56+09:00',
    findPR: async ref => {
      state.findPRRef = ref;
      return options.noPR ? null : { number: 73, head: { ref } };
    },
    closePR: async number => { state.closeCalls.push(number); },
    waitForMergeable: async () => { state.waitCalls++; return { mergeable: true }; },
    mergePR: async () => { state.mergeCalls++; return { merged: true }; },
    deleteBranch: async branchName => { state.deleteCalls.push(branchName); },
    findApprovedArticlesForDate: async () => { state.slotLookups++; return []; },
    sendNotification: async (event, data) => state.notifications.push({ event, data }),
  };
  return {
    state,
    main: () => mainContent,
    branch: () => branchContent,
    handler: event => approval._handler(event, deps),
  };
}

function request({ filename = '2026-02-01-refresh-check.md', ref = 'draft/refresh-refresh-check' } = {}) {
  return { httpMethod: 'POST', body: JSON.stringify({ filename, ref }) };
}

function frontmatterWithoutRefreshDates(raw) {
  const match = String(raw).match(/^(---\r?\n[\s\S]+?\r?\n---\r?\n)/);
  return match && match[1].replace(/^(?:updated_at|reviewed_at):[^\r\n]*(?:\r?\n|$)/gm, '');
}

async function main() {
  console.log('\n=== 更新案を main へ直接反映 ===');
  {
    const originalMain = rawArticle({ status: 'published', title: '公開中の題名', refresh: false })
      .replace(/\n/g, '\r\n');
    let branch = rawArticle({ status: 'draft', title: 'LLMが変更した題名', refresh: false,
      baseHash: freshnessRefresh.refreshBaseHash('本文です。'), recommendation: 'reject', body: '改訂本文です。\n別の行です。' })
      .replace('publish_at: "2024-02-01T17:15:00+09:00"', 'publish_at: "2099-02-01T17:15:00+09:00"')
      .replace('source_url: "https://www.nta.go.jp/example"', 'source_url: "https://example.invalid/changed"');
    const harness = setup(branch, originalMain);
    const response = await harness.handler(request());
    const saved = harness.state.puts[0] && harness.state.puts[0].content;
    assert(response.statusCode === 200 && JSON.parse(response.body).action === 'refresh_approve', 'ref 接頭辞だけで更新案の経路に入る');
    assert(harness.state.puts.length === 1 && harness.state.puts[0].ref === 'main'
      && harness.state.puts[0].message === 'refresh: 公開中の題名 (#73)', '公開中の題名とPR番号で main に直接書く');
    assert(saved && frontmatterWithoutRefreshDates(saved) === frontmatterWithoutRefreshDates(originalMain),
      'main の frontmatter は updated_at と reviewed_at 以外を保つ');
    assert(saved.includes('updated_at: "2026-10-02T12:34:56+09:00"')
      && saved.includes('reviewed_at: "2026-10-02T12:34:56+09:00"'), '更新日とレビュー日だけ現在時刻にする');
    assert(saved.includes('publish_at: "2024-02-01T17:15:00+09:00"')
      && saved.includes('published_at: "2024-02-01T17:15:00+09:00"')
      && saved.includes('publish_slot: "evening"') && saved.includes('approved_at: "2024-01-31T11:00:00+09:00"'),
    'publish_at・published_at・publish_slot・approved_at に触れない');
    const savedBody = saved.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/)[1];
    const branchBody = branch.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/)[1];
    const expectedBody = branchBody.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, '\r\n');
    assert(savedBody === expectedBody && !/(^|[^\r])\n/.test(savedBody), '本文は更新案から採り、main の CRLF に合わせる');
    assert(harness.branch() === branch && harness.state.waitCalls === 0 && harness.state.mergeCalls === 0,
      '更新案の枝を書き換えず、PRのマージ待ち・マージを呼ばない');
    assert(harness.state.closeCalls[0] === 73 && harness.state.deleteCalls[0] === 'draft/refresh-refresh-check',
      '反映後にPRを閉じて更新案の枝を削除');
    assert(harness.state.notifications.length === 1 && harness.state.notifications[0].event === 'refresh_published'
      && harness.state.notifications[0].data.publicUrl === 'https://mori-zeirishi.net/blog/refresh-check/',
    '成功時は refresh_published のみ通知');

    const markerOnly = setup(rawArticle({ status: 'draft', refresh: true, body: 'marker による更新本文',
      baseHash: freshnessRefresh.refreshBaseHash('公開本文') }),
      rawArticle({ status: 'published', refresh: false, body: '公開本文' }));
    const markerResponse = await markerOnly.handler(request());
    assert(markerResponse.statusCode === 200 && markerOnly.state.puts[0].ref === 'main',
      'refresh_of: published だけでも更新案の専用経路に入る');
  }

  console.log('\n=== main のチェックと安全な再試行 ===');
  {
    const draft = rawArticle({ refresh: true, body: '更新本文' });
    const unpublished = setup(draft, rawArticle({ status: 'approved', refresh: false }));
    const rejected = await unpublished.handler(request());
    assert(rejected.statusCode === 400 && unpublished.state.puts.length === 0
      && unpublished.state.notifications.some(item => item.event === 'refresh_approve_failed'), 'main が published でなければ承認失敗通知');

    const invalidMain = rawArticle({ status: 'published', refresh: false, version: true, sourceUrl: 'https://example.invalid/source', sourceProvenance: 'unknown' });
    const guarded = setup(draft, invalidMain);
    const guardResponse = await guarded.handler(request());
    assert(guardResponse.statusCode === 400 && guarded.state.puts.length === 0
      && guarded.state.notifications.some(item => item.event === 'refresh_approve_failed'), 'source guard は main の出典情報を検証');

    const wrongPair = setup(draft, rawArticle({ status: 'published', refresh: false }));
    const wrongPairResponse = await wrongPair.handler(request({ ref: 'draft/refresh-another-slug' }));
    assert(wrongPairResponse.statusCode === 400 && wrongPair.state.puts.length === 0
      && wrongPair.state.notifications.some(item => item.event === 'refresh_approve_failed'
        && item.data.comment.includes('更新案の枝と記事が一致しません')),
    '更新案の枝とmain記事のslugが一致しなければ断る');

    const missingBase = setup(rawArticle({ refresh: false, body: '更新本文' }), rawArticle({ status: 'published', refresh: false }));
    const missingBaseResponse = await missingBase.handler(request());
    assert(missingBaseResponse.statusCode === 400 && missingBase.state.puts.length === 0
      && missingBase.state.notifications.some(item => item.event === 'refresh_approve_failed'
        && item.data.comment.includes('作成時の情報がありません')),
    'refresh_base_hash が無い更新案は断る');

    const stale = setup(draft,
      rawArticle({ status: 'published', refresh: false, body: '作成後に公開本文が変わりました。' }));
    const staleResponse = await stale.handler(request());
    assert(staleResponse.statusCode === 400 && stale.state.puts.length === 0
      && stale.state.notifications.some(item => item.event === 'refresh_approve_failed'
        && item.data.comment.includes('更新案の作成後に公開中の記事が変わりました')),
    '更新案の作成後にmain本文が変わっていれば書き込まず断る');

    const latestMain = rawArticle({ status: 'published', title: '最新の題名', refresh: false });
    const conflict = setup(draft, rawArticle({ status: 'published', refresh: false }), { putError: 'GitHub PUT 409: sha conflict', conflictLatest: latestMain });
    const retried = await conflict.handler(request());
    assert(retried.statusCode === 200 && conflict.state.puts.length === 2
      && conflict.state.puts[1].sha === 'main-sha-2' && conflict.state.puts[1].content.includes('title: "最新の題名"'),
    'sha conflict は本文hashを再確認し、main本文が同じなら新frontmatterへ1回だけ再適用');

    const staleMain = rawArticle({ status: 'published', refresh: false, body: '公開後に別の更新が入りました。' });
    const conflictStale = setup(draft, rawArticle({ status: 'published', refresh: false }), {
      putError: 'GitHub PUT 409: sha conflict', conflictLatest: staleMain,
    });
    const conflictStaleResponse = await conflictStale.handler(request());
    assert(conflictStaleResponse.statusCode === 400 && conflictStale.state.puts.length === 1
      && conflictStale.state.notifications.some(item => item.event === 'refresh_approve_failed'
        && item.data.comment.includes('更新案の作成後に公開中の記事が変わりました')),
    'sha conflict後に本文hashが変わっていたら再適用せず承認失敗を通知');

    const twice = setup(draft, rawArticle({ status: 'published', refresh: false }), { putError: 'GitHub PUT 409: sha conflict', putErrorCount: 2 });
    const failed = await twice.handler(request());
    assert(failed.statusCode === 502 && twice.state.puts.length === 2 && twice.branch() === draft
      && twice.state.notifications.some(item => item.event === 'refresh_approve_failed'), '2回目のsha conflictは枝を残して承認失敗通知');
  }

  console.log('\n=== 変更なし・処理済み・通常経路 ===');
  {
    const draft = rawArticle({ refresh: true, body: '更新本文' });
    const original = rawArticle({ status: 'published', refresh: false, body: '同じ本文です。' });
    const same = setup(rawArticle({ refresh: false, body: '同じ本文です。  ',
      baseHash: freshnessRefresh.refreshBaseHash('同じ本文です。') }), original);
    const sameResponse = await same.handler(request());
    assert(sameResponse.statusCode === 200 && same.state.puts.length === 0
      && same.state.notifications.some(item => item.event === 'refresh_approve_failed' && item.data.comment === '反映する変更がありません。'),
    'AIが何も変えていない本文は書かず承認失敗通知');

    const appliedBody = 'すでに反映された本文です。';
    const alreadyApplied = setup(rawArticle({ body: appliedBody, baseHash: freshnessRefresh.refreshBaseHash('本文です。') }),
      rawArticle({ status: 'published', refresh: false, body: appliedBody }));
    const appliedResponse = await alreadyApplied.handler(request());
    assert(appliedResponse.statusCode === 200 && alreadyApplied.state.puts.length === 0
      && alreadyApplied.state.closeCalls[0] === 73
      && alreadyApplied.state.deleteCalls[0] === 'draft/refresh-refresh-check'
      && alreadyApplied.state.notifications.length === 1
      && alreadyApplied.state.notifications[0].event === 'refresh_processed'
      && alreadyApplied.state.notifications[0].data && alreadyApplied.state.notifications[0].data.kind === 'applied',
    'すでに反映済みならPR・枝を片付けてrefresh_processed（反映済み）だけを通知');

    const conflictApplied = setup(draft, rawArticle({ status: 'published', refresh: false }), {
      putError: 'GitHub PUT 409: sha conflict',
      conflictLatest: rawArticle({ status: 'published', refresh: false, body: '更新本文' }),
    });
    const conflictAppliedResponse = await conflictApplied.handler(request());
    assert(conflictAppliedResponse.statusCode === 200 && conflictApplied.state.puts.length === 1
      && conflictApplied.state.deleteCalls[0] === 'draft/refresh-refresh-check'
      && conflictApplied.state.notifications.length === 1
      && conflictApplied.state.notifications[0].event === 'refresh_processed'
      && conflictApplied.state.notifications[0].data && conflictApplied.state.notifications[0].data.kind === 'applied',
    'sha競合後に相手が同じ本文を反映済みなら処理済み（反映済み）通知で成功する');

    const missingBranch = setup('', original, { branchError: 'GitHub GET 404: not found', noPR: true });
    const processed = await missingBranch.handler(request());
    assert(processed.statusCode === 200 && missingBranch.state.puts.length === 0
      && missingBranch.state.notifications.some(item => item.event === 'refresh_processed'), '枝もPRも無ければ処理済みの短い通知');

    const ordinary = setup(rawArticle({ status: 'needs_review', refresh: false }), original);
    const blocked = await ordinary.handler(request({ ref: 'draft/ordinary-review' }));
    assert(blocked.statusCode === 409 && ordinary.state.puts.length === 0 && ordinary.state.notifications.length === 0,
      '通常経路は main に published の同名記事があれば通知・書き込みなしで409');

    let eligible = null;
    for (const filename of fs.readdirSync(path.join(ROOT, 'content', 'posts')).filter(name => name.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(ROOT, 'content', 'posts', filename), 'utf8');
      const meta = sourceGuard.parseFrontmatterMeta(raw);
      if (meta.review_status !== 'published' || isPlaceholderTitle(meta.title)) continue;
      if (sourceGuard.evaluateSourceGuard({ ...meta, review_status: 'needs_review' }, { stage: 'approve' }).allowed) {
        eligible = { filename, raw: api.updateFrontmatter(raw, { review_status: 'needs_review' }) };
        break;
      }
    }
    assert(Boolean(eligible), '通常経路の回帰確認用の記事が見つかる');
    if (eligible) {
      const normal = setup(eligible.raw, '', { mainMissing: true });
      const normalResponse = await normal.handler(request({ filename: eligible.filename, ref: 'draft/ordinary-review' }));
      const updated = normal.state.puts[0] && normal.state.puts[0].content;
      assert(normalResponse.statusCode === 200 && /review_status: "approved"/.test(updated), '新しい通常下書きは従来どおり承認できる');
      assert(normal.state.slotLookups === 1 && /publish_slot:/.test(updated)
        && /publish_at:/.test(updated) && /approved_at:/.test(updated), '通常下書きは従来どおり公開日を設定');
      assert(normal.state.notifications.some(item => item.event === 'approved'), '通常下書きは従来どおり承認通知');
    }
    assert(approval.handler.length === 1, 'Netlify handler は第2引数を注入に使わない');
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
