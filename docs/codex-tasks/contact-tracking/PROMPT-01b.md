01 の実装と報告、ありがとうございます。報告の【要判断】（`dateOffset` の 1 日ずれ）は、この PR に含めて直すことにしました。

`docs/codex-tasks/contact-tracking/01b-date-offset.md` を読み、R7 を実装し、「試験」を作って通してください。

- 01 で変えたファイルの他に変えてよいのは、`netlify/functions/lib/analytics-store.js` の `dateOffset` と、その試験だけです。`admin-list-analytics.js`・`analytics-cleanup.js` の呼び出し側は変えないでください。
- 環境の注意（隔離・コミット不可・EPERM・PowerShell）は前回と同じです。
- 前回報告の `test-check-master-freshness.js`（出典ハッシュ 148 件）と `test-gsc-topics.js` の失敗は main でも起きている既存の失敗なので、直さないでください。

確かめること:
1. `node scripts/lib/__tests__/test-analytics-store.js`、`test-track-visit.js`、`test-contact-transition.js`、`test-workflow-change-detection.js`
2. `npm run build`

最終報告（日本語）: 変えた箇所、試験の結果、`analytics-cleanup.js` を試せたかどうか。PR 本文の下書きは、前回のものに「日付の 1 日ずれの修正」を足し、「確認事項」の dateOffset の記述を消した版をください。
