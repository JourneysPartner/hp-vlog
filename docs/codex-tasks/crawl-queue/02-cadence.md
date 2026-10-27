# 02 生成のペースと配分

## 目的

新規 URL の追加を週 7〜8 本から週 3 本に落とし、その 3 本を「ネット物販を軸に、流入が来ている 3 分野を添える」配分にする。2 本組の生成をやめることで、双子記事による共食いも今後は起きなくする。

## R1 1 回の生成を 1 本にする（既定）

- `scripts/generate-draft.js` の通常モードで、選定本数を設定値にする: 環境変数 `DRAFT_COUNT`（既定 `1`）。`2` を指定したときだけ従来の本命＋補強の対を選ぶ。
- 1 本モードでは「本命」だけを選ぶ（`article_role: main` に相当する候補）。補強記事は選ばない。`pairedTopic` は `null` のままで、既存の `generateFromTemplate(dateStr, topic, null)` の経路を使う。
- `--force-slug` は本数指定に関係なく指定された数だけ生成する（現状維持）。
- `.github/workflows/daily-draft.yml`:
  - 入力 `count`（既定 `1`、選択肢 `1`/`2`）を追加し、`DRAFT_COUNT` に渡す。
  - `count` が `1` のときは「2 本目が作れませんでした」系の通知（`single_reason` を使う手順）を出さない。2 本目に関する出力変数は空で通す。
  - 生成 0 本のときの通知は現状どおり。
- テスト: `test-scenario-identity-and-postgen-dedup.js` など 2 本前提のテストは、`DRAFT_COUNT=2` を明示して通す。1 本モードのテストを追加する（選ばれるのが 1 本、`article_role` が本命、`related_slug` が空）。

## R2 実行日を月・水・金にする

- `netlify.toml` の `[functions."scheduler-daily-draft"]` の `schedule` を `5 0 * * 1,3,5` にする（UTC 0:05 = JST 9:05、曜日は UTC と JST で同じ）。
- `scheduler-daily-draft.js` の中で曜日判定はしない（cron に一元化）。コメントで理由を残す。
- 予約公開（`scheduler-publish`、`scheduler-publish-evening`）は変えない。承認から公開までの流れも変えない。

## R3 大分類の配分を目標比率にする

`scripts/lib/category-balance.js` は現状「均等比率 `1/N`」を基準に出しすぎへペナルティを付け、7 日で 30% を超えた macro をブロックしている。これを**目標比率の表**を基準にする。

目標比率（既定。【要判断】毛利の意向は「3 分野は受けるが本命は物販」。数値はこの意向を Claude が置いたもの）:

| macro | 目標 |
|---|---|
| 物販 | 0.50 |
| 建設 | 0.10 |
| コンテンツ販売 | 0.10 |
| インフルエンサー | 0.10 |
| 小売 | 0.05 |
| 一般事業者 | 0.05 |
| YouTube | 0.03 |
| サロン | 0.03 |
| 卸売 | 0.02 |
| 相続贈与 | 0.02 |
| 上記以外（`ALL_MACROS` にあって表に無いもの） | 0.00（選ばれない。候補が他に無いときだけ解除） |

- 表は `data/macro-target-ratios.json` に置き、`ALL_MACROS` に無い名前があればテストで落とす。合計が 1.0 ± 0.01 でなければテストで落とす。
- ペナルティは「実績比率 − 目標比率」の超過分に対して付ける（今の `FAIR_RATIO` を目標比率に置き換える）。
- 7 日ハードキャップは macro ごとに `min(0.9, 目標 × 1.6 + 0.05)` とする（物販 0.85、建設 0.21、相続 0.08）。候補が全滅したときの解除は現状のまま。
- 週 3 本だと 7 日窓に 3 本しか入らず比率が粗い。窓を 7/14/30 のままにし、**7 日窓のハードキャップは 14 日窓の本数が 4 本以上あるときだけ効かせる**（少数で誤ブロックしない）。
- テスト: 物販が直近 14 日で 45% でもブロックされない／相続が 14 日で 15% なら 7 日キャップでブロックされる／表の合計チェック。

## R4 質疑応答起点の候補を絞る

- 国税庁「質疑応答事例」起点（`shitsugi`）の候補は、割り当て persona が次のどれかのときだけ採用する: `ebay_export_seller`、`domestic_ec_seller`、`reseller_marketplace_seller`、`construction_solo`、`content_seller`、`influencer_creator`。
- 一覧は `data/shitsugi-persona-allowlist.json` に置く。空配列なら制限なし（元に戻す手段）。
- 退職所得の申告書のような、業種に依らない事例を無理に persona に割り当てる経路があれば、その割り当てで allowlist 外になる場合は候補から外す。
- テスト: allowlist 外の persona の質疑応答候補が `topic-pool` の出力に出ない／空配列なら従来どおり。

## R5 eBay 消費税還付の中核トピックを追加する

作り直しは Codex が本文を書くのではなく、**既存の生成パイプラインで新しい 1 本として生成し、毛利が通常どおり承認する**。ここではトピックだけ追加する。

- トピックプール（`scripts/topic-pool.js` が読む定義。シナリオ展開の元データ）に次を追加する:
  - slug: `ebay-export-consumption-tax-refund-complete-guide`
  - persona: `ebay_export_seller`、macro: `物販`、article_type: `basic_explainer`、article_role: 本命
  - primary_question（例）: 「eBay で海外に販売している個人事業主です。消費税の還付を受けられると聞きましたが、どういう仕組みで、何を満たし、どんな書類を揃えて、どの順番で手続きすればよいですか。」
  - search_intent: `eBay 輸出 消費税 還付 仕組み 要件 必要書類 手順 課税事業者 選択`
  - 出典の候補（パイプラインの出典解決に任せる。【要確認】番号は Claude の記憶で、実在をパイプラインが確認する）: タックスアンサー No.6551「輸出取引の免税」、No.6613「免税事業者と仕入税額の還付」、消費税の還付申告に関する明細書の国税庁ページ。
  - 本文の狙い（プロンプトに渡す `reader_problem` / `success_outcome`）: 既存 3 本（`ebay-shouhizei-kanpu-kihon`、`ebay-export-consumption-tax-refund-guide`、`ebay-tax-refund-required-documents`）を 1 本で置き換えられる網羅度。「仕組み → 受けられる条件 → 課税事業者の選択の判断 → 必要書類 → 申告の順番 → よくある失敗」の順。
- 既存 slug との重複判定に引っかからないよう、`search_intent` の類似度で弾かれる場合は `--force-slug` 経由で生成できることを確認する（強制生成は Claude がマージ後に起動する）。
- 公開後に既存 3 本を新記事へ 301 する作業は**この段階に含めない**（別の小さな PR。毛利の承認後）。

## 変更してはいけないもの

- 承認・公開の手順（手動承認のまま）。予約公開の時刻。
- `content/posts/*.md`。
- 既存の品質ゲート（禁止表現、出典必須、本文短縮ガード）。
