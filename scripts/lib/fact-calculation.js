'use strict';

// 計算で引用の数字を補えるのは日付だけ。金額・割合の四則演算は扱わない。
const NUM='[0-9〇零一二三四五六七八九十百千万]+';
const DATE=`(?:(?:(令和|平成|昭和|大正|明治)(元|${NUM})|([0-9]{4}))年)?(${NUM})月(${NUM})日`;
const clean=text=>String(text).normalize('NFKC').replace(/\s+/g,'').replace(/[−－]/g,'-');
function integer(text,normalizedNumbers){
  const key=normalizedNumbers('第'+text)[0],value=Number(key);
  if(!/^\d+$/.test(key)||!Number.isSafeInteger(value)||value>1000000)throw Error('読めない');
  return value;
}
function date(text,normalizedNumbers){
  const m=text.match(new RegExp('^'+DATE+'$'));if(!m)throw Error('読めない');
  const year=m[1]?{令和:2018,平成:1988,昭和:1925,大正:1911,明治:1867}[m[1]]+(m[2]==='元'?1:integer(m[2],normalizedNumbers)):m[3]?Number(m[3]):null;
  return{year,month:integer(m[4],normalizedNumbers),day:integer(m[5],normalizedNumbers),key:normalizedNumbers(text)[0]};
}
function dateEquation(left,right,normalizedNumbers){
  const duration=left.match(new RegExp('(\\+|-)('+NUM+')日$'));if(!duration)throw Error('読めない');
  const start=date(left.slice(0,duration.index),normalizedNumbers),end=date(right,normalizedNumbers),days=integer(duration[2],normalizedNumbers);
  for(const year of start.year===null?[2027,2028]:[start.year]){
    const original=new Date(Date.UTC(year,start.month-1,start.day));
    if(original.getUTCFullYear()!==year||original.getUTCMonth()+1!==start.month||original.getUTCDate()!==start.day)throw Error('読めない');
    const result=new Date(original.getTime()+(duration[1]==='-'?-1:1)*days*86400000);
    if((end.year!==null&&result.getUTCFullYear()!==end.year)||result.getUTCMonth()+1!==end.month||result.getUTCDate()!==end.day)throw Error('計算が合わない');
  }
  return{origin:start.key,key:end.key,days,operator:duration[1]};
}
function durationInQuote(quote,days,operator,normalizedNumbers){
  // 日付の「月15日」や「115日前」を15日の日数として拾わない。
  const direction=operator==='-'?'前':'(?:後|を経過)';
  const pattern=new RegExp(`(?<![0-9〇零一二三四五六七八九十百千万億月.,])(${NUM})日${direction}`,'g');
  return [...clean(quote).matchAll(pattern)].some(m=>{try{return integer(m[1],normalizedNumbers)===days;}catch(_){return false;}});
}
function verifyCalculations(calculations,{quote,sentence='',target,normalizedNumbers}){
  const excluded=new Set(),items=Array.isArray(calculations)?calculations:[calculations];
  const dates=items.filter(raw=>typeof raw==='string'&&new RegExp(DATE).test(clean(raw)));
  if(!dates.length)return{excluded};
  if(!Array.isArray(calculations)||calculations.length>3)return{error:'読めない'};
  const parsed=[];
  for(const raw of dates)try{
    if(raw.length>600)throw Error('読めない');const parts=clean(raw).split('=');if(parts.length!==2||!parts.every(Boolean))throw Error('読めない');
    parsed.push(dateEquation(parts[0],parts[1],normalizedNumbers));
  }catch(error){return{error:error.message==='計算が合わない'?error.message:'読めない'};}
  const quoted=new Set(normalizedNumbers(quote)),current=new Set(normalizedNumbers(sentence)),targets=new Set(normalizedNumbers(target)),results=new Set(parsed.map(p=>p.key));
  for(const row of parsed){
    if((results.has(row.origin)&&!quoted.has(row.origin))||(!quoted.has(row.origin)&&!current.has(row.origin))||!durationInQuote(quote,row.days,row.operator,normalizedNumbers))return{error:'数の出どころが無い'};
    if(!targets.has(row.key))return{error:'右辺が主張に無い'};
    excluded.add(row.origin);excluded.add(row.key);
  }
  return{excluded};
}
module.exports={verifyCalculations};
