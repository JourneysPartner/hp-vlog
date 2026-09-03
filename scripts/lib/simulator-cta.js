'use strict';

const { TOOL_DEFINITIONS } = require('./publish-prep');

const CTA_DEFINITIONS = Object.freeze([
  Object.freeze({
    simulatorType: 'hojinnari',
    keywords: Object.freeze(['法人成り', '法人化']),
    prompt: '法人化でどれくらい変わるか、あなたの数字で試算してみる',
    linkLabel: '法人成りシミュレーター',
  }),
  Object.freeze({
    simulatorType: 'yakuin_hoshu',
    keywords: Object.freeze(['役員報酬']),
    prompt: '役員報酬をいくらにするのがよいか試算してみる',
    linkLabel: '役員報酬シミュレーター',
  }),
  Object.freeze({
    simulatorType: 'shohizei',
    categories: Object.freeze(['消費税', 'インボイス']),
    keywords: Object.freeze(['簡易課税', '2割特例', 'インボイス', '免税事業者', '課税事業者']),
    prompt: 'あなたの場合の消費税を試算してみる',
    linkLabel: '消費税シミュレーター',
  }),
  Object.freeze({
    simulatorType: 'sozoku',
    categories: Object.freeze(['相続']),
    keywords: Object.freeze(['相続税', '生前贈与']),
    prompt: '相続税がかかるかどうか試算してみる',
    linkLabel: '相続税シミュレーター',
  }),
]);

function countOccurrences(text, keyword) {
  if (!keyword) return 0;
  return String(text || '').split(keyword).length - 1;
}

function hasEffectiveKeyword(post, keywords) {
  const title = post.title || '';
  const body = post._body || '';
  return keywords.some(keyword =>
    countOccurrences(title, keyword) >= 1 || countOccurrences(body, keyword) >= 2
  );
}

function matchesDefinition(post, definition) {
  const categoryMatch = (definition.categories || []).includes(post.category);
  return categoryMatch || hasEffectiveKeyword(post, definition.keywords);
}

function selectSimulatorCta(post, publishConfig) {
  if (!post || !publishConfig) return null;

  for (const definition of CTA_DEFINITIONS) {
    if (!matchesDefinition(post, definition)) continue;

    // 内容上の先勝ち判定を確定してから公開ゲートを適用する。
    // 上位候補が停止中だからといって、別用途の下位ツールへ誘導しない。
    const config = publishConfig[definition.simulatorType];
    return config && config.enabled === true ? definition : null;
  }
  return null;
}

function generateSimulatorCta(post, publishConfig) {
  const definition = selectSimulatorCta(post, publishConfig);
  if (!definition) return '';

  // slug は公開ページ生成と同じ定義を参照し、リンク先の二重管理を避ける。
  const tool = TOOL_DEFINITIONS[definition.simulatorType];
  if (!tool) return '';

  return `
      <aside class="blog-simulator-cta" aria-label="税務シミュレーター">
        <p class="blog-simulator-cta-prompt">${definition.prompt}</p>
        <a class="blog-simulator-cta-link" href="/tools/${tool.slug}/">
          ${definition.linkLabel} <i class="bi bi-arrow-right" aria-hidden="true"></i>
        </a>
        <p class="blog-simulator-cta-note">無料・登録不要・入力内容は保存されません</p>
      </aside>`;
}

module.exports = Object.freeze({
  CTA_DEFINITIONS,
  generateSimulatorCta,
  selectSimulatorCta,
});
