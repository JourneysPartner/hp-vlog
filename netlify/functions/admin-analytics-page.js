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
:root{--navy:#0b2045;--orange:#e85320;--green:#16805b;--line:#dbe3ef;--muted:#64748b}*{box-sizing:border-box}body{margin:0;background:#f6f8fc;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}.head{background:var(--navy);color:white;padding:18px 24px}.head h1{margin:0;font-size:20px}.head p{margin:5px 0 0;font-size:13px;opacity:.82}.wrap{max-width:1100px;margin:24px auto;padding:0 16px}.notice{font-size:13px;color:var(--muted);margin:0 0 16px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.panel{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 3px #0f172a0d}.card{padding:14px}.card .label{font-size:12px;color:var(--muted)}.stat{display:flex;gap:13px;margin-top:8px}.stat b{font-size:24px;color:var(--navy)}.stat span{font-size:12px;color:var(--muted)}.panel{padding:18px;margin-top:18px}.tools{display:flex;justify-content:space-between;align-items:center;gap:12px}.tools h2{font-size:16px;margin:0}.tools button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 13px;cursor:pointer}.tools button.active{background:var(--navy);color:white;border-color:var(--navy)}#chart{width:100%;min-height:230px;margin-top:14px}.legend{font-size:12px;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 12px}.pv{background:var(--orange)}.uu{background:var(--green)}ol{margin:12px 0 0;padding-left:24px}li{padding:8px 0;border-bottom:1px solid #edf1f6;display:flex;gap:12px;justify-content:space-between}li:last-child{border:0}.path{font-size:13px;color:var(--muted)}.error{color:#b42318}.gsc{white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:520px;overflow:auto;margin:12px 0 0}@media(max-width:720px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.wrap{padding:0 12px}}
</style></head><body><header class="head"><h1>アクセス解析</h1><p>ブラウザ単位の日次ユニークによる参考値です。</p></header>${renderAdminNav('analytics')}
<main class="wrap"><p class="notice">bot・スパムを完全には除去できません。数値は傾向把握のためにご利用ください。</p><section class="cards" id="cards">読み込み中…</section>
<section class="panel"><div class="tools"><h2>日次推移 <span class="legend"><i class="dot uu"></i>訪問者 <i class="dot pv"></i>PV</span></h2><div id="period"><button data-days="7">7日</button><button data-days="30" class="active">30日</button><button data-days="90">90日</button></div></div><div id="chart"></div></section>
<section class="panel"><h2>人気ページ Top 10</h2><ol id="top"></ol></section><section class="panel"><h2>問い合わせにつながったページ</h2><p class="notice">選択中の期間に、このページから問い合わせページへ進んだ回数です。</p><ol id="contact-from"></ol></section>{{SEARCH_CONSOLE}}</main>
<script>
(() => { let state={data:null,map:{},days:30}; const n=x=>Number(x||0).toLocaleString('ja-JP');
function totals(rows){return rows.reduce((a,r)=>({pageviews:a.pageviews+r.pageviews,visitors:a.visitors+r.visitors}),{pageviews:0,visitors:0})}
function renderCards(s){const items=[['今日',s.today],['昨日',s.yesterday],['直近7日',s.sevenDays],['直近30日',s.thirtyDays]];document.getElementById('cards').innerHTML=items.map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="stat"><div><b>'+n(x[1].visitors)+'</b><br><span>訪問者</span></div><div><b>'+n(x[1].pageviews)+'</b><br><span>PV</span></div></div></div>').join('')}
function line(points,color,max,w,h){return '<polyline fill="none" stroke="'+color+'" stroke-width="2.5" points="'+points.map((v,i)=>{const x=points.length===1?w/2:32+(w-44)*i/(points.length-1);const y=h-24-(h-40)*(v/max);return x.toFixed(1)+','+y.toFixed(1)}).join(' ')+'"/>'}
function render(){const rows=state.data.daily.slice(-state.days);const max=Math.max(1,...rows.map(r=>Math.max(r.pageviews,r.visitors)));const w=760,h=230;const labels=rows.filter((_,i)=>i===0||i===rows.length-1).map((r,i)=>'<text x="'+(i===0?32:w-12)+'" y="224" font-size="11" text-anchor="'+(i===0?'start':'end')+'" fill="#64748b">'+r.date.slice(5)+'</text>').join('');document.getElementById('chart').innerHTML='<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="訪問者とPVの日次グラフ"><line x1="32" y1="'+(h-24)+'" x2="'+(w-12)+'" y2="'+(h-24)+'" stroke="#dbe3ef"/>'+line(rows.map(r=>r.pageviews),'#e85320',max,w,h)+line(rows.map(r=>r.visitors),'#16805b',max,w,h)+'<text x="4" y="16" font-size="11" fill="#64748b">最大 '+n(max)+'</text>'+labels+'</svg>';const paths={};rows.forEach(r=>Object.entries(r.byPath).forEach(([p,v])=>paths[p]=(paths[p]||0)+v));const top=Object.entries(paths).sort((a,b)=>b[1]-a[1]).slice(0,10);document.getElementById('top').innerHTML=top.length?top.map(([p,v])=>'<li><span><strong>'+escapeHtml(state.map[p]||p)+'</strong><br><span class="path">'+escapeHtml(p)+'</span></span><b>'+n(v)+' PV</b></li>').join(''):'<li>まだデータがありません。</li>';const cf={};rows.forEach(r=>Object.entries(r.contactFrom||{}).forEach(([p,v])=>cf[p]=(cf[p]||0)+v));const cfTop=Object.entries(cf).sort((a,b)=>b[1]-a[1]).slice(0,10);document.getElementById('contact-from').innerHTML=cfTop.length?cfTop.map(([p,v])=>'<li><span><strong>'+escapeHtml(state.map[p]||p)+'</strong><br><span class="path">'+escapeHtml(p)+'</span></span><b>'+n(v)+' 回</b></li>').join(''):'<li>まだデータがありません。</li>'}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.getElementById('period').addEventListener('click',e=>{if(e.target.tagName!=='BUTTON')return;state.days=Number(e.target.dataset.days);document.querySelectorAll('#period button').forEach(b=>b.classList.toggle('active',Number(b.dataset.days)===state.days));render()});
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
