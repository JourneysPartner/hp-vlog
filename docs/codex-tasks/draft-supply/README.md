# 日次の記事生成が下書きを出さない問題を直す（取り下げた題材の記録・次の候補・点検の誤警報・古いテスト）

2026-10-09 の状況確認で見つかった 3 つの問題を直す。毛利さん承認済み（2026-10-09「1〜3 をまとめて直す」）。

## 背景と数字

### 問題 1: 日次生成がほとんど下書きを出さない

2026-09-27 に生成を「1 回 1 本・月水金」に変えて（crawl-queue 02）から、定期実行 6 回で下書きができたのは 10/5 の 1 回だけ。10/6 以降、新しい記事が公開されていない。

| 実行日（JST） | run | 選ばれた題材（topic_id） | 結果 |
|---|---|---|---|
| 2026-09-28 | 36360855055 | suggest-furima-sedori-1e1ea0 | 選定時の重複判定で除外 → 補充 suggest-ec-kakutei-a57de4 も重複 → 0 本 |
| 2026-09-30 | 36648533889 | suggest-furima-sedori-1e1ea0 | 本文まで生成 → 生成後の重複判定で取り下げ（reselling-profit-bookkeeping-beginners と重複）→ 0 本 |
| 2026-10-02 | 36944187851 | suggest-furima-sedori-1e1ea0 | 同上（3 回目の同じ題材）→ 0 本 |
| 2026-10-05 | 37246085809 | （土地の相続税） | 下書き 1 本（#668、公開済み） |
| 2026-10-07 | 37550072199 | suggest-zouyo-hikazei-351e52 | 選定時の重複判定で除外（未承認下書き suggest-zouyo-hikazei-5be58f と重複）→ 補充 suggest-souzoku-tetsuduki-4ff059 も重複 → 0 本 |
| 2026-10-09 | 37862926041 | suggest-zouyo-hikazei-351e52 | 同じ題材が再び除外 → 補充 suggest-souzoku-tetsuduki-4ff059 を本文まで生成 → 生成後の重複判定で取り下げ（inheritance-within-10months-inheritance-filing-guide と重複）→ 0 本 |

原因は 2 つ。

1. **取り下げた題材を覚えていない。** 選定の除外（`filter-existing-slugs`・`filter-cooldown` など）は「公開済み記事・未マージ下書き」との突き合わせなので、取り下げて記事にならなかった題材は次の回も同じ優先度で選ばれる。同じ題材を 3 回選び、うち 2 回は本文生成の費用を払ってから捨てている。
2. **1 回外れると、その日はほぼ終わり。** `pickPair()` の補充は「1 回だけ・1 件だけ」。生成後の重複判定・URL slug の衝突・狙う検索語の持ち主ありで外れた場合は補充が無く、0 本で終わる。

### 問題 2: 生成の無い日に「記事生成が失敗」と通知される

`check-existing-posts.yml` の「Check daily draft ran」は「直近 25 時間に成功した daily-draft があるか」を見ている。生成が月水金になったのに毎日前提のままなので、日・火・木の朝に失敗扱いになり `daily_draft_failed` 通知が飛ぶ（10/4・10/6・10/8 に実際に発生）。さらに GitHub の定期実行は 2〜4 時間遅れることがあり（予定 22:00 UTC → 実際 00:16〜01:59 UTC）、25 時間の窓は土曜でも際どい。記事の検証（validate）は毎回成功している。

### 問題 3: 税務シミュレーターの定期チェック（masters:test）が失敗

`scripts/lib/__tests__/test-title-refresh.js`（crawl-queue 09 の題名差し替えのテスト）が、対象 10 本の `updated_at` と本文が変わっていないことを確かめている。10/5 に鮮度の更新案（#663）でサブスク記事（`newseg-content_seller-content-subscription-revenue-guide`）の本文と `updated_at` が正しく書き換わったため、2 項目が失敗している（PASS 49 / FAIL 2、2026-10-08 の定期実行 run 37843259496）。テストのほうが鮮度更新を想定していない。

## 方針

- 取り下げた題材は `data/withdrawn-topics.json` に記録し、通常の選定では二度と選ばない（毛利さんの指示）。記録を消せば戻る。
- 1 本モードでは、外れたら次の候補を試す。ただし費用に上限を付ける: 候補の確認は 1 回の実行で最大 5 件、本文生成は最大 2 回（どちらも環境変数で変えられる）。
- 点検は「直近の生成予定（月水金）の後に成功した生成があるか」で判定する。曜日は `netlify.toml` の `scheduler-daily-draft` の cron を唯一の正とし、点検側に曜日を書かない。
- テストは「題名・要約が指定どおり」を引き続き全 10 本で確かめ、「それ以外は変わっていない」は鮮度更新を受けた記事だけ本文と更新日を対象から外す（出典・日付・slug などが変わっていないことは確かめ続ける）。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-withdrawn-and-retry.md` | 取り下げた題材の記録と選定からの除外、次の候補を試す、記録を main に残すワークフロー、本番ビルドの対象外 |
| 02 | `02-draft-ran-check.md` | 点検の判定を生成予定（cron）基準に |
| 03 | `03-title-refresh-test.md` | 題名差し替えテストを鮮度更新に対応させる |

01〜03 は独立。作業ブランチは 1 本（`fix/draft-supply`）。

## 全段階共通の厳守事項

- `content/posts/*.md` を触らない。
- 既存の選定フィルタ（existing-slugs / target-query / time-limited / denylist / relevance / quality-fit / topic-identity / cooldown / similarity / balance）、選定時の AI 重複判定、生成後の重複判定、URL slug・狙う検索語の判定を弱めない。判定の閾値やプロンプトを変えない。新しい除外は追加のみ。
- ランダムな代替（不適合な記事を作るフォールバック）を足さない。候補が尽きたら 0 本で終わってよい。
- 記事生成のプロンプト、LLM 選別プロンプト、重複判定プロンプトの文言を変えない。
- `--force-slug`（手動指定）と 2 本モード（`DRAFT_COUNT=2`）の既存の動きを変えない（01 に書いた追加だけ）。
- `regenerate-draft.yml` / `publish-scheduled.yml` と差し戻し再生成の経路は触らない。
- ネットワークは使えない。LLM 呼び出し・GitHub 呼び出しはテストで偽の関数に置き換える。
- 鍵・トークンをログやファイルに出さない。
- 説明・コメント・最終報告は日本語。ファイルは LF。

## 元に戻す方法

- 01: `data/withdrawn-topics.json` の項目を消せば、その題材は選定に戻る。`DRAFT_MAX_CANDIDATES=1` と `DRAFT_MAX_GENERATIONS=1` で従来に近い「1 件だけ試す」動きになる。ワークフローの記録ステップを消せば main への記録は止まる。
- 02: `check-existing-posts.yml` の「Check daily draft ran」を元の 25 時間判定に戻す。
- 03: テストファイルを戻す（ただし鮮度更新済みの記事があるので失敗に戻る）。

## 受け入れ確認（Claude が行う）

- `npm run build` / `npm run validate` / `npm run masters:test` と、全テストファイル（`scripts/lib/__tests__/*.js`、`scripts/__tests__/*.js`）の実行。`test-nta-qa.js` は main でも失敗しているので対象外。`test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、01 で `daily-draft.yml` を変えるのでコミット前は必ず落ちる。コミット後に通ることを Claude が確かめる。
- 実データで `selectDailyTopics` を呼び、`filter-withdrawn` が初期記録の 4 題材を外し、選ばれる題材が 4 題材以外になること。
- 偽の LLM で「1 件目が選定時に重複 → 2 件目が生成後に重複 → 3 件目で下書きができる」流れと、上限に達して 0 本で終わる流れが再現できること。
- 2026-10-04〜10-09 の実際の実行時刻で 02 の判定を計算し、日・火・木も成功になること。
- `test-title-refresh.js` が現在の main で通り、基準コミットで旧ハッシュが一致すること。

## コードの入口

- 選定: `scripts/lib/topic-selector.js`（`selectDailyTopics`、2.7 の denylist フィルタの直後が追加位置）、`scripts/lib/denylist.js`（読み込みとエントリ形式の参考）
- 生成: `scripts/generate-draft.js`（`pickPair` = 選定と AI 重複判定と補充、`main()` = 出典補完 → 狙う検索語と URL slug → 本文生成 → `checkGeneratedArticle`、GitHub 出力 `single_reason`）、`scripts/lib/ai-dedup.js`
- ワークフロー: `.github/workflows/daily-draft.yml`、`.github/workflows/check-existing-posts.yml`
- スケジュール: `netlify.toml`（`[functions."scheduler-daily-draft"] schedule = "5 0 * * 1,3,5"`、UTC）、`netlify/functions/scheduler-daily-draft.js`
- 本番ビルドの要否: `scripts/netlify-ignore-build.js`、`scripts/lib/netlify-ignore.js`（`IGNORED_PREFIXES` など）
- テスト: `test-selector.js`・`test-denylist.js`・`test-ai-dedup.js`・`test-pending-drafts-dedup.js`・`test-scenario-identity-and-postgen-dedup.js`・`test-demand-driven-selection.js`・`test-crawl-queue-cadence.js`・`test-netlify-ignore.js`・`test-notify-message.js`・`test-title-refresh.js`・`test-workflow-change-detection.js`
