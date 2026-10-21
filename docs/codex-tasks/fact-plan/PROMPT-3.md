あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-plan/` にあります。今回は **`03-glm-find-opus-confirm.md`（C1〜C7・D1〜D3）**を実装してください。照合の抜き出し・判定は GLM のまま、記事を書き換える・具体を外す前に Opus が 1 件ずつ確かめ、Opus が「誤り」と認めて機械の確かめを通ったものだけ書き換える仕組みです。**既定は止めたまま**（`FACT_CHECK_CONFIRM=true` のときだけ）です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `feat/fact-plan-02`（`feat/fact-plan-01` の上。第 1 段階は PR #699）。ブランチを切り替えないでください。コミットはしないでください（この環境ではできません）。
- まず README・02・review-02〜02c・03 を読んでください。03 の「背景」の実例（兄弟の制度のページで書き換える、正しい「15日前」を外す、誤解の例を逆にする、配偶者控除 2,500万円 を通す）を、偽の GLM・偽の Opus の試験で再現してから作ってください。
- 試験は `scripts/lib/__tests__/test-fact-plan-03.js` に書いてください（03 の「試験」1〜10）。D1〜D3 は review-02c の再現の条件どおりにしてください。既存の試験の期待は、D2 で 02b の時点に戻すもの（`01b-F2` の期待、S5・S5-7・02b-M1・02b-L2 の入力）以外は変えないでください。戻したものは、どれをなぜ戻したか報告してください。確かめを弱める方向に変えないでください。
- 最初の指示（PROMPT-1.md）の「厳守」は引き続き守ってください。特に、既定（変数なし）の照合を今の本番（Opus・全体の検索・Batch）と同じに保つこと、書き手の資料が無い記事を今と同じに保つこと、引用の実在・数字の歯止め・止める範囲・fail-closed を弱めないこと、鍵をログ・記録に出さないこと。
- ネットワーク不可・依存関係の追加なし・作業用ファイルはリポジトリの外・LF・説明は日本語、も同じです。判断に迷う点は【要判断】として残し、指示書の既定どおりに実装してください。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-plan-03.js
node scripts/lib/__tests__/test-fact-plan-02.js
node scripts/lib/__tests__/test-fact-plan-01.js
node scripts/lib/__tests__/test-gateway-model.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-03x.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-published-facts-audit.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）と EPERM 以外に失敗が無いことを確かめてください。`test-workflow-change-detection.js` は未コミットの間は落ちるので流さなくてよい。

## 最終報告（日本語で）

1. C1〜C7・D1〜D3 ごとに「何を変えたか」「触ったファイルと関数」「試験の結果」
2. 確かめの流れ（どの指摘を確かめに回すか、Opus の答えの機械の確かめ、書き換え・残す・判断できないの扱い、呼び出しの上限）を関数名と行で短く
3. 既存の試験の期待・入力を変えた（戻した）箇所とその理由
4. 全テストの結果（対象外と EPERM は名前だけ）
5. 【要判断】【要確認】
