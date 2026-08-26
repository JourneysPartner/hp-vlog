# 実装指示書: 質疑応答982件のLLM全件選別（段階1.5）

作成: 2026-08-26（設計・受け入れ確認: Claude ／ 実装: Codex）
前提: docs/codex-tasks/phase1-demand-driven-candidates.md（実装済み・マージ済み）

## 背景

段階1で質疑応答事例の候補を日次生成プールに接続したが、接続対象は人が手動採用した
276件のみ。この手動採用は「どれを採用していいかわからない・数が多い」という理由で
停滞しており、しかも精度が出ていない（機械判定 reject の候補が11件混入）。

残り706件を人が見るのではなく、**LLMに982件全件を明確な基準で選別させ、
人の採用作業を廃止する**。

実データで確認済みの、機械の点数だけでは見抜けない不適切候補の例:

- 「日本標準産業分類からみた事業区分（大分類－A農業…）」84点
  → 読者の悩みではなく分類表の解説ページ
- 「金融機関の店舗の分割があった場合の異動申告書」84点（読者想定: インフルエンサー）
  → 読者想定の対応付けが破綻
- 「身体障害者手帳等を交付申請中の者に対するマル優の適用」84点
  → 当ブログの顧客層と接点がない

最後の安全網（記事は1本ずつ公開前に人が承認する）は変わらない。

## 変更してはいけないもの（段階1と同じ）

- タイトル・本文の生成ルール、手動承認の運用、既存の選定フィルタのバイパス禁止
- 既存記事・frontmatter 形式
- 秘密情報（環境変数の値）をログ・コミットに含めない

## 実装要件

### R1. 選別スクリプト `scripts/triage-shitsugi-topics.js`

`data/nta-shitsugi-topics-candidate.json` の candidates 全982件を LLM で選別し、
各候補に `llm_triage` を書き戻す。

```json
"llm_triage": {
  "decision": "adopt" | "reject",
  "reason": "日本語で簡潔に",
  "corrected_persona": "（proposed.persona が不自然な場合のみ。それ以外は省略）",
  "judged_at": "ISO8601",
  "model": "使用モデルID"
}
```

実行方式:

- LLM 呼び出しは `scripts/lib/llm-source-selector.js` の `makeOpenAILuna()` と同じ流儀
  （`OPENAI_API_KEY`、モデルは `LLM_TRIAGE_MODEL`、既定 `gpt-5.6-luna`）
- 1回の呼び出しで15件前後をまとめて判定（982件 ≒ 66回）。出力は JSON のみを要求し、
  壊れた応答は1回だけリトライ。それでも壊れたらそのバッチをスキップしてログに残す
- **再開可能にする**: 既に `llm_triage` がある候補は既定でスキップ（`--force` で再判定）。
  途中で落ちても再実行すれば続きから進む。バッチごとにファイルへ書き戻す
- 進捗ログ: `[triage] 120/982 判定済み (adopt 74 / reject 46)` の形式

### R2. 判定基準（プロンプトに明記。この内容から発明・逸脱しない）

LLM への入力は候補ごとに: 題名 / 税目 / proposed.persona / 照会要旨の冒頭300字
（`data/nta-sources/{file_path}` の `shokai_yoshi`。読めない場合は題名のみで判定）。

**reject にする条件**（いずれかに該当）:

1. **読者の悩みに答えるページではない**: 分類表・一覧表・様式や手続の逐条解説・
   通達の適用関係の整理など、「実在の人の疑問」ではなく「資料」であるもの
2. **当ブログの顧客層の外**: 公益法人・特殊法人向け／金融機関・金融商品の運用／
   大法人の組織再編・連結／輸出入の特殊関税手続 など。
   当ブログの顧客層: EC・フリマ・ネット物販／クリエイター・YouTuber・コンテンツ販売／
   美容サロン／建設の一人親方／小売店／卸売／一般の個人事業主／中小法人／
   相続・贈与に直面する個人
3. **どの顧客カテゴリに置き換えても接点が不自然**: proposed.persona を別の顧客
   カテゴリに直しても、その読者が検索して辿り着く場面が想像できないもの

**adopt にする条件**: 上記に該当せず、実在の読者（顧客層のいずれか）が同じ場面で
迷いうる論点であること。proposed.persona が不自然だが**別の顧客カテゴリなら自然**な
場合は、`corrected_persona` にそのカテゴリを入れて adopt にする
（persona の値は既存トピックで使われている persona ID から選ぶこと）。

判定に迷う場合は reject に倒す（候補は他にも十分ある。誤 adopt の方が高くつく）。

### R3. 選別結果の反映 `scripts/lib/shitsugi-topics.js`

- 接続対象の決め方を変更: `llm_triage.decision === 'adopt'` を最優先。
  `llm_triage` が無い候補は従来どおり `adopted === true`（後方互換。選別が
  済んでいない状態でも壊れない）
- `corrected_persona` があれば persona をそれに置き換え、macro も persona に
  対応する値へ補正する（既存コードの persona→macro 対応に合わせる。
  対応が引けない場合はその候補をスキップしてログに残す）
- 統計に `triaged`（llm_triage を持つ件数）を追加

### R4. 優先度に候補の点数を反映 `scripts/lib/topic-selector.js`

現在: `priority = demand * 3 + season * 2 + lead`（demand は 0 か 1）

変更: demand_evidence に score がある場合は `demand = score / 100`（例: 91点→0.91、
72点→0.72）。score が無い demand_evidence は従来どおり 1。
→ `priority = demand * 3 + season * 2 + lead`

これで質疑応答同士でも高得点が先に使われる（91点→2.73 vs 72点→2.16。
いずれも季節ブースト2を上回るので、需要の証拠が最優先という設計は変わらない）。

### R5. 手動実行の workflow `.github/workflows/triage-shitsugi.yml`

- `workflow_dispatch` のみ（自動実行しない）
- `OPENAI_API_KEY` は既存 workflow（daily-draft.yml）と同じ流儀で参照
- 実行内容: R1 のスクリプト → 変更があれば `triage/shitsugi-{日付}` ブランチに
  コミットして PR を作成（自動マージはしない。**選別結果は人（Claude）が
  PR レビューで検収してからマージ**）
- PR 本文に選別の集計（adopt/reject 件数、persona 補正件数）を載せる

### R6. テスト `scripts/lib/__tests__/test-shitsugi-triage.js`

LLM はモック（callLLM 注入）でテストする。実 API を呼ばない。

1. 選別結果の書き戻し形式が正しい（decision/reason/judged_at/model）
2. 再開: llm_triage 済みはスキップ、`--force` で再判定
3. 壊れた LLM 応答 → リトライ → それでも壊れたらスキップして続行（全体を止めない）
4. shitsugi-topics: llm_triage.adopt が接続され、reject は接続されない。
   llm_triage 無しは adopted===true にフォールバック
5. corrected_persona の置き換えと macro 補正。対応が引けない場合はスキップ
6. 優先度: score 91 の候補が score 72 より先に並ぶ。score 無し demand は従来どおり 1
7. 既存の全テスト・validate・build が通ること

## 受け入れ確認（Claude が実施）

- 実際の選別実行（workflow）後、PR上で:
  - 背景に挙げた不適切候補3件（産業分類・店舗の分割・マル優）が reject であること
  - 「土地付建物の仲介手数料の仕入税額控除」（正当な例）が adopt であること
  - adopt/reject の分布と reject 理由の妥当性を抜き取り確認
- 選別結果マージ後の dry-run で接続件数が更新されること
