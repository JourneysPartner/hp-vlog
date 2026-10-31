# 令和8年度改正への切替（台帳 C-1）

## 背景

- 令和8年度の所得税の改正（基礎控除の引上げ・給与所得控除・62万円の所得要件など）は **2026-12-01 に施行**され、令和8年分に適用される。
- 税務シミュレーターは 4 ツールとも 2025 年（令和7年分）で計算している（`src/ui/hojinnari/context-builder.js`・`src/ui/shohizei/context-builder.js` の `SUPPORTED_YEAR = 2025`）。今日の公開結果に誤りは無い。
- 2026-10-01 の国税庁タックスアンサーの改訂で、鮮度チェック（`scripts/check-master-freshness.js`）が出典 30 ページ・148 件の記録に「出典が更新された」を出している。
- 下調べ: `docs/tax-simulator/r8-switch/comparison-income-r8.md`（所得税の控除の比較表）、`docs/tax-simulator/r8-switch/hash-update-list-r8.md`（148 件の仕分け）。

決定（毛利さん 2026-10-28）
- (a) 計算年は 12/1 の施行前に 2026 年へ切り替える。施行前の値を使う結果には「施行前・概算」と表示する。
- (b) 値が変わらない記録は `source_hash` だけ今の版に更新する（仕様書 §50-1-19 の blocked にはしない）。
- 段 1 の対象は 132 件。`as_of_date`・`verified_at` を確認日（2026-10-28）にする。期間の先で改正が告知された 10 件と、令和8年分の値が変わる 6 件は更新しない。

## 段階

| 段 | 内容 | 指示書 | 状態 |
| --- | --- | --- | --- |
| 1 | 値が変わらない記録の控え（`source_hash`）の更新 | `01-source-hash-update.md` | 済み（PR #721、2026-10-28 マージ） |
| 2 | 所得税法別表第五の令和8年分を足す（最優先）。あわせて給与所得控除の算式表 SID-R8 の出典を条文へ | `02-appendix5-r8.md` | 済み（PR #722、2026-10-29 に 14 件を承認してマージ） |
| 3 | 62万円の所得要件（特定親族特別控除・配偶者特別控除の最下段を年で分ける）。あわせてエンジンに止まる確かめを 3 つ | `03-income-62.md` | 済み（PR #724、2026-10-31 に 12 件を承認してマージ。AI の照合に基づく承認＝§50-1-20 の例外として `income-62-sources.md` 3 章に記録） |
| 4 | エンジンの「施行前・概算」の注記と対応年の判定（設計書 §10-4・§11-1） | `04-pending-law-notice.md` | 実装中 |
| 5 | 計算年の切替（2026 年）。前提: 台帳 C-7・C-13・C-14・C-15・C-16 | 後で書く | 税理士の最終承認（台帳 E-1） |

段 5 で合わせて行うこと
- 画面の文言に「令和8年12月1日施行の改正を反映」の説明を入れる（注記の文には日付を入れていない。段 4 の決定 D3）。
- ②③④の見出しの状態が `partial` のまま英語で出るので、①の「一部概算」に揃えるか決める。
- `src/simulators/core/versions.js` の `calculationVersion` を上げるか決める。

2026-12-01 の施行の後: 所得税の `enacted` の記録を `effective` に切り替えて公開する。切り替えると「施行前・概算」の注記は消え、結果は `complete` に戻る。

段 2 以降の金額は一次資料（改正法の条文・別表第五）で照合してから書く。タックスアンサーの本文から直接転記しない（設計書 §6-1・§1-1）。

## 全段階共通の厳守事項

1. **値を自動で書き換えない。** 金額・率・境目・期間は、指示書に書かれたものだけを変える。
2. 指示書に無い記録・ファイルを変えない。「ついでに」直さない。気づいたことは最終報告に書く。
3. マスターの JSON は**文字列として必要な行だけ**書き換える。`JSON.parse` → `JSON.stringify` で書き直すと書式が変わるファイルがある（段 1 の対象 13 本のうち 9 本）。
4. 国税庁のデータ（`data/nta-sources/`）、出典台帳（`sources/source-registry.json`）、年度マスター（`data/tax-year/`）は読むだけ。
5. 公開用のまとめファイル（`assets/js/tax-simulator.*.js`・`tax-simulator-manifest.json`）は作り直さない（段 5 でまとめて行う）。
6. テストを弱めない・消さない・飛ばさない。
7. 使い捨ての道具を作るときは名前を `.tmp-` で始め、終わったら消す。リポジトリに残さない。
8. 鍵の形の文字列を直書きしない（`publish="."` のため Netlify の秘密情報検出でビルドが落ちる）。`source_hash` の 64 桁は国税庁データから読んで書く。
9. 説明・コメント・最終報告は日本語。

## 元に戻す方法

段ごとに 1 つ以上のコミットにする。戻すときはそのコミットを `git revert` する。段 1 はデータの控えの項目だけなので、戻しても計算結果は変わらない。

## 受け入れ確認（Claude が行う）

- `npm run masters:validate` が通る。
- `node scripts/check-master-freshness.js --as-of 2026-10-28 --json` の結果が指示書の想定どおり。
- `npm run masters:test` が通る（隔離の外で再実行）。
- `git diff` に、指示書に書かれた項目以外の変化が無い（項目・件数を道具で突き合わせる）。

## コードの入口

| 何 | どこ |
| --- | --- |
| マスター | `data/tax-simulator/masters/data/**.json` |
| 出典台帳 | `data/tax-simulator/masters/sources/source-registry.json`（`source_document_id` → `category`・`taxanswer_id`） |
| 国税庁データ（今の版） | `data/nta-sources/taxanswer/<category>/<taxanswer_id>.json` の `html_hash` |
| 鮮度チェック | `scripts/check-master-freshness.js`（記録の `source_hash`、無ければファイル冒頭 `_extraction_source.html_hash` を控えとして使う。冒頭の控えは `taxanswer_id` が一致するときだけ） |
| 形式の検証 | `scripts/validate-masters.js`（`npm run masters:validate`） |
| 試験 | `npm run masters:test`、特に `scripts/lib/__tests__/test-check-master-freshness.js` |
