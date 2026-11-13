# 段 6 — 所得税の令和8年度改正の施行に合わせて記録を「施行済み」にする

根拠: 改正法（令和8年法律第12号）附則1条4号イ（2026-12-01 施行）・2条1項（令和8年分以後の所得税に適用）。README の「2026-12-01 の施行の後」、台帳 C-1、`TY-SUPPORTED-2026._action_after_enforcement`。

**前提**: この作業の前に、e-Gov 法令 API で所得税法の版 `340AC0000000033_20261201_508AC0000000012` と租税特別措置法の版 `332AC0000000026_20261201_508AC0000000012` が施行済みであることを `scripts/check-law-revisions-enforced.js` で確かめてある（終了コード 0）。その日付を「確認日」とし、依頼文で渡す。

## 何をするか

1. 所得税の令和8年分の記録 27 件の `legal_status` を `enacted` → `effective` にし、`as_of_date` を確認日にする。
2. 記録の注記と年度マスターの対応年の記録を、施行後の文に直す。
3. 画面の施行日の説明の文を、施行後の文に直す。
4. 「施行前・概算」の注記が付くことを前提にしていた 2026 年の試験を、施行後の仕様に合わせる。
5. 公開用のまとめファイルを作り直す。

**金額は 1 円も変わらない。** 変わるのは結果の状態と注記だけ。

## 決めたこと（変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | 切り替えるのは下の 27 件だけ。令和9年分の基礎控除（BD-R9）・住民税の令和9年度分（RT-*-R9）・インボイスの経過措置の先の段（INV-TRANS-03〜05）・3割特例・相続の生前贈与加算・`TY-SUPPORTED-2027` は `enacted` のまま | `enacted` は「成立・公布済みで適用開始前」（C-14 の決定）。BD-R9 は令和9年分から、住民税の 62万円の要件は令和9年1月1日施行（地方税法、令和8年法律第2号） |
| D2 | `as_of_date` は確認日にする。`verified_at`・`verified_by`・`data_review_status`・値・期間は変えない | 法令の状態を確かめた日が変わる。値の照合と承認は済んでいる |
| D3 | `TY-SUPPORTED-2026.support_status` を `supported` にする | 2026 年の所得税は施行済みになる。`supported` は①④②とも今の判定で通る（`src/simulators/core/supported-year.js`） |
| D4 | 施行後も、住民税の令和9年度分の記録（RT-*-R9、`enacted`）を使う結果には「施行前・概算」が付く。これは正しい動き | 地方税法の改正は 2027-01-01 施行 |

## R1. 記録（文字列として該当の行だけ書き換える）

対象 27 件。各記録の `"legal_status": "enacted"` を `"legal_status": "effective"` に、`"as_of_date": "…"` を `"as_of_date": "<確認日>"` にする。記録のほかの行は変えない。

| ファイル（`data/tax-simulator/masters/data/`） | 記録 |
| --- | --- |
| `basic-deduction/deductions.json` | BD-R8-TIER-01〜07（7 件） |
| `salary-income-deduction/deductions.json` | SID-R8-TIER-01〜05（5 件） |
| `salary-income-deduction/appendix5.json` | APDX5-R8-SEG-01〜09（9 件） |
| `income-deduction/specific-relative-deduction.json` | IDED-SPECREL-R8-T00・T01（2 件） |
| `income-deduction/spouse-special-deduction.json` | IDED-SPOUSE-SP-R8-S01-T1〜T4（4 件） |

`JSON.parse` → `JSON.stringify` で書き直さない（書式が変わる）。

## R2. 注記と年度マスター

文は次のとおりにする（`<確認日>` は依頼文の日付）。

1. `basic-deduction/deductions.json` の BD-R8 の塊の `_status`（534 行付近、「施行前。令和8年12月1日施行・令和8年分以後の所得税に適用…」）→ `"施行済み。令和8年12月1日施行・令和8年分以後の所得税に適用（令和8年法律第12号 附則1条4号イ・2条1項）。<確認日> に e-Gov で施行を確認し、legal_status を effective にした。"`
2. 同じファイルの BD-R9 の塊の `_status`（819 行付近、「施行前。legal_status は enacted。」）→ `"令和8年12月1日施行済み。令和9年分の所得税から適用するので、適用開始前の legal_status は enacted（2027-01-01 の後に effective へ）。"`
3. `salary-income-deduction/deductions.json` の R8 の塊の `_status`（243 行付近）→ `"施行済み。令和8年12月1日施行・令和8年分以後に適用（改正法附則1条4号イ・3条1項）。<確認日> に e-Gov で施行を確認し、legal_status を effective にした。"`
4. `tax-year/tax-year-master.json` の `TY-SUPPORTED-2026`
   - `"support_status": "supported_with_pending_law"` → `"support_status": "supported"`
   - `as_of_date` → `<確認日>`
   - `_caveat` → `"所得税の令和8年度改正は令和8年12月1日施行（令和8年法律第12号）。<確認日> に施行を確認し、所得税の令和8年分の記録を effective にした。住民税の令和9年度分の62万円の要件（地方税法 23条1項7号・9号）は令和9年1月1日施行で、それまでは enacted のまま、使った結果に「施行前・概算」の注記が付く。"`
   - `_action_after_enforcement` → `"所得税の切替えは済み（段 6）。住民税の令和9年度分の 6 件（RT-SPOUSE-SP-R9-S01-T1〜T4・RT-SPECREL-R9-T00・T01）は 2027-01-01 の後に effective へ。"`
5. 上の 27 件の塊に、ほかにも「施行前」「enacted」と書いた `_` の注記があれば、変えずに最終報告に一覧で書く（`salary-income-deduction/appendix5.json` の `_r8_note` は取得の経緯の記録なので変えない）。

## R3. 画面の施行日の説明

`src/ui/law-change-notice.js` の `incomeTaxLawChangeNotice(2026)` の文を次にする（2026 以外は今のまま `undefined`）。

```
令和8年分の所得税は、令和8年12月1日に施行された改正（基礎控除と給与所得控除の引上げ、配偶者・扶養親族などの所得要件の62万円への引上げなど）を反映しています。住民税は令和9年度分として計算し、同じ62万円の所得要件（令和9年1月1日施行）を反映しています。施行前の改正の値を使う結果には「施行前・概算」と表示します。
```

## R4. 試験（金額の期待値は変えない）

施行後の仕様:
- 2026 年の①④で、住民税の令和9年度分の記録（RT-*-R9）を使わない入力（単身・扶養なしなど）は `MASTER_PENDING_LAW_APPLIED` が付かない。④はほかに理由が無ければ `complete`。①は国保の令和8年度の料率の代用（`NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED`、台帳 C-16）で `partial` のまま。
- 住民税の令和9年度分の記録を使う入力（例: 配偶者の合計所得金額 70万円＝給与収入 144万円の配偶者特別控除）は、2026 年でも `MASTER_PENDING_LAW_APPLIED` が付いて `partial`。
- ②の 2027 年（3割特例）、③の 2028 年（生前贈与加算）の注記はそのまま。

直し方:
1. 2026 年の①④で「注記が付く」ことを確かめている試験は、**住民税の令和9年度分の記録を使う入力に変えて**同じことを確かめる。使用記録（`usedMasterRecords`）に `RT-SPOUSE-SP-R9-S01-` で始まる記録があることも確かめる。単身の入力のままの試験は「注記が付かない」ことを確かめる形にする。
2. ゴールデン `GC-HJ-STEADY-1200-R8` の試験: 状態 `partial`、`NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED` あり、`MASTER_PENDING_LAW_APPLIED` なし。`GC-YH-MODE-C-500K-R8`: 状態 `complete`、注記なし。金額の確かめは今のまま。
3. 画面の試験で、説明の文（R3）を確かめているものは新しい文にする。偽の結果に `MASTER_PENDING_LAW_APPLIED` を入れて注記の表示を確かめる試験はそのまま。
4. 新しく足す: 上の 27 件がすべて `effective`、`as_of_date` が確認日であること。D1 で `enacted` のままにする記録（BD-R9-TIER-01〜07、RT-SPOUSE-SP-R9-S01-T1〜T4、RT-SPECREL-R9-T00・T01、INV-TRANS-03〜05、CT-SPECIAL-3WARI、IHT-GIFT-ADDBACK-TRANSITION・-7Y・-EXTRA-DEDUCTION、TY-SUPPORTED-2027）がすべて `enacted` のままであること。`TY-SUPPORTED-2026.support_status` が `supported`。
5. 直した既存の試験は、名前と「仕様どおりの変化」の理由を最終報告に書く。**金額が 1 件でも変わったら直さずに【要判断】で報告する。**

## R5. まとめファイル

全部の試験の後に、試験で書き換わった `assets/js/` を戻してから `npm run simulator:bundle` を 1 回流す。

## 変えてはいけないもの

- 値・期間・`data_review_status`・`verified_at`・`verified_by`。R1・R2 に書いていない記録と行。
- `src/tax-engine/**`、`src/simulators/**`（エンジンとサービス）。画面は `src/ui/law-change-notice.js` だけ。
- `data/tax-simulator/golden-cases/official-examples.json`、`sources/source-registry.json`、`data/nta-sources/`。
- 試験を弱めない・消さない・飛ばさない。

## 確かめること

1. `npm run masters:validate` が通る。
2. `npm run masters:test` が通る（子プロセスの EPERM で落ちる試験は名前とエラーの 1 行目を報告）。
3. `npm run masters:gate` が 4 サービスとも公開可。
4. `git diff -U0 -- data/tax-simulator/masters/data` の変わった行が `legal_status`・`as_of_date`・`support_status`・`_status`・`_caveat`・`_action_after_enforcement` だけ。
5. 2026 年の①平年度・④モード C（ゴールデンと同じ入力）を画面と同じ組み立てで計算し、状態・警告のコード・①の `summary.amount`（825,140円のまま）を最終報告に書く。
