'use strict';

const contentModel = require('./content-model');
const { evidenceCatalog, loadEvidenceText, contiguousExcerpt, subjectWithoutTrailingParens, scoreEvidence } = require('./fact-evidence');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { qaCatalog, materialId, materialIds, resolveMaterial } = require('./writer-materials');

const PLAN_SYSTEM = '税理士事務所のブログ記事の企画です。読者の疑問に答えるために本文で説明が必要な税の制度・論点を、必要なものだけ最大8つ挙げてください。制度の正式な名前に近い名前（国税庁のタックスアンサーの題名に近い言い方）にしてください。出力は JSON 配列だけです。形は [{"name":"制度名","why":"この記事で何を説明するか（30字以内）"}]。';
const FIELDS = ['target_query', 'primary_question', 'search_intent', 'reader_problem', 'success_outcome', 'tax_terms', 'article_type', 'persona'];
const META_FIELDS = ['fact_plan_status', 'fact_plan', 'fact_plan_missing', 'fact_materials'];
const enabled = () => process.env.FACT_PLAN_ENABLED !== 'false';
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

async function planSystems(topic, { generate = prompt => contentModel.generateSimple(prompt, { maxTokens: 2000 }) } = {}) {
  try {
    const result = await generate({ system: PLAN_SYSTEM, user: FIELDS.map(key => `${key}: ${Array.isArray(topic[key]) ? topic[key].join('、') : topic[key] || ''}`).join('\n') });
    const text = String(typeof result === 'string' ? result : result?.text || '');
    let rows;
    if (Array.isArray(result)) rows = result;
    else {
      // 最初の配列を文字列中の括弧に惑わされず読む。前後の説明とコード囲みは無視する。
      for (let start = text.indexOf('['); start >= 0 && !rows; start = text.indexOf('[', start + 1)) {
        let quoted = false, escaped = false, depth = 0;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
          else if (ch === '"') quoted = true;
          else if (ch === '[') depth++;
          else if (ch === ']' && --depth === 0) {
            try { rows = JSON.parse(text.slice(start, i + 1)); } catch (_) { /* 前置きの角括弧は飛ばす。 */ }
            break;
          }
        }
      }
    }
    if (!Array.isArray(rows)) return { status: 'failed', reason: '計画の答えを読めませんでした' };
    const seen = new Set();
    const systems = rows.filter(row => typeof row?.name === 'string').map(row => ({ name: row.name.trim(), why: typeof row.why === 'string' ? row.why.trim().slice(0, 30) : '' }))
      .filter(row => row.name.length >= 2 && row.name.length <= 40)
      .filter(row => { const key = normalize(row.name); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
    return systems.length ? { status: 'ok', systems } : { status: 'failed', reason: '扱う制度がありませんでした' };
  } catch (_) { return { status: 'failed', reason: '計画を作れませんでした' }; }
}

// 助詞と一般語だけで無関係な題名が通らないよう、残る語が2字以上のときだけ条件3を使う。
const GENERAL_WORDS = ['相続税', '贈与税', '所得税', '法人税', '消費税', '制度', '特例', '場合', '非課税', '選択', '方法', 'について', 'に係る', 'に関する', 'の', 'を', 'から', '受けた', 'とき'];
function systemNames(name) {
  const main = normalize(subjectWithoutTrailingParens(name));
  const aliases = [...String(name).normalize('NFKC').matchAll(/\(([^()]{4,})\)/g)].map(m => normalize(m[1]));
  return { main, names: [main, ...aliases].filter(Boolean) };
}
function relevantMaterial(name, ref, body) {
  const { main, names } = systemNames(name);
  const title = normalize(ref.title), text = normalize(body);
  const titleMatch = names.some(n => title.includes(n));
  const bodyMatch = names.some(n => text.includes(n));
  const words = main.split(new RegExp(GENERAL_WORDS.join('|'), 'g')).filter(w => w.length >= 2);
  const termsMatch = words.length > 0 && words.every(w => title.includes(w));
  return { condition: titleMatch ? 1 : bodyMatch ? 2 : termsMatch ? 3 : 0, titleMatch: titleMatch || termsMatch,
    occurrences: names.reduce((sum, n) => sum + text.split(n).length - 1, 0) };
}
function mainText(ref, text) {
  const at = ref.kind === 'taxanswer' ? text.indexOf('関連リンク') : -1;
  return at >= 0 ? text.slice(0, at) : text;
}

function findSystemMaterials(systems, topic = {}, options = {}) {
  const entries = options.entries || [...evidenceCatalog().entries, ...qaCatalog()];
  const scoredEntries = entries.map(e => ({ ...e, tokens: e.tokens || new Set(tokenizeForMatcher(`${e.title} ${e.text}`)),
    titleTokens: e.titleTokens || new Set(tokenizeForMatcher(e.title)) }));
  const existing = new Set((options.existing || []).map(ref => typeof ref === 'string' ? ref : materialId(ref)));
  const attached = new Set(existing);
  const texts = new Map();
  const read = ref => {
    const key = ref.material_id || ref.id;
    if (!texts.has(key)) texts.set(key, mainText(ref, (options.loadEvidenceText || loadEvidenceText)(ref)));
    return texts.get(key);
  };
  let chars = 0, pages = 0;
  return systems.map(system => {
    const scores = new Map(scoreEvidence({ subject: normalize(system.name), claim: normalize(system.name) },
      { ...topic, catalog: { entries: scoredEntries, df: evidenceCatalog().df } }).scored.map(row => [row.e.material_id || row.e.id, row.score]));
    const candidates = entries.map(ref => {
      // 法令・通達は題名に当たるものだけ。本文は採用候補に限って読む。
      const title = relevantMaterial(system.name, ref, '');
      if (['law', 'tsutatsu'].includes(ref.kind) && !title.titleMatch) return null;
      const text = read(ref), related = relevantMaterial(system.name, ref, text);
      return related.condition ? { ref, text, ...related, score: scores.get(ref.material_id || ref.id) || 0 } : null;
    }).filter(Boolean).sort((a, b) => Number(['law', 'tsutatsu'].includes(a.ref.kind)) - Number(['law', 'tsutatsu'].includes(b.ref.kind)) ||
      Number(b.titleMatch) - Number(a.titleMatch) || b.occurrences - a.occurrences || b.score - a.score || a.ref.id.localeCompare(b.ref.id)).slice(0, 2);
    const materials = [], omitted = [];
    for (const row of candidates) {
      const id = materialId(row.ref);
      const text = contiguousExcerpt(row.text, normalize(system.name), 6000, systemNames(system.name).main);
      if (!attached.has(id) && (pages >= (options.maxPages ?? 18) || chars + text.length > (options.maxChars ?? 60000))) {
        omitted.push(id); continue;
      }
      if (!attached.has(id)) { pages++; chars += text.length; attached.add(id); }
      const { tokens, titleTokens, lazy, ...ref } = row.ref;
      materials.push({ ...ref, text });
    }
    return { ...system, materials, missing: candidates.length === 0,
      ...(omitted.length ? { omitted, note: '上限で添付せず' } : {}) };
  });
}

function buildPlanBlock(systems, existing = []) {
  const seen = new Set(existing.map(ref => typeof ref === 'string' ? ref : materialId(ref)));
  const missing = systems.filter(s => s.missing).map(s => s.name);
  const blocks = systems.map(system => {
    const refs = system.materials.map(ref => {
      const id = materialId(ref);
      if (seen.has(id)) return `（上に掲載）${ref.title}`;
      seen.add(id);
      return `【資料】${ref.title} / ${ref.url}\n${ref.text}`;
    });
    return [`制度: ${system.name}${system.why ? `（${system.why}）` : ''}`, ...refs, ...(system.note ? [system.note] : [])].join('\n');
  });
  return `\n\n═══ この記事で扱う制度と資料 ═══\n扱う制度: ${systems.map(s => s.name).join('、')}\n資料が見つからなかった制度: ${missing.length ? missing.join('、') + '（この制度は名前と「詳しくは国税庁の〇〇で確認」程度の案内までにする）' : 'なし'}\n${blocks.join('\n\n')}\n\n1. 税の要件・対象者・金額・割合・期限・適用年・届出や申請・判定の基準・条文や通達の番号は、添付した資料（このブロックと上の資料）に書いてあることだけを書く。あなたの記憶にある税制は古い可能性が高い。\n2. 「資料が見つからなかった制度」は、名前と案内までにする。\n3. 「扱う制度」に無い制度について、要件・金額・期限などの具体を書かない。`;
}

function planWarning(meta) {
  return meta.fact_plan_status === 'failed' ? '計画を作れませんでした（従来の資料だけで生成）'
    : meta.fact_plan_missing ? `計画: 資料が見つからない制度 ${String(meta.fact_plan_missing).split(' ／ ').join('・')}` : '';
}

async function prepareArticlePlan(topic, options = {}) {
  if (!enabled()) return '';
  try {
    const plan = topic.__factPlan || await planSystems(topic, options);
    topic.__factPlan = plan;
    if (plan.status !== 'ok') throw new Error('計画を作れませんでした');
    const systems = findSystemMaterials(plan.systems, topic, options);
    Object.assign(topic, { fact_plan_status: 'ok', fact_plan: systems.map(s => s.name).join(' ／ '),
      fact_plan_missing: systems.filter(s => s.missing).map(s => s.name).join(' ／ '),
      fact_materials: materialIds([...(options.references || []), ...(options.existing || []), ...systems.flatMap(s => s.materials), ...(options.changes || [])]).join(';') });
    return buildPlanBlock(systems, options.existing);
  } catch (_) {
    Object.assign(topic, { fact_plan_status: 'failed', fact_plan: '', fact_plan_missing: '', fact_materials: '' });
    return '';
  }
}

function restoreArticlePlan(meta, existing = []) {
  if (!enabled() || meta.fact_plan_status !== 'ok' || !meta.fact_materials) return '';
  try {
    const refs = String(meta.fact_materials).split(';').filter(Boolean).map(resolveMaterial);
    if (refs.some(ref => !ref)) throw new Error('記録した資料を読めませんでした');
    for (const ref of refs) ref.text = contiguousExcerpt(mainText(ref, ref.text), String(meta.fact_plan || ''), 6000);
    const missing = String(meta.fact_plan_missing || '').split(' ／ ');
    const names = String(meta.fact_plan || '').split(' ／ ').filter(Boolean);
    const systems = names.map((name, i) => ({ name, why: '', missing: missing.includes(name), materials: i === 0 ? refs : [] }));
    const block = buildPlanBlock(systems, existing);
    meta.fact_materials = [...new Set([...String(meta.fact_materials).split(';'), ...materialIds(existing)])].filter(Boolean).join(';');
    return block;
  } catch (_) {
    meta.materials_warning = [meta.materials_warning, '計画の資料を復元できませんでした（従来の資料だけで生成）'].filter(Boolean).join(' / ');
    return '';
  }
}

module.exports = { planSystems, findSystemMaterials, relevantMaterial, buildPlanBlock, prepareArticlePlan, restoreArticlePlan,
  planWarning, META_FIELDS, PLAN_SYSTEM, enabled };
