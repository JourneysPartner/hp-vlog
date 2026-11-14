'use strict';

/**
 * 題名に検索語を空白区切りのまま貼らせない（2026-11-14）。
 *
 * 背景: 11/14 に公開した記事の題名が「せどり 確定申告 バレない 無申告が…」と、
 * 主検索語を空白で区切ったまま頭に貼った形だった。lintTitle / lintSeo /
 * checkLlmTitle のどれも日本語の間の空白を見ておらず、作り直しの指示にも
 * 「空白で区切ったまま並べない」が無かった。
 *
 * 検証:
 *   1. R1 日本語の文字の間の空白を fail にする（9 通り）
 *   2. checkLlmTitle がその fail を理由として返す
 *   3. R2 検索語の貼り付けを fail にする（8 通り）
 *   4. decideRetitle の採否（5 通り）
 *   5. RETITLE_TRIGGER_CODES
 *   6. buildRetitlePrompt の指示
 *   7. generate-draft.js が新しい関数とログを使っている
 *   8. article-prompt-static.js の本文用の指示
 *   9. T1 今の記事を落とさない
 *  10. R6 validate.js の警告（OS の一時フォルダーで確かめる）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..', '..');
const { lintTitle, findJapaneseSpace } = require(path.join(ROOT, 'scripts/lib/title-lint'));
const { lintSeo, titleHasRawQuery } = require(path.join(ROOT, 'scripts/lib/seo-lint'));
const { checkLlmTitle } = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));
const {
  RETITLE_TRIGGER_CODES,
  decideRetitle,
  buildRetitlePrompt,
} = require(path.join(ROOT, 'scripts/lib/title-retry'));

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const hasJapaneseSpaceFail = title => lintTitle(title).fails.some(v => v.startsWith('日本語の間に空白'));

console.log('=== 1. R1 日本語の文字の間の空白 ===');
{
  const rows = [
    ['せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税', true, 'り 確'],
    ['せどり　確定申告　バレない？無申告の流れ', true, 'り 確'],
    ['ﾒﾙｶﾘ 売上の確定申告はいくらから？', true, 'リ 売'],
    ['ネットショップのセラー 確定申告の流れ', true, 'ー 確'],
    ['せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税', false, ''],
    ['eBay 輸出の消費税還付はいつ戻る？手続きの流れ', false, ''],
    ['インボイス 2割特例はいつまで使える？', false, ''],
    ['確定申告は必要？ 副業の所得が20万円以下のとき', false, ''],
    ['ふるさと納税 ｜ 上限額の目安', false, ''],
  ];
  for (const [title, expected, found] of rows) {
    assert(hasJapaneseSpaceFail(title) === expected,
      `lintTitle fail ${expected ? 'あり' : 'なし'}: ${title}`);
    assert(findJapaneseSpace(title) === found,
      `findJapaneseSpace "${found}": ${title}`);
  }
}

console.log('');
console.log('=== 2. checkLlmTitle の理由 ===');
{
  const ctx = { macro: '物販', article_type: 'basic_explainer' };
  const bad = checkLlmTitle('せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税', ctx);
  assert(bad.ok === false, '空白入りの題名は ok: false');
  assert(bad.reasons.some(v => v.includes('日本語の間に空白')), 'reasons に「日本語の間に空白」が入る');
  const good = checkLlmTitle('せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税', ctx);
  assert(good.ok === true, `直した題名は ok: true（${good.reasons.join(' / ')}）`);
}

console.log('');
console.log('=== 3. R2 検索語の貼り付け ===');
{
  const rows = [
    ['せどり 確定申告 バレない', 'せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税', true],
    ['せどり 確定申告 バレない', 'せどり　確定申告　バレない？無申告の流れ', true],
    ['せどり 確定申告 バレない', 'せどり  確定申告 バレない？無申告の流れ', true],
    ['せどり 確定申告 バレない', 'せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税', false],
    ['インボイス 2割特例', 'インボイス 2割特例はいつまで使える？', true],
    ['インボイス 2割特例', 'インボイスの2割特例はいつまで使える？', false],
    ['eBay 輸出', 'EBAY 輸出の消費税還付はいつ戻る？', true],
    ['年末調整', '年末調整 やり方', false],
  ];
  for (const [query, title, expected] of rows) {
    assert(titleHasRawQuery(title, query) === expected,
      `titleHasRawQuery ${expected ? 'true' : 'false'}: ${title}`);
    const r = lintSeo({ title, summary: '', body: '', target_query: query });
    assert(r.fails.includes('title_raw_query') === expected,
      `lintSeo title_raw_query ${expected ? 'あり' : 'なし'}: ${title}`);
  }
  const empty = lintSeo({ title: 'せどり 確定申告 バレない 無申告の流れ', summary: '', body: '', target_query: '' });
  assert(empty.fails.length === 0, 'target_query が空なら fails は空のまま');
}

console.log('');
console.log('=== 4. decideRetitle の採否 ===');
{
  const ok = { ok: true, reasons: [] };
  let d = decideRetitle({ beforeFails: ['title_raw_query'], retriedFails: [], titleCheck: ok });
  assert(d.accept === true && d.reason === '', '前だけ title_raw_query・後は空 → 採る');

  d = decideRetitle({
    beforeFails: ['title_missing_query', 'title_too_long'],
    retriedFails: ['title_raw_query'],
    titleCheck: ok,
  });
  assert(d.accept === false && d.reason === '検索語を空白区切りのまま貼っている',
    '後にも title_raw_query → 採らない（検索語を空白区切りのまま貼っている）');

  d = decideRetitle({
    beforeFails: ['title_missing_query'],
    retriedFails: [],
    titleCheck: { ok: false, reasons: ['日本語の間に空白: "り 確"'] },
  });
  assert(d.accept === false && d.reason.startsWith('題名の点検: '),
    '題名の点検が ok: false → 採らない（題名の点検: で始まる）');

  d = decideRetitle({ beforeFails: ['title_too_long'], retriedFails: ['title_too_long'], titleCheck: ok });
  assert(d.accept === false && d.reason === '題名の fail が減らない（1 → 1）',
    '題名の fail が減らない → 採らない（1 → 1）');

  d = decideRetitle({
    beforeFails: ['title_missing_query', 'summary_missing_query'],
    retriedFails: ['summary_missing_query'],
    titleCheck: ok,
  });
  assert(d.accept === true && d.reason === '', '題名以外の code は数えない → 採る');
}

console.log('');
console.log('=== 5. RETITLE_TRIGGER_CODES ===');
{
  assert(Object.isFrozen(RETITLE_TRIGGER_CODES), '変えられない（Object.isFrozen）');
  assert(JSON.stringify(RETITLE_TRIGGER_CODES)
    === JSON.stringify(['title_missing_query', 'title_too_long', 'title_raw_query']),
  '3 つの code をこの順で持つ');
}

console.log('');
console.log('=== 6. buildRetitlePrompt ===');
{
  const addedLines = [
    '- 主検索語が渡されたときは、その各語を先頭15文字以内に入れる。各語は助詞などを補って、自然な日本語の文としてつなぐ。',
    '- 題名に空白を入れない。主検索語を空白で区切ったまま並べない。',
    '  悪い例（主検索語「メルカリ 売上 確定申告」）: メルカリ 売上 確定申告 いくらから必要か',
    '  良い例: メルカリの売上は確定申告が必要？いくらからかと申告の流れ',
  ];
  const keptLines = [
    '28〜45文字。45文字を超えない。',
    '末尾に「を解説」「について」「まとめ」を付けない。',
    '「徹底解説」「完全ガイド」「必読」は使わない。',
    '同じ名詞を繰り返さない。',
    '記事に書かれていないことをタイトルにしない。',
    '出力はタイトルの文字列のみ。前置きも引用符も付けない。',
  ];

  const topic = {
    category: '所得税', persona: 'reseller_marketplace_seller',
    target_query: 'せどり 確定申告 バレない',
  };
  const { system, user } = buildRetitlePrompt('## 見出し1\n本文です。', topic);
  for (const line of addedLines) assert(system.includes(line), `system に R4 の行: ${line.slice(0, 18)}…`);
  assert(!system.includes('その語を先頭15文字以内に置く。'), '古い「その語を先頭15文字以内に置く。」が無い');
  for (const line of keptLines) assert(system.includes(line), `system に今の行: ${line.slice(0, 18)}…`);

  const lines = user.split('\n');
  const mainAt = lines.indexOf('主検索語: せどり 確定申告 バレない');
  assert(mainAt >= 0, 'user に主検索語の行がある');
  assert(lines[mainAt + 1] === '主検索語の各語: せどり／確定申告／バレない',
    '主検索語の行の直後に各語の行がある');

  const noQuery = buildRetitlePrompt('## 見出し1\n本文です。', { category: '所得税', persona: 'reseller_marketplace_seller' });
  assert(noQuery.user.includes('主検索語: （指定なし）'), '主検索語が無ければ（指定なし）');
  assert(!noQuery.user.includes('主検索語の各語'), '主検索語が無ければ各語の行は足さない');

  const headings = Array.from({ length: 13 }, (_, i) => `${i % 2 ? '###' : '##'} 見出し${i + 1}`);
  const manyHeads = buildRetitlePrompt(
    ['導入の文です。', ...headings.map(h => `${h}\n本文です。`)].join('\n'), topic);
  for (let i = 1; i <= 12; i++) {
    assert(manyHeads.user.includes(`- 見出し${i}`), `見出し ${i} が入る`);
  }
  assert(!manyHeads.user.includes('- 見出し13'), '見出しは 12 本まで');
  assert(manyHeads.user.includes('導入の文です。'), '本文の冒頭が入る');

  const longLead = buildRetitlePrompt(`## 見出し1\n${'あ'.repeat(400)}`, topic);
  assert(longLead.user.includes('あ'.repeat(300)) && !longLead.user.includes('あ'.repeat(301)),
    '本文の冒頭は 300 字まで');
}

console.log('');
console.log('=== 7. generate-draft.js の使い方 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(src.includes("require('./lib/title-retry')"), 'title-retry を読み込む');
  assert(src.includes('RETITLE_TRIGGER_CODES.includes'), 'RETITLE_TRIGGER_CODES で作り直しを始める');
  assert(src.includes('decideRetitle('), 'decideRetitle で採否を決める');
  assert(src.includes('buildRetitlePrompt('), 'buildRetitlePrompt で指示を組み立てる');
  assert(!src.includes('その語を先頭15文字以内に置く'), '古い指示の文が残っていない');
  assert(src.includes('[seo] 題名が点検に落ちました'), '落ちた理由のログがある');
  assert(src.includes('[seo] 作り直した題名を採用せず'), '採らなかった理由のログがある');
}

console.log('');
console.log('=== 8. article-prompt-static.js の本文用の指示 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/article-prompt-static.js'), 'utf8');
  assert(src.includes('主検索語は助詞を補って文にし、空白で区切ったまま題名に並べない（題名に空白を入れない）。'),
    '題名自然化ルールに 1 と 2 を広げた文がある');
  assert(src.includes('  ・題名: 先頭 15 文字以内（空白で区切ったまま並べず、助詞を補って文にする）'),
    'SEO ルールの題名の行を直した');
}

console.log('');
console.log('=== 9. T1 今の記事を落とさない ===');
{
  const postsDir = path.join(ROOT, 'content', 'posts');
  const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.md'));
  let spaceFails = 0;
  let rawQueryFails = 0;
  for (const file of files) {
    const { data: fm } = matter(fs.readFileSync(path.join(postsDir, file), 'utf8'));
    if (lintTitle(fm.title).fails.some(v => v.startsWith('日本語の間に空白'))) {
      spaceFails++;
      console.error(`    日本語の間に空白: ${file} "${fm.title}"`);
    }
    if (fm.target_query) {
      const r = lintSeo({ title: fm.title, summary: '', body: '', target_query: fm.target_query });
      if (r.fails.includes('title_raw_query')) {
        rawQueryFails++;
        console.error(`    title_raw_query: ${file} "${fm.title}"`);
      }
    }
  }
  assert(spaceFails === 0, `全 ${files.length} 本で「日本語の間に空白」の fail が無い`);
  assert(rawQueryFails === 0, 'target_query のある記事で title_raw_query の fail が無い');
}

console.log('');
console.log('=== 10. R6 validate.js の警告 ===');
{
  const { validateFile } = require(path.join(ROOT, 'scripts/validate.js'));
  const srcPath = path.join(ROOT, 'content', 'posts', '2026-11-13-reselling-tax-declaration-detection.md');
  const src = fs.readFileSync(srcPath, 'utf8');
  const base = validateFile(srcPath);
  const withTitle = (title, targetQuery) => src
    .replace(/^title: ".*"$/m, `title: "${title}"`)
    .replace(/^target_query: ".*"$/m, `target_query: "${targetQuery}"`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-spaced-query-'));
  try {
    const badPath = path.join(dir, 'bad.md');
    fs.writeFileSync(badPath, withTitle(
      'せどり 確定申告 バレない 無申告が税務署に気づかれる流れと加算税',
      'せどり 確定申告 バレない'), 'utf8');
    const bad = validateFile(badPath);
    assert(bad.warnings.some(v => v.includes('title に target_query「せどり 確定申告 バレない」が空白区切りのまま入っています')),
      '検索語の貼り付けの警告が出る');
    assert(bad.warnings.some(v => v.includes('title の日本語の間に空白があります（"り 確"）')),
      '日本語の間の空白の警告が出る');
    assert(bad.errors.length === base.errors.length,
      `errors は元の記事と同じ数（${base.errors.length} → ${bad.errors.length}）`);

    const goodPath = path.join(dir, 'good.md');
    fs.writeFileSync(goodPath, withTitle(
      'せどりで確定申告しなくてもバレない？無申告が税務署に気づかれる流れと加算税',
      'せどり 確定申告 バレない'), 'utf8');
    const good = validateFile(goodPath);
    assert(!good.warnings.some(v => v.includes('が空白区切りのまま入っています')), '直した題名は貼り付けの警告が出ない');
    assert(!good.warnings.some(v => v.includes('の日本語の間に空白があります')), '直した題名は空白の警告が出ない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
