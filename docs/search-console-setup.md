# サーチコンソールの取り込み（設定手順）

作成: 2026-09-03（並行A）

サーチコンソールの検索語を毎週月曜 JST 04:00 に自動で取り込み、`data/search-console/` に貯めます。
管理画面（`/admin/analytics`）の「検索語（サーチコンソール）」で読めます。
記事生成の候補選定には接続していません（貯めて見られるようにするまで）。

## 毛利さんの作業（一度だけ）

1. **サービスアカウントを作る**
   - Google Cloud Console → プロジェクトを選ぶ（無ければ新規作成）
   - 「APIとサービス」→「ライブラリ」→ **Google Search Console API** を有効にする
   - 「IAMと管理」→「サービスアカウント」→「作成」。名前は `search-console-reader` など
   - 作成したサービスアカウントの「キー」→「鍵を追加」→ **JSON** をダウンロード
2. **サーチコンソールにそのアカウントを追加する**
   - サーチコンソール → 対象プロパティ（`sc-domain:mori-zeirishi.net` または `https://mori-zeirishi.net/`）
   - 「設定」→「ユーザーと権限」→「ユーザーを追加」
   - メールアドレスに、サービスアカウントの `client_email`（`…@….iam.gserviceaccount.com`）を入れ、権限は **制限付き** でよい
3. **GitHub に鍵を登録する**
   - リポジトリの Settings → Secrets and variables → Actions → New repository secret
   - Name: `GSC_SERVICE_ACCOUNT_JSON`
   - Value: ダウンロードした JSON ファイルの中身をそのまま貼る
4. **動作確認**
   - Actions → 「Fetch Search Console」→ Run workflow
   - 成功すると `search-console/YYYYMMDD` のブランチで PR が作られる。マージすると管理画面に反映される

鍵を登録するまでは、ワークフローは「未設定」と表示して正常終了します（失敗にはなりません）。

## 貯まるもの

```
data/search-console/
  latest.json                最新の取り込みの所在
  report.md                  週次レポート（管理画面に表示するもの）
  YYYYMMDD/queries.json      検索語（上位1,000）
  YYYYMMDD/pages.json        ページ（上位1,000）
  YYYYMMDD/query-page.json   検索語×ページ（上位1,000）
```

期間は直近28日（終了日は3日前。反映の遅れを吸収）。保持は直近12週分で、古い日付は自動で消えます。

## レポートの見方

- **伸ばしやすい語**: 順位11〜30位で表示回数が多い語。該当する記事・サービスページの見出しと本文を見直す候補
- **ページ種別ごとの合計**: トップ／サービス／業種ハブ／記事／ツールのどこに検索が来ているか。段階1〜4の効果測定に使う
- **前回との差分**: 新しく表示され始めた検索語。新しいページが検索に載り始めたかの確認に使う

## 関係するファイル

| 場所 | 何があるか |
|---|---|
| `scripts/fetch-search-console.js` | 取り込み本体（鍵が無ければスキップ） |
| `scripts/report-search-console.js` | `report.md` の生成 |
| `.github/workflows/fetch-search-console.yml` | 週次の実行と PR 作成 |
| `netlify/functions/admin-analytics-page.js` | 管理画面での表示 |
| `netlify.toml` の `[functions] included_files` | 関数から `data/search-console/` を読めるようにする設定 |
