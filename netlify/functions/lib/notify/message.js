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
 */

function buildMessage(event, data) {
  switch (event) {
    case 'draft_created': {
      const { title, summary, persona, category, reviewUrl, prUrl } = data;
      const lines = [
        '本日のブログ下書きが生成されました。',
        '',
        `■ タイトル: ${title}`,
        `■ 対象読者: ${persona}`,
        `■ カテゴリ: ${category}`,
        `■ 概要: ${summary}`,
        '',
      ];
      if (reviewUrl) lines.push(`▶ レビュー画面: ${reviewUrl}`);
      if (prUrl)     lines.push(`▶ Pull Request: ${prUrl}`);
      lines.push('', 'レビュー画面から内容を確認し、承認・差し戻し・見送りの操作をお願いいたします。');
      return { subject: '【ブログ】下書きが生成されました', body: lines.join('\n') };
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
      const { title, publishAt, category, persona } = data;
      // publishAt を JST 表記の見やすい文字列に整形
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
      if (publishDateLabel) lines.push(`■ 公開予定: ${publishDateLabel} 11時台`);
      lines.push('', '翌日11時台に自動で本番サイトに反映され、公開完了通知をお送りします。');
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

    default:
      return { subject: event, body: JSON.stringify(data, null, 2) };
  }
}

module.exports = { buildMessage };
