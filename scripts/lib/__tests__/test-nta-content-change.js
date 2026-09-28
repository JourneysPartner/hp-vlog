'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectContentChange } = require('../nta-content-change');
const { backfill } = require('../../backfill-nta-content-changed');

let passed = 0;
let failed = 0;
function assert(value, label) {
  if (value) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const date = '2026-08-01T00:00:00Z';
const old = { fetched_at: '2026-06-21T00:00:00Z', body: '全角　ＡＢＣ', law_version: '令和7年' };
assert(detectContentChange(null, old, date).content_changed_at === null, '初回は改訂ではない');
assert(detectContentChange(old, { ...old, html_hash: '別' }, date).content_changed_at === null, 'HTML の差だけでは改訂しない');
assert(detectContentChange(old, { ...old, body: '全角ABC' }, date).content_changed_at === null, '空白と全角半角の差を無視する');
assert(detectContentChange(old, { ...old, body: '別の本文' }, date).content_change_kind === 'body', '本文の差を検出する');
assert(detectContentChange(old, { ...old, body: '別の本文', law_version: '令和8年' }, date).content_change_kind === 'law_version', '法令基準日を優先する');
assert(detectContentChange({ ...old, content_changed_at: '2026-07-01', content_change_kind: 'body' }, { ...old, html_hash: '別' }, date).content_changed_at === '2026-07-01', '前回の改訂日を引き継ぐ');
assert(detectContentChange({ fetched_at: old.fetched_at, body_combined: '回答 A' }, { body_combined: '回答 B' }, date).content_change_kind === 'body', '質疑応答の本文も比較する');
const hashed = { ...old, html_hash: 'hash-a' };
assert(detectContentChange(hashed, { ...hashed, body: '別の本文', law_version: '令和8年' }, date).content_changed_at === null, 'ハッシュが同じなら本文と法令基準日が違っても改訂しない');
const priorChange = { ...hashed, content_changed_at: '2026-07-01', content_change_kind: 'body' };
const carried = detectContentChange(priorChange, { ...hashed, body: '別の本文' }, date);
assert(carried.content_changed_at === '2026-07-01' && carried.content_change_kind === 'body', 'ハッシュが同じなら既存の改訂履歴を引き継ぐ');
assert(detectContentChange(hashed, { ...hashed, html_hash: 'hash-b' }, date).content_changed_at === null, 'ハッシュだけ違って本文が同じなら改訂しない');
assert(detectContentChange(hashed, { ...hashed, html_hash: 'hash-b', body: '別の本文' }, date).content_change_kind === 'body', 'ハッシュと本文が違えば改訂する');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-backfill-'));
function git(...args) { execFileSync('git', args, { cwd: root, stdio: 'pipe' }); }
try {
  const directory = path.join(root, 'data', 'nta-sources', 'taxanswer', 'shohi');
  fs.mkdirSync(directory, { recursive: true });
  const write = (id, body, fetchedAt) => fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ id, type: 'taxanswer', body, fetched_at: fetchedAt }) + '\n');
  write('1', '新しい本文', date);
  write('2', '同じ本文', date);
  fs.writeFileSync(path.join(directory, '3.json'), JSON.stringify({
    id: '3', type: 'taxanswer', body: 'parser 修正後の本文', fetched_at: date,
    html_hash: 'same-hash', content_changed_at: date, content_change_kind: 'body',
  }) + '\n');
  fs.writeFileSync(path.join(directory, '4.json'), JSON.stringify({
    id: '4', type: 'taxanswer', body: '初回の本文', fetched_at: date,
    content_changed_at: date, content_change_kind: 'body',
  }) + '\n');
  const historyFile = path.join(root, 'history.json');
  const firstVersions = Object.fromEntries(['1', '2', '3'].map(id => [`data/nta-sources/taxanswer/shohi/${id}.json`, { fetched_at: old.fetched_at }]));
  firstVersions['data/nta-sources/taxanswer/shohi/4.json'] = { fetched_at: date };
  const previousVersions = {
    'data/nta-sources/taxanswer/shohi/1.json': { body: '古い本文', fetched_at: old.fetched_at },
    'data/nta-sources/taxanswer/shohi/2.json': { body: '同じ本文', fetched_at: old.fetched_at },
    'data/nta-sources/taxanswer/shohi/3.json': { body: 'parser 修正前の本文', fetched_at: old.fetched_at, html_hash: 'same-hash' },
  };
  fs.writeFileSync(historyFile, JSON.stringify({ firstVersions, previousVersions }));
  const cachePreview = backfill({ root, dryRun: true, historyFile });
  assert(cachePreview.firstFetchedCount === 4 && cachePreview.changed.length === 1, '履歴キャッシュでも dry-run の内容改訂を判定する');
  assert(!JSON.parse(fs.readFileSync(path.join(directory, '1.json'), 'utf8')).first_fetched_at, '履歴キャッシュの dry-run は書き込まない');
  const cacheResult = backfill({ root, historyFile });
  assert(cacheResult.changed.length === 1 && JSON.parse(fs.readFileSync(path.join(directory, '1.json'), 'utf8')).content_change_kind === 'body', '履歴キャッシュから改訂を補正する');
  const corrected = JSON.parse(fs.readFileSync(path.join(directory, '3.json'), 'utf8'));
  assert(!('content_changed_at' in corrected) && !('content_change_kind' in corrected), '同一ハッシュによる parser 変更の誤判定を消す');
  const initialCorrected = JSON.parse(fs.readFileSync(path.join(directory, '4.json'), 'utf8'));
  assert(!('content_changed_at' in initialCorrected) && !('content_change_kind' in initialCorrected), '初回取得に誤って付いた改訂情報を消す');
  const again = backfill({ root, historyFile });
  assert(again.updated === 0 && again.changed.length === 1, '補正スクリプトを再実行しても結果が変わらない');
  fs.rmSync(historyFile);
  fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });

  git('init', '-q');
  fs.mkdirSync(directory, { recursive: true });
  write('1', '古い本文', '2026-06-21T00:00:00Z');
  write('2', '同じ本文', '2026-06-21T00:00:00Z');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '初回');
  write('1', '新しい本文', date);
  write('2', '同じ本文', date);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '再取得');
  const preview = backfill({ root, dryRun: true });
  assert(preview.firstFetchedCount === 2 && preview.changed.length === 1 && preview.changed[0].id === '1', 'dry-run は本文変更だけを予告する');
  assert(!JSON.parse(fs.readFileSync(path.join(directory, '1.json'), 'utf8')).first_fetched_at, 'dry-run は書き込まない');
  const result = backfill({ root });
  assert(result.firstFetchedCount === 2 && JSON.parse(fs.readFileSync(path.join(directory, '1.json'), 'utf8')).content_change_kind === 'body', '履歴から初回日と本文改訂を補正する');
  assert(!JSON.parse(fs.readFileSync(path.join(directory, '2.json'), 'utf8')).content_changed_at, '同じ本文の再取得は改訂にしない');
} catch (error) {
  if (error.code === 'EPERM') console.log('  SKIP: 一時 git リポジトリのテスト（子プロセス起動 EPERM）');
  else throw error;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed ? 1 : 0);
