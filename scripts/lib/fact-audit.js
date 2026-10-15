'use strict';
const fs = require('fs');
const path = require('path');
const { bodyHash, evidenceRefs } = require('./fact-check');
const AUDIT_DIR = path.join(__dirname, '../../data/fact-check/audit');
function readLatestAudits(dir = AUDIT_DIR) {
  const latest = {};
  if (!fs.existsSync(dir)) return latest;
  for (const date of fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse()) {
    for (const name of fs.readdirSync(path.join(dir, date)).filter(name => /^[a-z0-9][a-z0-9_-]*\.json$/i.test(name)).sort()) {
      const slug = name.slice(0, -5);
      if (Object.hasOwn(latest, slug)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, date, name), 'utf8'));
        latest[slug] = record.version === 1 && record.slug === slug ? { ...record,
          audit_path: path.relative(path.join(__dirname, '../..'), path.join(dir, date, name)).replace(/\\/g, '/') } : null;
      } catch (_) { latest[slug] = null; }
    }
  }
  return latest;
}
function auditFindings(record) { return (record?.claims || []).filter(c => c.status !== '裏付けあり'); }
function auditReason(post, record) {
  if (!record || record.status === 'not_run' || record.body_sha256 !== bodyHash(post.body)) return null;
  const findings = auditFindings(record).filter(c => c.status === '食い違い');
  if (!findings.length) return null;
  return { kind: 'fact_mismatch', detail: `事実の照合で食い違い ${findings.length} 件`, where: '本文', audit: {
    mismatch_count: findings.length, checked_at: record.checked_at || '', body_sha256: record.body_sha256,
    record_path: record.audit_path || `data/fact-check/audit/${String(record.checked_at || '').slice(0, 10)}/${record.slug || post.slug}.json`,
  } };
}
function auditInstructions(record) {
  return auditFindings(record).map(c => {
    const refs = evidenceRefs(record, c);
    return `対象の文: ${c.sentence}\n判定: ${c.status}\n原文に基づく修正内容: ${c.correct || '具体的な要件・金額・期限を外し、資料の確認を案内する'}\n根拠の抜粋: ${c.quote || ''}\n${refs.map(e => `${e.title || '根拠'} ${e.url}\n${c.quote || e.text?.slice(0, 500) || ''}`).join('\n')}`;
  }).join('\n\n');
}
module.exports = { AUDIT_DIR, readLatestAudits, auditFindings, auditReason, auditInstructions };
