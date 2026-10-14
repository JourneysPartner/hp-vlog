# 01 取り下げた題材の記録と、次の候補を試す

背景と数字は `README.md`。ここでは実装要件だけを書く。

## R1 取り下げ記録のファイルと読み書き

新しいデータ `data/withdrawn-topics.json`:

```json
{
  "version": 1,
  "comment": "日次生成で取り下げた題材。通常の選定では二度と選ばない。項目を消せば選定に戻る。",
  "entries": [
    {
      "topic_id": "suggest-furima-sedori-1e1ea0",
      "stage": "postgen-dedup",
      "similar_to": "reselling-profit-bookkeeping-beginners",
      "reason": "せどり・転売の確定申告における帳簿記録・利益計算という同じ論点",
      "url_slug": "sedori-kakutei-shinkoku-chobo-guide",
      "target_query": "せどり 確定申告 やり方",
      "date": "2026-10-02",
      "run_url": "https://github.com/JourneysPartner/hp-vlog/actions/runs/36944187851"
    }
  ]
}
```

- `topic_id` は候補プール上の `topic.slug`（生成時の `topic_id`）。URL slug ではない（同じ題材でも URL slug は実行ごとに変わる。9/30 は `…-yarikata`、10/2 は `…-guide`）。
- `stage` は次のどれか:
  - `select-dedup` … 選定時の AI 重複判定で除外（`pickPair` の最初の判定と補充の判定の両方）
  - `url-slug-taken` … URL slug が既存記事・未マージ下書きと衝突
  - `target-query-owned` … 狙う検索語を既存記事が持っている
  - `target-query-withdrawn` … 狙う検索語が、取り下げ記録のある語と同じ（R3）
  - `postgen-dedup` … 生成後の重複判定で取り下げ
- `similar_to`・`url_slug`・`target_query`・`run_url` は分かるときだけ（無ければ空文字）。`reason` は 200 文字で切る。`date` は JST の YYYY-MM-DD。`run_url` は `GITHUB_SERVER_URL`・`GITHUB_REPOSITORY`・`GITHUB_RUN_ID` から組み立てる。
- 新しいモジュール `scripts/lib/withdrawn-topics.js` に、読み込み・追記・照合をまとめる。
  - 読み込み: ファイルが無ければ空。JSON が壊れていれば警告を出して空として扱う（生成は止めない）。
  - 追記: 同じ `topic_id`＋`stage`＋`date` の組は 1 件にまとめる。既存項目の順番と中身は変えず、末尾に足す。出力は 2 スペースのインデント＋末尾改行。
  - 照合: `topic.slug === entry.topic_id` で一致。狙う検索語の照合は空白（半角・全角）をそろえて小文字にした完全一致。
- 書き込み先:
  - 環境変数 `WITHDRAWN_OUT` があれば、**今回の新しい項目だけ**をそのパスに JSON 配列で書く。`data/withdrawn-topics.json` は触らない（ワークフローが R5 で main に反映する）。
  - 無ければ（手元での実行）`data/withdrawn-topics.json` に直接追記する。
- `--force-slug`（手動指定）の実行では記録しない（人が選んだ題材なので）。

### 初期データ（このブランチで作る）

2026-09-28〜10-09 の実行ログから、次の 8 件を入れる（run の URL は `https://github.com/JourneysPartner/hp-vlog/actions/runs/<run>`）。

| topic_id | stage | date | run | similar_to | url_slug | target_query | reason |
|---|---|---|---|---|---|---|---|
| suggest-furima-sedori-1e1ea0 | select-dedup | 2026-09-28 | 36360855055 | reseller-profit-bookkeeping-beginners | | | 選定時の重複判定で除外（ログに理由なし） |
| suggest-ec-kakutei-a57de4 | select-dedup | 2026-09-28 | 36360855055 | | | | 補充候補も重複（ログに理由・相手なし） |
| suggest-furima-sedori-1e1ea0 | postgen-dedup | 2026-09-30 | 36648533889 | reselling-profit-bookkeeping-beginners | sedori-kakutei-shinkoku-chobo-yarikata | せどり 確定申告 やり方 | せどりの帳簿記録から確定申告までの全体的な手順を扱う記事であり、論点（せどり利益計算と帳簿付けの基本）が同一 |
| suggest-furima-sedori-1e1ea0 | postgen-dedup | 2026-10-02 | 36944187851 | reselling-profit-bookkeeping-beginners | sedori-kakutei-shinkoku-chobo-guide | せどり 確定申告 やり方 | せどり・転売の確定申告における帳簿記録・利益計算という同じ論点 |
| suggest-zouyo-hikazei-351e52 | select-dedup | 2026-10-07 | 37550072199 | suggest-zouyo-hikazei-5be58f | | | 住宅取得のための贈与税非課税制度という同一の論点で、未承認下書き「贈与税非課税制度の種類と選び方」に包含される |
| suggest-souzoku-tetsuduki-4ff059 | select-dedup | 2026-10-07 | 37550072199 | | | | 補充候補も重複（ログに理由・相手なし） |
| suggest-zouyo-hikazei-351e52 | select-dedup | 2026-10-09 | 37862926041 | suggest-zouyo-hikazei-5be58f | | | 10/7 と同じ理由で再び除外 |
| suggest-souzoku-tetsuduki-4ff059 | postgen-dedup | 2026-10-09 | 37862926041 | inheritance-within-10months-inheritance-filing-guide | inheritance-procedure-deadlines-extensions | 相続 手続き 期限 | 相続手続きの期限全般を扱う基本情報で、既存の「相続税申告を10ヶ月以内に進める」記事と論点（相続手続きの期限管理）が重複 |

## R2 選定から外す

- `scripts/lib/topic-selector.js` の `selectDailyTopics` に、2.7 の denylist フィルタの直後で `filter-withdrawn` を足す。`explanation.steps` に `{ step: 'filter-withdrawn', blocked, remaining, blockedDetails（先頭 5 件: slug・stage・date） }` を積む（既存のログ出力でそのまま表示される）。
- 取り下げ記録は `selectDailyTopics` の options（例: `withdrawn`）で渡せるようにし、渡されなければファイルから読む（テストで差し替えるため）。
- `--force-slug` の経路は選定を通らないので、今までどおり記録を無視する。
- `regenerate-draft`（差し戻し再生成）の経路は選定を通らないので影響しないことを確かめる。

## R3 1 本モードで次の候補を試す

`DRAFT_COUNT` が 1（既定）のときだけ、`generate-draft.js` の流れを「1 本できるか上限に達するまで繰り返す」に変える。2 本モードは R1・R2 の記録と除外だけを足し、繰り返しは入れない。

- 上限（環境変数で変えられる。不正値は既定に戻す）:
  - `DRAFT_MAX_CANDIDATES`（既定 5）… 1 回の実行で確認する候補の数。選定時の AI 重複判定に回した候補を 1 件と数える。
  - `DRAFT_MAX_GENERATIONS`（既定 2）… 本文生成（LLM での本文作成）の回数。
- 1 件ごとの流れ（既存の処理を同じ順で使う。判定の中身は変えない）:
  1. 選定: これまでに試した topic_id と取り下げ記録を除いて `selectDailyTopics` で 1 件選ぶ。「需要の証拠の種類は 1 日 1 件」の既存の規則（`demandKindOf`）は保つ。候補が無ければ終わり。
  2. 選定時の AI 重複判定。重複なら記録（`select-dedup`）して次へ。
  3. 出典の補完（`ensureSourceOnTopic`・`enrichTaxTerms`・`enrichSourceWithLLM`）。
  4. 狙う検索語と URL slug の確定。URL slug の衝突（`url-slug-taken`）、狙う検索語の持ち主あり（`target-query-owned`）、狙う検索語が取り下げ記録の語と同じ（`target-query-withdrawn`）なら記録して次へ。ここまでは本文生成の費用がかからない。
  5. 本文生成の上限に達していたら終わり。達していなければ本文を生成し、既存の自己点検と生成後の重複判定を行う。重複ならファイルを消して記録（`postgen-dedup`）して次へ。
  6. 重複でなければ下書き 1 本として確定し、繰り返しを終える。
- 候補の確認数の上限に達したら終わり。終わったときに 0 本なら、`single_reason` に試した候補ごとの結果を並べる（例: `1) suggest-a → 選定時に重複（相手 x） / 2) suggest-b → 生成後に重複（相手 y） / 上限 5 件に達したため本日は生成しません`）。改行は空白にし、600 文字で切る。
- ログ: 候補ごとに `[generate] 試行 n/上限: <topic_id> → <結果>` を出す。既存のログ行（`=== topic selection ===` や各フィルタの件数）は残す。
- 関数の分け方は任せるが、テストで LLM 呼び出し（AI 重複判定・生成後の重複判定・狙う検索語・本文生成）を偽の関数に差し替えられるようにする。

## R4 本番ビルドの対象外にする

`data/withdrawn-topics.json` だけの変更では本番ビルドしない。`scripts/lib/netlify-ignore.js` に「ビルド不要な個別ファイル」として足す（`data/` 全体は足さない。他のデータはサイトに使われる）。`test-netlify-ignore.js` に「このファイルだけの変更はビルドしない」「このファイル＋記事の変更はビルドする」を足す。

## R5 ワークフローで main に記録を残す

`.github/workflows/daily-draft.yml`:

- 「Generate draft」ステップの env に `WITHDRAWN_OUT: /tmp/withdrawn-new.json` を足す。
- 最後（記事の枝と PR を作るステップと通知の後）に、新しいステップ「Record withdrawn topics on main」を足す。`if: always()`（生成が途中で失敗しても、それまでの記録は残す）。
  - `/tmp/withdrawn-new.json` が無いか空配列なら何もしない。
  - `git fetch origin main` → `git checkout -B withdrawn-record origin/main`（記事ファイルは既に各枝に push 済みなので、main に切り替えて失うものは無い）。切り替えに失敗したら `::warning::` を出してステップを成功で終える。作業ツリーを消す操作（`git reset --hard`・`git clean`）は使わない。
  - 追記用の小さなスクリプト（例: `node scripts/record-withdrawn-topics.js /tmp/withdrawn-new.json`）で `data/withdrawn-topics.json` に足す。R1 と同じ追記関数を使う。
  - `data/withdrawn-topics.json` だけを `git add` し、`chore(draft): 取り下げた題材を記録 (YYYY-MM-DD)` でコミットして `git push origin HEAD:main`。失敗したら `git pull --rebase origin main` して最大 3 回まで再試行。最後まで失敗したら `::warning::` を出してステップは成功で終える（下書きの方が大事）。
- 既存のステップの順番・条件・文言は変えない（追加のみ）。
- 注意: `scripts/lib/__tests__/test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、コミット前は必ず落ちる。直さないこと（コミット後に別の担当が通ることを確かめる）。

## テスト（新しいファイル `scripts/lib/__tests__/test-withdrawn-topics.js`、必要なら既存のテストに追記）

1. 読み込み: ファイル無し → 空。壊れた JSON → 警告して空。
2. 追記: 同じ topic_id＋stage＋date は 1 件。既存の項目は順番も中身も変わらない。`WITHDRAWN_OUT` があるときは data のファイルを触らない。`--force-slug` では記録しない。
3. 選定: 取り下げ記録にある topic_id は `filter-withdrawn` で外れ、`explanation.steps` に件数が出る。記録が空なら従来と同じ結果。
4. 繰り返し（偽の LLM）:
   - 1 件目が選定時に重複 → 2 件目が生成後に重複 → 3 件目で下書き 1 本。記録は 2 件（`select-dedup`・`postgen-dedup`）。本文生成は 2 回。
   - 本文生成の上限 2 回に達したら、3 件目は本文を作らずに終わり、0 本と理由が出る。
   - 候補の確認が 5 件に達したら終わり、0 本と、試した 5 件の理由が出る。
   - 狙う検索語が取り下げ記録の語と同じ候補は、本文を作らずに `target-query-withdrawn` で次へ進む。
   - 1 件目でそのまま下書きができたときは、試行は 1 件で終わり、記録は 0 件（従来と同じ結果）。
5. 2 本モード: 繰り返しは入らない（従来どおり）。取り下げは記録される。
6. 上限の環境変数: 未設定・空・0・負・文字列 → 既定値。
7. 初期データ: `data/withdrawn-topics.json` が上の表の 8 件どおり（topic_id・stage・date・similar_to・url_slug・target_query）。
8. 実データ: 今の候補プールで `selectDailyTopics` を呼ぶと、`filter-withdrawn` が 4 つの topic_id（suggest-furima-sedori-1e1ea0・suggest-ec-kakutei-a57de4・suggest-zouyo-hikazei-351e52・suggest-souzoku-tetsuduki-4ff059）のうちプールに残っているものを外し、選ばれた題材がその 4 つ以外であること。結果（外した件数と選ばれた topic_id）を最終報告に書く。

## 変更してはいけないもの

- 既存の選定フィルタ・閾値・優先度の計算、AI 重複判定と生成後の重複判定の中身とプロンプト、記事生成プロンプト。
- `--force-slug` の挙動（記録しないこと以外は従来どおり）、2 本モードのペア生成。
- `content/posts/*.md`、`data/topic-denylist.json`、`data/search-suggest-topics.json`、`data/gsc-topics.json`。
- `regenerate-draft.yml`・`publish-scheduled.yml`・差し戻し再生成の経路。
