# 実装指示書: 表示速度の改善（並行B）【着手可】

作成: 2026-09-03（設計: Claude ／ 実装: Codex）
前提: `README.md` の共通厳守事項。

## 背景と目的

外部CSSを3か所（Bootstrap・Bootstrap Icons・AOS）から読み込み、Webフォントを6ウェイト読み、
見出しがアニメーション待ちで表示される。順位への直接効果は小さいが、モバイルの体験指標が
足を引っ張らないようにする守りの施策。**見た目は変えない**（アニメーションの有無を除く）。

## 変更してはいけないもの（厳守）

`README.md` に同じ。`tools/`（シミュレーター）のページと `assets/js/tax-simulator*.js` は触らない。

## 実装要件

### R1. AOS（スクロールアニメーション）を廃止する

- テンプレート内の `data-aos` `data-aos-delay` 属性（131か所）をすべて削除する。
- `aos.css` `aos.js` の読み込みと、`main.js` の `AOS.init` を削除する。
- 代わりに、JS無しでも内容が最初から見える状態にする（`opacity:0` の初期状態を残さない）。
  ふわっと出す演出が欲しい場合は、`main.js` に IntersectionObserver で `.is-visible` を付ける
  10行程度の実装と、`style.css` に `prefers-reduced-motion` を尊重した軽い transition を足してよい。
  ただし**初期状態で非表示にしない**こと（JS が動かなくても全文が見える）。

### R2. Webフォントを絞る

- Noto Sans JP: 400 / 700 のみ。Zen Old Mincho: 700 のみ（現状 400/500/700/900 と 700/900）。
- `style.css` で 500 / 900 を使っている箇所は 700 に寄せる（見た目の差は許容範囲）。
- `<link rel="preload">` は使わない（Google Fonts の CSS は可変URLのため）。`preconnect` は維持。

### R3. Bootstrap Icons を必要な分だけにする

- 使っているアイコン名をテンプレート全体から抽出し、その分だけを **インラインSVGスプライト**
  （`templates/partials/icons.svg`）にして `{{HEADER}}` の直前に埋め込む。
  `<i class="bi bi-xxx">` は `<svg class="bi"><use href="#bi-xxx"/></svg>` に置き換える。
- 記事本文（`{{BODY}}`）や管理画面（`netlify/functions/*`）は対象外。本文側で `bi-` を使っている
  記事があれば、そこだけ Bootstrap Icons の CSS を読み続ける（記事テンプレのみ）。
- 抽出→スプライト生成は `scripts/tools/build-icon-sprite.js` として残す（ビルド時には走らせない。
  アイコンを増やしたときだけ手動で実行）。

### R4. Bootstrap CSS/JS

- 本体は CDN のまま維持してよい（置き換えの効果が小さく、リスクが大きい）。
- ただし `<script>` は `defer` を付け、`main.js` も `defer` にする。
  `main.js` は `DOMContentLoaded` で動いているので影響なし。

### R5. キャッシュヘッダ

`netlify.toml` の `[[headers]]` に追加:
- `/assets/css/*` と `/assets/js/main.js`: `Cache-Control: public, max-age=3600, must-revalidate`
  （ハッシュ無しのファイルなので長くしすぎない）
- `/assets/images/*`: `public, max-age=604800`

### R6. 画像

段階1で入る画像（`og-default.png` `logo.png` `author-mori.png`）に `width` `height` `loading="lazy"`
（ファーストビューにあるものは `lazy` を付けない）。今後の画像も同じ規則にする旨を README に追記。

### R7. テスト

`scripts/lib/__tests__/test-performance-basics.js`（ビルド後の生成物）:
1. 生成物に `data-aos` が無い。`aos.css` `aos.js` を読み込んでいない
2. Google Fonts の URL に `wght@400;700` と `wght@700` だけが含まれる
3. 静的ページと一覧・記事テンプレの `<script src=".../bootstrap.bundle.min.js">` と `main.js` に `defer` がある
4. `<i class="bi ` が静的ページ・一覧・記事の**テンプレ由来部分**に無い（記事本文は除外）
5. `netlify.toml` に上記のキャッシュ設定がある

## 受け入れ確認（Claude が実施）

- トップ・記事・一覧を目視し、レイアウト崩れ・アイコン欠けが無い
- PageSpeed Insights（モバイル）で、変更前後の LCP / CLS を比較して悪化していない
  （Deploy Preview の URL で測る）

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `assets/js/main.js` | `AOS.init`（削除対象）、カウンタ、ナビ |
| `templates/**/*.html` | `data-aos` の使用箇所、フォント・CDN の `<link>` |
| `netlify.toml` `[[headers]]` | 既存のキャッシュ設定（tools 用）の書き方 |
