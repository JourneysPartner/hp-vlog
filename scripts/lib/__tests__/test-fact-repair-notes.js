'use strict';

// #741 の原文・c28 の値を使い、判定と修正はすべて偽の AI で確認する。
const assert = require('assert/strict');
const F = require('../fact-check');
const H = require('./fact-pages-test-helpers');
const bp = require('../banned-phrases');
const source2070 = require('../../../data/nta-sources/taxanswer/shotoku/2070.json');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { now: new Date('2026-11-04T00:00:00Z'), batch: false, loadEvidenceText: e => e.text };
const sentence = '事業所得にして青色申告をする場合は、複式簿記での記帳と、貸借対照表・損益計算書の添付が前提です。';
const correct = '青色申告は簡易な記帳でもよいとされており、複式簿記（正規の簿記）による記帳と貸借対照表・損益計算書の添付は、最高55万円（65万円）の青色申告特別控除を受けるための要件です。それ以外の青色申告者は最高10万円の控除となります。';
const quoteParts = [
  '青色申告者の帳簿書類とその保存青色申告の記帳は、年末に貸借対照表と損益計算書を作成することができるような正規の簿記によることが原則ですが、現金出納帳、売掛帳、買掛帳、経費帳、固定資産台帳のような帳簿を備え付けて簡易な記帳をするだけでもよいことになっています。',
  '青色申告特別控除イ不動産所得または事業所得を生ずべき事業を営んでいる青色申告者で、これらの所得に係る取引を正規の簿記の原則、（一般的には複式簿記）により記帳し、その記帳に基づいて作成した貸借対照表および損益計算書を確定申告書に添付して、確定申告書をその提出期限（確定申告期限）までに提出している場合には、原則としてこれらの所得を通じて最高55万円（令和元年以前は最高65万円）を控除することとされています。',
];
const quote = quoteParts.join('\n…\n');
const note1 = '（注1）令和2年分以後の青色申告特別控除について、この最高55万円の青色申告特別控除を受けることができる方が、電子帳簿保存（※）またはe-Taxによる電子申告を行っている場合は、最高65万円の青色申告特別控除が受けられます。';
const bad = '事業所得にして青色申告をする場合、簡易な記帳でもよいとされていますが、最高55万円（令和元年以前は最高65万円）の青色申告特別控除を受けるには、複式簿記での記帳と、貸借対照表・損益計算書を確定申告書に添付して期限内に提出することが要件で、それ以外の青色申告者は最高10万円の控除となります。';
const good = '事業所得で青色申告をする場合、最高55万円の青色申告特別控除を受けるには、複式簿記での記帳と貸借対照表・損益計算書の添付、期限内の提出が必要です。この要件に加えて、e-Taxで申告するか、帳簿を優良な電子帳簿として保存していれば、控除は最高65万円になります。それ以外の青色申告者は最高10万円です。';
const repairInstruction = '根拠の原文に合わせて、この文だけを直す。正しい内容は correct に従う。quote_notes に、条件によって別の額・要件になると書かれているときは、その条件と額も落とさずに書く。元の文が過去の年分を扱っていない限り、過去の年分の扱い（「令和元年以前は」など）は書かない。quote・quote_notes に例外（「〜の場合を除く」「ただし〜」など）や、別の判定のしかた・選択肢（「〜に代えて〜で判定することもできる」「いずれかを選べる」など）が書かれているときは、それを落とさずに書く';
const judgeInstruction = '主張が制度の控除額・上限額を「最高」「最大」「上限」などとして述べているのに、原文の注・ただし書きでは条件によって別の額（より高い額など）になると書かれていて、その文にも前後の文にもその条件と額が書かれていない場合は、食い違いとし、correct に条件と額を書いてください。';
const numberReason = '根拠の正しい内容に無い数字を足しています';
const claim = { id: 'c28', sentence, claim: sentence, type: '要件', subject: '青色申告', heading: '' };
const ref = text => ({ id: 'fixture', title: '試験用原文', url: 'https://example.invalid/source', text });
const finding = extra => ({ ...claim, status: '食い違い', correct, quote, quote_notes: note1, ...extra });
const enhanced = { ...options, writer_materials: ['ta:2070'], resolvedWriterMaterials: [ref(source2070.body)] };

async function judge(text, parts, status = '食い違い', extra = {}) {
  const [row] = await F.judgeClaims([claim], { c28: [ref(text)] }, sentence, async req => {
    const page = H.materials(req)[0];
    const basis = parts.map(part => {
      const range = String(page.rows.find(row => F.normalizedQuote(row.text) === F.normalizedQuote(part))?.s || '');
      assert.ok(range, '題材の引用を番号にできる');
      return range;
    }).join(',');
    return [{ id: 'c28', status, evidence_id: 1, basis, correct: status === '裏付けあり' ? '' : correct }];
  }, { ...options, ...extra });
  assert.equal(row.status, status);
  return row;
}

async function repair(f, replacement, opts = options, inspect = () => {}) {
  return F.repairBody(f.sentence, [f], async req => {
    inspect(req);
    return [{ id: f.id, replacement }];
  }, opts);
}

test('R1', '#741 の2範囲の quote を保ち、直後の注だけを渡す', async () => {
  const row = await judge(source2070.body, quoteParts);
  assert.equal(row.quote, quote);
  assert.ok(row.quote_notes.startsWith(note1));
  assert.ok(row.quote_notes.includes('（注2）'));
  assert.ok(row.quote_notes.includes('（※）令和4年分以後'));
  assert.ok(!row.quote_notes.includes('なお、既に'));
  assert.ok(!row.quote_notes.includes('ロ上記イ以外の'));
  const saved = JSON.parse(JSON.stringify(F.compactRecord({ corrections: [row], remaining: [row] })));
  assert.equal(saved.corrections[0].quote_notes, row.quote_notes);
  assert.equal(saved.remaining[0].quote_notes, row.quote_notes);
});

for (const status of ['裏付けあり', '資料なし']) test('R1', `${status} に quote_notes を作らない`, async () => {
  const row = await judge(source2070.body, quoteParts, status);
  assert.equal(Object.hasOwn(row, 'quote_notes'), false);
  if (status === '裏付けあり') assert.equal(row.quote, quote);
});

test('R1', '期限の書き漏れにも直後の注を渡す', async () => {
  const row = await judge(source2070.body, quoteParts, '期限の書き漏れ');
  assert.ok(row.quote_notes.startsWith(note1));
});

const plainQuote = 'この制度は所定の帳簿を作成して申告する必要があります。';
for (const prefix of ['（注1）', '(注1)', '※', '（※）', 'ただし', 'なお']) {
  test('R1', `空白に続く「${prefix}」を集め、通常文で止める`, async () => {
    const note = `${prefix}条件によって別の申告方法を利用できます。`;
    const row = await judge(`${plainQuote}\n　 ${note}\n通常の説明です。\n※後の注は集めません。`, [plainQuote]);
    assert.equal(row.quote_notes, note);
  });
}

test('R1', '注が無ければ欄を作らず、途中の通常文を飛ばさない', async () => {
  const row = await judge(`${plainQuote}\n通常の説明です。\n※後の注は集めません。`, [plainQuote]);
  assert.equal(Object.hasOwn(row, 'quote_notes'), false);
});

test('R1', '連続する注は3文まで', async () => {
  const notes = ['（注1）最初の条件です。', 'ただし別の条件があります。', 'なお提出も必要です。', '※この注は上限の外です。'];
  const row = await judge([plainQuote, ...notes].join('\n'), [plainQuote]);
  assert.equal(row.quote_notes, notes.slice(0, 3).join('\n'));
});

test('R1', '600字ちょうどを認め、超える文を入れずそこで止める', async () => {
  const notes = ['※' + 'あ'.repeat(197) + '。', '※' + 'い'.repeat(197) + '。']; // 各199字
  const last = 'なお' + 'う'.repeat(197) + '。'; // 200字（改行2つ込みで600字）
  const exact = await judge([plainQuote, ...notes, last].join('\n'), [plainQuote]);
  assert.equal(exact.quote_notes.length, 600);
  const over = await judge([plainQuote, ...notes, last.replace('。', 'う。'), '※短い注です。'].join('\n'), [plainQuote]);
  assert.equal(over.quote_notes, notes.join('\n'));
});

test('R1', '離れた2範囲の注を範囲ごとに集めて区切る', async () => {
  const other = '別の制度の説明についても原文に従って確認してください。';
  const first = '※最初の範囲の注です。', second = 'ただし次の範囲にも条件があります。';
  const row = await judge([plainQuote, first, '通常の説明です。', other, second].join('\n'), [plainQuote, other]);
  assert.equal(row.quote, [plainQuote, other].join('\n…\n'));
  assert.equal(row.quote_notes, [first, second].join('\n…\n'));
});

test('R1', '資料表の省略された区間を越えて注を集めない', async () => {
  const note = '※離れた箇所の注です。';
  const text = plainQuote + '\n' + '通常文。'.repeat(1600) + '\n' + note;
  const excerpt = { ...ref(text), text_ranges: [[0, plainQuote.length], [text.length - note.length, text.length]] };
  const [row] = await F.judgeClaims([claim], { c28: [excerpt] }, sentence,
    async () => [{ id: 'c28', status: '食い違い', evidence_id: 1, basis: '1', correct: '帳簿を作成して申告します。' }], options);
  assert.equal(row.status, '食い違い');
  assert.equal(Object.hasOwn(row, 'quote_notes'), false);
});

test('R2', 'instruction は指定文字列と一致し、repair に quote_notes を渡す', async () => {
  const f = await judge(source2070.body, quoteParts);
  assert.equal(F.repairInstructions([f])[0].instruction, repairInstruction);
  const result = await repair(f, good, options, req => {
    const [sent] = JSON.parse(req.user).corrections;
    assert.equal(sent.instruction, repairInstruction);
    assert.equal(sent.quote, quote);
    assert.equal(sent.quote_notes, f.quote_notes);
  });
  assert.equal(result.body, good);
});

for (const [name, opts] of [['enhanced 偽', options], ['enhanced 真', enhanced]]) {
  test('R3', `${name}: #741 の悪い置換の令和元年を却下する`, async () => {
    assert.deepEqual(F.normalizedNumbers('令和元年'), ['日付:令和1']);
    const result = await repair(finding(), bad, opts);
    assert.equal(result.rejected.get('c28'), numberReason);
    assert.equal(result.body, sentence);
    assert.equal(result.replacements.size, 0);
  });
  test('R3', `${name}: 条件と現在の別の額を含む良い置換を採る`, async () => {
    const result = await repair(finding(), good, opts);
    assert.equal(result.rejected.size, 0);
    assert.equal(result.body, good);
  });
}

test('R3', '作り直しの AI に新しい却下理由と注が届く', async () => {
  const tasks = [];
  const result = await F.repairBody(sentence, [finding()], async req => {
    tasks.push(req.task);
    if (req.task === 'retry_repair') {
      const input = JSON.parse(req.user);
      assert.equal(input.previous[0].reason, numberReason);
      assert.equal(input.corrections[0].quote_notes, note1);
      return [{ id: 'c28', replacement: good }];
    }
    return [{ id: 'c28', replacement: bad }];
  }, enhanced);
  assert.deepEqual(tasks, ['repair', 'retry_repair']);
  assert.equal(result.body, good);
  assert.equal(result.rejected.size, 0);
});

for (const [name, extra] of [
  ['元の文', { sentence: 'この制度の上限は65万円です。' }],
  ['correct', { correct: 'この制度の上限は65万円です。' }],
  ['quote_notes', { quote_notes: 'ただし追加の条件を満たすと65万円です。' }],
  ['keep_numbers', { keep_numbers: ['65万円'] }],
]) test('R3', `${name} の数字を許す`, async () => {
  const f = finding({ sentence: 'この制度を申告できます。', correct: '', quote_notes: '', ...extra });
  const result = await repair(f, 'この制度の申告には条件があり、控除額は65万円です。');
  assert.equal(result.rejected.size, 0);
});

test('R3', 'quote だけにある数字は許さない', async () => {
  const result = await repair(finding({ correct: '', quote_notes: '' }), 'この制度の控除額は55万円です。');
  assert.equal(result.rejected.get('c28'), numberReason);
});

test('R3', '期限の correct の年月日を許し、別の年は却下する', async () => {
  const f = finding({ sentence: 'この制度は申請できます。', status: '期限の書き漏れ',
    correct: '申請期限は令和9年3月31日です。', quote_notes: '' });
  const ok = await repair(f, 'この制度は令和九年三月三十一日まで申請できます。');
  assert.equal(ok.rejected.size, 0);
  const badYear = await repair(f, 'この制度は令和8年3月31日まで申請できます。');
  assert.equal(badYear.rejected.get('c28'), numberReason);
  assert.equal(badYear.body, f.sentence);
});

test('R3', '読めない数字は元の文にある場合だけ許す', async () => {
  const replacement = 'この制度の申告には0分の1の基準があります。';
  for (const original of ['この制度を申告できます。', 'この制度の基準は0分の1です。']) {
    const result = await repair(finding({ sentence: original, correct: '0分の1', quote_notes: '※0分の1です。', keep_numbers: ['0分の1'] }), replacement);
    if (original.includes('0分の1')) assert.equal(result.rejected.size, 0);
    else assert.equal(result.rejected.get('c28'), numberReason);
  }
});

for (const [label, original, details, replacement, invalid] of [
  ['食い違い2件', '限度額は100万円、控除額は50万円です。',
    [['食い違い', '限度額は200万円です。'], ['食い違い', '控除額は60万円です。']],
    '限度額は200万円、控除額は60万円です。', '限度額は200万円、控除額は70万円です。'],
  ['食い違いと期限の書き漏れ', '限度額は100万円で、申請できます。',
    [['食い違い', '限度額は200万円です。'], ['期限の書き漏れ', '申請期限は令和9年3月31日です。']],
    '限度額は200万円で、令和9年3月31日まで申請できます。', '限度額は200万円で、令和8年3月31日まで申請できます。'],
]) for (const [name, opts] of [['enhanced 偽', options], ['enhanced 真', enhanced]]) {
  const findings = details.map(([status, correct], i) => finding({ id: `c${i + 1}`, sentence: original, claim: original,
    type: status === '期限の書き漏れ' ? '期限' : '金額', subject: '試験制度', status, correct, quote: '', quote_notes: '' }));
  test('R3', `${name}: 同じ文の${label}をまとめた置換は作り直さず採る`, async () => {
    const tasks = [];
    const result = await F.repairBody(original, findings, async req => {
      tasks.push(req.task);
      return findings.map(f => ({ id: f.id, replacement }));
    }, opts);
    assert.deepEqual(tasks, ['repair']);
    assert.equal(result.rejected.size, 0);
    assert.equal(result.body, replacement);
  });
  test('R3', `${name}: 同じ文の${label}のどの指摘にも無い数字は両方却下する`, async () => {
    const result = await F.repairBody(original, findings, async () => findings.map(f => ({ id: f.id, replacement: invalid })), opts);
    for (const f of findings) assert.equal(result.rejected.get(f.id), numberReason);
    assert.equal(result.body, original);
    assert.equal(result.replacements.size, 0);
  });
}

test('R3', '別の文の指摘の数字は共有せず、その文の正しい修正は採る', async () => {
  const original = '限度額は100万円、控除額は50万円です。', other = '別の限度額は80万円です。';
  const findings = [
    ['c1', original, '限度額は200万円です。'], ['c2', original, '控除額は60万円です。'],
    ['c3', other, '別の限度額は90万円です。'],
  ].map(([id, sentence, correct]) => finding({ id, sentence, claim: sentence, type: '金額', correct, quote: '', quote_notes: '' }));
  const result = await F.repairBody(original + '\n' + other, findings, async () => findings.map(f => ({ id: f.id,
    replacement: f.id === 'c3' ? f.correct : '限度額は200万円、控除額は90万円です。' })), options);
  for (const id of ['c1', 'c2']) assert.equal(result.rejected.get(id), numberReason);
  assert.equal(result.rejected.has('c3'), false);
  assert.equal(result.body, original + '\n別の限度額は90万円です。');
});

test('R3', '同じ文でも資料なしの指摘の correct の数字は共有しない', async () => {
  const original = '限度額は100万円、控除額は50万円です。';
  const findings = [
    finding({ id: 'c1', sentence: original, claim: '限度額は100万円', type: '金額', correct: '限度額は200万円です。', quote: '', quote_notes: '' }),
    finding({ id: 'c2', sentence: original, claim: '控除額は50万円', type: '金額', status: '資料なし', correct: '控除額は70万円です。', quote: '', quote_notes: '' }),
  ];
  const result = await F.repairBody(original, findings, async () => findings.map(f => ({ id: f.id,
    replacement: '限度額は200万円、控除額は70万円です。' })), options);
  assert.equal(result.rejected.get('c1'), numberReason);
  assert.equal(result.body, original);
});

for (const field of ['quote_notes', 'keep_numbers', 'supported_numbers']) test('R3', `同じ文の別の指摘の ${field} の数字も共有する`, async () => {
  const original = '限度額は100万円、控除額は50万円です。', replacement = '限度額は200万円、控除額は60万円です。';
  const findings = [
    finding({ id: 'c1', sentence: original, correct: '限度額は200万円です。', quote: '', quote_notes: '' }),
    finding({ id: 'c2', sentence: original, correct: '', quote: '', quote_notes: '',
      [field]: field === 'quote_notes' ? '条件を満たす控除額は60万円です。' : ['60万円'] }),
  ];
  const result = await F.repairBody(original, findings, async () => findings.map(f => ({ id: f.id, replacement })), options);
  assert.equal(result.rejected.size, 0);
  assert.equal(result.body, replacement);
});

test('R3', '同じ文の別の指摘でも quote だけにある数字は共有しない', async () => {
  const original = '限度額は100万円、控除額は50万円です。';
  const findings = ['c1', 'c2'].map(id => finding({ id, sentence: original,
    correct: id === 'c1' ? '限度額は200万円です。' : '控除額は60万円です。',
    quote: id === 'c2' ? '控除額は70万円です。' : '', quote_notes: '' }));
  const result = await F.repairBody(original, findings, async () => findings.map(f => ({ id: f.id,
    replacement: '限度額は200万円、控除額は70万円です。' })), options);
  for (const f of findings) assert.equal(result.rejected.get(f.id), numberReason);
  assert.equal(result.body, original);
});

test('R3', '作り直しに渡らない同じ文の指摘の数字は共有しない', async () => {
  const original = '限度額は100万円、控除額は50万円です。', tasks = [];
  const findings = ['c1', 'c2'].map(id => finding({ id, sentence: original, claim: original, type: '金額', subject: '試験制度',
    correct: id === 'c1' ? '限度額は200万円です。' : '控除額は60万円です。', quote: '', quote_notes: '' }));
  const result = await F.repairBody(original, findings, async req => {
    tasks.push(req.task);
    if (req.task === 'retry_repair') {
      assert.deepEqual(JSON.parse(req.user).corrections.map(c => c.id), ['c1']);
      return [{ id: 'c1', replacement: '限度額は200万円、控除額は60万円です。' }];
    }
    return [{ id: 'c1', replacement: original }, { id: 'c2', replacement: '' }];
  }, enhanced);
  assert.deepEqual(tasks, ['repair', 'retry_repair']);
  assert.equal(result.rejected.get('c1'), numberReason);
  assert.equal(result.rejected.get('c2'), '置き換え後の文が空です');
  assert.equal(result.body, original);
});

test('R3', '#741 の悪い置換を本文に入れず、承認を止めて注と理由を記録する', async () => {
  const tasks = [];
  const result = await F.checkFacts(sentence, { ...options, writer_materials: [], searchEvidence: () => [ref(source2070.body)],
    callLLM: async req => {
      tasks.push(req.task);
      if (req.task === 'extract') return [{ s: 1, type: claim.type, subject: claim.subject, claim: sentence }];
      const input = JSON.parse(req.user);
      if (req.task === 'repair') return input.corrections.map(c => ({ id: c.id, replacement: bad }));
      assert.equal(req.task, 'judge');
      const page = H.materials(req)[0];
      const basis = quoteParts.map(part => page.rows.find(row => F.normalizedQuote(row.text) === F.normalizedQuote(part)).s).join(',');
      return input.claims.map(c => ({ id: c.id, status: '食い違い', evidence_id: 1, basis, correct }));
    },
  });
  assert.equal(result.body, sentence);
  assert.equal(result.record.status, 'revise');
  assert.equal(result.record.corrections[0].reason, numberReason);
  assert.equal(result.record.corrections[0].resolved, false);
  assert.equal(result.record.corrections[0].after, '');
  assert.equal(result.record.remaining[0].sentence, sentence);
  assert.ok(result.record.remaining[0].quote_notes.startsWith(note1));
  assert.deepEqual(tasks, ['extract', 'judge', 'repair']);
});

test('R4', 'judge の指定位置に規則が入り、版が plan2-s8 になる', async () => {
  await F.judgeClaims([claim], { c28: [ref(source2070.body)] }, sentence, async req => {
    assert.ok(req.system.includes('特定の年分の値として正しく書いている場合は裏付けありとしてください。' + judgeInstruction));
    return [{ id: 'c28', status: '資料なし' }];
  }, options);
  const result = await F.checkFacts('', { ...options, callLLM: async () => { throw new Error('空本文で AI を呼ばない'); } });
  assert.equal(result.record.logic_version, 'plan2-s8');
});

test('R5', '手がかりの3表記をポイントへ置換する', () => {
  for (const word of ['手がかり', '手掛かり', '手掛り']) {
    const result = bp.applyBannedPhrasesToBody(`営利目的で続けているかどうかが一つの${word}になります。`);
    assert.equal(result.text, '営利目的で続けているかどうかが一つのポイントになります。');
    assert.deepEqual(result.applied.map(p => p.id), ['no-tegakari']);
  }
});

test('R5', '常見ですを先に置換し、残る形だけ1件警告する', () => {
  const replaced = bp.applyBannedPhrasesToBody('思い込むのも常見です。');
  assert.equal(replaced.text, '思い込むのもよくあります。');
  assert.deepEqual(replaced.applied.map(p => p.id), ['no-jouken-desu']);
  const warning = bp.applyBannedPhrasesToBody('常見の誤り');
  assert.equal(warning.text, '常見の誤り');
  assert.deepEqual(warning.applied.map(p => [p.id, p.hasReplacement]), [['no-jouken', false]]);
  assert.equal(bp.detectBannedInBody(warning.text).length, 1);
});

test('R5', 'formatForPrompt() に3件が出る', () => {
  const prompt = bp.formatForPrompt();
  for (const phrase of ['手がかり', '常見です', '常見（〜の誤りなど）']) assert.ok(prompt.includes(`「${phrase}」`));
});

(async () => {
  const originalFetch = global.fetch;
  const previousWriterMode = process.env.FACT_CHECK_WRITER_MATERIALS;
  global.fetch = async () => { throw new Error('試験中のネットワークは禁止'); };
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  let passed = 0;
  try {
    for (const t of tests) {
      try { await t.run(); passed++; console.log(`PASS ${t.group}: ${t.name}`); }
      catch (error) { console.error(`FAIL ${t.group}: ${t.name}\n${error.stack}`); }
    }
  } finally {
    global.fetch = originalFetch;
    if (previousWriterMode === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS;
    else process.env.FACT_CHECK_WRITER_MATERIALS = previousWriterMode;
  }
  console.log(`repair-amount-notes: PASS ${passed} / FAIL ${tests.length - passed}`);
  if (passed !== tests.length) process.exitCode = 1;
})();
