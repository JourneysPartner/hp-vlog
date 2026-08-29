'use strict';

/**
 * 公開ページを作らず、OS一時ディレクトリへだけ①④②共通の確認用HTMLとバンドルを書き出す。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('./build-simulator-bundle.js');

function createPreview() {
  const built = build();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-simulators-preview-'));
  const bundleName = 'tax-simulator.js';
  fs.writeFileSync(path.join(directory, bundleName), built.bundle, 'utf8');
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>税務シミュレーター①④② 開発プレビュー</title>
  <style>
    .preview-toolbar{position:sticky;top:0;z-index:10;display:flex;gap:8px;padding:12px;background:#F5F7FA;border-bottom:1px solid #E3E8F0}
    .preview-toolbar button{min-height:44px;padding:8px 16px}.preview-status{margin-left:auto;align-self:center}
  </style>
</head>
<body>
  <nav class="preview-toolbar" aria-label="プレビューする画面">
    <button type="button" id="preview-hojinnari">① 法人成り</button>
    <button type="button" id="preview-yakuin">④ 役員報酬</button>
    <button type="button" id="preview-shohizei">② 消費税</button>
    <span class="preview-status" id="preview-status" role="status"></span>
  </nav>
  <div id="simulator-app"></div>
  <script src="./${bundleName}"></script>
  <script>
    (function () {
      var root = document.getElementById('simulator-app');
      var status = document.getElementById('preview-status');
      var active = null;
      var previewRouter = {
        navigate: function (tool) { status.textContent = tool === 'hojinnari' ? '④から①へ遷移しました' : ''; },
        destroy: function () {}
      };
      function mount(tool) {
        if (active) active.destroy();
        status.textContent = tool === 'hojinnari' ? '①を表示中' :
          tool === 'shohizei' ? '②を表示中' : '④を表示中';
        active = tool === 'hojinnari'
          ? TaxSimulator.mountHojinnari(root)
          : tool === 'shohizei'
            ? TaxSimulator.mountShohizei(root)
            : TaxSimulator.mountYakuinHoshu(root, { router: previewRouter });
      }
      document.getElementById('preview-hojinnari').addEventListener('click', function () { mount('hojinnari'); });
      document.getElementById('preview-yakuin').addEventListener('click', function () { mount('yakuinHoshu'); });
      document.getElementById('preview-shohizei').addEventListener('click', function () { mount('shohizei'); });
      mount('yakuinHoshu');
    })();
  </script>
</body>
</html>
`;
  const htmlPath = path.join(directory, 'index.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

if (require.main === module) process.stdout.write(`${createPreview()}\n`);

module.exports = Object.freeze({ createPreview });
