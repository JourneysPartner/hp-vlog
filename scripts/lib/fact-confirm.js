'use strict';

// 確かめ専用の資料表。全体検索のカタログや、通常の判定の資料表は変更しない。
const { splitUnits, renderUnits, basisRanges, unitNumber } = require('./fact-units');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { searchEvidence, loadEvidenceText, evidenceCatalog } = require('./fact-evidence');
const { searchWriterEvidence, resolveMaterial, materialId, qaCatalog } = require('./writer-materials');
const laws = require('./law-sources');
const qa = require('./nta-qa');
const { redactSecrets } = require('./content-model');

const CONFIRM_SYSTEM = '記事を書き換える前の事実確認です。各指摘を1件ずつ独立に、添付した資料だけで確かめてください。GLMの答えは参考であり、正しいとは限りません。記事の見出し・前後の文から役割を読み、よくある誤解・NG例の文は「その考えは誤り」という意味で判断してください。「注意点」の節は誤りの例とは限りません。兄弟の制度・対象者・時期を取り違えないでください。正しい文を別の一般論に置き換えないでください。資料の番号と文の番号はこの資料表で引き直してください。誤りならreplacementに元の文の位置に入る修正文を1件だけ書き、誤り以外の内容・話題・文の役割を残してください。期限の書き漏れは期限を足し、資料なしで具体を外す場合は裏付けのある内容を残してください。表の行は列数を変えず、改行・見出しを入れないでください。誤り・正しいには必ずevidence_idとbasisを付けてください。資料なしの指摘だけに使える記載なしは、見せた資料のどれにも主張の具体（数字・日付・期間・条件・様式名・判断の目安）の裏付けも否定も無いことです。似た制度・別の時期・別の対象の記載は裏付けにも否定にもなりません。見せた資料を最後まで読んでから決めてください。記載なしならreplacementに資料に無い具体だけを外した1文を書き、裏付けのある内容と数字、文の役割（誤解の例・注意・手順・試算）と話題を残してください。資料の外の知識は足さず、外すと文が成り立たないときは空にしてください。記事が自分で置いた前提から計算した数字は記載なしにせず、計算と資料の数字が合えば正しい、違えば誤り、確かめられなければ判断できないとしてください。同じ文の複数の指摘は全部をまとめて直した同じ1つのreplacementを返してください。資料で判断できなければ判断できないとしてください。出力は各指摘について [{"id":"c1","verdict":"誤り|正しい|記載なし|判断できない","evidence_id":1,"basis":"12-13","replacement":"誤り・記載なしのときだけ","reason":"短い理由"}] のJSON配列だけです。';

const safeText = (value, length) => redactSecrets(typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)).slice(0, length);
// 後段の歯止めでも最初の診断と元の答えを失わない。
function rejectConfirmation(answer, code, detail) {
  return { ...answer, verdict: '判断できない', reason: safeText(detail, 200),
    rejected: answer?.rejected || { code, detail: safeText(detail, 200) } };
}

let questionIndex;
// 通常のQ&A検索には影響させず、確かめの資料なしだけで数字と制度名を併用する。
function numericQuestions(finding, normalizedNumbers) {
  const catalog = qaCatalog();
  if (questionIndex?.catalog !== catalog) questionIndex = { catalog, frequency:new Map(), rows:catalog.map(ref=>({
    ref, text:qa.normalize(`${ref.title} ${ref.text}`), heading:qa.normalize(ref.title).replace(qa.normalize(ref.source_label),''), numbers:new WeakMap(),
  })) };
  const numbers = new Set(normalizedNumbers(qa.normalize(`${finding.claim} ${finding.sentence}`)).filter(n=>n!==null));
  if (!numbers.size) return [];
  const eligible = require('./nta-qa-sources').eligibleSourceKeys(`${finding.subject} ${finding.sentence}`);
  const terms = [...tokenizeForMatcher(finding.subject || '')].map(qa.normalize).filter(word=>word.length>=2).map(word=>{
    if (!questionIndex.frequency.has(word)) questionIndex.frequency.set(word, questionIndex.rows.filter(row=>row.text.includes(word)).length);
    const count=questionIndex.frequency.get(word);
    return {word,rarity:count ? Math.log(catalog.length/count) : 0};
  }).filter(term=>term.rarity>=0.7);
  if (!eligible.size || !terms.length) return [];
  const scored = questionIndex.rows.flatMap(row=>{
    if (!eligible.has(row.ref.source_key)) return [];
    const matched=terms.filter(term=>row.text.includes(term.word));
    if (!matched.length) return [];
    if (!row.numbers.has(normalizedNumbers)) row.numbers.set(normalizedNumbers,new Set(normalizedNumbers(row.text).filter(n=>n!==null)));
    const hits=[...numbers].filter(n=>row.numbers.get(normalizedNumbers).has(n)).length;
    return hits ? [{ref:row.ref,score:hits+matched.reduce((sum,term)=>sum+term.rarity,0),title:matched.filter(term=>row.heading.includes(term.word)).length}] : [];
  });
  return scored.sort((a,b)=>b.score-a.score || b.title-a.title || a.ref.material_id.localeCompare(b.ref.material_id)).slice(0,2)
    .map(row=>resolveMaterial(row.ref.material_id)).filter(Boolean);
}

function delegatedDecrees(finding, refs, normalizedNumbers) {
  const numbers = new Set(normalizedNumbers(qa.normalize(`${finding.claim} ${finding.sentence}`)).filter(n=>n!==null));
  if (!numbers.size) return [];
  const targets = new Map();
  for (const ref of refs) {
    const match=ref.id.match(/^law:(.+)_hou:(\d+(?:_\d+)*)$/);
    if (!match) continue;
    const key=match[1]+'_rei';
    if (!targets.has(key)) targets.set(key,new Set());
    targets.get(key).add(match[2]);
  }
  const entries=evidenceCatalog().entries, scored=[];
  for (const [key,articles] of targets) {
    const known = new Set(entries.filter(e=>e.kind==='law'&&e.key===key).map(e=>e.id));
    for (const article of laws.loadLaw(key)?.articles || []) {
      const id=`law:${key}:${article.num}`;
      if (!known.has(id)) continue;
      const text=qa.normalize(article.text);
      const citations=[...text.matchAll(/法第([〇零一二三四五六七八九十百千0-9]+条(?:の[〇零一二三四五六七八九十百千0-9]+)*)(?:第[〇零一二三四五六七八九十百千0-9]+[項号])*に規定する政令で定める/g)];
      if (!citations.some(m=>articles.has(laws.normalizeArticleNum(m[1])))) continue;
      const hits=new Set(normalizedNumbers(text).filter(n=>numbers.has(n))).size;
      if (hits) scored.push({id,hits});
    }
  }
  return scored.sort((a,b)=>b.hits-a.hits||a.id.localeCompare(b.id)).slice(0,2).map(row=>resolveMaterial(row.id)).filter(Boolean);
}

function candidatesFor(finding, options, normalizedNumbers) {
  const own = (options.searchWriterEvidence || searchWriterEvidence)(finding, options).slice(0, 4);
  const root = finding.glm_answer?.evidence || finding.evidence_id || finding.rejected_answer?.evidence;
  const ref = (finding.evidence || []).find(e => e.id === root) || options.resolvedWriterMaterials?.find(e => e.id === root)
    || (root && resolveMaterial(materialId({ id: root, url: root })));
  const refs = [...own, ...(ref ? [ref] : [])];
  if (finding.status === '資料なし') {
    const search = options.searchEvidence || searchEvidence;
    const { source_url, source_supplements, source_bundle, tax_terms, ...bare } = options;
    refs.push(...search(finding, options).slice(0, 2), ...search(finding, bare).slice(0, 3));
    const words = [...tokenizeForMatcher(`${finding.subject} ${finding.claim} ${finding.sentence}`)].filter(word => word.length >= 4 && word.length <= 16);
    const questions = (options.findQaByKeywords || qa.findQaByKeywords)(words, { maxDocs: 2, scopeText: `${finding.subject} ${finding.sentence}` });
    for (const question of questions.slice(0, 2)) {
      const resolved = resolveMaterial(materialId(question));
      if (resolved) refs.push(resolved);
    }
    refs.push(...numericQuestions(finding, normalizedNumbers));
    refs.push(...delegatedDecrees(finding, refs, normalizedNumbers));
  }
  return [...new Map(refs.filter(e => e.kind !== 'change').map(e => [e.id, e])).values()];
}

function loadPage(ref, options) {
  let source = (options.loadEvidenceText || (e => e.kind === 'qa' ? resolveMaterial(materialId(e))?.text : loadEvidenceText(e)))(ref);
  if (typeof source !== 'string' || !source.trim()) throw new Error('確かめの資料を読めませんでした');
  if (ref.kind === 'taxanswer') source = source.split('関連リンク')[0];
  const units = splitUnits(source, { material: true });
  return { id: ref.id, source, ref: { ...ref, text: source, text_ranges: undefined, text_start: undefined }, units };
}

// 同じページを共有する指摘全部の語・引用を使い、まとめるたびに抜粋を選び直す。
function pageFor(page, findings, limit, number, normalizedNumbers) {
  const { source, ref, units } = page;
  const queries = findings.map(finding => {
    const root = finding.glm_answer?.evidence || finding.evidence_id;
    return { words: [...tokenizeForMatcher(`${finding.subject} ${finding.claim}`)],
      numbers: new Set(normalizedNumbers(`${finding.claim} ${finding.sentence}`).filter(n => n !== null)),
      ranges: root === ref.id ? basisRanges(finding.glm_answer?.basis) || [] : [],
      quotes: root === ref.id && finding.quote ? finding.quote.split('\n…\n').map(q => source.indexOf(q)).filter(at => at >= 0) : [] };
  });
  const numbers = new Set(queries.flatMap(query=>[...query.numbers]));
  const scores = units.map((u, i) => ({ i, score: Math.min(60,[...new Set(normalizedNumbers(u.text))].filter(n=>numbers.has(n)).length*20) + queries.reduce((sum, query) => sum +
    query.words.filter(word => u.text.normalize('NFKC').toLowerCase().includes(word)).length +
    (query.quotes.some(at => at >= u.start && at < u.end) ? 100 : query.ranges.some(range => {
      const [a,b] = range.split('-').map(Number); return u.s >= a && u.s <= b;
    }) ? 30 : 0), 0) }));
  const header = `[資料 ${number}] ${ref.title || ''} / ${ref.url || ''} / ${ref.law_version || ''}\n`;
  const chosen = new Map(); let length = header.length;
  for (const { i } of scores.sort((a,b) => b.score - a.score || a.i - b.i)) for (const at of [i, i-1, i+1]) {
    const u = units[at]; if (!u || chosen.has(u.s)) continue;
    const cost = renderUnits([u]).length + 6;
    if (length + cost > limit) continue;
    chosen.set(u.s, u); length += cost;
  }
  if (!chosen.size) throw new Error('確かめの資料が上限を超えました');
  const selected = [...chosen.values()].sort((a,b) => a.s-b.s); let segment = 0;
  const numbered = selected.map((u,j) => { if (j && u.s !== selected[j-1].s+1) segment++; return { ...u, segment }; });
  return { ...page, number, units: numbered, block: header + numbered.map((u,j) =>
    (j && u.segment !== numbered[j-1].segment ? '……\n' : '') + renderUnits([u])).join('\n') };
}

function packItems(items, normalizedNumbers) {
  const merged = new Map();
  for (const item of items) for (const page of item.pages) {
    if (!merged.has(page.id)) merged.set(page.id, { page, findings: [] });
    const own = merged.get(page.id);
    own.findings.push(item.finding);
  }
  const rows = [...merged.values()], caps = rows.map(row => Math.min(9000, 3000 * row.findings.length));
  const scale = Math.min(1, (30000 - Math.max(0, rows.length-1)*2) / caps.reduce((a,b) => a+b, 0));
  let pages;
  try { pages = rows.map((row,i) => pageFor(row.page, row.findings, Math.floor(caps[i]*scale), i+1, normalizedNumbers)); }
  catch (_) { return null; }
  const block = pages.map(page => page.block).join('\n\n');
  return pages.some((page,i) => page.block.length > caps[i]) || block.length > 30000 ? null : { pages, block };
}

/** 1回8指摘・資料30000字・最大6回。失敗や上限はその指摘だけ判断できないにする。 */
async function confirmFindings(body, findings, call, options, validate, context, parseJson, normalizedNumbers = () => []) {
  const results = new Map(), pending = [], loaded = new Map(), metadata = new Map();
  const packItemsFor = items => packItems(items, normalizedNumbers);
  const unknown = (id, code, detail) => results.set(id, rejectConfirmation({ ...metadata.get(id), ...results.get(id) }, code, detail));
  for (const finding of findings) {
    metadata.set(finding.id, { pages: [], call: null });
    try {
      const pages = candidatesFor(finding, options, normalizedNumbers).flatMap(ref => { try {
        if (!loaded.has(ref.id)) loaded.set(ref.id, loadPage(ref, options));
        return [loaded.get(ref.id)];
      } catch (_) { return []; } });
      if (!pages.length || !packItemsFor([{ finding, pages }])) { unknown(finding.id, 'no_material', '確かめの資料を用意できませんでした'); continue; }
      pending.push({ finding, pages });
    } catch (error) { unknown(finding.id, 'no_material', '確かめの資料を用意できませんでした: ' + error.message); }
  }
  const bundles = [];
  for (const item of pending) {
    let bundle = bundles.find(rows => rows[0].finding.sentence === item.finding.sentence);
    if (!bundle) bundles.push(bundle = []);
    bundle.push(item);
  }
  const available = bundles.filter(items => {
    if (items.length > 8) { for (const {finding} of items) unknown(finding.id, 'call_limit', '同じ文の指摘が1回8件の上限を超えました'); return false; }
    if (!packItemsFor(items)) { for (const {finding} of items) unknown(finding.id, 'no_material', '同じ文の資料を上限内で用意できませんでした'); return false; }
    return true;
  });
  const groups = [];
  while (available.length) {
    const items = [...available.shift()]; let pack = packItemsFor(items);
    while (items.length < 8) {
      const ids = new Set(pack.pages.map(p => p.id));
      const ranked = available.map((bundle,index) => ({ bundle,index,overlap:new Set(bundle.flatMap(item=>item.pages.filter(p=>ids.has(p.id)).map(p=>p.id))).size })).sort((a,b)=>b.overlap-a.overlap || a.index-b.index);
      const next = ranked.find(row => row.overlap && items.length+row.bundle.length<=8 && packItemsFor([...items,...row.bundle]));
      if (!next) break;
      items.push(...available.splice(next.index,1)[0]); pack = packItemsFor(items);
    }
    groups.push({ items, pack });
  }
  let calls = 0;
  const run = async (jobs, retrying = false) => {
    const selected = jobs.slice(0, 6-calls), overflow = jobs.slice(6-calls), retry = [];
    for (const job of overflow) for (const {finding} of job.items) unknown(finding.id,'call_limit','確かめの呼び出しの上限を超えました');
    for (const [index,job] of selected.entries()) for (const {finding,pages} of job.items) metadata.set(finding.id, {
      call: calls+index+1, pages: job.pack.pages.filter(p=>pages.some(own=>own.id===p.id)).slice(0,12)
        .map(p=>({number:p.number,id:safeText(p.id,600),title:safeText(p.ref.title,600)})) });
    calls += selected.length;
    const requests = selected.map(({items,pack}) => ({ task:'confirm', immediate:!call.batch, maxTokens:16000,
      system:CONFIRM_SYSTEM, staticSystem:CONFIRM_SYSTEM, dynamicSystem:pack.block, ...(retrying ? { retry: true } : {}),
      user:JSON.stringify({ claims:items.map(({finding:f,pages})=>({id:f.id,type:f.type,subject:f.subject,sentence:f.sentence,
          ...context(body,f.sentence),finding:f.condition_mismatch?'条件の不一致':f.status,
          glm_answer:f.glm_answer || {status:f.status,evidence:f.evidence_id,basis:'',correct:f.correct},
          evidence_ids:pack.pages.filter(p=>pages.some(e=>e.id===p.id)).map(p=>p.number)})) }) }));
    const consume = async (job, work) => {
      const {items,pack} = job;
      let ret;
      try { ret = await work; }
      catch (error) { for (const {finding} of items) unknown(finding.id,'call_failed','確かめを実施できませんでした: '+error.message); return; }
      try {
        if (['max_tokens','length'].includes(ret?.stopReason) || ret?.stop_reason === 'max_tokens') {
          if (retrying) { for (const {finding} of items) unknown(finding.id,'max_tokens','確かめの出力が再び上限に達しました'); return; }
          // 再試行も文の途中では分けない。1文だけなら同じ組を1度だけ聞き直す。
          const sentences = [...new Set(items.map(item=>item.finding.sentence))], at = Math.ceil(sentences.length/2);
          for (const half of [sentences.slice(0,at),sentences.slice(at)].filter(part=>part.length).map(part=>items.filter(item=>part.includes(item.finding.sentence)))) {
            const next=packItemsFor(half);
            if (next) retry.push({ items:half, pack:next });
            else for (const {finding} of half) unknown(finding.id,'no_material','確かめの資料を用意できませんでした');
          }
          return;
        }
        let rows;
        try { rows = ret?.verdict ? ret : parseJson(ret); }
        catch (_) { for (const {finding} of items) unknown(finding.id,'answer_shape','確かめのJSONを読めませんでした'); return; }
        if (!Array.isArray(rows)) rows = [rows];
        for (const {finding,pages} of items) {
          const own = rows.filter(row=>row?.id===finding.id);
          if (own.length !== 1 || !['誤り','正しい','記載なし','判断できない'].includes(own[0].verdict)) { unknown(finding.id,'answer_shape','確かめの答えの形が不正です'); continue; }
          const row = own[0];
          const answer = { verdict:safeText(row.verdict,600), evidence:typeof row.evidence_id==='number'?row.evidence_id:safeText(row.evidence_id,600),
            evidence_id:safeText(pack.pages.find(p=>p.number===unitNumber(row.evidence_id))?.id,600),
            basis:safeText(row.basis,600),replacement:safeText(row.replacement,600),reason:safeText(row.reason,600) };
          metadata.set(finding.id, {...metadata.get(finding.id),answer});
          if (row.verdict === '判断できない') { results.set(finding.id,{...metadata.get(finding.id),verdict:'判断できない',reason:safeText(row.reason,300)}); continue; }
          if (typeof row.replacement === 'string' && redactSecrets(row.replacement) !== row.replacement) { unknown(finding.id,'secret','修正文に鍵の形の文字列が含まれています'); continue; }
          let result;
          try { result = await validate(finding, row, pack.pages.filter(page=>pages.some(p=>p.id===page.id))); }
          catch (error) { unknown(finding.id,'exception','確かめの答えの検証で例外が起きました: '+error.message); continue; }
          if (!result) { unknown(finding.id,'exception','確かめの答えの検証結果を読めませんでした'); continue; }
          results.set(finding.id, {...metadata.get(finding.id),...result});
        }
      } catch (error) { for (const {finding} of items) if (!results.has(finding.id)) unknown(finding.id,'exception','確かめの処理で例外が起きました: '+error.message); }
    };
    if (call.batch && requests.length) {
      const response = await call.batch(requests).catch(() => []), outcomes = Array.isArray(response) ? response : [];
      await Promise.all(selected.map((job,i) => consume(job, outcomes[i]?.status === 'fulfilled' ? Promise.resolve(outcomes[i].value) : Promise.reject(new Error('確かめのBatch失敗')))));
    } else for (let i=0; i<selected.length; i+=3) await Promise.all(selected.slice(i,i+3).map((job,j)=>consume(job,Promise.resolve().then(()=>call(requests[i+j])))));
    if (retry.length) await run(retry, true);
  };
  await run(groups);
  return results;
}

module.exports = { confirmFindings, rejectConfirmation };
