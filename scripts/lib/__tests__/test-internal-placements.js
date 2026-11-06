'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  linkPlacements, linkTerms, linkInternal, validatePlacements,
  readInternalLinkPlacements, protectedRanges, blogLinkTargets,
} = require('../internal-linker');
const { validatePlacementFile } = require('../../validate');

let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }
const quiet = { warn() {} };
const post = { slug: 'source', title: '別の主題', macro: '小売', review_status: 'published', _body: '## 本文\n\n言葉 言葉' };
const targets = Array.from({ length: 9 }, (_, i) => ({ slug: `target-${i}`, review_status: 'published' }));
const postsMap = new Map([post, ...targets, { slug: 'draft', review_status: 'draft' }].map(p => [p.slug, p]));
const opts = { post, postsMap, isPublished: p => p.review_status === 'published', hubMacroOf: p => p.macro, logger: quiet };
const placement = (i = 0, extra = {}) => ({ id: `id-${i}`, source: 'source', anchor: '言葉', target: `target-${i}`, added_at: '2026-11-01', ...extra });
const apply = (body, rows) => linkPlacements(body, { ...opts, placements: rows });
const body = '冒頭の言葉\n\n## 見出し\n\n言葉 言葉';

check('指定どおり1本', () => assert.strictEqual(apply(body, [placement()]).markdown, '冒頭の言葉\n\n## 見出し\n\n[言葉](/blog/target-0/) 言葉'));
check('occurrence は保護範囲を除いて数える', () => assert(apply(body, [placement(0, { occurrence: 2 })]).markdown.endsWith('言葉 [言葉](/blog/target-0/)')));
for (const [label, text] of [
  ['冒頭だけ', '言葉\n\n## 本文\n\n別の文章'], ['h2無し', '言葉'],
  ['見出し', '## 言葉\n\n### 言葉'], ['表', '## 本文\n\n| 言葉 |'],
  ['リンク', '## 本文\n\n[言葉](/other/)'], ['画像', '## 本文\n\n![言葉](/image.png)'],
  ['インラインコード', '## 本文\n\n`言葉`'], ['コード', '## 本文\n\n```\n言葉\n```'],
  ['HTML属性', '## 本文\n\n<span title="言葉">別</span>'],
  ['frontmatterとコードの偽h2', '---\ntitle: 言葉\n## 偽\n---\n```\n## 偽\n```\n言葉\n## 本文\n別'],
]) check(`${label}には付けない`, () => {
  const result = apply(text, [placement()]);
  assert.strictEqual(result.markdown, text); assert.strictEqual(result.stats.skipped.notFound, 1);
});
check('保護範囲と重なるanchorも除外', () => assert.strictEqual(apply('## 本文\n言葉`コード`', [placement(0, { anchor: '言葉`コード`' })]).stats.linked, 0));
check('HTMLタグの中身は従来どおり使える', () => assert.strictEqual(apply('## 本文\n<span>言葉</span>', [placement()]).stats.linked, 1));
check('protectedRangesの既定動作は不変', () => assert.deepStrictEqual(protectedRanges('言葉'), []));
for (const [label, extra, reason] of [
  ['self', { target: 'source' }, 'self'], ['未公開', { target: 'draft' }, 'unpublished'],
  ['不存在', { target: 'missing' }, 'unpublished'], ['無効', { enabled: false }], ['別記事', { source: 'other' }],
]) check(label, () => {
  const result = apply(body, [placement(0, extra)]); assert.strictEqual(result.stats.linked, 0);
  if (reason) assert.strictEqual(result.stats.skipped[reason], 1);
});
check('警告にslugとidを含む', () => {
  const warnings = [];
  linkPlacements('## 本文\n別', { ...opts, placements: [placement(), placement(1, { target: 'missing' })], logger: { warn: s => warnings.push(s) } });
  assert(warnings[0].includes('source') && warnings[0].includes('id-0'));
  assert(warnings[1].includes('source') && warnings[1].includes('id-1'));
});
check('指定は最大3本・ファイル順', () => {
  const result = apply('## 本文\n言葉0 言葉1 言葉2 言葉3', [0, 1, 2, 3].map(i => placement(i, { anchor: `言葉${i}` })));
  assert.strictEqual(result.stats.linked, 3); assert.strictEqual(result.stats.skipped.limit, 1);
  assert.deepStrictEqual([...result.stats.linkedTargets], ['target-0', 'target-1', 'target-2']);
});
check('指定どうしの行き先重複', () => {
  const result = apply(body, [placement(), placement(1, { target: 'target-0' })]);
  assert.strictEqual(result.stats.linked, 1); assert.strictEqual(result.stats.skipped.duplicateTarget, 1);
});
const terms = [0, 1, 2, 3, 4, 5, 6].map(i => ({ term: `用語${i}`, slug: `target-${i}`, macros: ['*'] }));
check('指定優先・合計5本・辞書との重複なし', () => {
  const result = linkInternal('## 本文\n言葉0 言葉1 言葉2 ' + terms.map(t => t.term).join(' '), {
    ...opts, placements: [0, 1, 2].map(i => placement(i, { anchor: `言葉${i}` })), terms,
  });
  assert.strictEqual(result.stats.linked, 5); assert.strictEqual(result.stats.placements.linked, 3);
  assert.strictEqual(result.stats.terms.linked, 2); assert.strictEqual(result.stats.terms.skipped.duplicateTarget, 3);
});
check('指定なしなら辞書は4本', () => assert.strictEqual(linkInternal('## 本文\n' + terms.map(t => t.term).join(' '), { ...opts, terms }).stats.terms.linked, 4));
check('辞書どうしの重複', () => {
  const result = linkTerms('## 本文\n用語0 用語1', { ...opts, terms: [terms[0], { ...terms[1], slug: 'target-0' }] });
  assert.strictEqual(result.stats.linked, 1); assert.strictEqual(result.stats.skipped.duplicateTarget, 1);
});
for (const existing of ['[元](/blog/target-0/)', '<a href="/blog/target-0/">元</a>', "<a href='https://example.com/blog/target-0/'>元</a>"]) {
  check(`元のリンクを重複させない ${existing}`, () => {
    const result = linkInternal(`${existing}\n## 本文\n言葉 用語0`, { ...opts, placements: [placement()], terms: [terms[0]] });
    assert.strictEqual(result.stats.linked, 0);
  });
}
check('既存リンクの数え方は記事単位・画像とコードは除外', () => assert.deepStrictEqual([...blogLinkTargets('![図](/blog/image/) ` [例](/blog/code/) `\n[記事](/blog/ok/) [再掲](/blog/ok/)')], ['ok']));
check('frontmatterと未終了コード内のURLは数えない', () => assert.deepStrictEqual([...blogLinkTargets('---\nurl: [元](/blog/meta/)\n---\n## 本文\n<a data-href="/blog/data/">別</a>\n[記事](/blog/ok/)\n```\n[例](/blog/code/)')], ['ok']));
check('空の指定はlinkTermsと同じ本文', () => {
  const text = '## 本文\n用語0 用語1';
  assert.strictEqual(linkInternal(text, { ...opts, terms, placements: [] }).markdown, linkTerms(text, { ...opts, terms }).markdown);
});
const validate = rows => validatePlacements({ placements: rows }, opts);
check('正しい指定は誤り・警告なし', () => assert.deepStrictEqual(validate([placement()]), { errors: [], warnings: [] }));
for (const key of ['id', 'source', 'anchor', 'target', 'added_at']) check(`必須 ${key}`, () => {
  const row = placement(); delete row[key]; assert(validate([row]).errors.length);
});
for (const [label, config] of [
  ['配列でない', { placements: {} }], ['行がnull', { placements: [null] }],
  ['id重複', { placements: [placement(), placement(1, { id: 'id-0' })] }],
  ['self', { placements: [placement(0, { target: 'source' })] }],
  ['anchor空', { placements: [placement(0, { anchor: '' })] }],
  ['anchor41字', { placements: [placement(0, { anchor: '字'.repeat(41) })] }],
  ...[0, -1, 1.5, '2', null].map(value => [`occurrence ${value}`, { placements: [placement(0, { occurrence: value })] }]),
  ['不存在source', { placements: [placement(0, { source: 'missing' })] }],
  ['不存在target', { placements: [placement(0, { target: 'missing' })] }],
  ['target重複', { placements: [placement(), placement(1, { target: 'target-0' })] }],
  ['4行', { placements: [0, 1, 2, 3].map(i => placement(i)) }],
  ['不正日付', { placements: [placement(0, { added_at: '2026-02-30' })] }],
]) check(`validate誤り: ${label}`, () => assert(validatePlacements(config, opts).errors.length));
check('disabledは同じtargetと行数の制限に数えない', () => assert.strictEqual(validate([placement(), ...[1, 2, 3].map(i => placement(i, { target: 'target-0', enabled: false }))]).errors.length, 0));
for (const status of ['draft', 'merged', 'withdrawn']) check(`validate警告: ${status}`, () => {
  const map = new Map(postsMap); map.set('target-0', { slug: 'target-0', review_status: status });
  const result = validatePlacements({ placements: [placement()] }, { ...opts, postsMap: map });
  assert.strictEqual(result.errors.length, 0); assert.strictEqual(result.warnings.length, 1);
});
check('source未公開とanchor無しは警告', () => {
  const map = new Map(postsMap); map.set('source', { ...post, review_status: 'draft' });
  const result = validatePlacements({ placements: [placement(0, { anchor: '存在しない' })] }, { ...opts, postsMap: map });
  assert.strictEqual(result.errors.length, 0); assert.strictEqual(result.warnings.length, 2);
});
check('occurrence不足は警告', () => assert.strictEqual(validate([placement(0, { occurrence: 3 })]).warnings.length, 1));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-placements-'));
try {
  const file = path.join(tmp, 'placements.json');
  check('指定ファイル無しは警告して続行', () => {
    const warnings = []; assert.deepStrictEqual(readInternalLinkPlacements(file, { warn: s => warnings.push(s) }), []);
    assert.strictEqual(warnings.length, 1);
  });
  for (const [i, text] of ['{', '{"placements":{}}', '{"placements":[null]}', '{"placements":[]}'].entries()) {
    check(`指定ファイル読み込み ${i}`, () => {
      const testFile = path.join(tmp, `case-${i}.json`); fs.writeFileSync(testFile, text);
      const warnings = []; assert.deepStrictEqual(readInternalLinkPlacements(testFile, { warn: s => warnings.push(s) }), []);
      assert.strictEqual(warnings.length, i === 3 ? 0 : 1);
      assert.strictEqual(validatePlacementFile(testFile).errors.length > 0, i !== 3);
    });
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`PASS: ${passed} / FAIL: 0`);
