# 01 流入元・端末・操作ありの計測

背景と厳守事項は `README.md` を先に読むこと。

## R1 公開ページの計測の文（`ANALYTICS_BEACON`）

既存の動き（`doNotTrack` と本番以外で何もしない、問い合わせの `r`、LINE のクリック）を保ったまま足す。

1. `sessionStorage` の `mz_visit` に `{ i, s, u?, e? }` を JSON で持つ。読み書きの失敗は握りつぶす。
2. `document.referrer` のホスト名を読む。読めなければ空文字にする。
3. `mz_visit` が無く、ホスト名が `location.hostname` と違う（空文字を含む）とき、この表示を訪問の始まりとする。
   - `i` は `Math.random().toString(36).slice(2, 14)`。
   - `s` はホスト名だけ。URL の全体を入れない。
   - `u` は `location.search` の `utm_source`。あるときだけ入れ、先頭 32 文字に切る。
   - `mz_visit` に保存し、最初の送信の本文に `v`（= `i`）・`s`・`u` を足す。
4. サイト内の移動・再読み込み・同じタブでの再訪問では `v`・`s`・`u` を送らない。
5. `mz_visit` があり `e` が無く、`navigator.webdriver` が真でないとき、`document` に `scroll`・`pointerdown`・`keydown`・`touchstart` を `{ capture: true, passive: true }` で付ける。
   - 最初の 1 回で 4 つとも外し、`e: 1` を保存し、`{ p, e: 'engaged', v, s, u? }` を送る。1 訪問に 1 回だけ。
6. 全ページに入る文なので、処理は読み込みを妨げない軽さにする。

## R2 検証と分類（`analytics-store.js`）

### `parseBeaconPayload`

- 許す鍵を `p, r, e, v, s, u` にする。`e` は `line` か `engaged`。
- `v` は `/^[a-z0-9]{8,32}$/`。`s` は文字列、`u` は任意の文字列。
- 訪問の情報が正しいときだけ、戻り値に `visit: { id, host, utm }` を足す。無いときは `visit` の鍵自体を足さない（既存の試験の期待値を保つため）。
- `v` が不正でも `e` が無ければ PV は受け付け、`visit` を付けない。
- `e: 'engaged'` は `visit` が無ければ `null` を返す。
- 問い合わせの `r` の扱いを変えない。

### `classifySource(host, utm)`

戻り値は `{ source, detail }`。`detail` は `other`・`tagged` のときだけ値を持ち、他は `null`。

`host` は小文字にして検証する。`/^[a-z0-9.-]{1,253}$/` に合わないものは `{ source: 'other', detail: null }`。空文字は `direct`。`detail` は 64 文字を超えたら `null` にする。

`utm` は小文字にして `/^[a-z0-9_-]{1,32}$/` に合うときだけ使い、参照元より優先する。

| utm | source |
|---|---|
| `google` `yahoo` `bing` | 同名 |
| `line` | `line` |
| `x` `twitter` `facebook` `instagram` `threads` `youtube` `tiktok` `linkedin` | `sns` |
| `openai` `chatgpt` `perplexity` `copilot` `gemini` `claude` | `ai` |
| その他 | `tagged`（`detail` は utm の値） |

参照元の分類は上から順に判定する。「＋下位」は、そのホストと `.` で続くサブドメインの両方。

| source | ホスト |
|---|---|
| `ai` | `chatgpt.com`・`chat.openai.com`・`perplexity.ai`＋下位・`claude.ai`・`gemini.google.com`・`copilot.microsoft.com` |
| `google` | `/^(www\.)?google\.[a-z.]{2,}$/`・`com.google.android.googlequicksearchbox` |
| `yahoo` | `search.yahoo.co.jp`・`search.yahoo.com`・`jp.co.yahoo.android.yjtop` |
| `bing` | `bing.com`＋下位 |
| `line` | `line.me`＋下位・`lin.ee` |
| `sns` | `x.com`・`t.co`・`twitter.com`・`facebook.com`＋下位・`instagram.com`＋下位・`threads.net`・`threads.com`・`youtube.com`＋下位・`youtu.be`・`tiktok.com`＋下位・`linkedin.com`＋下位・`lnkd.in` |
| `other` | 上記以外（`detail` はホスト名） |

`search.yahoo.co.jp` 以外の `yahoo.co.jp` は `other` にする。ヤフーのニュースなどを検索と混ぜないため。

本番のホスト（`mori-zeirishi.net`・`www.mori-zeirishi.net`）が届いたら訪問として数えない。

### `deviceOf(userAgent)`

`/iPhone|iPod/` → `iphone`、`/Android/` → `android`、それ以外 → `pc`。

### 印の鍵

```
src/<日付>/<kind>/<source>/<device>/<detail または ->/<訪問 ID>
```

`kind` は `v`（訪問）か `e`（操作あり）。`sourceKey()` で作り、`parseSourceKey()` で分解する。形が違う鍵は `null`。

書き込みは `store.set(key, '1')`。`setJSON` と条件付き書き込みを使わない。同じ訪問の再送は同じ鍵に上書きされるので二重に数えない。

## R3 受け口（`track-visit.js`）

- 訪問の始まり: 既存の PV の記録の直後（`rate.modified` の確認を通ったあと）に `kind: 'v'` の印を置く。失敗は `console.warn` だけで、PV の記録や応答に影響させない。
- `engaged`: LINE の分岐と同じ位置で処理する。`markRate(store, minute, vidHash, 'engaged:' + path)` が通ったら `kind: 'e'` の印を置く。PV・訪問者・遷移を増やさない。印の失敗時は自分のレートマーカーを消す。
- 端末は要求の `user-agent` から `deviceOf` で求める。
- 印の鍵に `vidHash` を入れない。

## R4 管理 API（`admin-list-analytics.js`）

- `listPrefixKeys(store, 'src/')` を 1 回だけ呼び、日付ごとに集計する。日付ごとに一覧を取らない。
- 各行に `sources: { visits, engaged, details }` を足す。
  - `visits`・`engaged`: `{ google: { iphone: 1, android: 0, pc: 2 }, ... }`。印が無い分類は省いてよい。
  - `details`: `{ 'other|example.com': 3, 'tagged|qr': 1 }`。訪問（`v`）だけを数える。
- 応答の直下に `sourcesSince`（印のある最も古い日付、無ければ `null`）を足す。
- 一覧の取得に失敗しても API 全体を失敗させない。各行の `sources` を空にし、`sourcesError: true` を足す。
- 既存の項目を変えない。

## R5 管理画面（`admin-analytics-page.js`）

「日次推移」の次に「流入元」の枠を足す。7・30・90 日の切り替えに追従する。

| 列 | 内容 |
|---|---|
| 流入元 | Google／ヤフー／Bing／AI／LINE／SNS／他のサイト／印付きリンク／不明 |
| 訪問 | 回数 |
| 操作あり | 回数 |
| iPhone | 訪問の回数 |
| Android | 訪問の回数 |
| パソコン・その他 | 訪問の回数 |

- 行の順は上の並びで固定し、0 件の行も出す。最後に合計の行を置く。
- 表の下に「他のサイト・印付きリンクの内訳」を多い順に 10 件まで出す。文字はすべて `escapeHtml` を通す。
- 説明文（`notice`）に次の内容を書く。
  - 「サイトに入ってきた 1 回を 1 訪問と数えます。」
  - 「『不明』は、ブックマークやアプリからの移動など、直前のサイトが届かなかった訪問です。」
  - 「操作ありは、スクロールやタップなどがあった訪問です。自動アクセスを完全には見分けられません。」
  - 「検索語は分かりません。」
- `sourcesSince` があれば「YYYY/M/D から記録しています。」と出す。無ければ「まだデータがありません。」とする。
- `sourcesError` のときは「流入元を読み込めませんでした。」と出し、他の枠は通常どおり出す。
- 列が多いので、狭い画面では枠の中で横に動かせるようにする。ページ全体をはみ出させない。

## R6 片付け（`analytics-cleanup.js`）

`src/` の印も、`uniq/` と同じ基準で直近 90 日より古いものを消す。ログに件数を足す。

## 試験

既存の試験ファイルに足す。

- **分類**: 上の表の全行、大文字、`gemini.google.com` が `google` にならないこと、`news.yahoo.co.jp` が `other`、`evilgoogle.com`・`google.com.evil.example` が `google` にならないこと、不正な文字、空文字、utm の優先、不正な utm の無視、長い detail。
- **検証**: `v`・`s`・`u` の正常と異常、`engaged` の `visit` 無し、未知の鍵。
- **端末**: iPhone・Android・パソコン・空。
- **鍵**: `sourceKey` と `parseSourceKey` の往復、形の違う鍵。
- **受け口**: 訪問の印、`engaged` の印、`engaged` で PV が増えないこと、印の失敗で PV が残ること、ボットは印を置かないこと、鍵に `vidHash` が入らないこと、本番のホストは数えないこと。
- **本物の部品**: `@netlify/blobs` の `getStore` に偽の `fetch` を渡し、`set` が想定の URL に PUT すること、`list` の結果から `parseSourceKey` で集計できることを確かめる。
- **計測の文**（vm で実行）: 外部からの最初の表示で `v`・`s` を送る／サイト内の 2 ページ目と再読み込みで送らない／参照元なしは `s: ''`／`utm_source`／URL の全体を送らない／`engaged` は 1 回だけ／`navigator.webdriver` で送らない／`sessionStorage` が例外でも PV を送る／問い合わせの `r` と LINE の送信が変わらない。
- **管理 API**: 集計、`sourcesSince`、一覧の失敗で 200 と `sourcesError`、既存項目が変わらないこと、`list` の呼び出しが 1 回であること。
- **管理画面**: 表の値、期間の切り替え、内訳のエスケープ、0 件、`sourcesError`。
- **片付け**: 古い `src/` が消え、新しい印が残ること。

## 変更してはいけないもの

- `templates/pages/privacy.html`
- `incrementPageview`・`markUnique`・遷移・送信完了・LINE の数え方
- `netlify.toml`（経路の追加は要らない）
- `package.json`（既存の試験ファイルに足すので要らない）
