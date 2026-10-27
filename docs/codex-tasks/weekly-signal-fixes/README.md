# 週次の信号の誤検知を直す（鮮度の「出典更新」と GSC 由来の記事候補）

2026-09-28 の週次 PR（#657、サーチコンソール取り込み）を検収して見つかった 2 つの誤りを直す。毛利さん承認済み（2026-09-28）。

## 背景と数字

### 問題 1: 鮮度の「出典が更新」が初回取り込み日を拾っている

- 更新候補の上位 10 件中 6 件の理由が「No.xxxx が 2026-06-21 に更新（出典欄）」。同じ内容が Chatwork 通知にも載った。
- `scripts/lib/freshness-candidates.js` の `sourceReason()` は `data/nta-sources/index.json` の `fetched_at` を「出典の更新日」として記事の公開日と比べている。
- `fetched_at` は「最後にページ本体を取り直した日時」。`crawl-nta-sources.js --incremental` は HTML のハッシュが変わったときだけ取り直すので、変わっていないページは**初回取り込み日（2026-06-21〜22）のまま**。実測: 2222 件中 2203 件が 6/21〜22、8/1 に取り直したのは 19 件。
- 国税庁側の実際の最終更新（`last_modified`）は例えば No.6501 が 2026-03-27、No.2792 が 2025-10-20。いずれも記事公開前で、書き直しは要らない。
- さらに、HTML のハッシュは国税庁サイトのデザイン変更でも変わるので、取り直し＝内容の改訂とは限らない。本当の改訂の目印は**本文の中身**と**法令基準日**（各ページの `law_version`、例「令和7年4月1日現在法令等」）。

### 問題 2: GSC 由来の記事候補が既存記事と重なる

`scripts/update-gsc-topics.js` の `extractGscCandidates()` が今週 6 件を新記事候補にしたが、検収で 6 件とも採用しなかった。原因は 3 つ。

1. **統合済み記事の URL を「記事が無い」と判定する。** 語の所在（題名・h2・本文）を調べる記事一覧 `readPublishedPostContents()` が公開中の記事だけなので、Google がまだ統合済みの旧 URL を上位に出していると所在が `none` になる。例: 「youtube 源泉徴収」は旧 URL（`youtube-side-business-withholding-treatment-practice`、merged）が 6.5 位。統合先の記事は題名で答えている。
2. **順位の閾値が週次レポートの「伸ばしやすい語」（11〜30 位は既存記事を直す）とぶつかる。** 現行は「20 位より下、または所在なし」で新記事候補。21〜30 位で題名に語がある既存記事まで新記事候補になる（経費 ガソリン代 26.2 位・題名、レジ 現金過不足 27.9 位・題名）。
3. **通称と正式名称を別の語として扱う。** 「簡易インボイス」は既存の小売インボイス記事（題名に「適格簡易請求書」、本文に 18 回）が主題として扱っているが、通称が一度も出てこないため所在 `none` → 新記事候補になった。

加えて、**却下を記録する方法が無い**。`data/gsc-topics.json` から消すと翌週また提案され、残すと記事生成の候補に入る。

### 今週のデータで新規則を試した結果（Claude が事前に計算）

| 語 | 表示 | 順位 | 該当ページ | 現行 | 新規則（01〜03 適用） |
|---|---:|---:|---|---|---|
| youtube 源泉徴収 | 17 | 6.5 | 統合済み → 統合先で所在 title | 候補 | 外れる |
| レジ 現金過不足 | 17 | 27.9 | 所在 title | 候補 | 外れる |
| 経費 ガソリン代 | 18 | 26.2 | 所在 title | 候補 | 外れる |
| 確定申告 帳簿 | 30 | 37.4 | 所在 title | 候補 | 外れる |
| 人工代 | 33 | 38.2 | 所在 title | 候補 | 外れる |
| 簡易インボイス | 27 | 47.5 | 所在 none → 同義語で title | 候補 | 外れる |
| インボイス レジ | 15 | 30.1 | 所在 body | 候補 | 候補（30 位をわずかに超える）→ 却下記録で止まる |

## 方針

- 鮮度: 「出典が改訂された」とは、**前回保存した内容と比べて本文か法令基準日が変わった**ときだけ。初回の取り込みや、HTML だけの変化は改訂と数えない。
- GSC 由来の候補: 11〜30 位は既存記事を直す領域（週次レポートの「伸ばしやすい語」）。新記事候補は「30 位より下で、統合先も含めた既存記事の題名・h2 にその語（同義語を含む）が無い」ものだけ。
- 人が却下した候補は `status: "rejected"` で残し、生成には使わず、再提案もしない。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-freshness-source-change.md` | 国税庁データに「内容が変わった日」を持たせ、鮮度はそれだけを使う。既存データの補正 |
| 02 | `02-gsc-candidate-rules.md` | 統合先で所在判定・順位閾値・同義語・却下の記録 |

01 と 02 は独立。どちらから実装してもよい。作業ブランチは 1 本（`fix/weekly-signal-accuracy`）。

## 全段階共通の厳守事項

- `content/posts/*.md` を触らない（記事の題名修正は別作業）。
- 週次レポートの節の順番と既存の文言を変えない（文言の差し替えは指示書にあるものだけ）。
- 鮮度の他の信号（税制改正・年度・検索の落ち込み・SEO 改稿）の重みと判定を変えない。
- 記事生成のプロンプト、LLM 選別プロンプトの文言を変えない。
- ネットワークは使えない。国税庁への実アクセスや LLM 呼び出しはテストで偽の関数に置き換える。
- 説明・コメント・最終報告は日本語。ファイルは LF。

## 元に戻す方法

- 01: `freshness-candidates.js` の `sourceReason()` を元に戻せば従来の判定に戻る。国税庁データに足した項目（`first_fetched_at`・`content_changed_at`・`content_change_kind`）は読まれなくなるだけで害は無い。
- 02: `update-gsc-topics.js` の閾値と所在判定を戻す。`data/query-synonyms.json` を空配列にすれば同義語は無効。`status: "rejected"` の候補は、この項目を消せば生成候補に戻る。

## 受け入れ確認（Claude が行う）

- `npm run build` / `npm run validate` / `npm run masters:test` と、全テストファイル（`scripts/lib/__tests__/*.js`、`scripts/__tests__/*.js`）の実行。`test-nta-qa.js` は main でも失敗している（軽減税率 Q&A の件数）ので対象外。
- 実データで `node scripts/build-freshness-candidates.js` を実行し、「2026-06-21 に更新」を理由にした候補が 0 件であること。
- 実データ（`data/search-console/20260928/`）で `extractGscCandidates()` を実行し、上表の「新規則」列と一致すること。

## コードの入口

- 鮮度: `scripts/lib/freshness-candidates.js`（`sourceReason`・`readNtaEntries`）、`scripts/build-freshness-candidates.js`
- 国税庁データ: `scripts/crawl-nta-sources.js`（taxanswer と shitsugi の 2 か所で保存項目を組み立てる）、`scripts/lib/nta-store.js`、`scripts/lib/nta-index-builder.js`、`data/nta-sources/`
- GSC 候補: `scripts/update-gsc-topics.js`（`extractGscCandidates`・`readPublishedPostContents`・`isKnownPhrase`）、`scripts/lib/gsc-topics.js`（`validateTopic`・`expandGscTopics`）、`scripts/lib/query-placement.js`（`locateQuery`）、`scripts/lib/target-query.js`（`tokenizeQuery`）
- 週次ワークフロー: `.github/workflows/fetch-search-console.yml`
- テスト: `test-freshness-candidates.js`・`test-nta-index-builder.js`・`test-gsc-topics.js`・`test-query-placement.js`・`test-search-console-ingest.js`
