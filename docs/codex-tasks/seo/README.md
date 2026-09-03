# HP全体のSEO再設計（全体計画）

作成: 2026-09-03（設計・文章: Claude ／ 実装: Codex ／ 判断・検収: 毛利）

## 背景と目的

税務コラムは232本まで育ったが、サイトの骨組みがそれを活かせていない。
調査で分かった事実:

- トップページは「eBay輸出セラー専門」一色（eBayが22回）。ところが記事232本のうち
  eBayは17本（7%）。実際の中心は美容サロン41・国内EC38・インフルエンサー36・相続26・転売21。
- 取扱業務は1ページに6サービスが小見出しで並ぶだけで、専用ページも料金ページも無い。
  「税理士 記帳代行 料金」「eBay 消費税還付 税理士」のような依頼に近い検索語を受ける
  ページが1つも無い。
- 記事は業種軸で書かれているのに、まとめページは薄い一覧のみ。61本はどの業種にも
  紐づいていない（frontmatter の macro が空）。
- 記事から取扱業務へのリンクがゼロ。
- トップ・事務所紹介・取扱業務・お客様の声・お問い合わせに、正規URL・SNS共有情報・
  構造化データが無い。記事の構造化データは「記事」型だけで、パンくず・FAQ・著者が無い。
- 記事に執筆者欄が無く、サイト全体に画像が1枚も無い。
- 404ページの実体が無い（netlify.toml は /404.html を指している）。
- 住所・地域の記載が無い。

## 決定事項（毛利・2026-09-03）

1. **看板を広げる。** 「ネット販売・個人事業主・相続に強い、国税局出身の税理士」を傘にし、
   eBay輸出は筆頭の得意分野として残す。
2. **住所は出さない。** 代わりに「対応地域」ページを作る。
3. 料金は「考え方と含まれるもの」を先に公開し、具体額は毛利が数字を出してから追記する
   （第1版に金額は載せない）。
4. その他は提案どおり。

## 段階と順序

| 段階 | 指示書 | 状態 | 内容 |
|---|---|---|---|
| 1 | `01-technical-basics.md` | **着手可** | 全ページの基本情報・執筆者欄・パンくず・FAQ・404・共有画像・業種紐づけの補完 |
| 2 | `02-service-pages.md` | **着手可**（1と並行可） | サービス専用ページ7本＋料金ページ。文章は指示書内に用意済み |
| 3 | `03-industry-hubs-and-links.md` | 1の後 | 業種別の柱ページ化と、記事→柱・サービスへの自動リンク |
| 4 | `04-homepage-and-area.md` | 2・3の後 | トップの看板差し替え、対応地域ページ、メニュー・フッター更新 |
| 並行A | `05-search-console-ingest.md` | 着手可 | サーチコンソールの検索語を週次で取り込む |
| 並行B | `06-performance.md` | 着手可 | 外部読み込みの削減・アニメーション廃止・フォント絞り込み |

1つの段階＝1つのPR。段階をまたいで1つのPRにしない。

## 全段階に共通の厳守事項

- `content/posts/*.md`（記事本文・frontmatter）は**一切変更しない**。既存記事の扱いは
  すべてビルド側（`scripts/build.js`・テンプレート）で行う。
- 記事の生成・承認・公開の流れ（`scripts/generate-draft.js`、`netlify/functions/*`、
  `.github/workflows/*`）は変更しない。
- `tools/`（シミュレーター）と `templates/pages/tools/` は変更しない。
- 事実を作らない。指示書に【要確認】とある箇所は、その表示のまま出力してはいけない。
  該当箇所は「そのセクションを出さない」か「指示書に書いた代替文を使う」。
  実績数値はトップページに既にあるカウンタ（200+ / 47都道府県 / 50+）以外を新たに書かない。
- 既存のCSSクラス（`assets/css/style.css` / `blog.css`）を優先して使う。新しい部品が要る
  ときは既存の命名に合わせて `style.css` に追記する。Bootstrap のユーティリティは可。
- ビルド（`npm run build`）と検証（`npm run validate`）が通ること。
  `scripts/lib/__tests__/*.js` は `test-simulator-ui-foundation.js`（既知の失敗）以外すべて通ること。
- 生成物（ルートの `*.html`、`blog/`、`sitemap.xml`）はビルドで作られる。手で編集しない。
- 日本語の文章は指示書のものをそのまま使う。言い回しを変えない。追加が要る場合は
  「読者が当然わかっていることを説明しない」「制度の内訳を本文に持ち込まない」を守る。

## 受け入れ確認（Claude が実施）

各段階の完了時に、ビルド済みHTMLに対して次を機械的に確認する（`01` で追加する
`test-seo-structure.js` が土台）。

- 全ページに正規URL・共有情報・構造化データがある
- 記事に執筆者欄・パンくずがあり、FAQ節を持つ記事にFAQの構造化データがある
- 全記事がいずれかの業種ハブに載っている
- 新ページが `sitemap.xml` と `analytics-page-map.json` に入っている
- 404ページが存在し noindex である
- 【要確認】という文字列が生成物に残っていない

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `scripts/build.js` | 静的ページ・記事・一覧・sitemap の生成。`buildStaticPages` は `templates/pages/*.html` を平置きで出力 |
| `templates/pages/*.html` | 静的ページの元。`{{HEADER}}` `{{FOOTER}}` `{{LATEST_POSTS_HTML}}` が置換される |
| `templates/blog-post.html` | 記事テンプレ。`{{STRUCTURED_DATA}}` に Article JSON-LD |
| `templates/blog-list.html` | 一覧・カテゴリ・業種ページの共通テンプレ |
| `scripts/lib/sitemap.js` | sitemap.xml / robots.txt |
| `scripts/lib/blog-taxonomy.js` | CATEGORIES / MACROS（slug と日本語名） |
| `scripts/lib/cluster-taxonomy.js` | `PERSONA_TO_MACRO`（ペルソナ→業種の既定対応） |
| `scripts/lib/customer-relevance.js` | `MACRO_TO_SEGMENT` ほか |
| `scripts/lib/simulator-cta.js` | 記事→ツール誘導の選び方（記事→サービス誘導の雛形になる） |
| `scripts/lib/source-guard.js` | `parseFrontmatterMeta`（frontmatter を読む共通関数） |
| `netlify.toml` | ビルドコマンド・リダイレクト・ヘッダ |
