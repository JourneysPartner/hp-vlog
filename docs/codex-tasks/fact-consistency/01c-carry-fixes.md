# 01c 止めた理由の引き継ぎの穴を塞ぐ（レビュー 2 回目の直し）

レビュー 2 回目（`review-01b.md`、結論「直してからマージ」。Critical・High は 0）の新しい Medium 2 件と Low 1 を直す。01・01b の要件と安全の条件はそのまま有効。要件の番号は 01b の続き。

## 直すこと

### R24（Medium 1）B の記録に「直した文」を持たせ、失敗の引き継ぎを切らさない

今は、引き継いだ `failed` が `corrections: []` で保存される。そのため、次の照合で直した文（after）を引けず、2 回目の引き継ぎで切れる。また、今回 B が別の直しで動くと、前回の `failed` は引き継がれない。

- B の記録（成功・失敗とも）に `afters: applied.map(f => f.after)` を足す。
- `checkArticle` の `previous_consistency_afters`:
  - 記録の `consistency.afters` が文字列の配列なら、それを使う（空の文字は除く）。
  - 無い古い記録だけ、今の id の引き方にする。id は照合ごとに振り直されるので、新しい記録では id で引かない。
- `checkFacts` で `failed` を引き継ぐ条件を次にする。
  - `previous_consistency.failed === true`
  - `previousAfters` が 1 件以上あり、全部が最後の本文に在る
  - 今回の B が、その直した文を全部確かめていない。つまり、今回 B が成功していて、`previousAfters` の全部が今回の applied の after に含まれる場合は引き継がない。それ以外（今回 B が動いていない・失敗した・前回の直した文を含んでいない）は引き継ぐ。
- 引き継ぎ方:
  - 今回の `record.consistency` が無い: `{ checked: false, failed: true, carried: true, corrections: [], afters: previousAfters, findings: [], dropped: 0 }`
  - 今回の `record.consistency` が在る: `failed: true`・`carried_failure: true` を足す。`afters` は今回のものと `previousAfters` を合わせ、重複を除いたものにする。今回の findings・dropped はそのまま残す。
- 画面（`renderFactConsistency`）: `failed` のとき、失敗の文を出したうえで、findings があればその一覧も続けて出す（今は失敗の文だけで、引き継いだ指摘や今回の指摘が隠れる）。`carried_failure` なら、失敗の文に `（前回の照合から引き継ぎ）` を添える。

### R25（Medium 2）照合が `not_run` の回でも、前回の止めた理由を記録に残す

今は、API の失敗・抜き出しの失敗・中断・照合の無効（`FACT_CHECK_ENABLED=false`）で `not_run` になった回が、`consistency` の無い記録でファイルを上書きする。そのため、次の照合で引き継ぎが消える。

- `checkArticle` で、`checkFacts` の結果の `record.status === 'not_run'`、結果に `consistency` が無く、前回の記録の `consistency` を読めていたら、保存する記録に前回の `consistency` を写す。
  - 写すときは `carried: true` を付ける。findings の各行にも `carried: true` を付ける。
  - `afters` は R24 の `previous_consistency_afters` を入れる。
- このとき `record.status`・`record.summary`・`fact_check_blocking` は変えない（`not_run` のまま。止めるかは今の `not_run` の扱いどおり）。
- `not_run` 以外の回は写さない。ふつうの照合で文字が無くなって引き継がなかった回に、古い指摘を戻してはいけない。

### R26（Low 1）中断の試験を B まで届かせる

R9 の中断の試験は、偽の AI が `consistency_check` を受けたときに `controller.abort()` してから例外を投げる形にする。そのうえで、次を見る。

- `record.calls` に `consistency_check` がある
- `record.status` が `not_run`
- `consistency.failed` が付いていない（B の失敗として記録していない）

B の `if (options.signal?.aborted) throw error;` を消すとこの試験が落ちることを、報告で確かめる。

### R27 指示書の文の直し（コードは変えない）

`01b-review-fixes.md` の R17 の「`repair: false`（…）は `previous_consistency` を渡さないので変わらない」は、実装と合っていない。`checkArticle` を通る道は、`repair: false` でも引き継ぐ（その道も記録のファイルを上書きするので、引き継ぐ方が安全）。`checkFacts` を直接呼ぶ公開済みの一括照合は、今のとおり引き継がない。この直しは司令役が README と 01b に書くので、実装担当は変えなくてよい。

## 試験（`test-fact-consistency.js` に足す）

- T30（R24）:
  - 前回が `failed`（直した文が本文に在る）の記録で、直しの無い照合を 3 回続けても `revise` のまま。3 回目の記録にも `afters` が在る。
  - 前回が `failed` で、今回は別の文の直しで B が動いて成功した → `failed`・`carried_failure` が付き、今回の findings も残る。画面に失敗の文と findings の両方が出る。
  - 前回が `failed` で、今回 B が同じ直した文を含んで成功した → 引き継がない。
  - `afters` の無い古い記録は、id で引いて今までどおり引き継ぐ。
- T31（R25）: 要約の指摘が 1 件の記録で、ふつう（`revise`）→ API が全部失敗（`not_run`。保存した記録に `carried: true` の `consistency` が在る）→ ふつう（要約が同じ文なら `revise`）。照合を無効にした回（`enabled: false`）でも同じく写す。ふつうの回で文字が無くなったら写さず `ok`。
- T32（R26）: 上のとおり。

## 記録に回すもの（直さない）

- レビュー 2 回目の Low 2: 引き継いだ指摘は判定し直さないので、AI の誤検出も文字が残る限り止め続ける。確認欄の印は、次の照合で消える。`where: 'body'` は本文全体で文字を探すので、短い text は残りやすい。どれも止める側に倒れる。
- レビュー 2 回目の Low 3: `where` が範囲・複数の番号（`"12-13"`・`"12, 13"`）だと、答え全体が `failed` になる。本物の AI で多いようなら、後で扱いを決める。
- `generate-draft.js` の catch が書く未実施の記録（記録の保存に失敗したときだけの道）は、`consistency` を残さない。変えてはいけないファイルなので、そのままにする。
- 再生成の側は照合記録の中身を読まず、要約の件数しか伝わらない（前からの穴）。

## 変えてよいファイル

01 と同じ。主に `scripts/lib/fact-check.js`（B の記録・引き継ぎ・`checkArticle`）・`netlify/functions/review-page.js`（`renderFactConsistency`）・`scripts/lib/__tests__/test-fact-consistency.js`。
