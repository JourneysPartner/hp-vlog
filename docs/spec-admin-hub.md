# 仕様書・設計書：管理画面の統合ハブ化（共通ナビ）

最終更新: 2026-07-16 / ステータス: ドラフト（実装前レビュー用・codex 実装向け）

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

- 「HP設定」は**リンク無効（`aria-disabled` ＋ 淡色 ＋「準備中」バッジ）**で表示。中身は本仕様では作らない。
  将来ページができたら `disabled` を外すだけにする。

### 4.2 `/admin` ルート（入口の一本化）
- `netlify.toml` に `from = "/admin"` → **`/admin/articles` へ 301/302 リダイレクト**を追加（MVP）。
  - 代替（将来）：軽量ダッシュボード `admin-hub-page.js`（各画面カード＋最近の状態サマリ）を `/admin` に置く。
    MVP はリダイレクトで十分とし、ダッシュボードは Phase 2。

### 4.3 差し込み位置（各ページ共通の適用ルール）
- 各ページの `<header>`（`.admin-header` または `.head`）**直後**に `renderAdminNav('<key>')` を挿入する。
  ヘッダの見た目は既存のまま変えない（ナビは独立バーとして下に追加）。
- 各ページで渡す `current` は自ページの key（articles/candidates/analytics）。

### 4.4 スタイル整合の方針
- **本仕様ではスタイル統一（方言A→B寄せ等）は行わない**（差分最小・リスク回避）。ナビだけを両対応にする。
- 将来的に各ページの重複 CSS を共有化する場合は別 Issue（`lib/admin-styles.js` 化）として切り出す（任意・Phase 2）。

## 5. 画面仕様（共通ナビ）

- 位置：ヘッダ直下の横並びバー。左からナビ項目、アクティブ項目を塗り（navy 背景/白文字）でハイライト。
- 無効項目（HP設定）：淡色＋カーソル `not-allowed`＋「準備中」小バッジ。クリック不可（`href` を張らない）。
- レスポンシブ：狭幅では横スクロール（`overflow-x:auto`・`white-space:nowrap`）で崩さない。
- アクセシビリティ：`<nav aria-label="管理メニュー">`、アクティブに `aria-current="page"`、無効に `aria-disabled="true"`。
- アイコン：絵文字（CDN不要）。将来インライン SVG に差し替え可。

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
- **変更**：
  - `netlify/functions/admin-articles-page.js`：`require` してヘッダ直後に `renderAdminNav('articles')` 挿入。
  - `netlify/functions/admin-candidates-page.js`：同上 `renderAdminNav('candidates')`。
  - `netlify/functions/admin-analytics-page.js`：同上 `renderAdminNav('analytics')`（**解析ブランチ側に適用**・§8）。
  - `netlify.toml`：`/admin` → `/admin/articles` リダイレクトを追加。
- **テスト**：`scripts/lib/__tests__/test-admin-nav.js`（新規・§9）。

## 7. テスト計画

- `renderAdminNav('articles')` が:
  - 4 項目すべてを含む（記事/候補/アクセス解析/HP設定）。
  - `articles` のみ**アクティブ**（`aria-current="page"`）で、他は非アクティブ。
  - `settings` は**無効**（`aria-disabled="true"`・`href` 無し・「準備中」表記）。
  - 各有効項目の `href` が正しい（`/admin/articles`・`/admin/candidates`・`/admin/analytics`）。
  - 出力に外部 CDN 参照（`cdn.jsdelivr`・`http`）を含まない（自己完結）。
- 各ページ Function の出力にナビ HTML（`mzadmin-nav`）が 1 回だけ含まれ、認証（`requireBasicAuth`）が先に効く。
- 既存テスト回帰：`test-admin.js` ほか全 PASS。

## 8. 実装順序・マージ調整（重要）

アクセス解析系が**未コミット**のため、衝突回避のため次の順で進める:
1. **先に解析ブランチを確定**（`admin-analytics-page.js` 等をコミット/PR 化）。
2. その後 or 併せて **`lib/admin-nav.js` を追加**し、記事・候補・解析の 3 ページへ適用。
   - 解析ページへの適用は解析ブランチ上で行う（同一ファイルを二重編集しない）。
3. `netlify.toml` の `/admin` リダイレクトを追加（解析の redirect 追加と同じ差分に載せると衝突しにくい）。

## 9. 段階リリース

- **Phase 1（本仕様・MVP）**：`lib/admin-nav.js` 共通ナビ＋3ページ適用＋`/admin` リダイレクト。HP設定は準備中表示。
- **Phase 2（任意）**：`/admin` 軽量ダッシュボード（各画面カード＋状態サマリ）、各ページ重複 CSS の共通化、
  「HP設定」ページ本体（トップの新着表示・固定ページ・サイト設定 等）の新規開発。

## 10. 未決事項

- 「HP設定」で実際に何を管理するか（トップの新着表示／固定ページ本文／サイト設定 など）。Phase 2 で要件定義。
- `/admin` はリダイレクト（MVP）か、ダッシュボード新設（Phase 2）か。
- 各ページのスタイル方言（A/B）を将来統一するか（本仕様では統一しない）。
- `/review`（個別記事レビュー）をハブナビに含めるか（既定は非対象。任意で「記事管理へ戻る」リンクのみ検討）。
