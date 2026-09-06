'use strict';

/**
 * 出典の図（画像）の取り込みと添付のテスト。
 *   node scripts/lib/__tests__/test-nta-figures.js
 *
 * 背景（2026-09-06）: 質疑応答事例 hyoka/05/03 は議決権割合が図にしか書かれておらず、
 * 本文しか渡していなかったためモデルが数値を創作し、結論まで誤った。
 * 図を渡せるようにしたうえで、図が別出典のものと入れ替わらないことを固定する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const figures = require(path.join(ROOT, 'scripts/lib/nta-figures'));
const { resolveSourceFile, loadSourceBody, loadSourceFigures } =
  require(path.join(ROOT, 'scripts/lib/nta-source-body'));
const { toAnthropicRequest, toOpenAIMessages } =
  require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else      { console.error(`  NG ${label}`); failed++; }
}

const PAGE = 'https://www.nta.go.jp/law/shitsugi/hyoka/05/03.htm';
const HTML = '<img alt="同族株主がいない会社の株主の図" class="over300" height="169"' +
  ' hspace="0" src="/law/shitsugi/hyoka/05/img/03_01.gif" vspace="0" width="448">';

console.log('=== 図の抽出: そのページに実在する img だけを採る ===');

const refs = figures.extractFigureRefs(HTML, PAGE);
assert(refs.length === 1 && refs[0].url.endsWith('/law/shitsugi/hyoka/05/img/03_01.gif'),
  'ページ内の img を絶対 URL で 1 件取得する');
assert(refs[0].alt === '同族株主がいない会社の株主の図', 'alt を取得する（属性順に依存しない）');

assert(figures.extractFigureRefs(HTML, 'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm').length === 0,
  '別ディレクトリのページの図として解決されたものは採らない');
assert(figures.extractFigureRefs('<img src="https://evil.example.com/law/shitsugi/hyoka/05/img/x.gif">', PAGE).length === 0,
  '外部ホストの画像は採らない');
assert(figures.extractFigureRefs('<img src="../../shohi/02/img/01_01.gif">', PAGE).length === 0,
  '相対パスで自ページのディレクトリ外へ出るものは採らない');
assert(figures.extractFigureRefs('<img src="img/a.svg">', PAGE).length === 0,
  'モデルが受け付けない形式は採らない');

console.log('');
console.log('=== 本文と図が同じ出典レコードから出ること ===');

const bodyFile = resolveSourceFile(PAGE);
assert(bodyFile.split(path.sep).join('/').endsWith('shitsugi/hyoka/05/03.json'),
  '本文の解決先は URL から決まる 1 つのパス');
assert(figures.figureDirFor({ url: PAGE }).split(path.sep).join('/').endsWith('images/shitsugi/hyoka/05/03'),
  '図の保存先も同じ URL から決まる（別経路で探さない）');
assert(figures.figureDirFor({ url: 'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm' })
  .split(path.sep).join('/').endsWith('images/shitsugi/shohi/02/01'),
  '別の出典 URL は別のディレクトリに解決される');

const body = loadSourceBody(PAGE);
const fig = loadSourceFigures({ source_url: PAGE });
assert(body && fig.title === body.title, '本文と図のタイトルが一致（同一レコード由来）');
assert(fig.hasFigures === true && fig.figures.length === 1, '図が 1 枚読み出せる');
assert(fig.figures[0].media_type === 'image/gif' && fig.figures[0].data.length > 100,
  'base64 データとして読み出せる');

console.log('');
console.log('=== ページが更新されていたら古い図は添付しない ===');

const staleEntry = {
  html_hash: 'NEW_HASH',
  images: [{ file: 'data/nta-sources/images/shitsugi/hyoka/05/03/03_01.gif',
             media_type: 'image/gif', page_html_hash: 'OLD_HASH', url: PAGE }],
};
assert(figures.loadFiguresForEntry(staleEntry).length === 0,
  'page_html_hash が現在の html_hash と違う図は返さない');
assert(figures.hasFigures(staleEntry) === true,
  '図の存在自体は分かる（渡せない旨をプロンプトで伝えるため）');

console.log('');
console.log('=== プロンプトへの載せ方 ===');

const ir = {
  staticSystem: 'S', dynamicSystem: 'D', user: 'U',
  figures: [{ media_type: 'image/gif', data: 'AAAA', alt: '図の説明', url: PAGE, sourceTitle: '主出典タイトル' }],
};
const an = toAnthropicRequest(ir, { model: 'm', maxTokens: 100, useCache: false });
const blocks = an.messages[0].content;
assert(blocks.map(b => b.type).join(',') === 'text,image,text',
  'Anthropic は 説明テキスト → 画像 → 本指示 の順で渡す');
assert(blocks[0].text.includes('主出典タイトル') && blocks[0].text.includes('主出典'),
  '画像の直前に、どの出典の図かを名乗るテキストを置く');
assert(blocks[1].source.media_type === 'image/gif' && blocks[1].source.data === 'AAAA',
  '画像は base64 ブロックとして渡る');

const oa = toOpenAIMessages(ir);
assert(oa[1].content.map(p => p.type).join(',') === 'text,image_url,text',
  'OpenAI 側も同じ順序で渡す');
assert(oa[1].content[1].image_url.url.startsWith('data:image/gif;base64,'),
  'OpenAI は data URL で渡す');

const plainAn = toAnthropicRequest({ staticSystem: 'S', dynamicSystem: 'D', user: 'U' }, { model: 'm', maxTokens: 1, useCache: false });
assert(plainAn.messages[0].content.length === 1 && plainAn.messages[0].content[0].type === 'text',
  '図が無ければテキスト 1 ブロックのみ（従来どおり）');
assert(typeof toOpenAIMessages({ staticSystem: 'S', dynamicSystem: 'D', user: 'U' })[1].content === 'string',
  '図が無ければ OpenAI の content は従来どおり文字列');

console.log('');
console.log('=== 差し戻し再生成でも図が渡ること（generateSimple 用の共用部品）===');

const { buildAnthropicUserContent } = require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
const withFig = buildAnthropicUserContent('U', [{ media_type: 'image/gif', data: 'AAAA', alt: 'a', url: PAGE, sourceTitle: 'T' }]);
assert(withFig.map(b => b.type).join(',') === 'text,image,text',
  '共用部品は 説明テキスト → 画像 → 本指示 の順に組む');
assert(buildAnthropicUserContent('U', []).length === 1 && buildAnthropicUserContent('U').length === 1,
  '図が無ければテキスト 1 ブロック（figures 未指定でも壊れない）');

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
