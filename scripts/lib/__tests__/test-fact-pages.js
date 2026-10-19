'use strict';

// 03i。LLMは偽の関数、実資料と試験データは読み取りだけ。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');
const F = require('../fact-check');
const E = require('../fact-evidence');
const U = require('../fact-units');
const P = require('../fact-pages');
const H = require('./fact-pages-test-helpers');
const { LAW_SCOPE_RULE } = require('../grounding-rules');
const groups = {};
const now = new Date('2026-10-14T00:00:00Z');
const root = path.resolve(__dirname, '../../..');
const fixtures = path.join(root, 'docs/codex-tasks/fact-grounding/fixtures/real-run-3');
const norm = F.normalizedQuote;
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, heading: '', type: '要件', subject: '制度', claim: sentence, ...extra });
const ref = (text, id = 'e1') => ({ id, title: '制度', url: `https://example.jp/${id}`, law_version: '', text });
const opts = extra => ({ now, enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', ...extra });
async function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
function findBasis(page, quote) {
  const needle = norm(quote);
  if (!needle) return '';
  for (const u of page.units) for (let end = u.s; end <= u.s + 3; end++) {
    const found = U.rangeText(page.source, page.units, end === u.s ? String(u.s) : `${u.s}-${end}`);
    if (found && norm(found.text).includes(needle)) return end === u.s ? String(u.s) : `${u.s}-${end}`;
  }
  return '';
}
function numberedClaims(request, rows) {
  const lines = [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)];
  return rows.flatMap(c => {
    const parts = U.splitUnits(c.sentence).filter(u => !u.heading);
    const found = lines.find(m => norm(m[2]).includes(norm(c.sentence))) || parts.map(u =>
      lines.find(m => !/^#{1,6}\s/.test(m[2]) && norm(m[2]).includes(norm(u.text)))).find(Boolean);
    return found ? [{ s: Number(found[1]), type: c.type, subject: c.subject, claim: c.claim }] : [];
  });
}
async function realData() {
  for (const pr of [642, 643, 644]) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, `pr${pr}.json`), 'utf8'));
    const article = matter(fs.readFileSync(path.join(fixtures, fixture.article_file), 'utf8'));
    // 保存本文は照合後の文を含む。修正前claimsの欠けた文を一般則で補い、全主張を再生する。
    const absent = fixture.claims.filter(c => !U.splitUnits(article.content).some(u => norm(u.text).includes(norm(c.sentence))));
    const replayBody = article.content + '\n' + [...new Map(absent.map(c => [c.sentence, c])).values()].map(c =>
      `${c.heading ? '## ' + c.heading : ''}\n${c.sentence}`).join('\n');
    const evidenceOptions = F.articleEvidenceOptions(article.data);
    const evidence = Object.fromEntries(fixture.claims.map(c => [c.id, E.searchEvidence(c, evidenceOptions)]));
    const pack = P.buildPages(fixture.claims, evidence);
    for (const id of fixture.known_errors) await test('T2', `#${pr} ${id}`, () => {
      const c = fixture.claims.find(c => c.id === id);
      const candidate = evidence[id].some(e => e.id === c.recorded_evidence_id);
      const page = pack.pages.find(p => p.id === c.recorded_evidence_id);
      const included = Boolean(page && page.ranges.some(([a, b]) => norm(page.source.slice(a, b)).includes(norm(c.recorded_quote))));
      const basis = page && findBasis(page, c.recorded_quote);
      console.log('T2実測:', JSON.stringify({ pr, id, subject: c.subject, candidate, included, page: page?.number, basis: basis || '' }));
      assert.ok(candidate); assert.ok(included); assert.ok(basis);
    });
    await test('T1', `#${pr} 最後まで照合し量とキャッシュを測る`, async () => {
      const calls = [];
      const initialEvidence = {};
      let repairing = false;
      const fake = async request => {
        calls.push(request);
        if (request.task === 'extract') {
          const candidates = repairing ? fixture.claims.filter(c => calls.find(r => r.task === 'repair') &&
            JSON.parse(calls.find(r => r.task === 'repair').user).corrections.some(f => norm(f.sentence).includes(norm(c.sentence)) ||
              U.splitUnits(c.sentence).some(u => norm(f.sentence).includes(norm(u.text))))) : fixture.claims;
          // 数字を残す偽の修正は03m M1で却下されるため、再抽出へ渡された文だけを対象にする。
          const changedUnits = U.splitUnits(H.bodyText(request.user)).filter(u => !u.heading);
          const targets = repairing ? candidates.filter(c => changedUnits.some(u => norm(u.text).includes(norm(c.sentence)) ||
            U.splitUnits(c.sentence).some(part => norm(u.text).includes(norm(part.text))))) : candidates;
          const numbered = numberedClaims(request, targets);
          assert.equal(numbered.length, targets.length, '全ての対象主張に対応する番号がある');
          return numbered;
        }
        if (request.task === 'repair') { repairing = true; return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: c.sentence + '（修正）' })); }
        const pages = H.materials(request), payload = JSON.parse(request.user);
        return payload.claims.map(c => {
          const recorded = fixture.claims.find(f => f.type === c.type && f.subject === c.subject && f.claim === c.claim);
          const original = recorded && E.evidenceCatalog().entries.find(e => e.id === recorded.recorded_evidence_id);
          const page = original && pages.find(p => p.url === original.url && p.title === original.title);
          // 03jでは数字の根拠は2文まで。表せない記録の引用は資料なしとして返す。
          const maxUnits = ['金額', '期限', '割合', '適用年', '番号'].includes(c.type) ? 2 : 4;
          const basis = page && H.basisFor(page, recorded.recorded_quote, maxUnits);
          return { id: c.id, status: basis ? recorded.recorded_status : '資料なし', evidence_id: page?.number || 0, basis: basis || '', correct: recorded?.recorded_correct || '' };
        });
      };
      const result = await F.checkFacts(replayBody, opts({ ...evidenceOptions, callLLM: fake, searchEvidence: (c, options) => {
        const refs = E.searchEvidence(c, options);
        if (!repairing) initialEvidence[c.id] = refs;
        return refs;
      } }));
      const initialPacks = P.pageGroups(result.record.claims, initialEvidence).map(g => g.pack);
      const initialPack = initialPacks[0];
      const byTask = {};
      for (const c of result.record.calls) { byTask[c.task] ||= { calls: 0, input: 0, output: 0 }; byTask[c.task].calls++; byTask[c.task].input += c.input_chars; byTask[c.task].output += c.output_chars; }
      const old = {};
      let repaired = false;
      for (const c of fixture.recorded_calls) { const task = repaired && ['extract', 'judge'].includes(c.task) ? `recheck_${c.task}` : c.task; old[task] = (old[task] || 0) + c.input_chars; if (c.task === 'repair') repaired = true; }
      const initial = result.record.calls.filter(c => !c.task.startsWith('recheck_')).reduce((sum, c) => sum + c.input_chars, 0);
      const materialByKind = Object.fromEntries(['国税庁のページ', '法令', '通達'].map(kind => [kind, { pages: 0, chars: 0 }]));
      for (const page of initialPack.pages) {
        const kind = page.ref.kind === 'law' ? '法令' : page.ref.kind === 'tsutatsu' ? '通達' : '国税庁のページ';
        materialByKind[kind].pages++; materialByKind[kind].chars += page.ref.text.length;
      }
      console.log('T1実測:', JSON.stringify({ pr, old, old_total: fixture.recorded_input_chars_total, current: byTask, initial,
        total: result.record.input_chars_total, output_total: result.record.output_chars_total, block_chars: initialPack.block.length,
        material_chars: initialPack.pages.reduce((sum, p) => sum + p.ref.text.length, 0), pages: initialPack.pages.length, material_by_kind: materialByKind,
        rejected_numeric_corrections: result.record.corrections.filter(c => c.reason === '資料の無い数字が残っています').map(c =>
          fixture.claims.find(f => f.type === c.type && f.subject === c.subject && f.claim === c.claim)?.id || c.id),
        supplemented_sentences: new Set(absent.map(c => c.sentence)).size, status: result.record.status }));
      assert.notEqual(result.record.status, 'not_run');
      for (const correction of result.record.corrections.filter(c => c.reason === '資料の無い数字が残っています')) {
        assert.equal(correction.resolved, false); assert.ok(result.body.includes(correction.before));
      }
      assert.ok(calls.some(c => c.task === 'repair'));
      const first = calls.find(c => c.task === 'judge');
      const last = calls.filter(c => c.task === 'judge').at(-1);
      assert.notEqual(first, last); assert.equal(first.staticSystem, last.staticSystem);
      // 固定部分を独立に組み立て、資料の増減によらず二重送信を検出する。
      const instruction = `主張を添付した原文だけで照合してください。evidence の中の、各主張の evidence_ids の資料だけを根拠にしてください。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,evidence_id,basis,correct}] の形のJSON配列だけです（correct は食い違い・期限の書き漏れのときだけ、資料なしでは evidence_id・basis も書かない）。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは basis に根拠の文の番号（連続4つまで）を書き（金額・期限・割合・適用年・番号の主張は連続2つまで）、evidence_id にその資料の番号を書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに番号付きの本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。その主張の数字・期間そのものが、原文で適用時期によって段階的に変わるのに、番号付きの本文のどこにも段階や対象の時期が書かれていない場合に限り、食い違いとし、correct に段階を書いてください。特定の年分の値として正しく書いている場合は裏付けありとしてください。数字の根拠が同じ資料の離れた2か所にあるときに限り、basis に範囲を2つまで "12-13,30" の形で書いてください。`;
      const example = '\n例: [{"id":"c1","status":"裏付けあり","evidence_id":3,"basis":"12-13"}]';
      const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      // 記録側のtaskで再照合を除き、初回判定の分割・再試行もすべて確かめる。
      const initialJudges = calls.filter((c, i) => result.record.calls[i].task === 'judge');
      assert.ok(initialJudges.length > 0);
      for (const request of initialJudges) {
        assert.ok(initialPacks.some(p => request.staticSystem === instruction + example + '\n\n' + p.block), '固定部分は指示文・例・資料表と完全に一致する');
        assert.equal(request.system, request.staticSystem);
        const payload = JSON.parse(request.user);
        assert.equal(payload.evidence, undefined);
        const variable = norm(strings([request.dynamicSystem || '', payload]).join('\n'));
        for (const page of initialPacks.flatMap(p => p.pages)) {
          const numberedBody = page.block.slice(page.block.indexOf('\n') + 1);
          assert.ok(!variable.includes(norm(page.ref.text)), `資料 ${page.number} の本文を可変部分に重複して送らない`);
          assert.ok(!variable.includes(norm(numberedBody)), `資料 ${page.number} の番号付き本文を可変部分に重複して送らない`);
          for (const [a, b] of page.ranges) {
            const original = norm(page.source.slice(a, b));
            if (original.length < 40) continue;
            assert.ok(!variable.includes(original), `資料 ${page.number} の範囲 ${a}-${b} を可変部分に重複して送らない`);
          }
        }
      }
      assert.ok(initial <= ({ 642: 100000, 643: 45000, 644: 140000 })[pr], `入力 ${initial} 字`);
    });
  }
}
async function main() {
  await realData();
  await test('T3', '括弧・見出し・原文位置・300字・範囲の復元', () => {
    const body = '## 見出し。\n外（内。さらに「内。」）外。次。\n\n最後（注）。';
    const rows = U.splitUnits(body);
    assert.equal(rows.length, 4); assert.ok(rows[0].heading); assert.equal(rows[1].text, '外（内。さらに「内。」）外。');
    assert.ok(rows.every(u => body.slice(u.start, u.end) === u.text));
    const source = '字'.repeat(280) + '、' + '続'.repeat(290) + '（中。注）' + '字'.repeat(100) + '。';
    const units = U.splitUnits(source, { material: true });
    assert.ok(units.every(u => u.text.length <= 300)); assert.equal(U.rangeText(source, units, `1-${units.length}`).text, source);
    assert.equal(units[0].text.length, 281); assert.equal(U.rangeText(source, units, '0'), null); assert.equal(U.rangeText(source, units, '2-1'), null);
    assert.equal(U.splitUnits('外（注\n中。続き）外。次。').length, 3);
    for (const [open, close] of [['(', ')'], ['「', '」'], ['『', '』'], ['【', '】']]) assert.equal(U.splitUnits(`外${open}中。注${close}外。次。`).length, 2);
  });
  await test('T4', '番号を原文・見出しへ戻す、数字と語のずれ・捨てる主張', async () => {
    const body = '## 制度\n案内。\n制度の控除は100万円です。\n別の案内。\n制度の条件を確認します。';
    const r = await F.extractClaims(body, async () => [
      { s: 2, type: '金額', subject: '制度', claim: '控除は100万円' },
      { s: 2, type: '金額', subject: '制度', claim: '控除は200万円' },
      { s: 4, type: '要件', subject: '制度', claim: '条件を確認' },
      { s: 2, type: '要件', subject: 'zzzz', claim: 'zzzz' },
      { s: 1, type: '要件', subject: '制度', claim: '制度' },
    ]);
    assert.equal(r.claims.length, 2); assert.equal(r.discarded, 3); assert.equal(r.claims[0].s, 3); assert.equal(r.claims[0].heading, '制度'); assert.equal(r.claims[1].s, 5);
    const ambiguous = await F.extractClaims('案内。制度100万円。制度100万円。', async () => [{ s: 1, type: '金額', subject: '制度', claim: '100万円' }]);
    assert.equal(ambiguous.discarded, 1);
  });
  await test('T4', 'E3は見出しで一段だけ再抽出し番号を維持', async () => {
    let calls = 0; const numbers = [];
    const result = await F.extractClaims('## 前\n制度100万円。\n## 後\n制度200万円。', async req => {
      assert.equal(req.maxTokens, 8000); calls++; if (calls === 1) return '[';
      const s = req.user.includes('100万円') ? 2 : 4; numbers.push(s); return [{ s, type: '金額', subject: '制度', claim: req.user.includes('100万円') ? '100万円' : '200万円' }];
    });
    assert.equal(calls, 3); assert.deepEqual(numbers, [2, 4]); assert.equal(result.claims.length, 2);
  });
  await test('T5', '本文とページは1回、番号の引用・候補外・範囲外・短い引用', async () => {
    const sentence = '制度の条件を満たす必要があります。', claims = [claim(sentence), claim(sentence, { id: 'c2', subject: '別制度' })];
    const text = '対象です。\n' + sentence, refs = { c1: [ref(text)], c2: [ref('別の資料の説明文がここにあります。', 'e2')] };
    const rows = await F.judgeClaims(claims, refs, sentence, async req => {
      assert.equal(req.maxTokens, 16000); assert.equal((req.system.match(/\[資料 1\]/g) || []).length, 1);
      const p = JSON.parse(req.user); assert.equal(p.evidence, undefined); assert.equal(p.body, '[1] ' + sentence); assert.equal(p.claims[0].sentence, undefined);
      return p.claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '2', correct: '' }));
    }, opts());
    assert.equal(rows[0].status, '裏付けあり'); assert.equal(rows[0].quote, sentence); assert.equal(rows[1].status, '資料なし');
    // 数値の 2・連続した「1,2」は有効な番号として受け付ける（番号の形の揺れの試験を参照）。飛んだ番号は不正。
    for (const basis of ['0', '999', '2-6', '2-1', 0, '1,3']) {
      const r = await F.judgeClaims([claims[0]], { c1: refs.c1 }, sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis }], opts());
      assert.equal(r[0].status, '資料なし');
    }
    const r = await F.judgeClaims([claims[0]], { c1: [ref('断片')] }, sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], opts());
    assert.equal(r[0].status, '資料なし');
  });
  await test('T5', '数字は引用の前後300字だけ、H1と不正な割合も維持', async () => {
    const sentence = '控除は100万円です。', c = claim(sentence, { type: '金額' });
    for (const [text, expected] of [['制度の説明をここで確認できます。\n' + '離'.repeat(301) + '\n100万円です。', '資料なし'],
      ['制度の説明をここで確認できます。\n100万円です。', '裏付けあり'], ['制度の説明をここで確認できます。100万円、0分の1。', '資料なし']]) {
      const r = await F.judgeClaims([c], { c1: [ref(text)] }, sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], opts()); assert.equal(r[0].status, expected);
    }
    const r = await F.judgeClaims([{ ...c, claim: '200万円です。' }], { c1: [ref('控除は200万円です。')] }, sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], opts()); assert.equal(r[0].status, '資料なし');
  });
  await test('T5', '100000字を超える場合だけ制度単位で分ける', () => {
    const claims = Array.from({ length: 22 }, (_, i) => claim(`制度${i}の条件です。`, { id: `c${i}`, subject: `制度${i}` }));
    const evidence = Object.fromEntries(claims.map((c, i) => [c.id, [ref('字'.repeat(5000), `e${i}`)]]));
    const options = { loadEvidenceText: r => r.text };
    assert.equal(P.pageGroups(claims.slice(0, 10), evidence, options).length, 1);
    const groups = P.pageGroups(claims, evidence, options); assert.ok(groups.length > 1); assert.ok(groups.every(g => g.pack.block.length <= 100000));
  });
  await test('T5', '長い原文の抜粋を位置で統合、離れた範囲はまたがない、TA末尾を除く', () => {
    const source = '字'.repeat(8000), claims = [claim('制度の条件です。'), claim('別制度の条件です。', { id: 'c2' })];
    const evidence = { c1: [ref(source.slice(100, 2100))], c2: [{ ...ref(source.slice(1600, 3600)), text_start: 1600 }] };
    evidence.c1[0].text_start = 100;
    const merged = P.buildPages(claims, evidence, { loadEvidenceText: () => source });
    assert.deepEqual(merged.pages[0].ranges, [[100, 3600]]);
    evidence.c2[0].text_start = 5000;
    const separated = P.buildPages(claims, evidence, { loadEvidenceText: () => source });
    assert.deepEqual(separated.pages[0].ranges, [[100, 2100], [5000, 7000]]);
    const units = separated.pages[0].units, boundary = units.find(u => u.segment === 1).s;
    assert.equal(U.rangeText(source, units, `${boundary - 1}-${boundary}`), null); assert.match(separated.block, /……/);
    const ta = P.buildPages([claims[0]], { c1: [{ ...ref('説明です。関連リンク以下。'), kind: 'taxanswer' }] }, { loadEvidenceText: r => r.text });
    assert.equal(ta.pages[0].ref.text, '説明です。');
    assert.equal(P.buildPages(claims, evidence, { loadEvidenceText: () => source }).block, separated.block);
    const many = Array.from({ length: 7 }, (_, i) => claim(`制度${i}の条件です。`, { id: `c${i}` }));
    const large = '原'.repeat(18000), manyRefs = Object.fromEntries(many.map((c, i) => [c.id,
      [{ ...ref(large.slice(i * 2200, i * 2200 + 2000)), text_start: i * 2200 }]]));
    // 長いページは字数で削らず、全主張の抜粋を含める（照合も止めない）。
    const kept = P.buildPages(many, manyRefs, { loadEvidenceText: () => large });
    assert.equal(kept.pages[0].ranges.length, 7);
    assert.ok(kept.pages[0].ranges.reduce((n, [a, b]) => n + b - a, 0) > 12000);
    assert.ok(many.every((c, i) => kept.pages[0].ranges.some(([a, b]) => a <= i * 2200 && b >= i * 2200 + 2000)));
  });
  await test('T5', '出力の切断は半分ずつ一段だけ再判定、再失敗はfail-closed', async () => {
    const claims = [claim('制度の条件です。'), claim('別制度の条件です。', { id: 'c2', subject: '別制度' })];
    const evidence = Object.fromEntries(claims.map(c => [c.id, [ref('制度の条件を満たしている必要があります。')]]));
    for (const stop of ['json', 'max_tokens']) {
      let calls = 0;
      const result = await F.judgeClaims(claims, evidence, claims.map(c => c.sentence).join('\n'), async req => {
        calls++; if (calls === 1) return stop === 'json' ? '[' : { text: '[]', stopReason: 'max_tokens' };
        return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '1' }));
      }, opts()); assert.equal(calls, 3); assert.equal(result.length, 2);
    }
    let calls = 0;
    await assert.rejects(F.judgeClaims(claims, evidence, '', async () => { calls++; return '['; }, opts()), SyntaxError); assert.equal(calls, 3);
  });
  await test('T6', '固定部分の完全一致、不足ページを続きの番号で可変部分へ追加', async () => {
    const sentence = '制度の条件を満たす必要があります。', c = claim(sentence), cache = {}, calls = [];
    const fake = async req => { calls.push(req); return [{ id: 'c1', status: '裏付けあり', evidence_id: calls.length === 1 ? 1 : 2, basis: '1' }]; };
    await F.judgeClaims([c], { c1: [ref(sentence)] }, sentence, fake, opts({ pageCache: cache }));
    const r = await F.judgeClaims([c], { c1: [ref(sentence, 'e2')] }, sentence, fake, opts({ pageCache: cache }));
    assert.equal(calls[0].staticSystem, calls[1].staticSystem); assert.match(JSON.parse(calls[1].user).evidence, /\[資料 2\]/); assert.equal(r[0].evidence_id, 'e2');
  });
  await test('T6', '抽出はキャッシュなし、既存の空system除外・モデル設定を通す', async () => {
    const model = require('../content-model'), saved = model.generateContent, calls = [];
    const sentence = '制度の条件を確認します。';
    model.generateContent = async (prompt, options) => {
      calls.push({ prompt, options });
      if (calls.length === 1) return { text: JSON.stringify([{ s: 1, type: '要件', subject: '制度', claim: sentence }]) };
      return { text: JSON.stringify([{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1', correct: '' }]) };
    };
    try {
      const r = await F.checkFacts(sentence, opts({ repair: false, searchEvidence: () => [ref(sentence)] }));
      assert.equal(r.record.status, 'ok'); assert.equal(calls[0].prompt.staticSystem, ''); assert.ok(calls[0].prompt.dynamicSystem);
      const wire = require('../article-prompt-builder').toAnthropicRequest(calls[0].prompt, { model: 'claude-opus-5-5', maxTokens: 8000, useCache: true });
      assert.equal(wire.system.length, 1); assert.equal(wire.system[0].cache_control, undefined);
      assert.match(calls[1].prompt.staticSystem, /\[資料 1\]/); assert.equal(calls[1].options.fallback, false); assert.equal(calls[1].options.model, 'claude-opus-5-5');
    } finally { model.generateContent = saved; }
  });
  await test('T6', '同じページの新しい抜粋が固定部分に無ければ、削らず止めずに資料を作り直して判定する', async () => {
    const source = '甲'.repeat(3500) + '乙'.repeat(3500), sentence = '制度の条件を確認します。', c = claim(sentence), cache = {}, calls = [];
    const options = opts({ pageCache: cache, loadEvidenceText: () => source });
    const fake = async req => { calls.push(req); return []; };
    await F.judgeClaims([c], { c1: [{ ...ref(source.slice(0, 2000)), text_start: 0 }] }, sentence, fake, options);
    const r = await F.judgeClaims([c], { c1: [{ ...ref(source.slice(4000, 6000)), text_start: 4000 }] }, sentence, fake, options);
    assert.equal(calls.length, 2); assert.equal(r.length, 1);
    assert.notEqual(calls[1].staticSystem, calls[0].staticSystem);
    assert.ok(!calls[0].staticSystem.includes('乙') && calls[1].staticSystem.includes('乙'));
  });
  await test('T5', '番号は数値・全角・括弧・「〜」の形でも受け付ける', async () => {
    const source = '一つ目の文です。二つ目の文です。三つ目の文です。', units = U.splitUnits(source, { material: true });
    assert.equal(U.rangeText(source, units, 2).text, '二つ目の文です。');
    assert.equal(U.rangeText(source, units, '［１］').text, '一つ目の文です。');
    for (const basis of ['1〜2', '1～2', '1–2', '[1]-[2]']) assert.equal(U.rangeText(source, units, basis).text, '一つ目の文です。二つ目の文です。');
    assert.equal(U.rangeText(source, units, '0'), null); assert.equal(U.rangeText(source, units, '2-1'), null);
    const sentence = '制度の条件を満たす必要があります。';
    const extracted = await F.extractClaims(`## 見出し\n${sentence}`, async () => [{ s: '2', type: '要件', subject: '制度', claim: sentence }], opts());
    assert.equal(extracted.claims.length, 1); assert.equal(extracted.claims[0].sentence, sentence); assert.equal(extracted.claims[0].heading, '見出し');
    const judged = await F.judgeClaims([claim(sentence)], { c1: [ref(sentence)] }, sentence,
      async () => [{ id: 'c1', status: '裏付けあり', evidence_id: '1', basis: 1 }], opts());
    assert.equal(judged[0].status, '裏付けあり'); assert.equal(judged[0].quote, sentence);
    assert.equal(U.rangeText(source, units, [1, 2]).text, '一つ目の文です。二つ目の文です。');
    assert.equal(U.rangeText(source, units, '1、2').text, '一つ目の文です。二つ目の文です。');
    assert.equal(U.rangeText(source, units, [1, 3]), null);
    for (const row of [{ evidence_id: '資料 1', correct: null }, { evidence_id: '[資料1]' }, { evidence_id: 1, basis: [1], correct: null }]) {
      const r = await F.judgeClaims([claim(sentence)], { c1: [ref(sentence)] }, sentence,
        async () => [{ id: 'c1', status: '裏付けあり', basis: '1', ...row }], opts());
      assert.equal(r[0].status, '裏付けあり', JSON.stringify(row)); assert.equal(r[0].correct, '');
    }
  });
  await test('T5', '答えの多くが確認を通らないときは照合不能で止め、記事を直さない', async () => {
    const sentences = ['制度甲の条件を満たす必要があります。', '制度乙の条件を満たす必要があります。', '制度丙の条件を満たす必要があります。', '制度丁の条件を満たす必要があります。'];
    const claims = sentences.map((s, i) => claim(s, { id: `c${i + 1}`, subject: `制度${i}` }));
    const refFor = s => ref(s, `e${sentences.indexOf(s) + 1}`);
    const evidence = Object.fromEntries(claims.map(c => [c.id, [refFor(c.sentence)]]));
    const body = sentences.join('\n');
    const rows = basis => req => JSON.parse(req.user).claims.map((c, i) => ({ id: c.id, status: '裏付けあり', evidence_id: c.evidence_ids[0], basis: basis(i) }));
    await assert.rejects(F.judgeClaims(claims, evidence, body, async req => rows(() => '99')(req), opts()), /確認を通りません/);
    await assert.rejects(F.judgeClaims(claims, evidence, body, async () => [], opts()), /確認を通りません/);
    // 1 件だけ落ちる通常の場合は止めず、落とした理由を残す。
    const one = await F.judgeClaims(claims, evidence, body, async req => rows(i => i ? '1' : '99')(req), opts());
    assert.equal(one[0].status, '資料なし'); assert.equal(one[0].reject_reason, '根拠の文の番号が読めない・範囲外'); assert.equal(one[1].status, '裏付けあり');
    const result = await F.checkFacts(body, opts({ searchEvidence: c => [refFor(c.sentence)], callLLM: async req => req.task === 'extract'
      ? sentences.map((s, i) => ({ s: i + 1, type: '要件', subject: `制度${i}`, claim: s }))
      : rows(() => '99')(req) }));
    assert.equal(result.record.status, 'not_run'); assert.equal(result.body, body); assert.match(result.record.error, /確認を通りません/);
  });
  await test('T7', '同じ数字の事実もまとめず、各文を1回の判定に送る', async () => {
    const claims = [claim('制度の控除は100万円です。', { type: '金額' }), claim('控除は百万円です。', { id: 'c2', type: '金額' }),
      claim('制度の要件は100万円です。', { id: 'c3' }), claim('制度の判定は100万円です。', { id: 'c4', type: '判定' }), claim('制度の手続は100万円です。', { id: 'c5', type: '手続' })];
    const rows = await F.judgeClaims(claims, Object.fromEntries(claims.map(c => [c.id, [ref(claims[0].sentence)]])), claims.map(c => c.sentence).join('\n'), async req => {
      assert.equal(JSON.parse(req.user).claims.length, 5); return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '1' }));
    }, opts()); assert.equal(rows.length, 5); assert.equal(rows[1].status, '裏付けあり'); assert.equal(rows[1].sentence, claims[1].sentence);
  });
  await test('T8', '置き換えだけ渡し、同じ文の全出現を直す・採らない条件', async () => {
    const sentence = '控除は100万円です。', body = '## 制度\n' + sentence + '\n案内。\n' + sentence, c = { ...claim(sentence, { type: '金額' }), status: '食い違い', quote: '控除は200万円です。', correct: '200万円' };
    const result = await F.repairBody(body, [c], async req => {
      assert.equal(req.maxTokens, 8000); const p = JSON.parse(req.user); assert.equal(p.body, undefined);
      assert.deepEqual(Object.keys(p.corrections[0]), ['id', 'sentence', 'heading', 'prev', 'next', 'status', 'type', 'correct', 'quote', 'instruction', 'keep']);
      assert.deepEqual(p.corrections[0].keep, []);
      return [{ id: 'c1', replacement: '控除は200万円です。' }];
    }); assert.equal(result.body.split('200万円').length - 1, 2);
    for (const replacement of ['', '改行\n文', '## 見出し', '長'.repeat(201)]) {
      const r = await F.repairBody(body, [c], async () => [{ id: 'c1', replacement }]); assert.equal(r.body, body); assert.ok(r.rejected.has('c1'));
    }
    const duplicate = await F.repairBody(body, [c], async () => [{ id: 'c1', replacement: sentence }, { id: 'c1', replacement: sentence }]); assert.ok(duplicate.rejected.has('c1'));
    const table = '| 控除 | 100万円 |', row = { ...c, sentence: table };
    const r = await F.repairBody(table, [row], async () => [{ id: 'c1', replacement: '| 200万円 |' }]); assert.ok(r.rejected.has('c1'));
    const invalid = await F.repairBody(body, [c], async () => '['); assert.equal(invalid.accepted, false); assert.equal(invalid.body, body);
  });
  await test('T8', '拒否した修正は未解決の記録として承認を止める', async () => {
    const sentence = '控除は100万円です。';
    const r = await F.checkFacts(sentence, opts({ searchEvidence: () => [], callLLM: async req => req.task === 'extract' ? [{ s: 1, type: '金額', subject: '制度', claim: sentence }] : [{ id: 'c1', replacement: '' }] }));
    assert.equal(r.record.status, 'revise'); assert.equal(r.record.corrections[0].resolved, false); assert.ok(r.record.corrections[0].reason);
  });
  await incrementalTests();
  await test('T10', '入出力・usage・taskと150000字超の警告', async () => {
    const sentence = '制度の条件を確認します。', logs = [], saved = console.warn;
    console.warn = message => logs.push(message);
    try {
      const r = await F.checkFacts(sentence, opts({ repair: false, searchEvidence: () => [], callLLM: async () => ({ text: JSON.stringify([{ s: 1, type: '要件', subject: '制度', claim: sentence }]) + ' '.repeat(10), usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } }) }));
      assert.equal(r.record.calls[0].output_chars, r.record.output_chars_total); assert.equal(r.record.calls[0].usage.cache_read_input_tokens, 4); assert.equal(r.record.calls[0].task, 'extract');
      const large = await F.checkFacts('## 制度\n' + '字'.repeat(150001), opts({ callLLM: async () => [] }));
      assert.match(large.record.summary, /照合の入力が多い/); assert.ok(logs.some(l => /照合の入力が多い/.test(l)));
    } finally { console.warn = saved; }
  });
  console.log('03i集計:', JSON.stringify(groups));
  process.exitCode = Object.values(groups).some(g => g.fail) ? 1 : 0;
}
async function incrementalTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-pages-'));
  const raw = body => `---\nslug: pages-test\nrecommendation: publish\n---\n${body}`;
  const before = '## 制度\n制度Aの条件を満たします。\n制度Aの届出を行います。\n制度Bの条件を満たします。';
  const after = before.replace('制度Aの条件を満たします。', '制度Aの条件を確認します。');
  const refs = [ref('制度Aの条件と届出を確認します。制度Bの条件を満たします。')];
  const fake = calls => async req => {
    calls.push(req);
    // 「制度A」「制度B」は語が残らず関係が曖昧になるため、使い回しの試験には区別できる制度名を使う。
    if (req.task === 'extract') return [...req.user.matchAll(/^\[(\d+)\] (制度([AB]).*)$/gm)].map(m => ({ s: Number(m[1]), type: '要件', subject: m[3] === 'B' ? '消費税' : '贈与税', claim: m[2] }));
    return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '1-2' }));
  };
  try {
    const initial = await F.checkArticle(raw(before), opts({ recordDir: dir, repair: false, searchEvidence: () => refs, callLLM: fake([]) }));
    await test('T9', '本文・記録一致の時だけ差分、同じ制度を再判定、他制度は使い回す', async () => {
      const calls = [];
      const r = await F.checkArticle(raw(after), opts({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false, searchEvidence: () => refs, callLLM: fake(calls) }));
      assert.deepEqual(r.record.incremental, { reused: 1, rejudged: 2, subjects: ['贈与税'] });
      assert.equal(r.record.status, 'ok'); assert.equal(r.record.claims.length, 3);
      assert.ok(!calls[0].user.includes('制度B')); assert.equal(JSON.parse(calls.find(c => c.task === 'judge').user).claims.length, 2);
    });
    await test('T9', '記録の不一致・壊れ・モデル変更・not_run・形の不正は全体照合', async () => {
      const saved = fs.readFileSync(initial.recordFile, 'utf8');
      for (const mutate of [r => ({ ...r, body_sha256: 'bad' }), r => ({ ...r, model: 'other' }), r => ({ ...r, status: 'not_run' }),
        r => ({ ...r, claims: [{}] }), r => ({ ...r, evidence: {} }), () => null]) {
        fs.writeFileSync(initial.recordFile, mutate === null ? '[' : JSON.stringify(mutate(JSON.parse(saved))), 'utf8');
        const calls = [];
        const r = await F.checkArticle(raw(after), opts({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false, searchEvidence: () => refs, callLLM: fake(calls) }));
        assert.equal(r.record.incremental, undefined); assert.ok(calls[0].user.includes('制度B'));
      }
      fs.writeFileSync(initial.recordFile, saved, 'utf8');
    });
    await test('T9', '文の削除でも同じ制度を再判定、読めない記録と記録なしは全体照合', async () => {
      const saved = fs.readFileSync(initial.recordFile, 'utf8');
      const deleted = before.replace('制度Aの条件を満たします。\n', '');
      const r = await F.checkArticle(raw(deleted), opts({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false, searchEvidence: () => refs, callLLM: fake([]) }));
      assert.deepEqual(r.record.incremental, { reused: 1, rejudged: 1, subjects: ['贈与税'] });
      for (const missing of [false, true]) {
        if (missing) fs.unlinkSync(initial.recordFile); else fs.writeFileSync(initial.recordFile, '[', 'utf8');
        const calls = [];
        const result = await F.checkArticle(raw(after), opts({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false, searchEvidence: () => refs, callLLM: fake(calls) }));
        assert.equal(result.record.incremental, undefined); assert.ok(calls[0].user.includes('制度B'));
      }
      fs.writeFileSync(initial.recordFile, saved, 'utf8');
    });
    await test('T9', 'finalizeRegenerationから再生成前の原文を渡す', async () => {
      let passed;
      await require('../../generate-draft').finalizeRegeneration(raw(before), raw(after), { scope: 'body' }, {
        persist: false, factCheck: async (content, options) => { passed = options.previousRaw; return { content, record: { status: 'ok', summary: '照合済み' } }; },
      });
      assert.equal(passed, raw(before));
    });
    await test('T9', '使い回した食い違いも状態と承認差し止めへ反映', async () => {
      const prior = JSON.parse(fs.readFileSync(initial.recordFile, 'utf8'));
      prior.status = 'revise'; prior.claims.find(c => c.subject === '消費税').status = '食い違い'; prior.claims.find(c => c.subject === '消費税').correct = '制度Bの条件を確認する';
      fs.writeFileSync(initial.recordFile, JSON.stringify(prior), 'utf8');
      const r = await F.checkArticle(raw(after), opts({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false, searchEvidence: () => refs, callLLM: fake([]) }));
      assert.equal(r.record.status, 'revise'); assert.equal(matter(r.content).data.fact_check_blocking, true); assert.equal(matter(r.content).data.recommendation, 'revise');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
