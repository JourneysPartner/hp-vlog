# 01 基準日だけの改訂を分ける

README を先に読むこと。試験データは `fixtures/`（タックスアンサーの記録の新旧。`r7` が 10/1 より前、`r8` が今）。

## R1 判定（`scripts/lib/nta-content-change.js`）

1. 内容の比較に使う文（例 `substantiveBody(entry, lawVersions)`、export して試験する）: 記録の `body`（無ければ `body_combined`）を
   - NFKC にして空白をすべて除く（今の `normalizedBody` と同じ）
   - 新旧の `law_version` の文字列（NFKC・空白なしにしたもの）をすべて除く
   - 基準日の表記 `[令和N年M月D日現在法令等]` を除く（`[` `]` は無くてもよい。`令和` のほか `平成`・`元年` も。`現在の法令・通達等` の形も）
   - **最後の**「お問い合わせ先」から後ろをすべて除く。「お問い合わせ先」が無く「このコンテンツはお役にたちましたか」があれば、そこから後ろを除く
   - それ以外は何も除かない（関連リンク・根拠法令等・注記は内容として比べる）
2. `detectContentChange(existing, next, fetchedAt)` の戻り値に `as_of_changed_at` を足す:
   - 初回（`existing` なし）: `content_changed_at: null`・`content_change_kind: null`・`as_of_changed_at: null`
   - `html_hash` が同じ: 3 つとも `existing` の値を引き継ぐ（無ければ null）
   - 内容の比較の文が違う（どちらかの本文が読めないときも、今の本文の比較で違えば「違う」とする）: `content_changed_at: fetchedAt`、`content_change_kind`: `law_version` が変わっていれば `'law_version'`、でなければ `'body'`。`as_of_changed_at` は `existing` の値を引き継ぐ
   - 内容の比較の文は同じで `law_version` だけが変わった: `as_of_changed_at: fetchedAt`。`content_changed_at`・`content_change_kind` は `existing` の値を引き継ぐ
   - どちらも変わらない（空白・問い合わせ先の定型文だけ）: 3 つとも `existing` を引き継ぐ
3. 取り込み（`crawl-nta-sources.js`）は戻り値を記録に広げているので、`as_of_changed_at` も保存されることを確かめる（保存する項目を絞っている箇所があれば足す）。値が null のときに項目を書かないか null で書くかは、今の `content_changed_at` の扱いに合わせる。

## R2 索引（`scripts/lib/nta-index-builder.js`）

索引の 1 件に `as_of_changed_at: entry.as_of_changed_at || null` を足す（`content_change_kind` の次）。

## R3 補正スクリプト（`scripts/backfill-nta-content-changed.js`）

- `detectContentChange` の結果の `as_of_changed_at` も、`content_changed_at` と同じ規則で記録に書く・消す（今の 59〜60・75〜81 行と同じ形）。
- 結果の一覧（`changed`）と標準出力に、基準日だけの件も出す（例 `{ id, type, date, kind: 'as_of' }`。今の出力の形は変えずに行を足す）。
- 最後に件数の要約を 1 行出す: `内容の改訂 N 件・基準日だけ M 件`。
- `--dry-run` は書かずに数だけ出す（今のまま）。
- **このスクリプトは隔離の中で実データに流さないこと**（git の履歴を読むので遅く、2,227 件のファイルを書き換える。Claude が隔離の外で流す）。試験は `historyFile`（`firstVersions`・`previousVersions`）の形で git を使わずに行う。

## R4 候補の理由（`scripts/lib/freshness-candidates.js`）

- `SIGNAL_WEIGHTS` に `source_as_of_updated: 1` を足す。
- `sourceReason` を、内容の改訂と基準日の改訂の 2 つの理由を返せるようにする（`buildCandidates` の `reasons` に両方入る。呼び出し側の形は任せる）:
  - 内容の改訂: 今のまま（`kind: 'source_updated'`・`detail`・`where` の文を変えない）。
  - 基準日の改訂: 記事の出典のうち `as_of_changed_at` が基準（公開日、`reviewed_at` がそれより後ならそれ）より後で、**その出典の `content_changed_at` は基準より後でない**もの。いちばん新しいものを 1 つ:
    `{ kind: 'source_as_of_updated', detail: '<出典の名前>の基準日が YYYY-MM-DD に「<law_version>」へ更新（内容の変更なし）', where: '出典欄' }`
    （`<出典の名前>` は今の `sourceLabel`、日付は今の `formatDate`）
  - 内容の改訂の理由がある記事にも、別の出典の基準日の改訂の理由は付けてよい。
- `reviewed_at` の扱いは今と同じ（基準が `reviewed_at` に進むので、「確認済み」を押した後は出ない）。
- `buildRefreshPlan`（`freshness-refresh.js`）は `source_as_of_updated` を更新案の段にしない（今のコードで `fiscal_year`・`tax_reform`・`source_updated`・`fact_mismatch` しか見ていないなら変更不要。試験で確かめる）。そのため基準日の改訂だけの記事は `refreshable: false` になる。
- 通知などで理由を文にする `reasonText` は変えない（`detail` が説明になっている）。

## R5 管理画面（`netlify/functions/admin-freshness-page.js`）

- 理由の行の先頭に、種類の札を付ける: `source_updated` → `内容の改訂あり`、`source_as_of_updated` → `基準日の改訂あり`（ほかの種類は札なし）。札は `kind` から決める（`detail` の文を読まない）。見た目は既存の CSS に小さな札の型を 1 つ足す程度（例 `.tag`、内容の改訂は濃い色・基準日は薄い色）。
- 理由が `source_as_of_updated` だけ（ほかの種類なし）のカードには、ボタンの上に `内容の変更はありません。記事の記述が今も正しいか確かめて「確認済み（変更なし）」を押してください。` を出す。「更新案を作る」は出さない（`refreshable` が偽なので今の分岐で「更新案を作れる理由はありません。」が出る。その文は、このカードでは出さない）。
- すべて `escapeHtml` を通す。

## 試験

`scripts/lib/__tests__/test-freshness-as-of.js`（新規）:

1. `fixtures/ta-2200-r7.json` → `ta-2200-r8.json`（`html_hash` は違う）: `content_changed_at` は `r7` の値（null）のまま・`as_of_changed_at` が `fetchedAt`。
2. `ta-6501-r7.json` → `ta-6501-r8.json`: `content_changed_at: fetchedAt`・`content_change_kind: 'law_version'`。
3. 基準日は同じで問い合わせ先の文だけ違う（2200 の r7 の `law_version` を r8 と同じにして作る）→ 3 つとも引き継ぎ（`existing` に `content_changed_at: '2026-09-01T00:00:00Z'` を入れておき、それが残る）。
4. 基準日は同じで本文の 1 文が違う → `content_change_kind: 'body'`。
5. `html_hash` が同じ → `as_of_changed_at` も引き継ぐ。
6. 質疑応答事例（`body_combined`、`law_version: '令和7年8月1日現在の法令・通達等'` → `'令和8年8月1日現在の法令・通達等'`、本文は同じ）→ 基準日だけ。
7. 「お問い合わせ先」より前に内容の変更があり、問い合わせ先も変わる → 内容の改訂。
8. 補正スクリプト（`historyFile` を使う）: 初版・前の版（`content_changed_at` あり 9/28）・今の版（10/1、基準日だけ）→ `content_changed_at` は前の版の 9/28 のまま・`as_of_changed_at` は今の版の `fetched_at`。今の版が内容の変更 → `content_changed_at` が今の版の `fetched_at`。
9. 候補: 公開日 2026-09-01 の記事で、出典 A が基準日だけ（`as_of_changed_at` 10/1）→ 理由 `source_as_of_updated`・重み 1・`refreshable: false`・`detail` が上の形。`reviewed_at` 10/20 → 理由なし。出典 A が内容の改訂（`content_changed_at` 10/1）→ 今までどおり `source_updated`。出典 A が基準日・出典 B が内容 → 両方。
10. 管理画面: 札 2 種、基準日だけのカードの案内文、「更新案を作る」と「更新案を作れる理由はありません。」が出ないこと、`detail` に `<b>` を入れてもエスケープされること。

既存の試験（全部通すこと）: `test-nta-content-change.js`・`test-freshness-candidates.js`・`test-freshness-refresh.js`・`test-admin-freshness.js`・`test-notify-message.js`・`test-nta-index*.js`・`test-crawl-nta*.js`（あれば）。既存の期待を変える必要が出たら、変える前に最終報告に【要判断】で理由を書く。

## 確かめること（隔離の中でやってよい）

- `node scripts/backfill-nta-content-changed.js --dry-run` は**流さない**（R3 の通り。Claude が外で流す）。
- 代わりに、`data/nta-sources/taxanswer/shotoku/2200.json` と `fixtures/ta-2200-r7.json` を `detectContentChange` に渡し、基準日だけと判定されることを試験 1 と同じく確かめる。

## 変更してはいけないもの

- `data/` の中のファイル（補正の結果・候補の JSON は Claude が外で作る）
- `check-master-freshness.js`・`data/tax-simulator/`・シミュレーターのマスタ
- `source_updated` の文・重み・`buildRefreshPlan` の今の段の作り方
- `admin-freshness-action.js`（「確認済み」の処理）
