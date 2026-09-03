#!/usr/bin/env node
'use strict';

/**
 * 使っているアイコンだけを SVG スプライトにする（2026-09-03 並行B R3）
 *
 *   node scripts/tools/build-icon-sprite.js
 *
 * Bootstrap Icons の CSS（フォント一式）を CDN から読むのをやめ、
 * テンプレートとビルドが実際に使う名前だけを templates/partials/icons.svg にまとめる。
 * ビルド時には走らせない。アイコンを増やしたときだけ手動で実行してコミットする。
 *
 * 取得元: https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/icons/<name>.svg
 * 対象:   templates/**（tools/ を除く）、scripts/build.js、scripts/lib/*.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'templates', 'partials', 'icons.svg');
const VERSION = '1.11.0';
const BASE = `https://cdn.jsdelivr.net/npm/bootstrap-icons@${VERSION}/icons/`;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === 'tools' || name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(html|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function collectIconNames() {
  const files = [
    ...walk(path.join(ROOT, 'templates')),
    path.join(ROOT, 'scripts', 'build.js'),
    ...fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(ROOT, 'scripts', 'lib', f)),
  ];
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bbi-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) names.add(m[1]);
  }
  return [...names].sort();
}

async function fetchSvg(name) {
  const res = await fetch(`${BASE}${name}.svg`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function toSymbol(name, svg) {
  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 16 16';
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  return `  <symbol id="bi-${name}" viewBox="${viewBox}">${inner}</symbol>`;
}

async function main() {
  const names = collectIconNames();
  console.log(`[icons] 使用アイコン: ${names.length} 種`);
  const symbols = [];
  const failed = [];
  for (const name of names) {
    try {
      symbols.push(toSymbol(name, await fetchSvg(name)));
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }
  const sprite = [
    '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sprite" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">',
    ...symbols,
    '</svg>',
    '',
  ].join('\n');
  fs.writeFileSync(OUT, sprite, 'utf8');
  console.log(`[icons] → templates/partials/icons.svg（${symbols.length} 種、${sprite.length.toLocaleString()} 文字）`);
  if (failed.length) {
    console.warn(`[icons] 取得できなかったもの ${failed.length} 件:\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { collectIconNames, toSymbol };
