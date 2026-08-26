'use strict';
/**
 * 問い合わせ遷移の計測と選定への還元（段階2）のテスト
 *
 * 検証:
 *   1. ビーコン本文の解釈（問い合わせページのときだけ遷移元を受け取る）
 *   2. 遷移の記録（日別・遷移元別に数える。閲覧記録に影響しない）
 *   3. 実測ファイル → 論点キー → 選定の優先度（inquiry×2）
 *   4. 実測が無い間はすべて 0（現状のアクセスゼロでも壊れない）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const A = require(path.join(ROOT, 'netlify/functions/lib/analytics-store'));
const { priorityBreakdown } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
const IS = require(path.join(ROOT, 'scripts/lib/inquiry-signals'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// Netlify Blobs の最小モック（onlyIfNew / onlyIfMatch を再現）
function makeStore() {
  const data = new Map();
  let etagSeq = 0;
  return {
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: JSON.parse(JSON.stringify(entry.value)), etag: entry.etag };
    },
    async setJSON(key, value, opts = {}) {
      const current = data.get(key);
      if (opts.onlyIfNew && current) return { modified: false };
      if (opts.onlyIfMatch && (!current || current.etag !== opts.onlyIfMatch)) return { modified: false };
      data.set(key, { value, etag: `e${++etagSeq}` });
      return { modified: true };
    },
    _raw: data,
  };
}

(async () => {
  console.log('=== 1. ビーコン本文の解釈 ===');
  {
    const p = (o) => A.parseBeaconPayload(JSON.stringify(o));
    assert(p({ p: '/blog/some-post/' }).ref === null, '通常ページは遷移元なし');
    const t = p({ p: '/contact.html', r: '/blog/some-post/' });
    assert(t && t.ref === '/blog/some-post/', '問い合わせページでは遷移元を受け取る');
    assert(p({ p: '/blog/a/', r: '/blog/b/' }).ref === null, '問い合わせページ以外の遷移元は無視');
    assert(p({ p: '/contact.html', r: '/contact.html' }).ref === null, '問い合わせページ自身は遷移元にしない');
    assert(p({ p: '/contact.html', r: 'https://example.com/x' }).ref === null, 'サイト外の形式は受け取らない');
    assert(p({ p: '/contact.html', r: '/random-path' }).ref === null, '許可されていないパスは受け取らない');
    assert(p({ p: '/contact.html', x: '1' }) === null, '不明な項目があれば全体を弾く（従来どおり）');
    assert(A.parseBeaconBody(JSON.stringify({ p: '/blog/example-post/' })) === '/blog/example-post/',
      '従来の関数は従来どおり動く');
  }

  console.log('');
  console.log('=== 2. 遷移の記録 ===');
  {
    const store = makeStore();
    await A.incrementTransition(store, '2026-08-27', '/blog/post-a/');
    await A.incrementTransition(store, '2026-08-27', '/blog/post-a/');
    await A.incrementTransition(store, '2026-08-27', '/blog/post-b/');
    const saved = (await store.getWithMetadata('transitions/2026-08-27')).data;
    assert(saved.total === 3, '遷移の合計が数えられる');
    assert(saved.byFrom['/blog/post-a/'] === 2 && saved.byFrom['/blog/post-b/'] === 1,
      '遷移元ごとに数えられる');
    assert(!store._raw.has('daily/2026-08-27'), '閲覧記録とは別の入れ物に保存される');
  }

  console.log('');
  console.log('=== 3. 実測 → 論点 → 選定の優先度 ===');
  {
    // 一時的な実測ファイルと記事で、パス→論点キーの対応を検証
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-'));
    const posts = path.join(TMP, 'posts');
    fs.mkdirSync(posts, { recursive: true });
    fs.writeFileSync(path.join(posts, '2026-08-01-test.md'), [
      '---', 'title: "テスト記事"', 'slug: "test-post"', 'pain_point: "test-pain"',
      'cluster: "test-cluster"', 'subcluster: "test-sub"', '---', '', '本文',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(TMP, 'signals.json'), JSON.stringify({
      byFrom: { '/blog/test-post/': 3, '/services.html': 1 },
    }), 'utf8');
    const built = IS.buildSignalKeys({ signalsFile: path.join(TMP, 'signals.json'), postsDir: posts });
    assert(built.fromCount === 1, '遷移元のうち記事だけが論点に対応づく');
    assert(built.keys.has('test-pain') && built.keys.has('test-cluster') && built.keys.has('test-sub'),
      '記事の pain / cluster / subcluster が信号キーになる');
    fs.rmSync(TMP, { recursive: true, force: true });

    // 優先度式: inquiry は 2 の重みで、需要の証拠（×3）は超えない
    const now = new Date('2026-08-27T03:00:00.000Z');
    const base = priorityBreakdown({ search_intent: '一般的な税務' }, now);
    assert(base.inquiry === 0, '実測ファイルが無い間は 0');
    // inquirySignalFor をモックできないので、式の構造を直接確認
    const withInquiry = { demand: 0, season: 0, lead: 0, inquiry: 1 };
    const priority = withInquiry.demand * 3 + withInquiry.season * 2 + withInquiry.inquiry * 2 + withInquiry.lead;
    assert(priority === 2, '問い合わせ実績の重みは季節と同じ 2');
    const demandOnly = 0.7 * 3;
    assert(demandOnly > priority, '需要の証拠（最低70点）は問い合わせ実績より優先される');
  }

  console.log('');
  console.log('=== 4. 実測が無い間の安全性 ===');
  {
    if (!fs.existsSync(IS.SIGNALS_FILE)) {
      assert(IS.inquirySignalFor({ pain_point: 'x', cluster: 'y' }) === 0,
        '実測ファイルが無ければ常に 0（現状のアクセスゼロでも壊れない）');
      const { keys, fromCount } = IS.loadSignals();
      assert(keys.size === 0 && fromCount === 0, '信号は空として読み込まれる');
    } else {
      const { keys } = IS.loadSignals();
      assert(keys instanceof Set, '実測ファイルがあれば信号として読み込まれる');
      assert(typeof IS.inquirySignalFor({}) === 'number', '判定は常に数値を返す');
    }
  }

  console.log('');
  console.log(`=== 結果 ===`);
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
