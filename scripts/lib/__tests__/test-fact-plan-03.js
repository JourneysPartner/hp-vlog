'use strict';

// 03の回帰試験。GLM・Opusは偽物、資料はローカルの本物のカタログを使う。
const assert = require('assert/strict');
const F = require('../fact-check');
const W = require('../writer-materials');
const H = require('./fact-pages-test-helpers');
const cases = [], groups = {};
const test = (group, name, run) => cases.push({ group, name, run });
const opts = { now: new Date('2026-10-21T00:00:00Z'), enabled: true, provider: 'gateway', model: 'zai/glm-5.3-flash', batch: false, repair: true };
async function env(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k,v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); } finally {
    for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const material = id => { const r=W.resolveMaterial(id); assert(r,id); return {...r,text:r.kind==='taxanswer'?r.text.split('関連リンク')[0]:r.text}; };
const extract = (req, type, subject) => [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m=>!m[2].startsWith('#')).map(m=>({s:+m[1],type,subject,claim:m[2]}));
const payload = req => JSON.parse(req.user);
const materials = req => H.materials({ ...req, system:[req.system,req.dynamicSystem].filter(Boolean).join('\n\n') });
const matching = (req, ref, pattern) => {
  const page=materials(req).find(p=>p.url===ref.url); assert(page,ref.title);
  const row=page.rows.find(r=>pattern.test(r.text)); assert(row,String(pattern));
  return {evidence_id:page.number,basis:String(row.s)};
};
const judged = (req,c,ref,pattern,status,correct='') => ({id:c.id,status,...matching(req,ref,pattern),correct});
const confirmed = (req,c,ref,pattern,verdict,replacement='') => ({id:c.id,verdict,...matching(req,ref,pattern),replacement,reason:'添付した資料で確認'});
const agreement = () => ({verdict:'一致',conditions:[],correct:''});
const load = e => W.resolveMaterial(W.materialId(e))?.text || e.text;
const feature = (run, ...flags) => env({FACT_CHECK_WRITER_MATERIALS:'true',FACT_CHECK_CONFIRM:flags.length ? flags[0] : 'true',FACT_CHECK_CONFIRM_MODEL:undefined},run);

test('C2・C5', '背景: 4511の50歳未満で住宅資金を書き換える前に、Opusが4508で正しいと確認する', async()=>feature(async()=>{
  const home=material('ta:4508'),family=material('ta:4511'),body='受贈者は18歳以上の者に限られます。';let opus=0;
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4510','ta:4511'],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','直系尊属からの贈与の非課税');
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm'){opus++;return payload(req).claims.map(c=>confirmed(req,c,home,/18歳以上/,'正しい'));}
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:'受贈者は18歳以上50歳未満の者に限られます。'}));
    return payload(req).claims.map(c=>judged(req,c,family,/50歳未満/,c.claim.includes('50歳未満')?'裏付けあり':'食い違い','受贈者は18歳以上50歳未満の者に限られます。'));
  }});
  assert.equal(opus,1);assert.equal(r.body,body);assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].status,'裏付けあり');
  assert.equal(r.record.claims[0].evidence_id,home.id);assert.equal(r.record.claims[0].confirmed_by,'claude-opus-5-5');
  assert(!r.record.calls.some(c=>/repair|recheck/.test(c.task)));
}));

for(const verdict of ['正しい','判断できない'])test('C2・C5',`背景: 正しい15日前を資料なしにしても、Q&Aを渡してOpusが${verdict}と判断する`,async()=>feature(async()=>{
  const own=material('ta:6501'),qa=material('qa:invoice/13');
  const body='登録取消届出書は、翌課税期間の初日から起算して15日前までに提出します。';let opus=0;
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:6501'],searchWriterEvidence:()=>[own],searchEvidence:()=>[own],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'期限','インボイスの登録取消届出書');
    if(req.task==='confirm'){
      opus++;assert(materials(req).some(p=>p.url===qa.url));
      return payload(req).claims.map(c=>verdict==='正しい'?confirmed(req,c,qa,/15\s*日\s*前/,'正しい'):{id:c.id,verdict});
    }
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:'登録取消届出書の期限は国税庁で確認してください。'}));
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});
  assert.equal(opus,1);assert.equal(r.body,body);assert.equal(r.record.status,verdict==='正しい'?'ok':'revise');
  assert(!r.record.calls.some(c=>/repair|recheck/.test(c.task)));
}));

const spouseBody='贈与税の配偶者控除では、婚姻期間が20年以上の配偶者への贈与について2,500万円まで控除できます。';
test('C3〜C5', '背景: 配偶者控除2500万円を通さず、Opusの2000万円の案だけで直して再照合しない',async()=>feature(async()=>{
  const source=material('ta:4452'),fixed=spouseBody.replace('2,500','2,000');let opus=0;
  const r=await F.checkFacts(spouseBody,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','贈与税の配偶者控除');
    if(req.task==='confirm'){opus++;return payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'誤り',fixed));}
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:fixed}));
    return payload(req).claims.map(c=>judged(req,c,source,/2,000万円/,'食い違い','2,000万円'));
  }});
  assert.equal(opus,1);assert.equal(r.body,fixed);assert.equal(r.record.status,'ok');assert(r.record.corrections[0].resolved);
  assert.equal(r.record.corrections[0].confirm.verdict,'誤り');assert.equal(r.record.rechecked.length,0);
  assert(!r.record.calls.some(c=>/repair|recheck/.test(c.task)));
}));

test('C2・C5', '背景: よくある誤解の父母それぞれなら枠が2倍になる例を反転させない',async()=>feature(async()=>{
  const source=material('ta:4508'),sentence='父母それぞれから住宅資金をもらえば枠が2倍になると考える。';
  const body='## よくある誤解\n'+sentence+'\n受贈者ごとの枠を確認します。';let opus=0;
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'判定','住宅取得等資金の贈与の非課税').slice(0,1).map(c=>({...c,claim:'父母それぞれからもらっても枠は2倍にならない。'}));
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm'){
      opus++;const c=payload(req).claims[0];assert.equal(c.heading,'よくある誤解');assert.equal(c.next,'受贈者ごとの枠を確認します。');
      return [confirmed(req,c,source,/贈与を受けた人ごと/,'正しい')];
    }
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:sentence.replace('2倍になる','2倍にならない')}));
    return payload(req).claims.map(c=>judged(req,c,source,/贈与を受けた人ごと/,'食い違い',sentence.replace('2倍になる','2倍にならない')));
  }});
  assert.equal(opus,1);assert.equal(r.body,body);assert.equal(r.record.status,'ok');
}));

test('D1', '数字6件で段Aは資料なし、段Bは3件だけ資料なしの答え・3件は答えなしならnot_run',async()=>feature(async()=>{
  const source=material('ta:4452'),body=['甲','乙','丙','丁','戊','己'].map(label=>`${label}の控除額は2,000万円です。`).join('\n');
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','贈与税の配偶者控除');
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:c.sentence.replace('2,000万円','一定の額')}));
    return payload(req).claims.slice(0,req.stageB?3:6).map(c=>({id:c.id,status:'資料なし'}));
  }});
  assert.equal(r.record.status,'not_run');assert.equal(r.body,body);assert(!r.record.calls.some(c=>c.task==='repair'));
},'false'));

test('D2', '確かめなしの配偶者控除2500万円の食い違いを3割の判定でokにしない',async()=>feature(async()=>{
  const source=material('ta:4452');
  const r=await F.checkFacts(spouseBody,{...opts,repair:false,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,
    callLLM:async req=>req.task==='extract'?extract(req,'金額','贈与税の配偶者控除'):payload(req).claims.map(c=>judged(req,c,source,/2,000万円/,'食い違い','2,000万円'))});
  assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].status,'食い違い');assert.equal(r.body,spouseBody);
},'false'));

test('D3', '本物の全体検索が4511を1位にしても、書き手の候補の1位・一意な題名でない根拠で直さない',async()=>feature(async()=>{
  const family=material('ta:4511'),home=material('ta:4508'),body='受贈者は18歳以上の者に限られます。';
  const c={type:'要件',subject:'直系尊属からの贈与の非課税',sentence:body,claim:body};
  assert.equal(F.searchEvidence(c)[0].id,family.id);assert.equal(W.searchWriterEvidence(c,{writer_materials:['ta:4508','ta:4510','ta:4511']})[0].id,home.id);
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4510','ta:4511'],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件',c.subject);
    if(req.task==='condition_check')return agreement();
    if(req.task==='repair')return payload(req).corrections.map(c=>({id:c.id,replacement:'受贈者は18歳以上50歳未満の者に限られます。'}));
    return payload(req).claims.map(c=>judged(req,c,family,/50歳未満/,c.claim.includes('50歳未満')?'裏付けあり':'食い違い','受贈者は18歳以上50歳未満の者に限られます。'));
  }});
  assert.equal(r.body,body);assert(!r.record.calls.some(c=>c.task==='repair'));
},'false'));

async function spouseCase(reply, extra = {}) {
  const source=material('ta:4452'), body=extra.body || spouseBody;
  return F.checkFacts(body,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,findQaByKeywords:()=>[],...extra,callLLM:async req=>{
    if(req.task==='extract')return extract(req,extra.type || '金額','贈与税の配偶者控除');
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm')return reply(req,source);
    assert(!/repair|recheck/.test(req.task),'確かめからGLMの修正へ戻らない');
    return payload(req).claims.map(c=>extra.missing?{id:c.id,status:'資料なし'}:judged(req,c,source,/2,000万円/,'食い違い','2,000万円'));
  }});
}

for(const flag of [undefined,'','false','TRUE',' true '])test('C1',`確かめの切替${String(flag)}は呼び出し・記録とも従来経路と同じ`,async()=>{
  const run=()=>spouseCase(()=>{throw Error('確かめを呼んではいけない');},{repair:false});
  const baseline=await feature(run,'false'),r=await feature(run,flag);
  assert.deepEqual(r,baseline);assert(!Object.hasOwn(r.record,'confirm'));assert(!r.record.calls.some(c=>c.task==='confirm'));
});

for(const writer of [undefined,'','false','true'])test('C1',`確かめtrueでも書き手の資料が有効でなければ本番のOpus・Batchのまま（${String(writer)}）`,async()=>{
  const source=material('ta:4452'),requests=[];
  await env({FACT_CHECK_WRITER_MATERIALS:writer,FACT_CHECK_CONFIRM:'true',FACT_CHECK_PROVIDER:undefined,FACT_CHECK_MODEL:undefined,FACT_CHECK_BATCH:'true'},async()=>{
    const r=await F.checkFacts(spouseBody,{now:opts.now,enabled:true,repair:false,writer_materials:writer==='true'?['ta:0000']:['ta:4452'],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
      requests.push({...req,signal:undefined});
      return req.task==='extract'?extract(req,'金額','贈与税の配偶者控除'):payload(req).claims.map(c=>judged(req,c,source,/2,000万円/,'食い違い','2,000万円'));
    }});
    assert.equal(r.record.provider,'anthropic');assert.equal(r.record.model,'claude-opus-5-5');assert.equal(r.record.batch,true);
    assert(r.record.calls.every(c=>c.model==='claude-opus-5-5'&&c.mode==='batch'));assert(!requests.some(c=>c.task==='confirm'));
    assert(!Object.hasOwn(r.record,'confirm'));assert(!Object.hasOwn(r.record,'stages'));
  });
});

for(const flaw of ['近傍に無い数字','表の列数','改行','見出し','長すぎる文','同じ文','空の文','範囲外の根拠','候補外の資料','重複したid'])test('C4',`Opusの${flaw}を採らず、元の文を保って承認停止する`,async()=>feature(async()=>{
  const body=flaw==='表の列数'?'| 贈与税の配偶者控除 | 2,500万円 |':spouseBody;
  const r=await spouseCase((req,source)=>{
    const replacements={'近傍に無い数字':body.replace('2,500','2,100'),'表の列数':'| 贈与税の配偶者控除 | 2,000万円 | 追加 |',
      '改行':body.replace('2,500','2,000')+'\n説明です。','見出し':'## 控除額の説明','長すぎる文':'控除できます。'.repeat(100),'同じ文':body,'空の文':''};
    const c=payload(req).claims[0],row=confirmed(req,c,source,/2,000万円/,'誤り',replacements[flaw]??body.replace('2,500','2,000'));
    if(flaw==='範囲外の根拠')row.basis='99999';if(flaw==='候補外の資料')row.evidence_id=999;
    return flaw==='重複したid'?[row,row]:[row];
  },{body});
  assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].confirm.verdict,'判断できない');assert.equal(r.record.corrections.length,0);
}));

for(const failure of ['API失敗','時間切れ','JSON不正','出力上限','知らないverdict','答えなし'])test('C7',`確かめの${failure}は照合全体をnot_runにせず、数字を止める`,async()=>feature(async()=>{
  const r=await spouseCase(()=>{
    if(failure==='API失敗')throw Object.assign(Error('sk-fake-secret12345'),{batch_error:'sk-fake-secret12345'});
    if(failure==='時間切れ')return new Promise(()=>{});
    if(failure==='JSON不正')return '{broken';if(failure==='出力上限')return {text:'[]',stopReason:'max_tokens'};
    return failure==='答えなし'?[]:[{id:'c1',verdict:'おそらく正しい'}];
  },failure==='時間切れ'?{timeoutMs:25}:{});
  assert.equal(r.body,spouseBody);assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].confirm.verdict,'判断できない');
  assert(!JSON.stringify(r.record).includes('sk-fake-secret12345'));assert(!r.record.calls.some(c=>/repair|recheck/.test(c.task)));
}));

for(const type of ['要件','判定','手続'])test('C5',`判断できない${type}の食い違いは人の一覧と承認停止へ残す`,async()=>feature(async()=>{
  const r=await spouseCase(req=>payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'})),{type});
  assert.equal(r.body,spouseBody);assert.equal(r.record.status,'revise');assert.equal(r.record.review_items[0].confirm.verdict,'判断できない');assert.equal(r.record.remaining.length,1);
}));

for(const verdict of ['誤り','正しい','判断できない'])test('C5',`条件確認の不一致もOpusの${verdict}へ渡す`,async()=>feature(async()=>{
  const source=material('ta:4508'),body='受贈者は18歳以上の者に限られます。',fixed='受贈者は18歳以上であることが要件です。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='condition_check')return {verdict:'不一致',conditions:[{article:'18歳以上',source:'50歳未満',match:'不一致'}],correct:'受贈者は50歳未満に限る。'};
    if(req.task==='confirm'){
      const c=payload(req).claims[0];assert.equal(c.finding,'条件の不一致');assert.equal(c.glm_answer.correct,'受贈者は50歳未満に限る。');
      return verdict==='判断できない'?[{id:c.id,verdict}]:[confirmed(req,c,source,/18歳以上/,verdict,fixed)];
    }
    assert.equal(req.task,'judge');return payload(req).claims.map(c=>judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});
  assert.equal(r.body,verdict==='誤り'?fixed:body);assert.equal(r.record.status,'ok');assert.equal(r.record.rechecked.length,0);
  assert.equal(r.record.review_items.length,verdict==='判断できない'?1:0);
}));

test('C5', '要件型でも期限の書き漏れが判断できなければ止める',async()=>feature(async()=>{
  const source=material('ta:4508'),body='住宅取得等資金の贈与は非課税です。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));
    return payload(req).claims.map(c=>judged(req,c,source,/令和8年12月31日/,'期限の書き漏れ','令和8年12月31日'));
  }});
  assert.equal(r.record.status,'revise');assert.equal(r.body,body);assert.equal(r.record.remaining[0].confirm.verdict,'判断できない');
}));

test('C6', '重なる候補をまとめ、1回8件・共有資料9000字・合計30000字・6回を上限にする',async()=>feature(async()=>{
  const labels=Array.from({length:49},(_,i)=>String.fromCharCode(0x4e00+i)),body=labels.map(s=>s+spouseBody).join('\n');let calls=0;
  const r=await spouseCase(req=>{
    calls++;const rows=payload(req).claims, pages=materials(req);assert(rows.length<=8);assert.equal(req.provider,'anthropic');assert.equal(req.model,'claude-opus-5-5');assert.equal(req.immediate,false);assert.equal(req.maxTokens,16000);
    assert.equal(req.modelOptions,undefined);assert.equal(req.effort,undefined);assert.equal(req.batch,undefined);
    const blocks=req.dynamicSystem.split(/(?=\[資料 \d+\])/).slice(1);assert(blocks.every(s=>s.trimEnd().length<=Math.min(9000,3000*rows.length)));assert(blocks.join('').length<=30000);assert(pages.length);
    return rows.map(c=>({id:c.id,verdict:'判断できない'}));
  },{body,batch:true});
  assert.equal(calls,6);assert.equal(r.record.calls.filter(c=>c.task==='confirm').length,6);assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.mode==='batch'));
  assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.confirm.checked,49);assert.equal(r.record.confirm.unknown,49);
  assert(r.record.claims.at(-1).confirm.reason.includes('上限'));assert(r.record.summary.includes('・Opus の確かめ 49 件（書き換え 0・具体を外した 0・残す 0・判断できない 49、うち答えを採らなかった 1）・6 回'));
}));

test('C6', '実際の提供元の振り分けでも確かめだけAnthropic即時・effortなし・出力16000となる',async()=>feature(async()=>{
  const CM=require('../content-model'),GW=require('../gateway-model'),generate=CM.generateContent,gateway=GW.callGateway,source=material('ta:4452');let confirms=0;
  try{
    GW.callGateway=async req=>req.task==='extract'?extract(req,'金額','贈与税の配偶者控除'):payload(req).claims.map(c=>judged(req,c,source,/2,000万円/,'食い違い','2,000万円'));
    CM.generateContent=async(prompts,options)=>{
      confirms++;assert.equal(options.provider,'anthropic');assert.equal(options.model,'claude-opus-test');assert.equal(options.maxTokens,16000);assert.equal(options.batch,null);assert.equal(options.modelOptions,undefined);assert.equal(options.effort,undefined);
      const req={system:prompts.staticSystem,dynamicSystem:prompts.dynamicSystem,user:prompts.user};return payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'誤り',spouseBody.replace('2,500','2,000')));
    };
    await env({FACT_CHECK_CONFIRM_MODEL:'claude-opus-test'},async()=>{
      const r=await F.checkFacts(spouseBody,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load});
      assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirmed_by,'claude-opus-test');
    });assert.equal(confirms,1);
  }finally{CM.generateContent=generate;GW.callGateway=gateway;}
}));

test('C5・C7', '同じ呼び出しの有効な修正を保ち、他の読めない答えだけ判断できないにする',async()=>feature(async()=>{
  const body='甲'+spouseBody+'\n乙'+spouseBody;
  const r=await spouseCase((req,source)=>{
    const [a,b]=payload(req).claims;return [confirmed(req,a,source,/2,000万円/,'誤り',a.sentence.replace('2,500','2,000')),{id:b.id,verdict:'誤り',evidence_id:1,basis:'99999',replacement:'読めない案'}];
  },{body});
  assert.equal(r.body,'甲'+spouseBody.replace('2,500','2,000')+'\n乙'+spouseBody);assert.equal(r.record.status,'revise');
  assert.equal(r.record.confirm.rewritten,1);assert.equal(r.record.confirm.unknown,1);assert.equal(r.record.corrections.length,1);
}));

test('C2', '資料なしには書き手の上位4件・全体の上位3件・関連Q&Aの最大2件だけを渡す',async()=>feature(async()=>{
  const own=['ta:4508','ta:4510','ta:4511','ta:4452','ta:4408'].map(material),global=['ta:6501','ta:6509','ta:1110','ta:4103'].map(material),qa=['qa:invoice/13','qa:invoice/13-2','qa:invoice/07'].map(material);
  let calls=0;
  const r=await F.checkFacts('登録取消届出書は15日前までに提出します。',{...opts,writer_materials:own.map(W.materialId),searchWriterEvidence:()=>own.slice(0,4),searchEvidence:()=>global,loadEvidenceText:load,
    findQaByKeywords:(words,options)=>{assert(words.some(w=>w.includes('登録取消届出書')));assert.equal(options.maxDocs,2);return qa;},callLLM:async req=>{
      if(req.task==='extract')return extract(req,'期限','インボイスの登録取消届出書');
      if(req.task==='confirm'){
        calls++;assert.deepEqual(new Set(materials(req).map(p=>p.url)),new Set([...own.slice(0,4),...global.slice(0,3),...qa.slice(0,2)].map(p=>p.url)));
        return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));
      }return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
    }});
  assert.equal(calls,1);assert.equal(r.record.status,'revise');
}));

test('C5', 'S6の少数の資料なしだけを確かめへ回し、具体を外す修正にもOpusの根拠を記録する',async()=>feature(async()=>{
  const source=material('ta:4508'),missing='贈与者の住所は東京都内に限ります。',supported='受贈者は18歳以上の者に限られます。';let confirms=0;
  const r=await F.checkFacts(missing+'\n'+['甲','乙','丙','丁'].map(s=>s+supported).join('\n'),{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,findQaByKeywords:()=>[],callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');if(req.task==='condition_check')return agreement();
    if(req.task==='confirm'){confirms++;assert.equal(payload(req).claims.length,1);return confirmed(req,payload(req).claims[0],source,/贈与を受けた人ごと/,'誤り','贈与税の非課税の要件は国税庁で確認してください。');}
    return payload(req).claims.map(c=>c.claim===missing?{id:c.id,status:'資料なし'}:judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});
  assert.equal(confirms,1);assert.equal(r.record.status,'ok');assert(r.record.corrections[0].generalized);assert.equal(r.record.corrections[0].confirmed_by,'claude-opus-5-5');
  assert(!r.body.includes('東京都内'));assert(r.body.includes('甲'+supported));assert.equal(r.record.rechecked.length,0);
}));

test('C5', 'S6の割合上限を超えた要件の資料なしは確かめも具体を外す修正もしない',async()=>feature(async()=>{
  const r=await spouseCase(()=>{throw Error('S6の上限を超えた資料なしを確かめない');},{type:'要件',missing:true});
  assert.equal(r.body,spouseBody);assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.checked,0);assert.equal(r.record.review_items.length,1);
}));

test('C7', '不正な確かめのモデルと理由中の鍵を記録に出さない',async()=>feature(async()=>{
  await env({FACT_CHECK_CONFIRM_MODEL:'sk-test-secret-confirm12345'},async()=>{
    const r=await spouseCase(()=>{throw Error('不正なモデルを呼ばない');});
    assert.equal(r.record.status,'revise');assert(!JSON.stringify(r.record).includes('sk-test-secret-confirm12345'));assert.equal(r.record.calls.filter(c=>c.task==='confirm').length,0);
  });
  const r=await spouseCase(req=>payload(req).claims.map(c=>({id:c.id,verdict:'判断できない',reason:'sk-test-secret-confirm12345'})));
  assert.equal(r.record.status,'revise');assert(!JSON.stringify(r.record).includes('sk-test-secret-confirm12345'));
}));

for(const [subject,sentence,correct,id,pattern] of [
  ['売上原価','値下げして販売した商品は、その販売価格で売上が立ち、取得価額が売上原価になります。','必要経費に算入できるのは、総収入金額に対応する売上原価その他その総収入金額を得るために直接要した費用の額です。','law:shotokuzei_hou:37',/必要経費/],
  ['棚卸資産の評価','値が付かないと説明できる根拠がない限り認められにくい処理です。','期末棚卸資産の評価の方法は、政令で定める方法の中から選定でき、青色申告の承認を受けていない場合は原価法によります。','law:shotokuzei_hou:47',/評価/],
])test('D2',`無関係なcorrectを返した${subject}の食い違いは、修正を採らずreviseを維持する`,async()=>feature(async()=>{
  const source=material(id);
  const r=await F.checkFacts(sentence,{...opts,writer_materials:[id],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'判定',subject);assert.equal(req.task,'judge');
    return payload(req).claims.map(c=>judged(req,c,source,pattern,'食い違い',correct));
  }});
  assert.equal(r.body,sentence);assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].correct_requires_review,true);assert.equal(r.record.remaining.length,1);
},'false'));

test('C1・C5', '確かめの切替時には過去の判定を使い回さず、保存した引用・確かめを復元できる',async()=>feature(async()=>{
  const fs=require('fs'),path=require('path'),os=require('os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fact-plan03-record-'));
  const raw='---\nslug: confirm-test\nrecommendation: publish\nfact_materials: "ta:4508"\n---\n受贈者は18歳以上の者に限られます。',source=material('ta:4508');
  let confirms=0,judges=0;
  const options={...opts,recordDir:dir,loadEvidenceText:load,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm'){confirms++;return payload(req).claims.map(c=>confirmed(req,c,source,/18歳以上/,'正しい'));}
    assert.equal(req.task,'judge');judges++;return payload(req).claims.map(c=>judged(req,c,source,/18歳以上/,'食い違い','受贈者は50歳未満に限られます。'));
  }};
  try{
    await feature(()=>F.checkArticle(raw,{...options,repair:false}),'false');
    const r=await F.checkArticle(raw,{...options,previousRaw:raw});assert.equal(r.record.incremental,undefined);assert.equal(r.record.status,'ok');assert.equal(confirms,1);
    const stored=JSON.parse(fs.readFileSync(r.recordFile,'utf8'));assert.equal(stored.claims[0].confirm.verdict,'正しい');assert.equal(stored.claims[0].confirmed_by,'claude-opus-5-5');assert(F.evidenceRefs(stored,stored.claims[0]).some(e=>e.id===source.id&&e.text.includes('18歳以上')));
    const before=judges,next=await feature(()=>F.checkArticle(raw,{...options,previousRaw:raw,repair:false,persist:false}),'false');
    assert.equal(next.record.incremental,undefined);assert(judges>before);assert.equal(confirms,1);
  }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
}));

test('C4', '同じ呼び出しに見える別の指摘だけの資料は根拠に採らない',async()=>feature(async()=>{
  const home=material('ta:4508'),spouse=material('ta:4452'),shared=material('ta:4511'),homeBody='住宅取得等資金の非課税限度額は1,200万円です。';let calls=0;
  const select=c=>[c.subject==='住宅取得等資金の贈与の非課税'?home:spouse,shared];
  const r=await F.checkFacts(homeBody+'\n'+spouseBody,{...opts,writer_materials:['ta:4508','ta:4452','ta:4511'],searchWriterEvidence:select,searchEvidence:select,loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','仮').map(c=>({...c,subject:c.claim.includes('非課税限度額')?'住宅取得等資金の贈与の非課税':'贈与税の配偶者控除'}));
    if(req.task==='confirm'){
      calls++;assert.equal(payload(req).claims.length,2);
      return payload(req).claims.map(c=>confirmed(req,c,spouse,/2,000万円/,'誤り',c.sentence.replace(/1,200|2,500/,'2,000')));
    }
    return payload(req).claims.map(c=>judged(req,c,select(c)[0],c.subject.includes('住宅')?/1,000万円/:/2,000万円/,'食い違い',c.subject.includes('住宅')?'1,000万円':'2,000万円'));
  }});
  assert.equal(calls,1);assert.equal(r.body,homeBody+'\n'+spouseBody.replace('2,500','2,000'));assert.equal(r.record.status,'revise');
  assert.equal(r.record.claims[0].confirm.verdict,'判断できない');assert.equal(r.record.corrections.length,1);
}));

// レビューの再現は、記事の文・モデルの答え・出典を変えずに回帰試験へ残す。
const wrongRecipient='受贈者は、贈与者の直系尊属であることが要件です。';
const rightRecipient='受贈者は、贈与者の直系卑属であることが要件です。';
async function recipientCase(opus, extra={}) {
  const source=material('ta:4508');
  return F.checkFacts(wrongRecipient,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,...extra,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='confirm')return opus(req,source);
    return payload(req).claims.map(c=>judged(req,c,source,/直系卑属/,'食い違い',rightRecipient));
  }});
}
for(const failure of ['basis不正','呼び出し例外','判断できない','時間切れ','JSON不正','再度の出力上限'])test('03b-H1',`本物の要件の誤りはOpusの${failure}でもreviseを維持する`,async()=>feature(async()=>{
  const r=await recipientCase((req,source)=>{
    if(failure==='呼び出し例外')throw Error('確かめのAPI失敗');
    if(failure==='判断できない')return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));
    if(failure==='時間切れ')return new Promise(()=>{});
    if(failure==='JSON不正')return '壊れたJSON';
    if(failure==='再度の出力上限')return {text:'[',stop_reason:'max_tokens'};
    return payload(req).claims.map(c=>({...confirmed(req,c,source,/直系卑属/,'誤り',rightRecipient),basis:'根拠の文'}));
  },failure==='時間切れ'?{timeoutMs:25}:{});
  assert.equal(r.body,wrongRecipient);assert.equal(r.record.claims[0].status,'食い違い');assert.equal(r.record.claims[0].confirm.verdict,'判断できない');assert.equal(r.record.status,'revise');
}));

async function scatteredHome(count, opus) {
  const U=require('../fact-units'),source=material('ta:4508'),units=U.splitUnits(source.text,{material:true});
  const chosen=Array.from({length:count},(_,i)=>units[i*3]);assert(chosen.every(Boolean));
  const body=chosen.map(u=>u.text).join('\n'),sizes=[];
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='confirm'){
      sizes.push({claims:payload(req).claims.length,chars:(req.dynamicSystem||req.system).length});
      return opus?opus(req,source):payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));
    }
    const page=materials(req).find(p=>p.url===source.url);assert(page);
    return payload(req).claims.map(c=>({id:c.id,status:'食い違い',evidence_id:page.number,basis:H.basisFor(page,c.claim),correct:c.claim+'（要件を確認してください）'}));
  }});
  return {r,sizes,body};
}
for(const count of [8,12])test('03b-M1',`4508の別々の箇所${count}件を1〜2回にまとめる`,async()=>feature(async()=>{
  const {r,sizes,body}=await scatteredHome(count);
  console.log('03b-M1 計測 '+JSON.stringify({count,sizes}));
  assert.equal(r.record.claims.length,count);assert(sizes.length>=1&&sizes.length<=2);assert.equal(r.body,body);assert.equal(r.record.status,'revise');
  assert(!r.record.claims.some(c=>c.confirm?.reason.includes('上限')));
}));

test('03b-M2','兄弟4511の18歳以上50歳未満を使うOpusの誤りも書き換えずrevise',async()=>feature(async()=>{
  const home=material('ta:4508'),family=material('ta:4511'),body='受贈者は18歳以上の者に限られます。',fixed='受贈者は18歳以上50歳未満の者に限られます。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4510','ta:4511'],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','直系尊属からの贈与の非課税');
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,family,/18歳以上50歳未満/,'誤り',fixed));
    return payload(req).claims.map(c=>judged(req,c,family,/18歳以上50歳未満/,'食い違い',fixed));
  }});
  assert.equal(W.searchWriterEvidence(r.record.claims[0],{writer_materials:['ta:4508','ta:4510','ta:4511']})[0].id,home.id);
  assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].confirm.verdict,'判断できない');
}));

test('03b-M3','非課税限度額1200万円を申告期限の別の話題へ置き換えない',async()=>feature(async()=>{
  const source=material('ta:4508'),body='住宅取得等資金の非課税限度額は省エネ等住宅で1,200万円です。',fixed='贈与税の申告は翌年2月1日から3月15日までに行います。';let round=0;
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract'){round++;return extract(req,round===1?'金額':'期限',round===1?'住宅取得等資金の贈与の非課税':'贈与税の申告');}
    if(req.task==='repair'||req.task==='retry_repair')return payload(req).corrections.map(c=>({id:c.id,replacement:fixed}));
    return payload(req).claims.map(c=>judged(req,c,source,/翌年2月1日から3月15日/,round===1?'食い違い':'裏付けあり',fixed));
  }});
  assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert(r.record.repair_warning||r.record.corrections.some(c=>!c.resolved));
},'false'));

async function manyRecipients(count, opus, extra={}) {
  const source=material('ta:4508'),body=Array.from({length:count},(_,i)=>String.fromCharCode(0x4e00+i)+wrongRecipient).join('\n');
  const glm=async req=>req.task==='extract'?extract(req,'要件','住宅取得等資金の贈与の非課税').map((c,i)=>({...c,type:['要件','判定','手続'][i%3]}))
    :payload(req).claims.map(c=>judged(req,c,source,/直系卑属/,'食い違い',rightRecipient));
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,...extra,
    callLLM:extra.callLLM || (async req=>req.task==='confirm'?opus(req,source):glm(req))});
  return {r,body};
}

test('03b-H1','上限を超える要件・判定・手続の3件も承認停止に残す',async()=>feature(async()=>{
  const {r,body}=await manyRecipients(51,req=>payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'})));
  assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.remaining.length,51);
  const overflow=r.record.claims.filter(c=>c.confirm.reason.includes('上限'));assert.equal(overflow.length,3);assert.deepEqual(new Set(overflow.map(c=>c.type)),new Set(['要件','判定','手続']));
  assert.equal(r.record.confirm.calls,6);
}));

for(const type of ['要件','判定','手続'])test('03b-M2',`兄弟の根拠による${type}の正しいという答えも採らない`,async()=>feature(async()=>{
  const family=material('ta:4511'),body='受贈者は18歳以上の者に限られます。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4510','ta:4511'],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,type,'直系尊属からの贈与の非課税');
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,family,/18歳以上50歳未満/,'正しい'));
    return payload(req).claims.map(c=>judged(req,c,family,/18歳以上50歳未満/,'食い違い','受贈者は18歳以上50歳未満の者に限られます。'));
  }});assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.claims[0].confirm.verdict,'判断できない');
}));

for(const type of ['金額','期限'])test('03b-M3',`${type}の修正は制度名の語か同じ話題を必要とする`,async()=>feature(async()=>{
  const body='住宅取得等資金の非課税限度額は省エネ等住宅で1,200万円です。',fixed='贈与税の申告は翌年2月1日から3月15日までに行います。';
  const finding={id:'c1',sentence:body,claim:body,subject:'住宅取得等資金の贈与の非課税',type,status:type==='期限'?'期限の書き漏れ':'食い違い',correct:fixed,quote:material('ta:4508').text,evidence:[]};
  const r=await F.repairBody(body,[finding],async()=>[{id:'c1',replacement:fixed}],{writer_materials:['ta:4508']});
  assert.equal(r.body,body);assert.equal(r.rejected.get('c1'),'元の文の話題を残していません');
},'false'));

for(const form of ['前置きと後書き','コードフェンス','JSONオブジェクト'])test('03b-L1',`${form}のある答えも既存のJSON読み取りで採る`,async()=>feature(async()=>{
  const r=await recipientCase((req,source)=>{
    const rows=payload(req).claims.map(c=>confirmed(req,c,source,/直系卑属/,'誤り',rightRecipient));
    if(form==='JSONオブジェクト')return JSON.stringify(rows[0]);
    return form==='コードフェンス'?'```json\n'+JSON.stringify(rows)+'\n```':'資料で確認しました。\n'+JSON.stringify(rows)+'\n以上です。';
  });assert.equal(r.body,rightRecipient);assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.rewritten,1);
}));

test('03b-L2','即時の資料はdynamicSystemへ置き、本文のキャッシュ書き込みを付けない',async()=>feature(async()=>{
  const CM=require('../content-model'),GW=require('../gateway-model'),B=require('../article-prompt-builder'),generate=CM.generateContent,gateway=GW.callGateway,source=material('ta:4508');let called=0,expectedInput=0,evidenceChars=0;
  try{
    GW.callGateway=async req=>req.task==='extract'?extract(req,'要件','住宅取得等資金の贈与の非課税')
      :payload(req).claims.map(c=>judged(req,c,source,/直系卑属/,'食い違い',rightRecipient));
    CM.generateContent=async(prompts,options)=>{
      called++;assert(!prompts.staticSystem.includes('[資料 '));assert(prompts.dynamicSystem.includes('[資料 1]'));
      evidenceChars=prompts.dynamicSystem.length;expectedInput=prompts.staticSystem.length+evidenceChars+prompts.user.length;
      const params=B.toAnthropicRequest(prompts,{model:options.model,maxTokens:options.maxTokens,useCache:true});
      const docs=params.system.filter(block=>block.text.includes('[資料 '));assert(docs.length);assert(docs.every(block=>!block.cache_control));
      const req={system:prompts.staticSystem,dynamicSystem:prompts.dynamicSystem,user:prompts.user};return payload(req).claims.map(c=>confirmed(req,c,source,/直系卑属/,'誤り',rightRecipient));
    };
    const r=await F.checkFacts(wrongRecipient,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load});
    assert.equal(r.record.status,'ok');assert.equal(called,1);assert.equal(r.record.calls.at(-1).evidence_chars,evidenceChars);assert.equal(r.record.calls.at(-1).input_chars,expectedInput);
  }finally{CM.generateContent=generate;GW.callGateway=gateway;}
}));

for(const recover of [true,false])test('03b-L3',`出力上限は半分の4件ずつへ一度だけ分ける（${recover?'回復':'再度上限'}）`,async()=>feature(async()=>{
  const sizes=[];
  const {r}=await scatteredHome(8,(req,source)=>{
    const rows=payload(req).claims;sizes.push(rows.length);assert.equal(req.maxTokens,16000);
    if(!req.retry||!recover)return {text:'[',stop_reason:'max_tokens'};
    const page=materials(req).find(p=>p.url===source.url);return rows.map(c=>({id:c.id,verdict:'正しい',evidence_id:page.number,basis:H.basisFor(page,c.sentence)}));
  });
  assert.deepEqual(sizes,[8,4,4]);assert.equal(r.record.confirm.calls,3);assert.equal(r.record.status,recover?'ok':'revise');assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.retry||c.stop_reason==='max_tokens'));
}));

test('03b-L3','分割の再試行も記事全体の6回に含め、超えた分は停止へ残す',async()=>feature(async()=>{
  const {r,body}=await manyRecipients(25,()=>({text:'[',stopReason:'max_tokens'}));
  assert.equal(r.record.confirm.calls,6);assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.remaining.length,25);assert(r.record.claims.some(c=>c.confirm.reason.includes('上限')));
}));

for(const keep of [false,true])test('03b-L4',`資料なしの一般化で同じ文の裏付け済み2000万円を${keep?'残せば採る':'消せば落とす'}`,async()=>feature(async()=>{
  const source=material('ta:4452'),sentence='配偶者控除は2,000万円、受贈者は18歳未満であれば対象です。',others=['甲','乙','丙','丁'].map(s=>s+'の配偶者控除は2,000万円です。'),body=[sentence,...others].join('\n');
  const replacement=keep?'配偶者控除は2,000万円です。対象要件は国税庁で確認してください。':'贈与税の配偶者控除の要件は国税庁で確認してください。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,findQaByKeywords:()=>[],callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','贈与税の配偶者控除').flatMap((c,i)=>[{...c,claim:'配偶者控除は2,000万円'},...(i===0?[{...c,type:'要件',claim:'受贈者は18歳未満であれば対象です。'}]:[])]);
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'誤り',replacement));
    return payload(req).claims.map(c=>c.type==='要件'?{id:c.id,status:'資料なし'}:judged(req,c,source,/2,000万円/,'裏付けあり'));
  }});
  assert.equal(r.record.status,keep?'ok':'revise');assert.equal(r.record.corrections.length,keep?1:0);assert.equal(r.body,keep?[replacement,...others].join('\n'):body);assert.equal(r.record.claims.find(c=>c.type==='要件').confirm.verdict,keep?'誤り':'判断できない');
}));

for(const keep of [false,true])test('03b-L4',`部分的な数字の裏付けsupported_numbersも一般化で${keep?'残す':'消さない'}`,async()=>feature(async()=>{
  const source=material('ta:4452'),body='配偶者控除は2,000万円、別の控除は1,800万円です。',replacement=keep?'配偶者控除は2,000万円です。別の控除の要件は国税庁で確認してください。':'控除額は国税庁で確認してください。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,findQaByKeywords:()=>[],callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','贈与税の配偶者控除');
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'誤り',replacement));
    return payload(req).claims.map(c=>judged(req,c,source,/2,000万円/,'裏付けあり'));
  }});assert(r.record.claims[0].supported_numbers.length);assert.equal(r.body,keep?replacement:body);assert.equal(r.record.status,keep?'ok':'revise');
}));

test('03b-L5','即時の確かめは最大3回並行し、遅い1回のほかも処理する',async()=>feature(async()=>{
  let active=0,peak=0;
  const {r}=await manyRecipients(25,async req=>{
    active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,10));return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));}finally{active--;}
  });assert.equal(peak,3);assert.equal(active,0);assert.equal(r.record.confirm.calls,4);assert.equal(r.record.status,'revise');
}));

// 実際のAnthropic送受信の形だけを使い、HTTP・待ち・GLMは全て試験用に差し替える。
async function withConfirmTransport(settings, run) {
  const GW=require('../gateway-model'),savedGateway=GW.callGateway,savedFetch=global.fetch,source=material('ta:4508');
  const stats={batchPosts:0,sync:0,cancels:0,peak:0,active:0,requests:[],time:0},batches=new Map(),controller=new AbortController();
  const count=settings.count??25,body=Array.from({length:count},(_,i)=>String.fromCharCode(0x4e00+i)+wrongRecipient).join('\n');
  const key=['03b','試験の認証値','0123456789'].join('-');
  const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>typeof data==='string'?data:JSON.stringify(data)});
  const message=params=>{
    assert.equal(params.model,'claude-opus-5-5');assert.equal(params.max_tokens,16000);assert.equal(params.output_config,undefined);
    const req={system:params.system.map(block=>block.text).join('\n\n'),user:params.messages[0].content.at(-1).text},rows=payload(req).claims;
    assert(params.system.filter(block=>block.text.includes('[資料 ')).every(block=>!block.cache_control));
    const truncated=settings.truncate&&rows.length>4;
    return {content:[{type:'text',text:truncated?'[':JSON.stringify(rows.map(c=>confirmed(req,c,source,/直系卑属/,'誤り',c.sentence.replace('直系尊属','直系卑属'))))}],stop_reason:truncated?'max_tokens':'end_turn',
      usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}};
  };
  try{
    GW.callGateway=async req=>req.task==='extract'?extract(req,'要件','住宅取得等資金の贈与の非課税')
      :payload(req).claims.map(c=>judged(req,c,source,/直系卑属/,'食い違い',rightRecipient));
    global.fetch=async(url,init)=>{
      assert(url.startsWith('https://api.anthropic.com/v1/messages'));assert.equal(init.headers['x-api-key'],key);
      if(url.endsWith('/batches')){
        stats.batchPosts++;const sent=JSON.parse(init.body);stats.requests.push(...sent.requests);
        assert(sent.requests.length<=6);assert.equal(new Set(sent.requests.map(item=>item.custom_id)).size,sent.requests.length);
        if(settings.createFail)return response({error:{type:'authentication_error',message:'key='+key}},401);
        const id='msgbatch03b-'+stats.batchPosts;batches.set(id,{requests:sent.requests,cancelled:false});return response({id});
      }
      const id=url.match(/\/batches\/([^/]+)/)?.[1],batch=batches.get(id);
      if(batch){
        if(url.endsWith('/cancel')){batch.cancelled=true;stats.cancels++;return response({});}
        if(url.endsWith('/results'))return response(batch.requests.map((item,i)=>({custom_id:item.custom_id,result:settings.pending&&settings.cancelEnded&&i>=(settings.finished??0)?{type:'canceled'}:settings.oneError&&i===0?{type:'errored'}:{type:'succeeded',message:message(item.params)}})).reverse().map(row=>JSON.stringify(row)).join('\n'));
        if(settings.abort)controller.abort();
        return response({processing_status:settings.pending?(batch.cancelled?(settings.cancelEnded?'ended':'canceling'):'in_progress'):'ended'});
      }
      assert(url.endsWith('/messages'));stats.sync++;stats.active++;stats.peak=Math.max(stats.peak,stats.active);
      try{await new Promise(resolve=>setTimeout(resolve,5));return settings.syncFail?response({error:{type:'api_error',message:key}},500):response(message(JSON.parse(init.body)));}finally{stats.active--;}
    };
    await env({ANTHROPIC_API_KEY:key},async()=>{
      const r=await F.checkFacts(body,{...opts,batch:settings.batch??true,batchMaxWaitMinutes:1,batchPollSeconds:5,
        batchRuntime:{now:()=>stats.time,sleep:async(ms,signal)=>{assert(!signal?.aborted);stats.time+=ms;}},
        signal:controller.signal,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load});
      await new Promise(resolve=>setImmediate(resolve));assert(!JSON.stringify(r.record).includes(key));await run({r,stats,body,key});
    });
  }finally{GW.callGateway=savedGateway;global.fetch=savedFetch;}
}

test('03b-B1','Gatewayで探した25件の確かめ4回を1つのBatchへまとめ、逆順の結果もIDで採る',async()=>feature(()=>withConfirmTransport({},async({r,stats,body})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.requests.length,4);assert.equal(stats.sync,0);assert.equal(r.record.status,'ok');assert.equal(r.body,body.replaceAll('直系尊属','直系卑属'));
  assert.equal(r.record.batch,false);assert.equal(r.record.confirm.batch,true);assert.equal(r.record.confirm.calls,4);assert.equal(r.record.confirm.input_tokens,400);assert.equal(r.record.confirm.output_tokens,80);
  assert.equal(r.record.confirm.cache_creation_input_tokens,0);assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.batch&&c.mode==='batch'&&c.usage.input_tokens===100));
  assert(r.record.summary.includes('・Opus の確かめ 25 件（書き換え 25・具体を外した 0・残す 0・判断できない 0、うち答えを採らなかった 0）・4 回'));assert.equal(r.record.rechecked.length,0);
})));

test('03b-B1','手動の即時の確かめはBatchを作らず、最大3回を並行する',async()=>feature(()=>withConfirmTransport({batch:false},async({r,stats})=>{
  assert.equal(stats.batchPosts,0);assert.equal(stats.sync,4);assert.equal(stats.peak,3);assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.batch,false);
  assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.mode==='sync'&&!c.batch));
})));

test('03b-B1','Batchの合計待ち上限を使い切れば取消を確かめてから最大3回の即時へ切り替える',async()=>feature(()=>withConfirmTransport({pending:true},async({r,stats})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.cancels,1);assert.equal(stats.sync,4);assert.equal(stats.peak,3);assert(stats.time>=60000);assert.equal(r.record.status,'ok');
  assert.equal(r.record.confirm.batch,false);assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.mode==='sync-fallback'&&!c.batch&&c.wait_seconds>=60));
})));

test('03b-B1','Batch作成が失敗しても鍵を出さず即時へ切り替える',async()=>feature(()=>withConfirmTransport({createFail:true},async({r,stats})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.sync,4);assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.calls,4);
  assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.mode==='sync-fallback'&&c.batch_error.includes('[秘匿]')));
})));

for(const finished of [0,1])test('03b-B1',`取消が完了したBatchは成功済み${finished}要求を残し、取消済みだけ即時へ戻す`,async()=>feature(()=>withConfirmTransport({pending:true,cancelEnded:true,finished},async({r,stats})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.cancels,1);assert.equal(stats.sync,4-finished);assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.calls,4);
  assert.equal(r.record.calls.filter(c=>c.task==='confirm'&&c.mode==='batch').length,finished);assert.equal(r.record.calls.filter(c=>c.task==='confirm'&&c.mode==='sync-fallback').length,4-finished);
  assert.equal(r.record.confirm.input_tokens,400);assert.equal(r.record.confirm.output_tokens,80);
})));

test('03b-B1','Batch内の1回だけが失敗したら、その8件だけを止めて成功した17件は採る',async()=>feature(()=>withConfirmTransport({oneError:true},async({r,stats})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.sync,0);assert.equal(r.record.status,'revise');assert.equal(r.record.corrections.length,17);assert.equal(r.record.confirm.unknown,8);
  assert.equal(r.record.remaining.length,8);assert.equal(r.record.confirm.input_tokens,300);assert.equal(r.record.confirm.usage_complete,false);
})));

test('03b-B1','即時への切替も失敗した場合は実際のmodeを記録して全ての食い違いを止める',async()=>feature(()=>withConfirmTransport({createFail:true,syncFail:true},async({r,stats,body})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.sync,4);assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.remaining.length,25);
  assert.equal(r.record.confirm.batch,false);assert(r.record.calls.filter(c=>c.task==='confirm').every(c=>c.mode==='sync-fallback'&&!c.batch));
})));

test('03b-B1','親の中断ではBatchを取り消し、即時へ戻さず食い違いを止める',async()=>feature(()=>withConfirmTransport({abort:true},async({r,stats,body})=>{
  assert.equal(stats.batchPosts,1);assert.equal(stats.cancels,1);assert.equal(stats.sync,0);assert.equal(r.body,body);assert.equal(r.record.status,'revise');assert.equal(r.record.remaining.length,25);
})));

test('03b-B1','出力上限後の半分ずつの確かめもまとめて送り、再試行を含め3回と記録する',async()=>feature(()=>withConfirmTransport({count:8,truncate:true},async({r,stats})=>{
  assert.equal(stats.batchPosts,2);assert.deepEqual(stats.requests.map(item=>JSON.parse(item.params.messages[0].content.at(-1).text).claims.length),[8,4,4]);
  assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.calls,3);assert.equal(r.record.calls.filter(c=>c.task==='confirm'&&c.stop_reason==='max_tokens').length,1);
})));

test('03b-入力','実地の照合の入力はboolean既定falseで、変数の上書きはenvの中だけにする',()=>{
  const fs=require('fs'),path=require('path'),text=fs.readFileSync(path.resolve(__dirname,'../../../.github/workflows/fact-check.yml'),'utf8');
  for(const input of ['writer_materials','confirm']){
    const section=text.match(new RegExp('      '+input+':\\n([\\s\\S]*?)(?=\\n      [a-z_]+:|\\npermissions:)'))?.[1];assert(section,input);
    assert(section.includes('type: boolean'));assert(section.includes('default: false'));
  }
  assert(text.includes("FACT_CHECK_WRITER_MATERIALS: ${{ inputs.writer_materials && 'true' || vars.FACT_CHECK_WRITER_MATERIALS }}"));
  assert(text.includes("FACT_CHECK_CONFIRM: ${{ inputs.confirm && 'true' || vars.FACT_CHECK_CONFIRM }}"));
  const runs=[...text.matchAll(/        run: \|\n([\s\S]*?)(?=\n      - |$)/g)].map(m=>m[1]).join('\n');
  assert(!runs.includes('inputs.writer_materials'));assert(!runs.includes('inputs.confirm'));
});

test('C4', '正しいという答えにも引用と数字の実在を求める',async()=>feature(async()=>{
  const r=await spouseCase((req,source)=>payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'正しい')));
  assert.equal(r.record.status,'revise');assert.equal(r.body,spouseBody);assert.equal(r.record.claims[0].confirm.verdict,'判断できない');
}));

// 03c: 記録の枝も実際の確かめと同じ関数を使う。公開APIは増やさない。
const fs03c=require('fs'),path03c=require('path'),Module03c=require('module');
const private03c=new Module03c(require.resolve('../fact-check'),module);
private03c.filename=require.resolve('../fact-check');private03c.paths=module.paths;
private03c._compile(fs03c.readFileSync(private03c.filename,'utf8')+'\nmodule.exports.validate03c=validateConfirmation;',private03c.filename);
const U03c=require('../fact-units'),CF03c=require('../fact-confirm');
function page03c(ref,number=1){return {number,id:ref.id,ref,source:ref.text,units:U03c.splitUnits(ref.text,{material:true})};}
const diagnostic03c=(answer,code,called=true)=>{
  assert.equal(answer.verdict,'判断できない');assert.equal(answer.rejected?.code,code);
  assert.equal(typeof answer.rejected.detail,'string');assert(answer.rejected.detail.length<=200);
  assert(Array.isArray(answer.pages));assert(answer.pages.length<=12);
  assert(called?Number.isInteger(answer.call)&&answer.call>=1:answer.call===null);
};
async function missing03c(sentence,type,replacement,extra={}){
  const source=material('ta:4508'),supported='受贈者は18歳以上であることが要件です。';
  const body=sentence+'\n'+['甲','乙','丙','丁'].map(s=>s+supported).join('\n');
  return F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,...extra,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税').map((c,i)=>({...c,...(i===0?{type,subject:sentence.startsWith('取消届出')?'取消届出':sentence.startsWith('下請代金')?'下請代金':c.subject}:{})}));
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement,reason:'見せられた資料に具体の裏付けも否定も無い'}));
    return payload(req).claims.map(c=>c.claim===sentence?{id:c.id,status:'資料なし'}:judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});
}

for(const [code,reply]of [
  ['basis_unreadable',(req,s)=>payload(req).claims.map(c=>({...confirmed(req,c,s,/2,000万円/,'誤り',spouseBody.replace('2,500','2,000')),basis:'文の番号ではない'}))],
  ['replacement_missing',(req,s)=>payload(req).claims.map(c=>confirmed(req,c,s,/2,000万円/,'誤り'))],
  ['replacement_numbers',(req,s)=>payload(req).claims.map(c=>confirmed(req,c,s,/2,000万円/,'誤り',spouseBody.replace('2,500','2,100')))],
  ['repair_rejected',(req,s)=>payload(req).claims.map(c=>confirmed(req,c,s,/2,000万円/,'誤り',spouseBody.replace('2,500','2,000')+'\n改行'))],
  ['secret',(req,s)=>payload(req).claims.map(c=>confirmed(req,c,s,/2,000万円/,'誤り','sk-test-confirm-secret123456789'))],
  ['answer_shape',()=>[]],['max_tokens',()=>({text:'[',stop_reason:'max_tokens'})],
  ['call_failed',()=>{throw Error('API失敗 sk-test-confirm-secret123456789');}],
])test('03c-R1',code+'の答え・診断・資料表・呼び出し番号を記録する',async()=>feature(async()=>{
  const r=await spouseCase(reply),c=r.record.claims[0].confirm;diagnostic03c(c,code);
  if(!['answer_shape','max_tokens','call_failed'].includes(code)){assert(c.answer);assert.equal(c.answer.evidence_id,material('ta:4452').id);}
  else assert(!c.answer);
  assert.equal(r.record.confirm.rejected_codes[code],1);assert.equal(r.record.status,'revise');assert.equal(r.body,spouseBody);
  assert(!JSON.stringify(r.record).includes('sk-test-confirm-secret123456789'));
}));

test('03c-R1','page_not_offeredでも同じ回の別の指摘の番号から元の資料idを記録する',async()=>feature(async()=>{
  const home=material('ta:4508'),spouse=material('ta:4452'),shared=material('ta:4511');
  const body='住宅取得等資金の非課税限度額は1,200万円です。\n'+spouseBody;
  const select=c=>[c.subject.includes('住宅')?home:spouse,shared];
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4452','ta:4511'],searchWriterEvidence:select,searchEvidence:select,loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','仮').map(c=>({...c,subject:c.claim.includes('非課税限度額')?'住宅取得等資金の贈与の非課税':'贈与税の配偶者控除'}));
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,spouse,/2,000万円/,'誤り',c.sentence.replace(/1,200|2,500/,'2,000')));
    return payload(req).claims.map(c=>judged(req,c,select(c)[0],c.subject.includes('住宅')?/1,000万円/:/2,000万円/,'食い違い','2,000万円'));
  }});
  const c=r.record.claims[0].confirm;diagnostic03c(c,'page_not_offered');assert.equal(c.answer.evidence_id,spouse.id);
  assert(!c.pages.some(p=>p.id===spouse.id));assert.equal(c.call,r.record.claims[1].confirm.call);
}));

test('03c-R1','rewrite_sourceは兄弟4511の18歳以上50歳未満を採らず残す',async()=>feature(async()=>{
  const family=material('ta:4511'),body='受贈者は18歳以上の者に限られます。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4510','ta:4511'],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','直系尊属からの贈与の非課税');
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,family,/18歳以上50歳未満/,'誤り','受贈者は18歳以上50歳未満の者に限られます。'));
    return payload(req).claims.map(c=>judged(req,c,family,/18歳以上50歳未満/,'食い違い','受贈者は18歳以上50歳未満の者に限られます。'));
  }});diagnostic03c(r.record.claims[0].confirm,'rewrite_source');assert.equal(r.body,body);assert.equal(r.record.status,'revise');
}));

test('03c-R1','quote_insufficientは計算した3300円を所令103の引用で正しいとしない',async()=>feature(async()=>{
  const source=material('law:shotokuzei_rei:103'),body='1着あたりに直すと3,300円になります。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['law:shotokuzei_rei:103'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','売上原価');
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,source,/棚卸/,'正しい'));
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));

test('03c-R1','quote_missingは番号の原文と保存した資料の本文が一致しない場合を記録する',async()=>{
  const source=material('ta:4452'),page=page03c(source),unit=page.units.find(u=>/2,000万円/.test(u.text));
  const finding={id:'c1',type:'金額',status:'食い違い',subject:'贈与税の配偶者控除',sentence:spouseBody,claim:spouseBody};
  const options={searchWriterEvidence:()=>[source],loadEvidenceText:load};
  const answers=await CF03c.confirmFindings(spouseBody,[finding],async()=>({id:'c1',verdict:'誤り',evidence_id:1,basis:String(unit.s),replacement:spouseBody.replace('2,500','2,000')}),options,
    (f,row)=>private03c.exports.validate03c(spouseBody,f,row,[{...page,ref:{...source,text:'別の本文'}}],options),()=>({}),JSON.parse,F.normalizedNumbers);
  const answer=answers.get('c1');diagnostic03c(answer,'quote_missing');assert(answer.answer);assert.equal(answer.answer.evidence_id,source.id);
});

test('03c-R1','答えの各値を600字に収めて鍵を伏せ、答えも資料本文も標準出力に出さない',async()=>feature(async()=>{
  const key='sk-test-confirm-secret123456789',messages=[],saved={log:console.log,warn:console.warn,error:console.error};
  for(const name of Object.keys(saved))console[name]=(...args)=>messages.push(args.join(' '));
  let r;
  try{r=await spouseCase(req=>payload(req).claims.map(c=>({id:c.id,verdict:'判断できない',evidence_id:'資料 1',basis:['12',key],replacement:key+'あ'.repeat(900),reason:key+'い'.repeat(900)})));}
  finally{Object.assign(console,saved);}
  const c=r.record.claims[0].confirm;assert(!c.rejected);assert.equal(r.record.confirm.verdicts['判断できない'],1);
  for(const value of Object.values(c.answer))assert(String(value).length<=600);
  assert.equal(c.answer.evidence_id,material('ta:4452').id);assert(!JSON.stringify(r.record).includes(key));
  assert(!messages.join('\n').includes(key));assert(!messages.join('\n').includes('あ'.repeat(20)));assert(!messages.join('\n').includes(material('ta:4452').text));
}));

for(const code of ['no_material','exception'])test('03c-R1',code+'は呼べなかった指摘だけに診断を付ける',async()=>{
  const source=material('ta:4452'),finding={id:'c1',type:'金額',status:'食い違い',sentence:spouseBody,claim:spouseBody};
  const r=await CF03c.confirmFindings(spouseBody,[finding],async()=>[{id:'c1',verdict:'正しい',evidence_id:1,basis:'1'}],{
    searchWriterEvidence:()=>code==='no_material'?[]:[source],loadEvidenceText:load,
  },async()=>{throw Error('検証の予期しない例外 sk-test-confirm-secret123456789');},()=>({}),ret=>Array.isArray(ret)?ret:JSON.parse(ret),F.normalizedNumbers);
  diagnostic03c(r.get('c1'),code,code!=='no_material');assert(!JSON.stringify([...r]).includes('sk-test-confirm-secret123456789'));
});

test('03c-R1','call_limitは7回目を呼ばず、未呼び出しも診断に残す',async()=>feature(async()=>{
  const {r}=await manyRecipients(49,req=>payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'})));
  diagnostic03c(r.record.claims.at(-1).confirm,'call_limit',false);assert.equal(r.record.confirm.calls,6);
  assert.equal(r.record.confirm.verdicts['判断できない'],48);assert.equal(r.record.confirm.rejected,1);
}));

test('03c-R1','usageの無い1回を除いた和・stop_reasons・答えの内訳と単一の要約を残す',async()=>feature(()=>withConfirmTransport({oneError:true},async({r})=>{
  assert.equal(r.record.confirm.input_tokens,300);assert.equal(r.record.confirm.output_tokens,60);assert.equal(r.record.confirm.usage_complete,false);
  assert.equal(r.record.confirm.stop_reasons.length,4);assert.equal(r.record.confirm.verdicts['誤り'],17);assert.equal(r.record.confirm.rejected,8);
  assert.equal((r.record.summary.match(/Opus の確かめ/g)||[]).length,1);
  assert(r.record.summary.includes('・Opus の確かめ 25 件（書き換え 17・具体を外した 0・残す 0・判断できない 8、うち答えを採らなかった 8）・4 回'));
})));

test('03c-R1','最終の本文保全で落ちても元の答えと最初の診断を残す',async()=>feature(async()=>{
  let guards=0;
  const r=await spouseCase((req,source)=>payload(req).claims.map(c=>confirmed(req,c,source,/2,000万円/,'誤り',spouseBody.replace('2,500','2,000'))),{validateRepair:()=>++guards===1});
  const c=r.record.claims[0].confirm;diagnostic03c(c,'repair_rejected');assert.equal(guards,2);assert.equal(c.answer.verdict,'誤り');assert.equal(r.body,spouseBody);assert.equal(r.record.status,'revise');
  const twice=CF03c.rejectConfirmation(c,'same_sentence','後で見つけた理由');assert.deepEqual(twice.rejected,c.rejected);
}));

for(const [type,sentence,replacement]of [
  ['要件','取消届出の期限は土日祝でも延長されない。','取消届出の期限は延長されない場合があります。'],
  ['判定','下請代金が1件100万円以上の大きい現場が中心なら登録する。','下請代金が大きい現場が中心なら登録を検討してください。'],
])test('03c-R2',type+'の資料に無い具体だけを外し、再照合せずokにする',async()=>feature(async()=>{
  const r=await missing03c(sentence,type,replacement);assert(r.body.startsWith(replacement));assert.equal(r.record.status,'ok');
  const c=r.record.corrections[0];assert(c.generalized&&c.resolved);assert.equal(c.confirm.verdict,'記載なし');assert.equal(c.confirmed_by,'claude-opus-5-5');
  assert.equal(r.record.confirm.generalized,1);assert.equal(r.record.confirm.rewritten,0);assert.equal(r.record.confirm.verdicts['記載なし'],1);
  assert(!r.record.calls.some(c=>/repair|recheck/.test(c.task)));
}));

for(const [code,sentence,replacement]of [
  ['not_stated_table','| 200万円以下 | 10% | 10% |','| 一定額以下 | 所定の税率 | 所定の税率 |'],
  ['repair_rejected','下請代金が1件100万円以上の大きい現場が中心なら登録する。','下請代金が1件200万円以上なら登録する。'],
  ['repair_rejected','下請代金が1件100万円以上の大きい現場が中心なら登録する。','下請代金が1件100万円以上の現場なら登録を検討する。'],
  ['repair_rejected','下請代金が1件100万円以上の大きい現場が中心なら登録する。','下請代金が1件100万円以上の大きい現場が中心なら登録する。'],
  ['replacement_missing','下請代金が1件100万円以上の大きい現場が中心なら登録する。',''],
])test('03c-R2',code+'で具体を外す答えを採らない: '+replacement,async()=>feature(async()=>{
  const r=await missing03c(sentence,'金額',replacement);diagnostic03c(r.record.claims[0].confirm,code);assert(r.body.startsWith(sentence));assert.equal(r.record.status,'revise');
}));

test('03c-R2','裏付けのある同じ文の数字を消す記載なしをrepair_rejectedにする',async()=>{
  const source=material('ta:4508'),sentence='受贈者は18歳以上で、住所が1年間東京都内なら適用できます。';
  const f={id:'c1',type:'要件',subject:'住宅取得等資金の贈与の非課税',status:'資料なし',sentence,claim:'住所が1年間東京都内',keep:[{claim:'受贈者は18歳以上'}]};
  const r=await private03c.exports.validate03c(sentence,f,{verdict:'記載なし',replacement:'受贈者の住所を確認してください。'},[page03c(source)],{});
  assert.equal(r?.rejected?.code,'repair_rejected');
});

for(const status of ['食い違い','期限の書き漏れ'])test('03c-R2',status+'に記載なしを認めず、03b-H1の停止を守る',async()=>feature(async()=>{
  const source=material('ta:4508');
  const r=status==='食い違い'?await spouseCase(req=>payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement:'贈与税の配偶者控除の額を確認してください。'}))):
    await F.checkFacts('住宅取得等資金の贈与は非課税です。',{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
      if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
      if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement:'住宅取得等資金の贈与は国税庁で確認してください。'}));
      return payload(req).claims.map(c=>judged(req,c,source,/令和8年12月31日/,'期限の書き漏れ','令和8年12月31日'));
    }});
  assert.equal(r.record.claims[0].status,status);
  diagnostic03c(r.record.claims[0].confirm,'not_stated_status');assert.equal(r.record.status,'revise');
}));

test('03c-R2','機械の確かめを通った9文はすべてnot_stated_limitで外さない',async()=>feature(async()=>{
  const source=material('ta:4452'),missing=Array.from({length:9},(_,i)=>`${String.fromCharCode(0x4e00+i)}の贈与税の配偶者控除は100万円です。`),body=missing.join('\n');
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4452'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','贈与税の配偶者控除');
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement:c.sentence.replace('100万円','所定の額')}));
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});assert.equal(r.body,body);assert.equal(r.record.corrections.length,0);assert.equal(r.record.status,'revise');
  for(const c of r.record.claims)diagnostic03c(c.confirm,'not_stated_limit');assert(r.record.summary.includes('・資料に記載の無い具体が多いため外していません'));
}));

test('03c-R2','1文でも主張の2割を超えれば具体を外さず、要件の不採用は人の一覧へ残す',async()=>feature(async()=>{
  const numeric=await spouseCase(req=>payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement:'贈与税の配偶者控除の額を確認してください。'})),{missing:true,body:'贈与税の配偶者控除は100万円です。'});
  diagnostic03c(numeric.record.claims[0].confirm,'not_stated_limit');assert.equal(numeric.record.status,'revise');assert.equal(numeric.record.corrections.length,0);
  const review=await missing03c('取消届出の期限は土日祝でも延長されない。','要件','');
  diagnostic03c(review.record.claims[0].confirm,'replacement_missing');assert.equal(review.record.status,'ok');assert(review.record.review_items.some(c=>c.id===review.record.claims[0].id));
}));

test('03c-R3-1','株の記事の手がかりを外した実カタログ検索から相法21の7も資料に加える',async()=>feature(async()=>{
  const root='https://www.nta.go.jp/taxes/shiraberu/taxanswer/',body='## 【手順③】贈与税額を計算する\n| 200万円以下 | 10% | 10% |';let offered=[];
  const r=await F.checkFacts(body,{...opts,source_url:root+'hyoka/4638.htm',source_bundle:[root+'hyoka/4638.htm',root+'zoyo/4429.htm',root+'sozoku/4103.htm',root+'sozoku/4602.htm',root+'sozoku/4152.htm','評基通168','評基通178','相続税法28条','相続税法33条','相続税法38条','相続税法39条','相続税法62条','相続税法21条の5'].join(';'),
    source_supplements:[root+'zoyo/4429.htm',root+'sozoku/4103.htm',root+'sozoku/4602.htm'],tax_terms:'取引相場のない株式の評価 財産評価基本通達 贈与税の申告 相続時精算課税',tax_domain:'inheritance_tax',
    writer_materials:'ta:4152;ta:4124;ta:4158;ta:4205;ta:4638;ta:4429;ta:4103;ta:4602;tsutatsu:hyoka:168;tsutatsu:hyoka:178;law:sozokuzei:28;law:sozokuzei:33;law:sozokuzei:38;law:sozokuzei:39;law:sozokuzei:62;law:sozokuzei:21_5;qa:sozoku/r5kaisei-2-4;qa:sozoku/r5kaisei-2-1;qa:sozoku/r5kaisei-2-2;https://www.nta.go.jp/law/shitsugi/hyoka/15/12.htm;tsutatsu:hyoka:10;tsutatsu:hyoka:33;https://www.nta.go.jp/law/shitsugi/hyoka/13/02.htm;https://www.nta.go.jp/law/shitsugi/hyoka/08/05.htm;ta:4408;ta:4161;law:sozeki_hou:70_2_4;ta:4301;change:r8_education_fund_gift_end;change:gift_tax_seven_year_addback'.split(';'),loadEvidenceText:load,callLLM:async req=>{
      if(req.task==='extract')return extract(req,'割合','贈与税の税率');
      if(req.task==='confirm'){offered=materials(req).map(p=>p.url);return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));}
      return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
    }});
  assert(offered.includes(material('law:sozokuzei:21_7').url));assert.equal(r.body,body);
  assert(r.record.claims[0].confirm.pages.some(p=>p.id==='law:sozokuzei:21_7'));
  console.log('03c-R3-1 資料id: '+r.record.claims[0].confirm.pages.map(p=>W.materialId(p)).join(';'));
}));

for(const [arabic,kanji]of [['15日前','十五日前'],['200万円','二百万円']])test('03c-R3-2',arabic+'と'+kanji+'を同じ数字として抜粋を選び原文を保つ',async()=>feature(async()=>{
  const text=Array.from({length:80},(_,i)=>`第${i+1}項 届出書の課税期間は、届出書と課税期間に関する記載${'説明'.repeat(30)}。`).join('\n')+`\n取消しは${kanji}を期限とし、${'取消しの原文'.repeat(30)}とする。`;
  const source={id:'law:test:cancel',kind:'law',title:'取消届出',url:'https://example.test/cancel',text},body=`取消届出書は戻したい課税期間の初日から起算して${arabic}まで。`;let shown='';
  await F.checkFacts(body,{...opts,writer_materials:['ta:6501'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'期限','取消届出書');
    if(req.task==='confirm'){shown=req.dynamicSystem;return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));}
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});assert(shown.includes(kanji));assert(shown.length<=3000);assert.equal(source.text,text);
}));

const familySentence03c='平成27年4月1日から令和11年3月31日までの間に、18歳以上50歳未満の受贈者が、結婚・子育て資金として贈与を受けた1,000万円までの金額に相当する部分が非課税になります。';
async function family03c(mode){
  const source=material('ta:4511'),fixed=familySentence03c.replace('令和11年','令和9年');
  return F.checkFacts(familySentence03c,{...opts,writer_materials:['ta:4511'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract'){const s=extract(req,'期限','結婚・子育て資金の一括贈与')[0].s;return [{s,type:'期限',subject:'結婚・子育て資金の一括贈与',claim:'平成27年4月1日から令和11年3月31日まで'},{s,type:'要件',subject:'結婚・子育て資金の一括贈与',claim:'受贈者は18歳以上50歳未満'}];}
    if(req.task==='confirm'){assert.equal(payload(req).claims.length,2);return payload(req).claims.map(c=>confirmed(req,c,source,c.type==='期限'?/令和9年/:/18歳以上50歳未満/,c.type==='期限'||mode==='別々'?'誤り':'正しい',c.type==='期限'?(mode==='消す'?fixed.replace('18歳以上50歳未満の',''):fixed):mode==='別々'?fixed.replace('の受贈者が','の方が'):''));}
    return payload(req).claims.map(c=>judged(req,c,source,c.type==='期限'?/令和9年/:/18歳以上50歳未満/,'食い違い',c.type==='期限'?'令和9年3月31日まで':'受贈者は18歳以上50歳未満'));
  }});
}
for(const mode of ['残す','消す','別々'])test('03c-R4','同じ文の正しい年齢を'+mode+'場合の書き換えを確かめる',async()=>feature(async()=>{
  const r=await family03c(mode);assert.equal(r.record.status,mode==='残す'?'ok':'revise');
  assert.equal(r.body,mode==='残す'?familySentence03c.replace('令和11年','令和9年'):familySentence03c);
  if(mode!=='残す')diagnostic03c(r.record.claims[0].confirm,'same_sentence');
}));

test('03c-R4','8件の境目にある同じ文の2指摘を分けず次の回へまとめる',async()=>{
  const source=material('ta:4508'),findings=Array.from({length:9},(_,i)=>({id:'c'+i,type:'要件',status:'食い違い',subject:'住宅取得等資金の贈与の非課税',sentence:i<7?'別の文'+i:'同じ文',claim:'受贈者'})),requests=[];
  await CF03c.confirmFindings('',findings,async req=>{requests.push(payload(req).claims.map(c=>c.id));return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));},{searchWriterEvidence:()=>[source],loadEvidenceText:load},()=>null,()=>({}),ret=>Array.isArray(ret)?ret:JSON.parse(ret),F.normalizedNumbers);
  assert.deepEqual(requests.map(r=>r.length),[7,2]);assert(requests.some(ids=>ids.includes('c7')&&ids.includes('c8')));
});

test('03c-R4','同じ文の採れない答えは直さず、同じ文の組は出力上限の再試行でも分けない',async()=>{
  const source=material('ta:4452'),findings=['c1','c2'].map(id=>({id,type:'金額',subject:'贈与税の配偶者控除',status:'食い違い',sentence:spouseBody,claim:spouseBody})),sizes=[];
  const answers=await CF03c.confirmFindings(spouseBody,findings,async req=>{sizes.push(payload(req).claims.length);return sizes.length===1?{stopReason:'max_tokens'}:payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));},
    {searchWriterEvidence:()=>[source],loadEvidenceText:load},()=>null,()=>({}),ret=>ret,F.normalizedNumbers);
  assert.deepEqual(sizes,[2,2]);assert.equal(answers.get('c1').call,2);assert.equal(answers.get('c2').call,2);
  assert.equal(answers.get('c1').answer.verdict,'判断できない');assert(!answers.get('c1').rejected);
});

// 03dの入力は実地の記録から固定し、試験時に一時ファイルを読まない。
const soloOptions03d={tax_domain:'invoice_system',
  source_url:'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6451.htm',source_bundle:'',
  source_supplements:['6498','6613','6630'].map(n=>'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/'+n+'.htm'),
  tax_terms:'適格請求書発行事業者 仕入税額控除 免税事業者 課税事業者選択届出書',
  writer_materials:'ta:6501;ta:6505;ta:6498;ta:6451;ta:6613;ta:6630;qa:invoice/17;qa:invoice/07;qa:invoice/130;qa:invoice/01;qa:invoice/02;qa:invoice/17-2;ta:6467;qa:invoice/114;qa:invoice/117;ta:6509;change:r8_invoice_30pct_special;change:invoice_transitional_measures'.split(';')};
const stockOptions03d={tax_domain:'inheritance_tax',
  source_url:'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm',
  source_supplements:['zoyo/4429','sozoku/4103','sozoku/4602'].map(s=>'https://www.nta.go.jp/taxes/shiraberu/taxanswer/'+s+'.htm'),
  source_bundle:'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4429.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4602.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm;評基通168;評基通178;相続税法28条;相続税法33条;相続税法38条;相続税法39条;相続税法62条;相続税法21条の5',
  tax_terms:'取引相場のない株式の評価 財産評価基本通達 贈与税の申告 相続時精算課税',
  writer_materials:'ta:4152;ta:4124;ta:4158;ta:4205;ta:4638;ta:4429;ta:4103;ta:4602;tsutatsu:hyoka:168;tsutatsu:hyoka:178;law:sozokuzei:28;law:sozokuzei:33;law:sozokuzei:38;law:sozokuzei:39;law:sozokuzei:62;law:sozokuzei:21_5;qa:sozoku/r5kaisei-2-4;qa:sozoku/r5kaisei-2-1;qa:sozoku/r5kaisei-2-2;https://www.nta.go.jp/law/shitsugi/hyoka/15/12.htm;tsutatsu:hyoka:10;tsutatsu:hyoka:33;https://www.nta.go.jp/law/shitsugi/hyoka/13/02.htm;https://www.nta.go.jp/law/shitsugi/hyoka/08/05.htm;ta:4408;ta:4161;law:sozeki_hou:70_2_4;ta:4301;change:r8_education_fund_gift_end;change:gift_tax_seven_year_addback'.split(';')};
const cancelClaim03d={id:'c32',type:'期限',subject:'インボイス登録の取消し',heading:'登録のデメリットと注意点',
  sentence:'- 免税事業者に戻すための取消届出書は、戻したい課税期間の初日から起算して15日前まで。',
  claim:'取消届出書は戻したい課税期間の初日から起算して15日前まで',status:'資料なし',glm_answer:{status:'資料なし',evidence:'',basis:'',correct:''}};
const stockClaims03d=[
  ['c38','| 200万円以下 | 10% | 10% |','基礎控除後の課税価格200万円以下は特例・一般とも10%'],
  ['c39','| 300万円以下 | 10% | 15%（控除10万円） |','基礎控除後300万円以下は特例10%、一般15%で控除10万円'],
  ['c40','| 400万円以下 | 15%（控除10万円） | 20%（控除25万円） |','基礎控除後400万円以下は特例15%控除10万円、一般20%控除25万円'],
  ['c41','| 600万円以下 | 20%（控除30万円） | 30%（控除65万円） |','基礎控除後600万円以下は特例20%控除30万円、一般30%控除65万円'],
  ['c42','| 1,000万円以下 | 30%（控除90万円） | 40%（控除125万円） |','基礎控除後1,000万円以下は特例30%控除90万円、一般40%控除125万円'],
].map(([id,sentence,claim])=>({id,sentence,claim,type:'割合',subject:'贈与税の税率',heading:'【手順③】贈与税額を計算する',status:'資料なし'}));
async function catalogCase03d(finding,options){
  let shown;
  const body='## '+finding.heading+'\n'+finding.sentence;
  const result=await F.checkFacts(body,{...opts,...options,loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return [{s:extract(req,finding.type,finding.subject)[0].s,type:finding.type,subject:finding.subject,claim:finding.claim}];
    if(req.task==='confirm'){shown=req;return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));}
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});
  assert(shown,'確かめまで実行する');assert.notEqual(result.record.status,'not_run');
  return {result,shown,pages:result.record.claims[0].confirm.pages};
}
test('03d-M1','c32の15日前の根拠を本物のQ&A問13または消令70の5の抜粋に入れる',async()=>feature(async()=>{
  const {shown,pages}=await catalogCase03d(cancelClaim03d,soloOptions03d);
  const roots=pages.filter(p=>['qa:invoice/13','law:shohizei_rei:70_5'].includes(W.materialId(p)));assert(roots.length);
  assert(materials(shown).some(p=>roots.some(r=>r.number===p.number)&&p.rows.some(u=>/15\s*日前の日|十五日前の日/.test(u.text))));
  console.log('03d-M1 c32: '+pages.map(W.materialId).join(';'));
}));
test('03d-M1','c38の実地の要約でもNo.4408か相法21の7を引き続き渡す',async()=>feature(async()=>{
  const {shown,pages}=await catalogCase03d(stockClaims03d[0],stockOptions03d);
  assert(pages.some(p=>['ta:4408','law:sozokuzei:21_7'].includes(W.materialId(p))));
  assert(materials(shown).some(p=>/200|二百/.test(p.text)&&/10|十分|百分/.test(p.text)));
}));
for(const number of ['15','１５','十五'])test('03d-M1',number+'日前と法律の委任先の条を照らして消令70の5を追加する',async()=>feature(async()=>{
  const law=material('law:shohizei_hou:57_2'),finding={...cancelClaim03d,sentence:cancelClaim03d.sentence.replace('15',number),claim:cancelClaim03d.claim.replace('15',number)};
  const {pages}=await catalogCase03d(finding,{...soloOptions03d,searchWriterEvidence:()=>[law],searchEvidence:()=>[],findQaByKeywords:()=>[]});
  assert(pages.some(p=>p.id==='law:shohizei_rei:70_5'));
  assert(pages.some(p=>p.id==='qa:invoice/13'));
}));
test('03d-M1','Q&Aの主題の範囲と、委任の法律の条・数字の両方を守る',async()=>feature(async()=>{
  const plain={...cancelClaim03d,subject:'取消届出',sentence:'取消届出書を15日前までに提出します。',claim:'取消届出書を15日前までに提出します。'};
  const options={...soloOptions03d,searchEvidence:()=>[],findQaByKeywords:()=>[]};
  const first=await catalogCase03d(plain,{...options,searchWriterEvidence:()=>[material('law:shohizei_hou:57_3')]});
  assert(!first.pages.some(p=>p.id.startsWith('qa:')));assert(!first.pages.some(p=>p.id==='law:shohizei_rei:70_5'));
  const second=await catalogCase03d({...plain,sentence:plain.sentence.replace('15','999999'),claim:plain.claim.replace('15','999999')},{...options,searchWriterEvidence:()=>[material('law:shohizei_hou:57_2')]});
  assert(!second.pages.some(p=>p.id==='law:shohizei_rei:70_5'));
}));

async function meaningCase03d({sentence,claim=sentence,replacement,subject='取消届出の期限',heading='手続の注意点',prev=''}){
  const source=material('ta:4508'),body='## '+heading+'\n'+(prev?prev+'\n':'')+sentence+'\n'+['甲','乙','丙','丁'].map(s=>s+'受贈者は18歳以上です。').join('\n');
  return F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税').filter(c=>c.claim!==prev).map(c=>({...c,...(c.claim===sentence?{type:'判定',subject,claim}:{})}));
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement,reason:'提示資料に記載がない'}));
    return payload(req).claims.map(c=>c.subject===subject?{id:c.id,status:'資料なし'}:judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});
}
const meaningCases03d=[
  ['①否定の向き','取消届出の期限は土日祝でも延長されない。','土日祝なら翌日に延長される。'],
  ['②関係ない一般論','取消届出の期限は土日祝でも延長されない。','詳しくは税務署に相談してください。'],
  ['③誤解の例','父母それぞれから住宅資金をもらえば枠が2倍になると考える。','住宅資金の非課税枠は増えます。','父母それぞれから住宅資金をもらっても枠は増えない','住宅資金の非課税','よくある誤解'],
  ['④何も外していない','取消届出の期限は土日祝でも延長されない。','取消届出の期限は土日祝でも延長されない点に注意します。'],
  ['⑤要約に無い数字','下請代金が1件100万円以上の大きい現場が中心なら登録する。','下請代金が1件100万円以上の現場なら登録します。','大きい現場が中心なら登録する','下請代金'],
];
for(const [name,sentence,replacement,claim,subject,heading]of meaningCases03d)test('03d-M2',name+'を記載なしの書き換えに採らない',async()=>feature(async()=>{
  const r=await meaningCase03d({sentence,replacement,claim,subject,heading}),c=r.record.claims.find(c=>c.sentence===sentence);
  assert(c?.confirm);diagnostic03c(c.confirm,'not_stated_meaning');assert(r.body.includes(sentence));assert.equal(r.record.corrections.length,0);assert.equal(r.record.confirm.generalized,0);
  assert(r.record.review_items.some(row=>row.id===c.id));
}));
for(const [name,values,detail]of [
  ['話題',{sentence:'取消届出の提出期限を確認する。',replacement:'詳しくは税務署に相談してください。'},'話題'],
  ['同じ内容',{sentence:'取消届出の期限は土日祝でも延長されない。',replacement:'取消届出の期限は土日祝でも延長されない点に注意します。'},'外して'],
  ['前の文の誤解',{sentence:'住宅資金の枠が増えると考える。',replacement:'住宅資金の枠を確認します。',subject:'住宅資金',prev:'これはよくある勘違いです。'},'誤解'],
])test('03d-M2',name+'の歯止めを個別に通す',async()=>feature(async()=>{
  const r=await meaningCase03d(values),c=r.record.claims.find(c=>c.sentence===values.sentence);diagnostic03c(c.confirm,'not_stated_meaning');assert(c.confirm.rejected.detail.includes(detail));
}));
test('03d-M2','具体を外した否定の文は採り、支持された数字だけを残せる',async()=>feature(async()=>{
  const sentence='取消届出の期限は土日祝でも延長されない。',replacement='取消届出の期限は延長されない場合があります。';
  const r=await meaningCase03d({sentence,replacement});assert(r.body.includes(replacement));assert.equal(r.record.status,'ok');assert.equal(r.record.confirm.generalized,1);
}));
test('03d-M2','要約に数字の無い判定でもkeep・supported_numbersの数字だけを残す',async()=>{
  const sentence='受贈者は18歳以上で、取消届出の期限は土日祝でも延長されない。',replacement='受贈者は18歳以上で、取消届出の期限は延長されない場合があります。';
  for(const support of [{keep:[{claim:'受贈者は18歳以上'}]},{supported_numbers:['18']}]){
    const f={id:'c1',type:'判定',subject:'取消届出',sentence,claim:'取消届出の期限は土日祝でも延長されない',status:'資料なし',...support};
    const answer=await private03c.exports.validate03c(sentence,f,{verdict:'記載なし',replacement},[],{});assert.equal(answer.verdict,'記載なし');
  }
});

for(const dropAge of [true,false])test('03d-M3','GLMだけが裏付けた年齢を'+(dropAge?'消す修正文は止める':'残す修正文は採る'),async()=>feature(async()=>{
  const source=material('ta:4511'),fixed=familySentence03c.replace('令和11年','令和9年'),replacement=dropAge?fixed.replace('18歳以上50歳未満の',''):fixed;let seen;
  const r=await F.checkFacts(familySentence03c,{...opts,writer_materials:['ta:4511'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return [{s:1,type:'期限',subject:'結婚・子育て資金の一括贈与',claim:'平成27年4月1日から令和11年3月31日まで'},{s:1,type:'要件',subject:'結婚・子育て資金の一括贈与',claim:'受贈者は18歳以上50歳未満'}];
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm'){seen=payload(req).claims;return seen.map(c=>confirmed(req,c,source,/令和9年/,'誤り',replacement));}
    return payload(req).claims.map(c=>judged(req,c,source,c.type==='期限'?/令和9年/:/18歳以上50歳未満/,c.type==='期限'?'食い違い':'裏付けあり',c.type==='期限'?'令和9年3月31日まで':''));
  }});
  assert.equal(seen.length,1);assert.equal(seen[0].type,'期限');assert.equal(r.record.status,dropAge?'revise':'ok');assert.equal(r.body,dropAge?familySentence03c:fixed);
  assert.equal(r.record.claims.find(c=>c.type==='要件').status,'裏付けあり');
}));

const privateConfirm03d=new Module03c(require.resolve('../fact-confirm'),module);privateConfirm03d.filename=require.resolve('../fact-confirm');privateConfirm03d.paths=module.paths;
privateConfirm03d._compile(fs03c.readFileSync(privateConfirm03d.filename,'utf8')+'\nmodule.exports.page03d=pageFor;',privateConfirm03d.filename);
test('03d-L1','数値の一致は1種類20点・単位で最大60点とし、GLMの引用を優先する',()=>{
  const numeric=('無関係な数値は1、2、3、4、5。').padEnd(299,'あ')+'。',anchor='引用の位置にある制度の根拠'.padEnd(299,'い')+'。',source=numeric+'\n'+anchor;
  const ref={id:'law:test:score',title:'点の試験',url:'https://example.test/score'},page={id:ref.id,ref,source,units:[{s:1,text:numeric,start:0,end:300},{s:2,text:anchor,start:301,end:601}]};
  const findings=Array.from({length:8},(_,i)=>({id:'c'+i,subject:'制度',claim:'1、2、3、4、5',sentence:'1、2、3、4、5',glm_answer:{evidence:ref.id},...(i===0?{quote:anchor}:{})}));
  const reads=[];const p=privateConfirm03d.exports.page03d(page,findings,370,1,text=>{reads.push(text);return F.normalizedNumbers(text);});
  assert(p.units.some(u=>u.s===2));assert(!p.units.some(u=>u.s===1));assert.equal(reads.filter(s=>s===numeric).length,1);assert.equal(reads.filter(s=>s===anchor).length,1);
});
for(const evidence of [undefined,'資料なし','999'])test('03d-L2','資料番号'+String(evidence)+'の診断を区別する',async()=>feature(async()=>{
  const r=await spouseCase((req,source)=>payload(req).claims.map(c=>({...confirmed(req,c,source,/2,000万円/,'誤り',spouseBody.replace('2,500','2,000')),evidence_id:evidence}))),answer=r.record.claims[0].confirm;
  diagnostic03c(answer,'page_not_offered');assert(answer.rejected.detail.includes(evidence==='999'?'この指摘':'読'));
}));
test('03d-L2','同じ回の別の指摘の資料番号は、読めない番号と分けて記録する',async()=>feature(async()=>{
  const home=material('ta:4508'),spouse=material('ta:4452'),shared=material('ta:4511'),select=c=>[c.subject.includes('住宅')?home:spouse,shared];
  const body='住宅取得等資金の非課税限度額は1,200万円です。\n'+spouseBody;
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4452','ta:4511'],searchWriterEvidence:select,searchEvidence:select,loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','仮').map(c=>({...c,subject:c.claim.includes('非課税限度額')?'住宅取得等資金の贈与の非課税':'贈与税の配偶者控除'}));
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,spouse,/2,000万円/,'誤り',c.sentence.replace(/1,200|2,500/,'2,000')));
    return payload(req).claims.map(c=>judged(req,c,select(c)[0],c.subject.includes('住宅')?/1,000万円/:/2,000万円/,'食い違い','2,000万円'));
  }});
  const answer=r.record.claims[0].confirm;diagnostic03c(answer,'page_not_offered');assert.equal(answer.answer.evidence_id,spouse.id);assert(answer.rejected.detail.includes('この指摘'));assert(!answer.rejected.detail.includes('読'));
}));

async function calculationCase03e({sentence,claim=sentence,type='期限',subject='インボイス登録の取消し',source=material('qa:invoice/13'),pattern=/15\s*日前の日/,calculation,verdict='正しい',replacement='',prev='',next=''}){
  const body='## 手続と計算\n'+(prev?prev+'\n':'')+sentence+(next?'\n'+next:'');
  return F.checkFacts(body,{...opts,writer_materials:['ta:6501'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req,type,subject).filter(c=>c.claim===sentence).map(c=>({...c,claim}));
    if(req.task==='confirm')return payload(req).claims.map(c=>{const proof=confirmed(req,c,source,pattern,verdict,replacement),rows=materials(req).find(p=>p.url===source.url).rows;return {...proof,...(source.id==='law:test:rates'?{basis:rows[0].s+'-'+rows[Math.min(1,rows.length-1)].s}:{}),...(calculation===undefined?{}:{calculation})};});
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});
}
const dateSentence03e='翌年1月1日から戻すなら、取消届出の期限は12月17日です。';
test('03e-E1','問13と1月1日から15日前の検算で12月17日を正しいと認める',async()=>feature(async()=>{
  const calculation=['1月1日−15日=12月17日'],r=await calculationCase03e({sentence:dateSentence03e,calculation});
  assert.equal(r.record.status,'ok');assert.equal(r.body,'## 手続と計算\n'+dateSentence03e);assert.equal(r.record.claims[0].confirm.verdict,'正しい');assert.deepEqual(r.record.claims[0].confirm.answer.calculation,calculation);
}));
for(const [calculation,sentence,detail]of [
  ['1月1日−15日=12月20日',dateSentence03e,'計算が合わない'],
  ['1月1日−16日=12月16日',dateSentence03e,'数の出どころが無い'],
  ['12月17日+0日=12月17日',dateSentence03e,'数の出どころが無い'],
  ['3月10日−15日=2月23日','3月10日から戻すなら、取消届出の期限は2月23日です。','計算が合わない'],
  ['1月1日−15日=12月17日','翌年1月1日から戻すなら、取消届出の期限は12月20日です。','右辺が主張に無い'],
  ['process.exit()=12月17日',dateSentence03e,'読めない'],
])test('03e-E1',calculation+'は検算の理由を残して止める',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence,calculation:[calculation]}),answer=r.record.claims[0].confirm;diagnostic03c(answer,'calculation_rejected');assert(answer.rejected.detail.includes(detail));assert.equal(r.record.status,'revise');
}));
const rates03e={id:'law:test:rates',kind:'law',title:'贈与税の税率',url:'https://example.test/rates',text:'200万円以下の金額 10%\n200万円を超え300万円以下の金額 15%'};
test('03e-E1','速算表の行は計算の答えで控除額を補わない',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'| 300万円以下 | 15%（控除10万円） |',source:rates03e,type:'割合',subject:'贈与税の税率',pattern:/200万円以下/,calculation:['200万円×15%−200万円×10%=10万円']});
  assert.equal(r.record.status,'revise');diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');
}));
test('03e-E1','前の文の330000円と100着があっても3300円の金額計算では裏付けない',async()=>feature(async()=>{
  const source=material('law:shotokuzei_rei:103'),r=await calculationCase03e({sentence:'1着あたりに直すと3,300円になります。',claim:'1着あたりの取得価額は3,300円',prev:'仕入代金は330,000円で、仕入れた数は100着です。',source,type:'金額',subject:'売上原価',pattern:/棚卸/,calculation:['330,000円÷100=3,300円']});
  assert.equal(r.record.status,'revise');diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.claims[0].confirm.answer.evidence_id,source.id);assert(r.record.claims[0].confirm.answer.basis);
}));
for(const calculation of ['(200万円×15%)-(200万円×10%)=10万円','200万円×15%−200万円×10%=9.999万円','1円÷3=0.33円'])test('03e-E1','金額の式は正誤によらず裏付けに使わない: '+calculation,async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:calculation.startsWith('1円')?'1円を3人で分けると0.33円です。':'控除額は10万円です。',source:rates03e,type:'金額',subject:'贈与税の税率',pattern:/200万円以下/,calculation:[calculation]});
  assert.equal(r.record.status,'revise');diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');
}));
test('03e-E1','計算がない答えは従来どおり引用近傍の数字を求める',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:dateSentence03e});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
for(const [formula,sentence,text]of [
  ['0.1円+0.2円=0.3円','合計額は0.3円です。','計算の基礎となる金額は0.1円と0.2円です。'],
  ['2分の1×200万円=100万円','算出額は100万円です。','計算の基礎は200万円、用いる割合は50%です。'],
  ['二百万円×二割−二百万円×百分の十五=十万円','控除額は10万円です。','控除額の計算に用いるのは200万円、20%と15%です。'],
])test('03e-E1','小数・分数・漢数字でも金額の計算は裏付けに使わない: '+formula,async()=>feature(async()=>{
  const source={...rates03e,text},r=await calculationCase03e({sentence,source,type:'金額',subject:'贈与税の税率',pattern:/計算/,calculation:[formula]});assert.equal(r.record.status,'revise');diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');
}));
test('03e-E1','修正文の金額も計算で補わず、残りの数字・引用の長さを確かめる',async()=>feature(async()=>{
  const fixed=await calculationCase03e({sentence:'控除額は11万円です。',type:'金額',subject:'贈与税の税率',source:rates03e,pattern:/200万円以下/,verdict:'誤り',replacement:'控除額は10万円です。',calculation:['200万円×15%−200万円×10%=10万円']});assert.equal(fixed.record.status,'revise');diagnostic03c(fixed.record.claims[0].confirm,'replacement_numbers');assert(fixed.body.includes('控除額は11万円です。'));assert.equal(fixed.record.corrections.length,0);
  const remaining=await calculationCase03e({sentence:'控除額は10万円、追加控除は17万円です。',type:'金額',source:rates03e,subject:'贈与税の税率',pattern:/200万円以下/,calculation:['200万円×15%−200万円×10%=10万円']});diagnostic03c(remaining.record.claims[0].confirm,'quote_insufficient');
}));
test('03e-E1','日付以外は数字を外さず、日付の式は最大3件・読める形だけに限る',()=>{
  const verify=require('../fact-calculation').verifyCalculations,context={quote:'初日から15日前の日です。',sentence:dateSentence03e,target:dateSentence03e,normalizedNumbers:F.normalizedNumbers},formula='1月1日−15日=12月17日';
  for(const value of [['1+2=3','3-2=1'],[],['1=1','1=1','1=1','1=1'],[123],['1e3=1000'],['約1円=1円']]){const result=verify(value,context);assert.equal(result.error,undefined);assert.equal(result.excluded.size,0);}
  assert.equal(verify([formula,formula,formula],context).excluded.size,2);
  for(const value of [[formula,formula,formula,formula],formula,['1月1日×15日=12月17日']])assert.equal(verify(value,context).error,'読めない');
});
test('03e-E1','検算が合っても短い引用は採らず、式の鍵も記録に出さない',async()=>feature(async()=>{
  const source={...rates03e,id:'law:test:short',text:'200万円10%15%'},r=await calculationCase03e({sentence:'控除額は10万円です。',source,type:'金額',subject:'贈与税の税率',pattern:/200/,calculation:['200万円×15%−200万円×10%=10万円']});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');
  const key='sk-test-calculation-secret123456789',secret=await calculationCase03e({sentence:dateSentence03e,calculation:['1月1日−15日=12月17日;'+key]});diagnostic03c(secret.record.claims[0].confirm,'calculation_rejected');assert(!JSON.stringify(secret).includes(key));
}));

for(const suffix of ['', '（届出の期限）','（取消し（手続））'])test('03e-E2','同じ制度'+suffix+'の問13を共有し、12月17日を検算する',async()=>feature(async()=>{
  const home=material('ta:6501'),qa=material('qa:invoice/13'),first='登録取消届出書は戻したい課税期間の初日から起算して15日前まで。',body=first+'\n'+dateSentence03e;let shared=false;
  const select=c=>c.claim.includes('12月17')?[home]:[home,qa];
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:6501'],searchWriterEvidence:select,searchEvidence:select,findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'期限','インボイス登録の取消し').map((c,i)=>({...c,subject:c.subject+(i?suffix:'')}));
    if(req.task==='confirm'){const claims=payload(req).claims,page=materials(req).find(p=>p.url===qa.url);shared=claims.length===2&&claims.every(c=>c.evidence_ids.includes(page.number));return claims.map(c=>({...confirmed(req,c,qa,/15\s*日前の日/,'正しい'),...(c.sentence.includes('12月17')?{calculation:['1月1日−15日=12月17日']}:{})}));}
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});assert(shared);assert.equal(r.record.status,'ok');assert(r.record.claims.every(c=>c.confirm.verdict==='正しい'));
}));
test('03e-E2','別の制度4508と4511は同じ回でも共有しない',async()=>feature(async()=>{
  const home=material('ta:4508'),family=material('ta:4511'),common=material('ta:4452'),body='住宅取得等資金の非課税は18歳以上です。\n結婚・子育て資金の非課税は18歳以上50歳未満です。';
  const select=c=>[c.subject==='住宅取得等資金の贈与の非課税'?home:family,common];
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','ta:4511'],searchWriterEvidence:select,searchEvidence:select,loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','仮').map((c,i)=>({...c,subject:i?'結婚・子育て資金の一括贈与':'住宅取得等資金の贈与の非課税'}));
    if(req.task==='confirm')return payload(req).claims.map(c=>confirmed(req,c,family,/18歳以上50歳未満/,'正しい'));
    return payload(req).claims.map(c=>judged(req,c,select(c)[0],/18歳以上/,'食い違い','要件を確かめる'));
  }});diagnostic03c(r.record.claims[0].confirm,'page_not_offered');assert.equal(r.record.status,'revise');
}));
test('03e-E2','同じ制度を資料の重なりより先にまとめ、同じ回だけで共有する',async()=>{
  const findings=['甲','乙','丙'].map((label,i)=>({id:'c'+i,type:'要件',subject:i===1?'別制度':'共通制度',sentence:label+'の対象者です。',claim:label,status:'食い違い'})),seen=[];
  await CF03c.confirmFindings('',findings,async req=>{seen.push(payload(req).claims);return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));},{searchWriterEvidence:f=>[{id:f.id,kind:'law',title:f.subject,text:'対象者について説明している資料です。'}],loadEvidenceText:e=>e.text},()=>null,()=>({}),v=>v,F.normalizedNumbers);
  assert.deepEqual(seen.map(c=>c.map(c=>c.id)),[['c0','c2'],['c1']]);assert.deepEqual(seen[0][0].evidence_ids,seen[0][1].evidence_ids);assert.equal(seen[1][0].evidence_ids.length,1);
});

for(const type of ['要件','判定','手続'])test('03e-E3','名義預金の食い違い・'+type+'に記載なしなら書き換えず人の一覧に残す',async()=>feature(async()=>{
  const source=material('ta:4103'),body='名義預金は口座の名義人だけで相続財産かどうかを判断します。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4103'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,type,'名義預金');
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし',replacement:'名義預金の具体を確認します。'}));
    return payload(req).claims.map(c=>judged(req,c,source,/相続税/,'食い違い','口座の名義だけでは判断しません。'));
  }});const c=r.record.claims[0];assert.equal(r.record.status,'ok');assert.equal(c.status,'資料なし');assert.equal(c.confirm.verdict,'記載なし');assert.equal(c.confirm.rejected.code,'not_stated_status');assert.equal(c.confirm.review,true);assert.equal(r.body,body);assert.equal(r.record.corrections.length,0);assert(r.record.review_items.some(c=>c.id===r.record.claims[0].id));
}));
test('03e-E4','税の具体だけを記載なしにし、会計の一般説明は判断できないと指示する',async()=>feature(async()=>{
  let instruction='';const r=await recipientCase(req=>{instruction=req.system;return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));});
  for(const text of ['税の制度の具体','会計・計算の一般','期首','仕入','期末','言葉の意味','想定読者','判断できない'])assert(instruction.includes(text),text);
  assert.equal(r.record.status,'revise');assert.equal(r.body,wrongRecipient);
}));
test('03e-E4','売上原価の一般の式を判断できないと答えたら、弱めず人の一覧へ残す',async()=>feature(async()=>{
  const source=material('ta:4508'),sentence='売上原価は期首棚卸高＋当期仕入高−期末棚卸高で計算します。',body=sentence+'\n'+['甲','乙','丙','丁'].map(s=>s+'受贈者は18歳以上です。').join('\n');
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税').map(c=>c.claim===sentence?{...c,type:'判定',subject:'売上原価'}:c);
    if(req.task==='condition_check')return agreement();if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));
    return payload(req).claims.map(c=>c.subject==='売上原価'?{id:c.id,status:'資料なし'}:judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});assert.equal(r.body,body);assert.equal(r.record.status,'ok');assert.equal(r.record.corrections.length,0);assert(r.record.review_items.some(c=>c.subject==='売上原価'));
}));
test('03e-E3','条件の不一致への記載なしも、数字を直さず人の確認へ戻す',async()=>feature(async()=>{
  const source=material('ta:4508'),body='受贈者は18歳以上であることが要件です。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='condition_check')return {verdict:'不一致',conditions:[{article:'18歳以上',source:'50歳未満',match:'不一致'}],correct:'50歳未満'};
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'記載なし'}));
    return payload(req).claims.map(c=>judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].status,'資料なし');assert.equal(r.record.claims[0].confirm.review,true);assert.equal(r.body,body);
}));

async function gatewayCase03e(kind,run){
  const CM=require('../content-model'),saved={fetch:global.fetch,timer:global.setTimeout,log:console.log,warn:console.warn},source=material('ta:4508'),requests=[],logs=[],batches=new Map();
  const respond=data=>({ok:true,json:async()=>data}),bad=status=>({ok:false,status,body:{cancel:async()=>{}},text:async()=>'sk-test-gateway-response-secret123456789'});
  const decode=b=>({system:b.system?(Array.isArray(b.system)?b.system.map(p=>p.text).join('\n'):b.system):b.messages[0].content,user:(()=>{const c=b.messages.at(-1).content;return typeof c==='string'?c:c.filter(p=>p.type==='text').map(p=>p.text).join('\n');})()});
  const answer=b=>{const req=decode(b);if(req.system.startsWith('記事本文から'))return extract(req,'要件','住宅取得等資金の贈与の非課税');if(req.system.startsWith('記事の文が'))return agreement();return payload(req).claims.map(c=>judged(req,c,source,/18歳以上/,'裏付けあり'));};
  const message=b=>({content:[{type:'text',text:JSON.stringify(answer(b))}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20}});
  console.log=console.warn=(...a)=>logs.push(a.join(' '));global.setTimeout=(fn,ms,...args)=>saved.timer(fn,[15000,30000].includes(ms)?0:ms,...args);
  global.fetch=async(url,init={})=>{const b=init.body?JSON.parse(init.body):null;requests.push({url,body:b,raw:init.body});
    if(url.includes('ai-gateway')){
      if(kind==='timeout')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new TypeError('通信中止')),{once:true}));
      if(kind==='network')throw new TypeError('通信の失敗 sk-test-gateway-response-secret123456789');
      if(kind==='5xx')return bad(503);if(kind==='auth')return bad(401);if(kind==='unsupported')return bad(404);
      return respond({choices:[{message:{content:JSON.stringify(answer(b))},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}});
    }
    if(kind==='fallback-failed'||kind==='anthropic-failed')return bad(401);
    if(url.endsWith('/batches')&&init.method==='POST'){const id='batch-e5-'+batches.size;batches.set(id,b.requests);return respond({id});}
    if(url.endsWith('/results')){const id=url.split('/').at(-2);return {ok:true,text:async()=>batches.get(id).map(r=>JSON.stringify({custom_id:r.custom_id,result:{type:'succeeded',message:message(r.params)}})).join('\n')};}
    if(url.includes('/batches/'))return respond({processing_status:'ended',results_url:url+'/results'});
    return respond(message(b));
  };
  try{await env({AI_GATEWAY_API_KEY:kind==='credentials'?undefined:'test-gateway-key-12345',ANTHROPIC_API_KEY:'test-anthropic-key-12345',FACT_CHECK_MODEL:'zai/glm-5.3-flash',FACT_CHECK_EXTRACT_MODEL:'zai/glm-5.3-flash',FACT_CHECK_EFFORT:undefined,FACT_CHECK_EXTRACT_EFFORT:undefined},()=>run({requests,logs,options:{...opts,batch:true,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,batchRuntime:{now:()=>0,sleep:async()=>{}}}}));}
  finally{global.fetch=saved.fetch;global.setTimeout=saved.timer;console.log=saved.log;console.warn=saved.warn;}
}
for(const effort of ['low',undefined])test('03e-E5-1','照合のGatewayでeffort='+String(effort)+'を要求と記録で確かめる',async()=>feature(()=>gatewayCase03e('ok',async({options,requests})=>env({FACT_CHECK_EFFORT:effort,FACT_CHECK_EXTRACT_EFFORT:effort},async()=>{
  const r=await F.checkFacts('受贈者は18歳以上です。',options);assert.equal(r.record.status,'ok');assert(requests.length>1);
  for(const req of requests){assert(req.url.includes('ai-gateway'));assert.deepEqual(req.body.reasoning,effort?{effort}:undefined);}assert.equal(r.record.effort,effort||null);assert.equal(r.record.extract_effort,effort||null);
}))));
for(const kind of ['timeout','5xx','network','fallback-failed'])test('03e-E5-2',kind+'なら既定のOpus・全体検索・Batchへ一度戻す',async()=>feature(()=>gatewayCase03e(kind==='fallback-failed'?'5xx':kind,async({options,requests,logs})=>{
  if(kind==='fallback-failed'){const fetch=global.fetch;global.fetch=(url,init)=>url.includes('ai-gateway')?fetch(url,init):Promise.resolve({ok:false,status:401,text:async()=>'',body:{cancel:async()=>{}}});}
  const r=await F.checkFacts('受贈者は18歳以上です。',{...options,...(kind==='timeout'?{timeoutMs:20}:{})});
  assert.equal(r.record.status,kind==='fallback-failed'?'not_run':'ok');assert.equal(r.record.fallback?.from,'gateway');assert(r.record.summary.includes(kind==='fallback-failed'?'・GLM の照合が終わらず、Opus でのやり直しもできませんでした':'・GLM の照合が終わらなかったため Opus で照合'));
  const anthro=requests.filter(r=>r.url.includes('anthropic'));if(kind!=='fallback-failed'){assert(anthro.length);assert.equal(r.record.batch,true);assert.equal(r.record.model,'claude-opus-5-5');assert(!r.record.stages);assert(!r.record.confirm);}
  assert.equal(requests.filter(r=>r.url.includes('ai-gateway')).length,kind==='timeout'?1:3);assert(!JSON.stringify(r.record).includes('sk-test-gateway-response-secret123456789'));assert(!logs.join('\n').includes('sk-test-gateway-response-secret123456789'));
})));
for(const kind of ['credentials','unsupported','auth','anthropic-failed'])test('03e-E5-2',kind+'はやり直して設定の失敗を隠さない',async()=>feature(()=>gatewayCase03e(kind,async({options,requests})=>{
  const r=await F.checkFacts('受贈者は18歳以上です。',{...options,...(kind==='anthropic-failed'?{provider:'anthropic',model:'claude-opus-5-5',extractModel:'claude-opus-5-5'}:{})});assert.equal(r.record.status,'not_run');assert(!r.record.fallback);
  if(kind!=='anthropic-failed')assert(!requests.some(r=>r.url.includes('anthropic')));
})));
test('03e-E5-3','Gatewayの上限は既定600000、設定の上限900000を保つ',()=>{
  assert.equal(F.config({provider:'gateway'}).timeoutMs,600000);assert.equal(F.config({provider:'gateway',timeoutMs:1000000}).timeoutMs,900000);
});
test('03e-E5-1','不正なeffort・モデル設定は無視もやり直しもせずnot_runにする',async()=>feature(()=>gatewayCase03e('ok',async({options,requests})=>{
  const invalidEffort=await F.checkFacts('受贈者は18歳以上です。',{...options,effort:'invalid'});assert.equal(invalidEffort.record.status,'not_run');assert(!invalidEffort.record.fallback);
  const invalidModel=await F.checkFacts('受贈者は18歳以上です。',{...options,model:'unsupported-model'});assert.equal(invalidModel.record.status,'not_run');assert(!invalidModel.record.fallback);assert.equal(requests.length,0);
})));

// 03f: レビューの文・式・資料をそのまま使い、誤った前提を検算で正当化しない。
for(const [name,settings] of [
  ['①', {sentence:'翌年1月1日から戻すなら、10日前の12月22日までに取消届出書を出します。',calculation:['1月1日−10日=12月22日']}],
  ['②', {sentence:'| 300万円以下 | 20%（控除20万円） |',type:'割合',subject:'贈与税の税率',source:rates03e,pattern:/300万円以下/,calculation:['200万円×20%−200万円×10%=20万円']}],
  ['③', {sentence:'基礎控除100万円を差し引くと、課税価格は400万円です。',prev:'贈与財産の価額は500万円です。',type:'金額',subject:'贈与税の計算',source:material('ta:4408'),pattern:/基礎控除額110万円/,calculation:['500万円−100万円=400万円']}],
])test('03f-H1',name+'の誤った前提は検算が合っても正しいにしない',async()=>feature(async()=>{
  const r=await calculationCase03e(settings),answer=r.record.claims[0].confirm;
  assert.equal(r.record.status,'revise');assert(['quote_insufficient','calculation_rejected'].includes(answer.rejected?.code));assert.notEqual(answer.verdict,'正しい');assert(r.body.includes(settings.sentence));
}));
test('03f-H1','引用の確認から外すのは右辺と日付の起点だけに限る',()=>{
  const verify=require('../fact-calculation').verifyCalculations,normalizedNumbers=F.normalizedNumbers;
  const money=verify(['330,000円÷100=3,300円'],{quote:'取得価額を記載します。',article:['330,000円で100着です。'],target:'1着3,300円です。',normalizedNumbers});
  assert.deepEqual([...money.excluded],[]);
  const date=verify(['1月1日−15日=12月17日'],{quote:'初日から起算して15日前の日です。',sentence:dateSentence03e,target:dateSentence03e,normalizedNumbers});
  assert.deepEqual(new Set(date.excluded),new Set(normalizedNumbers('1月1日、12月17日')));assert(!date.excluded.has(normalizedNumbers('15日')[0]));
});
test('03f-M1','同じ文でも住宅資金の指摘に結婚・子育て資金の300万円は使わせない',async()=>feature(async()=>{
  // No.4511の手元の本文には300万円が無いため、同じ制度の本物の措法70の2の3を使う。
  const home=material('ta:4508'),family=material('law:sozeki_hou:70_2_3'),sentence='住宅取得等資金の非課税は300万円まで、結婚・子育て資金の一括贈与は1,000万円までが非課税です。';let offered;
  const select=c=>[c.subject==='住宅取得等資金の贈与の非課税'?home:family];
  const r=await F.checkFacts(sentence,{...opts,writer_materials:['ta:4508','law:sozeki_hou:70_2_3'],searchWriterEvidence:select,searchEvidence:select,findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return [{s:1,type:'金額',subject:'住宅取得等資金の贈与の非課税',claim:'住宅取得等資金の非課税は300万円まで'}, {s:1,type:'金額',subject:'結婚・子育て資金の一括贈与',claim:'結婚・子育て資金の一括贈与は1,000万円までが非課税'}];
    if(req.task==='confirm'){offered={claims:payload(req).claims,pages:materials(req)};return payload(req).claims.map(c=>confirmed(req,c,family,c.subject.startsWith('住宅')?/三百万円/:/千万円/,'正しい'));}
    return payload(req).claims.map(c=>judged(req,c,select(c)[0],c.subject.startsWith('住宅')?/1,000万円/:/千万円/,'食い違い','非課税の限度額を確かめます。'));
  }});
  const number=offered.pages.find(p=>p.url===family.url).number,claim=offered.claims.find(c=>c.subject.startsWith('住宅'));
  assert(!claim.evidence_ids.includes(number));diagnostic03c(r.record.claims.find(c=>c.subject.startsWith('住宅')).confirm,'page_not_offered');assert.equal(r.record.status,'revise');assert.equal(r.body,sentence);assert.equal(r.record.corrections.length,0);
}));
test('03f-M2','GLM用lowが環境変数にもオプションにもあっても、やり直しのOpusはeffort未指定',async()=>feature(()=>gatewayCase03e('timeout',async({options,requests})=>env({FACT_CHECK_EFFORT:'low',FACT_CHECK_EXTRACT_EFFORT:'low'},async()=>{
  const r=await F.checkFacts('受贈者は18歳以上です。',{...options,effort:'low',extractEffort:'low',timeoutMs:20});
  assert.equal(r.record.status,'ok');assert.equal(r.record.effort,null);assert.equal(r.record.extract_effort,null);
  const anthropic=requests.filter(req=>req.url.includes('anthropic')).flatMap(req=>req.body?.requests?.map(r=>r.params)|| (req.body?.messages?[req.body]:[]));
  assert(anthropic.length);assert(anthropic.every(body=>!Object.hasOwn(body,'output_config')));assert.deepEqual(requests.find(r=>r.url.includes('ai-gateway')).body.reasoning,{effort:'low'});
}))));
for(const calculation of [[],null,''])test('03f-L2','空のcalculation '+JSON.stringify(calculation)+'は未指定と同じにする',async()=>feature(async()=>{
  const sentence='登録取消届出書は翌課税期間の初日から起算して15日前までに提出します。';
  const actual=await calculationCase03e({sentence,calculation}),before=await calculationCase03e({sentence});
  assert.equal(actual.record.status,'ok');assert.equal(actual.record.claims[0].confirm.verdict,'正しい');
  const outcome=r=>({body:r.body,status:r.record.status,claims:r.record.claims.map(c=>({...c,confirm:{...c.confirm,answer:{...c.confirm.answer,calculation:undefined}}})),corrections:r.record.corrections,review_items:r.record.review_items,confirm:r.record.confirm});assert.deepEqual(outcome(actual),outcome(before));
}));
for(const failed of [false,true])test('03f-L3','失敗前のGLMの使用量を残す・Opusやり直し'+(failed?'失敗':'成功'),async()=>feature(()=>gatewayCase03e('ok',async({options,requests,logs})=>{
  const original=global.fetch;let gateway=0;
  global.fetch=async(url,init)=>{
    if(url.includes('ai-gateway')&&++gateway>1){requests.push({url,body:JSON.parse(init.body)});return {ok:false,status:503,body:{cancel:async()=>{}}};}
    if(failed&&url.includes('anthropic')){requests.push({url,body:init.body?JSON.parse(init.body):null});return {ok:false,status:401,text:async()=>'sk-test-fallback-secret123456789',body:{cancel:async()=>{}}};}
    return original(url,init);
  };
  const r=await F.checkFacts('受贈者は18歳以上です。',options);assert.equal(r.record.status,failed?'not_run':'ok');
  const calls=r.record.fallback.gateway_calls;assert(Array.isArray(calls));assert.equal(calls.length,2);assert.deepEqual(calls[0],{task:'extract',model:'zai/glm-5.3-flash',usage:{input_tokens:10,output_tokens:20}});
  assert.equal(calls[1].task,'judge');assert.equal(calls[1].model,'zai/glm-5.3-flash');assert(!Object.hasOwn(calls[1],'usage'));assert(calls.every(c=>Object.keys(c).every(k=>['task','model','usage'].includes(k))));
  assert(r.record.summary.includes(failed?'・GLM の照合が終わらず、Opus でのやり直しもできませんでした':'・GLM の照合が終わらなかったため Opus で照合'));
  assert(!JSON.stringify(r.record).includes('sk-test-fallback-secret123456789'));assert(!logs.join('\n').includes('sk-test-fallback-secret123456789'));
})));
test('03f-L4','本文に存在しない表の行へ本文先頭の前提を混ぜない',async()=>{
  const source=material('law:shotokuzei_rei:103'),page=page03c(source),unit=page.units.find(u=>/棚卸/.test(u.text)&&u.text.length>=15);
  const answer=await private03c.exports.validate03c('仕入代金は330,000円で、数量は100着です。',{id:'c1',type:'金額',claim:'1着3,300円',sentence:'| 取得価額 | 3,300円 |',subject:'売上原価',status:'資料なし'},
    {verdict:'正しい',evidence_id:1,basis:String(unit.s),calculation:['330,000円÷100=3,300円']},[page],{});
  assert.equal(answer.rejected?.code,'quote_insufficient');assert(answer.rejected.detail.includes('主張の数字'));
});
test('03f-L4','計算で主張の数字が全部外れても資料の読めない割合は止める',async()=>feature(async()=>{
  const source={...rates03e,text:rates03e.text+'\n0分の1'},r=await calculationCase03e({sentence:'控除額は10万円です。',source,type:'金額',subject:'贈与税の税率',pattern:/200万円以下/,calculation:['200万円×15%−200万円×10%=10万円']});
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));

// 03g: 主張の要約から落ちた数字も、計算の前提として無条件には使わせない。
for(const [label,settings] of [
  ['①', {sentence:'翌年1月1日から戻すなら、10日前の12月22日までに取消届出書を出します。',claim:'提出期限は12月22日',calculation:['1月1日−10日=12月22日']}],
  ['③', {sentence:'基礎控除100万円を差し引くと、課税価格は400万円です。',claim:'課税価格は400万円',prev:'贈与財産の価額は500万円です。',type:'金額',subject:'贈与税の計算',source:material('ta:4408'),pattern:/基礎控除額110万円/,calculation:['500万円−100万円=400万円']}],
])test('03g-N1-1','要約の形の'+label+'でも同じ文の誤った前提を採らない',async()=>feature(async()=>{
  const r=await calculationCase03e(settings),answer=r.record.claims[0].confirm;
  diagnostic03c(answer,label==='①'?'calculation_rejected':'quote_insufficient');assert(answer.rejected.detail.includes(label==='①'?'数の出どころが無い':'主張の数字'));assert.equal(r.record.status,'revise');assert(r.body.includes(settings.sentence));
}));
test('03g-N1-1','同じ文の330000円・100着だけから3300円を計算しない',async()=>feature(async()=>{
  const sentence='330,000円を100着で割ると3,300円になります。',r=await calculationCase03e({sentence,claim:'取得価額は3,300円',type:'金額',subject:'売上原価',source:material('law:shotokuzei_rei:103'),pattern:/棚卸/,calculation:['330,000円÷100=3,300円']});
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert.equal(r.body,'## 手続と計算\n'+sentence);
}));
for(const ratio of ['20%','2割','5分の1'])test('03g-N1-2','記事の前提の割合'+ratio+'は引用なしで使わない',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'税額は100万円です。',claim:'税額100万円',prev:'贈与額は500万円、税率は'+ratio+'です。',type:'金額',subject:'贈与税の計算',source:material('ta:4408'),pattern:/基礎控除額110万円/,calculation:['500万円×'+ratio+'=100万円']});
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert(r.record.claims[0].confirm.rejected.detail.includes('主張の数字'));assert.equal(r.record.status,'revise');
}));
async function premisesCase03g({same=false,date=false,verdict='誤り',reverse=false,next=false,chain=false}={}){
  const source=material(date?'qa:invoice/13':'ta:4408'),claimById=new Map();
  const first=date?'登録取消届出書は10日前までに提出します。':same?'贈与財産の価額は500万円です。':'贈与財産500万円から基礎控除100万円を差し引きます。';
  const sentence=date?'翌年1月1日から戻すなら、取消届出の期限は12月22日です。':same?'基礎控除100万円を差し引くと、課税価格は400万円です。':'課税価格は400万円です。';
  const body=(next?sentence+'\n'+first:first+'\n'+sentence)+(chain?'\n税額は80万円です。':''),claim=date?'提出期限は12月22日':'課税価格は400万円',baseClaim=date?'提出期限は10日前':'基礎控除100万円',type=date?'期限':'金額';
  const r=await F.checkFacts(body,{...opts,writer_materials:[date?'ta:6501':'ta:4408'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract'){
      const lines=extract(req,type,date?'インボイス登録の取消し':'贈与税の計算'),claims=[{...lines[same||next?1:0],claim:baseClaim},{...lines[next?0:1],claim},...(chain?[{...lines[2],claim:'税額80万円'}]:[])];return reverse?claims.reverse():claims;
    }
    if(req.task==='confirm')return payload(req).claims.map(c=>claimById.get(c.id)===baseClaim
      ?verdict==='判断できない'?{id:c.id,verdict}:confirmed(req,c,source,date?/15\s*日前の日/:same?/基礎控除額110万円/:/500万円.*110万円/,verdict,(same?sentence:first).replace(date?'10日前':'100万円',date?'15日前':'110万円'))
      :claimById.get(c.id)==='税額80万円'?{...confirmed(req,c,source,/390万円.*20%/,'正しい'),calculation:['400万円×20%=80万円']}
      :{...confirmed(req,c,source,date?/15\s*日前の日/:/基礎控除額110万円/,'正しい'),calculation:[date?'1月1日−10日=12月22日':'500万円−100万円=400万円']});
    return payload(req).claims.map(c=>{claimById.set(c.id,c.claim);return c.claim===baseClaim&&verdict==='誤り'?judged(req,c,source,date?/15\s*日前の日/:/基礎控除額110万円/,'食い違い',date?'15日前':'110万円'):{id:c.id,status:'資料なし'};});
  }});
  return {r,body,claim,baseClaim};
}
test('03g-N1-1','③の二つの主張を110万円だけに直して400万円のままokにしない',async()=>feature(async()=>{
  const {r,body,claim,baseClaim}=await premisesCase03g({same:true});diagnostic03c(r.record.claims.find(c=>c.claim===claim).confirm,'quote_insufficient');assert.equal(r.record.claims.find(c=>c.claim===baseClaim).confirm.answer.verdict,'誤り');assert.equal(r.record.status,'revise');assert.equal(r.body,body);assert.equal(r.record.corrections.length,0);
}));
for(const settings of [{},{reverse:true},{verdict:'判断できない'},{date:true},{next:true}])test('03g-N1-3','前後の文の未確認の数字に依存する計算を止める '+JSON.stringify(settings),async()=>feature(async()=>{
  const {r,claim,baseClaim}=await premisesCase03g(settings),dependent=r.record.claims.find(c=>c.claim===claim),premise=r.record.claims.find(c=>c.claim===baseClaim);
  diagnostic03c(dependent.confirm,settings.date?'calculation_rejected':'quote_insufficient');assert(dependent.confirm.rejected.detail.includes(settings.date?'数の出どころが無い':'主張の数字'));assert.equal(r.record.status,'revise');assert.notEqual(premise.status,'裏付けあり');assert(!r.record.corrections.some(c=>c.id===dependent.id));
  assert.equal(premise.confirm.answer.verdict,settings.verdict||'誤り');
}));
test('03g-N1-3','未確認の前提から二段階で計算した答えも順序に依存せず採らない',async()=>feature(async()=>{
  const {r}=await premisesCase03g({chain:true,reverse:true});
  for(const claim of ['課税価格は400万円','税額80万円']){const answer=r.record.claims.find(c=>c.claim===claim).confirm;diagnostic03c(answer,'quote_insufficient');assert(answer.rejected.detail.includes('主張の数字'));}
  assert.equal(r.record.status,'revise');assert(!r.record.corrections.some(c=>['課税価格は400万円','税額80万円'].includes(c.claim)));
}));
for(const mode of ['抽出なし','GLMで裏付けあり','Opusで正しい'])test('03g-N1-3','前の文の330000円・100着が'+mode+'でも3300円の計算は裏付けに使わない',async()=>feature(async()=>{
  const source=material('law:shotokuzei_rei:103'),first='仕入代金は330,000円で、仕入れた数は100着です。',sentence='1着あたりに直すと3,300円になります。',purchase={id:'law:test:purchase',kind:'law',title:'仕入れの前提',url:'https://example.test/purchase',text:first},body=first+'\n'+sentence;
  const select=c=>[c.subject==='仕入れの前提'?purchase:source];
  const r=await F.checkFacts(body,{...opts,writer_materials:['law:shotokuzei_rei:103'],searchWriterEvidence:select,searchEvidence:select,findQaByKeywords:()=>[],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'金額','売上原価').flatMap((c,i)=>i?[{...c,claim:'1着あたりの取得価額は3,300円'}]:mode==='抽出なし'?[]:[{...c,subject:'仕入れの前提',claim:'仕入代金330,000円、100着'}]);
    if(req.task==='confirm')return payload(req).claims.map(c=>c.subject==='仕入れの前提'?confirmed(req,c,purchase,/330,000/,'正しい'):{...confirmed(req,c,source,/棚卸/,'正しい'),calculation:['330,000円÷100=3,300円']});
    return payload(req).claims.map(c=>c.subject==='仕入れの前提'&&mode==='GLMで裏付けあり'?judged(req,c,purchase,/330,000/,'裏付けあり'):{id:c.id,status:'資料なし'});
  }});assert.equal(r.record.status,'revise');assert.equal(r.body,body);diagnostic03c(r.record.claims.find(c=>c.subject==='売上原価').confirm,'quote_insufficient');if(mode!=='抽出なし')assert.equal(r.record.claims.find(c=>c.subject==='仕入れの前提').status,'裏付けあり');
}));
for(const calculation of [undefined,['200万円×20%−200万円×10%=20万円']])test('03g-N2','本物のNo.4408の表でも控除20万円を通さない '+JSON.stringify(calculation),async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'| 300万円以下 | 15%（控除20万円） |',claim:'税率15%、控除20万円',type:'割合',subject:'贈与税の税率',source:material('ta:4408'),pattern:/200万円以下.*300万円以下/,calculation});
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
test('03g-N2','本物のNo.4408に控除額まで書かれた行は計算なしでok',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'| 300万円以下 | 15%（控除10万円） |',claim:'税率15%、控除10万円',type:'割合',subject:'贈与税の税率',source:material('ta:4408'),pattern:/200万円以下.*300万円以下/});
  assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));

// 03h: 金額は引用で確認し、計算による数字の除外は日付だけに限る。
async function moneyCase03h(body,specs){
  const source=material('ta:4408'),claimById=new Map();
  return F.checkFacts(body,{...opts,writer_materials:['ta:4408'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract'){const rows=extract(req,'金額','贈与税の計算');return specs.map(s=>({...rows.find(c=>c.claim===s.sentence),type:s.type||'金額',claim:s.claim}));}
    if(req.task==='confirm')return payload(req).claims.map(c=>{const s=specs.find(s=>s.claim===claimById.get(c.id));return {...confirmed(req,c,source,s.pattern||/基礎控除額110万円/,s.replacement?'誤り':'正しい',s.replacement||''),...(s.calculation?{calculation:s.calculation}:{})};});
    if(req.task==='condition_check')return agreement();
    return payload(req).claims.map(c=>{claimById.set(c.id,c.claim);const s=specs.find(s=>s.claim===c.claim);return s.replacement?judged(req,c,source,/基礎控除額110万円/,'食い違い',s.replacement):{id:c.id,status:'資料なし'};});
  }});
}
for(const calculation of [undefined,['200万円×20%−200万円×10%=20万円']])test('03h-D1','X1: 地の文の誤った控除額20万円を計算で通さない '+JSON.stringify(calculation),async()=>feature(async()=>{
  const sentence='300万円以下の部分の税率は15%、控除額は20万円です。',r=await moneyCase03h(sentence,[{sentence,claim:'税率15%、控除額20万円',pattern:/200万円以下.*300万円以下/,calculation}]);
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert.equal(r.body,sentence);
}));
test('03h-D1','X4b: 数字の無い要約の基礎控除を110万円に直しても500万円を正しいにしない',async()=>feature(async()=>{
  const first='贈与財産600万円から基礎控除100万円を差し引きます。',second='課税価格は500万円です。',r=await moneyCase03h(first+'\n'+second,[{sentence:first,claim:'基礎控除を差し引く',type:'判定',replacement:first.replace('100','110')},{sentence:second,claim:'課税価格500万円',calculation:['600万円−100万円=500万円']}]);
  const premise=r.record.claims.find(c=>c.claim==='基礎控除を差し引く'),answer=r.record.claims.find(c=>c.claim==='課税価格500万円');
  assert.equal(premise.confirm.answer.verdict,'誤り');assert.equal(premise.confirm.verdict,'誤り');assert.equal(premise.correct,first.replace('100','110'));assert(r.body.includes(first.replace('100','110')));diagnostic03c(answer.confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert(!r.record.corrections.some(c=>c.id===answer.id));
}));
test('03h-D1','X3: 見出しの550万円・基礎控除100万円から450万円を正しいにしない',async()=>feature(async()=>{
  const sentence='課税価格は450万円です。',body='## 贈与財産550万円から基礎控除100万円を引く例\n'+sentence,r=await moneyCase03h(body,[{sentence,claim:'課税価格450万円',calculation:['550万円−100万円=450万円']}]);
  diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert.equal(r.body,body);
}));
for(const explicit of [false,true])test('03h-D1','X5: 100万円と450万円を互いの計算だけで裏付けない '+(explicit?'単位と550万円の前提を明示':'レビュー記載の式'),async()=>feature(async()=>{
  const first='基礎控除は100万円です。',second='課税価格は450万円です。',body=(explicit?'## 贈与財産550万円の例\n':'')+first+'\n'+second;
  const r=await moneyCase03h(body,[{sentence:first,claim:'基礎控除100万円',calculation:[explicit?'550万円−450万円=100万円':'550−450=100']},{sentence:second,claim:'課税価格450万円',calculation:[explicit?'550万円−100万円=450万円':'550−100=450']}]);
  assert.equal(r.record.claims.length,2);for(const c of r.record.claims)diagnostic03c(c.confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert.equal(r.body,body);assert.equal(r.record.corrections.length,0);
}));
test('03h-D3','X2: 問13の同月30日を30日前の日数には使わせない',async()=>feature(async()=>{
  const sentence='翌年1月1日から戻すなら、取消届出の期限は12月2日です。',r=await calculationCase03e({sentence,claim:'提出期限は12月2日',pattern:/同月\s*30\s*日/,calculation:['1月1日−30日=12月2日']});
  diagnostic03c(r.record.claims[0].confirm,'calculation_rejected');assert.equal(r.record.status,'revise');assert.equal(r.body,'## 手続と計算\n'+sentence);
}));
test('03h-D2','日付の起点を前の文からは取らない',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'取消届出の期限は12月17日です。',prev:'課税期間の初日は1月1日です。',calculation:['1月1日−15日=12月17日']});
  diagnostic03c(r.record.claims[0].confirm,'calculation_rejected');assert.equal(r.record.status,'revise');
}));
const dateSource03h=text=>({id:'law:test:date',kind:'law',title:'届出の期限',url:'https://example.test/date',text});
for(const [text,operator,ok] of [
  ['届出は起点から15日前の日までに提出してください。','−',true],
  ['届出は起点から１５ 日 前の日までに提出してください。','−',true],
  ['届出は起点から十五日前の日までに提出してください。','−',true],
  ['届出は起点から15日後の日までに提出してください。','+',true],
  ['届出は起点から15日を経過する日までに提出してください。','+',true],
  ['届出の例示には同月15日の日付が記載されています。','−',false],
  ['届出の例示には115日前の日付が記載されています。','−',false],
  ['届出は起点から15日後の日までに提出してください。','−',false],
  ['届出は起点から15日前の日までに提出してください。','+',false],
])test('03h-D3','日数の単位と向き: '+operator+' '+text,async()=>feature(async()=>{
  const result=operator==='+'?'1月16日':'12月17日',sentence='1月1日から計算した提出期限は'+result+'です。',r=await calculationCase03e({sentence,source:dateSource03h(text),pattern:/届出/,calculation:['1月1日'+operator+'15日='+result]});
  assert.equal(r.record.status,ok?'ok':'revise');if(ok)assert.equal(r.record.claims[0].confirm.verdict,'正しい');else diagnostic03c(r.record.claims[0].confirm,'calculation_rejected');
}));
test('03h-D2','起点が引用にある場合はその文に無くても日付を検算する',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:'提出期限は12月17日です。',source:dateSource03h('起点の1月1日から15日前の日までに届出を行います。'),pattern:/起点/,calculation:['1月1日−15日=12月17日']});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));
test('03h-D1','引用に直接ある金額は計算の正誤に影響されず、計算なしと同じに扱う',async()=>feature(async()=>{
  const sentence='基礎控除は110万円です。',r=await calculationCase03e({sentence,source:material('ta:4408'),type:'金額',subject:'贈与税の計算',pattern:/基礎控除額110万円/,calculation:['1円÷0=110万円']});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));
test('03h-D1','日付と金額の式が混ざっても日付だけを確かめる',async()=>feature(async()=>{
  const r=await calculationCase03e({sentence:dateSentence03e,calculation:['1円÷0=110万円','1月1日−15日=12月17日']});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));
test('03h-D4','calculationの指示は日付だけにし、金額の例を入れない',async()=>feature(async()=>{
  let system='';await recipientCase(req=>{system=req.system;return payload(req).claims.map(c=>({id:c.id,verdict:'判断できない'}));});
  assert(system.includes('日付'));assert(system.includes('日数は引用'));assert(!system.includes('200万円×15%'));assert(!system.includes('330,000円÷100'));
}));

for(const claim of ['課税価格は400万円','課税価格'])test('03h-追加歯止め','計算なしでも110万円の引用の近くにある400万円を採らない: '+claim,async()=>feature(async()=>{
  const sentence=claim==='課税価格'?'課税価格は400万円です。':'基礎控除100万円を差し引くと、課税価格は400万円です。',r=await moneyCase03h('贈与財産の価額は500万円です。\n'+sentence,[{sentence,claim}]);
  const answer=r.record.claims[0].confirm;diagnostic03c(answer,'quote_insufficient');assert(answer.rejected.detail.includes('金額が引用の中にありません'));assert.equal(r.record.status,'revise');assert(r.body.includes(sentence));assert.equal(r.record.corrections.length,0);
}));
for(const claim of ['基礎控除110万円','基礎控除','基礎控除1,100,000円'])test('03h-追加歯止め','計算なしの金額を引用した文そのものに確認する: '+claim,async()=>feature(async()=>{
  const sentence='基礎控除は110万円です。',r=await moneyCase03h(sentence,[{sentence,claim}]);
  assert.equal(r.record.status,'ok');assert.equal(r.body,sentence);assert.equal(r.record.claims[0].confirm.verdict,'正しい');assert(r.record.claims[0].confirm.quote.includes('110万円'));
}));
test('03h-追加歯止め','本物の速算表で控除額まで正しい金額の主張はok',async()=>feature(async()=>{
  const sentence='| 300万円以下 | 15%（控除10万円） |',r=await moneyCase03h(sentence,[{sentence,claim:'控除10万円',pattern:/200万円以下.*300万円以下/}]);
  assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');assert(r.record.claims[0].confirm.quote.includes('10万円'));
}));

// 03i: 採れなかった「誤り」は止め、引用内の年の無いスラッシュ日付だけ補う。
async function missing03i({sentence,type='手続',subject='棚卸資産の評価方法',sources=[material('law:shotokuzei_rei:100'),material('law:shotokuzei_rei:101')],opus,extra={}}){
  const home=material('ta:4508'),body=sentence+'\n'+['甲','乙','丙','丁'].map(label=>label+'の受贈者は18歳以上であることが要件です。').join('\n');
  const select=c=>c.subject===subject?sources:[home];
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508','law:shotokuzei_rei:100','law:shotokuzei_rei:101'],searchWriterEvidence:select,searchEvidence:select,findQaByKeywords:()=>[],loadEvidenceText:load,...extra,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税').map((c,i)=>i?c:{...c,type,subject});
    if(req.task==='condition_check')return agreement();
    if(req.task==='confirm')return opus(req,sources[0]);
    return payload(req).claims.map(c=>c.subject===subject?{id:c.id,status:'資料なし'}:judged(req,c,home,/18歳以上/,'裏付けあり'));
  }});return {r,body};
}
function blocked03i(r,c,code,correct=''){
  diagnostic03c(c.confirm,code);assert.equal(c.confirm.answer.verdict,'誤り');assert.equal(c.confirm.blocked,true);assert.equal(c.status,'食い違い');assert.equal(c.correct,correct);assert(!c.condition_mismatch);
  assert(r.record.remaining.some(row=>row.id===c.id));assert(!r.record.review_items.some(row=>row.id===c.id));assert.equal(r.record.status,'revise');
}
test('03i-A','1: S6の届出だけで評価方法を変えられる誤りは所令101を採れなくても止める',async()=>feature(async()=>{
  const sentence='3. 評価方法を変えたいときは、新たな方法を採用しようとする年の3月15日までに届出書を提出すれば、承認を受けなくても変更できます（所得税法施行令）。',law=material('law:shotokuzei_rei:101');
  const replacement='3. 評価方法を変えたいときは、新たな方法を採用しようとする年の3月15日までに申請書を提出し、承認を受ける必要があります（所得税法施行令）。';
  const {r,body}=await missing03i({sentence,opus:req=>payload(req).claims.map(c=>confirmed(req,c,law,/承認を受けなければならない/,'誤り',replacement))});
  blocked03i(r,r.record.claims[0],'rewrite_source');assert.equal(r.body,body);assert.equal(r.record.confirm.blocked,1);assert.equal(r.record.confirm.unknown,1);assert(r.record.summary.includes('・誤りとしたが採れず止めた 1'));assert.equal(r.record.claims[0].confirm.answer.replacement,replacement);
}));
test('03i-A','2: 条件の不一致でOpusの修正文の数字を採れないときは人の一覧でなく止める',async()=>feature(async()=>{
  const source=material('ta:4508'),body='受贈者は18歳以上の者に限られます。',replacement='受贈者は97歳以上であることが要件です。';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='condition_check')return {verdict:'不一致',conditions:[{article:'18歳以上',source:'50歳未満',match:'不一致'}],correct:'受贈者は50歳未満に限る。'};
    if(req.task==='confirm')return payload(req).claims.map(c=>{assert.equal(c.finding,'条件の不一致');return confirmed(req,c,source,/18歳以上/,'誤り',replacement);});
    return payload(req).claims.map(c=>judged(req,c,source,/18歳以上/,'裏付けあり'));
  }});blocked03i(r,r.record.claims[0],'replacement_numbers');assert.equal(r.body,body);assert.equal(r.record.claims[0].confirm.answer.replacement,replacement);
}));
test('03i-A','3: 課税仕入れが売上の半分を超える判定の資料なしで候補外の誤りを止める',async()=>feature(async()=>{
  const sentence='逆に本則課税が有利になるのは、外注費や材料費など課税仕入れが売上の半分を超える場合です。',source=material('ta:6505');
  const {r,body}=await missing03i({sentence,type:'判定',subject:'簡易課税と本則課税',sources:[source],opus:req=>payload(req).claims.map(c=>({id:c.id,verdict:'誤り',evidence_id:999,basis:'1',replacement:'本則課税と簡易課税の税額を比べて判断します。',reason:'売上の半分という基準だけでは決まらない'}))});
  blocked03i(r,r.record.claims[0],'page_not_offered');assert.equal(r.body,body);
}));
const private03i=new Module03c(require.resolve('../fact-check'),module);private03i.filename=require.resolve('../fact-check');private03i.paths=module.paths;
private03i._compile(fs03c.readFileSync(private03i.filename,'utf8')+'\nmodule.exports.apply03i=applyConfirmations;module.exports.blocks03i=blockingFinding;module.exports.sufficient03i=sufficientQuote;',private03i.filename);
for(const type of ['金額','期限','割合','適用年','番号'])test('03i-A','4: 数字の無い資料なしの'+type+'も確かめへ渡った誤りは止める',async()=>feature(async()=>{
  const source=material('ta:4508'),sentence='この制度の条件は国税庁の案内で定められます。',c={id:'c1',type,subject:'住宅取得等資金の贈与の非課税',sentence,claim:sentence,status:'資料なし',correct:'未確認の修正案',evidence:[source]},record={claims:[c],review_items:[{...c}],corrections:[],calls:[]};
  assert.equal(private03i.exports.blocks03i(c),false);
  const body=await private03i.exports.apply03i(sentence,[{...c}],record,async req=>{record.calls.push({task:req.task});return payload(req).claims.map(row=>({id:row.id,verdict:'誤り',evidence_id:1,basis:'不正',replacement:sentence,reason:'制度の条件が違う'}));},{searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:load},'claude-opus-5-5');
  assert.equal(body,sentence);diagnostic03c(c.confirm,'basis_unreadable');assert.equal(c.confirm.blocked,true);assert.equal(c.status,'食い違い');assert.equal(c.correct,'');assert.equal(private03i.exports.blocks03i(c),true);assert.equal(record.review_items.length,0);assert.equal(record.confirm.blocked,1);
}));
test('03i-A','5: 同じ文の一方だけ誤りを採れても両方を書き換えず止める',async()=>feature(async()=>{
  const source=material('ta:4511'),fixed=familySentence03c.replace('令和11年','令和9年');
  const r=await F.checkFacts(familySentence03c,{...opts,writer_materials:['ta:4511'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract'){const s=extract(req,'期限','結婚・子育て資金の一括贈与')[0].s;return [{s,type:'期限',subject:'結婚・子育て資金の一括贈与',claim:'平成27年4月1日から令和11年3月31日まで'},{s,type:'要件',subject:'結婚・子育て資金の一括贈与',claim:'受贈者は18歳以上50歳未満'}];}
    if(req.task==='confirm')return payload(req).claims.map(c=>({...confirmed(req,c,source,c.type==='期限'?/令和9年/:/18歳以上50歳未満/,'誤り',fixed),...(c.type==='要件'?{basis:'不正'}:{})}));
    return payload(req).claims.map(c=>judged(req,c,source,c.type==='期限'?/令和9年/:/18歳以上50歳未満/,'食い違い',c.type==='期限'?'令和9年3月31日まで':'受贈者は18歳以上50歳未満'));
  }});assert.equal(r.body,familySentence03c);assert.equal(r.record.confirm.blocked,2);
  for(const c of r.record.claims)blocked03i(r,c,c.type==='期限'?'same_sentence':'basis_unreadable',c.type==='期限'?'令和9年3月31日まで':'受贈者は18歳以上50歳未満');
}));
test('03i-A','5: 最後の本文保全で採れなかった誤りも止める',async()=>feature(async()=>{
  let guards=0;const r=await recipientCase((req,source)=>payload(req).claims.map(c=>confirmed(req,c,source,/直系卑属/,'誤り',rightRecipient)),{validateRepair:()=>++guards===1});
  blocked03i(r,r.record.claims[0],'repair_rejected',rightRecipient);assert.equal(guards,2);assert.equal(r.body,wrongRecipient);assert.equal(r.record.confirm.blocked,1);
}));
for(const mode of ['判断できない','正しい','記載なし','重複id','呼び出し失敗'])test('03i-A','6: 要件の資料なしで'+mode+'は止める扱いを増やさない',async()=>feature(async()=>{
  const sentence='取消届出の期限は土日祝でも延長されない。',source=mode==='正しい'?{id:'law:test:short-quote',kind:'law',title:'取消届出',url:'https://example.test/short',text:'短い引用'}:material('ta:4508');
  const {r,body}=await missing03i({sentence,type:'要件',subject:'取消届出',sources:[source],opus:req=>{
    if(mode==='呼び出し失敗')throw Error('確かめのAPI失敗');
    return payload(req).claims.flatMap(c=>mode==='重複id'?[{id:c.id,verdict:'誤り'},{id:c.id,verdict:'誤り'}]:mode==='判断できない'?[{id:c.id,verdict:mode}]:mode==='正しい'?[confirmed(req,c,source,/短い引用/,'正しい')]:[{id:c.id,verdict:'記載なし',replacement:'取消届出の期限は延長される場合があります。',reason:'資料に無い'}]);
  }});assert.equal(r.record.status,'ok');assert.equal(r.body,body);assert.equal(r.record.review_items.length,1);assert(!Object.hasOwn(r.record.claims[0].confirm,'blocked'));assert.equal(r.record.confirm.blocked,0);
  if(mode==='正しい')diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');if(mode==='記載なし')diagnostic03c(r.record.claims[0].confirm,'not_stated_meaning');if(mode==='重複id')diagnostic03c(r.record.claims[0].confirm,'answer_shape');if(mode==='呼び出し失敗')diagnostic03c(r.record.claims[0].confirm,'call_failed');
}));
async function slashCase03i({sentence=dateSentence03e,claim=sentence,source=material('qa:invoice/jireishu'),basis=13,verdict='正しい',replacement=''}={}){
  const r=await F.checkFacts(sentence,{...opts,writer_materials:['ta:6501','qa:invoice/jireishu'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'期限','インボイス登録の取消し').map(c=>({...c,claim}));
    const page=materials(req).find(p=>p.url===source.url);assert(page);assert(page.rows.some(u=>u.s===basis),'指定の文を実際に提示');
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict,evidence_id:page.number,basis:String(basis),replacement,reason:'指定された引用で確認'}));
    return payload(req).claims.map(c=>({id:c.id,status:'資料なし'}));
  }});return r;
}
for(const [basis,claim]of [[13,dateSentence03e],[16,'期限は12月17日'],[16,'1月1日から取り消す場合の期限は12月17日']])test('03i-B','7: 本物の事例集の文'+basis+'で'+claim+'を満たす',async()=>feature(async()=>{
  const r=await slashCase03i({basis,claim});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].status,'裏付けあり');assert.equal(r.record.claims[0].confirm.verdict,'正しい');assert.equal(r.record.claims[0].confirm.evidence_id,'qa:invoice/jireishu');assert.equal(r.body,dateSentence03e);
}));
for(const sentence of ['取消届出の期限は12月18日です。','取消届出の期限は令和8年12月17日です。'])test('03i-B','8: 本物の文13で満たせない日付 '+sentence,async()=>feature(async()=>{
  const r=await slashCase03i({sentence});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');assert.equal(r.body,sentence);
}));
const slashSource03i=text=>({id:'law:test:slash-dates',kind:'law',title:'取消届出の期限',url:'https://example.test/slash-dates',text});
for(const [text,date]of [
  ['所得の金額に1/2を乗じた金額とします。','1月2日'],['割合を計算する式は× 1/2とされています。','1月2日'],['総数の7/10に相当する数を用いて計算します。','7月10日'],['割合を計算する式は1/2=1/8とされています。','1月2日'],
  ['登録取消しの日を2027/12/17とする例です。','12月17日'],['登録取消しの日をX/1/1とする例です。','1月1日'],['登録取消しの日をR10/12とする例です。','10月12日'],
])test('03i-B','8: 分数・年付きの一部を日付にしない '+text,async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'取消届出の期限は'+date+'です。',source:slashSource03i(text),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
test('03i-B','8: 引用の前後300字にだけある12/17は日付の根拠にしない',async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'取消届出の期限は12月17日です。',source:slashSource03i('取消届出の手続は国税庁の案内を確認してください。\n期限の例示は12/17までとされています。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
test('03i-B','9: 本物の文13で修正文の12月17日を確かめて書き換える',async()=>feature(async()=>{
  const sentence='取消届出の期限は12月31日です。',replacement='取消届出の期限は12月17日です。',r=await slashCase03i({sentence,verdict:'誤り',replacement});
  assert.equal(r.record.status,'ok');assert.equal(r.body,replacement);assert.equal(r.record.claims[0].confirm.verdict,'誤り');assert.equal(r.record.corrections.length,1);assert.equal(r.record.confirm.blocked,0);
}));
test('03i-B','10: 数字の一般の読み方と段Aの引用は12/17を日付にしない',async()=>feature(async()=>{
  assert.deepEqual(F.normalizedNumbers('12/17'),['12','17']);
  const source=material('qa:invoice/jireishu'),quote=page03c(source).units.find(u=>u.s===13).text;
  assert.equal(private03i.exports.sufficient03i({sentence:dateSentence03e,claim:dateSentence03e,type:'期限'},{quote},source,'裏付けあり'),false);
},'false'));
for(const [literal,date]of [['１／２','1月2日'],['01/02','1月2日'],['2/29','2月29日'],['4/30','4月30日']])test('03i-B','日付の字幅・先頭ゼロ・月の日数: '+literal,async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'取消届出の期限は'+date+'です。',source:slashSource03i('取消届出は（'+literal+'）までに提出してください。'),basis:1});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));
for(const literal of ['0/2','13/2','1/0','1/32','2/30','4/31','001/02','01/002'])test('03i-B','日付として読まない月日・桁数: '+literal,async()=>feature(async()=>{
  const [month,day]=literal.split('/').map(Number),r=await slashCase03i({sentence:'取消届出の期限は'+month+'月'+day+'日です。',source:slashSource03i('取消届出は（'+literal+'）までに提出してください。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
for(const prefix of ['123','A','_','.',',','/','×','*','÷','=','+','−','-','の',';'])test('03i-B','直前の文字で日付にしない: '+prefix,async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'取消届出の期限は1月2日です。',source:slashSource03i('取消届出の記載例は'+prefix+' 1/2とされています。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
for(const suffix of ['999','/3','=','+','×','*','÷','−','に相当','相当','を乗じ','を掛け','の割合','倍','を超え'])test('03i-B','直後の文字で日付にしない: '+suffix,async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'取消届出の期限は1月2日です。',source:slashSource03i('取消届出の記載例は1/2 '+suffix+'とされています。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
test('03i-A','元の期限の書き漏れの状態とGLMの答えは採れない誤りでも残す',async()=>feature(async()=>{
  const source=material('ta:4508'),body='住宅取得等資金の贈与は非課税です。',correct='令和8年12月31日まで';
  const r=await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:load,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件','住宅取得等資金の贈与の非課税');
    if(req.task==='confirm')return payload(req).claims.map(c=>({id:c.id,verdict:'誤り',evidence_id:999,basis:'1',replacement:'住宅取得等資金の贈与は期限内なら非課税です。',reason:'期限が必要'}));
    return payload(req).claims.map(c=>judged(req,c,source,/令和8年12月31日/,'期限の書き漏れ',correct));
  }});const c=r.record.claims[0];assert.equal(c.status,'期限の書き漏れ');assert.equal(c.correct,correct);assert.equal(c.confirm.blocked,true);assert.equal(r.record.status,'revise');assert.equal(r.body,body);assert.equal(r.record.remaining.length,1);assert.equal(r.record.review_items.length,0);
}));

// 03j: 本物の分数を日付として採らず、unknown()と再試行の「誤り」も停止を確認する。
for(const [id,pattern,date,verdict]of [
  ['tsutatsu:sozoku:38-2',/3\s*\/\s*12/,'3月12日','正しい'],
  ['tsutatsu:sozoku:38-2',/3\s*\/\s*12/,'3月12日','誤り'],
  ['tsutatsu:sozoku:16-1',/1\s*\/\s*2/,'1月2日','正しい'],
  ['qa:keigen/gaiyo-2w',/2\s*\/\s*3/,'2月3日','正しい'],
])test('03j-L1','L1-c: 本物の'+id+'の分数で'+date+'を'+verdict+'にしない',async()=>feature(async()=>{
  const source=material(id),unit=page03c(source).units.find(u=>pattern.test(u.text.normalize('NFKC')));assert(unit,'本物のカタログの分数');
  const sentence='提出期限は'+(verdict==='誤り'?'3月15日':date)+'です。',replacement=verdict==='誤り'?'提出期限は3月12日です。':'';
  const r=await slashCase03i({sentence,source,basis:unit.s,verdict,replacement});
  assert.equal(r.record.status,'revise');diagnostic03c(r.record.claims[0].confirm,verdict==='誤り'?'replacement_numbers':'quote_insufficient');assert.equal(r.body,sentence);assert.equal(r.record.corrections.length,0);assert.equal(r.record.claims[0].confirm.answer.verdict,verdict);assert.equal(r.record.claims[0].confirm.answer.evidence_id,id);
  if(verdict==='誤り')assert.equal(r.record.claims[0].confirm.blocked,true);
}));
for(const suffix of ['&times;1/2','&divide;2','-1/4'])test('03j-L1','L1-a: 直後の'+suffix+'を分数の続きとして日付にしない',async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'提出期限は1月2日です。',source:slashSource03i('提出期限の資料には（1/2'+suffix+'）という記載があります。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
for(const word of ['×','&times;','÷','=','分の','割合','持分','相続分','按分','あん分','乗じ','掛け'])test('03j-L1','L1-b: 同じ引用部分の'+word+'があればスラッシュを日付にしない',async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'提出期限は3月12日です。',source:slashSource03i('提出期限の資料には3/12（'+word+'に関する補足）が記載されています。'),basis:1});diagnostic03c(r.record.claims[0].confirm,'quote_insufficient');assert.equal(r.record.status,'revise');
}));
test('03j-L1','L1-b: 分数の語が別の引用部分にあっても日付の部分は読む',async()=>feature(async()=>{
  const source=slashSource03i('提出期限は12/17までとされています。\n添付書類は案内を確認してください。\n計算する割合は1/2とされています。'),page=page03c(source),finding={id:'c1',type:'期限',subject:'取消届出',sentence:'提出期限は12月17日です。',claim:'提出期限は12月17日',status:'資料なし',evidence:[source]};
  const result=await private03c.exports.validate03c(finding.sentence,finding,{verdict:'正しい',evidence_id:1,basis:'1,3'},[page],{});assert.equal(result.verdict,'正しい');assert.equal(result.quote,page.units.filter(u=>u.s===1||u.s===3).map(u=>u.text).join('\n…\n'));
}));
test('03j-L1','L1-b: 分数の語があっても通常の12月17日の読みは残す',async()=>feature(async()=>{
  const r=await slashCase03i({sentence:'提出期限は12月17日です。',source:slashSource03i('提出期限は12月17日までであり、持分の計算とは区別してください。'),basis:1});assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].confirm.verdict,'正しい');
}));
for(const mode of ['secret','exception','再試行'])test('03j-L4','unknown()・出力上限の'+mode+'で採れなかった誤りも止める',async()=>feature(async()=>{
  let attempts=0;const key='sk-test-confirm-secret123456789';
  const r=await recipientCase((req,source)=>{
    attempts++;if(mode==='再試行'&&!req.retry)return {text:'[',stop_reason:'max_tokens'};
    return payload(req).claims.map(c=>({...confirmed(req,c,source,/直系卑属/,'誤り',mode==='secret'?key:rightRecipient),...(mode==='再試行'?{basis:'不正'}:{})}));
  },mode==='exception'?{validateRepair:()=>{throw Error('検証の試験用例外');}}:{});
  blocked03i(r,r.record.claims[0],mode==='再試行'?'basis_unreadable':mode,rightRecipient);assert.equal(r.body,wrongRecipient);assert.equal(r.record.confirm.blocked,1);assert.equal(r.record.confirm.unknown,1);assert.equal(r.record.confirm.verdicts['誤り'],1);assert(!JSON.stringify(r.record).includes(key));
  if(mode==='再試行'){assert.equal(attempts,2);assert.equal(r.record.confirm.calls,2);assert.equal(r.record.claims[0].confirm.call,2);assert(r.record.calls.some(c=>c.task==='confirm'&&c.retry));}else assert.equal(attempts,1);
}));

(async()=>{
  const original=global.fetch;global.fetch=async()=>{throw Error('試験中の通信は禁止');};
  try{for(const {group,name,run}of cases){const result=groups[group]||=( {pass:0,fail:0} );try{await run();result.pass++;console.log(`PASS ${group}: ${name}`);}catch(error){result.fail++;console.error(`FAIL ${group}: ${name}\n${error.stack}`);}}}
  finally{global.fetch=original;}
  const passed=Object.values(groups).reduce((n,r)=>n+r.pass,0),failed=Object.values(groups).reduce((n,r)=>n+r.fail,0);
  console.log(JSON.stringify({passed,failed,groups}));if(failed)process.exitCode=1;
})();
