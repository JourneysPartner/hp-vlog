# 仕様書・設計書：訪問者計測（自前アナリティクス）

最終更新: 2026-07-14 / ステータス: ドラフト（実装前レビュー v2・レビュー反映）

> v2 反映：daily の同時更新欠落を **CAS（ETag/onlyIfMatch）＋onlyIfNew を MVP 必須**に格上げ／
> `/track` 濫用対策を具体化（Origin・Sec-Fetch-Site・本文サイズ・PV上限・本番ホスト限定）／
> Cookie を **署名付き**に／プライバシー文言を「個人関連情報」前提に強化・参照元(r)は Phase1 で送らない／
> コスト前提を「実プラン要確認」に修正／人気ページのタイトル取得を `analytics-page-map.json` で定義／
> ローテを専用 Scheduled Function に分離／テスト計画を追加／断定表現を是正。

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
| `daily/<YYYY-MM-DD>` | `{ date, pageviews, visitors, byPath: { "<path>": pv } }` | 日次集計（表示の主データ） | **強整合読み取り＋ETag CAS（§6.5）** |
| `uniq/<YYYY-MM-DD>/<vidHash>` | `"1"`（マーカー） | その日そのブラウザが訪問済みか | **onlyIfNew（原子的作成・§6.4）** |

- `vidHash` = 署名付き Cookie `mz_vid` の**ID 部分**を SHA-256 でハッシュした先頭 16 桁。**IP は保存しない**。

### 4.1 整合性（重大・MVP 必須）
- Netlify Blobs は**既定で結果整合性**であり、同一キーの同時更新は **last-write-wins**。
  素朴な read-modify-write（RMW）では、**低トラフィックでも同時アクセスで PV・訪問者が欠落する**。
- したがって MVP から次を必須とする：
  - `daily/<date>` の更新は **強整合読み取り（`{ consistency: 'strong' }`）で ETag を取得 →
    `setJSON(..., { onlyIfMatch: etag })` で条件付き書き込み → 競合（未更新）ならリトライ**（CAS）。
  - ユニークマーカーは **`set(uniqKey, "1", { onlyIfNew: true })` で原子的に作成**し、
    「初回作成できたか（modified）」で visitors を増やすか判定する（二重計上を防ぐ）。

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

### 6.1 受信検証（濫用対策・重大）
`/track` は公開エンドポイントのため、次を**すべて満たさない要求は記録しない**（204で無視）：
- **Origin / Referer が本番ホスト**（`mori-zeirishi.net`）であること。
- **`Sec-Fetch-Site` が `same-origin`（または `same-site`）**であること（クロスサイトからの直POSTを弾く）。
- **User-Agent 必須**、既知クローラ（`bot|crawl|spider|slurp|preview|lighthouse|headless|monitor` 等）は除外。
- **実際に読み込んだ本文サイズの上限**（例：1KB）を超えたら破棄（Content-Length 申告だけに頼らない）。
- パスは**許可プレフィックス（`/`, `/blog/`, 既知の固定ページ）**のみ計上。クエリ除去・末尾スラッシュ統一・長さ制限。

### 6.2 レート制限（数値汚染の緩和）
- **1 Cookie・1 パス・1 分あたりの PV 上限**（例：同一 `vidHash`×同一パスは 1 分に 1PV まで）。上限超過分は無視。
- Netlify 側の **レート制限（Edge/Functions のリクエスト制限）**も併用する前提で設計（設定は実装時に確認）。
- **完全防止は不可能**であり、数値は**「参考値」**として扱う（管理画面にも明記・§8）。

### 6.3 Cookie（改ざん耐性）
- 属性：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`（1年）。
- 値：`"<ランダムID>.<HMAC-SHA256(ID, 秘密鍵)>"` の**署名付き**。秘密鍵は環境変数（例 `ANALYTICS_COOKIE_SECRET`）。
- 受信時に**署名を検証**し、不正・欠落なら**新規発行**して当該リクエストは新規訪問者として扱う（改ざんCookieを信用しない）。
- `HttpOnly` によりクライアント JS からは読めない（ID 生成・付与はすべてサーバー側）。

### 6.4 ユニーク判定（原子的）
1. `vidHash` を算出。
2. `set('uniq/<date>/<vidHash>', "1", { onlyIfNew: true })` を実行。
3. **作成できた（初回）場合のみ** `visitors += 1` の対象とする（§6.5 の CAS 内で加算）。

### 6.5 PV / 集計（CAS）
1. `daily/<date>` を **強整合読み取り**（無ければ初期値）。ETag を保持。
2. メモリ上で `pageviews += 1`、`byPath[path] += 1`、（§6.4 が初回なら）`visitors += 1`。
3. `setJSON('daily/<date>', v, { onlyIfMatch: etag })`。**未更新なら 1 から再試行**（最大 N 回、指数バックオフ）。
4. N 回失敗時は記録を諦め 204（サイト表示に影響させない）。件数増で頻発するなら §11 の移行。

### 6.6 ローテはここで行わない
- 初回アクセスの重さ・削除競合を避けるため、`uniq/*` の削除は **`/track` 内で行わない**（§7 の専用 Function）。

### 6.7 本番ホスト限定（Blobs 混入防止）
- Blobs はサイト全体（本番・各 Deploy Preview）で**共有**される。ビーコン側の除外だけでなく、
  **Function 側でも本番ホスト以外（プレビュー/ブランチデプロイ）からの記録を破棄**する。

## 7. 集計・データ保持（ローテーションは専用 Function）

- `daily/<date>`：**無期限保持**（1日1レコード・軽量）。
- `uniq/<date>/*`：**90 日でローテ削除**。既存の Scheduled Function 運用に合わせ、
  **専用の日次/月次クリーンアップ Function（`analytics-cleanup`）**で古い日付分を削除する
  （`/track` では実施しない）。
- 人気ページ Top は `daily.byPath` を期間合算して算出（表示時に計算）。

## 8. 管理画面仕様：`/admin/analytics`

- 認証：既存の `requireBasicAuth(event)`（`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS`）を必須。
- 応答は **`Cache-Control: no-store`**（画面・API とも）。
- 構成：`admin-analytics-page`（HTML）＋ `admin-list-analytics`（API・`?days=30` 等で日次集計を返す）。
- 表示要素：
  1. サマリー：**今日／昨日／直近7日／直近30日** の「ユニーク訪問者」と「PV」。
  2. 日次グラフ（自前の軽量インライン SVG。外部CDN禁止方針に合わせる）。期間切替 7 / 30 / 90 日。
  3. **人気ページ Top 10**：期間内 PV 上位。**パス→記事タイトルの変換**は §8.1。
  4. 注記：「数値はブラウザ単位の日次ユニークによる**参考値**（bot・スパムを完全には除去できない）」。

### 8.1 パス→タイトルの取得（人気ページ）
- `daily.byPath` は**パスしか持たない**。タイトル変換方法を Phase 1 で確定する：
  - **採用案**：`build.js` がビルド時に **`analytics-page-map.json`（`{ "/blog/xxx/": "記事タイトル", ... }`）**
    を出力し、管理画面（API）がこれを読んでタイトル表示・記事リンク化する。
  - 代替：Phase 1 は**パスのみ表示**（マップ導入は後回し）。
- どちらにするかはレビューで決定（既定は `analytics-page-map.json` 方式）。

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
- ポリシー追記文例：
  > 当サイトでは、サイトの利用状況の把握・改善のため、Cookie（名称: mz_vid／保持期間: 1年）を
  > 用いて訪問者数・ページ閲覧数を集計しています。集計は当サイトのホスティング事業者
  > （Netlify）上で行い、IP アドレスは保存しません。ブラウザの設定で Cookie を無効化できます。

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
  - `netlify/functions/analytics-cleanup.js`（Scheduled・uniq ローテ削除）
  - `netlify/functions/lib/analytics-store.js`（Blobs I/O・CAS・onlyIfNew・bot 判定・パス正規化・ハッシュ・署名検証）
- 変更：
  - `netlify.toml`：`/track`→track-visit、`/admin/analytics`→admin-analytics-page、
    `/admin/api/analytics`→admin-list-analytics の redirect、`analytics-cleanup` の schedule を追加。
  - `scripts/build.js`：ビーコン注入（各HTML1回）＋ **`analytics-page-map.json` 出力**。
- テスト：`scripts/lib/__tests__/test-analytics-store.js` ほか（§14）。

## 14. テスト計画

- **整合性**：`daily` に対し**同時 20 リクエストで PV/UU が欠落しない**（CAS リトライで合算が一致）。
- **ユニーク**：`onlyIfNew` で同一 `vidHash`×同日は **visitors が一度だけ増える**（二重計上しない）。
- **ホスト限定**：**本番以外のホスト（プレビュー）からは記録しない**。
- **改ざん**：**不正 Cookie・署名不正を拒否**（新規発行扱い、既存カウントを汚さない）。
- **キャッシュ**：管理画面 / API 応答が **`no-store`**。
- **ビーコン**：`build` 後、**各生成 HTML にビーコンが 1 回だけ**入る（`/admin`・`/review` には入らない）。
- **bot / パス正規化 / JST 日付境界 / レート上限**の単体。
- 既存回帰：`scripts/lib/__tests__/test-*.js` 全 PASS、`npm run build` 成功。

## 15. 段階リリース

- **Phase 1（MVP・本仕様）**：訪問者・PV・人気ページ Top・直近30日グラフ・管理画面表示（CAS・濫用対策込み）。
- **Phase 2（任意）**：参照元（referrer）集計（同意/最小化を再検討）、期間比較（前週比）、
  CSV エクスポート、Chatwork へ「昨日の訪問者数」日次通知。

## 16. 未決事項・実装前チェック

- クロスデバイス同定は不可（§2）。Cookie 単位・日次ユニークの定義で合意が前提。
- **Netlify の実契約プランを確認**し、コスト見積もりを更新（§10）。
- **Netlify Blobs の有効化**確認、`consistency: 'strong'` / `onlyIfMatch` / `onlyIfNew` の
  対応をランタイムで確認（実装時）。
- 人気ページのタイトル取得：`analytics-page-map.json` 方式かパスのみか決定（§8.1・既定は前者）。
- `ANALYTICS_COOKIE_SECRET` の払い出し。
- 海外提供時の同意/地域別停止の要否（§9）。
- 数値は**参考値**（bot・スパムを完全除去できない）という前提の合意。
