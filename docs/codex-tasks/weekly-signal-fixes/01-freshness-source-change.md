# 01 国税庁データに「内容が変わった日」を持たせ、鮮度はそれだけを使う

背景は `README.md` の「問題 1」。

## 実装要件

### R1 取り直し時に「内容が変わったか」を記録する（`scripts/crawl-nta-sources.js`）

taxanswer と shitsugi の両方の保存処理（`action === 'fetched'` のあと、`stored` を組み立てる箇所）で、既存の保存データ（`existing`。無ければ新規）と比べて次の 3 項目を付ける。

- `first_fetched_at`: `existing.first_fetched_at || existing.fetched_at`。新規なら今回の `fetchedAt`。
- `content_changed_at`:
  - 新規（existing 無し）→ 付けない（`null`）。初回の取り込みは改訂ではない。
  - 既存あり、かつ **本文か法令基準日が変わった** → 今回の `fetchedAt`。
  - 既存あり、かつ変わっていない（HTML だけ変わった）→ `existing.content_changed_at || null` を引き継ぐ。
- `content_change_kind`: 変わったときに `'law_version'`（法令基準日が変わった。本文も変わっていてもこちらを優先）か `'body'`（本文だけ）。変わっていなければ `existing.content_change_kind || null` を引き継ぐ。

「本文が変わった」の判定は、`body` を NFKC 正規化して空白をすべて除いた文字列同士の比較。`body` が無いデータ（shitsugi の形式が違う場合）は、その形式の本文に当たる項目で同じ比較をする。法令基準日は `law_version` の文字列比較（どちらかが空なら比較しない）。

比較の関数は `scripts/lib/nta-content-change.js`（新規）に置き、`detectContentChange(existing, next, fetchedAt)` が上の 3 項目を返す形にする。非 incremental（全件取り直し）でも同じ関数を通すこと。全件取り直しで内容が同じなら `content_changed_at` は動かない。

### R2 索引に載せる（`scripts/lib/nta-index-builder.js`）

index.json の各項目に `first_fetched_at`・`content_changed_at`・`content_change_kind`・`law_version` を追加する（無ければ `null`）。既存の項目と並び順は変えない（末尾に追加）。

### R3 鮮度は「内容が変わった日」だけを使う（`scripts/lib/freshness-candidates.js`）

- `sourceReason()` は `entry.content_changed_at` が記事の日付より後のものだけを対象にする。`fetched_at` は使わない。並び替えも `content_changed_at` の新しい順。
- 理由の文言: `${sourceLabel(entry)}の本文が ${formatDate(entry.content_changed_at)} に改訂` とし、`content_change_kind === 'law_version'` のときは末尾に `（${entry.law_version} に更新）` を付ける。`where: '出典欄'` は変えない。
- `readNtaEntries()` のデータ鮮度チェック（`last_checked_at || fetched_at` と meta.json）は変えない。

### R4 既存データの補正（一度だけ実行するスクリプト）

`scripts/backfill-nta-content-changed.js [--dry-run]`（新規）。

- 対象: `data/nta-sources/` の taxanswer・shitsugi の保存データ全件。
- `first_fetched_at` が無い項目は、git 履歴でそのファイルが最初に追加されたコミットの版の `fetched_at` を入れる（`git log --diff-filter=A --format=%H -- <file>` と `git show <commit>:<file>`）。履歴が取れなければ現在の `fetched_at`。
- `fetched_at` が最初の版の `fetched_at` と違う項目（＝あとで取り直した項目。2026-09-28 時点で 8/1 の 19 件程度）は、取り直し直前の版（`git log --format=%H -- <file>` で現在の 1 つ前の版）と R1 と同じ関数で比べ、変わっていれば `content_changed_at` と `content_change_kind` を入れる。
- 書き換えたあと、既存の索引生成（crawl-nta-sources.js が index.json を作るのと同じ関数）で `index.json` を作り直す。
- `--dry-run` は書き込まず、補正する件数と、`content_changed_at` が付く項目の一覧（id・種類・日付・kind）を表示する。
- git の読み取り（log/show）だけを使い、git への書き込みはしない。

実データで本実行し、結果のデータ変更もこのブランチに含める（コミットは別の担当が行う）。

## テスト

`test-freshness-candidates.js` と `test-nta-index-builder.js` に追加し、R1 の関数には新しいテスト `scripts/lib/__tests__/test-nta-content-change.js` を作って `package.json` の `masters:test` の連鎖の末尾に登録する。

- 新規の取り込みでは `content_changed_at` が付かない。
- HTML ハッシュだけ違い本文と法令基準日が同じ → 付かない（既存の値は引き継ぐ）。
- 本文が違う → `body`、法令基準日が違う → `law_version`。
- 空白・全角半角だけの違いは変更と数えない。
- 鮮度: `fetched_at` が記事より新しくても `content_changed_at` が無ければ `source_updated` にならない。`content_changed_at` が記事より新しければなる。文言が R3 のとおり。
- 補正スクリプト: 一時ディレクトリに作った小さな git リポジトリ（2 版の保存データ）で、取り直しで本文が変わった項目だけに `content_changed_at` が付く。
- 索引: 追加した 4 項目が載り、既存項目の値と順番が変わらない。

## 変更してはいけないもの

- 国税庁データの既存項目の意味（`fetched_at` は「最後に取り直した日時」のまま）。
- クローラーの取得・スキップの判断（HEAD・etag・ハッシュ比較）。
- 鮮度の他の信号、重み（`SIGNAL_WEIGHTS`）、上位件数。
- `content/posts/*.md`。
