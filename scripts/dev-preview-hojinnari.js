'use strict';

/**
 * 公開ページを作らず、OS一時ディレクトリへだけ①の確認用HTMLとバンドルを書き出す。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('./build-simulator-bundle.js');

function createPreview() {
  const built = build();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hojinnari-preview-'));
  const bundleName = 'tax-simulator.js';
  fs.writeFileSync(path.join(directory, bundleName), built.bundle, 'utf8');
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>法人成りシミュレーター 開発プレビュー</title>
</head>
<body>
  <div id="hojinnari-app"></div>
  <script src="./${bundleName}"></script>
  <script>TaxSimulator.mountHojinnari(document.getElementById('hojinnari-app'));</script>
</body>
</html>
`;
  const htmlPath = path.join(directory, 'index.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

if (require.main === module) process.stdout.write(`${createPreview()}\n`);

module.exports = Object.freeze({ createPreview });
