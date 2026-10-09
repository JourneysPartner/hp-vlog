'use strict';

function readDraftCron(text) {
  const section = String(text || '').match(/^\[functions\."scheduler-daily-draft"\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  const schedule = section && section[1].match(/^\s*schedule\s*=\s*["']([^"']+)["']/m);
  return schedule ? schedule[1] : '';
}

function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length === 5 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1])
      && Number(fields[0]) < 60 && Number(fields[1]) < 24
      && fields[2] === '*' && fields[3] === '*'
      && (fields[4] === '*' || /^[0-7](?:,[0-7])*$/.test(fields[4]))) {
    return { minute: Number(fields[0]), hour: Number(fields[1]),
      days: fields[4] === '*' ? [0, 1, 2, 3, 4, 5, 6] : [...new Set(fields[4].split(',').map(day => Number(day) % 7))], warning: '' };
  }
  return { minute: 5, hour: 0, days: [0, 1, 2, 3, 4, 5, 6],
    warning: '生成予定の cron を読めないため、毎日 00:05 UTC として点検します' };
}

function latestExpectedSlot(now, cron, graceMinutes = 180) {
  const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
  const cutoff = new Date(new Date(now).getTime() - graceMinutes * 60000);
  if (!Number.isFinite(cutoff.getTime())) throw new Error('点検時刻が不正です');
  for (let offset = 0; offset <= 7; offset++) {
    const slot = new Date(cutoff);
    slot.setUTCDate(slot.getUTCDate() - offset);
    slot.setUTCHours(parsed.hour, parsed.minute, 0, 0);
    if (slot <= cutoff && parsed.days.includes(slot.getUTCDay())) return slot;
  }
  throw new Error('生成予定を計算できません');
}

function judgeDraftRan(runs, slot, toleranceMinutes = 10) {
  const threshold = slot.getTime() - toleranceMinutes * 60000;
  return runs.filter(run => run.conclusion === 'success' && new Date(run.createdAt).getTime() >= threshold).length;
}

module.exports = { readDraftCron, parseCron, latestExpectedSlot, judgeDraftRan };
