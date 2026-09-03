# 実装指示書: 全ページの基本情報・執筆者欄・パンくず・FAQ・404・共有画像（段階1）【着手可】

作成: 2026-09-03（設計: Claude ／ 実装: Codex）
前提: `README.md` の共通厳守事項を先に読むこと。

## 背景と目的

検索エンジンが機械的に読む情報が、記事以外のページに一切無い。記事側も「記事」型の
構造化データだけで、パンくず・FAQ・執筆者が無い。税務（YMYL）では「誰が書いたか」が
順位に直結するので、232本すべてにテンプレート側で執筆者欄を付ける。
すべて生成側（ビルド・テンプレート）の変更で、記事本文は触らない。

## 変更してはいけないもの（厳守）

`README.md` の共通厳守事項に同じ。加えて、記事の本文HTMLの構造（`{{BODY}}` の中身）は変えない。

## 実装要件

### R1. 静的ページの `<head>` を共通化する

`templates/pages/*.html` は各ファイルが `<head>` を丸ごと持っている。これを部品化する。

1. `templates/partials/head-common.html` を新設し、次を置く（`{{...}}` はビルドで置換）:
   ```html
   <link rel="canonical" href="https://mori-zeirishi.net{{CANONICAL_PATH}}">
   <meta property="og:site_name" content="毛利順活税理士事務所">
   <meta property="og:type" content="{{OG_TYPE}}">
   <meta property="og:title" content="{{OG_TITLE}}">
   <meta property="og:description" content="{{OG_DESCRIPTION}}">
   <meta property="og:url" content="https://mori-zeirishi.net{{CANONICAL_PATH}}">
   <meta property="og:image" content="https://mori-zeirishi.net/assets/images/og-default.png">
   <meta property="og:locale" content="ja_JP">
   <meta name="twitter:card" content="summary_large_image">
   ```
2. `scripts/build.js` の `buildStaticPages` で、各ページの `<title>` と `<meta name="description">`
   を読み取り、`{{OG_TITLE}}` `{{OG_DESCRIPTION}}` に入れる。`{{CANONICAL_PATH}}` は
   `index.html` → `/`、それ以外 → `/{ファイル名}`。`{{OG_TYPE}}` は `website`。
3. 各 `templates/pages/*.html` の `<head>` 内、`<meta name="description">` の直後に
   `{{HEAD_COMMON}}` を1行入れる。`injectPartials` で置換する。
4. `templates/blog-post.html` と `templates/blog-list.html` には既に canonical / og がある。
   不足分（`og:site_name` `og:image` `og:locale` `twitter:card`）だけ追記する。
   一覧テンプレには `og:title` `og:description` `og:type=website` `og:url` も無いので追記する。

### R2. 事務所の構造化データを全ページに入れる

`scripts/lib/site-schema.js` を新設し、次を返す関数を置く。`buildStaticPages`・記事・一覧の
すべてで `<head>` 末尾に `<script type="application/ld+json">` として出力する。

```js
// organizationSchema()
{
  "@context": "https://schema.org",
  "@type": ["Organization", "AccountingService"],
  "@id": "https://mori-zeirishi.net/#organization",
  "name": "毛利順活税理士事務所",
  "alternateName": "Mori Yoshiiku Tax Accountant Office",
  "url": "https://mori-zeirishi.net/",
  "logo": "https://mori-zeirishi.net/assets/images/logo.png",
  "image": "https://mori-zeirishi.net/assets/images/og-default.png",
  "description": "国税局出身の税理士による、ネット販売・個人事業主・相続に強い税理士事務所。eBay輸出・越境ECの消費税還付にも対応。全国オンライン対応・初回相談無料。",
  "areaServed": { "@type": "Country", "name": "JP" },
  "availableLanguage": "ja",
  "openingHoursSpecification": [{
    "@type": "OpeningHoursSpecification",
    "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"],
    "opens": "09:00", "closes": "18:00"
  }],
  "founder": { "@id": "https://mori-zeirishi.net/#person" },
  "knowsAbout": ["税務", "所得税", "消費税", "インボイス制度", "相続税", "税務調査", "eBay輸出", "越境EC", "ネット販売", "記帳代行"],
  "sameAs": []
}
```
- 住所（`address`）は**入れない**（決定事項）。`sameAs` は空配列で出し、URL は毛利が
  後で追加する（【要確認】なので値を作らない）。
- `personSchema()`:
  ```js
  {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": "https://mori-zeirishi.net/#person",
    "name": "毛利 順活",
    "alternateName": "Mori Yoshiiku",
    "jobTitle": "税理士",
    "worksFor": { "@id": "https://mori-zeirishi.net/#organization" },
    "url": "https://mori-zeirishi.net/about.html",
    "image": "https://mori-zeirishi.net/assets/images/author-mori.png",
    "description": "国税局での勤務経験を経て税理士として独立。ネット販売・個人事業主・相続の税務を全国オンラインで支援。",
    "knowsAbout": ["所得税", "消費税", "相続税", "税務調査", "eBay輸出", "越境EC"]
  }
  ```
  `hasCredential`（税理士登録番号）は【要確認】のため入れない。
- `websiteSchema()`（トップページだけ）:
  ```js
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://mori-zeirishi.net/#website",
    "url": "https://mori-zeirishi.net/",
    "name": "毛利順活税理士事務所",
    "publisher": { "@id": "https://mori-zeirishi.net/#organization" },
    "inLanguage": "ja"
  }
  ```
  サイト内検索は無いので `potentialAction`（SearchAction）は入れない。
- 記事の既存 Article JSON-LD は `publisher` を `{ "@id": ".../#organization" }`、
  `author` を `{ "@id": ".../#person" }` に置き換え、`mainEntityOfPage` と `image`
  （og-default.png）を足す。`@type` は `Article` のまま。

### R3. パンくず（表示＋構造化データ）

1. 記事: `templates/blog-post.html` の `.blog-post-hero` 内、`.blog-post-meta` の上に
   `{{BREADCRUMB_HTML}}` を置く。ビルドで次を生成:
   ```html
   <nav class="breadcrumb-custom" aria-label="パンくず">
     <a href="/">ホーム</a> › <a href="/blog/">税務コラム</a> › <a href="/blog/category/{slug}/">{カテゴリ}</a> › <span aria-current="page">{タイトル}</span>
   </nav>
   ```
   `breadcrumb-custom` は既存クラス（事務所紹介ページで使用）。記事ヒーローは背景が
   濃いので、`blog.css` に `.blog-post-hero .breadcrumb-custom` の色指定を足す。
   カテゴリが CATEGORIES に無い（例: 法人税）場合はカテゴリ段を省く。
2. 一覧・カテゴリ・業種ページ: `blog-list.html` の `.page-hero` に同様に
   `ホーム › 税務コラム › {ページ見出し}` を出す（`/blog/` 自体は `ホーム › 税務コラム`）。
3. 上記に対応する `BreadcrumbList` JSON-LD を `<head>` に出す（`site-schema.js` に
   `breadcrumbSchema(items)` を追加）。

### R4. FAQ の構造化データ（該当記事のみ）

記事本文（markdown）に `## よくある質問` があり、その下に `### 質問文` と回答段落が
続く記事が30本ある。ビルド時にこの節を解析して `FAQPage` JSON-LD を出す。

- 解析: `## よくある質問` から次の `## ` までを対象。`### ` 行を質問、その直後から次の
  `### ` または節末までの段落を回答とする。
- 回答はマークダウン記法とHTMLタグを除いたプレーンテキストにする（`<strong>` などを残さない）。
  リンクも文字だけにする。
- 質問が1つも取れない場合は出さない。
- 出力先: `<head>` に別の `<script type="application/ld+json">` として追加。
  ```js
  { "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": [{ "@type": "Question", "name": q, "acceptedAnswer": { "@type": "Answer", "text": a } }, ...] }
  ```
- 解析器は `scripts/lib/faq-extractor.js` として独立させ、テストを付ける。

### R5. 執筆者欄を全記事に付ける

`templates/blog-post.html` の免責事項（`.blog-disclaimer`）の**上**に `{{AUTHOR_BOX_HTML}}` を置く。
内容は固定（`templates/partials/author-box.html` を新設して読み込む）:

```html
<aside class="author-box" aria-label="この記事の執筆者">
  <div class="author-box-photo">
    <img src="/assets/images/author-mori.png" alt="税理士 毛利順活" width="96" height="96" loading="lazy">
  </div>
  <div class="author-box-body">
    <div class="author-box-label">この記事を書いた人</div>
    <div class="author-box-name">毛利 順活 <span class="author-box-title">税理士・毛利順活税理士事務所 代表</span></div>
    <p class="author-box-text">国税局での勤務を経て税理士として独立。税務行政の内側を知る立場から、ネット販売・個人事業主・相続の税務を全国オンラインで支援しています。eBay輸出・越境ECの消費税還付にも対応。</p>
    <div class="author-box-links">
      <a href="/about.html">プロフィールを見る</a>
      <a href="/contact.html">この記事の内容を相談する</a>
    </div>
  </div>
</aside>
```
- `style.css` に `.author-box` 一式を追記（横並び、写真は丸、モバイルは縦積み）。
- 写真 `assets/images/author-mori.png` は本人写真が【要用意】。用意されるまでは
  **頭文字「毛」を丸で囲んだ SVG を PNG 化した仮画像**を同名で置く（R7 の生成スクリプトで作る）。
  写真差し替え時はファイルを置き換えるだけで済むようにする。

### R6. 404 ページ

`templates/pages/404.html` を新設（ビルドで `/404.html` に出る。netlify.toml は既にこれを指している）。
- `<meta name="robots" content="noindex">`。R1 の共通 head は入れるが canonical は出さない
  （`buildStaticPages` で `404.html` のときだけ canonical 行を除く）。
- 本文（既存の `page-hero` と `cta-section` を使う）:
  - 見出し: 「お探しのページは見つかりませんでした」
  - 本文: 「URLが変更されたか、ページが削除された可能性があります。お手数ですが、下のリンクからお進みください。」
  - リンク: ホーム／取扱業務／税務コラム／お問い合わせ
- `sitemap.xml` と `analytics-page-map.json` から除外する。

### R7. 共有画像・ロゴ・仮の著者画像を用意する

画像が1枚も無い。次の3枚を `assets/images/` に置く。

| ファイル | 内容 | サイズ |
|---|---|---|
| `og-default.png` | 濃紺の地に「毛利順活税理士事務所」「国税局出身・全国オンライン対応」の白文字。既存の見出しフォント（Zen Old Mincho 相当は使えないので、システムの明朝またはゴシック）で可 | 1200×630 |
| `logo.png` | 白地に「毛利順活税理士事務所」の文字ロゴ | 600×160 |
| `author-mori.png` | 仮画像（R5 参照）。本人写真が来たら差し替え | 400×400 |

- 生成は一度きりのスクリプト `scripts/tools/make-brand-images.js` で行い、**PNG を
  リポジトリにコミット**する。ビルド時には生成しない（Netlify のビルドを重くしない）。
- 依存は `@resvg/resvg-js` を **devDependencies** に入れる（SVG文字列→PNG）。
  `dependencies` には入れない。
- 色は `style.css` の `--color-primary` / `--color-secondary` を読んで合わせる。

### R8. 業種の紐づけを補完する（61本＋40本）

frontmatter の `macro` が空の記事が61本、`税目実務` の記事が40本あり、業種ページに載らない。
記事は変更せず、ビルド側で「業種ハブ所属」を決める関数を作る。

- `scripts/lib/hub-membership.js` を新設:
  ```js
  // 記事がどの業種ハブに属するか。frontmatter は変更しない。
  //   1. primary_persona があれば PERSONA_TO_MACRO で引く（最優先）
  //   2. 無ければ frontmatter の macro
  //   3. どちらも無ければ '一般事業者'
  // general_individual_proprietor → '一般事業者'
  function hubMacroFor(post) { ... }
  ```
  `PERSONA_TO_MACRO` は `scripts/lib/cluster-taxonomy.js` から取る（export されていなければ export を足す）。
- `scripts/build.js` の業種別ページ生成（`for (const m of MACROS)`）で、
  `posts.filter(p => p.macro === m.ja)` を `posts.filter(p => hubMacroFor(p) === m.ja)` に変える。
  `sitemap.js` の `generatedTaxonomyPaths` と `writeAnalyticsPageMap` も同じ判定に揃える。
- `MACROS`（blog-taxonomy.js）に `一般事業者` が無ければ追加する（slug: `general`。既にある場合はそのまま）。
- 結果として **全公開記事がいずれか1つの業種ページに載る**こと。

### R9. sitemap / analytics-page-map の整合

- 404 を除外（R6）。
- 静的ページにも `lastmod` を入れる（`templates/pages/*.html` の git 最終コミット日。
  取れなければ省略）。

### R10. テスト

`scripts/lib/__tests__/test-seo-structure.js` を新設。**ビルド後の生成物**を読んで確認する
（テスト冒頭で `node scripts/build.js` を実行してよい。既存テストの `assert` 関数の流儀に合わせる）。

1. `index.html` `about.html` `services.html` `voice.html` `contact.html` `privacy.html`:
   canonical / og:title / og:image / `Organization` JSON-LD がある。`index.html` には `WebSite` もある
2. `404.html`: 存在し、`noindex` があり、canonical が無い
3. `blog/*/index.html` を全件: canonical / og:image / `Article` JSON-LD（`author.@id` が `#person`）/
   パンくず表示 / `BreadcrumbList` / 執筆者欄（`.author-box`）がある
4. `FAQPage` JSON-LD を持つ記事が **30本以上**あり、各 `Answer.text` に `<` が含まれない
5. `faq-extractor.js` 単体: 見出しの揺れ（`## よくある質問` の後に空行が無い、質問が `###` でなく
   `**太字**` の記事）は「取れない」として空を返し、例外を出さない
6. `hub-membership.js`: 公開記事全件で `hubMacroFor` が MACROS のいずれかを返す。
   `macro` 空の記事が `一般事業者` 以外に正しく振り分けられる例（`beauty_salon_owner` → `サロン`）
7. `sitemap.xml`: `/404.html` を含まない。全業種ページを含む
8. 生成物全体に `【要確認】` `【要用意】` の文字列が無い
9. `assets/images/og-default.png` `logo.png` `author-mori.png` が存在し、PNG のヘッダで始まる

### R11. ログ

ビルドログに次を出す: FAQ を出した記事数、業種ハブに振り分けた記事数（業種ごと）、
執筆者欄を付けた記事数。

## 受け入れ確認（Claude が実施）

- `README.md` の受け入れ項目
- 記事ページ1本を実際に開き、パンくず・執筆者欄・免責・出典・関連記事の順序が崩れていない
- Google のリッチリザルトテストに `index.html` と FAQ 付き記事1本を通し、エラーが無い
  （URL は Deploy Preview のものでよい）

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `scripts/build.js` 470–510行 | `buildStaticPages`（静的ページの置換処理） |
| `scripts/build.js` 400–445行 | 記事の JSON-LD 組み立て |
| `scripts/build.js` 585–625行 | カテゴリ・業種ページの生成ループ |
| `templates/blog-post.html` 55–62行 | 免責・出典（執筆者欄はこの上） |
| `scripts/lib/cluster-taxonomy.js` 33–46行 | `PERSONA_TO_MACRO` |
| `scripts/lib/sitemap.js` | `generatedTaxonomyPaths` / `generateSitemapXml` |
| `templates/pages/about.html` | `breadcrumb-custom` の使用例 |
