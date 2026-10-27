# 差し戻しの複数の指摘を全部直す・古い下書きでも再生成できるようにする

2026-10-27 の #644（贈与税の非課税制度）の差し戻しで見つかった、再生成（`regenerate-draft.yml` → `generate-draft.js --regenerate`）の弱点 2 つを直す。毛利了承済み（2026-10-27 の引き継ぎ 1・3）。

## 背景（実際に起きたこと）

### 1. 1 回の差し戻しで 1 つの章しか直さず、直さなかった旨を本文に書いた（run 40484642578）

差し戻しコメント（3 点の番号付き）:

```
次の3点だけを直してください。それ以外の文章・構成・見出しは変えないでください。

1. 「贈与税の非課税制度 一覧比較」の表の「相続時精算課税」の行の対象者の欄にある「贈与者60歳以上・受贈者18歳以上の直系卑属または推定相続人」を、「贈与者は贈与の年の1月1日に60歳以上の父母・祖父母など、受贈者は同日に18歳以上で、贈与者の直系卑属である推定相続人または孫」に直す（本文の「相続時精算課税」の節の書き方と合わせる）。根拠: 国税庁タックスアンサー No.4103。

2. 「結婚・子育て資金の一括贈与は今からでも始められますか？」の回答にある「令和8年3月31日時点で利用可能な制度ですので」を、「平成27年4月1日から令和9年3月31日までに金融機関等と結婚・子育て資金管理契約を結んで拠出した場合が対象の制度です（適用期限は令和9年3月31日）」という内容に直す。根拠: No.4511（令和8年4月1日現在法令等）。

3. 「配偶者への居住用不動産の贈与（配偶者控除）」の節にある「贈与を受けた翌年3月15日までに居住していること（またはその見込みがあること）」を、「贈与を受けた年の翌年3月15日までに、贈与で取得した居住用不動産（または贈与された金銭で取得した居住用不動産）に実際に住んでおり、その後も引き続き住む見込みであること」に直す。「または」ではなく、住んでいることと引き続き住む見込みの両方が要件。根拠: No.4452。
```

- `classifyRevision` はコメント全体を 1 つとして分類し、1 点目の「表の」に当たって `table_fix`（scope `section`）、`sectionHint` は最初の「」＝「贈与税の非課税制度 一覧比較」になった。
- `regenerateSection` は表の章 1 つだけを LLM に渡した。2・3 点目の箇所は渡していないので直せない。
- LLM は表を直したうえで、その章の末尾に「※差し戻しコメントの2・3は…変更していません。」と書き足し、それがそのまま本文になった。
- 「差し戻しコメント」は `partial-revise.js` の `INTERNAL_PROCESS_WORDS` に入っているが、`findInternalProcessWords` はルール自動反映の経路（`generate-draft.js` 1583 行付近）と更新案の経路でしか呼ばれておらず、差し戻しの `regenerateSection` / `regenerateTargeted` では見ていない。
- 通知は「対応版ができました」（`regenerated`）になり、2・3 点目が直っていないことは分からなかった。

### 2. 9/27（#645）より前に作った下書きは再生成が必ず失敗する（run 40483979382）

- `regenerate-draft.yml` は下書きの枝を取り出したあと、main から `scripts/` と決まったデータ（`data/banned-phrases.json` など 8 つ）だけを上書きしている。
- main の `scripts/` は、その後に足されたデータ（`data/macro-target-ratios.json`・`data/macro-quota.json`・`data/shitsugi-persona-allowlist.json` など）を読み込み時に `require` する。古い下書きの枝にはそのファイルが無いので `MODULE_NOT_FOUND` で止まる。
- #644 は `gh pr update-branch` で main を取り込んで回避した。残りの対象は #575・#642（今後も、古い下書きは毎回同じ失敗をする）。

## 方針

- **1 の直し**: 番号付き・箇条書きの差し戻しは、指摘ごとに分けて分類し、同じ章に当たる指摘はまとめて 1 回、章を決められない指摘はまとめて全文の最小修正 1 回、と順に直す。LLM が作業の説明（「差し戻しコメントの〜は変更していません」など）を本文に書いたら、その行を取り除くか、その段の出力を捨てる。直せなかった指摘があれば「自動反映は一部のみ」の印を付け、通知を「反映できなかった」側に切り替える（既存の仕組み）。
- **2 の直し**: main から上書きするデータを、決まったファイルの列挙ではなく `data/` 全体にする。ただし下書きの枝の記事固有の照合記録 `data/fact-check/` は枝のまま残す。

## 段階

| 段 | 指示書 | 内容 |
|---|---|---|
| 1 | `01-multi-point.md` | R1〜R7（指摘の分割・章ごとの修正・作業の説明の除去・反映の確かめ・再生成の data の上書き） |

## 全段階共通の厳守事項

- 指摘が 1 つだけ（番号付き・箇条書きでない）の差し戻しは、**今までと同じ動き**にする（分類・プロンプト・LLM の呼び出し回数を変えない）。ただし R4（作業の説明の除去）と R3 の「節」の追加は 1 つだけの差し戻しにも効かせる。
- 禁止意図（`detectDenyIntent`）の扱い・テーマ禁止での中止（`process.exit(2)`）は変えない。
- 更新案（`isRefreshRegeneration`、`freshness-refresh.js` の `regenerateRefreshDraft` / `runRefresh`）の流れは変えない。
- 照合（`fact-check.js`）・`finalizeRegeneration` は変えない。
- `regenerate-draft.yml` の「記事と照合記録以外がステージされていたら落とす」確認、push の再試行、通知の切り替え（`自動再生成の警告|自動反映は一部のみ`）は変えない。

## 元に戻す方法

- 1: 変数 `ENABLE_MULTI_POINT_REVISE=false`（GitHub の Variables、`regenerate-draft.yml` で渡す）で、指摘を分けずに従来どおり 1 つとして扱う。R4 の除去は戻さない（作業の説明が本文に残るのは常に誤り）。
- 2: PR を revert する。

## 受け入れ確認（Claude）

- 試験（01 の「試験」）が全部通る。既存の `test-revision-classifier.js`・`test-partial-revise.js`・`test-freshness-refresh.js`・`test-generation-review-fixes.js`・`test-generation-review-fixes-2.js`・`test-workflow-change-detection.js` が通る。
- #644 の 1 回目の差し戻しコメントを偽の LLM で流すと、表の章・よくある質問・配偶者控除の 3 か所すべてに LLM の呼び出しが届き、「※差し戻しコメント…」の行が最終の本文に残らない。
- 指示書に無いファイルの変更が無い。

## コードの入口

- `scripts/lib/revision-classifier.js`（`classifyRevision`・`extractSectionHint`・`RULES`）
- `scripts/lib/partial-revise.js`（`splitSections`・`findTargetSectionIndex`・`buildSectionPrompt`・`buildTargetedPrompt`・`findInternalProcessWords`・`INTERNAL_PROCESS_WORDS`・`stripAnalysisPreamble`）
- `scripts/generate-draft.js`（`regenerateSection` 2409 行付近・`regenerateTargeted` 2470 行付近・`rebuildWithBodyAndWarning`・`--regenerate` の分岐 3212〜3258 行付近）
- `.github/workflows/regenerate-draft.yml`（「Use latest scripts, deps and moderation data from main」）
