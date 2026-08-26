'use strict';

const fs = require('fs');
const path = require('path');

const CALENDAR_FILE = path.join(__dirname, '..', '..', 'data', 'tax-calendar.json');

let cachedEntries = null;
let loadWarningShown = false;

function loadEntries() {
  if (cachedEntries !== null) return cachedEntries;
  try {
    const parsed = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    cachedEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    cachedEntries = [];
    if (!loadWarningShown) {
      console.warn(`[tax-calendar] 読込失敗（季節ブーストなしで続行）: ${error.message}`);
      loadWarningShown = true;
    }
  }
  return cachedEntries;
}

function monthInJapan(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return 0;
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
  }).format(date));
}

function topicText(topic = {}) {
  return [topic.search_intent, topic.primary_question, topic.reader_problem, topic.title]
    .filter(Boolean)
    .join(' ');
}

function matchingSeasonEntries(topic = {}, now = new Date()) {
  if (process.env.DISABLE_SEASON_BOOST === 'true') return [];
  const month = monthInJapan(now);
  if (!month) return [];
  const text = topicText(topic);

  return loadEntries().filter(entry => {
    if (!Array.isArray(entry.boost_months) || !entry.boost_months.includes(month)) return false;
    const domainMatch = Array.isArray(entry.tax_domains)
      && entry.tax_domains.includes(topic.tax_domain);
    const keywordMatch = Array.isArray(entry.keywords)
      && entry.keywords.some(keyword => keyword && text.includes(keyword));
    return domainMatch || keywordMatch;
  });
}

function seasonBoost(topic, now = new Date()) {
  return matchingSeasonEntries(topic, now).length > 0 ? 1 : 0;
}

module.exports = {
  seasonBoost,
  matchingSeasonEntries,
  monthInJapan,
  loadEntries,
  CALENDAR_FILE,
};
