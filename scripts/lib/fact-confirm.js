'use strict';

// 確かめ専用の資料表。全体検索のカタログや、通常の判定の資料表は変更しない。
const { splitUnits, renderUnits, basisRanges } = require('./fact-units');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { searchEvidence, loadEvidenceText } = require('./fact-evidence');
const { searchWriterEvidence, resolveMaterial, materialId } = require('./writer-materials');
const qa = require('./nta-qa');
const { redactSecrets } = require('./content-model');

const CONFIRM_SYSTEM = '記事を書き換える前の事実確認です。各指摘を1件ずつ独立に、添付した資料だけで確かめてください。GLMの答えは参考であり、正しいとは限りません。記事の見出し・前後の文から役割を読み、よくある誤解・NG例の文は「その考えは誤り」という意味で判断してください。「注意点」の節は誤りの例とは限りません。兄弟の制度・対象者・時期を取り違えないでください。正しい文を別の一般論に置き換えないでください。資料の番号と文の番号はこの資料表で引き直してください。誤りならreplacementに元の文の位置に入る修正文を1件だけ書き、誤り以外の内容・話題・文の役割を残してください。期限の書き漏れは期限を足し、資料なしで具体を外す場合は裏付けのある内容を残してください。表の行は列数を変えず、改行・見出しを入れないでください。誤り・正しいには必ずevidence_idとbasisを付けてください。資料で判断できなければ判断できないとしてください。出力は各指摘について [{"id":"c1","verdict":"誤り|正しい|判断できない","evidence_id":1,"basis":"12-13","replacement":"誤りのときだけ","reason":"短い理由"}] のJSON配列だけです。';

function candidatesFor(finding, options) {
  const own = (options.searchWriterEvidence || searchWriterEvidence)(finding, options).slice(0, 4);
  const root = finding.glm_answer?.evidence || finding.evidence_id || finding.rejected_answer?.evidence;
  const ref = (finding.evidence || []).find(e => e.id === root) || options.resolvedWriterMaterials?.find(e => e.id === root)
    || (root && resolveMaterial(materialId({ id: root, url: root })));
  const refs = [...own, ...(ref ? [ref] : [])];
  if (finding.status === '資料なし') {
    refs.push(...(options.searchEvidence || searchEvidence)(finding, options).slice(0, 3));
    const words = [...tokenizeForMatcher(`${finding.subject} ${finding.claim} ${finding.sentence}`)].filter(word => word.length >= 4 && word.length <= 16);
    const questions = (options.findQaByKeywords || qa.findQaByKeywords)(words, { maxDocs: 2, scopeText: `${finding.subject} ${finding.sentence}` });
    for (const question of questions.slice(0, 2)) {
      const resolved = resolveMaterial(materialId(question));
      if (resolved) refs.push(resolved);
    }
  }
  return [...new Map(refs.filter(e => e.kind !== 'change').map(e => [e.id, e])).values()];
}

function pageFor(ref, finding, options) {
  let source = (options.loadEvidenceText || (e => e.kind === 'qa' ? resolveMaterial(materialId(e))?.text : loadEvidenceText(e)))(ref);
  if (typeof source !== 'string' || !source.trim()) throw new Error('確かめの資料を読めませんでした');
  if (ref.kind === 'taxanswer') source = source.split('関連リンク')[0];
  const units = splitUnits(source, { material: true });
  const words = [...tokenizeForMatcher(`${finding.subject} ${finding.claim}`)];
  const root = finding.glm_answer?.evidence || finding.evidence_id;
  const ranges = root === ref.id ? basisRanges(finding.glm_answer?.basis) || [] : [];
  const quoteAt = root === ref.id && finding.quote ? source.indexOf(finding.quote.split('\n…\n')[0]) : -1;
  const scores = units.map((u, i) => ({ i, score: words.filter(word => u.text.normalize('NFKC').toLowerCase().includes(word)).length +
    (quoteAt >= u.start && quoteAt < u.end ? 100 : ranges.some(range => { const [a,b] = range.split('-').map(Number); return u.s >= a && u.s <= b; }) ? 30 : 0) }));
  const header = `[資料 100] ${ref.title || ''} / ${ref.url || ''} / ${ref.law_version || ''}\n`;
  const chosen = new Map(); let length = header.length;
  for (const { i } of scores.sort((a,b) => b.score - a.score || a.i - b.i)) for (const at of [i, i-1, i+1]) {
    const u = units[at]; if (!u || chosen.has(u.s)) continue;
    const cost = renderUnits([u]).length + 6;
    if (length + cost > 2990) continue;
    chosen.set(u.s, u); length += cost;
  }
  if (!chosen.size) throw new Error('確かめの資料が上限を超えました');
  return { id: ref.id, source, ref: { ...ref, text: source, text_ranges: undefined, text_start: undefined }, units: [...chosen.values()] };
}

function packItems(items) {
  const merged = new Map();
  for (const item of items) for (const page of item.pages) {
    if (!merged.has(page.id)) merged.set(page.id, { ...page, units: new Map() });
    const own = merged.get(page.id);
    for (const unit of page.units) own.units.set(unit.s, unit);
  }
  const pages = [...merged.values()].map((page, i) => {
    const units = [...page.units.values()].sort((a,b) => a.s-b.s); let segment = 0;
    const numbered = units.map((u,j) => { if (j && u.s !== units[j-1].s+1) segment++; return { ...u, segment }; });
    return { ...page, number: i+1, units: numbered,
      block: `[資料 ${i+1}] ${page.ref.title || ''} / ${page.ref.url || ''} / ${page.ref.law_version || ''}\n` +
        numbered.map((u,j) => (j && u.segment !== numbered[j-1].segment ? '……\n' : '') + renderUnits([u])).join('\n') };
  });
  const block = pages.map(page => page.block).join('\n\n');
  return pages.some(page => page.block.length > 3000) || block.length > 30000 ? null : { pages, block };
}

/** 1回8指摘・資料30000字・最大6回。失敗や上限はその指摘だけ判断できないにする。 */
async function confirmFindings(body, findings, call, options, validate, context) {
  const results = new Map(), pending = [];
  const unknown = (id, reason) => results.set(id, { verdict: '判断できない', reason });
  for (const finding of findings) {
    try {
      const pages = candidatesFor(finding, options).flatMap(ref => { try { return [pageFor(ref, finding, options)]; } catch (_) { return []; } });
      if (!pages.length || !packItems([{ pages }])) { unknown(finding.id, '確かめの資料を用意できませんでした'); continue; }
      pending.push({ finding, pages });
    } catch (_) { unknown(finding.id, '確かめの資料を用意できませんでした'); }
  }
  let calls = 0;
  while (pending.length && calls < 6) {
    const items = [pending.shift()]; let pack = packItems(items);
    while (items.length < 8) {
      const ids = new Set(pack.pages.map(p => p.id));
      const ranked = pending.map((item,index) => ({ item,index,overlap:item.pages.filter(p=>ids.has(p.id)).length })).sort((a,b)=>b.overlap-a.overlap || a.index-b.index);
      const next = ranked.find(row => row.overlap && packItems([...items,row.item]));
      if (!next) break;
      items.push(pending.splice(next.index,1)[0]); pack = packItems(items);
    }
    calls++;
    try {
      const ret = await call({ task:'confirm', immediate:true, maxTokens:8000, system:CONFIRM_SYSTEM+'\n\n'+pack.block,
        user:JSON.stringify({ claims:items.map(({finding:f,pages})=>({id:f.id,type:f.type,subject:f.subject,sentence:f.sentence,
          ...context(body,f.sentence),finding:f.condition_mismatch?'条件の不一致':f.status,
          glm_answer:f.glm_answer || {status:f.status,evidence:f.evidence_id,basis:'',correct:f.correct},
          evidence_ids:pack.pages.filter(p=>pages.some(e=>e.id===p.id)).map(p=>p.number)})) }) });
      if (['max_tokens','length'].includes(ret?.stopReason) || ret?.stop_reason === 'max_tokens') throw new Error('確かめの出力が上限に達しました');
      let rows = Array.isArray(ret) || ret?.verdict ? ret : JSON.parse(String(typeof ret === 'string' ? ret : ret?.text || '').replace(/^```(?:json)?\s*|\s*```$/g,'').trim());
      if (!Array.isArray(rows)) rows = [rows];
      for (const {finding,pages} of items) {
        const own = rows.filter(row=>row?.id===finding.id);
        if (own.length !== 1 || !['誤り','正しい','判断できない'].includes(own[0].verdict)) { unknown(finding.id,'確かめの答えの形が不正です'); continue; }
        const row = own[0];
        if (row.verdict === '判断できない') { unknown(finding.id,redactSecrets(String(row.reason || '')).slice(0,300)); continue; }
        if (typeof row.replacement === 'string' && redactSecrets(row.replacement) !== row.replacement) { unknown(finding.id,'確かめの答えを採れませんでした'); continue; }
        let result;
        try { result = await validate(finding, row, pack.pages.filter(page=>pages.some(p=>p.id===page.id))); }
        catch (_) { /* 他の指摘の答えは維持し、この指摘だけ不採用にする。 */ }
        results.set(finding.id, result || {verdict:'判断できない',reason:'確かめの引用・数字・修正文を採れませんでした'});
      }
    } catch (_) { for (const {finding} of items) unknown(finding.id,'確かめを実施できませんでした'); }
  }
  for (const {finding} of pending) unknown(finding.id,'確かめの呼び出しの上限を超えました');
  return results;
}

module.exports = { confirmFindings };
