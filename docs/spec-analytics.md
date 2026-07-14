# 仕様書・設計書：訪問者計測（自前アナリティクス）

最終更新: 2026-07-14 / ステータス: ドラフト（実装前レビュー用）

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
- **サイト全ページ**（トップ・固定ページ・ブログ記事すべて）

## 2. 「訪問者数」の定義とクロスデバイスの扱い（重要）

要望は「**別端末でも同一人なら同一カウント**」だが、**匿名の公開サイトでは、別端末
（スマホ／PC 等）の訪問者を"同じ人"と確実に判定することは技術的に不可能**である。
個人を紐づける手段（ログイン等）が無いため。これは Google Analytics 等でも同じで、
真のクロスデバイス同定には次のいずれかが必要になる：

| 手段 | 可否 | 備考 |
|---|---|---|
| ログイン（User-ID） | ○だが不適用 | マーケティングサイトに会員ログインは無い |
| Google シグナル（GA4） | △近似のみ | 「Googleアカウントにログイン中＋広告個人化に同意」ユーザーだけを横断。全員は無理・同意必須 |
| フィンガープリンティング | ×非推奨 | 不正確・プライバシー/法令リスク（同意要）・保守困難 |
| Cookie（1ブラウザ＝1人） | ○採用 | 業界標準の"ユニーク訪問者"。別端末/別ブラウザ/Cookie削除は別人扱い |

### 本仕様での定義（採用）
- **「訪問者」＝ 同一ブラウザ（同一 Cookie `mz_vid`）を同一人とみなし、1 日 1 カウント。**
- 別端末・別ブラウザ・Cookie 削除・シークレットモードは**別人扱い**（この点は限界として明記）。
- これは GA/Plausible/Netlify Analytics すべてと同じ標準的な数え方であり、
  「同一人の重複」をブラウザ単位では確実に排除できる、という意味で要望に最も近い実装。
- **将来オプション**：どうしても近似のクロスデバイスが欲しくなった場合は、GA4（＋Google
  シグナル・同意バナー）を併設して"参考値"として見る道がある。自前方式では対応しない。

## 3. 全体アーキテクチャ

```
[各ページ末尾のビーコンJS] ──navigator.sendBeacon('/track', {path,ref})──▶ track-visit Function
                                                                                │ 記録
                                                                                ▼
                                                                        Netlify Blobs (store: "analytics")
                                                                                ▲
[/admin/analytics 画面 (Basic認証)] ──fetch('/admin/api/analytics')──▶ admin-list-analytics Function ─┘
```

- 収集：全ページに埋めた軽量ビーコンが表示時に `/track` を1回叩く。
- 記録：`track-visit` が bot 判定・ユニーク判定して Netlify Blobs に集計を書く。
- 表示：`/admin/analytics`（Basic 認証）が `admin-list-analytics` から日次データを取得して描画。

## 4. データモデル（Netlify Blobs）

- ストア名：`analytics`
- 日付は **JST**（`Asia/Tokyo`）の `YYYY-MM-DD`。
- キー設計：

| キー | 値（JSON） | 用途 |
|---|---|---|
| `daily/<YYYY-MM-DD>` | `{ date, pageviews, visitors, byPath: { "<path>": pv } }` | 日次集計（表示の主データ） |
| `uniq/<YYYY-MM-DD>/<vidHash>` | `1`（マーカー） | その日そのブラウザが訪問済みか（ユニーク判定用） |

- `vidHash` = Cookie `mz_vid`（ランダム値）を **SHA-256 でハッシュ**した先頭 16 桁。**IP は保存しない**。
- 集計は `daily/<date>` を read-modify-write（RMW）。低トラフィック前提で十分。
  高負荷になった場合の移行案は §11 に記載。

## 5. 収集仕様（ビーコン）

- 注入場所：`templates/*.html` の `</body>` 直前（`build.js` が全ページに展開）。
  管理系（`/admin`, `/review`）と Netlify プレビューURL、localhost では**送信しない**。
- 動作：
  1. `mz_vid` Cookie が無ければランダム値を生成し `Set-Cookie`（有効期限1年・`SameSite=Lax`・`Secure`・個人情報なし）。
     ※ Cookie 発行は `/track` 応答側で行う（クライアントJSはIDを作らない設計にして改ざん耐性を上げる）。
  2. `navigator.sendBeacon('/track', JSON.stringify({ p: location.pathname, r: document.referrer ? new URL(document.referrer).hostname : '' }))` を1回送信。
  3. `sendBeacon` 非対応時は `fetch('/track', {keepalive:true})` にフォールバック。
- 送信内容：`p`（パス）・`r`（参照元ホスト名のみ、任意）。**本文・個人情報は送らない**。
- 尊重：`navigator.doNotTrack === '1'` の場合は送信しない（任意・既定ON）。

## 6. 記録 API：`track-visit`（ルート `/track`）

- メソッド：POST（sendBeacon）。GET は 204 で無視。
- 処理：
  1. **Bot 判定**：User-Agent が既知クローラ（`bot|crawl|spider|slurp|preview|lighthouse|headless` 等）なら記録せず 204。
  2. Cookie `mz_vid` を読む。無ければ生成し `Set-Cookie`。`vidHash` を算出。
  3. パス正規化（クエリ除去・末尾スラッシュ統一・長さ制限・許可プレフィックスのみ）。`/admin`・`/review` は無視。
  4. JST 日付を決定。
  5. `daily/<date>` を取得（無ければ初期化）→ `pageviews++`、`byPath[path]++`。
  6. `uniq/<date>/<vidHash>` が無ければ `visitors++` し、マーカーを作成。
  7. `daily/<date>` を保存。204 を返す。
- レスポンス：204 No Content（＋必要時 `Set-Cookie`）。本文なし。
- エラー時：握りつぶして 204（計測失敗でサイト表示に影響させない）。
- 濫用対策（§12）：軽い検証（Content-Length 上限・パス許可リスト・UA必須）。

## 7. 集計・データ保持（ローテーション）

- `daily/<date>`：**無期限保持**（1日1レコード・軽量）。
- `uniq/<date>/*`：**90 日でローテ削除**（Blobs 節約）。日次または `track-visit` 内で
  古い日付分を遅延削除、あるいは月次バッチ（GitHub Actions）で掃除。
- 人気ページ Top は `daily.byPath` を期間合算して算出（表示時に計算）。

## 8. 管理画面仕様：`/admin/analytics`

- 認証：既存の `requireBasicAuth(event)`（`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS`）を必須。
- 構成：
  - `admin-analytics-page`（HTML を返す。既存 admin ページと同じ枠組み）
  - `admin-list-analytics`（API。`?days=30` 等で直近 N 日の `daily/*` を集計して返す）
- 表示要素：
  1. サマリー数値：**今日／昨日／直近7日／直近30日** の「ユニーク訪問者」と「PV」。
  2. 折れ線／棒グラフ：日次のユニーク訪問者・PV（期間切替 7 / 30 / 90 日）。
  3. **人気ページ Top 10**：期間内 PV 上位（パス→記事タイトルに紐付け表示・記事リンク）。
- グラフ描画：外部CDN禁止方針に合わせ、**依存を増やさず自前の軽量インライン SVG** で描画。
- 画面レイアウト案（ワイヤー）：

```
┌ アクセス解析 ──────────────────────────────┐
│ [今日 12]  [昨日 20]  [7日 90]  [30日 380]   ← ユニーク訪問者 │
│ [今日 34]  [昨日 55]  [7日 260] [30日 1,120] ← PV            │
│ 期間: (7日)(30日)(90日)                                        │
│ ┌ 日次グラフ（訪問者/PV 折れ線）────────────┐ │
│ │      ▁▂▅▇▅▃▂▁ …                            │ │
│ └──────────────────────────────┘ │
│ 人気ページ Top10                                             │
│  1. /blog/xxx  「タイトル」  PV 120                           │
│  2. /          「トップ」    PV 88                            │
│  …                                                           │
└──────────────────────────────────┘
```

## 9. プライバシー・法令対応

- Cookie `mz_vid` は**ランダムIDのみ**で個人を識別しない。**IP は保存しない**（ハッシュ化した Cookie ID のみ）。
- DNT（Do Not Track）を尊重（既定 ON）。
- プライバシーポリシーに一文追記（例）：
  > 当サイトでは、サイトの利用状況を把握するため、匿名の識別子（Cookie）を用いて
  > 訪問者数・ページ閲覧数を集計しています。個人を特定する情報や IP アドレスは
  > 保存していません。ブラウザ設定で Cookie を無効化できます。

## 10. パフォーマンス・コスト

- Netlify Functions 無料枠：月 125,000 呼び出し。1 訪問=1 `/track` 呼び出しなので、
  月間数万 PV 規模までは無料枠内。管理画面の閲覧は微少。
- Netlify Blobs：無料枠あり。日次1レコード＋ユニークマーカー（90日ローテ）で軽量。
- ビーコンは `sendBeacon` で非同期・表示をブロックしない。

## 11. 高負荷時の移行案（将来）

- `daily/<date>` の RMW は同時書き込みで稀に取りこぼす可能性がある（低トラフィックでは無視可）。
- 増えた場合の対策：(a) パス別・訪問者別を個別キーにして集計時に合算（書込競合回避）、
  (b) 外部 KV（Upstash 等）や集計DBへ移行、(c) GA4 併設。MVP では (0) RMW のまま。

## 12. セキュリティ

- `/track` は公開エンドポイント。濫用（数値汚染）対策：
  - UA 必須・Content-Length 上限・パス許可リスト（既知の公開パス接頭辞のみ計上）。
  - bot 除外。過剰連打は同一 `vidHash`＋同日で visitors は増えない（PV は増えるが上限を設ける任意）。
- 管理系はすべて `requireBasicAuth`。`/admin/api/analytics` も認証必須。

## 13. 実装対象ファイル（Phase 1）

- `package.json`：`@netlify/blobs` を追加。
- 新規：
  - `netlify/functions/track-visit.js`（記録）
  - `netlify/functions/admin-analytics-page.js`（画面）
  - `netlify/functions/admin-list-analytics.js`（API）
  - `netlify/functions/lib/analytics-store.js`（Blobs 読み書き・集計・bot 判定・ハッシュ・ローテ）
- 変更：
  - `netlify.toml`：`/track`→track-visit、`/admin/analytics`→admin-analytics-page、`/admin/api/analytics`→admin-list-analytics の redirect 追加。
  - `templates/*.html`（または `scripts/build.js`）：ビーコン注入。
- テスト：`scripts/lib/__tests__/test-analytics-store.js`（集計・ユニーク判定・bot 除外・パス正規化・ローテ）。

## 14. テスト計画

- 単体：`analytics-store` の increment（PV/visitors/byPath）、ユニーク重複排除、bot 判定、パス正規化、日付境界（JST）、ローテ削除。
- 結合（手動）：ローカル or Netlify Deploy Preview でビーコン→`/track`→`/admin/analytics` に反映されること。
- 既存回帰：`scripts/lib/__tests__/test-*.js` 全 PASS、`npm run build` 成功。

## 15. 段階リリース

- **Phase 1（MVP・本仕様）**：訪問者・PV・人気ページ Top・直近30日グラフ・管理画面表示。
- **Phase 2（任意）**：参照元（referrer）集計、期間比較（前週比）、CSV エクスポート、日次通知（Chatwork に「昨日の訪問者数」）。

## 16. 未決事項・リスク

- クロスデバイス同定は不可（§2）。この定義で合意が前提。
- `daily` RMW の同時書き込み取りこぼし（低トラフィックでは実害なし・§11）。
- Netlify Blobs の有効化がサイト設定で必要な場合あり（利用は確認済み）。
- スパム/連打による数値汚染（§12 の対策で緩和。完全防止は不可）。
