'use strict';

// 03k の差分レビュー（review-03k.md）の残りと、実 AI での確認を受けた修正の回帰確認。LLM は偽の関数。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../fact-check');
const groups = Object.fromEntries(['L1', 'L2', 'L3', 'L4'].map(key => [key, { pass: 0, fail: 0 }]));
const now = new Date('2026-10-15T00:00:00Z');
const ref = (text, extra = {}) => ({ id: 'e1', title: '制度の原文', text, url: 'https://example.jp/source', law_version: '', ...extra });
const options = extra => ({ now, enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', loadEvidenceText: r => r.text, ...extra });
async function test(group, name, fn) {
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
function unitsOf(req) { return [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ s: Number(m[1]), text: m[2] })); }

async function main() {
  await test('L1', '同じ制度の2件目の期限の書き漏れは自動で直さず、止めて人が確かめる（正しい数字を消さない）', async () => {
    const body = '控除は100万円です。\n上限は200万円です。';
    const source = '控除は100万円です。上限は200万円です。適用期限は令和9年3月31日までです。';
    const repairs = [];
    const result = await F.checkFacts(body, options({
      searchEvidence: () => [ref(source)],
      callLLM: async req => {
        if (req.task === 'extract') return unitsOf(req).map(u => ({ s: u.s, type: '金額', subject: '制度A', claim: u.text }));
        if (req.task === 'repair') {
          const { corrections } = JSON.parse(req.user);
          repairs.push(...corrections.map(c => c.id));
          return corrections.map(c => ({ id: c.id, replacement: `${c.sentence.replace(/。$/, '')}（令和9年3月31日まで）。` }));
        }
        return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '期限の書き漏れ', evidence_id: 1, basis: '3', correct: '令和9年3月31日まで' }));
      },
    }));
    const second = result.record.claims.find(c => c.sentence === '上限は200万円です。');
    assert.equal(second.status, '資料なし');
    assert.equal(second.reject_reason, '同じ制度の期限の書き漏れは記録済み');
    assert.ok(!repairs.includes(second.id), '2 件目は修正に回さない');
    assert.ok(result.body.includes('上限は200万円です。'), '正しい数字を案内文に置き換えない');
    assert.ok(result.record.remaining.some(c => c.sentence === '上限は200万円です。'), '止める側に残す');
    assert.equal(result.record.status, 'revise');
  });

  await test('L2', '入れ子の見出しで名前が同じ節へ文を移した差し戻しは判定し直す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03k-l2-'));
    const raw = text => `---\nslug: review-fixes-6\nrecommendation: publish\n---\n${text}`;
    const moved = '基礎控除は48万円です。', other = '控除の説明の文です。';
    const before = `## 令和6年分\n### 基礎控除\n${moved}\n## 令和7年分\n### 基礎控除\n${other}`;
    const after = `## 令和6年分\n### 基礎控除\n${other}\n## 令和7年分\n### 基礎控除\n${moved}`;
    const llm = calls => async req => {
      calls.push(req.task);
      if (req.task === 'extract') return unitsOf(req).filter(u => u.text === moved).map(u => ({ s: u.s, type: '金額', subject: '基礎控除', claim: moved }));
      return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '1', correct: '' }));
    };
    try {
      const first = [];
      const initial = await F.checkArticle(raw(before), options({ recordDir: dir, repair: false, searchEvidence: () => [ref(moved)], callLLM: llm(first) }));
      assert.equal(initial.record.status, 'ok');
      const calls = [];
      const result = await F.checkArticle(raw(after), options({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false,
        searchEvidence: () => [ref(moved)], callLLM: llm(calls) }));
      assert.ok(result.record.incremental, '差分照合の経路を通る');
      assert.ok(result.record.incremental.rejudged >= 1, '移した文の主張を判定し直す');
      assert.ok(calls.includes('judge'), '判定を呼ぶ');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('L3', '同じ文・種類・制度名でも要約の数字が違う主張は両方残して照合する', async () => {
    const sentence = '基礎控除は48万円で、合計所得2,400万円以下が対象です。';
    const extracted = await F.extractClaims(sentence, async () => [
      { s: 1, type: '金額', subject: '基礎控除', claim: '基礎控除は48万円' },
      { s: 1, type: '金額', subject: '基礎控除', claim: '合計所得2,400万円以下が対象' },
      { s: 1, type: '金額', subject: '基礎控除', claim: '基礎控除は48万円' },
    ], options());
    assert.equal(extracted.claims.length, 2, '数字の違う 2 件は残し、まったく同じ 3 件目だけ除く');
    assert.deepEqual(extracted.claims.map(c => c.claim), ['基礎控除は48万円', '合計所得2,400万円以下が対象']);
  });

  await test('L4', '判定の指示文に経過措置の規則がある（実 AI の #644 の見逃しへの対策）', async () => {
    const sentence = '亡くなる直前の7年分は相続税の計算に影響します。';
    let system = '';
    await F.judgeClaims([{ id: 'c1', sentence, heading: '', type: '判定', subject: '生前贈与加算', claim: sentence }],
      { c1: [ref('令和8年12月31日までの相続開始は3年以内、令和13年1月1日以後は7年以内です。')] }, sentence,
      async req => { system = req.system; return [{ id: 'c1', status: '資料なし', evidence_id: null, basis: [], correct: '' }]; }, options());
    assert.match(system, /経過措置/);
    assert.match(system, /段階を書かずに最終の数字や期間だけを述べている場合は食い違い/);
  });

  console.log(`03k残り集計: ${JSON.stringify(groups)}`);
  if (Object.values(groups).some(g => g.fail)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
