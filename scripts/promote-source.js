'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const {
  DEFAULT_SOURCE_BY_PAIN,
  PROMOTED_SOURCE_BY_PAIN,
} = require('./lib/tax-authority-refs');
const {
  SOURCE_GUARD_VERSION,
  setFrontmatterFields,
} = require('./lib/source-guard');
const {
  evaluateTopicFit,
  recommendationForDecision,
} = require('./lib/customer-relevance');
const { validateFile } = require('./validate');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MAP_PATH = path.join(ROOT, 'data', 'curated-source-promotions.json');
const DEFAULT_CATALOG_PATH = path.join(ROOT, 'data', 'nta-sources', 'index.json');
const PROMOTABLE_STATUSES = new Set(['draft', 'needs_review', 'needs_revision']);
const PROMOTABLE_PROVENANCE = new Set(['auto', 'domain-fallback']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeAtomic(filePath, content) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

function normalizeUrl(value) {
  return String(value || '').trim();
}

function removeFrontmatterFields(raw, fields) {
  const match = String(raw || '').match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter not found');
  let fm = match[2];
  for (const field of fields) {
    fm = fm.replace(new RegExp(`^${field}:\\s*.*(?:\\r?\\n|$)`, 'm'), '');
  }
  return match[1] + fm.replace(/\s+$/, '') + match[3] + match[4];
}

function catalogEntryForUrl(catalog, url) {
  const entries = Array.isArray(catalog) ? catalog : catalog && catalog.entries;
  if (!Array.isArray(entries)) return null;
  return entries.find(entry => entry
    && entry.type === 'taxanswer'
    && entry.deleted !== true
    && normalizeUrl(entry.url) === url) || null;
}

/**
 * Validate the complete transaction without changing files or module state.
 */
function preflightPromotion(options = {}) {
  const suppliedArticlePath = String(options.articlePath || '').trim();
  if (!suppliedArticlePath) throw new Error('article file is required');
  const articlePath = path.resolve(suppliedArticlePath);
  const registeredUrl = normalizeUrl(options.registeredUrl);
  const mapPath = options.mapPath || DEFAULT_MAP_PATH;
  const catalogPath = options.catalogPath || DEFAULT_CATALOG_PATH;
  const defaultMap = options.defaultMap || DEFAULT_SOURCE_BY_PAIN;

  if (!fs.existsSync(articlePath) || !fs.statSync(articlePath).isFile()) throw new Error('article file not found');
  const articleRaw = fs.readFileSync(articlePath, 'utf8');
  const meta = matter(articleRaw).data || {};
  const provenance = String(meta.source_provenance || 'unknown');
  const status = String(meta.review_status || '');
  const pain = String(meta.pain_point || '').trim();
  const articleUrl = normalizeUrl(meta.source_url);

  if (!PROMOTABLE_PROVENANCE.has(provenance)) {
    throw new Error(`source_provenance is not promotable: ${provenance}`);
  }
  if (!PROMOTABLE_STATUSES.has(status)) {
    throw new Error(`review_status is not promotable: ${status}`);
  }
  if (!pain) throw new Error('pain_point is required');
  if (!articleUrl) throw new Error('source_url is required');
  if (!registeredUrl) throw new Error('--url is required');
  if (registeredUrl !== articleUrl) throw new Error('registered URL does not match article source_url');

  const promotions = fs.existsSync(mapPath) ? readJson(mapPath) : {};
  const existing = defaultMap[pain];
  if (existing && normalizeUrl(existing.url) !== registeredUrl) {
    throw new Error(`existing source map conflicts for pain_point=${pain}`);
  }
  if (promotions[pain] && normalizeUrl(promotions[pain].url) !== registeredUrl) {
    throw new Error(`promotion map conflicts for pain_point=${pain}`);
  }

  const catalog = readJson(catalogPath);
  const catalogEntry = catalogEntryForUrl(catalog, registeredUrl);
  if (!catalogEntry) throw new Error('source URL is not present in the NTA tax-answer catalog');

  return {
    articlePath,
    articleRaw,
    meta,
    pain,
    registeredUrl,
    catalogEntry,
    mapPath,
    promotions,
    defaultMap,
  };
}

/**
 * Apply the map and article updates as one recoverable transaction.
 * Test-only hooks may throw after either write to verify rollback behavior.
 */
function promoteSource(options = {}) {
  const plan = preflightPromotion(options);
  const promotedMap = options.promotedMap || PROMOTED_SOURCE_BY_PAIN;
  const validateArticle = options.validateArticle || validateFile;
  const hooks = options.hooks || {};
  const mapExisted = fs.existsSync(plan.mapPath);
  const mapRawBefore = mapExisted ? fs.readFileSync(plan.mapPath, 'utf8') : null;
  const hadDefault = Object.prototype.hasOwnProperty.call(plan.defaultMap, plan.pain);
  const defaultBefore = plan.defaultMap[plan.pain];
  const hadPromoted = Object.prototype.hasOwnProperty.call(promotedMap, plan.pain);
  const promotedBefore = promotedMap[plan.pain];
  const source = {
    url: plan.registeredUrl,
    title: plan.catalogEntry.title || plan.meta.source_title || plan.registeredUrl,
  };

  try {
    const nextPromotions = { ...plan.promotions, [plan.pain]: source };
    writeAtomic(plan.mapPath, `${JSON.stringify(nextPromotions, null, 2)}\n`);
    plan.defaultMap[plan.pain] = source;
    promotedMap[plan.pain] = source;
    if (hooks.afterMapWrite) hooks.afterMapWrite(plan);

    const fit = evaluateTopicFit({
      ...plan.meta,
      source_url: source.url,
      source_title: source.title,
      source_provenance: 'curated',
      source_confidence: 1,
    });
    if (fit.decision !== 'approve') {
      throw new Error(`promoted article is not approval-ready: ${fit.reason || fit.decision}`);
    }

    let updated = setFrontmatterFields(plan.articleRaw, {
      source_url: source.url,
      source_title: source.title,
      source_provenance: 'curated',
      source_confidence: 1,
      source_guard_version: SOURCE_GUARD_VERSION,
      review_status: 'draft',
      recommendation: recommendationForDecision(fit.decision),
      customer_fit_score: fit.customer_fit_score,
      search_intent_score: fit.search_intent_score,
      practical_usefulness_score: fit.practical_usefulness_score,
      source_alignment_score: fit.source_alignment_score,
      lead_value_score: fit.lead_value_score,
      tax_risk_score: fit.tax_risk_score,
      review_warning: fit.reason || '',
    });
    updated = removeFrontmatterFields(updated, ['approved_at', 'publish_at', 'publish_slot']);
    writeAtomic(plan.articlePath, updated);
    if (hooks.afterArticleWrite) hooks.afterArticleWrite(plan, updated);

    const validation = validateArticle(plan.articlePath);
    if (!validation || (validation.errors && validation.errors.length > 0)) {
      const details = validation && validation.errors ? validation.errors.join('; ') : 'unknown validation failure';
      throw new Error(`validation failed after promotion: ${details}`);
    }
    if (hooks.afterValidate) hooks.afterValidate(plan, validation);

    return { pain_point: plan.pain, source, articlePath: plan.articlePath, validation };
  } catch (error) {
    fs.writeFileSync(plan.articlePath, plan.articleRaw, 'utf8');
    if (mapExisted) fs.writeFileSync(plan.mapPath, mapRawBefore, 'utf8');
    else if (fs.existsSync(plan.mapPath)) fs.unlinkSync(plan.mapPath);

    if (hadDefault) plan.defaultMap[plan.pain] = defaultBefore;
    else delete plan.defaultMap[plan.pain];
    if (hadPromoted) promotedMap[plan.pain] = promotedBefore;
    else delete promotedMap[plan.pain];
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.articlePath = argv[++i];
    else if (argv[i] === '--url') args.registeredUrl = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.articlePath || !args.registeredUrl) {
    console.error('Usage: node scripts/promote-source.js --file content/posts/<file>.md --url <nta-url> [--apply]');
    process.exitCode = 1;
    return;
  }
  try {
    const options = {
      articlePath: path.resolve(ROOT, args.articlePath),
      registeredUrl: args.registeredUrl,
    };
    const result = args.apply ? promoteSource(options) : preflightPromotion(options);
    console.log(args.apply ? 'Promotion applied.' : 'Preflight passed; no files changed.');
    console.log(JSON.stringify({
      pain_point: result.pain || result.pain_point,
      source_url: result.registeredUrl || result.source.url,
    }, null, 2));
  } catch (error) {
    console.error(`Promotion failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  PROMOTABLE_STATUSES,
  PROMOTABLE_PROVENANCE,
  preflightPromotion,
  promoteSource,
  removeFrontmatterFields,
  catalogEntryForUrl,
};
