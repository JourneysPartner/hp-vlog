# 問い合わせの計測を本番の URL の形で動かす（contact-tracking）

## 背景（2026-10-27 の棚卸しで判明）

記事→問い合わせページの遷移計測（#476、2026-08-26）は、始めてから一度も数えられていない。
`data/contact-transitions.json` は 8/26 から `byFrom: {}` のまま。週次の書き出し
（`export-contact-transitions.yml`）は毎回「成功」と表示されるが、ログは「遷移元ページ: 0 件」。

原因は URL の形の食い違い。

| 場所 | 問い合わせページの URL |
|---|---|
| テンプレート（`templates/`） | `/contact.html`（32 か所） |
| 本番の HTML | `/contact`（Netlify の Pretty URLs 後処理が書き換える。`/contact` はリダイレクトなしで 200） |
| 計測ビーコン（`scripts/build.js` の `ANALYTICS_BEACON`） | `location.pathname === '/contact.html'` の時だけ遷移元を付ける |
| 受け口（`netlify/functions/lib/analytics-store.js`） | `FIXED_PATHS` は `/contact.html` などの `.html` 形だけ |

その結果、次の閲覧は**表示回数ごと捨てられている**。

- サイト内のリンクから来た `/contact`・`/about`・`/services`・`/voice`・`/privacy`（本番では全部 `.html` なしに書き換わる）
- `/services/<slug>/`（7 本）・`/pricing/`・`/area/`（そもそも受け口の許可リストに無い。`analytics-page-map.json` には名前が載っているのに数えられない）
- `/contact-thanks`（送信完了ページ。許可リストに無い）

記事の題材選び（`scripts/lib/inquiry-signals.js` → `topic-selector.js`）は空のデータで動いてきた。

## 方針

1. 本番の形（`.html` なし）と元の形（`.html` あり）を、受け口で**同じページとして数える**。保存するキーは今までどおり `.html` 形（`analytics-page-map.json` と過去のデータに合わせる）。
2. サービスページ・料金・対応地域・送信完了ページを数える対象に加える。
3. **送信完了まで進んだ人が、問い合わせページの前に見ていたページ**を記録する（問い合わせページに来ただけでなく、実際に送った数を記事・サービスページごとに見られるようにする）。
4. 計測ビーコンを、本番の URL の形で実際に動かして確かめる試験を足す（今回の不具合は、この試験が無かったので 2 か月見つからなかった）。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-pretty-urls-and-submissions.md` | 上の 1〜4 すべて（1 PR） |

## 全段階共通の厳守事項

- 受け口は公開されている。**許可リスト方式を崩さない**（任意のパスを受け取らない。既存の Origin・sec-fetch-site・ボット判定・1 分あたりの重複除外はそのまま）。
- 計測の失敗で公開ページの表示を止めない（今までどおり）。
- 記事本文（`content/posts/*.md`）とテンプレートのリンク先（`/contact.html`）は変えない。
- `/tools/*` は対象外（ビーコンが入っておらず、`Referrer-Policy: no-referrer` で遷移元も取れない）。
- `@netlify/blobs` の `setJSON` が条件付き書き込みの条件を送らない既知の不具合（同時アクセスで数え漏れがありうる）は**この PR では直さない**（記録のみ。アクセスが少ないので影響は小さい）。

## 元に戻す方法

この PR を revert する。保存済みのデータ（Netlify Blobs の `daily/`・`transitions/`・新しい `submissions/`）は消えないが、revert 後は新しいキーを誰も読まなくなるだけで害はない。

## 受け入れ確認（Claude）

- 01 の試験項目がすべて通る。`npm run masters:test`・`npm run build`・`npm run validate` が通る。
- `git status` で指示書に無いファイルが変わっていない。
- マージ・本番反映の後、毛利さんが実際のブラウザで「記事 → 無料相談ボタン → 問い合わせページ」と進み、管理画面のアクセス解析で「問い合わせにつながったページ」にその記事が出ることを確かめる（送信までは不要）。

## コードの入口

- `scripts/build.js`（`ANALYTICS_BEACON`、`injectAnalyticsBeacon`）
- `netlify/functions/lib/analytics-store.js`（`FIXED_PATHS`、`normalizePath`、`isAllowedPath`、`parseBeaconPayload`、`parseBeaconBody`、`incrementTransition`）
- `netlify/functions/track-visit.js`
- `netlify/functions/admin-list-analytics.js`、`netlify/functions/admin-analytics-page.js`
- `.github/workflows/export-contact-transitions.yml`
- `scripts/lib/inquiry-signals.js`
- 試験: `scripts/lib/__tests__/test-analytics-store.js`、`test-track-visit.js`、`test-contact-transition.js`（いまはどの自動実行にも登録されていない）
