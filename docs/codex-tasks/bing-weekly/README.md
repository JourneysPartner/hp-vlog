# 週次のサーチコンソールのレポートに Bing の数字を足す（bing-weekly）

2026-11-13 毛利: Bing Webmaster Tools に登録済み（GSC から取り込み）、API の鍵を GitHub Secret `BING_WEBMASTER_API_KEY`（JourneysPartner/hp-vlog）に登録済み。「Bing の数字を、週次のサーチコンソールのレポートに足す仕組みを作って」。

## 背景と数字

- 週次の取り込み（`.github/workflows/fetch-search-console.yml`、毎週月曜 JST 04:00）は Google の数字だけを `data/search-console/report.md` に書いている。管理画面 `/admin/analytics` はこの report.md を表示する。
- Bing の画面（2026-11-13）: サイトマップは読み込み成功（315 URL）。検索の数字は「48 時間後に」で未集計。AI Performance（AI の回答での引用）は 3 か月とも 0。
- 取り込むのは **検索（表示・クリック）・検索語・ページ・巡回・サイトマップ**。AI Performance は API の説明書に窓口が無いので取り込まない（月 1 回、Claude が画面で読む）。
- 新しく取り込むのは Bing だけ。記事生成の候補選びには接続しない（GSC と同じく「貯めて見る」まで）。

## 確かめた事実と、まだ確かでないこと

| 事項 | 内容 | 根拠 |
|---|---|---|
| 窓口の形 | `GET https://ssl.bing.com/webmaster/api.svc/json/<窓口名>?siteUrl=<サイト>&apikey=<鍵>`。応答は `{"d": [...]}` | Microsoft Learn「Supported API Protocols」（2026-08-10 更新）と各窓口の見本 |
| 誤りの形 | HTTP 400 で `{"ErrorCode":3,"Message":"InvalidApiKey"}` の形 | Microsoft Learn「Getting started」 |
| 項目名 | QueryStats: `Query`・`Date`・`Impressions`・`Clicks`・`AvgImpressionPosition`・`AvgClickPosition`（GetPageStats も同じ形で `Query` に URL）。RankAndTrafficStats: `Date`・`Impressions`・`Clicks`。CrawlStats: `Date`・`CrawledPages`・`InIndex`・`CrawlErrors`・`Code2xx`・`Code301`・`Code302`・`Code4xx`・`Code5xx`・`BlockedByRobotsTxt`・`AllOtherCodes`・`ConnectionTimeout`・`DnsFailures`・`ContainsMalware`・`InLinks`。Feed: `Url`・`Type`・`Status`・`UrlCount`・`FileSize`・`Compressed`・`Submitted`・`LastCrawled` | Microsoft Learn の .NET の型の説明（2019〜2023 更新） |
| 日付の形 | `"/Date(1316156400000-0700)/"`（ミリ秒＋時差） | 同上の見本 |
| 期間 | GetRankAndTrafficStats・GetCrawlStats は毎日更新、GetCrawlStats は「直近 6 か月」。GetRankAndTrafficStats はウェブのほかチャット・ニュース・画像・動画・ナレッジパネルの表示とクリックを含む（2023-03-24 以降）。GetQueryStats・GetPageStats は「毎週更新」 | 各窓口の説明 |
| 旧式の終了 | 「SOAP と POX の旧式の API は 2026-08-31 に終了」。JSON は対象に書かれていない | 「Supported API Protocols」の注記 |
| 【要確認】JSON は今も動くか | 他のサイトの公開リポジトリに 2026-11-10 に JSON の窓口で取ったデータがあり、動いているとみられる | 第三者の観察（AGPL のためコードは写さない。事実だけ使う） |
| 【要確認】検索語・ページの単位 | 同じ第三者の観察では「週ごとのまとまりで、日付は週の終わりの金曜、1 週あたり最大 100 行」。足しても全体の数にはならない（全体の数は日ごとの GetRankAndTrafficStats から出す） | 第三者の観察 |
| 【要確認】順位の値 | 同じ観察では 3.25 位のような普通の値（倍率なし）。-1 は「順位なし」 | 第三者の観察 |
| 【要確認】同じ日付の行 | 同じ観察では、日ごとの窓口で同じ日付の行が重なることがある | 第三者の観察 |

【要確認】の 4 点は、実装の後に GitHub の中で本物の鍵を使って 1 回だけ試し（01 の R5 の `dry_run`）、形の記録を見て確かめる。食い違えば直してからマージする。

## 方針（全段階共通の厳守事項）

1. **鍵を外に出さない。** 鍵は環境変数 `BING_WEBMASTER_API_KEY` からだけ読む。ログ・保存するファイル・report.md・失敗の理由の文・試験の出力に、鍵も、鍵の入った URL も書かない。このリポジトリは公開で、Actions の記録も公開。
2. **読むだけ。** 呼ぶのは 01 の R1 の 5 つの読み取りの窓口だけ（GET）。URL の送信・サイトの追加や削除など、書き込みの窓口は呼ばない。窓口の名前は決めた一覧の中からしか選べない作りにする。
3. **Bing が失敗しても Google の週次は今と同じに動く。** 鍵が無い・Bing が落ちている・形が違う、のどれでも、サーチコンソールの取り込み・レポート・PR・通知は今と同じに進む。
4. **既存のレポートの節の中身と順番は変えない。** 足すのは「Bing の数字」の節 1 つだけ（「索引の状態」の後、「更新候補（上位 10）」の前）。
5. **応答をまるごと写さない。** 決めた項目だけを取り出して保存する。
6. 試験の偽の鍵は鍵らしい形にしない（例 `fake-bing-key-for-tests`。英数字 32 文字などは Netlify の秘密情報の検出で公開が止まる）。
7. 記事の Markdown（`content/posts/*.md`）・記事生成・題材選び（`scripts/generate-draft.js`・`scripts/topic-pool.js`・`scripts/update-gsc-topics.js`）は変えない。

## 段階

| 段 | 内容 | ファイル |
|---|---|---|
| 01 | Bing の取り込み（新しいスクリプト）・ワークフロー・設定手順の文書・試験 | 01-fetch.md |
| 02 | 週次レポートに「Bing の数字」の節・試験 | 02-report.md |

## 元に戻す方法

- Bing だけ止める: GitHub の Secret `BING_WEBMASTER_API_KEY` を消す（取り込みは「未設定」でスキップし、レポートの節は「未取り込み」になる）。
- 仕組みごと戻す: この枝のマージコミットを revert。`data/bing-webmaster/` は残っても害はない（消すなら別の PR）。

## 受け入れ確認（Claude が隔離の外で行う）

1. 関係する試験・`npm run masters:test`・`node scripts/lib/__tests__/test-workflow-run-injection.js`・`npm run validate`・`npm run build` が通る。
2. main と枝で、同じ `data/search-console/20261108` のデータから report.md を作って比べ、違いが「Bing の数字」の節だけであること（Bing のデータが無い状態で）。
3. 鍵の扱い: 差分を読み、URL・応答の本文・例外の文がログやファイルに入る道が無いこと。試験で、偽の鍵が書いたファイル・ログのどこにも出ないこと。
4. 枝を push し、`gh workflow run fetch-search-console.yml --ref seo/bing-weekly -f dry_run=true -f skip_inspection=true` で 1 回だけ本物の鍵で動かす。PR・通知・GSC 候補の更新が起きないこと、形の記録（窓口ごとの行数・日付の範囲・日付の数・項目名・順位の範囲）と成果物の report.md を見て【要確認】の 4 点を確かめる。記録と成果物に鍵が無いことを確かめる。
5. 手が届けば、Orca のブラウザで Bing の画面（検索のパフォーマンス）の合計と report.md の合計を見比べる（見るだけ。設定は触らない）。

## コードの入口

- `scripts/fetch-search-console.js`（取り込みの書き方の手本。`prune` は書き出されているので使ってよい。このファイルは変えない）
- `scripts/report-search-console.js`（`buildReport`・`run`・`pageKind`・`linkCell`・`table`・`n`・`pos`）
- `.github/workflows/fetch-search-console.yml`
- `scripts/lib/__tests__/test-search-console-ingest.js`（偽の fetch の作り方の手本）、`test-freshness-candidates.js` の「8. 週次ワークフロー」（ワークフローの文字で確かめる試験。今の期待は通ったままにする）、`test-workflow-run-injection.js`
- `package.json` の `masters:test`（`scripts/run-test-files.js` に試験ファイルを並べる形）
- `docs/search-console-setup.md`、`data/search-console/README.md`
