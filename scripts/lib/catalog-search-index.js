'use strict';
const { tokenizeForMatcher } = require('./nta-source-matcher');
// 本文は保存せず、検索語と本文の所在だけを索引に持つ。
function searchIndex(entries) {
  return entries.map(({ text, ...entry }) => ({ ...entry,
    titleTokens: [...tokenizeForMatcher(entry.title)], tokens: [...tokenizeForMatcher(`${entry.title} ${text}`)],
  }));
}
function lawSearchIndex(law) {
  return { ...Object.fromEntries(Object.entries(law).filter(([key]) => key !== 'articles')),
    entries: searchIndex(law.articles.map(a => ({ id: `law:${law.key}:${a.num}`, kind: 'law', key: law.key,
      no: a.num, title: `${law.title} ${a.caption || ''}`, text: a.text, law_version: law.amendment_enforcement_date || '' }))),
  };
}
module.exports = { searchIndex, lawSearchIndex };
