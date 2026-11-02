# 流入元の計測（traffic-sources）

## 背景

- 2026-11-01、毛利さんの決定で、アクセス解析に流入元を足す。「ヤフー経由の人数」「iPhone の割合」「10 月に増えた分は人か自動アクセスか」を当サイトの数字で確かめるため。
- サーチコンソールは Google 検索だけを集計する。サイトの計測は流入元を残していない。
- 実験（2026-11-01）: ヤフーの検索結果から移動すると `document.referrer` は `https://search.yahoo.co.jp/`、Google は `https://www.google.com/`。検索語は届かない。

## 毛利さんの決定

- **プライバシーポリシーは変更しない**（`templates/pages/privacy.html` に触らない）。
- Google アナリティクスなどの外部の解析ツールは入れない。

## 方針

1. 訪問の最初のページで、直前のサイト名・印（`utm_source`）を送る。
2. サーバーで分類して、1 訪問につき名前のない印（Blob）を 1 つ置く。管理画面は印の数を数える。
3. 画面を操作した訪問には、もう 1 つ印を置く（操作あり）。
4. 管理画面に「流入元」の表を足す。

### 記録しないもの（厳守）

- 参照元の URL の全体（パス・検索文字列）。サイト名だけを扱う。
- 訪問者の識別子（`mz_vid` とそのハッシュ）を流入元の印に入れない。印と個人を結びつけない。
- IP アドレス、UA の全文。

### 読み書きの方式を変えない理由

`daily/` のような「読んで足して書き戻す」方式は流入元には使わない。

- `@netlify/blobs` 10.7.9 の `setJSON` は `onlyIfMatch` / `onlyIfNew` をサーバーに送らない。
- `connectLambda` では読み込みが最終的整合性で、最大 60 秒ほど古い値が返る。
- したがって読み書きを繰り返すと数え漏れる。訪問者数（`uniq/`）と同じく、印を 1 つずつ置いて一覧の件数で数える。

## 段階

| 段階 | 内容 |
|---|---|
| 01 | 計測・保存・管理 API・管理画面・片付け（1 PR） |

## 全段階共通の厳守事項

- `privacy.html` を変更しない。
- 既存の PV・訪問者・問い合わせ遷移・送信完了・LINE の数え方と API の既存項目を変えない。
- 計測の失敗で公開サイトの表示や PV の記録を止めない。
- 既存の試験を弱めない・消さない。期待値を変えてよいのは、新しい項目が増えて本文が変わる箇所だけ。
- `assets/js/tax-simulator*` はビルドや試験の副作用で変わる。コミットの対象にしない。

## 元に戻す方法

PR を revert する。`src/` の印は残っても害がなく、`analytics-cleanup` で 90 日後に消える。

## 受け入れ確認

- 試験（下記）が隔離の外で全件通る。
- `git status` に指示書にないファイルがない。
- マージ後、本番で実際に検索結果から移動し、`/track` の送信内容と管理画面の表を確かめる。iPhone の Safari・ヤフーのアプリ・LINE は毛利さんの実機で確かめる。

## コードの入口

- `scripts/build.js` の `ANALYTICS_BEACON`（公開ページの計測の文）
- `netlify/functions/lib/analytics-store.js`（分類・検証・保存）
- `netlify/functions/track-visit.js`（受け口）
- `netlify/functions/admin-list-analytics.js`（管理 API）
- `netlify/functions/admin-analytics-page.js`（管理画面）
- `netlify/functions/analytics-cleanup.js`（片付け）
- 試験: `scripts/lib/__tests__/test-analytics-store.js`・`test-track-visit.js`・`test-contact-transition.js`
