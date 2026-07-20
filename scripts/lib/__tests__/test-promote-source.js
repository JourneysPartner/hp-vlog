'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const { preflightPromotion, promoteSource } = require('../../promote-source');
const { DEFAULT_SOURCE_BY_PAIN } = require('../tax-authority-refs');

const URL_6501 = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm';
const URL_6502 = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6502.htm';
const PAIN = 'promotion-test-pain';

function article(status = 'needs_review', provenance = 'auto') {
  return `---
title: "高額特定資産を取得した場合の消費税の判断"
slug: "promotion-test"
category: "消費税"
primary_persona: "general_corporation"
customer_segment: "general_business"
macro: "高額特定資産"
tax_domain: "consumption_tax"
pain_point: "${PAIN}"
search_intent: "高額特定資産を取得した場合の納税義務免除の特例"
reader_problem: "取得後の納税義務を判断できない"
success_outcome: "免税へ戻れる時期を判断できる"
primary_question: "いつまで納税義務があるか"
source_url: "${URL_6502}"
source_title: "高額特定資産を取得した場合等の納税義務の免除等の特例"
source_provenance: "${provenance}"
source_confidence: 0.65
source_guard_version: 1
recommendation: "revise"
source_alignment_score: 5
review_status: "${status}"
approved_at: "2026-07-01"
publish_at: "2026-07-20"
publish_slot: "morning"
summary: "高額特定資産に関する消費税の判断を実務向けに整理します。"
---
## 要点
本文
## 判断
本文
`;
}

function makeFixture(status = 'needs_review', provenance = 'auto') {
  delete DEFAULT_SOURCE_BY_PAIN[PAIN];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-source-'));
  const articlePath = path.join(dir, 'article.md');
  const mapPath = path.join(dir, 'promotions.json');
  const catalogPath = path.join(dir, 'index.json');
  fs.writeFileSync(articlePath, article(status, provenance), 'utf8');
  fs.writeFileSync(mapPath, '{}\n', 'utf8');
  fs.writeFileSync(catalogPath, JSON.stringify({ entries: [{
    id: '6502',
    type: 'taxanswer',
    tax_category_code: 'shohi',
    title: '高額特定資産を取得した場合等の納税義務の免除等の特例',
    url: URL_6502,
    deleted: false,
  }] }), 'utf8');
  return { dir, articlePath, mapPath, catalogPath, defaultMap: DEFAULT_SOURCE_BY_PAIN, promotedMap: {} };
}

function options(fixture, extra = {}) {
  return {
    articlePath: fixture.articlePath,
    registeredUrl: URL_6502,
    mapPath: fixture.mapPath,
    catalogPath: fixture.catalogPath,
    defaultMap: fixture.defaultMap,
    promotedMap: fixture.promotedMap,
    validateArticle: () => ({ errors: [], warnings: [] }),
    ...extra,
  };
}

function assertUnchanged(fixture, articleBefore, mapBefore) {
  assert.strictEqual(fs.readFileSync(fixture.articlePath, 'utf8'), articleBefore);
  assert.strictEqual(fs.readFileSync(fixture.mapPath, 'utf8'), mapBefore);
  assert.strictEqual(fixture.defaultMap[PAIN], undefined);
  assert.strictEqual(fixture.promotedMap[PAIN], undefined);
}

{
  const f = makeFixture();
  const beforeArticle = fs.readFileSync(f.articlePath, 'utf8');
  const beforeMap = fs.readFileSync(f.mapPath, 'utf8');
  assert.throws(() => preflightPromotion(options(f, { registeredUrl: URL_6501 })), /does not match/);
  assertUnchanged(f, beforeArticle, beforeMap);
}

{
  const f = makeFixture();
  f.defaultMap[PAIN] = { url: URL_6501, title: 'conflict' };
  assert.throws(() => preflightPromotion(options(f)), /conflicts/);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.mapPath, 'utf8'))[PAIN], undefined);
}

for (const status of ['approved', 'scheduled', 'published']) {
  const f = makeFixture(status);
  const beforeArticle = fs.readFileSync(f.articlePath, 'utf8');
  const beforeMap = fs.readFileSync(f.mapPath, 'utf8');
  assert.throws(() => preflightPromotion(options(f)), /not promotable/, status);
  assertUnchanged(f, beforeArticle, beforeMap);
}

{
  const f = makeFixture();
  const result = promoteSource(options(f));
  const meta = matter(fs.readFileSync(f.articlePath, 'utf8')).data;
  assert.strictEqual(result.pain_point, PAIN);
  assert.strictEqual(meta.source_provenance, 'curated');
  assert.strictEqual(meta.source_alignment_score, 5);
  assert.strictEqual(meta.recommendation, 'publish');
  assert.notStrictEqual(meta.recommendation, 'approve');
  assert.strictEqual(meta.review_status, 'draft');
  assert.strictEqual(meta.approved_at, undefined);
  assert.strictEqual(meta.publish_at, undefined);
  assert.strictEqual(meta.publish_slot, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.mapPath, 'utf8'))[PAIN].url, URL_6502);
  assert.strictEqual(f.defaultMap[PAIN].url, URL_6502);
  assert.strictEqual(f.promotedMap[PAIN].url, URL_6502);
}

{
  const f = makeFixture();
  const beforeArticle = fs.readFileSync(f.articlePath, 'utf8');
  const beforeMap = fs.readFileSync(f.mapPath, 'utf8');
  assert.throws(() => promoteSource(options(f, {
    hooks: { afterMapWrite: () => { throw new Error('injected map-stage failure'); } },
  })), /injected/);
  assertUnchanged(f, beforeArticle, beforeMap);
}

{
  const f = makeFixture();
  const beforeArticle = fs.readFileSync(f.articlePath, 'utf8');
  const beforeMap = fs.readFileSync(f.mapPath, 'utf8');
  assert.throws(() => promoteSource(options(f, {
    validateArticle: () => ({ errors: ['injected validation failure'], warnings: [] }),
  })), /validation failed/);
  assertUnchanged(f, beforeArticle, beforeMap);
}

console.log('PASS: promote-source preflight, apply, status rules, and rollback');
