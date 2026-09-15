# 02 テスト

## 新規 `scripts/lib/__tests__/test-has-substantive-change.js`

判定のロジックを、git に触らずテストできる形にしておくこと。
`scripts/has-substantive-change.js` から次を切り出して `module.exports` に出す。

```js
stripTimestamps(value)      // 時刻キーを再帰的に落とした複製を返す
isSameContent(before, after) // 時刻を除いて同じかを返す
TIMESTAMP_KEY_RE            // 時刻とみなすキーの判定
```

### `stripTimestamps`

- 浅い形: `{a:1, fetched_at:'x'}` → `{a:1}`
- 入れ子: `{meta:{generated_at:'x', n:3}}` → `{meta:{n:3}}`
- 配列の中: `[{fetched_at:'x', no:'1'}]` → `[{no:'1'}]`
- **配列の順序を変えない**: `[{n:2},{n:1}]` はそのまま
- `last_crawl_duration_seconds` が落ちること
- `_at` で終わらない普通のキーは残ること（`format` `treat` `at_home` など)
- `null`・数値・文字列をそのまま渡しても落ちないこと

### `isSameContent`

- 時刻だけ違う → `true`（同じ扱い）
- 本文が1文字違う → `false`
- キーの順序だけ違う → `true`
- 配列の要素の順序が違う → `false`（順序に意味があるため）
- 片方に新しいキーが増えた → `false`
- `deleted: true` が付いた（他は時刻のみ変化）→ `false`（**必ず拾うこと**）

### 実データでの確認

実際に取り込み済みの JSON を1つ読み、自身と比べて `true` になること。
時刻フィールドを書き換えた複製と比べても `true` になること。
中身を1つ書き換えた複製と比べると `false` になること。

## ワークフローの整合（`scripts/lib/__tests__/test-workflow-change-detection.js` を新規、または既存のワークフロー検査に追加）

YAML を読んで、次を確かめる。**これが今回いちばん壊れやすいところ。**

- 対象7ファイルが `scripts/has-substantive-change.js` を呼んでいること
- 旧来の `has_changes` を参照している箇所が残っていないこと
  （`steps.changes.outputs.has_changes` の grep がゼロ件）
- PR 作成ステップの `if:` が新しい出力名を見ていること
- 記事系（`daily-draft.yml` `publish-scheduled.yml` `regenerate-draft.yml`）は
  **変更されていないこと**

## 回帰確認

```
node scripts/lib/__tests__/test-has-substantive-change.js
node scripts/lib/__tests__/test-workflow-change-detection.js
node scripts/lib/__tests__/test-tsutatsu.js
node scripts/lib/__tests__/test-tsutatsu-bridge.js
node scripts/lib/__tests__/test-law-sources.js
node scripts/lib/__tests__/test-selector.js
npm run build
```

`npm run build` は `assets/js/tax-simulator-boot.js` に差分を出すことがある。
出たら `git checkout -- assets/js/tax-simulator-boot.js` で戻すこと。

## 手で確かめてほしいこと

作業ツリーで次を実行し、出力が期待どおりになること。

```
# 何も変えていない状態（変更なしのはず）
node scripts/has-substantive-change.js data/nta-tsutatsu

# 時刻だけ書き換える（変更なしのはず）
#   data/nta-tsutatsu/shotoku.json の fetched_at を適当な値に

# 中身を書き換える（変更ありのはず）
#   どれか1条の title を書き換える
```

**確かめたら作業ツリーを元に戻すこと**（`git checkout -- data/`）。
データを書き換えたままコミットしないこと。
