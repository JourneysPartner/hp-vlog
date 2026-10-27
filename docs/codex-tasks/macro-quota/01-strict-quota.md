# 01 比率の変更・本数の上限・承認待ちの下書きを数える

背景・方針・厳守事項は `README.md`。

## 実装要件

### R1 目標比率（`data/macro-target-ratios.json`）

README の表のとおりに変える（合計 1.00。`validateTargetRatios` が通ること）。

### R2 本数の上限を守る分類（新しい設定ファイル `data/macro-quota.json`）

```json
{
  "note": "本数の上限を必ず守る分類。上限 = ceil(目標比率 × planned_per_window)。2026-10-27 毛利決定: 相続贈与は 10%（直近30日で2本まで）。",
  "window_days": 30,
  "planned_per_window": 13,
  "strict_macros": ["相続贈与"]
}
```

- 上限の本数 = `Math.max(1, Math.ceil(目標比率 × planned_per_window))`（相続贈与は ceil(0.10 × 13) = 2）。
- 数える本数 = 直近 `window_days` 日の、その分類の**記事（main）＋承認待ちの下書き**。日付は既存の `postReferenceDate` と同じ基準。下書きの分類は、記事と同じ方法（`cluster-taxonomy` の解決）で決める。取り下げ・統合済み（`merged` など、既存の集計で数えない状態）は数えない。
- 数える本数が上限以上なら、その分類の候補は**選定から外す**（理由の文言の例: `相続贈与: 直近30日で 3 本（上限 2 本・目標 10%）`）。
- 設定ファイルが無い・読めない時は、今までどおり（上限なし）で動き、警告を 1 行出す。`strict_macros` に表に無い分類があれば、起動時に例外（`validateTargetRatios` と同じ扱い）。

### R3 承認待ちの下書きを比率にも数える（`scripts/lib/category-balance.js`）

- `computeMacroRatios(now, { extraCorpus })` で、承認待ちの下書き（`topic-selector.js` の `normalizeExtraCorpus` を通したもの）も 7・14・30 日の集計に入れる。同じ slug が main と下書きの両方にあれば 1 本と数える。
- `topic-selector.js` の呼び出し（「5. カテゴリ偏り是正」）で、既に読み込んでいる下書き（`pending`）を渡す。

### R4 選定での扱い（`topic-selector.js`・`category-balance.js`）

- R2 で外した候補は、`balanceBlocked` と区別できる形で `explanation.steps` に残す（例: `step: 'macro-quota'`、外した件数・分類・理由）。
- 「カテゴリ偏りハードブロックで全滅 → ブロック解除」の救済で、**R2 で外した候補は戻さない**（戻すのは既存の hardCap で外したものだけ）。R2 で外した結果、候補が 0 件になった時は、既存の「候補なし」の扱いに任せる。
- 手動の `force_slug` の経路は変えない（上限の対象外）。
- 既存の並び順（需要の証拠 > 季節 > 問い合わせ近接度 > balance）と hardCap は変えない。

## 試験（新しいファイル `scripts/lib/__tests__/test-macro-quota.js`、`package.json` の `masters:test` の末尾に登録）

1. 上限の計算: 0.10 × 13 → 2、0.02 × 13 → 1、0.50 × 13 → 7。
2. 数え方: 直近 30 日に main 2 本（相続贈与）→ 外す。main 1 本＋下書き 1 本 → 外す。main 1 本だけ → 外さない。31 日前の 1 本は数えない。同じ slug が main と下書きにあれば 1 本。`merged` の記事は数えない。
3. 選定: 相続贈与 1 件と物販 1 件の候補で、相続贈与が上限に達していれば物販だけが残り、`explanation` に `macro-quota` の段が出る。候補が相続贈与だけの時は 0 件になり、救済で戻らない。
4. 設定ファイルが無い時は上限なしで動き、警告が出る。`strict_macros` に未知の分類があれば例外。
5. `computeMacroRatios` に下書きを渡すと比率に入る。渡さなければ今までと同じ結果（既存の呼び出しを壊さない）。
6. 既存の試験（`test-selector.js`・`test-crawl-queue-cadence.js`・`test-suggest-topics.js`・`test-cooldown-granularity.js`・`test-scenarios.js` など、目標比率や `category-balance` を使うもの）が通る。比率の値そのものを確かめている既存の試験は、新しい値に合わせて直してよい（値以外の期待は変えない）。

## 確かめること（実データ）

`node -e` などで、今日の main の記事と下書き無しの状態で `computeMacroRatios` と R2 の判定を実行し、相続贈与が「直近 30 日で 3 本（上限 2 本）」で外れることを報告する。

## 変更してはいけないもの

- `content/posts/*.md`、承認・公開・予約公開の流れ、`force_slug` の経路
- 需要の証拠・季節・問い合わせ近接度の点数と並び順
- workflow（`.github/workflows/*`）
