# 実装指示書: サーチコンソールの検索語を週次で取り込む（並行A）【着手可】

作成: 2026-09-03（設計: Claude ／ 実装: Codex）
前提: `README.md` の共通厳守事項。

## 背景と目的

サーチコンソールはサイト認証済みだが、検索語のデータをサイト側に持っていない。
段階1〜4の効果を測る物差しと、「どの業種・どのサービスのページを先に強化するか」を
データで決める材料として、週次で取り込む。問い合わせ遷移の取り込み
（`.github/workflows/export-contact-transitions.yml`）と同じ流儀にする。

## 変更してはいけないもの（厳守）

`README.md` に同じ。取り込んだデータを記事生成の候補選定に**自動で接続しない**
（それは別の判断。今回は貯めて見られるようにするまで）。

## 実装要件

### R1. 認証

- Google のサービスアカウントで Search Console API を呼ぶ。鍵の JSON は GitHub Secrets
  `GSC_SERVICE_ACCOUNT_JSON` に置く（毛利が登録。サービスアカウントのメールを
  サーチコンソールのプロパティに「制限付き」ユーザーとして追加する手順を README に書く）。
- プロパティは `sc-domain:mori-zeirishi.net` を第一候補、無ければ `https://mori-zeirishi.net/`。
  両方試して取れたほうを使い、ログに出す。
- 依存は `googleapis` を **devDependencies** に追加せず、`google-auth-library` だけを
  `dependencies` に追加して REST を直接呼ぶ（依存を最小にする）。

### R2. 取得

`scripts/fetch-search-console.js`:
- 直近28日（終了日は3日前。サーチコンソールのデータ反映の遅れを吸収）。
- 次の3種を取得し、それぞれ上位1,000行まで:
  1. `query`（検索語）
  2. `page`（URL）
  3. `query` × `page`
- 指標: clicks / impressions / ctr / position。
- 出力: `data/search-console/YYYYMMDD/{queries,pages,query-page}.json` と、
  最新を指す `data/search-console/latest.json`（`{ fetched_at, range: {start,end}, property, files }`）。
- 保持は直近12週分。それより古い日付ディレクトリは削除する。

### R3. 週次の集計レポート

`scripts/report-search-console.js` が `latest.json` を読み、`data/search-console/report.md` を作る:
- 検索語の上位30（表示回数順）と、そのうち**順位11〜30位で表示回数が多いもの**（伸ばしやすい語）
- ページ別の上位30
- ページ種別ごとの合計（トップ／サービス／業種ハブ／記事／ツール。URL の形で分類）
- 前週の `report.md` との差分（新しく表示され始めた検索語）

### R4. ワークフロー

`.github/workflows/fetch-search-console.yml`:
- 毎週月曜 JST 04:00（UTC 日曜 19:00）＋手動。
- 取得 → 集計 → 変更があれば PR（自動マージなし。既存の transitions の PR と同じ体裁）。
- 鍵が未設定なら「未設定」と notice を出して正常終了する（失敗にしない）。

### R5. 管理画面

既存の `/admin/analytics`（`netlify/functions/admin-analytics-page.js`）に「検索語（サーチコンソール）」の
節を足し、`report.md` の内容を表示する。読み取り専用。

### R6. テスト

`scripts/lib/__tests__/test-search-console-ingest.js`:
1. API 応答のモックで、3種のファイルと `latest.json` が正しい形で出る
2. 12週より古いディレクトリが削除される
3. `report.md` に「伸ばしやすい語」の節があり、順位11〜30位だけが入る
4. 鍵が無い場合に例外を出さず終了コード0

## 受け入れ確認（Claude が実施）

- 手動実行で PR が作られ、`report.md` が読める
- 個人情報（検索語に含まれることがある氏名など）をそのまま管理画面に出していないか目視

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `.github/workflows/export-contact-transitions.yml` | 週次取り込み→PR の既存の流儀 |
| `netlify/functions/lib/github-api.js` | GitHub App 認証（PR 作成に流用可） |
| `netlify/functions/admin-analytics-page.js` | 管理画面の解析ページ |
