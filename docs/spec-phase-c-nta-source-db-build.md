# 仕様書：Phase C 国税庁ソース DB 構築

**ステータス**：仕様確定済（user 承認、実装着手前）
**起票日**：2026-06-21
**確定日**：2026-06-21
**前提**：Phase A+B（PR #196）merge 済
**位置づけ**：Phase D（n-gram 検知）、E（topic-pool 自動抽出）、G（Fact-Check）の前提インフラ

---

## 確定事項（user 承認済）

| # | 項目 | 確定方針 |
|---|---|---|
| 1 | User-Agent の連絡先 URL | `https://mori-zeirishi.net/contact` を使う |
| 2 | 月次更新の運用方式 | **自動 PR 化**（main 直 push ではない）|
| 3 | 初回 crawl のタイミング | **即時実行**（実装完了後すぐ）|
| 4 | 国際課税の質疑応答事例 | **スコープ外**（取得しない）|
| 5 | タックスアンサーと質疑応答事例の役割優先順位 | **タックスアンサー = 基本ルール（要件）検証の主役**、質疑応答事例 = エッジケース・実務具体例の補完。両方保持し、Phase A セクション 7 の役割分担表に従って使い分ける |

---

## 0. 仕様策定にあたり実施した実調査

仕様の前提を実データで固めるため、以下を確認済：

| 確認項目 | 結果 |
|---|---|
| robots.txt | `/taxes/shiraberu/taxanswer/` および `/law/shitsugi/` への crawl 許可 |
| 質疑応答事例トップ index URL | `https://www.nta.go.jp/law/shitsugi/01.htm`（税目別カテゴリ index へのリンク 16 件） |
| 質疑応答事例カテゴリ index 例 | 消費税 `/law/shitsugi/shohi/01.htm`（279 リンク） / 相続 `/law/shitsugi/sozoku/01.htm`（153 リンク） |
| 質疑応答事例の個別ページ URL | `/law/shitsugi/<カテゴリ>/<section_NN>/<id>.htm` |
| 質疑応答事例の文字コード | **Shift_JIS** |
| タックスアンサー index | `https://www.nta.go.jp/taxes/shiraberu/taxanswer/index2.htm` |
| タックスアンサー個別ページ URL | `/taxes/shiraberu/taxanswer/<カテゴリ>/<4桁id>.htm` |
| タックスアンサーの文字コード | **UTF-8** |

---

## 1. スコープと範囲

### 1-1. 取得対象（プラン (b) ベース：税目別に絞る）

#### タックスアンサー
| カテゴリ | URL prefix | id 範囲 | 推定件数 |
|---|---|---|---|
| 消費税 | `/taxes/shiraberu/taxanswer/shohi/` | 6101〜6900 | 約 120 件 |
| 所得税 | `/taxes/shiraberu/taxanswer/shotoku/` | 1100〜2700 | 約 250 件 |
| 源泉所得税 | `/taxes/shiraberu/taxanswer/gensen/` | 2700〜2900 | 約 50 件 |
| 譲渡所得 | `/taxes/shiraberu/taxanswer/joto/` | 3100〜3700 | 約 80 件 |
| 相続税 | `/taxes/shiraberu/taxanswer/sozoku/` | 4101〜4500 | 約 80 件 |
| 贈与税 | `/taxes/shiraberu/taxanswer/sozoku/` | 4401〜4700 | 約 60 件 |
| 法人税 | `/taxes/shiraberu/taxanswer/hojin/` | 5100〜5800 | 約 150 件 |
| **計** | | | **約 790 件** |

#### 質疑応答事例
| カテゴリ | URL prefix | 推定件数 |
|---|---|---|
| 所得税 | `/law/shitsugi/shotoku/` | 約 200 件 |
| 源泉所得税 | `/law/shitsugi/gensen/` | 約 100 件 |
| 譲渡所得 | `/law/shitsugi/joto/` | 約 100 件 |
| 相続税・贈与税 | `/law/shitsugi/sozoku/` | 約 150 件 |
| 財産の評価 | `/law/shitsugi/hyoka/` | 約 150 件 |
| 法人税 | `/law/shitsugi/hojin/` | 約 300 件 |
| 消費税 | `/law/shitsugi/shohi/` | 約 280 件 |
| **計** | | **約 1,280 件** |

#### スコープ外
- 印紙税 / 酒税 / 揮発油税 / 国際課税
- 法定調書（質疑応答事例にあるが書く予定がない）
- 一般のお知らせ・パンフレット・FAQ ページ（Phase 7 で別途検討）

### 1-2. 取得対象の確定方法

「推定件数」は実 crawl 前の推測。**実装初回の crawl 結果で確定**する。実装時に index ページから個別 URL を抽出して件数を確定 → 仕様書を実数で更新。

---

## 2. 保存形式

### 2-1. ファイルレイアウト

```
data/nta-sources/
├── index.json                        # 全エントリのメタデータ一覧（軽量サマリ、retrieval 用）
├── meta.json                          # crawl 全体のメタ（最終実行日時、件数、エラー集計）
├── taxanswer/
│   ├── shohi/
│   │   ├── 6101.json
│   │   ├── 6501.json
│   │   └── ...
│   ├── shotoku/
│   ├── sozoku/
│   ├── gensen/
│   ├── joto/
│   └── hojin/
└── shitsugi/
    ├── shohi/
    │   ├── 01/
    │   │   ├── 01.json
    │   │   └── 02.json
    │   ├── 02/
    │   └── ...
    ├── shotoku/
    ├── gensen/
    ├── joto/
    ├── sozoku/
    ├── hyoka/
    └── hojin/
```

### 2-2. 個別ページの JSON 構造

```json
{
  "id": "6501",
  "type": "taxanswer",
  "tax_category": "消費税",
  "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm",
  "title": "納税義務の免除",
  "body": "（HTML から抽出した本文プレーンテキスト全文）",
  "body_html_simplified": "（最低限の構造を残した簡易 HTML、テーブル等の構造維持用）",
  "law_version": "令和7年4月1日現在法令等",
  "fetched_at": "2026-06-21T10:00:00Z",
  "html_hash": "sha256:abc123...",
  "byte_size": 4523,
  "char_count_body": 3127,
  "keywords": ["納税義務", "免除", "基準期間", "特定期間", "1000万円"]
}
```

質疑応答事例の場合：
```json
{
  "id": "shohi/02/01",
  "type": "shitsugi",
  "tax_category": "消費税",
  "url": "https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm",
  "title": "会社員が行う建物の貸付けの取扱い",
  "shokai_yoshi": "（照会要旨の全文）",
  "kaitou_yoshi": "（回答要旨の全文）",
  "kankei_hourei": "消費税法第2条第1項第8号、消費税法基本通達5-1-1",
  "law_version": "令和7年8月1日現在の法令・通達等に基づいて作成",
  "body_combined": "（照会要旨 + 回答要旨を結合したプレーンテキスト、n-gram 検知用）",
  "fetched_at": "2026-06-21T10:00:00Z",
  "html_hash": "sha256:def456...",
  "byte_size": 5185,
  "char_count_body": 412,
  "keywords": ["会社員", "建物", "貸付け", "課税対象", "事業"]
}
```

### 2-3. index.json の構造

各エントリの metadata だけを保持する軽量インデックス（retrieval 高速化用）：

```json
{
  "version": 1,
  "generated_at": "2026-06-21T10:00:00Z",
  "total_count": 2070,
  "entries": [
    {
      "id": "6501",
      "type": "taxanswer",
      "tax_category": "消費税",
      "title": "納税義務の免除",
      "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm",
      "file_path": "taxanswer/shohi/6501.json",
      "char_count_body": 3127,
      "keywords": ["納税義務", "免除", "基準期間"]
    }
  ]
}
```

### 2-4. meta.json の構造

crawl 全体のメタ情報：

```json
{
  "last_crawl_at": "2026-06-21T10:00:00Z",
  "last_crawl_duration_seconds": 1834,
  "total_entries": 2070,
  "by_type": { "taxanswer": 790, "shitsugi": 1280 },
  "errors_count": 3,
  "errors": [
    { "url": "...", "reason": "404 Not Found" }
  ],
  "next_scheduled_at": "2026-07-01T00:00:00Z"
}
```

### 2-5. 容量見積もり

- 1 ページあたり JSON: 平均 3〜10 KB
- 約 2,070 ページ × 平均 5 KB ≒ **10 MB**
- Git LFS は不要、通常コミットで管理

---

## 3. クロール仕様

### 3-1. スクリプト

`scripts/crawl-nta-sources.js`

```bash
# 全件 crawl（初回 + 月次）
node scripts/crawl-nta-sources.js

# 特定タイプのみ
node scripts/crawl-nta-sources.js --type taxanswer
node scripts/crawl-nta-sources.js --type shitsugi

# 特定カテゴリのみ
node scripts/crawl-nta-sources.js --category shohi

# 差分 crawl（変更分のみ更新）
node scripts/crawl-nta-sources.js --incremental

# パースだけ（API を叩かない、デバッグ用）
node scripts/crawl-nta-sources.js --dry-run

# 詳細ログ
node scripts/crawl-nta-sources.js --verbose
```

### 3-2. 取得手順

1. **インデックス取得**
   - 質疑応答事例：`/law/shitsugi/01.htm` から税目別カテゴリ URL を取得
   - タックスアンサー：`/taxes/shiraberu/taxanswer/index2.htm` から全 ID リストを取得
   - 各カテゴリの目次ページから個別ページの URL を全件抽出

2. **個別ページ取得**
   - rate limit: **1 リクエスト/秒**（国税庁サーバーへの負荷配慮）
   - User-Agent: `MoriZeirishi-Bot/1.0 (https://mori-zeirishi.net)`
   - Timeout: 30 秒
   - リトライ: 失敗時 3 回、指数バックオフ（1s / 2s / 4s）
   - エラーログ: `meta.json` に集計

3. **文字エンコーディング判別**
   - HTTP ヘッダーの `Content-Type` 優先
   - HTML の `<meta charset>` または `<meta http-equiv="Content-Type">` を fallback
   - 国税庁ページは経験上：タックスアンサー = UTF-8、質疑応答事例 = Shift_JIS
   - 文字化け検知（U+FFFD 出現率 > 1%）で異常終了

4. **本文抽出**
   - `<div id="bodyArea">` 内のコンテンツを抽出
   - パンくず、サイドナビ、ページトップへのリンクを除去
   - 質疑応答事例：`【照会要旨】` `【回答要旨】` `【関係法令通達】` をラベルで分割保存
   - タックスアンサー：見出し階層を保持して本文プレーンテキスト化

5. **JSON 生成 + 保存**
   - `data/nta-sources/<type>/<category>/<id>.json` に出力
   - 既存ファイルと `html_hash` が同じなら skip（差分 crawl 時）

6. **index.json + meta.json 更新**
   - 全 JSON 生成後にインデックス再構築
   - meta.json に crawl 実績を記録

### 3-3. 差分検知の仕組み

- 各 JSON に `html_hash` を保持
- 差分 crawl 時は HTTP HEAD で取得した `Last-Modified` または `ETag` で先に粗いフィルタ
- 変更ありの場合のみ本文取得 → hash 比較 → 異なれば更新
- 削除されたページ（404）は JSON に `deleted: true` を立てて保持（過去記事のソース URL 切れを検知できるよう）

### 3-4. レート制限と倫理

- 1 リクエスト/秒（rate limit）
- robots.txt 準拠（`/service_publication/` は対象外）
- User-Agent に連絡先 URL を含める
- crawl 結果は記事生成のソース照合用途のみに使用、再配布しない
- 国税庁サイトに過度な負荷をかけないため、初回 crawl は分散実行可能（例：1 日 500 ページずつ 4 日分割）

---

## 4. 月次更新の仕組み

### 4-1. GitHub Actions

`.github/workflows/crawl-nta-sources.yml`

```yaml
on:
  schedule:
    - cron: '0 15 1 * *'   # 毎月 1 日 JST 00:00 (UTC 15:00) に実行
  workflow_dispatch:        # 手動実行も可能
```

実行内容：
1. main から checkout
2. `node scripts/crawl-nta-sources.js --incremental` 実行
3. 変更があれば `chore: 国税庁ソース DB 月次更新` という commit を自動 push（または PR 化）
4. エラー件数が閾値超過なら Chatwork 通知

### 4-2. 自動 push vs PR 化

| 案 | メリット | デメリット |
|---|---|---|
| **A. main に直接 push** | 自動化が完結、人手不要 | 国税庁側で内容変更があった場合に気付きにくい |
| **B. 自動 PR 化（推奨）** | 変更内容を毎月レビューできる、改正情報の把握につながる | 月次で PR レビューが必要 |

→ **案 B（自動 PR 化）** を推奨。改正情報のキャッチアップにも繋がる。

### 4-3. エラー検知

| 状況 | 対処 |
|---|---|
| 1 ページ取得失敗 | 3 回リトライ後 skip、`meta.json` のエラーリストに記録 |
| 1 カテゴリ全件失敗 | crawl 全体を中断、Chatwork 通知 |
| エンコーディング判別失敗 | そのページを skip、`meta.json` に記録 |
| 全体の 5% 超で失敗 | Chatwork 通知（サイト構造変更の疑い）|

---

## 5. 実装計画

### 5-1. Phase C 内のサブステップ

| Sub | 内容 | 規模 |
|---|---|---|
| C-1 | crawl スクリプト骨子（index 取得 + 個別ページ取得 + JSON 保存）| 1 日 |
| C-2 | タックスアンサーのパーサ（UTF-8、本文抽出）| 0.5 日 |
| C-3 | 質疑応答事例のパーサ（Shift_JIS、照会/回答/法令分割）| 0.5 日 |
| C-4 | 差分 crawl ロジック（HEAD + hash 比較）| 0.5 日 |
| C-5 | index.json / meta.json 生成 | 0.5 日 |
| C-6 | GitHub Actions workflow + Chatwork 通知 | 0.5 日 |
| C-7 | 初回フル crawl 実行 + 結果検証 | 0.5 日 |

**合計：約 4 日**

### 5-2. Phase C 完了の判定基準

- 約 2,000 ページの JSON が `data/nta-sources/` に存在する
- `index.json` から全エントリが retrieval 可能
- 月次 cron が正常動作することを 1 回確認できている
- 差分 crawl が動作することを確認できている（同じ内容なら skip）

---

## 6. テスト戦略

### 6-1. 単体テスト
- `scripts/lib/__tests__/test-nta-crawler.js`
- HTML パーサのスナップショットテスト（既知の数ページの HTML をフィクスチャ化）
- 文字コード判別ロジックのテスト
- 差分 hash 計算のテスト

### 6-2. 統合テスト
- 5〜10 ページ程度のサンプル URL を実 fetch してパース結果を検証
- CI では実 fetch しない（API レート消費 + 不安定なため）。ローカル / 手動実行のみ

### 6-3. 監視
- 月次 crawl 後の件数モニタリング（前月から ±5% 以上変動したら Chatwork 通知）
- エラー率モニタリング（0.5% 超過で通知）

---

## 7. 後続フェーズで使う API

Phase C 完了後、以下の関数を `scripts/lib/nta-sources.js` として提供する：

```js
// 全エントリの index を読み込み
loadIndex() => { entries: [...] }

// ID で個別エントリを取得
getEntry(type, category, id) => { id, title, body, ... }

// 税目で絞り込み
getEntriesByCategory(taxCategory) => [...]

// キーワード検索（後続 Phase E で使用）
searchByKeywords(keywords, options) => [...]

// URL から JSON ファイルパスを解決
resolveByUrl(url) => filePath
```

これを Phase D（n-gram 検知）、E（topic-pool 自動抽出）、G（Fact-Check）から利用する。

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 国税庁サイトの HTML 構造変更 | パース失敗 | パーサに sanity check を入れ、構造異常時は Chatwork 通知 |
| 大量 crawl で IP ブロック | crawl 不能 | rate limit 厳守、User-Agent 明示 |
| 文字化け頻発 | データ品質低下 | U+FFFD 出現率モニタリング、異常時は skip + 通知 |
| ストレージ肥大化 | リポジトリ容量増 | 約 10 MB なので問題なし。Git LFS 不要 |
| robots.txt 変更 | crawl 違反 | 月次 crawl 開始前に robots.txt を再取得 |

---

## 9. 残課題（実装時に詰める）

1. パーサの sanity check の閾値（U+FFFD 出現率・本文最小文字数等の具体値は実データで決める）
2. 月次 PR の reviewer 自動アサイン設定
3. 改正情報の差分追跡（diff の見せ方）— 将来課題

---

## 10. 次のアクション

1. 本仕様書を main に merge
2. Phase C-1（crawl スクリプト骨子）から実装着手
3. 各 sub Phase ごとに小さく PR 化 → review → merge

---

**本仕様書のステータス**：確定済
