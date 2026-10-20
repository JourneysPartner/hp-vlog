'use strict';

const contentModel = require('./content-model');
const { evidenceCatalog, loadEvidenceText, contiguousExcerpt, subjectWithoutTrailingParens, scoreEvidence, evidenceTax, CATEGORY_TAX } = require('./fact-evidence');
const { tokenizeForMatcher, TAX_CATEGORY_CODES } = require('./nta-source-matcher');
const { qaCatalog, materialId, materialIds, resolveWriterMaterials } = require('./writer-materials');

const PLAN_SYSTEM = '税理士事務所のブログ記事の企画です。読者の疑問に答えるために本文で説明が必要な税の制度・論点を、必要なものだけ最大8つ挙げてください。制度の正式な名前に近い名前（国税庁のタックスアンサーの題名に近い言い方）にしてください。出力は JSON 配列だけです。形は [{"name":"制度名","why":"この記事で何を説明するか（30字以内）"}]。';
const FIELDS = ['target_query', 'primary_question', 'search_intent', 'reader_problem', 'success_outcome', 'tax_terms', 'article_type', 'persona'];
const META_FIELDS = ['fact_plan_status', 'fact_plan', 'fact_plan_missing', 'fact_materials'];
const enabled = () => process.env.FACT_PLAN_ENABLED !== 'false';
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

async function planSystems(topic, { generate = (prompt, options) => contentModel.generateSimple(prompt, options) } = {}) {
  const signal = AbortSignal.timeout(90000);
  let abort;
  const failed = reason => {
    console.warn('[fact-plan] 計画を作れませんでした（従来の資料だけで生成）');
    return { status: 'failed', reason };
  };
  try {
    const result = await Promise.race([
      new Promise((_, reject) => {
        abort = () => reject(new Error('計画の時間切れ'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }),
      Promise.resolve().then(() => generate({ system: PLAN_SYSTEM,
        user: FIELDS.map(key => `${key}: ${Array.isArray(topic[key]) ? topic[key].join('、') : topic[key] || ''}`).join('\n') }, { maxTokens: 2000, signal })),
    ]);
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
    if (!Array.isArray(rows)) return failed('計画の答えを読めませんでした');
    const seen = new Set();
    const systems = rows.filter(row => typeof row?.name === 'string').map(row => ({ name: row.name.trim(), why: typeof row.why === 'string' ? row.why.trim().slice(0, 30) : '' }))
      .filter(row => row.name.length >= 2 && row.name.length <= 40)
      .filter(row => { const key = normalize(row.name); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
    return systems.length ? { status: 'ok', systems } : failed('扱う制度がありませんでした');
  } catch (_) { return failed('計画を作れませんでした'); }
  finally { signal.removeEventListener('abort', abort); }
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

function materialTax(ref) {
  const tax = ref.kind === 'qa' ? CATEGORY_TAX[ref.tax_category_code] : evidenceTax(ref);
  if (tax || ref.kind !== 'law' || !ref.key?.startsWith('sozeki_')) return tax;
  const explicit = String(ref.title).match(/所得税|法人税|消費税|相続税|贈与税/)?.[0];
  if (explicit) return /所得税/.test(explicit) ? 'income' : /法人税/.test(explicit) ? 'corporate'
    : /相続税|贈与税/.test(explicit) ? 'inheritance' : 'consumption';
  return [
    ['income', /必要経費|所得税|譲渡所得|事業所得/],
    ['corporate', /損金|益金|法人/],
    ['inheritance', /贈与|相続/],
    ['consumption', /消費税|仕入税額/],
  ].find(([, pattern]) => pattern.test(ref.title))?.[0];
}
function systemTax(name, topic, candidates) {
  const text = String(name).normalize('NFKC');
  const explicit = text.match(/(?:所得税|法人税|消費税|相続税|贈与税)(?!額)|インボイス|適格請求書/)?.[0];
  if (explicit) return /所得税/.test(explicit) ? 'income' : /法人税/.test(explicit) ? 'corporate'
    : /相続税|贈与税/.test(explicit) ? 'inheritance' : 'consumption';
  if (/損金|益金/.test(text)) return 'corporate';
  if (/必要経費/.test(text)) return 'income';
  const taxes = new Set((TAX_CATEGORY_CODES[topic.tax_domain] || []).map(code => CATEGORY_TAX[code]).filter(Boolean));
  const articleTax = taxes.size === 1 ? [...taxes][0] : undefined;
  const titled = candidates.filter(row => row.titleMatch && row.tax);
  if (articleTax && titled.some(row => row.tax === articleTax && ['taxanswer', 'qa', 'law', 'tsutatsu'].includes(row.ref.kind))) return articleTax;
  return titled.filter(row => ['taxanswer', 'qa'].includes(row.ref.kind))
    .sort((a, b) => b.score - a.score || a.ref.id.localeCompare(b.ref.id))[0]?.tax || articleTax;
}
const KIND_ORDER = { taxanswer: 0, qa: 1, shitsugi: 2, law: 3, tsutatsu: 3 };

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
    const name = String(system.name).normalize('NFKC');
    const scores = new Map(scoreEvidence({ subject: name, claim: name },
      { tax_domain: topic.tax_domain, catalog: { entries: scoredEntries, df: evidenceCatalog().df } }).scored.map(row => [row.e.material_id || row.e.id, row.score]));
    const related = entries.map(ref => {
      // 法令・通達は題名に当たるものだけ。本文は採用候補に限って読む。
      const title = relevantMaterial(system.name, ref, '');
      if (['law', 'tsutatsu'].includes(ref.kind) && !title.titleMatch) return null;
      const text = read(ref), related = relevantMaterial(system.name, ref, text);
      const tax = materialTax(ref);
      return related.condition ? { ref, text, tax, ...related, score: scores.get(ref.material_id || ref.id) || 0 } : null;
    }).filter(Boolean);
    const tax = systemTax(name, topic, related);
    const candidates = related.filter(row => !tax || !row.tax || row.tax === tax)
      .sort((a, b) => (tax ? Number(b.tax === tax) - Number(a.tax === tax) : 0) || Number(b.titleMatch) - Number(a.titleMatch) ||
      KIND_ORDER[a.ref.kind] - KIND_ORDER[b.ref.kind] || b.score - a.score || b.occurrences - a.occurrences || a.ref.id.localeCompare(b.ref.id)).slice(0, 2);
    const materials = [], omitted = [];
    for (const row of candidates) {
      const id = materialId(row.ref);
      const text = contiguousExcerpt(row.text, name, 6000, systemNames(system.name).main);
      if (!attached.has(id) && (pages >= (options.maxPages ?? 18) || chars + text.length > (options.maxChars ?? 60000))) {
        omitted.push(id); continue;
      }
      if (!attached.has(id)) { pages++; chars += text.length; attached.add(id); }
      const { tokens, titleTokens, lazy, ...ref } = row.ref;
      materials.push({ ...ref, text });
    }
    return { ...system, tax, materials, missing: candidates.length === 0,
      ...(omitted.length ? { omitted, note: '上限で添付せず' } : {}) };
  });
}

function buildPlanBlock(systems, existing = [], otherMaterials = []) {
  const seen = new Set(existing.map(ref => typeof ref === 'string' ? ref : materialId(ref)));
  const missing = systems.filter(s => s.missing).map(s => s.name);
  const render = refs => refs.map(ref => {
      const id = materialId(ref);
      if (seen.has(id)) return `（上に掲載）${ref.title}`;
      seen.add(id);
      return `【資料】${ref.title} / ${ref.url}\n${ref.text}`;
    });
  const blocks = systems.map(system => [`制度: ${system.name}`, ...render(system.materials), ...(system.note ? [system.note] : [])].join('\n'));
  if (otherMaterials.length) blocks.push(['その他の資料', ...render(otherMaterials)].join('\n'));
  return `\n\n═══ この記事で扱う制度と資料 ═══\n扱う制度: ${systems.map(s => s.name).join('、')}\n資料が見つからなかった制度: ${missing.length ? missing.join('、') + '（この制度は名前と「詳しくは国税庁の〇〇で確認」程度の案内までにする。名前に含まれる数字・期間も書かない）' : 'なし'}\n${blocks.join('\n\n')}\n\n1. 税の要件・対象者・金額・割合・期限・適用年・届出や申請・判定の基準・条文や通達の番号は、添付した資料（このブロックと上の資料）と、この後の論点別ルールに書いてあることだけを書く。あなたの記憶にある税制は古い可能性が高い。\n2. 「資料が見つからなかった制度」は、名前と案内までにする。\n3. 「扱う制度」に無い制度について、要件・金額・期限などの具体を書かない。`;
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

function appendWarnings(existing, ...warnings) {
  return [...new Set([existing, ...warnings].filter(Boolean).flatMap(text => String(text).split(' / ')).filter(Boolean))].join(' / ');
}

function resolveArticlePlan(meta, additional = []) {
  if (!enabled() || meta.fact_plan_status !== 'ok' || !meta.fact_materials) return null;
  try {
    const recorded = [...new Set(String(meta.fact_materials).split(';').filter(Boolean))];
    const recordedRefs = resolveWriterMaterials(recorded);
    const addedRefs = resolveWriterMaterials(materialIds(additional).filter(id => !recorded.includes(id)));
    const ids = [...new Set([...recorded, ...materialIds(addedRefs)])];
    const refs = [...recordedRefs, ...addedRefs];
    const skipped = recorded.length - recordedRefs.length;
    if (skipped) meta.materials_warning = appendWarnings(meta.materials_warning,
      `計画: 記録した資料のうち引けない ${skipped} 件${refs.length ? '' : '（従来の資料だけで生成）'}`);
    if (!refs.length) return null;
    const names = String(meta.fact_plan || '').split(' ／ ').filter(Boolean);
    const systems = findSystemMaterials(names.map(name => ({ name })), meta, {
      entries: refs.filter(ref => ref.kind !== 'change'), existing: refs, loadEvidenceText: ref => ref.text,
    });
    const assigned = new Set(systems.flatMap(system => system.materials).map(materialId));
    const otherMaterials = refs.filter(ref => !assigned.has(materialId(ref))).map(ref => ({ ...ref,
      text: contiguousExcerpt(mainText(ref, ref.text), ref.title, 6000) }));
    meta.fact_materials = ids.join(';');
    return { systems, otherMaterials };
  } catch (_) {
    meta.materials_warning = appendWarnings(meta.materials_warning, '計画の資料を復元できませんでした（従来の資料だけで生成）');
    return null;
  }
}

function restoreArticlePlan(meta, existing = [], restored = undefined) {
  const plan = restored === undefined ? resolveArticlePlan(meta, existing) : restored;
  return plan ? buildPlanBlock(plan.systems, existing, plan.otherMaterials) : '';
}

module.exports = { planSystems, findSystemMaterials, relevantMaterial, buildPlanBlock, prepareArticlePlan, restoreArticlePlan,
  resolveArticlePlan, appendWarnings, planWarning, META_FIELDS, PLAN_SYSTEM, enabled };
