# 仕様書・設計書：訪問者計測（自前アナリティクス）

最終更新: 2026-07-14 / ステータス: ドラフト（実装前レビュー v4・レビュー反映）

> v4 反映（最後の必須2点）：
> **rate マーカー × daily PV のクロスキー不整合を解消** — `rate` を `onlyIfNew` 作成後に daily CAS が
> 最終失敗したら**自分が作成した `rate` マーカーを補償削除**して再送で再試行可能にする（§6.2/§6.5、処理順序を §6 に明記）。
> より堅牢な代替（rate を PV 正本イベント化・daily は派生）は Phase 2 で検討／
> **既存プライバシーポリシー（`templates/pages/privacy.html` の「Google アナリティクス等」）を自前計測の記載に
> 置換**することを実装対象に明記（§9/§13）。
>
> v3 反映（クロスキー整合性・実装細部）：
> **UU は daily.visitors を持たず `uniq/<date>/*` の件数から算出**（PV だけを daily で CAS。マーカー作成と
> visitors++ が別キーで CAS 失敗時に過少計上する問題を根本回避）／CAS の**新規キー分岐**を明記
> （ETag があれば `onlyIfMatch`、無ければ `onlyIfNew`、競合は再読込リトライ）／レート上限の状態を
> **Blobs マーカー**で保持（メモリ不可）とデータモデルに追加／パス許可を `startsWith('/')` でなく
> **固定ページ完全一致＋ブログ正規表現**に／`analytics-page-map.json` は**ブラウザ側が同一オリジン取得**で変換／
> `analytics-cleanup` の**頻度・対象日・list ページネーション**を定義／HMAC Cookie を
> **Base64URL・`v1.` バージョン接頭辞・`timingSafeEqual`** で確定。
>
> v2 反映：daily の同時更新欠落を CAS 必須に格上げ／`/track` 濫用対策を具体化／Cookie を署名付きに／
> プライバシー文言を「個人関連情報」前提に強化・参照元(r)は Phase1 で送らない／コスト前提を「実プラン要確認」に／
> 人気ページのタイトル取得を `analytics-page-map.json` で定義／ローテを専用 Scheduled Function に分離／
> テスト計画を追加／断定表現を是正。

## 1. 目的・背景

mori-zeirishi.net（Netlify ホスティング／`hp-vlog` リポジトリの静的サイト）に、
**「毎日何人が訪問したか」を管理画面で確認できる機能**を追加する。

外部サービスに依存せず、既存構成（Netlify Functions＋Netlify Blobs＋Basic 認証の
管理画面＋`templates/*.html` からの `build.js` 生成）にそのまま乗せる自前方式で作る。

### 対象指標（確定）
- **ユニーク訪問者数**（日次）
- **ページビュー（PV）**（日次）
- **人気ページ Top**（期間内の閲覧上位）

### 対象範囲（確定）
- **サイト全ページ**（トップ・固定ページ・ブログ記事すべて）。ただし**本番ホストのみ**を計上（§6.7）。

## 2. 「訪問者数」の定義とクロスデバイスの扱い（重要）

要望は「**別端末でも同一人なら同一カウント**」だが、**匿名の公開サイトでは、別端末
（スマホ／PC 等）の訪問者を"同じ人"と確実に判定することは技術的に不可能**である。
個人を紐づける手段（ログイン等）が無いため。真のクロスデバイス同定には次のいずれかが必要になる：

| 手段 | 可否 | 備考 |
|---|---|---|
| ログイン（User-ID） | ○だが不適用 | マーケティングサイトに会員ログインは無い |
| Google シグナル（GA4） | △近似のみ | 「Googleアカウントにログイン中＋広告個人化に同意」ユーザーだけを横断。全員は無理・同意必須 |
| フィンガープリンティング | ×非推奨 | 不正確・プライバシー/法令リスク（同意要）・保守困難 |
| Cookie（1ブラウザ＝1人） | ○採用 | 別端末/別ブラウザ/Cookie削除は別人扱い |

### 本仕様での定義（採用）
- **「訪問者」＝ 同一ブラウザ（署名付き Cookie `mz_vid`）を同一人とみなし、1 日 1 カウント。**
- 別端末・別ブラウザ・Cookie 削除・シークレットモードは**別人扱い**（限界として明記）。
- **本サイトでは「ブラウザ単位の日次ユニーク」として扱う**（＝あくまで参考値）。他製品（GA/Plausible/
  Netlify Analytics 等）は Cookie 利用・推定・同意・クロスデバイスの扱いが製品ごとに異なるため、
  「各社と同じ」とは断定しない。
- **将来オプション**：近似のクロスデバイスが必要なら GA4（＋Google シグナル・同意バナー）を
  併設して"参考値"として見る道がある。自前方式では対応しない。

## 3. 全体アーキテクチャ

```
[各ページ末尾のビーコンJS] ──navigator.sendBeacon('/track', {p})──▶ track-visit Function
                                                                          │ CAS で記録
                                                                          ▼
                                                                  Netlify Blobs (store: "analytics")
                                                                          ▲
[/admin/analytics 画面 (Basic認証)] ──fetch('/admin/api/analytics')──▶ admin-list-analytics ─┘

[日次/月次クリーンアップ Scheduled Function] ──▶ 古い uniq/* を削除（§7）
[build.js] ──▶ analytics-page-map.json（パス→記事タイトル）を出力（§8）
```

## 4. データモデル（Netlify Blobs）と整合性

- ストア名：`analytics`。日付は **JST**（`Asia/Tokyo`）の `YYYY-MM-DD`。

| キー | 値（JSON） | 用途 | 書き込み方式 |
|---|---|---|---|
| `daily/<YYYY-MM-DD>` | `{ date, pageviews, byPath: { "<path>": pv } }` | 日次 **PV** 集計（visitors は持たない） | **強整合読み取り＋条件付き書き込み CAS（§6.5）** |
| `uniq/<YYYY-MM-DD>/<vidHash>` | `"1"`（マーカー） | その日そのブラウザが訪問済みか（**UU は件数から算出**） | **onlyIfNew（原子的作成・§6.4）** |
| `rate/<YYYY-MM-DD-HHmm>/<vidHash>/<pathHash>` | `"1"`（マーカー） | 1 Cookie・1 パス・1 分の PV 上限判定（§6.2） | **onlyIfNew（原子的作成）** |

- `vidHash` = 署名付き Cookie `mz_vid` の**ID 部分**を SHA-256 でハッシュした先頭 16 桁。`pathHash` = 正規化パスの SHA-256 先頭 8 桁。**IP は保存しない**。

### 4.1 整合性（重大・MVP 必須）
- Netlify Blobs は**既定で結果整合性**であり、同一キーの同時更新は **last-write-wins**。
  素朴な read-modify-write（RMW）では、**低トラフィックでも同時アクセスで PV が欠落する**。
- **UU（visitors）は daily に持たせない**。§6.4 で述べたクロスキーの非原子性
  （uniq マーカー作成成功 ↔ daily.visitors++ が別キーで、CAS 失敗時に整合性が崩れ**永久に過少計上**）
  を根本回避するため、**UU は集計時に `uniq/<date>/*` の件数から数える**（§6.6 / §8）。
- **daily は PV（pageviews・byPath）だけ**を、次の CAS で更新する（visitors を含めないのでクロスキー問題なし）：
  - **強整合読み取り**（`getWithMetadata(key, { consistency: 'strong' })`）で現在値と ETag を取得。
  - **キーが存在する場合**：`setJSON(key, v, { onlyIfMatch: etag })`。
  - **キーが存在しない（ETag が無い）場合**：`onlyIfMatch` は使えないため `setJSON(key, v, { onlyIfNew: true })`。
  - どちらも**条件不一致（未更新）なら再読込して 1 からリトライ**（最大 N 回・指数バックオフ）。
- ユニーク／レート上限マーカーは **`set(key, "1", { onlyIfNew: true })` で原子的に作成**する。

## 5. 収集仕様（ビーコン）

- 注入場所：`templates/*.html` の `</body>` 直前（`build.js` が全ページに展開）。**各生成HTMLに1回だけ**入れる。
- 送信しない条件：`/admin`・`/review`、Netlify プレビューURL・localhost・`location.hostname` が本番でない、
  `navigator.doNotTrack === '1'`（DNT 尊重・既定 ON）。
- 動作：
  1. ページ表示時に `navigator.sendBeacon('/track', JSON.stringify({ p: location.pathname }))` を **1回**送信。
     非対応時は `fetch('/track', { method:'POST', keepalive:true, body })` にフォールバック。
  2. **参照元（referrer）は Phase 1 では送らない**（データ最小化）。将来 Phase 2 で必要時に検討。
- Cookie は**サーバー（`/track`）が発行・署名**する（クライアント JS は ID を作らない）。§6.3 参照。

## 6. 記録 API：`track-visit`（ルート `/track`）

- メソッド：POST のみ。GET/OPTIONS は 204。**本文は JSON `{ p }` のみ**。
- レスポンス：204 No Content（＋必要時 `Set-Cookie`）。`Cache-Control: no-store`。エラーは握りつぶして 204。
- **処理順序**：受信検証(§6.1) → Cookie 検証/発行(§6.3) → UU マーカー(§6.4) →
  **レートマーカー作成(§6.2)** → **PV 集計 CAS(§6.5)** → PV CAS が最終失敗ならレートマーカーを補償削除(§6.2/§6.5)。
  UU マーカー(§6.4)は補償削除しない（UU は件数由来で PV 失敗と独立、二重計上も過少計上も起きないため）。

### 6.1 受信検証（濫用対策・重大）
`/track` は公開エンドポイントのため、次を**すべて満たさない要求は記録しない**（204で無視）：
- **Origin / Referer が本番ホスト**（`mori-zeirishi.net`）であること。
- **`Sec-Fetch-Site` が `same-origin`（または `same-site`）**であること（クロスサイトからの直POSTを弾く）。
- **User-Agent 必須**、既知クローラ（`bot|crawl|spider|slurp|preview|lighthouse|headless|monitor` 等）は除外。
- **実際に読み込んだ本文サイズの上限**（例：1KB）を超えたら破棄（Content-Length 申告だけに頼らない）。
- **パス許可判定は `startsWith('/')` にしない**（それでは全パスが通る）。次で判定し、外れたら記録しない：
  - **固定ページは完全一致**の許可リスト：`/`, `/about/`, `/contact/`, `/blog/`（一覧）等（末尾スラッシュ正規化後）。
  - **ブログ記事は明示的な正規表現**：`^/blog/[a-z0-9-]+/?$`（生成 slug の形に一致）。
  - クエリ・フラグメント除去、末尾スラッシュ統一、長さ上限（例 128 文字）。いずれにも合致しないパスは無視。

### 6.2 レート制限（数値汚染の緩和・状態は Blobs で保持）
- **1 Cookie・1 パス・1 分あたり PV 1 回**。判定は**メモリではなく Blobs マーカー**で行う（Function は毎回別インスタンスになり得るため、メモリでは効かない）：
  - キー `rate/<YYYY-MM-DD-HHmm>/<vidHash>/<pathHash>`（分単位バケット）に `set(..., { onlyIfNew: true })`。
  - **作成できた（初回）場合のみ PV を計上**。作成失敗（既存）＝同一分の重複とみなし PV を計上しない。
  - `rate/*` は短命。**`analytics-cleanup` が当日分より前のバケットを削除**（§7）。
- **重要（クロスキー整合）：レートマーカー作成 → PV 集計失敗の補償**。
  `rate` を `onlyIfNew` 作成した直後に §6.5 の daily CAS が N 回失敗すると、**マーカーだけが残り、同じ分の再送は
  レート制限で捨てられるため当該 PV が恒久的に過少計上**になる。これを防ぐため：
  - **daily CAS が最終的に失敗したら、このリクエストが作成した `rate` マーカーを `delete` してから 204 を返す**
    （＝再送で再試行可能にする。補償トランザクション）。
  - 「自分が作成したマーカーだけ」を消す（作成が成功＝初回だったリクエストのみ削除する。既存扱いだった場合は消さない）。
- Netlify 側の **レート制限（Edge/Functions のリクエスト制限）**も併用（設定は実装時に確認）。
- **完全防止は不可能**であり、数値は**「参考値」**として扱う（管理画面にも明記・§8）。

> 【より堅牢な代替（任意・Phase 2 で検討）】`rate/*`（＝時刻付きのアクセスイベント）を **PV の正本イベント**として
> 保持し、`daily.pageviews`/`byPath` は**そこから導出する派生データ**にする設計。こうすると CAS 失敗＝
> 派生の再計算で回復でき、補償削除も不要になる。MVP は上記の「補償削除」で十分とし、正本イベント化は
> トラフィック増時に移行（§11）。

### 6.3 Cookie（改ざん耐性）
- 属性：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`（1年）。
- 値の形式：**`v1.<idB64url>.<sigB64url>`**（**バージョン接頭辞 `v1.` を付与**し将来の鍵ローテ／方式変更に備える）。
  - `id` = ランダム 16 バイト、`sig` = `HMAC-SHA256(secret, "v1." + idB64url)`。両者とも **Base64URL（パディング無し）**。
  - `secret` は環境変数 `ANALYTICS_COOKIE_SECRET`（表示・ログ出力しない）。
- 検証：形式・バージョン一致を確認し、署名は **`crypto.timingSafeEqual` で定数時間比較**（`==` は使わない）。
  不正・欠落・バージョン不一致なら**新規発行**し、当該リクエストは新規訪問者として扱う（改ざん Cookie を信用しない）。
- `HttpOnly` によりクライアント JS からは読めない（ID 生成・署名・付与はすべてサーバー側）。

### 6.4 ユニーク判定（マーカーのみ・visitors は加算しない）
1. `vidHash` を算出。
2. `set('uniq/<date>/<vidHash>', "1", { onlyIfNew: true })` を実行（**そのブラウザがその日訪問した事実だけ**を残す）。
3. **daily.visitors は更新しない**。UU は集計時に `uniq/<date>/*` の**件数**から数える（§6.6 / §8）。
   これによりユニークマーカー作成と PV 集計が**別キーでも整合が崩れない**（過少計上バグの根本回避）。

### 6.5 PV 集計（CAS・新規キー分岐）
1. `daily/<date>` を **強整合読み取り**（`getWithMetadata(key, { consistency: 'strong' })`）。値と ETag を取得。
2. メモリ上で `pageviews += 1`、`byPath[path] += 1`（**visitors は扱わない**）。§6.2 で計上対象と判定された時のみ実行。
3. 書き込み：
   - **存在する場合**：`setJSON(key, v, { onlyIfMatch: etag })`。
   - **存在しない（ETag 無し）場合**：`setJSON(key, v, { onlyIfNew: true })`。
4. **条件不一致（未更新）なら再読込して 1 から再試行**（最大 N 回・指数バックオフ）。
   **N 回失敗時は、このリクエストが §6.2 で作成した `rate` マーカーを `delete`（補償）してから 204 を返す**
   （再送で再試行できるようにし、PV の恒久過少計上を防ぐ）。

### 6.6 UU の算出（集計時）
- 日次 UU = `store.list({ prefix: 'uniq/<date>/' })` の**件数**（`list` は**ページネーション**するため全ページを走査・§7）。
- 期間 UU（7/30 日など）は各日の件数を合算（同一ブラウザが複数日訪問すれば各日でカウント＝日次ユニークの定義どおり）。
- ローテ削除は `/track` では行わない（§7 の専用 Function）。

### 6.7 本番ホスト限定（Blobs 混入防止）
- Blobs はサイト全体（本番・各 Deploy Preview）で**共有**される。ビーコン側の除外だけでなく、
  **Function 側でも本番ホスト以外（プレビュー/ブランチデプロイ）からの記録を破棄**する。

## 7. 集計・データ保持（ローテーションは専用 Function）

- `daily/<date>`：**無期限保持**（1日1レコード・軽量）。
- `uniq/<date>/*`：**90 日でローテ削除**（UU 集計は直近 90 日で足りる）。
- `rate/<...>`：**当日より前を削除**（短命・分単位バケット）。
- **専用 Scheduled Function `analytics-cleanup`**（`/track` では実施しない）：
  - **実行頻度**：日次 1 回（既存 scheduler と同様に Netlify scheduled → 早朝 JST。例 03:00）。
  - **削除対象**：`uniq/<date>/*` は `date < today−90日`、`rate/*` は当日バケットより前すべて。
  - **列挙**：`store.list({ prefix })` は**ページネーションする**ため、`cursor` が無くなるまで全ページを取得して
    対象キーを `delete`。1 回の実行で処理しきれない量になったら日付範囲を分割（当面は不要想定）。
  - 削除件数を `console.log` に残す（監視用）。
- 人気ページ Top は `daily.byPath` を期間合算して算出（表示時に計算）。

## 8. 管理画面仕様：`/admin/analytics`

- 認証：既存の `requireBasicAuth(event)`（`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS`）を必須。
- 応答は **`Cache-Control: no-store`**（画面・API とも）。
- 構成：`admin-analytics-page`（HTML）＋ `admin-list-analytics`（API・`?days=30` 等で日次集計を返す）。
  - API は各日について **PV（`daily/<date>`）と UU（`uniq/<date>/*` の件数・§6.6）**を集計して返す。
- 表示要素：
  1. サマリー：**今日／昨日／直近7日／直近30日** の「ユニーク訪問者（uniq 件数由来）」と「PV」。
  2. 日次グラフ（自前の軽量インライン SVG。外部CDN禁止方針に合わせる）。期間切替 7 / 30 / 90 日。
  3. **人気ページ Top 10**：期間内 PV 上位。**パス→記事タイトルの変換**は §8.1。
  4. 注記：「数値はブラウザ単位の日次ユニークによる**参考値**（bot・スパムを完全には除去できない）」。

### 8.1 パス→タイトルの取得（人気ページ）
- `daily.byPath` は**パスしか持たない**。タイトル変換方法を Phase 1 で確定する：
  - **採用案**：`build.js` がビルド時に **`analytics-page-map.json`（`{ "/blog/xxx/": "記事タイトル", ... }`）**
    を**サイトの静的ファイルとして出力**する（例 `/analytics-page-map.json`）。
  - 変換は **Function ではなく管理画面のブラウザ側**が行う：`/admin/analytics` の JS が
    **同一オリジンの静的 JSON を fetch** し、API が返したパス別 PV にタイトルを突き合わせて表示・リンク化する。
    （Function のローカルファイル読み取りに依存しない。バンドル・デプロイ差異の影響を受けないため安全。）
  - 代替：Phase 1 は**パスのみ表示**（マップ導入は後回し）。
- どちらにするかはレビューで決定（既定は `analytics-page-map.json`＋ブラウザ側変換）。

### 8.2 画面レイアウト案（ワイヤー）
```
┌ アクセス解析（参考値）────────────────────┐
│ 訪問者 [今日12][昨日20][7日90][30日380]                       │
│ PV     [今日34][昨日55][7日260][30日1,120]                    │
│ 期間: (7日)(30日)(90日)                                        │
│ ┌ 日次グラフ（訪問者/PV）──────────────┐ │
│ │      ▁▂▅▇▅▃▂▁ …                          │ │
│ └────────────────────────────┘ │
│ 人気ページ Top10                                             │
│  1. /blog/xxx/  「記事タイトル」  PV 120                      │
│  …                                                           │
└──────────────────────────────────┘
```

## 9. プライバシー・法令対応

- Cookie 識別子と閲覧履歴は、個人情報でなくても日本の個人情報保護委員会（PPC）がいう
  **「個人関連情報」に当たり得る**。「匿名」「個人を識別しない」だけの説明では不十分。
- **プライバシーポリシーに最低限、次を明記**する：
  - 利用目的（サイト利用状況の把握・改善）
  - 使用する **Cookie 名（`mz_vid`）と保持期間（1年）**
  - **Netlify（ホスティング／Blobs）を利用**して集計している旨
  - **アプリケーションとして IP アドレスを保存しない**旨
  - **無効化方法**（ブラウザの Cookie 設定・DNT）
- **海外向けにも提供する場合**は、解析 Cookie の**同意取得**、または**地域別の計測停止**を要検討。
- **参照元（referrer）は Phase 1 では収集しない**（データ最小化）。
- **既存プライバシーポリシーの置換（実装対象）**：
  現在 `templates/pages/privacy.html`（8.「アクセス解析ツールについて」・79 行目付近）に
  **「Googleアナリティクス等のアクセス解析ツールを使用することがあります」**という記載がある。
  **自前計測のみ**の方針なので、この文言は実態と食い違う。**同ファイルを本仕様の内容に置換**し、
  ビルド（`build.js`）で公開ページ（`/privacy.html`）に反映する。§13 の変更対象に含める。
- ポリシー置換文例（8. の本文）：
  > 当サイトでは、サイトの利用状況の把握・改善のため、当サイト独自の Cookie（名称: mz_vid／保持期間: 1年）を
  > 用いて訪問者数・ページ閲覧数を集計しています。Google アナリティクス等の外部解析ツールは使用していません。
  > 集計は当サイトのホスティング事業者（Netlify）上で行い、IP アドレスは保存しません。
  > ブラウザの設定で Cookie を無効化できます。

## 10. コスト・パフォーマンス

- **料金は契約プラン依存**。「無料枠 125,000 呼び出し」は**旧プランの数値**であり、
  現行のクレジット制プランでは Web リクエストと Functions compute の扱いが異なる。
  → **Netlify の実契約プランを確認してから見積もりを更新**する（実装前の確認事項・§16）。
- 1 訪問 = 1 `/track` 呼び出し＋Blobs 読み書き。ビーコンは `sendBeacon` で非同期・表示をブロックしない。
- CAS リトライは同時アクセス時のみ発生（低トラフィックでは稀）。

## 11. 高負荷時の移行案（将来）

- CAS リトライが頻発するトラフィックになった場合：
  (a) パス別・訪問者別を個別キーにして集計時に合算（書込競合を分散）、
  (b) 外部 KV（Upstash 等）や集計 DB、(c) GA4 併設。MVP は §4.1 の CAS 方式のまま。

## 12. セキュリティ（まとめ）

- 記録側（`/track`）：Origin/Sec-Fetch-Site 検証、本番ホスト限定、UA 必須・bot 除外、
  本文サイズ上限、パス許可リスト、署名 Cookie 検証、1 Cookie・1 パス・1 分の PV 上限、
  Netlify レート制限。**完全防止は不可＝参考値**を管理画面に明記。
- 管理側：`requireBasicAuth` 必須、`Cache-Control: no-store`。
- 秘密情報：`ANALYTICS_COOKIE_SECRET` は環境変数（表示・ログ出力しない）。

## 13. 実装対象ファイル（Phase 1）

- `package.json`：`@netlify/blobs` を追加。
- 新規：
  - `netlify/functions/track-visit.js`（記録・CAS・検証・署名Cookie）
  - `netlify/functions/admin-analytics-page.js`（画面・no-store）
  - `netlify/functions/admin-list-analytics.js`（API・no-store）
  - `netlify/functions/analytics-cleanup.js`（Scheduled・`uniq`/`rate` ローテ削除・list ページネーション）
  - `netlify/functions/lib/analytics-store.js`（Blobs I/O・CAS＋新規キー分岐・onlyIfNew・UU件数集計・bot 判定・パス許可判定・ハッシュ・HMAC署名検証）
- 変更：
  - `netlify.toml`：`/track`→track-visit、`/admin/analytics`→admin-analytics-page、
    `/admin/api/analytics`→admin-list-analytics の redirect、`analytics-cleanup` の schedule を追加。
  - `scripts/build.js`：ビーコン注入（各HTML1回）＋ **`analytics-page-map.json` を静的出力**（`/analytics-page-map.json`）。
  - **`templates/pages/privacy.html`**：既存の「8. アクセス解析ツールについて」の Google アナリティクス言及を
    自前計測の記載に**置換**（§9）。ビルドで `/privacy.html` に反映。
- 環境変数：`ANALYTICS_COOKIE_SECRET`（HMAC 用）を追加。
- テスト：`scripts/lib/__tests__/test-analytics-store.js` ほか（§14）。

## 14. テスト計画

- **PV 整合性**：`daily` に対し**同時 20 リクエストで PV が欠落しない**（CAS＋新規キー分岐で合算が一致）。
- **CAS 新規キー**：`daily/<date>` 未作成時は `onlyIfNew`、以後は `onlyIfMatch`、競合時は再読込リトライで正しく増える。
- **UU 算出**：同一 `vidHash`×同日は `uniq` マーカーが 1 個だけ → **UU 件数が一度だけ増える**（二重計上しない）。
  別 `vidHash` は別カウント。UU は `uniq/<date>/*` の件数と一致。
- **クロスキー過少計上の非再現**：uniq 作成成功後に daily CAS が失敗しても、**UU は uniq 件数由来なので過少計上しない**。
- **レート上限**：同一 `vidHash`×同一パス×同一分は 2 回目以降 PV を計上しない（`rate/*` マーカーで判定）。
- **レート×PV 補償**：`rate` 作成後に daily CAS を N 回失敗させると、**その `rate` マーカーが削除される**（残らない）。
  直後の再送で PV が正しく 1 計上される（rate 残留による恒久過少計上の非再現）。既存扱いだったリクエストは削除しない。
- **ホスト限定**：**本番以外のホスト（プレビュー）からは記録しない**。
- **改ざん**：**不正 Cookie・署名不正・バージョン不一致を拒否**（`timingSafeEqual`／新規発行扱い、既存カウントを汚さない）。
- **キャッシュ**：管理画面 / API 応答が **`no-store`**。
- **ビーコン**：`build` 後、**各生成 HTML にビーコンが 1 回だけ**入る（`/admin`・`/review` には入らない）。
- **パス許可判定**：`/`・固定ページは完全一致で通り、`/blog/<slug>/` は正規表現で通り、
  それ以外（例 `/../`, `/random`, クエリ付き）は通らない（`startsWith('/')` 誤判定の非再現）。
- **クリーンアップ**：`uniq` は 90 日超、`rate` は前日以前を削除。`list` の**複数ページ**を走査できる。
- **bot / パス正規化 / JST 日付境界**の単体。
- 既存回帰：`scripts/lib/__tests__/test-*.js` 全 PASS、`npm run build` 成功。

## 15. 段階リリース

- **Phase 1（MVP・本仕様）**：訪問者・PV・人気ページ Top・直近30日グラフ・管理画面表示（CAS・濫用対策込み）。
- **Phase 2（任意）**：参照元（referrer）集計（同意/最小化を再検討）、期間比較（前週比）、
  CSV エクスポート、Chatwork へ「昨日の訪問者数」日次通知。

## 16. 未決事項・実装前チェック

- クロスデバイス同定は不可（§2）。Cookie 単位・日次ユニークの定義で合意が前提。
- **Netlify の実契約プランを確認**し、コスト見積もりを更新（§10）。
- **Netlify Blobs の有効化**確認、`getWithMetadata(..., { consistency: 'strong' })` の ETag 返却／
  `onlyIfMatch` / `onlyIfNew` / `list` のページネーション（cursor）対応をランタイムで確認（実装時）。
- **UU は `uniq/<date>/*` の件数から算出**（daily.visitors は持たない）で確定（§4.1/§6.6）。
  トラフィックが増えて `list` 件数集計が重くなったら、日次確定後に件数を `daily` へ**書き戻して確定値化**する
  最適化を検討（§11）。
- 人気ページのタイトル取得：`analytics-page-map.json` 方式かパスのみか決定（§8.1・既定は前者）。
- `ANALYTICS_COOKIE_SECRET` の払い出し。
- 海外提供時の同意/地域別停止の要否（§9）。
- 数値は**参考値**（bot・スパムを完全除去できない）という前提の合意。
