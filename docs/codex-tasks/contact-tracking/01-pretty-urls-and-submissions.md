# 01 本番の URL の形で数える・送信完了の前のページを記録する

背景と厳守事項は `README.md`。この段階で全部を 1 PR にする。

## 実装要件

### R1 受け口でパスをそろえる（`netlify/functions/lib/analytics-store.js`）

- `.html` なしの形を `.html` 形にそろえる対応表を持つ。

  | 受け取った形 | 保存するキー |
  |---|---|
  | `/about` | `/about.html` |
  | `/contact` | `/contact.html` |
  | `/contact-thanks` | `/contact-thanks.html` |
  | `/services` | `/services.html` |
  | `/voice` | `/voice.html` |
  | `/privacy` | `/privacy.html` |
  | `/404` | `/404.html` |

  末尾に `/` が付いた形（例 `/contact/`）も同じ扱いにする。表に無いパスはそろえない（`/blog/...` の扱いは今のまま変えない）。
- そろえる処理は `normalizePath` の中（またはその直後の共通の 1 か所）で行い、閲覧したページ（`p`）と遷移元（`r`）の**両方**に効かせる。`parseBeaconBody` も同じ結果になること。
- 数える対象（`isAllowedPath`）に次を加える。
  - `/contact-thanks.html`、`/area/`、`/pricing/`（固定）
  - `/services/<slug>/`（`/^\/services\/[a-z0-9-]+\/?$/`。`/blog/` の既存の書き方に合わせる）
- 今までの長さ制限・文字の制限・`..` 禁止・不明な項目があれば全体を弾く、はそのまま。

### R2 送信完了の記録（受け口）

- 定数 `THANKS_PATH = '/contact-thanks.html'` を足す。
- `parseBeaconPayload`: 遷移元 `ref` を受け取るのは、そろえた後のパスが `CONTACT_PATH` か `THANKS_PATH` の時だけ。`ref` は数える対象のパスで、かつ `CONTACT_PATH`・`THANKS_PATH` のどちらでもないこと（それ以外は `ref: null`）。
- `track-visit.js`:
  - パスが `CONTACT_PATH` で `ref` あり → 今までどおり `incrementTransition`（キー `transitions/<日付>`）。
  - パスが `THANKS_PATH` で `ref` あり → 新しく `submissions/<日付>` に遷移元別の回数を足す（中身の形は `transitions/` と同じ `{ date, total, byFrom }`）。
  - 同じ処理を 2 回書かず、内部の共通関数にまとめる。`incrementTransition` の名前・引数・戻り値は変えない（既存の試験が使う）。新しい関数は `incrementSubmission` とし、`submissionKey(date)` と一緒に公開する。
  - 失敗しても閲覧の記録に影響させない、1 分あたりの重複除外を通った時だけ足す、は `transitions` と同じ。

### R3 計測ビーコン（`scripts/build.js` の `ANALYTICS_BEACON`）

- 問い合わせページの判定は `/contact` と `/contact.html` の両方。送信完了ページの判定は `/contact-thanks` と `/contact-thanks.html` の両方。
- 問い合わせページで:
  - 遷移元がこのサイトの別のページ（問い合わせページ・送信完了ページ以外）なら、今までどおり `r` に付けて送る。さらに `sessionStorage` の `mz_contact_from` にそのパスを保存する。
  - 遷移元が問い合わせページ自身か送信完了ページ（入力エラーでの再表示・再読み込み・送信後に戻った場合）なら、`r` を付けず、保存済みの値もそのまま残す。
  - 遷移元が無い・サイトの外なら、`r` を付けず、保存済みの値を消す（前に見た記事の手柄にしない）。
- 送信完了ページで: `mz_contact_from` があれば `r` に付けて送り、送った後に消す（再読み込みで二重に数えない）。
- `sessionStorage` が使えない環境（例外）でも、閲覧の送信は止めない（`try` で囲む）。
- 既存の「本番のホスト以外・Do Not Track なら何もしない」はそのまま。送る項目は `p` と `r` だけ（受け口が他の項目を弾くため）。

### R4 管理画面（`admin-list-analytics.js`・`admin-analytics-page.js`）

- 一覧の API: 日ごとに `submissions/<日付>` も読み、各日の行に `submittedFrom`、全体に合計 `submittedFrom` を足す（`contactFrom` と同じ作り）。
- 画面: 「問い合わせにつながったページ」の隣に「送信完了につながったページ」の欄を足す。説明文は「選択中の期間に、このページを見たあと問い合わせを送った回数です（同じ画面の中で続けて見た場合だけ数えます）。」。表示の作りは既存の欄と同じ（名前は `analytics-page-map.json`、上位 10）。

### R5 週次の書き出し（`.github/workflows/export-contact-transitions.yml`）

- `data/contact-transitions.json` に `submittedFrom`（API の合計 `submittedFrom`）を足す。`note` を「どのページから問い合わせページへ進んだか（byFrom）と、送信完了の前にどのページを見ていたか（submittedFrom）の実測（直近90日）。週次で更新。」に変える。
- ログに、直近 90 日の閲覧数の合計・問い合わせページ（`/contact.html`）の閲覧数・送信完了ページ（`/contact-thanks.html`）の閲覧数・遷移元の件数・送信完了の遷移元の件数を出す（数えられているかを GitHub のログだけで確かめるため）。これらの合計はファイルには書かない（毎週 PR ができてしまうため）。
- 変更の有無の判定（`has-substantive-change.js`）・PR の作り方・自動マージしない、は変えない。
- `data/contact-transitions.json` 自体も新しい形（`submittedFrom: {}`）にしておく。

### R6 題材選びへの反映（`scripts/lib/inquiry-signals.js`）

- 信号のキーは `byFrom` と `submittedFrom` の両方の遷移元（和集合）から作る。`submittedFrom` が無い古い形のファイルでも今までどおり動く。重み付けは足さない（0 か 1 のまま）。
- 冒頭の説明コメントを実態に合わせる。

## 試験

既存の `test-analytics-store.js`・`test-track-visit.js`・`test-contact-transition.js` を直し・足し、**3 本を `package.json` の `masters:test` の末尾に登録する**（いまはどの自動実行にも入っていない）。

1. `normalizePath`／`parseBeaconPayload`:
   - `{p:'/contact', r:'/blog/x/'}` → `path:'/contact.html', ref:'/blog/x/'`
   - `{p:'/contact/', r:'/about'}` → `path:'/contact.html', ref:'/about.html'`
   - `{p:'/contact-thanks', r:'/services/ebay-export/'}` → `path:'/contact-thanks.html', ref:'/services/ebay-export/'`
   - `{p:'/contact-thanks', r:'/contact'}` → `ref:null`、`{p:'/contact', r:'/contact-thanks.html'}` → `ref:null`
   - `{p:'/about', r:'/blog/x/'}` → `path:'/about.html', ref:null`（問い合わせ・送信完了以外では遷移元を持たない）
   - `/pricing/`・`/area/`・`/services/tax-return/` は数える。`/services/../x`・`/servicesx`・`/tools/shohizei-simulator/`・`/random` は数えない
   - 既存の否定の試験（サイト外の形式・不明な項目・長すぎるパス）はそのまま通る
2. `track-visit`（注入した偽の store）:
   - `/contact` ＋ `r` → `daily` の `byPath['/contact.html']` と `transitions/<日付>` が 1 増える
   - `/contact-thanks` ＋ `r` → `daily` の `byPath['/contact-thanks.html']` と `submissions/<日付>` が 1 増え、`transitions/` は増えない
   - 同じ訪問者・同じ分の 2 回目は増えない（既存の重複除外）
3. **ビーコンを実際に動かす試験**（新規。`test-contact-transition.js` に足すか新しいファイル）:
   `scripts/build.js` が書き出した HTML（または `ANALYTICS_BEACON` の文字列）から `<script>` の中身を取り出し、Node の `vm` で、偽の `location`（`hostname: 'mori-zeirishi.net'`）・`document.referrer`・`navigator`（`doNotTrack`、`sendBeacon` を記録する偽物）・`sessionStorage`（Map で作る偽物）を与えて実行し、送られた本文を確かめる。
   - 本番の形: `pathname '/contact'`・`referrer 'https://mori-zeirishi.net/blog/x/'` → 送信 `{p:'/contact', r:'/blog/x/'}`、`sessionStorage.mz_contact_from === '/blog/x/'`
   - 元の形: `pathname '/contact.html'` でも同じ
   - 再表示: 保存済み `/blog/x/` の状態で `referrer` が `https://mori-zeirishi.net/contact` → `r` なし、保存値は残る
   - サイトの外から: `referrer 'https://www.google.com/'` → `r` なし、保存値は消える
   - 送信完了: 保存済み `/blog/x/` の状態で `pathname '/contact-thanks'` → `{p:'/contact-thanks', r:'/blog/x/'}`、送った後に保存値は消える。保存値が無ければ `{p:'/contact-thanks'}`
   - `sessionStorage` が例外を投げても `sendBeacon` は呼ばれる
   - 送られた本文を `parseBeaconPayload` に通すと、上の 1 の期待どおりの `path`・`ref` になる（ビーコンと受け口のつながりを確かめる）
4. `admin-list-analytics`: 偽の store に `submissions/<日付>` を置くと、合計 `submittedFrom` に出る（関数を store 注入で試せない作りなら、集計部分を小さな関数に切り出して試す）。
5. `inquiry-signals`: `submittedFrom` だけに遷移元がある形・`submittedFrom` が無い古い形の両方で、期待どおりのキーになる。
6. `test-workflow-change-detection.js` が通る。

## 変更してはいけないもの

- `content/posts/*.md`、`templates/` のリンク先、`analytics-page-map.json` のキー
- `isProductionRequest`・`isBot`・Cookie・1 分あたりの重複除外・`analytics-cleanup.js`
- `/tools/*` の扱い、`netlify.toml`
- 他の workflow
