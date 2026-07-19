'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { rankSources } = require('./lib/nta-source-matcher');

const ROOT = path.join(__dirname, '..');

function loadTopics(files) {
  if (files.length === 0) {
    const { TOPICS } = require('./topic-pool');
    return TOPICS.filter(topic => ['auto', 'domain-fallback'].includes(topic.source_provenance));
  }
  return files.map(file => {
    const absolute = path.resolve(ROOT, file);
    const raw = fs.readFileSync(absolute, 'utf8');
    return { ...matter(raw).data, _file: path.relative(ROOT, absolute) };
  });
}

function proposeSources(topics) {
  return topics.map(topic => {
    const ranking = rankSources(topic);
    return {
      file: topic._file || null,
      slug: topic.slug || null,
      pain_point: topic.pain_point || null,
      tax_domain: topic.tax_domain || null,
      current_source_url: topic.source_url || null,
      top1_score: ranking.top1 ? ranking.top1.score : null,
      margin: ranking.margin,
      errorCode: ranking.errorCode || null,
      candidates: ranking.candidates.map(candidate => ({
        id: candidate.no,
        title: candidate.title,
        url: candidate.url,
        tax_category_code: candidate.tax_category_code,
        score: candidate.score,
      })),
    };
  });
}

function main() {
  try {
    const topics = loadTopics(process.argv.slice(2));
    console.log(JSON.stringify(proposeSources(topics), null, 2));
  } catch (error) {
    console.error(`Unable to propose sources: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { loadTopics, proposeSources };
