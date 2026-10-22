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
  assert.equal(r.record.status,'ok');assert.equal(r.record.corrections.length,keep?1:0);assert.equal(r.body,keep?[replacement,...others].join('\n'):body);assert.equal(r.record.claims.find(c=>c.type==='要件').confirm.verdict,keep?'誤り':'判断できない');
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

(async()=>{
  const original=global.fetch;global.fetch=async()=>{throw Error('試験中の通信は禁止');};
  try{for(const {group,name,run}of cases){const result=groups[group]||=( {pass:0,fail:0} );try{await run();result.pass++;console.log(`PASS ${group}: ${name}`);}catch(error){result.fail++;console.error(`FAIL ${group}: ${name}\n${error.stack}`);}}}
  finally{global.fetch=original;}
  const passed=Object.values(groups).reduce((n,r)=>n+r.pass,0),failed=Object.values(groups).reduce((n,r)=>n+r.fail,0);
  console.log(JSON.stringify({passed,failed,groups}));if(failed)process.exitCode=1;
})();
