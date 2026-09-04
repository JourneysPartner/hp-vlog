#!/usr/bin/env node
'use strict';

/**
 * ブランド画像を一度だけ生成する（2026-09-03 段階1 R7）
 *
 *   node scripts/tools/make-brand-images.js
 *
 * 出力（すべて assets/images/ にコミットする。ビルド時には走らせない）:
 *   og-default.png   1200×630  SNS共有・記事の既定画像
 *   logo.png          600×160  文字ロゴ
 *   author-mori.png   400×400  執筆者欄の仮画像（本人写真が来たら同名で差し替える）
 *
 * 色は assets/css/style.css の --color-primary / --color-secondary を読んで合わせる。
 * 文字はシステムの日本語フォント（Windows: 游ゴシック／メイリオ）で描く。
 * 依存: @resvg/resvg-js（devDependencies）
 */

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'assets', 'images');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'style.css');

function cssVar(css, name, fallback) {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1] : fallback;
}

const css = fs.existsSync(CSS_PATH) ? fs.readFileSync(CSS_PATH, 'utf8') : '';
const PRIMARY = cssVar(css, '--color-primary', '#E85320');
const SECONDARY = cssVar(css, '--color-secondary', '#0B2045');
const SECONDARY_LIGHT = cssVar(css, '--color-secondary-light', '#1a3a6e');

const FONT_FAMILY = "'Yu Gothic', 'YuGothic', 'Meiryo', 'Noto Sans JP', 'BIZ UDGothic', sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── SVG ─────────────────────────────────────────────────────────
function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#081833"/>
      <stop offset="0.6" stop-color="${SECONDARY}"/>
      <stop offset="1" stop-color="#16386B"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.15" r="0.6">
      <stop offset="0" stop-color="${PRIMARY}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${PRIMARY}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="80" y="86" width="8" height="120" rx="4" fill="${PRIMARY}"/>
  <text x="112" y="150" font-family="${FONT_FAMILY}" font-size="74" font-weight="700" fill="#ffffff">${esc('毛利順活税理士事務所')}</text>
  <text x="112" y="200" font-family="${FONT_FAMILY}" font-size="26" fill="rgba(255,255,255,0.72)" letter-spacing="2">MORI YOSHIIKU TAX ACCOUNTANT OFFICE</text>
  <text x="112" y="330" font-family="${FONT_FAMILY}" font-size="44" font-weight="700" fill="#ffffff">${esc('国税局出身・全国オンライン対応')}</text>
  <text x="112" y="395" font-family="${FONT_FAMILY}" font-size="30" fill="rgba(255,255,255,0.85)">${esc('ネット販売・個人事業主・相続の税務')}</text>
  <rect x="112" y="470" width="420" height="64" rx="32" fill="${PRIMARY}"/>
  <text x="322" y="513" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="28" font-weight="700" fill="#ffffff">${esc('初回相談無料')}</text>
  <text x="1120" y="580" text-anchor="end" font-family="${FONT_FAMILY}" font-size="26" fill="rgba(255,255,255,0.7)">mori-zeirishi.net</text>
</svg>`;
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160">
  <rect width="600" height="160" fill="#ffffff"/>
  <circle cx="52" cy="80" r="22" fill="${PRIMARY}"/>
  <text x="96" y="86" font-family="${FONT_FAMILY}" font-size="46" font-weight="700" fill="${SECONDARY}">${esc('毛利順活税理士事務所')}</text>
  <text x="98" y="122" font-family="${FONT_FAMILY}" font-size="16" fill="#55607a" letter-spacing="1.5">Mori Yoshiiku Tax Accountant Office</text>
</svg>`;
}

function authorSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <linearGradient id="av" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${SECONDARY}"/>
      <stop offset="1" stop-color="${SECONDARY_LIGHT}"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" fill="#ffffff"/>
  <circle cx="200" cy="200" r="190" fill="url(#av)"/>
  <circle cx="200" cy="200" r="190" fill="none" stroke="${PRIMARY}" stroke-width="10"/>
  <text x="200" y="262" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="170" font-weight="700" fill="#ffffff">${esc('毛')}</text>
</svg>`;
}

// ── 描画 ─────────────────────────────────────────────────────────
function renderPng(svg, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Yu Gothic',
    },
  });
  return resvg.render().asPng();
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const targets = [
    ['og-default.png', ogSvg(), 1200],
    ['logo.png', logoSvg(), 600],
    ['author-mori.png', authorSvg(), 400],
  ];
  for (const [name, svg, width] of targets) {
    const png = renderPng(svg, width);
    fs.writeFileSync(path.join(OUT_DIR, name), png);
    console.log(`[brand-images] → assets/images/${name} (${png.length.toLocaleString()} bytes)`);
  }
}

if (require.main === module) main();

module.exports = { ogSvg, logoSvg, authorSvg, renderPng };
