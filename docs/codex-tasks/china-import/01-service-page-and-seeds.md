# 01 サービスページと種語に中国輸入を足す

前提と安全の決まり T1〜T7 は `README.md` を読むこと。ページに出す文は、下の「後」の文を一字一句そのまま使う（T2）。

## 変えてよいファイル

1. `templates/pages/services/online-seller.html`
2. `templates/pages/services.html`
3. `scripts/lib/service-links.js`
4. `data/service-segments.json`
5. `data/search-suggest-seeds.json`
6. `scripts/lib/__tests__/test-service-pages-content.js`

これ以外は変えない。ビルドや試験が書き換える生成物（`services/`・`services.html`・`sitemap.xml`・`blog/`・`assets/js/tax-simulator*.js` など）は、そのままにして報告に書く（コミットに入れるかは Claude が決める）。

## R1 説明文（`online-seller.html` の `<meta name="description">`）

`content` の値だけを置き換える。

- 前: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売の記帳から確定申告、インボイス対応まで。副業から本業まで、ネット販売の税務に慣れた税理士が全国オンラインで対応します。`
- 後: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売、中国輸入の記帳から確定申告、インボイス対応、関税・輸入消費税の経理処理まで。副業から本業まで、ネット販売の税務に慣れた税理士が全国オンラインで対応します。`

## R2 こんな方に（`online-seller.html`）

`<li>複数のプラットフォームで売っていて、売上と手数料の集計が追いつかない</li>` の次の行に 1 行足す（字下げは前後の `<li>` と同じ）。

```html
            <li>アリババ・タオバオなどから中国輸入で仕入れていて、関税や輸入消費税の処理が分からない</li>
```

## R3 できること（`online-seller.html`）

「消費税とインボイス」のカード（`<h3>消費税とインボイス</h3>` を含む `<div class="service-detail-card">`）の閉じタグの次、「法人化の相談」のカードの前に、カードを 1 枚足す。字下げは前後のカードと同じ。

```html
      <div class="service-detail-card">
        <div class="row g-4 align-items-start">
          <div class="col-auto"><i class="bi bi-box-seam service-detail-icon"></i></div>
          <div class="col">
            <h3>中国輸入の仕入れ（関税・輸入消費税・通関書類）</h3>
            <p class="service-detail-lead">アリババ・タオバオなどからの仕入れでは、商品代金のほかに国際送料・関税・輸入消費税がかかり、代行業者を使えば手数料もかかります。国際送料や関税など、仕入れのためにかかった費用は仕入原価に含めます。輸入消費税は、経理の方式（税抜・税込）や消費税の申告方法に合わせて記帳します。一般課税で、輸入消費税を納める消費税から差し引くには、帳簿のほか、税関の輸入許可通知書などの保存が要ります。代行業者や配送業者から書類を受け取る手順を一緒に決め、書類の輸入者の名義も確かめます。</p>
          </div>
        </div>
      </div>
```

## R4 よくある質問（`online-seller.html`）

「どのプラットフォームに対応していますか。」の `<details class="faq-item">…</details>` の次、「売上の集計はどこまでやってもらえますか。」の前に、2 問を足す。形は既にある FAQ と同じ（`faq-q`・`faq-toggle`・`faq-a`・`faq-a-mark`）。

```html
      <details class="faq-item">
        <summary><span class="faq-q">Q</span>中国輸入（アリババ・タオバオなどからの仕入れ）も頼めますか。<i class="bi bi-chevron-down faq-toggle"></i></summary>
        <div class="faq-a"><span class="faq-a-mark">A</span><p>はい。仕入れの記帳から、関税・輸入消費税の経理処理、通関書類の整理までお受けします。</p></div>
      </details>
      <details class="faq-item">
        <summary><span class="faq-q">Q</span>中国の仕入先はインボイスを出してくれません。消費税はどうなりますか。<i class="bi bi-chevron-down faq-toggle"></i></summary>
        <div class="faq-a"><span class="faq-a-mark">A</span><p>中国にある商品を買う取引そのものには日本の消費税はかからず、輸入のときに税関で消費税（輸入消費税）がかかります（少額の荷物などでは、かからないこともあります）。一般課税の課税事業者が自分の名義で輸入した場合は、帳簿と税関の輸入許可通知書などを保存すれば、この輸入消費税を納める消費税から差し引けます。免税事業者の方、簡易課税などを選んでいる方、代行業者の名義で輸入している方、日本国内の倉庫にある商品を中国の業者から買っている方は扱いが変わるので、ご相談ください。</p></div>
      </details>
```

「ご相談の例（想定）」は変えない（T5）。

## R5 取扱業務の一覧（`templates/pages/services.html` の「ネット販売・副業」のカード）

1. 段落の 1 文目だけを置き換える。2 文目（「副業から本業まで、…お引き受けします。」）はそのまま。
   - 前: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売の記帳から確定申告、インボイス対応まで。`
   - 後: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売、中国輸入の記帳から確定申告、インボイス対応、関税・輸入消費税の経理処理まで。`
2. `<li>消費税とインボイス（2割特例・簡易課税の選択）</li>` の次の行に 1 行足す（字下げは前後と同じ）。

```html
              <li>中国輸入の関税・輸入消費税の経理処理と通関書類の整理</li>
```

## R6 サービスの説明文（`scripts/lib/service-links.js` の `SERVICE_PAGES['online-seller'].description`）

- 前: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売の記帳から確定申告、インボイス対応まで。`
- 後: `Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売、中国輸入の記帳から確定申告、インボイス対応、関税・輸入消費税の経理処理まで。`

`name`・`short`・`icon` とほかのサービスは変えない。

## R7 対応している業種・働き方（`data/service-segments.json` の `online-seller`）

配列の先頭に 1 件足す（既にある 2 件はその後ろに、順番も中身もそのまま）。

```json
    { "label": "中国輸入（アリババ・タオバオなどからの仕入れ）", "hub": "retail", "blurb": "関税や送料を含めた仕入原価の計算、輸入消費税の処理、通関書類の整理まで扱います。" },
```

## R8 種語（`data/search-suggest-seeds.json`）

`{ "id": "ec-amazon", … }` の次の行に、次の 5 行をこの順で足す（既にある行の書き方に合わせ、1 件 1 行）。`note` とほかの種語は変えない。

```json
    { "id": "ec-kanzei-kamoku", "persona_hint": "domestic_ec_seller", "term": "関税 勘定科目" },
    { "id": "ec-yunyu-shiwake", "persona_hint": "domestic_ec_seller", "term": "輸入消費税 仕訳" },
    { "id": "ec-yunyu-kojo", "persona_hint": "domestic_ec_seller", "term": "輸入消費税 控除" },
    { "id": "ec-yunyu-menzei", "persona_hint": "domestic_ec_seller", "term": "輸入消費税 免税事業者" },
    { "id": "ec-yunyu-kyoka", "persona_hint": "domestic_ec_seller", "term": "輸入許可通知書" },
```

足した後の種語は 50 件。

## R9 試験（`scripts/lib/__tests__/test-service-pages-content.js`）

1. `ADDED_FAQ['online-seller']` の配列の末尾に、R4 の 2 問の質問文（`中国輸入（アリババ・タオバオなどからの仕入れ）も頼めますか。`、`中国の仕入先はインボイスを出してくれません。消費税はどうなりますか。`）を足す。
2. `const startup = read('services/startup/index.html');` を含む `{ … }` の中、startup の確認の後に、次の 5 つの確認を足す（`assert` の文言はこのまま）。
   - `services/online-seller/index.html` が `<h3>中国輸入の仕入れ（関税・輸入消費税・通関書類）</h3>` を含む → `online-seller: 中国輸入のカード`
   - 同じページが `<h3 class="service-title">中国輸入（アリババ・タオバオなどからの仕入れ）</h3>` を含む → `online-seller: 対応している業種に中国輸入`
   - 同じページの `<meta name="description" content="…">` の値が `中国輸入` を含む → `online-seller: 説明文に中国輸入`
   - `services.html`（生成物）が `<li>中国輸入の関税・輸入消費税の経理処理と通関書類の整理</li>` を含む → `services.html: ネット販売のカードに中国輸入`
   - 同じページ（online-seller）の FAQPage の構造化データ（既にある `jsonLd()` で読む）で、質問 `中国の仕入先はインボイスを出してくれません。消費税はどうなりますか。` の答え（`acceptedAnswer.text`）が `自分の名義で輸入した場合` と `代行業者の名義で輸入している方` の両方を含む → `online-seller: 輸入消費税の FAQ の答えに条件がある`
3. 「ご相談の例（想定）が2件」の確認はそのまま残す。ほかの確認も変えない。

## R10 差分レビュー（2026-11-14）を受けた直し

1 回目の実装の後、R1・R3〜R6・R8・R9 の文を次のとおり改めた（上の各節は改めた後の文）。ファイルを、上の各節の「後」とコードブロックの文に合わせ直す。

| 節 | 直したところ |
|---|---|
| R1・R5（段落）・R6 | 「関税・輸入消費税の処理まで」→「関税・輸入消費税の経理処理まで」 |
| R3 | 「経理の方式や消費税の申告方法に合わせて分けて記帳します」→「経理の方式（税抜・税込）や消費税の申告方法に合わせて記帳します」 |
| R4（1 問目の答え） | 「関税・輸入消費税の処理」→「関税・輸入消費税の経理処理」 |
| R4（2 問目の答え） | 「がかかります。」の後に「（少額の荷物などでは、かからないこともあります）」を足し、扱いが変わる人の並びの最後に「日本国内の倉庫にある商品を中国の業者から買っている方」を足す |
| R5（一覧の行） | 「中国輸入の関税・輸入消費税と通関書類の整理」→「中国輸入の関税・輸入消費税の経理処理と通関書類の整理」 |
| R8 | 1 件目の種語を `ec-chugoku-kanzei`「中国輸入 関税」から `ec-kanzei-kamoku`「関税 勘定科目」に替える（位置は同じ） |
| R9 | 確かめる行の文を R5 に合わせ、FAQ の答えの確認を 1 つ足す（5 つ目） |

## 期待の表

| 確かめること | 期待 |
|---|---|
| `services/online-seller/index.html` の FAQPage | 既にある 8 問＋足した 2 問。答えにタグが無い |
| 「対応している業種・働き方」 | 3 件（中国輸入・コンテンツ販売・アフィリエイト の順） |
| 「ご相談の例（想定）」 | 2 件のまま |
| 種語 | 50 件。ID はすべて別 |
| `<title>`・`<h1>`・`page-hero-sub`・canonical | 変わらない |

## 流す試験（すべて `sbx` を通す。ビルドを先に流す）

1. `node scripts/build.js`
2. `node scripts/lib/__tests__/test-service-pages-content.js`
3. `node scripts/lib/__tests__/test-service-pages.js`
4. `node scripts/lib/__tests__/test-service-segments.js`
5. `node scripts/lib/__tests__/test-suggest-topics.js`
6. `node scripts/lib/__tests__/test-industry-hubs.js`
7. `node scripts/validate.js`

直す前の main（2026-11-14、a12d16fd）では、1〜7 はすべて終了コード 0（2 は PASS 57 / FAIL 0、4 は PASS 18 / FAIL 0）。`validate.js` は「品質チェック: OK」。
