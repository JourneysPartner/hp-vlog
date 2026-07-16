# 仕様書・設計書：管理画面の統合ハブ化（共通ナビ）

最終更新: 2026-07-16 / ステータス: ドラフト（実装前レビュー v2・レビュー反映・codex 実装向け）

> v2 反映：`/admin` の**認証境界を厳密化**（単純リダイレクトでは /admin 自体が Basic 認証されないため
> `admin-home` Function で `requireBasicAuth` → 302 とする）／**`/admin` と `/admin/`・クエリ付き**の
> 正規化と catch-all 404 非落下を受入条件に追加／候補管理の **sticky（`--header-h`/`--stack-h`）連動**要件を明記／
> ナビの**アクセシビリティ**（`aria-current`・無効項目は span/`button disabled`・絵文字 `aria-hidden`）を厳密化／
> **「scoped CSS」の定義**を明文化（`.admin-nav` 配下のみ・`body`/`:root`/汎用タグ/Bootstrap クラスを触らない）／
> **テスト計画を具体化**。

## 1. 目的・背景

現在、管理系の画面は**それぞれ独立した Netlify Function** として存在し、
**相互のリンク（共通ナビ）が無い**ため、管理者は各 URL を直接叩かないと辿れない。

これを **1 つの入口から全管理画面を辿れる「統合ハブ」** にする。具体的には
`/admin/articles`（記事管理画面）を基点に、**共通ナビ（記事／候補／解析／HP設定…）** を
全管理ページ共通で表示し、バラバラな独立ページを束ねる。

- **スコープ**：既存ページを束ねる「共通ナビの追加」が本仕様の主目的（＝ハブ化）。
- **非スコープ**：各ページの機能追加・「HP設定」ページ本体の新規開発は本仕様では作らない
  （ナビ項目としてのプレースホルダのみ用意。中身は将来フェーズ）。

## 2. 現状の棚卸し（対象ページ）

すべて **HTTP Basic 認証**（`netlify/functions/lib/admin-auth.js` の `requireBasicAuth(event)`）付き。
各 Function が**完結した HTML 文字列を返す**（インライン `<style>`）。

| 画面 | URL | Function | API | スタイル方言 |
|---|---|---|---|---|
| 記事管理画面（ハブ基点） | `/admin/articles` | `admin-articles-page.js` | `/admin/api/list`・`/admin/api/change` | **A: Bootstrap系** |
| 候補管理（質疑応答事例） | `/admin/candidates` | `admin-candidates-page.js` | `/admin/api/candidates/list`・`/save` | **A: Bootstrap系** |
| アクセス解析 | `/admin/analytics` | `admin-analytics-page.js` | `/admin/api/analytics` | **B: 自己完結（CDN非依存）** |
| （参考）記事レビュー | `/review` | `review-page.js` ほか | — | 個別記事用・Chatwork導線 |

### 2.1 現状の課題
1. **相互ナビが無い**：各ページに他ページへのリンクが無く、`/admin` トップ（index）も無い。
2. **スタイルが 2 方言**：
   - **方言A**（記事・候補）：`Bootstrap 5.3.2 + Bootstrap Icons + Noto Sans JP` を CDN 読込。
     配色 `--primary:#0B2045 / --accent:#E85320`、ヘッダ `.admin-header`。CSS は**各 Function に重複**。
   - **方言B**（解析）：**外部 CDN 非依存**の自己完結インライン CSS。配色 `--navy:#0b2045 / --orange:#e85320`、
     ヘッダ `.head`。アクセス解析の設計方針（CSP・自己完結）に沿う。
3. **アクセス解析系が未コミット**：`admin-analytics-page.js`・`admin-list-analytics.js`・
   `analytics-cleanup.js`・`lib/analytics-store.js`・`track-visit.js` と `netlify.toml` の変更が
   **作業ツリーに未コミットで存在**（並行実装中）。ハブ化はこれと**マージ順の調整が必要**（§8）。

## 3. 要件

### 機能要件
- 全管理ページ（記事・候補・解析）の上部に**共通ナビ**を表示し、相互に 1 クリックで移動できる。
- ナビ項目：**記事管理 / 候補管理 / アクセス解析 / HP設定（将来・準備中）**。
- **現在表示中のページをアクティブ表示**（ハイライト）する。
- `/admin`（ルート）にアクセスしたら管理画面に入れる（既定は `/admin/articles` へ）。

### 非機能要件
- 認証：既存の `requireBasicAuth` を**全ページ・全 API で維持**（ナビ追加で認証要件を変えない）。
- レスポンシブ：スマホ幅でも崩れない（横スクロール可 or 折返し）。
- `noindex,nofollow`（管理画面は非公開）。API/ページは `Cache-Control: no-store` を推奨。
- **方言A・B の両方に破綻なく載る**こと（ナビは外部 CDN に依存しない自己完結実装にする）。
- 既存の各ページの機能・レイアウトを壊さない（ナビはヘッダ直後に差し込むだけ）。

## 4. 設計方針

### 4.1 共通ナビは「自己完結コンポーネント」を共有ライブラリ化（推奨）
- 新規 `netlify/functions/lib/admin-nav.js` を追加し、**ナビの HTML と scoped CSS を 1 箇所で生成**する。
  各ページ Function はこれを `require` してヘッダ直後に差し込む（DRY・単一ソース）。
- **外部 CDN（Bootstrap/Icons）に依存しない**：ナビ自身が `<style>` を内包し、アイコンは
  **絵文字またはインライン SVG** を使う（方言B＝解析ページでも Bootstrap が無いため）。
- 配色はハブ共通のブランド色（navy `#0b2045` / orange `#e85320`）をナビ内で自前定義。
- CSS は独自クラス接頭辞（例 `.mzadmin-nav`）で**スコープ**し、各ページの既存 CSS と衝突させない。

```js
// lib/admin-nav.js（インターフェイス案）
// current: 'articles' | 'candidates' | 'analytics' | 'settings'
function renderAdminNav(current) { /* return HTML文字列（<style>内包） */ }
module.exports = { renderAdminNav, ADMIN_NAV_ITEMS };
```

- ナビ項目定義（単一ソース）:

| key | ラベル | href | アイコン | 状態 |
|---|---|---|---|---|
| `articles` | 記事管理 | `/admin/articles` | 📝 | 有効 |
| `candidates` | 候補管理 | `/admin/candidates` | 💬 | 有効 |
| `analytics` | アクセス解析 | `/admin/analytics` | 📊 | 有効（解析マージ後） |
| `settings` | HP設定 | `/admin/settings` | ⚙️ | **準備中（disabled・将来）** |

- 「HP設定」は**リンクにしない**（中身が無いため）。**`<span>` または `<button disabled>`** で表示し、
  淡色＋「準備中」バッジ＋`aria-disabled="true"`。`href` は張らない。将来ページができたら要素を `<a>` に差し替える。

### 4.2 `/admin` ルート（入口の一本化）と**認証境界**
- **認証境界を厳密に守る**：`netlify.toml` の**単純リダイレクトでは `/admin` 自体は Basic 認証されない**
  （リダイレクト応答は認証前に返る）。認証必須の方針を守るため、**`admin-home` Function を新設**し、
  **`requireBasicAuth(event)` を通過してから `/admin/articles` へ 302** を返す。
  ```
  /admin  → admin-home Function
             1) requireBasicAuth(event)（失敗なら 401 をそのまま返す）
             2) 認証OK → 302 Location: /admin/articles
  ```
- **`/admin` と `/admin/`・クエリ付き**の両方を受ける（**正規化**）：
  - `/admin`・`/admin/`（末尾スラッシュ）・`/admin?foo=bar` のいずれも `admin-home` に到達させ、
    **catch-all 404 に落とさない**（受入条件・§7 でテスト）。
  - `netlify.toml` の redirect は `from = "/admin"` と `from = "/admin/"` の**両方**を Function に向ける
    （必要なら `/admin/*` のうちハブ対象外に誤マッチしないよう、既存の `/admin/articles` 等より**後**に
    ならない順序で明示。既存の個別ルートを壊さないこと）。
  - 302 の Location は絶対パス `/admin/articles`。クエリは基本的に引き継がない（管理トップに用途が無いため）。
  - 代替（将来）：軽量ダッシュボード `admin-hub-page.js`（各画面カード＋最近の状態サマリ）を `/admin` に置く。
    その場合も `requireBasicAuth` を先頭で必須にする。MVP はリダイレクトで十分・ダッシュボードは Phase 2。

### 4.3 差し込み位置と**固定/非固定の方針**（sticky 連動）
- 各ページの `<header>`（`.admin-header` または `.head`）**直後**に `renderAdminNav('<key>')` を挿入する。
  ヘッダの見た目は既存のまま変えない（ナビは独立バーとして下に追加）。渡す `current` は自ページの key。
- **既定：ナビは固定しない（非 sticky）**。ページ先頭でのみ表示し、スクロール時は一緒に流れる。
  → これにより既存の sticky レイアウト（特に候補管理）の座標計算に**影響を与えない**。実装ぶれ防止のため
  「ナビは非固定」を既定として明記する。
- **候補管理（`admin-candidates-page.js`）の sticky 連動（重要）**：
  同ページは `--header-h: 48px`／`--filter-h: 48px`／`--stack-h: 96px`（= header + filter）を CSS 変数で持ち、
  `.admin-header`（`top:0`）→ フィルタバー（`top: var(--header-h)`）→ 表ヘッダ `th`（`top: var(--stack-h)`）が
  連動している。
  - **ナビを非固定にする場合（既定）**：これらの変数は**変更不要**。ナビはヘッダ直後・非 sticky で置くだけ。
  - **ナビを固定表示にしたい場合（任意）**：`.admin-header` の下にナビを sticky で重ねる分、
    **`--header-h` を「ヘッダ高＋ナビ高」に、`--stack-h` を `header-h + filter-h + ナビ高` に更新**しないと、
    フィルタバー・表ヘッダの sticky 位置がナビと重なる。固定を選ぶ場合はこの変数更新を受入条件に含める。
  - MVP は**非固定を採用**（変数を触らない＝最小差分・最小リスク）。固定は Phase 2 で検討。

### 4.4 スタイル整合の方針
- **本仕様ではスタイル統一（方言A→B寄せ等）は行わない**（差分最小・リスク回避）。ナビだけを両対応にする。
- 将来的に各ページの重複 CSS を共有化する場合は別 Issue（`lib/admin-styles.js` 化）として切り出す（任意・Phase 2）。

### 4.5 「scoped CSS」の定義（厳守）
ナビが内包する `<style>` は、**`.admin-nav` 配下のセレクタだけ**を対象にする。次を**変更してはならない**：
- `body` / `html` / `:root`（CSS 変数の再定義を含む。特に候補管理の `--header-h`/`--stack-h`、
  解析の `--navy`/`--orange` 等に触れない）。
- `a` / `button` / `ul` / `nav` などの**汎用タグセレクタ**（`.admin-nav` で必ず限定する。例 `.admin-nav a { … }`）。
- **Bootstrap の既存クラス**（`.btn`・`.container`・`.badge` 等）や各ページ独自クラス。
- 目的：**方言A（Bootstrap）でも方言B（アクセス解析の完全自己完結 CSS）でも副作用ゼロ**で載ること。
  アクセス解析画面は外部 CDN 非依存の自己完結 CSS のため、グローバル汚染は特に厳禁。

## 5. 画面仕様（共通ナビ）

- 位置：ヘッダ直下の横並びバー（**非固定**・§4.3）。アクティブ項目を塗り（navy 背景/白文字）でハイライト。
- 無効項目（HP設定）：淡色＋カーソル `not-allowed`＋「準備中」小バッジ。**リンクにせず** `<span>`/`<button disabled>`。
- レスポンシブ：狭幅では横スクロール（`overflow-x:auto`・`white-space:nowrap`）で崩さない。
- **アクセシビリティ（厳守）**：
  - コンテナは `<nav aria-label="管理メニュー">`。
  - 有効な現在地の項目に **`aria-current="page"`**（active スタイルと一致）。
  - 準備中項目は**リンクにしない**：`<span aria-disabled="true">` または `<button type="button" disabled>`。
  - **絵文字アイコンは `aria-hidden="true"`**（装飾）とし、**ラベル本文（記事管理 等）は必ずテキストで残す**
    （アイコンだけにしない）。
- アイコン：絵文字（CDN不要・`aria-hidden`）。将来インライン SVG に差し替え可。

### ワイヤー（イメージ）
```
┌ 記事管理画面（既存ヘッダ）──────────────────────┐
├ [📝 記事管理] [💬 候補管理] [📊 アクセス解析] [⚙️ HP設定(準備中)] │ ← 共通ナビ（アクティブ=記事管理）
├ 全て | 公開済み | 予約中 | レビュー待ち | …（既存フィルタタブ）        │
│ （既存の一覧・操作 UI はそのまま）                                 │
└──────────────────────────────────┘
```

## 6. 実装対象ファイル

- **新規**：`netlify/functions/lib/admin-nav.js`（`renderAdminNav`・`ADMIN_NAV_ITEMS`）。
- **新規**：`netlify/functions/admin-home.js`（`/admin` の入口。`requireBasicAuth` → 302 `/admin/articles`・§4.2）。
- **変更**：
  - `netlify/functions/admin-articles-page.js`：`require` してヘッダ直後に `renderAdminNav('articles')` 挿入。
  - `netlify/functions/admin-candidates-page.js`：同上 `renderAdminNav('candidates')`。
  - `netlify/functions/admin-analytics-page.js`：同上 `renderAdminNav('analytics')`（**解析ブランチ側に適用**・§8）。
  - `netlify.toml`：`from = "/admin"` と `from = "/admin/"` を **`admin-home`** に向ける redirect を追加
    （`/admin/articles` 等の既存個別ルートを壊さない順序で）。
- **テスト**：`scripts/lib/__tests__/test-admin-nav.js`（新規・§7）。

## 7. テスト計画（具体化）

既存 `scripts/lib/__tests__/test-admin.js` は**記事画面中心**。以下を追加対象にする。

### 7.1 `renderAdminNav(key)`（単体・`test-admin-nav.js`）
- 4 項目すべてを含む（記事/候補/アクセス解析/HP設定）。
- 指定 key（例 `articles`）**のみ** `aria-current="page"`＝アクティブ、他は非アクティブ。
- `settings` は**リンクでない**（`<a href` を持たない）＝ `aria-disabled="true"`＋「準備中」表記。
- 各有効項目の `href` が正しい（`/admin/articles`・`/admin/candidates`・`/admin/analytics`）。
- **CDN URL を含まない**（`cdn.jsdelivr`・`http://`・`https://` の外部参照が出力に無い＝自己完結）。
- 絵文字に `aria-hidden="true"` が付き、各項目に**テキストラベル**が残る。
- `<nav aria-label="管理メニュー">` を含む。

### 7.2 各ページへの適用（単体）
- 記事／候補／解析の各 Function 出力に、ナビ（`.admin-nav`）が **ちょうど 1 つ**含まれる。
- ナビの `<style>` が **`.admin-nav` 配下のみ**（`body`/`:root`/`.btn` 等のグローバルセレクタを含まない）。
- 認証：`requireBasicAuth` が**先に評価**される（未認証は 401、ナビ HTML を返さない）。

### 7.3 `/admin` 入口（`admin-home`）
- 未認証：`/admin`・`/admin/` ともに **401**（`WWW-Authenticate` 付き）。
- 認証済み：`/admin`・`/admin/`・`/admin?foo=bar` すべて **302 Location `/admin/articles`**。
- **catch-all 404 に落ちない**（`/admin`・`/admin/` が確実に Function に到達する）ことを確認。

### 7.4 目視（手動・Deploy Preview）
- **モバイル幅**でナビが横スクロールで崩れない。
- **候補管理の sticky 表ヘッダ**がナビ追加後もズレない（非固定方針＝§4.3 の変数不変更を確認）。

### 7.5 回帰
- `test-admin.js` ほか全 PASS、`npm run build` 成功。

## 8. 実装順序・マージ調整（重要）

アクセス解析系が**未コミットの並行差分**（`admin-analytics-page.js`・`admin-list-analytics.js`・
`netlify.toml` ほか）として存在する。特に **`netlify.toml` は `/admin` の追加と競合**するため、
**アクセス解析を先に確定してからハブ化**するのが安全。次の順で進める:
1. **先に解析ブランチを確定**（`admin-analytics-page.js`・`admin-list-analytics.js`・`analytics-cleanup.js`・
   `lib/analytics-store.js`・`track-visit.js` と `netlify.toml` の解析 redirect をコミット/PR 化・マージ）。
2. その後 **`lib/admin-nav.js` と `admin-home.js` を追加**し、記事・候補・解析の 3 ページへナビ適用。
   - 解析ページへの適用は解析確定後に行う（同一ファイル `admin-analytics-page.js` を二重編集しない）。
3. `netlify.toml` の `/admin`・`/admin/` → `admin-home` redirect を追加（**解析の `netlify.toml` 差分が
   main に入った後**に追記して競合を避ける）。既存の `/admin/articles` 等の個別ルートは順序・内容とも変更しない。

## 9. 段階リリース

- **Phase 1（本仕様・MVP）**：`lib/admin-nav.js` 共通ナビ＋3ページ適用＋`/admin` リダイレクト。HP設定は準備中表示。
- **Phase 2（任意）**：`/admin` 軽量ダッシュボード（各画面カード＋状態サマリ）、各ページ重複 CSS の共通化、
  「HP設定」ページ本体（トップの新着表示・固定ページ・サイト設定 等）の新規開発。

## 10. 未決事項

- 「HP設定」で実際に何を管理するか（トップの新着表示／固定ページ本文／サイト設定 など）。Phase 2 で要件定義。
- `/admin` はリダイレクト（MVP）か、ダッシュボード新設（Phase 2）か。
- 各ページのスタイル方言（A/B）を将来統一するか（本仕様では統一しない）。
- `/review`（個別記事レビュー）をハブナビに含めるか（既定は非対象。任意で「記事管理へ戻る」リンクのみ検討）。
