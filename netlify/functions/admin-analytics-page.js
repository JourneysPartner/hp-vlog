'use strict';

const fs = require('fs');
const path = require('path');
const { requireBasicAuth } = require('./lib/admin-auth');
const { renderAdminNav } = require('./lib/admin-nav');

// サーチコンソールの週次レポート（data/search-console/report.md）。
// netlify.toml の [functions] included_files で関数に同梱している。
// 置かれる場所が環境で違うので候補を順に見る。無ければ「未取り込み」と出す。
function readSearchConsoleReport() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'data', 'search-console', 'report.md'),
    path.resolve(process.cwd(), 'data', 'search-console', 'report.md'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* 次の候補 */ }
  }
  return '';
}

function escapeHtmlServer(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSearchConsoleSection() {
  const md = readSearchConsoleReport();
  const body = md
    ? `<pre class="gsc">${escapeHtmlServer(md)}</pre>`
    : '<p class="notice">まだ取り込まれていません。設定手順は docs/search-console-setup.md を参照してください。</p>';
  return `<section class="panel"><h2>検索語（サーチコンソール）</h2><p class="notice">毎週月曜に取り込む週次レポートです（直近28日）。読み取り専用。</p>${body}</section>`;
}

const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>アクセス解析｜毛利順活税理士事務所</title>
<style>
:root{--navy:#0b2045;--orange:#e85320;--green:#16805b;--line:#dbe3ef;--muted:#64748b}*{box-sizing:border-box}body{margin:0;background:#f6f8fc;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}.head{background:var(--navy);color:white;padding:18px 24px}.head h1{margin:0;font-size:20px}.head p{margin:5px 0 0;font-size:13px;opacity:.82}.wrap{max-width:1100px;margin:24px auto;padding:0 16px}.notice{font-size:13px;color:var(--muted);margin:0 0 16px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.panel{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 3px #0f172a0d}.card{padding:14px}.card .label{font-size:12px;color:var(--muted)}.stat{display:flex;gap:13px;margin-top:8px}.stat b{font-size:24px;color:var(--navy)}.stat span{font-size:12px;color:var(--muted)}.panel{padding:18px;margin-top:18px}.tools{display:flex;justify-content:space-between;align-items:center;gap:12px}.tools h2{font-size:16px;margin:0}.tools button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 13px;cursor:pointer}.tools button.active{background:var(--navy);color:white;border-color:var(--navy)}#chart{position:relative;width:100%;min-height:300px;margin-top:14px}.legend{font-size:12px;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 12px}.pv{background:var(--orange)}.uu{background:var(--green)}ol{margin:12px 0 0;padding-left:24px}li{padding:8px 0;border-bottom:1px solid #edf1f6;display:flex;gap:12px;justify-content:space-between}li:last-child{border:0}.path{font-size:13px;color:var(--muted)}.error{color:#b42318}.gsc{white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:520px;overflow:auto;margin:12px 0 0}@media(max-width:720px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.wrap{padding:0 12px}}
.from-panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}@media(max-width:720px){.from-panels{grid-template-columns:1fr}}
#chart svg{display:block;width:100%;height:auto;touch-action:pan-y}#chart svg:focus-visible{outline:2px solid var(--navy);outline-offset:2px}#chart text{font-family:inherit}.axis{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}.peak{font-size:12px;font-weight:700;fill:#1e293b}.dot.pv{border-radius:2px}.chart-tip{position:absolute;top:8px;left:0;pointer-events:none;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 8px #0f172a1f;padding:8px 10px;font-size:12px;line-height:1.7;white-space:nowrap}.chart-tip[hidden]{display:none}.chart-tip b{font-size:14px;color:var(--navy);margin-right:4px}.tip-date{color:var(--muted)}.key{display:inline-block;width:12px;height:2px;margin-right:6px;vertical-align:middle}.chart-note{margin:10px 0 0}.chart-table{margin-top:10px}.chart-table summary{cursor:pointer;font-size:13px;color:var(--navy)}.chart-table>div{max-height:320px;overflow:auto;margin-top:8px}.chart-table table{width:100%;max-width:420px;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}.chart-table th,.chart-table td{padding:5px 10px;border-bottom:1px solid #edf1f6;text-align:right}.chart-table th:first-child,.chart-table td:first-child{text-align:left}.chart-table tr.we{background:#f1f4f9}
</style></head><body><header class="head"><h1>アクセス解析</h1><p>ブラウザ単位の日次ユニークによる参考値です。</p></header>${renderAdminNav('analytics')}
<main class="wrap"><p class="notice">bot・スパムを完全には除去できません。数値は傾向把握のためにご利用ください。</p><section class="cards" id="cards">読み込み中…</section>
<section class="panel"><div class="tools"><h2>日次推移 <span class="legend"><i class="dot uu"></i>訪問者 <i class="dot pv"></i>PV</span></h2><div id="period"><button data-days="7">7日</button><button data-days="30" class="active">30日</button><button data-days="90">90日</button></div></div><div id="chart"></div><p class="notice chart-note" id="chart-note"></p><details class="chart-table"><summary>日別の数値を表で見る</summary><div id="chart-table"></div></details></section>
<section class="panel"><h2>人気ページ Top 10</h2><ol id="top"></ol></section><div class="from-panels"><section class="panel"><h2>問い合わせにつながったページ</h2><p class="notice">選択中の期間に、このページから問い合わせページへ進んだ回数です。</p><ol id="contact-from"></ol></section><section class="panel"><h2>送信完了につながったページ</h2><p class="notice">選択中の期間に、このページを見たあと問い合わせを送った回数です（同じ画面の中で続けて見た場合だけ数えます）。</p><ol id="submitted-from"></ol></section><section class="panel"><h2>LINE 相談につながったページ</h2><p id="line-total"></p><p class="notice">選択中の期間に、お問い合わせページの『LINEで相談する』が押された回数です。ページ名は、問い合わせページの前に見ていたページです（直接来た場合は『お問い合わせ』）。同じ人が 1 分以内に続けて押した分は 1 回と数えます。友だち追加まで進んだかは、LINE 公式アカウントの管理画面で確かめてください。</p><ol id="line-from"></ol></section></div>{{SEARCH_CONSOLE}}</main>
<script>
(() => { let state={data:null,map:{},days:30,chart:null}; const n=x=>Number(x||0).toLocaleString('ja-JP');
function totals(rows){return rows.reduce((a,r)=>({pageviews:a.pageviews+r.pageviews,visitors:a.visitors+r.visitors}),{pageviews:0,visitors:0})}
function renderCards(s){const items=[['今日',s.today],['昨日',s.yesterday],['直近7日',s.sevenDays],['直近30日',s.thirtyDays]];document.getElementById('cards').innerHTML=items.map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="stat"><div><b>'+n(x[1].visitors)+'</b><br><span>訪問者</span></div><div><b>'+n(x[1].pageviews)+'</b><br><span>PV</span></div></div></div>').join('')}
const WEEK=['日','月','火','水','木','金','土'];
function weekday(date){return new Date(date+'T00:00:00Z').getUTCDay()}
function mmdd(date){return Number(date.slice(5,7))+'/'+Number(date.slice(8,10))}
// 縦軸の目盛り幅。最大値を 5 段以内に収める 1・2・5 系の切りのよい整数を選ぶ。
function niceStep(max){const base=10**Math.floor(Math.log10(max));return [base/10,base/5,base/2,base,base*2,base*5,base*10].find(s=>s>=1&&max/s<=5)}
// 横軸に日付を出す位置。7日は毎日（狭い画面は1日おき）、それ以上は月曜を基準に最新の週からそろえる。
function xTicks(rows,stepPx){if(rows.length<=14){const stride=stepPx>=46?1:2;return rows.map((_,i)=>i).filter(i=>(rows.length-1-i)%stride===0)}const mondays=rows.map((r,i)=>weekday(r.date)===1?i:-1).filter(i=>i>=0);const stride=[1,2,4].find(s=>s*7*stepPx>=46)||4;return mondays.filter((_,i)=>(mondays.length-1-i)%stride===0)}
// 色だけに頼らないよう、訪問者は丸・PVは四角で打つ。白抜きは今日の途中経過。
function mark(p,color,square,hollow){const fill=hollow?'#fff':color,stroke=hollow?color:'#fff',r=hollow?4:5;return square?'<rect x="'+(p[0]-r).toFixed(1)+'" y="'+(p[1]-r).toFixed(1)+'" width="'+r*2+'" height="'+r*2+'" rx="1" fill="'+fill+'" stroke="'+stroke+'" stroke-width="2"/>':'<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="'+r+'" fill="'+fill+'" stroke="'+stroke+'" stroke-width="2"/>'}
function line(rows,key,color,square,c){const pts=rows.map((r,i)=>[c.x(i),c.y(r[key])]);const last=pts.length-1;const path=(ps,dash)=>'<polyline fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"'+(dash?' stroke-dasharray="2 6"':'')+' points="'+ps.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')+'"/>';const marks=pts.map((p,i)=>c.stepPx>=14||i===last?mark(p,color,square,c.partial&&i===last):'').join('');return path(c.partial?pts.slice(0,-1):pts)+(c.partial&&last>0?path(pts.slice(-2),true):'')+marks}
function renderChart(rows){const el=document.getElementById('chart');const W=Math.max(320,el.clientWidth||760),H=300,L=40,right=W-24,top=24,bottom=H-46;const max=Math.max(1,...rows.map(r=>Math.max(r.pageviews,r.visitors)));const step=niceStep(max),ceil=Math.ceil(max/step)*step;const stepPx=rows.length>1?(right-L)/(rows.length-1):0;const x=i=>rows.length>1?L+stepPx*i:(L+right)/2;const y=v=>bottom-(bottom-top)*v/ceil;const lastRow=rows[rows.length-1];const partial=!!lastRow&&lastRow.date===state.data.today;const weekly=rows.length>14;const c={rows,x,y,stepPx,partial,W,index:null};state.chart=c;
const bands=rows.map((r,i)=>{const d=weekday(r.date);if(d!==6&&!(d===0&&i===0))return '';const from=Math.max(L,x(i)-stepPx/2),to=Math.min(right,x(d===6?i+1:i)+stepPx/2);return '<rect x="'+from.toFixed(1)+'" y="'+top+'" width="'+(to-from).toFixed(1)+'" height="'+(bottom-top)+'" fill="#f1f4f9"/>'}).join('');
let grid='';for(let v=0;v<=ceil;v+=step)grid+='<line x1="'+L+'" y1="'+y(v).toFixed(1)+'" x2="'+right+'" y2="'+y(v).toFixed(1)+'" stroke="'+(v===0?'#cbd5e1':'#e8edf4')+'"/><text class="axis" x="'+(L-8)+'" y="'+(y(v)+4).toFixed(1)+'" text-anchor="end">'+n(v)+'</text>';
const labels=xTicks(rows,stepPx).map(i=>{const px=x(i).toFixed(1),r=rows[i];return '<line x1="'+px+'" y1="'+bottom+'" x2="'+px+'" y2="'+(bottom+4)+'" stroke="#cbd5e1"/><text class="axis" x="'+px+'" y="'+(bottom+18)+'" text-anchor="middle">'+mmdd(r.date)+'</text>'+(weekly?'':'<text class="axis" x="'+px+'" y="'+(bottom+33)+'" text-anchor="middle">'+WEEK[weekday(r.date)]+'</text>')}).join('');
const peak=rows.reduce((b,r,i)=>r.pageviews>rows[b].pageviews?i:b,0);const peakLabel=rows.length&&rows[peak].pageviews?'<text class="peak" x="'+x(peak).toFixed(1)+'" y="'+(y(rows[peak].pageviews)-10).toFixed(1)+'" text-anchor="'+(peak===0?'start':peak===rows.length-1?'end':'middle')+'">'+n(rows[peak].pageviews)+'</text>':'';
el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" tabindex="0" aria-label="訪問者とPVの日次グラフ。左右の矢印キーで日を移動できます。数値は下の表でも確認できます。">'+bands+grid+labels+line(rows,'pageviews','#e85320',true,c)+line(rows,'visitors','#16805b',false,c)+peakLabel+'<line id="chart-cross" y1="'+top+'" y2="'+bottom+'" stroke="#94a3b8" visibility="hidden"/><text class="axis" x="0" y="11">人・回</text></svg><div class="chart-tip" id="chart-tip" hidden><div class="tip-date" id="tip-date"></div><div><i class="key uu"></i><b id="tip-uu"></b>訪問者</div><div><i class="key pv"></i><b id="tip-pv"></b>PV</div></div>';
document.getElementById('chart-note').textContent='灰色の帯は土日です。'+(weekly?'日付の目盛りは各週の月曜日です。':'')+(partial?'白抜きの点と点線は、今日の途中経過です。':'')+'グラフに触れると、その日の数値が出ます。';
document.getElementById('chart-table').innerHTML='<table><thead><tr><th>日付</th><th>訪問者</th><th>PV</th></tr></thead><tbody>'+rows.slice().reverse().map(r=>{const d=weekday(r.date);return '<tr'+(d===0||d===6?' class="we"':'')+'><td>'+mmdd(r.date)+'（'+WEEK[d]+'）'+(partial&&r.date===state.data.today?' 途中経過':'')+'</td><td>'+n(r.visitors)+'</td><td>'+n(r.pageviews)+'</td></tr>'}).join('')+'</tbody></table>'}
function showTip(i){const c=state.chart;if(!c||!c.rows.length)return;c.index=Math.min(c.rows.length-1,Math.max(0,i));const r=c.rows[c.index],x=c.x(c.index),tip=document.getElementById('chart-tip'),cross=document.getElementById('chart-cross');cross.setAttribute('x1',x);cross.setAttribute('x2',x);cross.setAttribute('visibility','visible');document.getElementById('tip-date').textContent=mmdd(r.date)+'（'+WEEK[weekday(r.date)]+'）'+(c.partial&&c.index===c.rows.length-1?' 途中経過':'');document.getElementById('tip-uu').textContent=n(r.visitors);document.getElementById('tip-pv').textContent=n(r.pageviews);tip.hidden=false;const box=document.getElementById('chart').getBoundingClientRect(),px=x*box.width/c.W;tip.style.left=(px+12+tip.offsetWidth>box.width?px-12-tip.offsetWidth:px+12)+'px'}
function hideTip(){const c=state.chart;if(!c)return;c.index=null;document.getElementById('chart-tip').hidden=true;document.getElementById('chart-cross').setAttribute('visibility','hidden')}
function render(){const rows=state.data.daily.slice(-state.days);renderChart(rows);const paths={};rows.forEach(r=>Object.entries(r.byPath).forEach(([p,v])=>paths[p]=(paths[p]||0)+v));const top=Object.entries(paths).sort((a,b)=>b[1]-a[1]).slice(0,10);document.getElementById('top').innerHTML=top.length?top.map(([p,v])=>'<li><span><strong>'+escapeHtml(state.map[p]||p)+'</strong><br><span class="path">'+escapeHtml(p)+'</span></span><b>'+n(v)+' PV</b></li>').join(''):'<li>まだデータがありません。</li>';renderFrom(rows,'contactFrom','contact-from');renderFrom(rows,'submittedFrom','submitted-from');renderFrom(rows,'lineFrom','line-from');const lineTotal=rows.reduce((sum,r)=>sum+Object.values(r.lineFrom||{}).reduce((a,v)=>a+(Number.isSafeInteger(v)&&v>0?v:0),0),0);document.getElementById('line-total').innerHTML='合計 '+escapeHtml(n(lineTotal))+' 回'}
function renderFrom(rows,key,id){const cf={};rows.forEach(r=>Object.entries(r[key]||{}).forEach(([p,v])=>{if(key==='lineFrom'&&(!Number.isSafeInteger(v)||v<=0))return;cf[p]=(cf[p]||0)+v}));const cfTop=Object.entries(cf).sort((a,b)=>b[1]-a[1]).slice(0,10);document.getElementById(id).innerHTML=cfTop.length?cfTop.map(([p,v])=>'<li><span><strong>'+escapeHtml(state.map[p]||p)+'</strong><br><span class="path">'+escapeHtml(p)+'</span></span><b>'+escapeHtml(n(v))+' 回</b></li>').join(''):'<li>まだデータがありません。</li>'}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.getElementById('period').addEventListener('click',e=>{if(e.target.tagName!=='BUTTON')return;state.days=Number(e.target.dataset.days);document.querySelectorAll('#period button').forEach(b=>b.classList.toggle('active',Number(b.dataset.days)===state.days));render()});
const chartEl=document.getElementById('chart');
function onPointer(e){const c=state.chart;if(!c||!c.stepPx)return;const box=chartEl.getBoundingClientRect();showTip(Math.round(((e.clientX-box.left)*c.W/box.width-c.x(0))/c.stepPx))}
chartEl.addEventListener('pointermove',onPointer);chartEl.addEventListener('pointerdown',onPointer);chartEl.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')hideTip()});chartEl.addEventListener('focusout',hideTip);
chartEl.addEventListener('keydown',e=>{const c=state.chart;if(!c||(e.key!=='ArrowLeft'&&e.key!=='ArrowRight'))return;e.preventDefault();showTip((c.index===null?c.rows.length:c.index)+(e.key==='ArrowLeft'?-1:1))});
if(typeof ResizeObserver==='function')new ResizeObserver(()=>{const c=state.chart;if(c&&Math.max(320,chartEl.clientWidth)!==c.W)renderChart(c.rows)}).observe(chartEl);
Promise.all([fetch('/admin/api/analytics',{credentials:'same-origin',cache:'no-store'}),fetch('/analytics-page-map.json',{cache:'no-store'})]).then(async([a,m])=>{if(!a.ok)throw new Error('HTTP '+a.status);state.data=await a.json();if(!state.data.ok)throw new Error('API error');state.map=m.ok?await m.json():{};renderCards(state.data.summaries);render()}).catch(e=>{document.getElementById('cards').innerHTML='<p class="error">読み込みに失敗しました: '+escapeHtml(e.message)+'</p>'});
})();
</script></body></html>`;

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    body: HTML.replace('{{SEARCH_CONSOLE}}', renderSearchConsoleSection()),
  };
};

module.exports.renderSearchConsoleSection = renderSearchConsoleSection;
