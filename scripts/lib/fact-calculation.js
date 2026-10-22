'use strict';

// 確かめの式だけを読む。数値はBigIntの分数で持ち、JavaScriptの式として実行しない。
const DIGITS='〇零一二三四五六七八九';
const NUM='[0-9〇零一二三四五六七八九十百千万億]+(?:,[0-9]{3})*(?:\\.[0-9]+)?(?:[万億][0-9〇零一二三四五六七八九十百千万億]*(?:\\.[0-9]+)?)*';
const LITERAL=new RegExp(`^(?:${NUM}分の${NUM}(?:%|パーセント)?|${NUM}割(?:${NUM}分)?|${NUM}(?:%|パーセント|円|日)?)`);
const clean=text=>String(text).normalize('NFKC').replace(/\s+/g,'').replace(/[−－]/g,'-');
function fraction(n,d=1n){
  if(!d)throw Error('計算が合わない');if(d<0n){n=-n;d=-d;}
  let a=n<0n?-n:n,b=d;while(b)[a,b]=[b,a%b];return{n:n/(a||1n),d:d/(a||1n)};
}
const add=(a,b)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
const mul=(a,b)=>fraction(a.n*b.n,a.d*b.d);
const equal=(a,b)=>a.n===b.n&&a.d===b.d;
function numeral(text){
  let total=fraction(0n),section=fraction(0n),num=fraction(0n),seen=false;
  for(const token of text.replace(/,/g,'').match(/[0-9]+(?:\.[0-9]+)?|[〇零一二三四五六七八九]+|[十百千万億]/g)||[]){
    const unit={十:10n,百:100n,千:1000n,万:10000n,億:100000000n}[token];
    if(!unit){const raw=/[0-9]/.test(token)?token:[...token].map(c=>c==='零'||c==='〇'?0:DIGITS.indexOf(c)-1).join('');const [whole,decimal='']=raw.split('.');num=fraction(BigInt(whole+decimal),10n**BigInt(decimal.length));seen=true;}
    else if(unit<10000n){section=add(section,mul(seen?num:fraction(1n),fraction(unit)));num=fraction(0n);seen=false;}
    else{total=add(total,mul(add(section,seen?num:fraction(section.n?0n:1n)),fraction(unit)));section=num=fraction(0n);seen=false;}
  }
  return add(total,add(section,num));
}
function literal(raw,normalizedNumbers){
  const keys=normalizedNumbers(raw);if(keys.length!==1||keys[0]===null)throw Error('読めない');
  let value,match;
  if((match=raw.match(new RegExp(`^(${NUM})分の(${NUM})(%|パーセント)?$`)))){const denominator=numeral(match[1]);if(!denominator.n)throw Error('計算が合わない');value=mul(numeral(match[2]),fraction(denominator.d,denominator.n));if(match[3])value=mul(value,fraction(1n,100n));}
  else if((match=raw.match(new RegExp(`^(${NUM})割(?:(${NUM})分)?$`))))value=add(mul(numeral(match[1]),fraction(1n,10n)),mul(numeral(match[2]||'0'),fraction(1n,100n)));
  else{const percent=/%$|パーセント$/.test(raw);value=numeral(raw.replace(/%$|パーセント$|円$|日$/,''));if(percent)value=mul(value,fraction(1n,100n));}
  return{key:keys[0],value};
}
function arithmetic(text,normalizedNumbers){
  let at=0,depth=0;const operands=[];
  const factor=()=>{
    if(text[at]==='('){if(++depth>20)throw Error('読めない');at++;const value=expression();if(text[at++]!==')')throw Error('読めない');depth--;return value;}
    const match=text.slice(at).match(LITERAL);if(!match)throw Error('読めない');at+=match[0].length;const number=literal(match[0],normalizedNumbers);operands.push(number.key);return number.value;
  };
  const term=()=>{let value=factor();while(text[at]==='×'||text[at]==='÷'){const op=text[at++],right=factor();value=mul(value,op==='×'?right:fraction(right.d,right.n));}return value;};
  const expression=()=>{let value=term();while(text[at]==='+'||text[at]==='-'){const op=text[at++],right=term();value=add(value,op==='+'?right:fraction(-right.n,right.d));}return value;};
  const value=expression();if(at!==text.length)throw Error('読めない');return{value,operands};
}
const DATE='(?:(?:(令和|平成|昭和|大正|明治)(元|[0-9〇零一二三四五六七八九十百千]+)|([0-9]{4}))年)?([0-9〇零一二三四五六七八九十百千]+)月([0-9〇零一二三四五六七八九十百千]+)日';
function date(text,normalizedNumbers){
  const m=text.match(new RegExp('^'+DATE+'$'));if(!m)throw Error('読めない');
  const integer=s=>{const v=numeral(s);if(v.d!==1n||v.n>10000n)throw Error('読めない');return Number(v.n);};
  const year=m[1]?{令和:2018,平成:1988,昭和:1925,大正:1911,明治:1867}[m[1]]+(m[2]==='元'?1:integer(m[2])):m[3]?Number(m[3]):null;
  return{year,month:integer(m[4]),day:integer(m[5]),key:normalizedNumbers(text)[0]};
}
function dateEquation(left,right,normalizedNumbers){
  const m=left.match(new RegExp('^('+DATE+')(\\+|-)('+NUM+')日$'));if(!m)throw Error('読めない');
  // DATEにも捕捉があるので、日数と演算子は末尾から取り出す。
  const duration=left.match(new RegExp('(\\+|-)('+NUM+')日$')),startText=left.slice(0,duration.index);
  const start=date(startText,normalizedNumbers),end=date(right,normalizedNumbers),days=literal(duration[2]+'日',normalizedNumbers);
  if(days.value.d!==1n||days.value.n>1000000n)throw Error('読めない');
  for(const year of start.year===null?[2027,2028]:[start.year]){
    const original=new Date(Date.UTC(year,start.month-1,start.day));
    if(original.getUTCFullYear()!==year||original.getUTCMonth()+1!==start.month||original.getUTCDate()!==start.day)throw Error('読めない');
    const result=new Date(original.getTime()+(duration[1]==='-'?-1:1)*Number(days.value.n)*86400000);
    if((end.year!==null&&result.getUTCFullYear()!==end.year)||result.getUTCMonth()+1!==end.month||result.getUTCDate()!==end.day)throw Error('計算が合わない');
  }
  return{operands:[start.key,days.key],key:end.key,origin:start.key};
}

function verifyCalculations(calculations,{quote,article,target,normalizedNumbers}){
  const excluded=new Set();
  if(!Array.isArray(calculations)||!calculations.length||calculations.length>3)return{error:'読めない'};
  const quoted=new Set(normalizedNumbers(quote).filter(n=>n!==null)),premises=new Set(article.flatMap(text=>normalizedNumbers(text)).filter(n=>n!==null)),targets=new Set(normalizedNumbers(target).filter(n=>n!==null));
  const parsed=[];
  for(const raw of calculations)try{
    if(typeof raw!=='string'||raw.length>600)throw Error('読めない');const text=clean(raw),parts=text.split('=');if(parts.length!==2||!parts.every(Boolean))throw Error('読めない');
    let checked;
    if(/月|年/.test(text))checked=dateEquation(parts[0],parts[1],normalizedNumbers);
    else{const parsed=arithmetic(parts[0],normalizedNumbers),match=parts[1].match(LITERAL);if(!match||match[0]!==parts[1])throw Error('読めない');const right=literal(parts[1],normalizedNumbers);if(!equal(parsed.value,right.value))throw Error('計算が合わない');checked={operands:parsed.operands,key:right.key};}
    parsed.push(checked);
  }catch(error){return{error:['読めない','計算が合わない'].includes(error.message)?error.message:'読めない'};}
  const results=new Set(parsed.map(row=>row.key));
  for(const checked of parsed)try{
    for(const key of checked.operands){
      if((results.has(key)&&!quoted.has(key))||(!quoted.has(key)&&!premises.has(key)))throw Error('数の出どころが無い');
    }
    // 主張に書かれた左辺の金額・割合・日数は、検算とは別に引用で確かめる。
    if(checked.origin)excluded.add(checked.origin);
    if(!targets.has(checked.key))throw Error('右辺が主張に無い');excluded.add(checked.key);
  }catch(error){return{error:['読めない','計算が合わない','数の出どころが無い','右辺が主張に無い'].includes(error.message)?error.message:'読めない'};}
  return{excluded};
}

module.exports={verifyCalculations};
