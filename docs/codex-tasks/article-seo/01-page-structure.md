# 01 ページの構造（ビルド側。記事の Markdown と frontmatter は触らない）

全 270 本に即日効く変更。`content/posts/*.md` は 1 バイトも変えない。すべて `scripts/build.js` とその部品で行う。

## R1 見出しに id を付ける

- 新規 `scripts/lib/heading-anchors.js`:
  - `slugifyHeading(text, used)`: 見出し文から id を作る。HTML タグと Markdown 記法を落とし、`【】（）()「」『』・、。，．？?！!：:；;／/＋+＆&%％〜~`＋各種記号（①〜⑳、❶〜❿、■●▶ など）を除き、前後の空白を落とし、連続する空白を `-` 1 つにする。日本語の文字と英数字はそのまま残す（英字は小文字にする）。空になったら `section`。数字で始まるときは `s-` を前置する。`used`（Set）に同じ id があれば `-2`、`-3` と付ける。
  - `applyHeadingIdRenderer(markedInstance, state)`: marked 9 の `renderer.heading` を上書きし、h2・h3 に `id` を付けて `<h2 id="…">…</h2>` を返す。`state.used` は記事ごとにリセットできる形にする（`state.reset()`）。marked 9.1.6 の `heading` の引数は `(text, level, raw)`。`node_modules/marked` の実装を確認して合わせる。
  - `buildTocHtml(htmlBody, { minH2 = 4 })`: 描画済み HTML から `<h2 id="…">見出し</h2>` を拾い、h2 が `minH2` 本以上のときだけ目次 HTML を返す。見出し文はタグを落としたプレーンテキスト。h3 は入れない。
- `scripts/build.js`: `applyExternalLinkRenderer(marked)` の隣で `applyHeadingIdRenderer(marked, headingState)` を適用し、`generatePost` の先頭で `headingState.reset()` する。
- 静的ページ（`templates/pages/`）と一覧・ハブは対象外。記事ページの本文だけ。

## R2 目次を自動生成する

- `generatePost` で `marked(linkedBody)` の後、`buildTocHtml(htmlBody)` が返した目次を、本文 HTML の**最初の `<h2` の直前**に差し込む（リード文の後、最初の見出しの前）。h2 が 4 本未満の記事には出さない。
- マークアップ（新しい JavaScript は無し。`<details>` で折りたたみ可能、既定は開いた状態）:

```html
<nav class="blog-toc" aria-label="目次">
  <details open>
    <summary>目次</summary>
    <ol>
      <li><a href="#見出しのid">見出し</a></li>
    </ol>
  </details>
</nav>
```

- `assets/css/blog.css` に `.blog-toc` の見た目を足す。既存の色変数（`--color-primary` 等）と `.blog-article` の余白に合わせる。小さめの文字（0.92rem 程度）、行間 1.7、`summary` は太字、PC で 2 列にしてよい（`column-count: 2`）。スマホは 1 列。
- 構造化データは足さない。`{{BODY}}` の中に入れる（テンプレートの変更は不要）。

## R3 関連記事を 3 本にする

- `buildRelatedArticleHtml(post, postsMap, pickupContext)` を、最大 3 本を並べる `buildRelatedArticlesHtml` に置き換える（呼び出し元・テストの名前は両方通るよう、旧名も残して新関数を呼ぶ）。
- 並べる順:
  1. `post.related_slug`（ペアの相手）が公開中なら 1 本目。物販記事で中核枠（pickup）と重なる場合は現行どおり別の物販記事に差し替える（既存ロジックを残す）。
  2. 残りは公開中の記事から `similarityScore(post, candidate).score` の高い順。同点は新しい順。
- 候補の条件: `review_status === 'published'`、自分自身でない、既に並べた記事と重複しない、物販記事では中核枠の記事を除く、`similarityScore` が 0.1 未満の候補は使わない（無関係な記事を並べない）。同じ業種ハブ（`hubMacroOf`）の記事を優先する（並び順のキーを「同じハブか」→「類似度」→「新しさ」にする）。
- 3 本に届かなければ届く分だけ出す。0 本なら何も出さない。
- 見た目: 既存の `.blog-related-article` の枠を使い、見出しを「関連記事」にする。ペアの記事には `related_link_text`（例: 「比較・判断のポイントはこちら」）を小さなラベルとして添える。3 本を縦に並べる（既存のカードのスタイルを流用。新しいクラスは `.blog-related-list` `.blog-related-item` 程度に留める）。
- `postsMap` に公開中以外の記事が入っている場合に備え、必ず `isPublished` で確認する。

## R4 本文内の文脈リンク（辞書方式）

### 辞書 `data/internal-link-terms.json`

```json
{
  "_note": "本文中の用語に、その用語を主題にした記事へのリンクをビルド時に付ける辞書。記事の Markdown は触らない。term は本文に出る語そのまま。macros はリンクを出す記事の業種ハブ（hub-membership の日本語 macro 名）。\"*\" は全業種。enabled が false の行は使わない。",
  "terms": [
    { "term": "簡易課税", "slug": "（対象記事の slug）", "macros": ["サロン"], "enabled": true }
  ]
}
```

### 付与の規則 `scripts/lib/internal-linker.js`

- `linkTerms(markdown, { terms, post, postsMap, isPublished, hubMacroOf, coreSlugs })` → `{ markdown, stats: { linked, skipped: {...} } }`。Markdown 文字列に対して `[用語](/blog/<slug>/)` を差し込む。`linkCitations` の**前**に適用する（`linkCitations` は既存リンク範囲をスキップする）。
- 対象にしない場所: 見出し行（`#` で始まる行）、表の行（`|` で始まる行）、既存の Markdown リンク `[...](...)` と画像、HTML タグの内側（`<strong>` の**中身**はリンクしてよいが、タグの属性は触らない）、インラインコード、frontmatter。
- 1 つの用語は記事内で**初出の 1 回だけ**。1 記事あたり**最大 4 本**。用語が重なるときは長い語を先に処理し、既にリンクにした範囲の中は対象外（例: 「少額減価償却資産」を処理してから「減価償却」）。
- リンクしない条件: 対象記事が自分自身、対象記事が公開中でない（`postsMap` に無い、または `isPublished` でない。1 回だけ `console.warn`）、`macros` に自分のハブが無い（`"*"` を含む行は全業種）、`enabled` が `false`、その記事の中核枠（pickup）に出る記事、**自分の題名にその用語が含まれる**（その記事自身が主題にしているので外へ飛ばさない）。
- 内部リンクは `applyExternalLinkRenderer` が外部と判定しないため `target="_blank"` は付かない（確認だけ）。

### 初期の辞書（Codex が規則で作り、Claude と毛利が確認する）

- 新規 `scripts/propose-internal-link-terms.js`: 下の種語ごとに、公開中の記事で**題名にその語を含む**ものを探し、`article_type` が `basic_explainer` / `comparison_decision` のものを優先、複数あれば題名の中でその語が早く出るもの → 新しいものの順で 1 本選ぶ。`macros` はその記事のハブ（`hubMacroOf`）1 つ。見つからない語は辞書に入れない。結果を `data/internal-link-terms.json` に書く（`enabled: true`）。最終報告に「語 → 記事の題名 → macros」の一覧を載せる（毛利が外す語を選べるように）。
- 種語（この一覧の語だけ。増やさない）: 簡易課税、輸出免税、消費税還付、2割特例、3割特例、特定期間、基準期間、課税事業者選択届出書、少額減価償却資産、一括償却資産、源泉徴収、青色申告特別控除、専従者給与、インボイス登録、適格簡易請求書、リバースチャージ、前受金、棚卸資産、法人成り、名義預金、小規模宅地等の特例、配偶者の税額軽減、準確定申告、相続登記、生前贈与、相続時精算課税、事業所得、雑所得、家事按分、修繕費、資本的支出、免税事業者、仕入税額控除、外注費、人工代、特定課税仕入れ、現金過不足、商品券。
- このスクリプトは手動実行（ワークフローには入れない）。

### `generatePost` への組み込み

```
const withTerms = linkTerms(post._body, { terms, post, postsMap, isPublished, hubMacroOf, coreSlugs });
const { markdown: linkedBody, stats } = linkCitations(withTerms.markdown, …既存…);
```

ビルドログに記事ごとの本数を 1 行（`[build]   ℹ <slug>: 文脈リンク N 件`）。辞書が無い・空・壊れているときは 0 件で続行（`console.warn` 1 回）。

## R5 `<title>` のサフィックス

- `templates/blog-post.html` の `<title>{{TITLE}}｜毛利順活税理士事務所</title>` を `<title>{{TITLE}}｜毛利税理士事務所</title>` に変える。`og:title` も同じにする。他のページ（一覧・ハブ・静的ページ）は変えない。

## R6 テスト `scripts/lib/__tests__/test-page-structure.js`

既存テストの流儀（自前の `assert`、PASS/FAIL 集計、ビルドは関数を直接呼ぶ。子プロセスで `node` を呼ばない）。`npm run masters:test` に追加。

- `slugifyHeading`: 記号除去、空白 → `-`、重複 `-2`、空 → `section`、数字始まり → `s-`。
- 記事 HTML: h2 と h3 に id があり、同じ記事内で重複しない。目次のアンカーが全部その記事の h2 の id と一致する。h2 が 4 本以上の記事に目次があり、3 本以下の記事に無い。目次は最初の `<h2` の前にある。
- 関連記事: 最大 3 本、自分自身が無い、重複が無い、公開中以外が無い、ペアの相手が 1 本目、物販記事で中核枠の記事が並ばない。
- 文脈リンク: 初出 1 回だけ、最大 4 本、見出し行・表の行・既存リンクの中に入らない、`macros` 外の記事に出ない、`enabled: false` が使われない、公開中でない対象がスキップされる、自分の題名に含まれる語がリンクされない、辞書が空でも build が失敗しない。
- `<title>` が「…｜毛利税理士事務所」。
- `sitemap.xml` の URL 数と一覧が変更前と同じ。
- 相続の代表記事 1 本の HTML について、変更前後の差分が「見出しの id・目次・関連記事・`<title>`」以外に無い（文脈リンクの辞書に相続の語が入った場合はそのリンクも許容）。

## 変更してはいけないもの

- `content/posts/*.md`。
- 記事の `canonical`・構造化データ・パンくず・出典欄・免責文・CTA。
- 既存のサービス案内枠（`buildHubLinksHtml`）と中核枠（`buildPickupBoxHtml`）の文言と位置。
- 一覧・ハブ・静的ページの HTML（差分ゼロ。`<title>` の変更は記事ページだけ）。
- `updated_at` / `dateModified` / sitemap の `lastmod`（ビルドの変更で日付を動かさない）。
