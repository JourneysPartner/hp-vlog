'use strict';

/**
 * 通知メッセージ組み立て（プロバイダ共通）
 *
 * イベント種別:
 *   - draft_created      : 下書き生成完了
 *   - regenerated        : 差し戻し対応版の再生成完了
 *   - regenerate_failed  : 再生成失敗
 *   - approved           : 承認完了（公開予約された状態）
 *   - revised            : 差し戻し受付
 *   - skipped            : 見送り完了
 *   - published          : 公開完了（publish-scheduled が送信）
 *   - merge_failed       : PRマージ失敗
 *   - slot_readjusted    : 公開枠変更（evening→morning 繰り上げ）
 */

function buildMessage(event, data) {
  switch (event) {
    case 'draft_created': {
      const { title, summary, persona, category, reviewUrl, prUrl, articleType, articleRole } = data;

      const ARTICLE_TYPE_LABELS = {
        basic_explainer:     '基本解説',
        comparison_decision: '比較・判断',
        edge_case:           '判断に迷うケース',
        industry_example:    '業種別具体例',
        filing_practice:     '申告実務',
        misconception_fix:   'よくある誤解',
        case_study:          'ケーススタディ',
      };
      const roleLabel = articleRole === 'main' ? '本命記事' : articleRole === 'support' ? '補強記事' : '';
      const typeLabel = ARTICLE_TYPE_LABELS[articleType] || articleType || '';

      const lines = [
        '本日のブログ下書きが生成されました。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (roleLabel || typeLabel) {
        lines.push(`■ 記事区分: ${[roleLabel, typeLabel].filter(Boolean).join('／')}`);
      }
      lines.push(
        `■ 対象読者: ${persona}`,
        `■ カテゴリ: ${category}`,
        `■ 概要: ${summary}`,
        '',
      );
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      if (prUrl)     lines.push(`▶ Pull Request: ${prUrl}`);
      lines.push('', 'レビュー画面から内容を確認し、承認・差し戻し・見送りの操作をお願いいたします。');
      return { subject: `【ブログ】${roleLabel ? `${roleLabel}の` : ''}下書きが生成されました`, body: lines.join('\n') };
    }

    case 'regenerated': {
      const { title, reviewUrl, comment } = data;
      const lines = [
        '差し戻し対応版を再生成しました。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (comment) lines.push(`■ 差し戻しコメント: ${comment}`);
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      lines.push('', '再度レビュー画面から内容をご確認ください。');
      return { subject: '【ブログ】差し戻し対応版ができました', body: lines.join('\n') };
    }

    // 差し戻しコメントを自動で本文に反映できなかった（または一部のみ）ケース。
    // 本文長さガードで LLM の全文再生成が破棄されたときなど。誤って「対応版ができました」と
    // 通知すると内容が変わっていないのに完了扱いになるため、明確に手動対応を促す。
    case 'regenerate_not_applied': {
      const { title, reviewUrl, comment } = data;
      const lines = [
        '差し戻しコメントを自動で本文に反映できませんでした（本文は変更されていないか、禁止表現の置換のみ適用されています）。',
        'お手数ですが、レビュー画面から手動で修正するか、コメントをより具体的にして再度お試しください。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (comment) lines.push(`■ 差し戻しコメント: ${comment}`);
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      return { subject: '【ブログ】差し戻しを自動反映できませんでした（要手動対応）', body: lines.join('\n') };
    }

    case 'regenerate_failed': {
      const { filename, comment } = data;
      return {
        subject: '【ブログ】再生成に失敗しました',
        body: [
          '差し戻し対応の再生成に失敗しました。',
          '',
          `■ ファイル: ${filename}`,
          comment ? `■ コメント: ${comment}` : '',
          '',
          'GitHub Actions のログを確認してください。',
        ].filter(Boolean).join('\n'),
      };
    }

    // 日次の記事生成そのものが失敗したとき。
    // 2026-08-28/29: 生成は成功していたのにバリデーションでジョブが落ち、
    // 下書きが作られないまま2日気づかれなかった。失敗を必ず知らせる。
    case 'daily_draft_failed': {
      const { comment, prUrl } = data;
      return {
        subject: '【ブログ】本日の記事生成に失敗しました',
        body: [
          '本日の記事生成が失敗し、下書きが作られていません。',
          '',
          comment ? `■ 状況: ${comment}` : '',
          prUrl ? `■ 実行ログ: ${prUrl}` : '',
          '',
          '放置すると記事が作られない日が続きます。ログを確認してください。',
        ].filter(Boolean).join('\n'),
      };
    }

    // 2026-09-04: cooldown が候補を削りすぎて本命記事1本しか作れず、
    // ジョブは成功扱いだったため「補強記事が無い」ことに誰も気づけなかった。
    // 2本揃わなかった日は、失敗でなくても必ず知らせる。
    case 'daily_draft_partial': {
      const { title, comment, prUrl } = data;
      return {
        subject: '【ブログ】本日は下書きが1本だけです（補強記事なし）',
        body: [
          `${title || '本日の記事生成'}は完了しましたが、下書きが2本揃いませんでした。`,
          '',
          comment ? `■ 理由: ${comment}` : '',
          prUrl ? `■ 実行ログ: ${prUrl}` : '',
          '',
          '生成された記事のレビューは通常どおり進められます。',
          '同じ日が続く場合は、選定条件で候補が枯れていないかログを確認してください。',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'revised': {
      const { title, filename, comment, reviewUrl } = data;
      const lines = [
        '記事の差し戻しを受け付けました。AIが再生成中です。',
        '',
        `■ タイトル: ${title || filename}`,
      ];
      if (comment) lines.push(`■ コメント: ${comment}`);
      lines.push('', '再生成が完了したら改めて通知します。');
      return { subject: '【ブログ】差し戻しを受け付けました', body: lines.join('\n') };
    }

    case 'skipped': {
      const { title, filename } = data;
      return {
        subject: '【ブログ】記事を見送りました',
        body: [
          '記事を見送りにしました。PRは自動でクローズされます。',
          '',
          `■ タイトル: ${title || filename}`,
        ].join('\n'),
      };
    }

    case 'approved': {
      const { title, publishAt, publishSlot, category, persona } = data;
      const slotLabel = publishSlot === 'evening' ? '17時台' : '11時台';
      let publishDateLabel = '';
      if (publishAt) {
        try {
          const d = new Date(publishAt);
          const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          const yyyy = jst.getUTCFullYear();
          const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(jst.getUTCDate()).padStart(2, '0');
          publishDateLabel = `${yyyy}-${mm}-${dd}`;
        } catch { /* noop */ }
      }
      const lines = [
        '記事を承認しました。公開予約を受け付けました。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (category) lines.push(`■ カテゴリ: ${category}`);
      if (persona)  lines.push(`■ 対象読者: ${persona}`);
      if (publishDateLabel) lines.push(`■ 公開予定: ${publishDateLabel} ${slotLabel}`);
      lines.push('', `翌日${slotLabel}に自動で本番サイトに反映され、公開完了通知をお送りします。`);
      return { subject: '【ブログ】公開予約を受け付けました', body: lines.join('\n') };
    }

    case 'published': {
      const { title, publicUrl, category, persona } = data;
      const lines = [
        '記事の公開処理が完了しました。',
        '',
        `■ タイトル: ${title}`,
      ];
      if (category) lines.push(`■ カテゴリ: ${category}`);
      if (persona)  lines.push(`■ 対象読者: ${persona}`);
      if (publicUrl) lines.push(`▶ 公開URL: ${publicUrl}`);
      return { subject: '【ブログ】記事が公開されました', body: lines.join('\n') };
    }

    case 'slot_readjusted': {
      const { title, publishAt: raPublishAt } = data;
      let raDateLabel = '';
      if (raPublishAt) {
        try {
          const d = new Date(raPublishAt);
          const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          const yyyy = jst.getUTCFullYear();
          const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(jst.getUTCDate()).padStart(2, '0');
          raDateLabel = `${yyyy}-${mm}-${dd}`;
        } catch { /* noop */ }
      }
      return {
        subject: '【ブログ】公開枠が変更されました',
        body: [
          'ペア記事の見送り・差し戻しにより、公開枠を変更しました。',
          '',
          `■ タイトル: ${title}`,
          raDateLabel ? `■ 公開予定: ${raDateLabel} 11時台` : '',
          '',
          '17時台 → 11時台へ自動的に繰り上げられました。',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'merge_failed': {
      const { title, filename } = data;
      return {
        subject: '【ブログ】公開処理に失敗しました',
        body: [
          'PRの自動マージに失敗しました。',
          '',
          `■ タイトル: ${title || filename}`,
          '',
          'GitHub でPRの状態を確認してください。',
        ].join('\n'),
      };
    }

    case 'source_blocked': {
      const { title, filename, reasons } = data;
      const reasonLines = (reasons || []).map(r => `  - ${r}`).join('\n');
      return {
        subject: '【ブログ】出典ガードにより承認をブロックしました',
        body: [
          '「そのまま公開」が実行されましたが、出典の検証に問題があり承認処理をブロックしました。',
          '',
          `■ タイトル: ${title || filename}`,
          reasonLines ? `■ 理由:\n${reasonLines}` : '',
          '',
          'レビュー画面から出典を修正した上で、再度「そのまま公開」を押してください。',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'quality_blocked': {
      const { title, filename, reasons } = data;
      const reasonLines = (reasons || []).map(r => `  - ${r}`).join('\n');
      return {
        subject: '【ブログ】品質ゲートにより承認をブロックしました',
        body: [
          '「そのまま公開」が実行されましたが、品質基準を満たさず承認処理をブロックしました。',
          '',
          `■ タイトル: ${title || filename}`,
          reasonLines ? `■ 理由:\n${reasonLines}` : '',
          '',
          'レビュー画面から差し戻して、内容・出典・タイトルを見直してください。',
        ].filter(Boolean).join('\n'),
      };
    }

    default:
      return { subject: event, body: JSON.stringify(data, null, 2) };
  }
}

module.exports = { buildMessage };
