# 01 変更判定を作る

7つのワークフローが同じ判定を必要とするので、**共有のスクリプトを1本作って各ワークフローから呼ぶ**。
YAML を7箇所それぞれ書き換えるのはやめること（同じ抜けを7回作ることになる）。

## A. `scripts/has-substantive-change.js`（新規）

```
node scripts/has-substantive-change.js data/nta-sources
node scripts/has-substantive-change.js data/contact-transitions.json
```

引数に1つ以上のパス（ディレクトリまたはファイル）を取り、**時刻を除いた中身**に変更があるかを判定する。

### 判定

| 状況 | 結果 |
|---|---|
| 追跡外の新規ファイルがある | 変更あり |
| ファイルが消えている | 変更あり |
| JSON 以外のファイルに差分がある | 変更あり |
| JSON の差分が時刻フィールドだけ | **変更なし** |
| JSON に時刻以外の差分がある | 変更あり |
| JSON として読めないファイルに差分がある | 変更あり（安全側） |

### 出力

標準出力に `changed=true` または `changed=false` の1行。
終了コードは**常に 0**（差分の有無で exit code を変えない。`set -e` のワークフローで事故るため）。

変更ありのときは、何が変わったかを標準エラーに出す。

```
[change] data/nta-sources/shitsugi/gensen/04.json  中身に差分
[change] data/nta-tsutatsu/shotoku.json            中身に差分
[skip]   data/nta-sources/meta.json                時刻のみ（last_crawl_started_at ほか2件）
```

### 時刻とみなすキー

キー名が次のいずれかに当たるものを、比較の前に**再帰的に取り除く**。

- `_at` で終わるもの（`fetched_at` `generated_at` `updated_at` `checked_at`
  `last_crawl_started_at` `last_crawl_finished_at` `next_scheduled_at`
  `last_checked_at` `figures_checked_at` がこれで拾える）
- `last_crawl_duration_seconds`

取り除いたキーの名前は、上の `[skip]` 行に出すこと。将来「実は意味のあるフィールドだった」と
気づけるようにするため。

> 値は見ない。キー名だけで判断する。日時の形をしているかを調べ始めると、
> 形の違う時刻を取りこぼす。

### 比較の方法

`git show HEAD:<path>` で変更前を、ワークフォルダの中身を変更後として読み、
どちらも時刻キーを落としたうえで**キー順を揃えた JSON 文字列**にして比較する。

配列の順序は意味があるので**並べ替えない**。オブジェクトのキー順だけ揃える。

## B. 各ワークフローから呼ぶ

いまの判定を差し替える。たとえば `crawl-nta-sources.yml`:

```yaml
- name: Check for changes
  id: changes
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    node scripts/has-substantive-change.js data/nta-sources >> "$GITHUB_OUTPUT"
```

スクリプトが `changed=true` / `changed=false` を出すので、後段の条件は
`steps.changes.outputs.changed == 'true'` になる。**既存の `has_changes` を参照している
箇所（PR 作成の `if:`、通知、サマリ）を全部追随させること。** 取りこぼすと通知が壊れる。

対象と引数:

| ワークフロー | 引数 |
|---|---|
| `crawl-nta-sources.yml` | `data/nta-sources` |
| `crawl-nta-tsutatsu.yml` | `data/nta-tsutatsu` |
| `refresh-nta-qa.yml` | `data/nta-qa` |
| `crawl-law-sources.yml` | `data/law-sources` |
| `export-contact-transitions.yml` | `data/contact-transitions.json` |
| `update-suggest-topics.yml` | `data/search-suggest-topics.json data/search-suggest` |
| `check-tax-reform.yml` | `data/tax-reform-outline.json` |

`crawl-law-sources` `update-suggest-topics` `export-contact-transitions` は
`git add` したあとに `git diff --cached --quiet` で見ている。スクリプトは
**ステージの有無にかかわらず**判定できるようにすること（`git diff HEAD` 相当を見る）。

## C. 変更が無かったときのログ

PR を立てない回も、実行したことは分かるようにする。
各ワークフローの既存のサマリ出力（`$GITHUB_STEP_SUMMARY` や通知）に

```
■ 変更なし（時刻のみ更新のため PR は作成しません）
```

と出す。すでに「変更なし」の分岐があるワークフローは、その文言に合わせてよい。

## D. 時刻の更新は止めない

`fetched_at` などを書くのをやめてはいけない。いつ取得したかは記録として要る。
**PR を立てないだけ**で、ファイルはそのまま（コミットされずに捨てられる）。
