# 02 週次レポートに 4 節を足す

data/search-console/report.md（scripts/report-search-console.js）に次の 4 節を足す。置き場所は「狙った語の順位」の直後。週次のワークフロー（fetch-search-console.yml）はこのスクリプトを既に呼んでいるので**ワークフローは変えない**。

## R8 設定ファイル data/gsc-link-config.json（新規）

```json
{
  "_note": "週次レポートの内部リンクの候補と長い質問の検索語の条件。target_macros は今リンクを足す対象の業種ハブ。exclude_slugs は exclude_until までは対象外（eBay の統合の効果を 11/23〜29 に確かめるため、リンクで効果を混ぜない）。",
  "position_min": 4,
  "position_max": 20,
  "min_impressions": 20,
  "target_macros": ["小売", "建設"],
  "exclude_slugs": [
    "ebay-export-consumption-tax-refund-complete-guide",
    "ebay-taxable-vs-exempt-business",
    "ebay-export-invoice-system-impact",
    "ebay-growth-incorporation-threshold-guide",
    "ebay-growth-expense-grayzone-guide"
  ],
  "exclude_until": "2026-11-30",
  "min_query_tokens": 3,
  "question_words": ["どっち", "とは", "いつまで", "しないと", "どうなる", "ばれ", "バレ", "いくら", "必要", "違い", "やり方", "方法", "かかる", "できる", "?", "？"]
}
```

設定ファイルが無いときは、この既定値で動く（レポートは止めない）。

## R9 節「内部リンクの候補（順位 4〜20 位）」

- 対象: pages の記事ページ（pageKind が「記事」）で、position が position_min〜position_max、impressions が min_impressions 以上。表示回数の多い順、最大 20 行。
- 列: 記事（題名、無ければ slug）／業種（hubMacroOf）／表示／クリック／順位／Google 登録（index-status の isIndexed で ○・×・不明）／**本文からのリンク数**／主な検索語（query-page からその記事の検索語を表示回数の多い順に最大 3 つ、無ければ「（伏せられています）」）／今回の対象。
- 本文からのリンク数: 公開中の全記事の本文に、01 の `linkInternal` を build と同じ入力（辞書・指定ファイル・pickup の中核記事）で当てたとき、その記事へのリンクを含む記事の数。build を呼ばずに計算する。
- 今回の対象: 業種が target_macros に入り、かつ（今日が exclude_until より前なら）exclude_slugs に無いとき「○」。それ以外は「業種外」か「eBay の確認中」。
- 節の頭に 1 行:「Claude がこの表と本文を読んでリンク案（リンク元・言い回し・行き先）を作り、承認されたものを data/internal-link-placements.json に足します。」

## R10 節「足したリンクのその後」

- data/internal-link-placements.json の enabled の行を行き先ごとにまとめる。
- 列: 行き先（題名）／リンク元の数（本文で実際に付いた数と指定の数。例「2/3」）／追加日（最も早いもの）／経過週／基準の順位・表示・クリック（baseline。無ければ「—」）／今の順位・表示・クリック（pages）／順位の差（小さくなれば改善。「+1.2 位改善」のように書く）。
- 指定が 0 件なら「（まだありません）」。

## R11 節「長い質問の検索語」

- queries のうち、語の数（半角・全角の空白で区切る）が min_query_tokens 以上、または question_words のどれかを含むもの。表示回数の多い順、最大 20 行。
- 列: 検索語／表示／クリック／順位／該当ページ（bestImpressionPage。記事なら slug）。
- 60 字を超える、または `question:` を含む検索語は別の小さな表「AI が代わりに検索したとみられる語」に分ける（同じ列）。
- 節の頭に 1 行:「Google は件数の少ない検索語を伏せるため、ここに出るのは一部です（20261101 では表示の約 8%）。」の趣旨（数字は固定で書かず、その週の queries と pages の表示合計から計算する）。

## R12 節「辞書の行き先の点検」

- data/internal-link-terms.json の enabled の行のうち、行き先が無い・未公開・統合済み（merged。merged_into があれば併記）のものを表にする（語・行き先・状態）。
- さらに、enabled の行き先のうち、この期間の pages に表示が無いものの**数**を 1 行で書く。
- 該当が無ければ「（問題ありません）」。

## R13 試験

test-search-console-ingest.js（または新しい試験ファイル。新しくしたら masters:test の末尾に足す）で、作った小さなデータから 4 節の中身を確かめる:
- R9: 範囲外の順位・表示不足・記事以外は出ない。今回の対象の判定（業種外・除外期間の前と後）。本文からのリンク数が辞書と指定リンクの両方を数える。
- R10: baseline あり・なし、0 件。
- R11: 3 語以上・質問の語・AI 風の語の振り分け。
- R12: 統合済みの行き先が出る。
- 設定ファイルが無くても既定値で動く。

## 変更してはいけないもの

- 既存の節の中身と順番（新しい節は「狙った語の順位」の直後に足すだけ）
- .github/workflows/、scripts/fetch-search-console.js、scripts/update-gsc-topics.js
