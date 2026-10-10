'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./lib/fact-check');
const { readPosts } = require('./lib/freshness-candidates');
const { AUDIT_DIR, readLatestAudits } = require('./lib/fact-audit');
const ROOT = path.join(__dirname, '..');

function parseArgs(args) {
  const options = { limit: 10, offset: 0, dryRun: false, resume: false };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--dry-run' || name === '--resume') { options[name === '--dry-run' ? 'dryRun' : 'resume'] = true; continue; }
    if (!['--limit', '--offset', '--slug', '--since'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('引数が不正です');
    const value = args[++i];
    if (name === '--limit' || name === '--offset') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (name === '--limit' && Number(value) < 1)) throw new Error('件数が不正です');
      options[name.slice(2)] = Number(value);
    } else if (name === '--slug') {
      options.slugs = value.split(',');
      if (!options.slugs.every(slug => /^[a-z0-9][a-z0-9_-]*$/i.test(slug))) throw new Error('slugが不正です');
    } else {
      const date = new Date(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('公開日が不正です');
      options.since = value;
    }
  }
  return options;
}
function publishedDate(post) {
  const value = post.published_at || post.publish_at || String(post.file || '').slice(0, 10);
  return value instanceof Date ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(value) : String(value).slice(0, 10);
}
function selectPosts(posts, options) {
  return posts.filter(p => p.review_status === 'published' && (!options.slugs || options.slugs.includes(p.slug)) && (!options.since || publishedDate(p) >= options.since))
    .sort((a, b) => publishedDate(a).localeCompare(publishedDate(b)) || a.slug.localeCompare(b.slug))
    .slice(options.offset, options.offset + options.limit);
}
function estimateClaims(body) {
  return (body.match(/[^。\n]+。?/g) || []).filter(s => !/^\s*#{1,6}\s/.test(s) && /\d|[〇一二三四五六七八九十]+(?:円|年|月|日)|要件|対象|期限|控除|非課税|申告|届出|申請|判定|税率|保存|適用/.test(s));
}
function estimateAudit(posts) {
  const claims = posts.reduce((sum, p) => sum + estimateClaims(p.body).length, 0);
  const bodies = posts.reduce((sum, p) => sum + p.body.length, 0);
  // 判定は10主張ずつ本文も送る。各主張の原文は最大3件×2000文字。
  const inputChars = posts.reduce((sum, p) => {
    const n = Math.min(estimateClaims(p.body).length, F.config().maxClaims);
    return sum + p.body.length + 700 + Math.ceil(n / 10) * (p.body.length + 1000) + n * 6500;
  }, 0);
  const inputTokens = Math.ceil(inputChars * 1.5), outputTokens = claims * 250;
  const inputRate = Number(process.env.FACT_CHECK_INPUT_USD_PER_MILLION), outputRate = Number(process.env.FACT_CHECK_OUTPUT_USD_PER_MILLION);
  const costUsd = Number.isFinite(inputRate) && Number.isFinite(outputRate) && inputRate > 0 && outputRate > 0
    ? (inputTokens * inputRate + outputTokens * outputRate) / 1000000 : null;
  return { articles: posts.length, claims, body_chars: bodies, input_chars: inputChars, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd,
    note: '件数は文からの概算、文字数は根拠3件の上限で計算。料金は設定単価による概算です。単価未設定時は金額を出しません。' };
}
const md = value => String(value || '').replace(/([\\`*_{}[\]<>|])/g, '\\$1').replace(/\r?\n/g, ' ');
function counts(record) {
  const rows = record.claims || [];
  return { mismatch: rows.filter(c => c.status === '食い違い').length, deadline: rows.filter(c => c.status === '期限の書き漏れ').length,
    unsupported: rows.filter(c => c.status === '資料なし' && ['要件', '判定', '金額', '割合', '期限', '適用年', '手続', '番号'].includes(c.type)).length };
}
function renderReport(records, { skipped = 0 } = {}) {
  const ordered = [...records].sort((a, b) => counts(b).mismatch - counts(a).mismatch || a.slug.localeCompare(b.slug));
  const total = ordered.reduce((sum, r) => { const c = counts(r); for (const k of Object.keys(sum)) sum[k] += c[k]; return sum; }, { mismatch: 0, deadline: 0, unsupported: 0 });
  const checked = ordered.filter(r => r.status !== 'not_run').length;
  const lines = ['# 公開済み記事の事実照合', '', `食い違い ${total.mismatch} 件・期限の書き漏れ ${total.deadline} 件・資料なし ${total.unsupported} 件。`,
    `照合した記事 ${checked} 本・飛ばした記事 ${skipped} 本・照合できなかった記事 ${ordered.length - checked} 本。記事本文は変更していません。`, ''];
  for (const r of ordered) {
    const c = counts(r);
    lines.push(`## ${md(r.slug)}`, '', `${md(r.title)} — 食い違い ${c.mismatch} 件・期限の書き漏れ ${c.deadline} 件・資料なし ${c.unsupported} 件（${md(r.status)}）`, '', md(r.summary), '');
    for (const finding of (r.claims || []).filter(c => c.status !== '裏付けあり')) {
      lines.push(`- ${md(finding.status)}: ${md(finding.sentence)}`, `  - 正しい内容: ${md(finding.correct || '資料なし')}`, `  - 根拠の抜粋: ${md(finding.quote)}`);
      for (const e of F.evidenceRefs(r, finding)) if (/^https:\/\//.test(e.url || '')) lines.push(`  - [${md(e.title || '根拠')}](${encodeURI(e.url).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16))})`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
function atomicWrite(file, value) {
  const temp = `${file}.tmp`; fs.writeFileSync(temp, value, 'utf8'); fs.renameSync(temp, file);
}
async function run(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args), now = dependencies.now || new Date(), log = dependencies.log || console.log;
  const posts = selectPosts(dependencies.posts || readPosts(path.join(ROOT, 'content/posts')), options);
  if (options.dryRun) {
    const estimate = estimateAudit(posts); log(JSON.stringify(estimate, null, 2)); return { estimate, records: [] };
  }
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
  const dir = path.join(dependencies.auditDir || AUDIT_DIR, day);
  const priorResults = options.resume ? readLatestAudits(dependencies.auditDir || AUDIT_DIR) : {};
  fs.mkdirSync(dir, { recursive: true });
  const records = fs.readdirSync(dir).filter(name => /^[a-z0-9][a-z0-9_-]*\.json$/i.test(name)).map(name => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { return null; }
  }).filter(r => r?.version === 1);
  let skipped = 0;
  const remember = record => {
    const index = records.findIndex(r => r.slug === record.slug);
    if (index >= 0) records[index] = record; else records.push(record);
  };
  const report = () => atomicWrite(path.join(dir, 'report.md'), renderReport(records, { skipped }));
  for (const post of posts) {
    const file = F.recordPath(post.slug, dir);
    if (options.resume) {
      const prior = priorResults[post.slug];
      if (prior && prior.version === 1 && prior.slug === post.slug && ['ok', 'revise'].includes(prior.status) && prior.body_sha256 === F.bodyHash(post.body)) { remember(prior); skipped++; report(); continue; }
    }
    const result = await (dependencies.checkFacts || F.checkFacts)(post.body, { ...dependencies, now, repair: false,
      tax_terms: post.tax_terms, tax_domain: post.tax_domain, source_bundle: post.source_bundle });
    const record = F.compactRecord({ ...result.record, slug: post.slug, title: post.title, file: post.file });
    atomicWrite(file, JSON.stringify(record, null, 2) + '\n'); remember(record); report();
    log(`${post.slug}: ${record.status} — ${record.summary || ''}`);
  }
  if (!posts.length) report();
  return { records, skipped, dir };
}
if (require.main === module) run().then(r => { if (r.records.some(r => r.status === 'not_run')) process.exitCode = 1; }).catch(() => {
  console.error('公開済み記事の照合を完了できませんでした。保存済みの結果を確認してください。'); process.exitCode = 1;
});
module.exports = { parseArgs, selectPosts, estimateClaims, estimateAudit, counts, renderReport, run };
